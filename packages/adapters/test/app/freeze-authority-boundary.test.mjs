// Freeze-authority boundary: closes the independent review's open acceptance item on the USDG-freeze
// pre-spend case (`launch-failure-matrix.test.mjs`) -- that case's own freeze harness deliberately
// omits the per-step standing-authority artifact, so its refusal, while genuinely canary-driven,
// could not by itself prove the same first claim signature was otherwise reachable, and a separate
// process with a different authority state cannot supply that missing precondition either.
//
// This file closes it with a shared publish-and-verify barrier engine (`engageAuthorityBarrierOnce`
// below), built on the SAME real per-step standing-authority producer, held on the SAME loopback
// `isFrozen` RPC round-trip (`beforeMutation` blocks `stageDriver.execute()`,
// `automated-cycle-service.mjs`) for both paired tests, differing only in the boolean each releases:
// the frozen run (`createFreezeAuthorityBarrier`) proves the hold is attributable specifically to the
// freeze (authority was genuinely, verifiably published for the exact refused request, and still
// unused); the paired counterfactual-control run (`createReleasedAuthorityBarrier`) proves the same
// prepared claim, verified against the same barrier engine at the same request-ordering point,
// actually signs and completes when freeze is never observed. Sharing one barrier point for both
// became possible once `stage-driver.mjs` started resolving and verifying claim-process's
// operator-evm step authorization before reserving its wallet nonce (see `createReleasedAuthorityBarrier`'s
// own doc comment for the defect that previously required a different, generic barrier point here).
//
// Base: fa62117c (this worktree). Setup reused from ./fixtures/launch-failure-harness.mjs, whose
// `createStandingAuthorityProducer` is itself a read-only copy of the reserved
// launch-production-graph.test.mjs's `testPolicyAuthority` at ccb55a4fb11282f807884c4c8236a065853a6fc7
// (see that harness function's own header). No runtime, source, module, or manifest file is edited;
// no production keys, network, or broadcast beyond the loopback fixture are used.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  activateTwoPackPolicy, buildProductionEnv, createStandingAuthorityProducer,
  eligibilitySnapshotFixture, fixtureServer, isolatedSource, observabilityConfig,
  productionChildSigner, readSignerInvocations, repointCopiedDeploymentIdentity,
  runProductionWindow,
} from './fixtures/launch-failure-harness.mjs';

const POSITIVE_WINDOW_MS = Number(process.env.HKMN_AUTHORITY_WINDOW_MS ?? 15000);
const FREEZE_WINDOW_MS = Number(process.env.HKMN_FREEZE_AUTHORITY_WINDOW_MS ?? 8000);

/**
 * Core barrier engine shared by both tests below: read-only-peeks the producer's own committed-state
 * read (`peekPrepared`, no write) on every call. A read count is not a reliable proxy for "which
 * stage this is" -- observed directly while building this: eligibility-snapshot sometimes needs its
 * own execute-and-canary round before claim-process's own first prepared attempt exists, and
 * sometimes does not, so which numbered call belongs to claim-process varies run to run. The
 * prepared *state* is not ambiguous, though: `readCommittedPreparedAttempts`/`peekPrepared` only
 * turns up an entry once it is durably on disk, so the first call where it is non-empty is,
 * deterministically, a call made no earlier than that entry's own commit -- no poll loop, no sleep,
 * just a conditional on the current committed state of a real request already being made.
 *
 * Every call before that point is a no-op returning `null` (nothing published, nothing observed
 * yet). The engaging call runs the real producer's one read-sign-rename pass (`publishOnce`), then
 * an independent re-read of the artifact file from disk to confirm the exact rename it just awaited
 * is actually visible there, before returning the captured result. Every call after that reuses it
 * (a restart of the child process must see the same authority state it would have seen the first
 * time).
 *
 * `touch()` is called from the fixture's own HTTP request handler, which Node can and does invoke
 * concurrently for pipelined/parallel requests; without single-flight de-duplication, two overlapping
 * calls could both see `captured === null`, both start their own peek-publish-verify sequence, and
 * the second could read the artifact file before the first's own rename ever completed (observed
 * directly as a real ENOENT on that read while building this). `inFlight` collapses every concurrent
 * call onto the one already-running attempt instead.
 */
function engageAuthorityBarrierOnce(authority) {
  let captured = null;
  let inFlight = null;
  async function run() {
    const prepared = await authority.peekPrepared();
    if (prepared.length === 0) return null;
    const { wrote } = await authority.publishOnce();
    const artifactText = await readFile(authority.artifactPath, 'utf8');
    captured = { prepared, wrote, artifactText };
    return captured;
  }
  return {
    async touch() {
      if (captured !== null) return captured;
      if (inFlight === null) inFlight = run().finally(() => { inFlight = null; });
      return inFlight;
    },
    getCaptured: () => captured,
  };
}

/**
 * Barrier for the frozen test: held on the `isFrozen` read itself (`beforeMutation` blocks
 * `stageDriver.execute()`, `automated-cycle-service.mjs`, so this is the real request the child is
 * already awaiting before it can attempt to execute a stage at all). Answers healthy until the
 * barrier engages, then frozen forever after -- preserving a genuine healthy-then-frozen observation
 * pair while guaranteeing nothing is ever signable before the freeze takes hold.
 */
function createFreezeAuthorityBarrier(authority) {
  const engine = engageAuthorityBarrierOnce(authority);
  const freezeBarrier = async () => (await engine.touch()) !== null;
  return { freezeBarrier, getCaptured: engine.getCaptured };
}

/**
 * Barrier for the counterfactual-control test: the identical `isFrozen`-tied engagement point as
 * `createFreezeAuthorityBarrier` above (same detection of the durably committed prepared digest,
 * same real producer publish-and-verify pass), differing only in the boolean it releases -- never
 * frozen, healthy on every read. The two barriers therefore share first-attempt history, the exact
 * publication point, and retry state; only the released freeze value differs, which is what makes
 * this test a genuine counterfactual for the frozen one rather than a differently-shaped control.
 *
 * This barrier previously had to fire on every request instead (a generic, `isFrozen`-independent
 * gate) to work around a stage-driver defect: claim-process reserved the global EVM wallet nonce
 * before any authorization check, so a first attempt that observed `isFrozen` healthy but found no
 * published authority yet would fail deep inside signing, after already reserving that nonce under
 * its own lease's fencing token; the retry's rotated fencing token then made `cycle-repository.mjs`
 * refuse `reserveWalletNonce` until that stale fence expired (a real, bounded delay, not a permanent
 * deadlock -- expiry takeover is a repository invariant this change does not touch).
 * `stage-driver.mjs`'s `execute()` now resolves and verifies
 * the exact operator-evm step authorization for claim-process before calling its mutating handler --
 * before that nonce is ever reserved -- so a first attempt with no authority published yet refuses
 * before touching the nonce at all, and the `isFrozen`-tied barrier here is sufficient.
 */
function createReleasedAuthorityBarrier(authority) {
  const engine = engageAuthorityBarrierOnce(authority);
  const freezeBarrier = async () => { await engine.touch(); return false; };
  return { freezeBarrier, getCaptured: engine.getCaptured };
}

/** Asserts the barrier actually ran and that the real producer published a matching, real
 * `operator-evm` step-authorization for the exact prepared claim request -- the "counterfactual
 * signability" precondition both paired tests below build their remaining assertions on. */
function assertBarrierPublishedMatchingAuthority(captured) {
  assert.ok(captured !== null, 'the freeze barrier must have actually engaged (a second isFrozen read never happened)');
  assert.ok(captured.prepared.length > 0, `the barrier must observe at least one durably committed prepared stage attempt; captured=${JSON.stringify(captured)}`);
  const [{ stage, requestDigest }] = captured.prepared;
  assert.ok(captured.wrote, `the producer must actually publish a new artifact at the barrier (not reuse a stale one); captured=${JSON.stringify(captured)}`);
  const artifact = JSON.parse(captured.artifactText);
  const matching = artifact.entries.filter(entry => entry.signerRole === 'operator-evm'
    && entry.intent?.actionKind === stage && entry.intent?.subjectDigest === requestDigest);
  assert.equal(
    matching.length, 1,
    `the artifact on disk must carry exactly one operator-evm authorization matching the prepared stage/digest (${stage}/${requestDigest}); artifact=${captured.artifactText}`,
  );
  return { stage, requestDigest };
}

async function bootIsolatedRun(t, directory, fixture, authority) {
  const { root, binPath } = await isolatedSource(directory);
  const signer = await productionChildSigner(t, root, directory);
  await repointCopiedDeploymentIdentity(root, { evm: signer.evmAccount, solana: signer.solanaAccount });
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
  'I-authority-positive-control real per-step standing authority lets the first claim signature genuinely complete',
  { timeout: POSITIVE_WINDOW_MS + 60000 },
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'hookemon-authority-positive-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    let operationsEvm = `0x${'0'.repeat(40)}`;
    let operationsSolana = null;
    const fixture = await fixtureServer(t, directory, () => operationsEvm, () => operationsSolana, {});
    const authority = await createStandingAuthorityProducer(t, directory);
    const { root, binPath, signer, env } = await bootIsolatedRun(t, directory, fixture, authority);
    operationsEvm = signer.evmAccount;
    operationsSolana = signer.solanaAccount;

    const run = await runProductionWindow(binPath, env, POSITIVE_WINDOW_MS);
    await authority.stop();
    authority.assertHealthy();

    const diagnostics = async repository => JSON.stringify({
      calls: fixture.calls, authorityDiagnostics: authority.diagnostics, run,
      cycles: await Promise.all((await repository.listKnownCycleIds()).map(async cycleId => {
        const cycle = await repository.describeCycle(cycleId);
        return { cycleId, terminalState: cycle.terminalState, stages: [...cycle.stages.entries()].map(([stage, record]) => [stage, record?.status]) };
      })),
    });

    assert.ok(
      fixture.calls.usdgFrozenObservations.every(observed => observed === false),
      `this control run must never observe a freeze; observations=${JSON.stringify(fixture.calls.usdgFrozenObservations)}`,
    );
    assert.ok(authority.diagnostics.publishWrites > 0, `the real standing-authority producer must actually publish a signed step-authorization artifact; diagnostics=${JSON.stringify(authority.diagnostics)}`);

    const repository = await openIsolatedRepository(root, directory);
    const cycleIds = await repository.listKnownCycleIds();
    assert.equal(cycleIds.length, 1, `admission must durably succeed exactly once; ${await diagnostics(repository)}`);
    const cycle = await repository.describeCycle(cycleIds[0]);
    assert.equal(
      cycle.stages.get('claim-process')?.status, 'COMPLETE',
      `with a real, otherwise-valid per-step authority available, the first claim signature must genuinely reach completion (the actual authorized signing boundary); ${await diagnostics(repository)}`,
    );

    const invocations = await readSignerInvocations(signer);
    assert.ok(
      invocations.sign > 0,
      `at least one real child signing operation (not a probe) must occur once authority is available; invocations=${JSON.stringify(invocations.lines)}`,
    );
    assert.ok(
      fixture.calls.evmBroadcasts > 0,
      `the signed claim transaction must actually reach the loopback chain transport (scripted, not a real network); calls=${JSON.stringify(fixture.calls)}`,
    );
  },
);

test(
  'I-authority-freeze-boundary freeze holds the cycle on exactly USDG_FROZEN, with real authority verified available and unused',
  { timeout: (FREEZE_WINDOW_MS * 2) + 60000 },
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'hookemon-authority-freeze-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    let operationsEvm = `0x${'0'.repeat(40)}`;
    let operationsSolana = null;
    const authority = await createStandingAuthorityProducer(t, directory, { autoStart: false });
    const { freezeBarrier, getCaptured } = createFreezeAuthorityBarrier(authority);
    const fixture = await fixtureServer(t, directory, () => operationsEvm, () => operationsSolana, { freezeBarrier });
    const { root, binPath, signer, env } = await bootIsolatedRun(t, directory, fixture, authority);
    operationsEvm = signer.evmAccount;
    operationsSolana = signer.solanaAccount;

    const diagnostics = async repository => JSON.stringify({
      calls: fixture.calls, captured: getCaptured(),
      cycles: await Promise.all((await repository.listKnownCycleIds()).map(async cycleId => {
        const cycle = await repository.describeCycle(cycleId);
        return {
          cycleId, terminalState: cycle.terminalState, terminalEvidence: cycle.terminalEvidence,
          stages: [...cycle.stages.entries()].map(([stage, record]) => [stage, record?.status]),
        };
      })),
    });

    const run = await runProductionWindow(binPath, env, FREEZE_WINDOW_MS);

    // Both real observations occurred (unchanged from launch-failure-matrix.test.mjs's own case).
    assert.ok(fixture.calls.usdgFrozenObservations.length >= 2, `the real freeze reader must be observed at least twice; observations=${JSON.stringify(fixture.calls.usdgFrozenObservations)}`);
    assert.equal(fixture.calls.usdgFrozenObservations[0], false, `the first observation must be the healthy startup read; observations=${JSON.stringify(fixture.calls.usdgFrozenObservations)}`);
    assert.ok(fixture.calls.usdgFrozenObservations.slice(1).every(observed => observed === true), `every observation after the first must be frozen; observations=${JSON.stringify(fixture.calls.usdgFrozenObservations)}`);

    // The counterfactual precondition: authority for the exact refused request was verified present
    // on disk before this same second read was ever released as frozen.
    const { stage: heldStage } = assertBarrierPublishedMatchingAuthority(getCaptured());

    const repository = await openIsolatedRepository(root, directory);
    const cycleIds = await repository.listKnownCycleIds();
    assert.equal(cycleIds.length, 1, `admission must still succeed once; ${await diagnostics(repository)}`);
    const cycle = await repository.describeCycle(cycleIds[0]);
    assert.equal(cycle.terminalState, 'HELD_UNAVAILABLE', `the cycle must be truthfully held once the freeze is observed; ${await diagnostics(repository)}`);
    assert.equal(cycle.terminalEvidence?.stage, heldStage, `the hold must name the exact stage the barrier verified authority for; ${await diagnostics(repository)}`);
    const heldCodes = cycle.terminalEvidence?.drift?.map(item => item.code) ?? [];
    assert.deepEqual(heldCodes, ['USDG_FROZEN'], `the durable hold evidence must name exactly USDG_FROZEN and nothing else; ${await diagnostics(repository)}`);
    assert.ok(
      ![...cycle.stages.entries()].some(([stage, record]) => stage !== 'eligibility-snapshot' && record?.status === 'COMPLETE'),
      `no money-moving stage may be durably complete once the freeze is observed, even though authority for it was genuinely available; ${await diagnostics(repository)}`,
    );

    const invocations = await readSignerInvocations(signer);
    assert.equal(invocations.sign, 0, `no real signing operation may occur once the freeze is observed, even with authority verified available; invocations=${JSON.stringify(invocations.lines)}`);
    assert.equal(invocations.broadcast, 0, `no broadcast operation may occur once the freeze is observed; invocations=${JSON.stringify(invocations.lines)}`);
    assert.equal(fixture.calls.evmBroadcasts, 0, `no chain transaction may ever be broadcast; run=${JSON.stringify(run)}`);

    // Restart with the freeze fixture and authority artifact both unchanged on disk (the barrier's
    // captured state is reused for every read past the second, including across restart): the hold
    // must persist, read through a fresh repository handle, not the pre-restart one, whose in-memory
    // caches only reflect the earlier snapshot.
    const restart = await runProductionWindow(binPath, env, FREEZE_WINDOW_MS);
    assert.match(restart.stderr, /HELD_UNAVAILABLE/, `the restart's own tick diagnostics must report the persisted hold; run=${JSON.stringify(restart)}`);
    const repositoryAfterRestart = await openIsolatedRepository(root, directory);
    assert.deepEqual(await repositoryAfterRestart.listKnownCycleIds(), cycleIds, `restart must not admit a second cycle while the freeze holds; ${await diagnostics(repositoryAfterRestart)}`);
    const cycleAfterRestart = await repositoryAfterRestart.describeCycle(cycleIds[0]);
    assert.equal(cycleAfterRestart.terminalState, 'HELD_UNAVAILABLE', `the hold must persist across restart; ${await diagnostics(repositoryAfterRestart)}`);
    const invocationsAfterRestart = await readSignerInvocations(signer);
    assert.equal(invocationsAfterRestart.sign, 0, `no real signing operation may occur across restart either; invocations=${JSON.stringify(invocationsAfterRestart.lines)}`);
    assert.equal(invocationsAfterRestart.broadcast, 0, `no broadcast operation may occur across restart either; invocations=${JSON.stringify(invocationsAfterRestart.lines)}`);
  },
);

test(
  'I-authority-freeze-counterfactual-control the same publish-and-verify barrier, released healthy, actually signs the same prepared claim',
  { timeout: FREEZE_WINDOW_MS + 60000 },
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'hookemon-authority-counterfactual-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    let operationsEvm = `0x${'0'.repeat(40)}`;
    let operationsSolana = null;
    const authority = await createStandingAuthorityProducer(t, directory, { autoStart: false });
    const { freezeBarrier, getCaptured } = createReleasedAuthorityBarrier(authority);
    const fixture = await fixtureServer(t, directory, () => operationsEvm, () => operationsSolana, { freezeBarrier });
    const { root, binPath, signer, env } = await bootIsolatedRun(t, directory, fixture, authority);
    operationsEvm = signer.evmAccount;
    operationsSolana = signer.solanaAccount;

    const run = await runProductionWindow(binPath, env, FREEZE_WINDOW_MS);

    const diagnostics = async repository => JSON.stringify({
      calls: fixture.calls, captured: getCaptured(), run,
      cycles: await Promise.all((await repository.listKnownCycleIds()).map(async cycleId => {
        const cycle = await repository.describeCycle(cycleId);
        return { cycleId, terminalState: cycle.terminalState, stages: [...cycle.stages.entries()].map(([stage, record]) => [stage, record?.status]) };
      })),
    });

    if (getCaptured() === null) t.diagnostic(JSON.stringify({ calls: fixture.calls, run }));

    // The same barrier, the same real authority publish/verify step -- released healthy this time.
    assert.ok(
      fixture.calls.usdgFrozenObservations.every(observed => observed === false),
      `this counterfactual control must never actually observe a freeze; observations=${JSON.stringify(fixture.calls.usdgFrozenObservations)}`,
    );
    const { stage: preparedStage, requestDigest: preparedDigest } = assertBarrierPublishedMatchingAuthority(getCaptured());

    const repository = await openIsolatedRepository(root, directory);
    const cycleIds = await repository.listKnownCycleIds();
    assert.equal(cycleIds.length, 1, `admission must durably succeed exactly once; ${await diagnostics(repository)}`);
    const cycle = await repository.describeCycle(cycleIds[0]);
    assert.equal(
      cycle.stages.get(preparedStage)?.status, 'COMPLETE',
      `at the exact same authority state the frozen test verified was available and unused, releasing healthy instead must let the same prepared claim actually sign and complete; ${await diagnostics(repository)}`,
    );

    const invocations = await readSignerInvocations(signer);
    assert.ok(
      invocations.sign > 0,
      `at least one real child signing operation (not a probe) must occur; invocations=${JSON.stringify(invocations.lines)}`,
    );
    assert.ok(
      fixture.calls.evmBroadcasts > 0,
      `the signed claim transaction must actually reach the loopback chain transport (scripted, not a real network); calls=${JSON.stringify(fixture.calls)}`,
    );
    const completedAttempt = await repository.readOperationalStageAttempt?.(cycleIds[0], preparedStage) ?? null;
    if (completedAttempt !== null) {
      assert.equal(
        completedAttempt.attempt?.requestDigest, preparedDigest,
        `the completed attempt's own durable request digest must be the exact one the barrier published authority for; ${await diagnostics(repository)}`,
      );
    }
  },
);
