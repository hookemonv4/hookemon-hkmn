import { open, readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

export const MANUAL_TEST_PLAN = Object.freeze({
  packCode: 'pokemon_25', quantity: 1, packPriceMicroUsd: '25000000',
  recipientLimit: 100, recipientTokenAddress: '0xC60bA256B44334A0Cd2C7242E98B88f031abB006',
  fundingSource: 'existing-wallet', chainId: 4663,
});

export function unavailableManualCycle(reasons = ['MANUAL_RUNTIME_NOT_CONNECTED']) {
  return { schemaVersion: 1, ready: false, reasons, executionMode: 'unavailable',
    revision: null, plan: { ...MANUAL_TEST_PLAN }, request: null };
}

async function syncDirectory(path) {
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

// The exclusive, synced first write is the admission latch. It is never deleted or reset. A crash
// before its first worker call conservatively consumes the test rather than risking another purchase.
async function writeRecord(path, record, exclusive = false) {
  const target = exclusive ? path : join(dirname(path), `.manual-cycle-${randomUUID()}.tmp`);
  const file = await open(target, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify({ ...record, digest: digest(record) })); await file.sync(); } finally { await file.close(); }
  if (!exclusive) await rename(target, path);
  await syncDirectory(path);
}

function digest(record) {
  const { digest: ignored, ...body } = record;
  void ignored;
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}
function expectedPlan(plan) {
  return Object.entries(MANUAL_TEST_PLAN).every(([key, value]) => plan?.[key] === value);
}
function assertRecord(record) {
  if (!record || record.schemaVersion !== 1 || typeof record.requestId !== 'string'
    || !/^[A-Za-z0-9_-]{8,128}$/.test(record.requestId) || typeof record.cycleId !== 'string'
    || !record.cycleId || !expectedPlan(record.plan)
    || !Number.isSafeInteger(record.expectedRevision) || record.expectedRevision < 0
    || !Number.isSafeInteger(record.configurationRevision) || record.configurationRevision < 0
    || record.digest !== digest(record)
    || !['running', 'uncertain', 'completed', 'failed'].includes(record.status)) {
    throw new Error('invalid manual cycle record');
  }
  return record;
}

export function createManualCycleControl({ path, readReadiness, cycleRepository, buildWorker, now = Date.now,
  wait = (ms, signal) => sleep(ms, undefined, { signal }), recoveryIntervalMs = 5000, maximumRecoveries = 12 }) {
  let pending = null;
  const abort = new AbortController();
  async function readRecord() {
    try { return assertRecord(JSON.parse(await readFile(path, 'utf8'))); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  function publicRequest(record) {
    return record === null ? null : { requestId: record.requestId, status: record.status,
      cycleId: record.cycleId, resultCode: record.resultCode };
  }
  async function status() {
    let readiness;
    try { readiness = await readReadiness(); }
    catch { readiness = unavailableManualCycle(['MANUAL_READINESS_UNAVAILABLE']); }
    let record;
    try { record = await readRecord(); }
    catch { return { ...unavailableManualCycle(['MANUAL_RECORD_UNREADABLE']), executionMode: 'manual' }; }
    const reasons = [...(readiness.reasons ?? [])];
    if (!expectedPlan(readiness.plan)) reasons.push('MANUAL_PLAN_MISMATCH');
    if (record !== null) reasons.push('MANUAL_TEST_ALREADY_REQUESTED');
    return { schemaVersion: 1, ready: readiness.ready === true && reasons.length === 0,
      reasons, executionMode: 'manual', revision: readiness.revision ?? null,
      plan: readiness.plan ?? { ...MANUAL_TEST_PLAN }, request: publicRequest(record) };
  }
  async function finish(record, result) {
    const matched = result?.cycleId === record.cycleId;
    const completed = matched && result.status === 'COMPLETE';
    const active = await cycleRepository.readActiveCycle();
    const next = { ...record, status: completed ? 'completed' : active === null && !matched ? 'failed' : 'uncertain',
      resultCode: result?.status ?? 'EXECUTION_UNCERTAIN', updatedAtMs: now() };
    await writeRecord(path, next);
  }
  async function execute(record, initial) {
    const worker = buildWorker();
    for (let attempt = 0; attempt <= maximumRecoveries; attempt += 1) {
      let result;
      try {
        result = initial && attempt === 0
          ? await worker.runOnce({ signal: abort.signal, manualCycleId: record.cycleId,
            manualPlan: { ...record.plan, configurationRevision: record.configurationRevision } })
          : await worker.recoverActiveCycle({ signal: abort.signal, manualCycleId: record.cycleId });
      } catch (error) {
        if (!/mutation remains unresolved after execution/.test(error?.message ?? '')) {
          await writeRecord(path, { ...record, status: 'uncertain', resultCode: 'EXECUTION_UNCERTAIN', updatedAtMs: now() });
          return;
        }
        result = { status: 'AWAITING_RECONCILIATION', cycleId: record.cycleId };
      }
      const active = await cycleRepository.readActiveCycle();
      const retry = !abort.signal.aborted && attempt < maximumRecoveries && active?.cycleId === record.cycleId
        && !active.terminalState && ['AWAITING_RECONCILIATION', 'WAITING_FOR_QUOTE_REFRESH', 'LEASE_HELD'].includes(result.status);
      if (!retry) { await finish(record, result); return; }
      await writeRecord(path, { ...record, status: 'running', resultCode: result.status, updatedAtMs: now() });
      try { await wait(recoveryIntervalMs, abort.signal); } catch { return; }
    }
  }

  function dispatch(record, initial) {
    pending = execute(record, initial).catch(() => {}).finally(() => { pending = null; });
  }
  async function request({ requestId, expectedRevision, actor = 'operator' }) {
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(requestId)
      || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      return { httpStatus: 400, body: { code: 'INVALID_MANUAL_REQUEST' } };
    }
    const existing = await readRecord();
    if (existing !== null) {
      if (existing.requestId !== requestId) return { httpStatus: 409, body: { ...await status(), code: 'MANUAL_TEST_ALREADY_REQUESTED' } };
      // Retries report the same durable outcome. They cannot restart admission or dispatch effects.
      return { httpStatus: pending ? 202 : 200, body: { ...await status(), code: 'MANUAL_REQUEST_REPLAY' } };
    }
    const current = await status();
    if (!current.ready || current.revision !== expectedRevision) {
      return { httpStatus: 409, body: { ...current, code: current.revision !== expectedRevision ? 'STALE_REVISION' : 'MANUAL_NOT_READY' } };
    }
    const record = { schemaVersion: 1, requestId, expectedRevision, actor,
      configurationRevision: (await readReadiness()).configurationRevision,
      cycleId: cycleRepository.nextCycleId(), status: 'running', resultCode: 'MANUAL_REQUEST_ACCEPTED',
      plan: current.plan, requestedAtMs: now(), updatedAtMs: now() };
    if (!Number.isSafeInteger(record.configurationRevision) || record.configurationRevision < 0) {
      return { httpStatus: 409, body: { ...current, ready: false, code: 'MANUAL_NOT_READY', reasons: ['CONFIGURATION_REVISION_UNAVAILABLE'] } };
    }
    try { await writeRecord(path, record, true); }
    catch (error) {
      if (error.code === 'EEXIST') return request({ requestId, expectedRevision, actor });
      throw error;
    }
    // Readiness is revalidated after the durable reservation, immediately before dispatch.
    const fresh = await readReadiness();
    if (!fresh.ready || fresh.revision !== expectedRevision || fresh.configurationRevision !== record.configurationRevision || JSON.stringify(fresh.plan) !== JSON.stringify(record.plan)) {
      await writeRecord(path, { ...record, status: 'failed', resultCode: 'READINESS_CHANGED' });
      return { httpStatus: 409, body: { ...await status(), code: 'READINESS_CHANGED' } };
    }
    dispatch(record, true);
    return { httpStatus: 202, body: { ...current, ready: false, reasons: ['MANUAL_TEST_ALREADY_REQUESTED'],
      request: publicRequest(record), code: 'MANUAL_REQUEST_ACCEPTED' } };
  }
  async function recover() {
    const record = await readRecord();
    if (pending || record === null || ['completed', 'failed'].includes(record.status)) return;
    const readiness = await readReadiness({ recovery: true, cycleId: record.cycleId });
    if (!readiness.ready || !expectedPlan(readiness.plan)
      || JSON.stringify(readiness.plan) !== JSON.stringify(record.plan)) return;
    const active = await cycleRepository.readActiveCycle();
    if (active?.cycleId !== record.cycleId) {
      // The journal can show completion after a crash before the HTTP receipt was written.
      const described = await cycleRepository.describeCycle(record.cycleId).catch(() => null);
      const complete = described?.terminalState === 'COMPLETED';
      await writeRecord(path, { ...record, status: complete ? 'completed' : 'uncertain',
        resultCode: complete ? 'COMPLETE' : 'MANUAL_RECOVERY_REQUIRES_RECONCILIATION' });
      return;
    }
    dispatch(record, false);
  }
  return Object.freeze({ status, request, recover, stop: () => abort.abort(), settled: () => pending ?? Promise.resolve() });
}
