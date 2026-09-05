import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertProxyCredentialConfigured,
  proxyCredentialMatches,
  ProxyCredentialConfigError,
} from '../../src/auth/proxy-credential.mjs';

const VALID = 'a'.repeat(40);

test('assertProxyCredentialConfigured accepts a well-formed secret', () => {
  assert.equal(assertProxyCredentialConfigured(VALID), VALID);
});

test('assertProxyCredentialConfigured rejects a too-short secret', () => {
  assert.throws(() => assertProxyCredentialConfigured('short'), ProxyCredentialConfigError);
});

test('assertProxyCredentialConfigured rejects a secret with surrounding whitespace', () => {
  assert.throws(() => assertProxyCredentialConfigured(` ${VALID}`), ProxyCredentialConfigError);
});

test('assertProxyCredentialConfigured rejects a non-string', () => {
  assert.throws(() => assertProxyCredentialConfigured(undefined), ProxyCredentialConfigError);
});

test('proxyCredentialMatches accepts the exact configured credential', () => {
  assert.equal(proxyCredentialMatches(VALID, VALID), true);
});

test('proxyCredentialMatches rejects a wrong credential of the same length', () => {
  assert.equal(proxyCredentialMatches('b'.repeat(40), VALID), false);
});

test('proxyCredentialMatches rejects a different-length credential without throwing', () => {
  assert.equal(proxyCredentialMatches('short', VALID), false);
});

test('proxyCredentialMatches rejects a missing header', () => {
  assert.equal(proxyCredentialMatches(undefined, VALID), false);
  assert.equal(proxyCredentialMatches('', VALID), false);
});
