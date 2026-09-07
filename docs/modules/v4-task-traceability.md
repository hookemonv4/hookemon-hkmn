# V4 Task Traceability

## Purpose

Task traceability connects typed requirements, fenced task execution, completion commits, evidence receipts, and serial integration records.

## Public interface

- `node scripts/v4.mjs req add` and `req list` manage typed requirements.
- `node scripts/v4.mjs task add|set-deps|defer|claim|heartbeat|complete|rebind-completion|release|list|project` manages the SQLite ledger and committed projection.
- `node scripts/v4.mjs receipt add --type evidence --task <id> --input <path>` creates evidence for a completed projected task.
- `node scripts/v4.mjs trace check` verifies requirement coverage and completed-task evidence from committed projections.
- `node scripts/v4.mjs merge enqueue|next|record` serializes integration candidates.
- [Finding traceability](finding-traceability.md) builds and verifies audited finding dispositions for phase-three work packages.

## Invariants

- Requirement IDs are stable and unique.
- Every active projected task binds at least one known requirement. Owner-deferred tasks are excluded from active requirement coverage and delivery-boundary records.
- A projected task cannot reference an unknown requirement.
- `set-deps` may change only the dependencies of an unleased `ready` task. Its dependencies must be known, unique, non-self-referential, and acyclic; attempts and fencing tokens do not change.
- `defer` is terminal and accepts only an unleased `ready` or `done` task with no non-deferred dependent. It preserves attempts and fencing tokens.
- A deferred projection has no `commitSha` and carries only its owner-approval path, immutable descriptor path, and exact prestate fingerprint as deferral authority.
- Deferral requires the exact Ask-First policy, the no-self-approval policy, a repository-internal immutable descriptor, and an owner approval that binds that descriptor and `policy/policy.json`. The descriptor binds the task ID, phase, rationale, requirements revision and hash, ADR and design hashes, and the exact ledger prestate.
- Fencing tokens prevent an expired or superseded worker from completing a task.
- Task phases are restricted to the framework phase set.
- A completed task projects only a full lowercase 40-hex Git commit that exists as a commit object, is reachable from the current `HEAD`, and was recorded by its successful ledger attempt.
- `rebind-completion` requires the requested `--from` to equal the task's current completion commit and appends one new `done` attempt on success; it never edits or removes an existing attempt. It accepts exactly two routes, evaluated in order: (1) `descendant` — `--from` is itself reachable from current `HEAD`, and the new commit is reachable from `HEAD` and a descendant of `--from`; (2) `stable-patch-id` — `--from` is not reachable from current `HEAD` (a rewritten source), both `--from` and the new commit are full, existing, non-merge commit objects, both produce a non-empty `git patch-id --stable` value and those IDs are equal, and both produce a byte-identical canonical raw patch. The canonical raw patch is `git show --no-color --no-textconv --no-renames --no-ext-diff --no-relative --ignore-submodules=none --submodule=short --src-prefix=a/ --dst-prefix=b/ --full-index --binary --format=`, rendered and compared as raw bytes (never UTF-8-decoded, since committed content is not guaranteed to be valid UTF-8) with only the blob object IDs in `index` lines and the line-number coordinates in hunk headers normalized; everything else — whitespace, binary payloads, paths, modes, gitlink targets, and all changed content — is compared byte-for-byte, because patch ID alone ignores whitespace and can equate distinct semantic changes, and inherited repository diff configuration (an external diff driver, path relativization, or `diff.ignoreSubmodules`) could otherwise hide or alter rendered content. There is no third route: semantic equivalence, range substitution, and broad head substitution are never accepted, regardless of task or origin. Any other case — a malformed or missing commit object, an unreachable new commit, a merge commit on the `stable-patch-id` route, an empty patch, unequal patch IDs, an unequal canonical raw patch, or a reachable `--from` whose new commit does not descend from it — is rejected without mutating the ledger.
- Every `rebind-completion` attempt records machine-readable provenance naming its route (`descendant` or `stable-patch-id`), the `--from` and target commits, and, on the `stable-patch-id` route, the shared patch ID and the canonical raw patch's SHA-256 digest. The CLI always derives this provenance from the commits themselves; no caller-supplied value is ever recorded as provenance.
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
7. `defer` validates the owner-bound descriptor against the current prestate, then moves an eligible task to terminal `deferred`.
8. `project` revalidates completion commits and writes `tasks.json`; task evidence binds that exact projected definition and requirements revision.
9. A candidate moves from `queued` to `merged`, or to `retest` when its integration base changed.

## Operational commands

```sh
node scripts/v4.mjs task list
node scripts/v4.mjs task project
node scripts/v4.mjs task set-deps P1-012 --dep P1-008 --dep P1-009 --dep P1-010
node scripts/v4.mjs task defer P1-011 --rationale "Dashboard deferred to Phase 2 by the owner-approved manual one-cycle scope" --record decisions/task-deferrals/P1-011.json --approval decisions/owner-approvals/phase-1-revision-55-dashboard-deferral-approved.json
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
