// The second signer-client implementation (WP-33 part 1, decision D3's "start local (keychain)"):
// backs a signer client with an OS-keychain-resident key by shelling out to a keychain
// command-line tool — never by reading a key file, never by deriving or reconstructing key
// material in this process. This module does not import `node:child_process`, `node:fs`, or any
// chain-signing library, and it never will: the *only* way this file ever reaches the outside
// world is the caller-injected `exec` function, so a reviewer can confirm "this module never reads
// a key file" by grepping its own source, not by trusting a comment. The real production `exec`
// (spawning the actual command-line tool) is constructed by the caller — see
// `bin/hookemon-verifier.mjs`'s `createProcessExec` for the one place that happens — never by this
// module.
//
// Wire protocol with the keychain command-line tool (deliberately minimal — this is a seam any
// operator-chosen tool can implement, not a specific vendor's API): the tool is invoked as
// `<command> <...args> <operation> --role <role> --account <account>` with a single JSON line on
// stdin, `{ operation, role, account, digest, request }` (`request` is the sign/broadcast payload,
// reshaped for JSON transport — see `encodeForTransport` below), and must reply with exactly one
// JSON object on stdout and an exit code of `0` on success. A nonzero exit code or malformed stdout
// is treated as a hard failure, never a partial success.
import {
  ROLE_CAPABILITIES,
  SignerClientError,
  assertRole,
  signRequestDigest,
  wrapSignerClient,
  wrapTransactionPolicySignerClient,
} from './signer-client.mjs';

const MAX_STDERR_IN_ERROR = 500;
const DEFAULT_TIMEOUT_MS = 10_000;
const SECRET_ASSIGNMENT = /\b(private[ _-]?key|secret[ _-]?key|seed(?:[ _-]?phrase)?|mnemonic|credential)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\r\n]*)/gi;
const RAW_SECRET_HEX = /(?:0x)?[a-f0-9]{64,128}/gi;
const MNEMONIC_PHRASE = /\b(?:[a-z]{3,}\s+){11,23}[a-z]{3,}\b/gi;

/** JSON cannot represent a `Buffer`/`Uint8Array` (or, faithfully, an arbitrary object graph with a
 * defined key order) on its own — this reshapes a sign/broadcast payload into a JSON-safe
 * envelope the keychain tool can rely on, without ever needing to guess the original type back. */
function encodeForTransport(value) {
  if (Buffer.isBuffer(value)) return { encoding: 'base64', data: value.toString('base64') };
  if (value instanceof Uint8Array) return { encoding: 'base64', data: Buffer.from(value).toString('base64') };
  if (typeof value === 'string') return { encoding: 'utf8', data: value };
  return { encoding: 'json', data: value };
}

function truncate(text) {
  if (typeof text !== 'string') return '';
  return text.length > MAX_STDERR_IN_ERROR ? `${text.slice(0, MAX_STDERR_IN_ERROR)}…` : text;
}

function redactErrorText(text) {
  if (typeof text !== 'string') return '';
  return truncate(text
    .replace(SECRET_ASSIGNMENT, '$1=[redacted]')
    .replace(RAW_SECRET_HEX, '[redacted]')
    .replace(MNEMONIC_PHRASE, '[redacted]'));
}

/**
 * @param {object} input
 * @param {string} input.role - one of `SIGNER_ROLES` (signer-client.mjs).
 * @param {boolean} input.liveMode - see `wrapSignerClient`'s own doc comment.
 * @param {object} [input.preflightAuthority] - exact test-runner fixture authority forwarded to
 *   `wrapSignerClient`; production callers must omit it.
 * @param {(call: {command: string, args: string[], input: string}) => Promise<{code: number, stdout: string, stderr?: string}>} input.exec -
 *   injected; this module never spawns a process itself.
 * @param {string} input.command - absolute path to (or name of) the keychain command-line tool.
 * @param {string} input.account - a keychain entry identifier (never a secret — a label, e.g.
 *   "hookemon-operator-evm"), forwarded to the tool so it knows which stored key to use.
 * @param {string[]} [input.args] - extra fixed arguments to pass to every invocation.
 * @returns {{role: string, sign: Function, broadcast?: Function}}
 */
export function createKeychainSignerClient({
  role,
  liveMode,
  preflightAuthority,
  exec,
  command,
  account,
  args = [],
  timeoutMs = DEFAULT_TIMEOUT_MS,
  transactionPolicy,
  transactionPolicyRules,
  transactionDecodeOptions,
}) {
  assertRole(role);
  if (typeof liveMode !== 'boolean') throw new SignerClientError('liveMode must be a boolean');
  if (typeof exec !== 'function') {
    throw new SignerClientError(
      'keychain signer requires an injected exec(...) function; it never invokes a real OS process '
      + 'or reads a key file directly itself',
    );
  }
  if (typeof command !== 'string' || command.length === 0) {
    throw new SignerClientError('keychain signer requires a command (the keychain command-line tool to invoke)');
  }
  if (typeof account !== 'string' || account.length === 0) {
    throw new SignerClientError('keychain signer requires an account identifier (a label, never a secret value)');
  }
  if (!Array.isArray(args) || args.some(entry => typeof entry !== 'string')) {
    throw new SignerClientError('keychain signer args must be an array of strings');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new SignerClientError('keychain signer timeoutMs must be a positive safe integer');
  }

  async function invoke(operation, payload) {
    const requestDigest = signRequestDigest(payload);
    const line = `${JSON.stringify({
      operation,
      role,
      account,
      digest: requestDigest,
      request: encodeForTransport(payload),
    })}\n`;
    const controller = new AbortController();
    let timeout;
    let result;
    try {
      result = await Promise.race([
        Promise.resolve().then(() => exec({
          command,
          args: [...args, operation, '--role', role, '--account', account],
          input: line,
          timeoutMs,
          signal: controller.signal,
        })),
        new Promise((resolve, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new SignerClientError(`keychain command "${command} ${operation}" timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      if (controller.signal.aborted && error instanceof SignerClientError) throw error;
      const message = redactErrorText(error instanceof Error ? error.message : String(error));
      throw new SignerClientError(`keychain command "${command} ${operation}" failed: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
    if (!result || typeof result !== 'object') {
      throw new SignerClientError(`keychain command produced no result for "${operation}"`);
    }
    if (result.timedOut === true) {
      throw new SignerClientError(`keychain command "${command} ${operation}" timed out after ${timeoutMs}ms`);
    }
    if (result.code !== 0) {
      const stderrHint = result.stderr ? `: ${redactErrorText(result.stderr)}` : '';
      throw new SignerClientError(`keychain command "${command} ${operation}" exited with code ${result.code}${stderrHint}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new SignerClientError(`keychain command "${command} ${operation}" produced non-JSON stdout`);
    }
    return parsed;
  }

  const inner = {
    async sign(request) {
      return invoke('sign', request);
    },
  };
  if (ROLE_CAPABILITIES[role].broadcast) {
    inner.broadcast = async signed => invoke('broadcast', signed);
  }

  const client = wrapSignerClient({ role, liveMode, inner, preflightAuthority });
  const policyClient = transactionPolicy === undefined
    ? client
    : wrapTransactionPolicySignerClient({
      client,
      policy: transactionPolicy,
      rules: transactionPolicyRules,
      decodeOptions: transactionDecodeOptions,
    });
  return Object.freeze({
    ...policyClient,
    async probe() {
      const result = await invoke('probe', { kind: 'hookemon-keychain-sign-only-readiness.v1' });
      if (!result || typeof result !== 'object' || result.ready !== true) {
        throw new SignerClientError(`keychain command "${command} probe" did not confirm readiness`);
      }
      return { ready: true };
    },
  });
}
