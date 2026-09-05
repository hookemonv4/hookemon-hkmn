// One of the two signer-client implementations (WP-33 part 1): the operator supplies a path to
// their own module — never bundled, never defaulted, never inside this repository in real use —
// exporting `createSignerClient(role, { liveMode })` (or a default factory) that returns
// `{ sign(request, meta), broadcast(signed, meta)? }`. This is the exact pattern
// packages/runner/src/distribution/distribution-signer.mjs's own `loadSignerClient` already uses
// for the distribution-signer/verifier roles, and packages/adapters/src/app/environment.mjs's
// `loadSignerClient` uses for the operator roles — this module formalizes that one pattern as a
// reusable, role-scoped implementation of the shared `signer-client.mjs` interface, so any caller
// (an operator-role client for `compose.mjs`, or `bin/hookemon-verifier.mjs`'s verifier-role
// client) constructs it the same way.
//
// This module never reads a key file, never imports a chain-signing library, and never contains
// any key material of its own — the imported module is code the operator wrote (or a
// vendor-supplied SDK wrapper), and whatever it does to actually produce a signature happens
// entirely inside that module, outside this one's control or knowledge.
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ROLE_CAPABILITIES,
  SignerClientError,
  assertRole,
  wrapSignerClient,
  wrapTransactionPolicySignerClient,
} from './signer-client.mjs';

/**
 * @param {object} input
 * @param {string} input.modulePath - absolute path to the operator-supplied module.
 * @param {string} input.role - one of `SIGNER_ROLES` (signer-client.mjs).
 * @param {boolean} input.liveMode - see `wrapSignerClient`'s own doc comment.
 * @param {object} [input.preflightAuthority] - exact test-runner fixture authority forwarded to
 *   `wrapSignerClient`; production callers must omit it.
 * @returns {Promise<{role: string, sign: Function, broadcast?: Function}>}
 */
export async function createExternalModuleSignerClient({
  modulePath,
  role,
  liveMode,
  preflightAuthority,
  transactionPolicy,
  transactionPolicyRules,
  transactionDecodeOptions,
}) {
  assertRole(role);
  if (typeof liveMode !== 'boolean') throw new SignerClientError('liveMode must be a boolean');
  if (typeof modulePath !== 'string' || modulePath.length === 0) {
    throw new SignerClientError(
      `external-module-signer requires a module path for role "${role}"; `
      + 'this implementation holds no key material of its own and will not fabricate a signer',
    );
  }
  if (!isAbsolute(modulePath)) throw new SignerClientError('external-module-signer module path must be absolute');

  const moduleUrl = pathToFileURL(resolvePath(modulePath)).href;
  const loaded = await import(moduleUrl);
  const factory = loaded.createSignerClient ?? loaded.default;
  if (typeof factory !== 'function') {
    throw new SignerClientError(`signer module "${modulePath}" must export createSignerClient(role, { liveMode }) or a default factory`);
  }

  const inner = await factory(role, { liveMode });
  if (!inner || typeof inner !== 'object' || Array.isArray(inner)) {
    throw new SignerClientError(`signer module "${modulePath}" factory must return a plain object`);
  }
  if (typeof inner.sign !== 'function') {
    throw new SignerClientError(`signer module "${modulePath}" must return an object exposing sign()`);
  }
  if (ROLE_CAPABILITIES[role].broadcast && typeof inner.broadcast !== 'function') {
    throw new SignerClientError(`signer module "${modulePath}" must return an object exposing broadcast() for role "${role}"`);
  }

  const client = wrapSignerClient({ role, liveMode, inner, preflightAuthority });
  return transactionPolicy === undefined
    ? client
    : wrapTransactionPolicySignerClient({
      client,
      policy: transactionPolicy,
      rules: transactionPolicyRules,
      decodeOptions: transactionDecodeOptions,
    });
}
