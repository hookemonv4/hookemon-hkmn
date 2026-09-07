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
  KeychainPreInvocationDenialError,
  KeychainSignOnlyTimeoutError,
  OPERATOR_SOLANA_ROLE,
  ROLE_CAPABILITIES,
  SignerClientError,
  assertRole,
  signRequestDigest,
  wrapSignerClient,
  wrapTransactionPolicySignerClient,
} from './signer-client.mjs';

export { KeychainPreInvocationDenialError, KeychainSignOnlyTimeoutError };

const MAX_STDERR_IN_ERROR = 500;
const DEFAULT_TIMEOUT_MS = 10_000;

// ADR-0025 sign-only bounded retry: this module is the one place a `sign`/`signApproved` timeout
// can be classified as retry-eligible, because it is the one place this repository can prove the
// checked-in Keychain broker's own sign-only/broadcast separation (see this module's header). Both
// error classes are defined in signer-client.mjs (re-exported above, purely to avoid a circular
// top-level class-`extends` evaluation) but this is the only module that ever constructs either
// one. The "owned" capability below is module-private in the same sense: nothing outside this file
// can *mint* it, so a recovery-aware caller that requires both (see signer-client.mjs's
// `wrapTransactionPolicySignerClient`) cannot be satisfied by an external module, a hand-built
// object with matching method names, or a generic exec/parse failure.
function isProvenPreInvocationDenial(error) {
  return Boolean(error) && typeof error === 'object' && (error.code === 'ENOENT' || error.code === 'EACCES');
}

// Keyed by the exact frozen client object `createKeychainSignerClient` returns, mapped to the
// non-secret `{role, account}` identity a durable pre-sign binding records. Deliberately not a
// WeakSet keyed by an exposed property or symbol value: those survive an object spread
// (`{...client}`) performed by *legitimate* wrapping code, which is also exactly the shape a
// spoofed clone would copy. Checking the live object reference itself means a spread produces a
// structurally identical but reference-distinct object this WeakMap does not recognize -- a caller
// that needs the capability to survive a legitimate wrap (see `forwardOwnedKeychainSignOnlyIdentity`
// below) must say so explicitly, once, at the exact place it constructs that wrapper.
const ownedKeychainSignOnlyClients = new WeakMap();

/** True only for the exact object this module's own `createKeychainSignerClient` returned, or an
 * object a trusted in-repository wrapper explicitly re-attested with `forwardOwnedKeychainSignOnlyIdentity`. */
export function isOwnedKeychainSignOnlyClient(client) {
  return Boolean(client) && typeof client === 'object' && ownedKeychainSignOnlyClients.has(client);
}

/** The non-secret `{role, account}` identity a durable pre-sign binding records, or `null` when
 * `client` is not owned. `account` is a keychain entry label (never a secret), per this module's own
 * `createKeychainSignerClient` doc comment. */
export function readOwnedKeychainSignOnlyIdentity(client) {
  if (!isOwnedKeychainSignOnlyClient(client)) return null;
  return ownedKeychainSignOnlyClients.get(client);
}

/**
 * Lets a trusted in-repository wrapper (e.g. a stage's `{role, sign, broadcast}` facade that only
 * ever delegates unchanged to `rawSigner`) carry the owned-Keychain attestation through to the
 * object a recovery-aware signer facade actually sees. This is not a general "mint ownership"
 * escape hatch: it only ever re-attests a *different* object once `original` has already, itself,
 * passed `isOwnedKeychainSignOnlyClient` -- it can never make an unrelated or spoofed object pass
 * that check on its own. Call it only where `wrapper`'s `sign`/`signApproved` provably call straight
 * through to `original`'s.
 */
export function forwardOwnedKeychainSignOnlyIdentity(original, wrapper) {
  const identity = readOwnedKeychainSignOnlyIdentity(original);
  if (identity && wrapper && typeof wrapper === 'object') {
    ownedKeychainSignOnlyClients.set(wrapper, identity);
  }
  return wrapper;
}

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

/**
 * The Operations Solana child (`bin/hookemon-keychain-signer.mjs`'s `signSolana`) accepts only a
 * bare transaction — it explicitly refuses any `policy`/`transactionPolicy` field on the wire
 * because Solana policy evaluation (with its trusted, non-serializable `currentBlockHeightResolver`/
 * `blockhashContextResolver` functions) can only happen in the parent, per
 * `wrapTransactionPolicySignerClient`. A caller wrapping this client in that policy layer may
 * legitimately re-describe the same call with its own `transaction`/`transactionPolicy`/
 * `transactionDecodeOptions` envelope (the EVM child *does* want that shape — see
 * `keychain-child-evm.mjs`'s `transactionForSigning`); for the Solana role this function narrows
 * that same envelope back down to the one thing the wire protocol accepts, so neither a forbidden
 * policy field nor a non-JSON resolver function ever reaches `signRequestDigest`/`encodeForTransport`.
 * A bare string or byte payload (the shape every other Solana caller already uses) passes through
 * unchanged.
 */
function solanaSignTransportPayload(payload) {
  if (typeof payload === 'string' || Buffer.isBuffer(payload) || payload instanceof Uint8Array) return payload;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const transaction = payload.transactionBase64 ?? payload.transaction;
    if (typeof transaction === 'string') return transaction;
  }
  return payload;
}

/** Recursively refuses a function anywhere in a value about to cross the JSON keychain wire. A
 * function cannot survive `JSON.stringify` (it is silently dropped) and cannot survive this
 * module's own canonical digest (`signRequestDigest` throws deep inside a shared canonicalizer);
 * this turns that into one clear, correctly-attributed error at the actual transport boundary. */
function assertJsonTransportSafe(value, label, seen = new Set()) {
  if (value === null || value === undefined) return;
  if (typeof value === 'function') fail(`${label} must not contain a function; resolver functions stay in the parent and never cross the keychain JSON wire`);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return;
  if (typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonTransportSafe(item, `${label}[${index}]`, seen));
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    assertJsonTransportSafe(nested, `${label}.${key}`, seen);
  }
}

function fail(message) {
  throw new SignerClientError(message);
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
 * @param {string[]} [input.args] - extra fixed arguments to pass to every invocation. There is no
 *   equivalent per-operation knob: the Solana `--parent-policy-evaluated` CLI marker is derived
 *   internally (see `signApproved` below), never accepted as caller configuration, so no caller can
 *   construct a client that asserts a parent policy evaluation it never performed.
 * @param {(signed: object|string, context: {role: string}) => Promise<object>} [input.broadcast] -
 *   injected chain RPC transport. When supplied, `broadcast()` sends already-authorized signed
 *   bytes directly through this function instead of the sign-only keychain command — the command
 *   never receives a `broadcast` operation. Omit only for a role or caller that still relies on the
 *   keychain command's own (sign-only) `broadcast` verb; production Operations EVM/Solana clients
 *   always supply this. When supplied, the plain `broadcast()` this function would otherwise expose
 *   is replaced by a `broadcastApproved()` reachable only through a genuine parent
 *   transaction-policy evaluation proof (see `signer-client.mjs`'s `assertPolicyEvaluationProof`) —
 *   a caller holding a bare reference to this client can no longer send it arbitrary signed bytes to
 *   broadcast; only `createPolicySigner`/`wrapTransactionPolicySignerClient`'s own guarded broadcast
 *   path can.
 * @returns {{role: string, sign: Function, broadcast?: Function, signApproved?: Function, broadcastApproved?: Function}}
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
  broadcast,
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
  if (broadcast !== undefined && typeof broadcast !== 'function') {
    throw new SignerClientError('keychain signer broadcast must be a function when supplied');
  }

  async function invoke(operation, payload, { includeParentPolicyMarker = false } = {}) {
    const transportPayload = role === OPERATOR_SOLANA_ROLE && operation === 'sign'
      ? solanaSignTransportPayload(payload)
      : payload;
    assertJsonTransportSafe(transportPayload, `${role} ${operation} request`);
    const requestDigest = signRequestDigest(transportPayload);
    const line = `${JSON.stringify({
      operation,
      role,
      account,
      digest: requestDigest,
      request: encodeForTransport(transportPayload),
    })}\n`;
    const controller = new AbortController();
    let timeout;
    let result;
    try {
      result = await Promise.race([
        Promise.resolve().then(() => exec({
          command,
          args: [
            ...args,
            operation,
            '--role',
            role,
            '--account',
            account,
            // Never caller configuration (see this function's own header comment): set only by
            // `signApproved` below, which the wrapping `wrapSignerClient` never reaches without a
            // proof `signer-client.mjs` mints exclusively after a real policy evaluation.
            ...(includeParentPolicyMarker ? ['--parent-policy-evaluated'] : []),
          ],
          input: line,
          timeoutMs,
          signal: controller.signal,
        })),
        new Promise((resolve, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            const TimeoutErrorClass = operation === 'sign' ? KeychainSignOnlyTimeoutError : SignerClientError;
            reject(new TimeoutErrorClass(`keychain command "${command} ${operation}" timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      if (controller.signal.aborted && error instanceof SignerClientError) throw error;
      if (isProvenPreInvocationDenial(error)) {
        const message = redactErrorText(error instanceof Error ? error.message : String(error));
        throw new KeychainPreInvocationDenialError(`keychain command "${command} ${operation}" was never invoked: ${message}`);
      }
      const message = redactErrorText(error instanceof Error ? error.message : String(error));
      throw new SignerClientError(`keychain command "${command} ${operation}" failed: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
    if (!result || typeof result !== 'object') {
      throw new SignerClientError(`keychain command produced no result for "${operation}"`);
    }
    if (result.timedOut === true) {
      const TimeoutErrorClass = operation === 'sign' ? KeychainSignOnlyTimeoutError : SignerClientError;
      throw new TimeoutErrorClass(`keychain command "${command} ${operation}" timed out after ${timeoutMs}ms`);
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
  if (role === OPERATOR_SOLANA_ROLE) {
    // The only place this module ever sets the `--parent-policy-evaluated` CLI marker.
    // `wrapSignerClient` (signer-client.mjs) refuses to call this at all unless its second
    // argument is a proof `signer-client.mjs` minted immediately after a real
    // `evaluateTransactionPolicy` call — there is no path from caller configuration to this marker.
    inner.signApproved = async request => invoke('sign', request, { includeParentPolicyMarker: true });
  }
  if (ROLE_CAPABILITIES[role].broadcast) {
    if (broadcast === undefined) {
      // Production Operations EVM/Solana broadcasting is a chain RPC concern, never a sign-only
      // keychain command concern (WP-33's own boundary: this module never holds key material, and
      // the command's `sign` verb is the only thing that needs to). This fallback exists only for a
      // caller that has not yet wired a real transport; the command refuses the operation outright.
      inner.broadcast = async signed => invoke('broadcast', signed);
    } else {
      // A real chain RPC transport is exposed only as `broadcastApproved`, never as a plain
      // `broadcast` — see this function's own header comment. `wrapSignerClient` requires a genuine
      // policy-evaluation proof before this ever runs.
      inner.broadcastApproved = async signed => broadcast(signed, { role });
    }
  }

  const client = wrapSignerClient({ role, liveMode, inner, preflightAuthority });

  // `wrapSignerClient.sign()` computes its own canonical audit digest over whatever it is given,
  // before `inner.sign()` (this module's `invoke()`) ever runs — narrowing only inside `invoke()`
  // would be too late for a caller who passes the full return/outbound-shaped envelope straight
  // into this exported `sign()`. Narrow (and refuse a lingering function) here, at the one place
  // every caller of this client's `sign()`/`signApproved()` must pass through, whether directly or
  // wrapped again by a stage-level `wrapTransactionPolicySignerClient`.
  function transportSignRequest(request) {
    const narrowed = role === OPERATOR_SOLANA_ROLE ? solanaSignTransportPayload(request) : request;
    assertJsonTransportSafe(narrowed, `${role} sign request`);
    return narrowed;
  }
  const transportClient = Object.freeze({
    role: client.role,
    sign: request => client.sign(transportSignRequest(request)),
    ...(client.signApproved ? { signApproved: (request, proof) => client.signApproved(transportSignRequest(request), proof) } : {}),
    ...(client.broadcast ? { broadcast: signed => client.broadcast(signed) } : {}),
    ...(client.broadcastApproved ? { broadcastApproved: (signed, proof) => client.broadcastApproved(signed, proof) } : {}),
  });

  const policyClient = transactionPolicy === undefined
    ? transportClient
    : wrapTransactionPolicySignerClient({
      client: transportClient,
      policy: transactionPolicy,
      rules: transactionPolicyRules,
      decodeOptions: transactionDecodeOptions,
    });
  const ownedClient = Object.freeze({
    ...policyClient,
    async probe() {
      const result = await invoke('probe', { kind: 'hookemon-keychain-sign-only-readiness.v1' });
      if (!result || typeof result !== 'object' || result.ready !== true) {
        throw new SignerClientError(`keychain command "${command} probe" did not confirm readiness`);
      }
      return { ready: true };
    },
  });
  // ADR-0025: this exact object is the "verified owned Keychain broker" a recovery-aware policy
  // signer may bounded-retry on a classified sign-only timeout. Minted only here, once, for the
  // object this factory itself returns -- never reachable from `external-module-signer.mjs`, a
  // hand-built lookalike, or a plain-object clone of this one (see `isOwnedKeychainSignOnlyClient`).
  ownedKeychainSignOnlyClients.set(ownedClient, Object.freeze({ role, account }));
  return ownedClient;
}
