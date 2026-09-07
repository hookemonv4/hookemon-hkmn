// Pre-spend failure-matrix: literal loader/composition/child-signer protocol proofs for two
// failures that must be caught before any claim/purchase money effect -- a Collector catalog
// outage, and a USDG freeze introduced after a healthy startup observation.
//
// Base: coherent integration ccb55a4fb11282f807884c4c8236a065853a6fc7. This is the first pre-spend
// slice of the plan's full crash matrix (Section I); it does not claim post-signature/broadcast,
// custody, or N2/Collector-policy cuts, all of which are owned elsewhere (see the harness's own
// header comment and this file's closing remarks).
//
// Setup is the pinned graph fixture's own literal CLI/loader/child-signer wiring, copied into
// ./fixtures/launch-failure-harness.mjs (see that file's header for exactly what was copied and
// what was deliberately dropped). No stage-handler injection, fake repository, or
// createTestProfileMutationAuthority stands in for the loader anywhere in this file.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  activateTwoPackPolicy, buildProductionEnv, eligibilitySnapshotFixture, fixtureServer,
  isolatedSource, observabilityConfig, productionChildSigner, readSignerInvocations,
  repointCopiedDeploymentIdentity, runProductionUntil, runProductionWindow, writeStandingAuthorityDocument,
} from './fixtures/launch-failure-harness.mjs';

const FREEZE_DEADLINE_MS = Number(process.env.HKMN_FREEZE_DEADLINE_MS ?? 30000);
const WINDOW_MS = Number(process.env.HKMN_FAILURE_WINDOW_MS ?? 8000);

async function bootIsolatedRun(t, directory, fixture) {
  const { root, binPath } = await isolatedSource(directory);
  const signer = await productionChildSigner(t, root, directory);
  await repointCopiedDeploymentIdentity(root, { evm: signer.evmAccount, solana: signer.solanaAccount });
  const authority = await writeStandingAuthorityDocument(directory);
  await activateTwoPackPolicy(directory);
  const observabilityPath = join(directory, 'observability.json');
  const eligibilitySnapshotPath = join(directory, 'eligibility-snapshot.json');
  await writeFile(observabilityPath, `${JSON.stringify(observabilityConfig(fixture.baseUrl, directory, signer.evmAccount))}\n`);
  await writeFile(eligibilitySnapshotPath, `${JSON.stringify(eligibilitySnapshotFixture(signer.evmAccount))}\n`);
  const env = buildProductionEnv({ directory, fixture, signer, authority, observabilityPath, eligibilitySnapshotPath });
  return { root, binPath, signer, env };
}

async function openIsolatedRepository(root, directory) {
  const { CycleRepository } = await import(`file://${join(root, 'packages/adapters/src/app/cycle-repository.mjs')}`);
  return CycleRepository.open(join(directory, 'cycles'));
}

test(
  'I-catalog-outage literal loader refuses admission through a Collector catalog outage and stays refused across restart',
  { timeout: (WINDOW_MS * 2) + 60000 },
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'hookemon-failure-catalog-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    let operationsEvm = `0x${'0'.repeat(40)}`;
    let operationsSolana = null;
    const fixture = await fixtureServer(t, directory, () => operationsEvm, () => operationsSolana, {
      catalogAvailable: () => false,
    });
    const { root, binPath, signer, env } = await bootIsolatedRun(t, directory, fixture);
    operationsEvm = signer.evmAccount;
    operationsSolana = signer.solanaAccount;

    const diagnostics = () => JSON.stringify({ calls: fixture.calls });

    const firstRun = await runProductionWindow(binPath, env, WINDOW_MS);
    assert.ok(fixture.calls.catalog > 0, `the real catalog endpoint must actually be reached; ${diagnostics()}`);
    assert.match(
      firstRun.stderr,
      /collector-crypt machines responded with status 503/,
      `a tick diagnostic must expose the real provider failure, not a swallowed success; ${diagnostics()}`,
    );

    const repository = await openIsolatedRepository(root, directory);
    assert.deepEqual(
      await repository.listKnownCycleIds(), [],
      `a permanently unavailable catalog must never durably admit a cycle (no fabricated admission); ${diagnostics()}`,
    );
    assert.equal(fixture.calls.quotes.length, 0, `no Relay quote may be requested before the catalog is even readable; ${diagnostics()}`);
    assert.equal(fixture.calls.evmBroadcasts, 0, `no chain transaction may ever be broadcast; ${diagnostics()}`);
    assert.equal(fixture.calls.collectorGenerateYoloPacks, 0, `no Collector generate call may ever be reached; ${diagnostics()}`);
    assert.equal(fixture.calls.collectorSubmitTransaction, 0, `no Collector submit call may ever be reached; ${diagnostics()}`);

    // Restart the same durable state through the same literal loader while the catalog remains
    // unavailable. A startup refusal both times is the honest result this case proves; it is not
    // evidence of "recovery after provider acceptance" (no acceptance has ever occurred).
    const catalogCallsBeforeRestart = fixture.calls.catalog;
    const secondRun = await runProductionWindow(binPath, env, WINDOW_MS);
    assert.ok(
      fixture.calls.catalog > catalogCallsBeforeRestart,
      `restart must reach the real catalog endpoint again, not reuse a cached refusal; ${diagnostics()}`,
    );
    assert.match(
      secondRun.stderr,
      /collector-crypt machines responded with status 503/,
      `the restart's own tick diagnostics must again expose the real provider failure; ${diagnostics()}`,
    );
    // A fresh repository handle, not the one opened before restart: CycleRepository/DurableCycleStore
    // cache their active/index state in memory, so reusing the pre-restart handle would only prove
    // the snapshot it took before the child restarted, never what the restarted child actually wrote.
    const repositoryAfterRestart = await openIsolatedRepository(root, directory);
    assert.deepEqual(
      await repositoryAfterRestart.listKnownCycleIds(), [],
      `restart against the same unavailable catalog must still admit no cycle; ${diagnostics()}`,
    );
    assert.equal(fixture.calls.evmBroadcasts, 0, `no chain transaction may ever be broadcast, including after restart; ${diagnostics()}`);
    assert.equal(fixture.calls.collectorGenerateYoloPacks, 0, `no Collector generate call may ever be reached, including after restart; ${diagnostics()}`);
    assert.equal(fixture.calls.collectorSubmitTransaction, 0, `no Collector submit call may ever be reached, including after restart; ${diagnostics()}`);
  },
);

test(
  'I-usdg-freeze literal observability canary observes healthy then frozen and refuses every mutation from the flip onward, across restart',
  { timeout: (FREEZE_DEADLINE_MS * 2) + 60000 },
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'hookemon-failure-freeze-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    let operationsEvm = `0x${'0'.repeat(40)}`;
    let operationsSolana = null;
    const fixture = await fixtureServer(t, directory, () => operationsEvm, () => operationsSolana, {
      freezeAfterFirstRead: true,
    });
    const { root, binPath, signer, env } = await bootIsolatedRun(t, directory, fixture);
    operationsEvm = signer.evmAccount;
    operationsSolana = signer.solanaAccount;

    const diagnostics = async repository => JSON.stringify({
      calls: fixture.calls,
      cycles: await Promise.all((await repository.listKnownCycleIds()).map(async cycleId => {
        const cycle = await repository.describeCycle(cycleId);
        return {
          cycleId, terminalState: cycle.terminalState, terminalEvidence: cycle.terminalEvidence,
          stages: [...cycle.stages.entries()].map(([stage, record]) => [stage, record?.status]),
        };
      })),
    });

    const run = await runProductionUntil(binPath, env, {
      deadlineMs: FREEZE_DEADLINE_MS,
      observe: ({ stderr }) => stderr.includes('TICK_COMPLETE') && stderr.includes('HELD_UNAVAILABLE'),
    });

    assert.ok(
      fixture.calls.usdgFrozenObservations.length >= 2,
      `the real USDG freeze reader must be observed at least twice (healthy, then frozen); observations=${JSON.stringify(fixture.calls.usdgFrozenObservations)}; run=${JSON.stringify(run)}`,
    );
    assert.equal(
      fixture.calls.usdgFrozenObservations[0], false,
      `the first observation across the whole run must be the healthy startup read; observations=${JSON.stringify(fixture.calls.usdgFrozenObservations)}`,
    );
    assert.ok(
      fixture.calls.usdgFrozenObservations.slice(1).every(observed => observed === true),
      `every observation after the first must be frozen, with no reversion back to healthy; observations=${JSON.stringify(fixture.calls.usdgFrozenObservations)}`,
    );

    const invocations = await readSignerInvocations(signer);
    assert.equal(invocations.sign, 0, `no real signing operation may occur once the freeze is observed; invocations=${JSON.stringify(invocations.lines)}`);
    assert.equal(invocations.broadcast, 0, `no broadcast operation may occur once the freeze is observed; invocations=${JSON.stringify(invocations.lines)}`);
    assert.ok(invocations.probe > 0, `signer readiness probes are expected and are not signatures; invocations=${JSON.stringify(invocations.lines)}`);

    assert.equal(fixture.calls.evmBroadcasts, 0, `no EVM chain transaction may ever be broadcast; run=${JSON.stringify(run)}`);
    assert.equal(fixture.calls.collectorGenerateYoloPacks, 0, `purchase must never be reached; run=${JSON.stringify(run)}`);
    assert.equal(fixture.calls.collectorSubmitTransaction, 0, `Collector submit must never be reached; run=${JSON.stringify(run)}`);

    const repository = await openIsolatedRepository(root, directory);
    const cycleIds = await repository.listKnownCycleIds();
    assert.equal(cycleIds.length, 1, `admission must still succeed once (the freeze is a post-admission mutation refusal, not a catalog/admission failure); ${await diagnostics(repository)}`);
    const cycle = await repository.describeCycle(cycleIds[0]);
    assert.equal(cycle.terminalState, 'HELD_UNAVAILABLE', `the cycle must be truthfully held once the freeze is observed, not silently stuck or falsely completed; ${await diagnostics(repository)}`);
    const heldCodes = cycle.terminalEvidence?.drift?.map(item => item.code) ?? [];
    assert.ok(heldCodes.includes('USDG_FROZEN'), `the durable hold evidence must name the real USDG_FROZEN drift; ${await diagnostics(repository)}`);
    // eligibility-snapshot is documented as read-only (a live call returns the same evidence its
    // reconciliation would), so its own completion is not a money effect; every other stage is.
    assert.ok(
      ![...cycle.stages.entries()].some(([stage, record]) => stage !== 'eligibility-snapshot' && record?.status === 'COMPLETE'),
      `no money-moving stage (claim-process/purchase/payout/...) may be durably marked complete once the freeze is observed; ${await diagnostics(repository)}`,
    );

    // Restart the same durable state while the freeze fixture stays permanently flipped (every
    // read after the first is frozen; the fixture's counter is never reset). The refusal must
    // persist rather than being a one-tick fluke.
    const restart = await runProductionUntil(binPath, env, {
      deadlineMs: FREEZE_DEADLINE_MS,
      observe: ({ stderr }) => stderr.includes('TICK_COMPLETE') && stderr.includes('HELD_UNAVAILABLE'),
    });
    // An already-held cycle is reported as held on recovery without re-running the mutation gate
    // (there is nothing left to refuse a second time); the persisted refusal itself is the proof,
    // read from the tick's own reported status rather than from a re-thrown canary error.
    assert.match(
      restart.stderr,
      /HELD_UNAVAILABLE/,
      `the restart's own tick diagnostics must report the persisted hold; run=${JSON.stringify(restart)}`,
    );
    // A fresh repository handle, not the one opened before restart: CycleRepository/DurableCycleStore
    // cache their active/index state in memory, so reusing the pre-restart handle would only prove
    // the snapshot it took before the child restarted, never what the restarted child actually wrote.
    const repositoryAfterRestart = await openIsolatedRepository(root, directory);
    assert.deepEqual(await repositoryAfterRestart.listKnownCycleIds(), cycleIds, `restart must not admit a second cycle while the freeze holds; ${await diagnostics(repositoryAfterRestart)}`);
    const cycleAfterRestart = await repositoryAfterRestart.describeCycle(cycleIds[0]);
    assert.equal(cycleAfterRestart.terminalState, 'HELD_UNAVAILABLE', `the hold must persist across restart; ${await diagnostics(repositoryAfterRestart)}`);
    assert.ok(
      ![...cycleAfterRestart.stages.entries()].some(([stage, record]) => stage !== 'eligibility-snapshot' && record?.status === 'COMPLETE'),
      `no money-moving stage may complete after restart either; ${await diagnostics(repositoryAfterRestart)}`,
    );
    const invocationsAfterRestart = await readSignerInvocations(signer);
    assert.equal(invocationsAfterRestart.sign, 0, `no real signing operation may occur across restart either; invocations=${JSON.stringify(invocationsAfterRestart.lines)}`);
    assert.equal(invocationsAfterRestart.broadcast, 0, `no broadcast operation may occur across restart either; invocations=${JSON.stringify(invocationsAfterRestart.lines)}`);
  },
);
