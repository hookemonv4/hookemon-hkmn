# fork-proof environment: narrow deployment-branch-policy addition proposal

**Status: proposal only. A has not called any GitHub API mutation endpoint and will not without explicit
owner action taken by the owner (or an operator the owner explicitly authorizes) directly.**

## Confirmed current state (read-only, via Terra's independent review)

Per `A3-terra-review.md`: the `fork-proof` environment has exactly one custom deployment branch policy —
`main` (policy id `59176106`), `protected_branches: false`, `custom_branch_policies: true` — plus a required
reviewer (`hookemonv4`). Evidence: `GET
https://api.github.com/repos/hookemonv4/hookemon-hkmn/environments/fork-proof/deployment-branch-policies`.
This is why the new PR-triggered `fork-proof` job (`.github/workflows/fork-proof.yml` `pull_request` job,
which checks out `github.event.pull_request.head.sha` read-only and re-runs the same proof) is rejected:
"Branch 'refs/pull/3/merge' is not allowed to deploy to fork-proof due to environment protection rules."

## What A confirmed from official GitHub REST API docs (this turn)

- List: `GET /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies`
- Create: `POST /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies`
  body: `{ "name": "<pattern>", "type": "branch" | "tag" }` (type defaults to `branch`); pattern matching
  follows glob-style rules where `*` does not cross `/` (e.g. `release/*/*` matches one extra path segment).
- Required-reviewer protection and deployment-branch-policy are two independent, additively-enforced
  environment protection rules: adding or widening a branch/tag policy does not remove, weaken, or bypass
  the existing required-reviewer rule for `hookemonv4`. Both must still pass for a deployment to proceed.

## What A could NOT independently confirm from fetched docs this turn

GitHub's public docs pages A attempted to fetch either 404'd or did not state explicitly whether a
`type: "branch"` deployment-branch-policy pattern matches refs outside `refs/heads/*` — specifically whether
it can be made to match the `pull_request`-triggered merge ref (`refs/pull/<number>/merge`, which is what
`github.ref` resolves to for that job) at all, or whether GitHub instead evaluates a PR-triggered job's base
branch for this purpose. **A is not asserting either behavior as confirmed** — this is exactly the kind of
claim this proposal must not fabricate.

## The proposed narrow, ready-to-approve action

Because the exact ref-matching mechanics are the one unconfirmed fact, A proposes the owner (or an operator
the owner explicitly authorizes) take this single verification-then-action step, rather than A guessing at a
pattern that might silently fail to match or might over-broaden the policy:

1. Owner directly inspects, in the GitHub UI, Settings → Environments → `fork-proof` → Deployment branches
   and tags, what "Selected branches and tags" pattern options GitHub's own environment editor currently
   offers for this repository (GitHub's own UI is authoritative over any pattern guess made here).
2. If the UI (or a `GET` to the deployment-branch-policies endpoint after a manual trial) confirms a pattern
   that admits `refs/pull/<number>/merge` for PR-triggered runs — for example a policy scoped to `main` is
   already documented by GitHub to also require confirming whether "Allow administrators to bypass"-style
   settings are involved for PR contexts — the owner adds **exactly one** additional deployment branch policy
   entry via `POST .../deployment-branch-policies` with the minimal pattern GitHub's own tooling confirms is
   correct. No existing policy entry (`main`, policy `59176106`) is removed or modified.
3. The required reviewer (`hookemonv4`) stays configured exactly as-is; this proposal adds a branch/tag
   policy entry only and touches no reviewer/protection-rule field.
4. After the addition, the owner reruns the PR's `fork-proof` job once to confirm it now executes (rather
   than being rejected before the read-only proof step runs) and that the required-reviewer prompt still
   appears exactly as before.

## Why A is not doing this itself

- This is a live GitHub Environment settings mutation, explicitly forbidden to A under this turn's
  instructions ("do not mutate environment").
- The one open technical fact (whether a branch-type pattern can match `refs/pull/*/merge` at all, or
  whether the correct approach is instead to scope the policy to the PR's base branch) needs GitHub's own
  authoritative behavior, which A could not fully confirm from the docs pages fetched this turn — verifying
  it against GitHub's live UI/API response, which only the owner (or an explicitly authorized operator with
  environment-admin access) can safely do, is the responsible way to avoid proposing a pattern that either
  silently fails to match or is broader than intended.
