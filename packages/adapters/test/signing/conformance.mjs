// A reusable conformance suite (WP-33 step 1): every signer-client implementation in
// packages/adapters/src/signing must pass this unmodified. Not itself a `*.test.mjs` file (the
// `node --test test/**/*.test.mjs` glob never picks it up on its own) — each implementation's own
// test file imports and registers it against that implementation's real constructor, so a failure
// is always attributed to the implementation under test, not to a shared mock.
//
// `build(role, liveMode)` is the only thing each implementation-specific test file supplies. It
// must construct a *real* client (via `createExternalModuleSignerClient`/`createKeychainSignerClient`,
// never a stand-in) and return `{ client, calls }`, where `calls()` returns the list of
// `{ method, digest }` entries the implementation's own underlying mechanism actually received —
// populated by that test file's own fake (an operator module's fixture, or a fake `exec`), never
// by this suite or by signer-client.mjs itself. This is what makes "the underlying mechanism was
// never invoked" and "the same canonical digest reached the mechanism regardless of key order"
// genuine, implementation-level assertions rather than assumptions about a shared wrapper.
import assert from 'node:assert/strict';

import { ROLE_CAPABILITIES } from '../../src/signing/signer-client.mjs';

export function registerSignerClientConformanceSuite(test, { name, roles = Object.keys(ROLE_CAPABILITIES), build }) {
  for (const role of roles) {
    const capabilities = ROLE_CAPABILITIES[role];

    test(`${name} [${role}]: role check — an unsupported role is refused at construction`, async () => {
      await assert.rejects(() => build('not-a-real-role', true), /role/i);
    });

    test(`${name} [${role}]: refuses to sign when liveMode is false, and never reaches the underlying mechanism`, async () => {
      const { client, calls } = await build(role, false);
      assert.equal(client.role, role);
      await assert.rejects(() => client.sign({ example: 1 }), /liveMode is false/);
      assert.equal(calls().length, 0, 'the underlying mechanism must never be invoked when liveMode is false');
    });

    if (capabilities.broadcast) {
      test(`${name} [${role}]: refuses to broadcast when liveMode is false, and never reaches the underlying mechanism`, async () => {
        const { client, calls } = await build(role, false);
        await assert.rejects(() => client.broadcast({ example: 1 }), /liveMode is false/);
        assert.equal(calls().length, 0);
      });
    } else {
      test(`${name} [${role}]: this role has no broadcast capability at all`, async () => {
        const { client } = await build(role, true);
        assert.equal(client.broadcast, undefined);
      });
    }

    test(`${name} [${role}]: signs when liveMode is true, and the result carries no key material`, async () => {
      const { client, calls } = await build(role, true);
      const result = await client.sign({ example: 1, nested: { b: 2, a: 1 } });
      const entries = calls();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].method, 'sign');
      for (const forbidden of ['privateKey', 'secretKey', 'mnemonic', 'seed', 'keypair']) {
        assert.equal(Object.hasOwn(result ?? {}, forbidden), false, `result must not carry a "${forbidden}" field`);
      }
    });

    test(`${name} [${role}]: request canonicalisation is deterministic regardless of key order`, async () => {
      const built1 = await build(role, true);
      const built2 = await build(role, true);
      await built1.client.sign({ a: 1, b: 2 });
      await built2.client.sign({ b: 2, a: 1 });
      const digest1 = built1.calls()[0].digest;
      const digest2 = built2.calls()[0].digest;
      assert.equal(typeof digest1, 'string');
      assert.match(digest1, /^sha256:[0-9a-f]{64}$/);
      assert.equal(digest1, digest2);
    });

    test(`${name} [${role}]: a different logical request produces a different digest`, async () => {
      const built1 = await build(role, true);
      const built2 = await build(role, true);
      await built1.client.sign({ a: 1 });
      await built2.client.sign({ a: 2 });
      assert.notEqual(built1.calls()[0].digest, built2.calls()[0].digest);
    });

    if (capabilities.broadcast) {
      test(`${name} [${role}]: broadcasts when liveMode is true, and the result carries no key material`, async () => {
        const { client, calls } = await build(role, true);
        const result = await client.broadcast({ signedBytes: 'AA==' });
        assert.equal(calls().some(entry => entry.method === 'broadcast'), true);
        for (const forbidden of ['privateKey', 'secretKey', 'mnemonic', 'seed', 'keypair']) {
          assert.equal(Object.hasOwn(result ?? {}, forbidden), false, `result must not carry a "${forbidden}" field`);
        }
      });
    }
  }
}
