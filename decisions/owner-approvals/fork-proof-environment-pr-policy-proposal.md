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

## Confirmed REST API shape and ref-matching semantics (official docs, coordinator-verified)

- List: `GET /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies`
- Create: `POST /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies`
  body: `{ "name": "<pattern>", "type": "branch" | "tag" }` (type defaults to `branch`).
- Ref-matching for `pull_request`-triggered deployments is explicitly documented, not inferred: GitHub's
  official docs, [Deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
  (source: https://github.com/github/docs/blob/main/content/actions/reference/workflows-and-actions/deployments-and-environments.md),
  state that adding a branch policy for the pattern `refs/pull/*/merge` allows workflow runs triggered by
  `pull_request` to deploy to a protected environment. This resolves the one fact A's own doc-fetch attempts
  this turn could not confirm (A's prior text speculated it might need base-branch matching instead — that
  speculation is withdrawn; the coordinator's citation above is authoritative and it is a distinct `branch`
  pattern entry, not a base-branch match).
- Required-reviewer protection and deployment-branch-policy are two independent, additively-enforced
  environment protection rules: adding this branch policy does not remove, weaken, or bypass the existing
  required-reviewer rule for `hookemonv4`. Both must still pass for a deployment to proceed.

## The proposed narrow, ready-to-approve action

Exact payload, addable with a single API call, changing nothing else:

```
POST /repos/hookemonv4/hookemon-hkmn/environments/fork-proof/deployment-branch-policies
{ "name": "refs/pull/*/merge", "type": "branch" }
```

1. The owner (or an operator the owner explicitly authorizes) adds this one deployment-branch-policy entry.
   The existing `main` policy (id `59176106`) and the required reviewer (`hookemonv4`) are untouched —
   neither removed nor modified.
2. After the addition, the owner reruns the PR's `fork-proof` job once to confirm it now executes (rather
   than being rejected before the read-only proof step runs) and that the required-reviewer prompt still
   appears exactly as before.

## Why A is not doing this itself

This is a live GitHub Environment settings mutation, explicitly forbidden to A under this turn's
instructions ("do not mutate environment"). The technical content of the proposal is now fully resolved
(exact payload, cited official source); only the actual API call remains, and only the owner (or an
explicitly authorized operator) may make it.
