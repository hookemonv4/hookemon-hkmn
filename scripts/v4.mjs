#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { projectState } from './lib/state.mjs';
import { generateDocs } from './lib/policy.mjs';
import {
  authorizeNotApplicable, authorizeOwnerGateEvidence, checkGate, overrideGate,
  recordGateEvidence, reservedGateReceiptTypes, validateTaskDeferralApproval,
} from './lib/gates.mjs';
import { addReceipt } from './lib/receipts.mjs';
import {
  addRequirement, listRequirements, taskEvidenceContext, traceCheck,
} from './lib/reqs.mjs';
import { validatePack, composePacks } from './lib/packs.mjs';
import {
  openLedger, addTask, listTasks, nextTask, claimTask, heartbeatTask,
  completeTask, releaseTask, projectTasks, mergeEnqueue, mergeNext, mergeRecord,
  setTaskDeps, prepareTaskDeferral, deferTask, rebindCompletionCommit,
} from './lib/ledger.mjs';

const root = process.cwd();
const [cmd, sub, ...rest] = process.argv.slice(2);
const out = o => console.log(JSON.stringify(o));
const STATUS_CHECK_PASSING_RESULTS = new Set(['PASSED', 'OVERRIDDEN', 'PENDING']);

function flags(defs) {
  const { values, positionals } = parseArgs({ args: rest, options: defs, allowPositionals: true, strict: false });
  return { values, positionals };
}

try {
  if (cmd === 'status') {
    const state = projectState(root);
    out(state);
    if (sub === '--check' && state.phases.some(phase => !STATUS_CHECK_PASSING_RESULTS.has(phase.result))) {
      process.exitCode = 1;
    }
  }
  else if (cmd === 'policy' && sub === 'gen') { generateDocs(root); out({ ok: true }); }
  else if (cmd === 'gate' && sub === 'check') {
    const phase = rest[0];
    const r = checkGate(root, phase);
    projectState(root); out(r);
    process.exit(r.result === 'PASSED' ? 0 : 1);
  }
  else if (cmd === 'gate' && sub === 'override') {
    const phase = rest[0];
    const { values } = flags({
      rationale: { type: 'string' }, approval: { type: 'string' },
      rationalization: { type: 'string' },
    });
    const r = overrideGate(root, phase, values.rationale, values.approval, values.rationalization ?? null);
    projectState(root); out(r);
  }
  else if (cmd === 'gate' && sub === 'evidence') {
    const phase = rest[0];
    const { values } = flags({
      item: { type: 'string' }, input: { type: 'string', multiple: true },
    });
    out(recordGateEvidence(root, phase, values.item, values.input ?? []));
  }
  else if (cmd === 'gate' && sub === 'owner-authorize') {
    const phase = rest[0];
    const { values } = flags({
      item: { type: 'string' }, rationale: { type: 'string' }, approval: { type: 'string' },
      input: { type: 'string', multiple: true },
    });
    out(authorizeOwnerGateEvidence(
      root, phase, values.item, values.rationale, values.approval, values.input ?? [],
    ));
  }
  else if (cmd === 'gate' && sub === 'authorize-not-applicable') {
    const phase = rest[0];
    const { values } = flags({
      item: { type: 'string' }, rationale: { type: 'string' }, approval: { type: 'string' },
    });
    const r = authorizeNotApplicable(root, phase, values.item, values.rationale, values.approval);
    out(r);
  }
  else if (cmd === 'receipt' && sub === 'add') {
    const { values } = flags({
      type: { type: 'string' }, phase: { type: 'string' }, result: { type: 'string' },
      task: { type: 'string' }, commit: { type: 'string' }, input: { type: 'string', multiple: true },
    });
    if (reservedGateReceiptTypes(root).has(values.type)) {
      throw new Error(`${values.type} receipt type is reserved for gate commands`);
    }
    let data = {};
    let receiptPhase = values.phase ?? null;
    let receiptInputs = values.input ?? [];
    if (values.type === 'evidence' && values.task) {
      const context = taskEvidenceContext(root, values.task, values.commit ?? null);
      if (values.phase && values.phase !== context.phase) {
        throw new Error(`task ${values.task} phase ${context.phase} does not match requested ${values.phase}`);
      }
      if (!(values.input ?? []).some(input => !context.inputs.includes(input))) {
        throw new Error(`task ${values.task} evidence requires at least one verification artifact in addition to requirements`);
      }
      receiptPhase = context.phase;
      data = context.data;
      receiptInputs = [...new Set([...receiptInputs, ...context.inputs])];
    } else {
      if (values.task) data.taskId = values.task;
      if (values.commit) data.commitSha = values.commit;
    }
    out(addReceipt(root, {
      type: values.type, phase: receiptPhase, result: values.result ?? null,
      data, inputs: receiptInputs,
    }));
  }
  else if (cmd === 'task') {
    const db = openLedger(root);
    const id = rest[0];
    const { values } = flags({
      title: { type: 'string' }, phase: { type: 'string' }, risk: { type: 'string' },
      dep: { type: 'string', multiple: true }, req: { type: 'string', multiple: true },
      owner: { type: 'string' }, token: { type: 'string' }, ttl: { type: 'string' }, commit: { type: 'string' },
      from: { type: 'string' },
      rationale: { type: 'string' }, approval: { type: 'string' }, record: { type: 'string' },
    });
    if (sub === 'add') { addTask(db, { id, title: values.title, phase: values.phase, risk: values.risk, deps: values.dep ?? [], reqs: values.req ?? [] }); projectTasks(db, root); out({ ok: true, id }); }
    else if (sub === 'next') out({ task: nextTask(db) });
    else if (sub === 'claim') out(claimTask(db, id, values.owner, values.ttl ? Number(values.ttl) : undefined));
    else if (sub === 'heartbeat') { heartbeatTask(db, id, values.owner, Number(values.token), values.ttl ? Number(values.ttl) : undefined); out({ ok: true }); }
    else if (sub === 'complete') { completeTask(db, id, values.owner, Number(values.token), values.commit ?? null); projectTasks(db, root); out({ ok: true }); }
    else if (sub === 'rebind-completion') {
      rebindCompletionCommit(db, id, values.from, values.commit);
      projectTasks(db, root);
      out({ ok: true, id, commitSha: values.commit });
    }
    else if (sub === 'release') { releaseTask(db, id, values.owner, Number(values.token)); out({ ok: true }); }
    else if (sub === 'set-deps') { setTaskDeps(db, id, values.dep ?? []); projectTasks(db, root); out({ ok: true, id }); }
    else if (sub === 'defer') {
      const current = prepareTaskDeferral(db, id);
      const descriptor = validateTaskDeferralApproval(root, {
        taskId: id,
        phase: current.prestate.phase,
        rationale: values.rationale,
        descriptorInput: values.record,
        approvalInput: values.approval,
        prestate: current.prestate,
        prestateFingerprint: current.fingerprint,
      });
      deferTask(db, id, {
        authority: descriptor.authority,
      });
      projectTasks(db, root);
      out({ ok: true, id, status: descriptor.targetStatus });
    }
    else if (sub === 'list') out({ tasks: listTasks(db) });
    else if (sub === 'project') { projectTasks(db, root); out({ ok: true }); }
    else throw new Error(`unknown task subcommand ${sub}`);
  }
  else if (cmd === 'merge') {
    const db = openLedger(root);
    const { values } = flags({ task: { type: 'string' }, candidate: { type: 'string' }, integration: { type: 'string' }, merged: { type: 'string' } });
    if (sub === 'enqueue') out({ seq: mergeEnqueue(db, { taskId: values.task, candidateSha: values.candidate, integrationSha: values.integration }) });
    else if (sub === 'next') out({ next: mergeNext(db) });
    else if (sub === 'record') out({ result: mergeRecord(db, Number(rest[0]), { mergedSha: values.merged === '-' ? null : values.merged, currentIntegrationSha: values.integration }) });
    else throw new Error(`unknown merge subcommand ${sub}`);
  }
  else if (cmd === 'req') {
    const { values } = flags({ id: { type: 'string' }, kind: { type: 'string' }, title: { type: 'string' }, statement: { type: 'string' }, measurement: { type: 'string' }, module: { type: 'string' } });
    if (sub === 'add') out(addRequirement(root, values));
    else if (sub === 'list') out({ requirements: listRequirements(root) });
    else throw new Error(`unknown req subcommand ${sub}`);
  }
  else if (cmd === 'trace' && sub === 'check') {
    const r = traceCheck(root);
    out(r); process.exit(r.gaps.length ? 1 : 0);
  }
  else if (cmd === 'pack' && sub === 'validate') {
    const dirs = rest;
    const r = dirs.length > 1 ? composePacks(dirs) : validatePack(dirs[0]);
    out(r); process.exit(r.ok ? 0 : 1);
  }
  else {
    out({ error: `unknown command: ${cmd ?? '(none)'} — commands: status, policy gen, gate check|evidence|owner-authorize|override|authorize-not-applicable, receipt add, task ..., merge ..., req ..., trace check, pack validate` });
    process.exit(2);
  }
} catch (e) {
  console.error(String(e.message ?? e));
  process.exit(1);
}
