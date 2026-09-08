# V4 Task Traceability

## Purpose

Task traceability connects typed requirements, fenced task execution, completion commits, evidence receipts, and serial integration records.

## Public interface

- `node scripts/v4.mjs req add` and `req list` manage typed requirements.
- `node scripts/v4.mjs task add|set-deps|defer|claim|heartbeat|complete|rebind-completion|rebind-completion-composite-provenance|release|list|project` manages the SQLite ledger and committed projection.
- `node scripts/v4.mjs receipt add --type evidence --task <id> --input <path>` creates evidence for a completed projected task.
- `node scripts/v4.mjs trace check` verifies requirement coverage and completed-task evidence from committed projections.
- `node scripts/v4.mjs task prepare-bindings <id>` reads the unleased task prestate for requirement-binding recovery. `task recover-bindings <id> --record decisions/task-bindings/<id>.json --approval decisions/owner-approvals/<approval>.json` applies an exact approved correction.
- `task prepare-operation <id>` reads the completed unbound task prestate. `task accept-operation <id> --record decisions/task-operations/<id>.json --approval decisions/owner-approvals/<approval>.json` records an exact owner-approved process disposition.
- `node scripts/v4.mjs merge enqueue|next|record` serializes integration candidates.
- [Finding traceability](finding-traceability.md) builds and verifies audited finding dispositions for phase-three work packages.

## Invariants

- Requirement IDs are stable and unique.
- Every active projected task binds at least one known requirement or carries a validated owner-approved operational acceptance. Operational tasks contribute no product requirement coverage and still require completed-task evidence. Owner-deferred tasks are excluded from active requirement coverage and delivery-boundary records.
- A projected task cannot reference an unknown requirement.
- Requirement-binding recovery accepts an unleased `ready` or `done` task. Its `v4-task-binding-recovery-v1` descriptor has exactly `schema`, `action` (`TASK_BIND_REQUIREMENTS`), `taskId`, `prestate`, `prestateFingerprint`, `requirements`, `bindings`, and `rationale`. The prestate comes from `prepare-bindings` and includes the fencing token and latest successful attempt sequence and commit. `requirements` binds the current `revision` and `sha256` of `specs/requirements.json`.
- Each recovered binding names `requirementId`, `contribution` (`implementation`, `supporting`, or `test`), `rationale`, and `evidence` (repository-relative verification paths mapped to their SHA-256 hashes). Requirement IDs must be unique and currently approved. A `v4-owner-approval-v2` artifact must approve action `TASK_BIND_REQUIREMENTS`, the task phase and ID, the same rationale, and exactly the descriptor hash. A known requirement alone does not establish relevance; the owner approves the exact qualified contributions.
- Recovery rechecks the task, specification, evidence, and approval inside a transaction. It changes only `reqs` and appends the full descriptor and authority hashes to `task_binding_recoveries`; it preserves completion attempts, status, dependencies, fencing tokens, and receipts. An active or expired lease, changed prestate, changed approved descriptor, or repeated application refuses. Existing evidence becomes invalid when its task fingerprint changes; recovery is neither a passing evidence receipt nor proof of full requirement acceptance.
- Recovery does not exempt operational tasks from traceability or create product requirements for maintenance work. The CLI validates the whole task projection before applying a correction, so unrelated orphan completion history must be resolved through its supported provenance route first. Completion ancestry remains mandatory.
- Operational acceptance is separate from requirement recovery and never inferred from a task name. It accepts only unleased completed tasks with empty product requirements. Its `v4-task-operational-acceptance-v1` descriptor contains exactly `schema`, `action` (`TASK_ACCEPT_OPERATIONAL`), `taskId`, `prestate`, `prestateFingerprint`, `processSources`, and `rationale`. `processSources` maps actual governing process paths to SHA-256 hashes and must include `policy/policy.json`. Owner approval binds exactly this descriptor, action, task phase, task ID, and rationale; approving the capability does not approve any individual disposition.
- Operational acceptance appends the full descriptor and owner approval to `task_operational_acceptances`, changes no task or attempt row, and validates all completed-task ancestry before writing. The projection includes the descriptor path/hash, approval path/hash, and prestate fingerprint; generating or consuming it revalidates the exact task, completion, governing sources, and owner authority. Operational acceptance never authorizes signing, deployment, a gate exception, or product requirement coverage.
- Operational evidence binds the disposition, owner approval, governing process sources, current specification, and at least one additional verification artifact. Those authority fields participate in the task fingerprint. Stale policy, changed task/completion, missing authority, or an altered projection refuses; old evidence cannot silently become current. Refreshing stale process acceptance requires a new exact approved descriptor and appends history, retaining the previous descriptor and approval in the ledger. Identical replay refuses. Product bindings cannot be added to an operationally accepted task through the recovery route.
- `set-deps` may change only the dependencies of an unleased `ready` task. Its dependencies must be known, unique, non-self-referential, and acyclic; attempts and fencing tokens do not change.
- `defer` is terminal and accepts only an unleased `ready` or `done` task with no non-deferred dependent. It preserves attempts and fencing tokens.
- A deferred projection has no `commitSha` and carries only its owner-approval path, immutable descriptor path, and exact prestate fingerprint as deferral authority.
- Deferral requires the exact Ask-First policy, the no-self-approval policy, a repository-internal immutable descriptor, and an owner approval that binds that descriptor and `policy/policy.json`. The descriptor binds the task ID, phase, rationale, requirements revision and hash, ADR and design hashes, and the exact ledger prestate.
- Fencing tokens prevent an expired or superseded worker from completing a task.
- Task phases are restricted to the framework phase set.
- A completed task projects only a full lowercase 40-hex Git commit that exists as a commit object, is reachable from the current `HEAD`, and was recorded by its successful ledger attempt.
- `rebind-completion` requires the requested `--from` to equal the task's current completion commit and appends one new `done` attempt on success; it never edits or removes an existing attempt. It accepts exactly two routes, evaluated in order: (1) `descendant` — `--from` is itself reachable from current `HEAD`, and the new commit is reachable from `HEAD` and a descendant of `--from`; (2) `stable-patch-id` — `--from` is not reachable from current `HEAD` (a rewritten source), both `--from` and the new commit are full, existing, non-merge commit objects, both produce a non-empty `git patch-id --stable` value and those IDs are equal, and both produce a byte-identical canonical raw patch. The canonical raw patch is `git show --no-color --no-textconv --no-renames --no-ext-diff --no-relative --ignore-submodules=none --submodule=short --src-prefix=a/ --dst-prefix=b/ --full-index --binary --format=`, rendered and compared as raw bytes (never UTF-8-decoded, since committed content is not guaranteed to be valid UTF-8) with only the blob object IDs in `index` lines and the line-number coordinates in hunk headers normalized; everything else — whitespace, binary payloads, paths, modes, gitlink targets, and all changed content — is compared byte-for-byte, because patch ID alone ignores whitespace and can equate distinct semantic changes, and inherited repository diff configuration (an external diff driver, path relativization, or `diff.ignoreSubmodules`) could otherwise hide or alter rendered content. There is no third route: semantic equivalence, range substitution, and broad head substitution are never accepted, regardless of task or origin. Any other case — a malformed or missing commit object, an unreachable new commit, a merge commit on the `stable-patch-id` route, an empty patch, unequal patch IDs, an unequal canonical raw patch, or a reachable `--from` whose new commit does not descend from it — is rejected without mutating the ledger.
- Every `rebind-completion` attempt records machine-readable provenance naming its route (`descendant` or `stable-patch-id`), the `--from` and target commits, and, on the `stable-patch-id` route, the shared patch ID and the canonical raw patch's SHA-256 digest. The CLI always derives this provenance from the commits themselves; no caller-supplied value is ever recorded as provenance.
- `rebind-completion-composite-provenance` is a separate command, never a third route of `rebind-completion`: it is permanently restricted to task `BOT-CLEANROOM` and requires an authenticated owner-approval descriptor at `decisions/task-rebinds/BOT-CLEANROOM.json`, bound by a repo-internal owner approval (`v4-owner-approval-v2`) whose `subjectHashes` cover only that descriptor file. The descriptor binds the task's exact prestate fingerprint, `--from` and target commits, a five-path `retainedPatch` (sorted unique paths, a `sourceCommit` reachable from the target, and a canonical patch SHA-256), exactly two `omittedFiles` (path plus blob object id, disjoint from the retained paths), and a `domainFoundationCommit`/`domainMergeCommit` pair. At validation every value is independently recomputed from the repository, never trusted from the descriptor: `--from` must be an existing, non-merge, HEAD-unreachable commit that changes exactly the seven declared paths and no other path; the canonical patch of `--from` restricted to the five retained paths must equal both the descriptor's declared SHA-256 and the canonical patch of `sourceCommit` (itself non-merge, reachable from the target, and touching exactly those five paths); each omitted file's git blob id must be byte-identical across `--from`, `domainFoundationCommit`, and the target; `domainMergeCommit` must be an actual merge commit reachable from the target with `domainFoundationCommit` as one of its ancestors. It never accepts semantic similarity, a different task, or a target not covered by a freshly bound descriptor and approval. A stale reinvocation whose current completion no longer equals `--from` is refused without appending another record.
- Completed-task evidence matches the task ID, phase, completion commit, deterministic task fingerprint, and the complete requirements revision and content hash.
- The fingerprint covers ID, title, phase, requirements, dependencies, risk, status, and commit.
- Task evidence automatically includes `specs/requirements.json` and requires at least one additional fresh content-addressed verification artifact.
- Requirement-to-task coverage becomes mandatory only after the tasks gate is authoritatively passed or overridden.
- The merge queue accepts one integration base at a time; a changed integration SHA moves a candidate to retest.

## State transitions

1. A task begins `ready`.
2. `claim` grants a lease owner, expiry, and monotonically increasing fencing token.
3. `set-deps` replaces dependencies only before a task is leased or completed.
4. `heartbeat` extends only the matching lease.
5. `complete` validates reachability, records the successful attempt and commit, then moves the task to `done`.
6. `rebind-completion` validates the descendant or stable-patch-id route against the current completion, then appends a new `done` attempt carrying derived provenance without changing prior attempts.
7. `rebind-completion-composite-provenance` validates the BOT-CLEANROOM-only owner-approved descriptor and its bound approval against the current completion and the repository, then appends a new `done` attempt carrying the derived composite-provenance record without changing prior attempts.
8. `defer` validates the owner-bound descriptor against the current prestate, then moves an eligible task to terminal `deferred`.
9. `project` revalidates completion commits and writes `tasks.json`; task evidence binds that exact projected definition and requirements revision.
10. A candidate moves from `queued` to `merged`, or to `retest` when its integration base changed.

## Operational commands

```sh
node scripts/v4.mjs task list
node scripts/v4.mjs task project
node scripts/v4.mjs task set-deps P1-012 --dep P1-008 --dep P1-009 --dep P1-010
node scripts/v4.mjs task defer P1-011 --rationale "Dashboard deferred to Phase 2 by the owner-approved manual one-cycle scope" --record decisions/task-deferrals/P1-011.json --approval decisions/owner-approvals/phase-1-revision-55-dashboard-deferral-approved.json
node scripts/v4.mjs task rebind-completion-composite-provenance BOT-CLEANROOM --from 1176f7b239ed1f325d584fb35ed297ed0e4a8924 --commit ebd5a22faba8a86789d9487436f24d4229e8a835 --rationale "Owner-approved composite provenance: five files are an exact retained patch, two are byte-identical through the independently merged domain foundation" --record decisions/task-rebinds/BOT-CLEANROOM.json --approval decisions/owner-approvals/bot-cleanroom-composite-provenance.json
node scripts/v4.mjs trace check
node scripts/v4.mjs merge next
```

## Recovery pointers

- Release an abandoned live lease with its current owner and fencing token, or reclaim it only after expiry.
- Reproject `tasks.json` from the ledger. Never edit the projection by hand.
- If a task definition or completion commit changes, append new evidence for the new fingerprint.
- If requirements change, append new task evidence bound to the new requirements revision and hash.
- If `set-deps` or `defer` fails, the ledger transaction leaves task state, attempts, and fencing intact. Correct the requested dependencies or create a fresh descriptor and owner approval bound to the current prestate, then retry.
- Do not edit `tasks.json` to recover a deferral. Reproject it from the ledger after a successful owner-approved transition.
- Retest a merge candidate against the current integration SHA before recording it as merged.
- If `rebind-completion` fails, the ledger transaction leaves attempts and task state intact. There is no override or exception route: obtain or reconstruct a genuine descendant or an exact patch-equivalent rewritten commit, then retry.
- If `rebind-completion-composite-provenance` fails, no attempt or task state changes. It never falls back to `rebind-completion`'s routes or to a broader authority; correct or re-derive the descriptor and its owner approval against the current repository and task prestate, then retry. A target change requires a freshly bound descriptor and approval, never a wildcard re-run against `HEAD`.
