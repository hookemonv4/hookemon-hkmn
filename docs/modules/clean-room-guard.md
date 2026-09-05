# Clean Room Guard

## Purpose

The clean-room guard keeps the active repository limited to the approved Hookemon Robinhood control surface and neutral project identity.

## Public interface

- `node scripts/check-cleanroom.mjs .` scans tracked files and non-ignored untracked files, including statically reconstructible protected markers.
- `node scripts/check-commit-identity.mjs <base-sha> <head-sha>` verifies commit authors and committers in a range. Twenty-four immutable historical commits have SHA- and rule-specific identity exceptions; every unknown commit remains rejected.

## Invariants

- Retired project markers are stored only as lowercase SHA-256 digests with lengths and boundary rules.
- Revision-56 vault identifiers pass only when the complete case-sensitive ASCII identifier matches the explicit digest allowlist. A substring or case variant never inherits the exception.
- The previous-chain comparison artifact is accepted only at its exact digest-bound path with its exact content digest. Path prefixes, suffixes, copies, renames, and byte drift fail closed.
- The scanner checks paths, filenames, text, NUL-containing blobs, and tracked symlink targets without following them.
- Static source reconstructions through `String.fromCharCode`, character-code arrays, literal hex/base64 `Buffer.from(...).toString`, `new Function`, and `eval` fail when their reconstructed value or code-unit length matches a protected digest rule. The guard never executes scanned source.
- Local home paths, private email addresses, attribution trailers, and Programmable live-key shapes are rejected.
- Only the exact Hookemon project noreply identity is allowed in repository text and commit metadata.
- Historical Git identity exceptions match a full commit SHA and an exact rule. They cannot exempt a different commit or rule, and new attribution trailers remain rejected.
- The approved repository slug remains allowed.
- Ignored untracked build output is outside the scan; tracked files remain inside it.

## State transitions

The guard is stateless. A tree or commit range either contains zero findings and passes, or reports every detected rule and fails.

## Operational commands

```sh
node scripts/check-cleanroom.mjs .
node scripts/check-commit-identity.mjs <base-sha> <head-sha>
```

## Recovery pointers

- Replace a rejected active-tree artifact with a clean-room equivalent. Do not copy historical production assumptions into the replacement.
- Migrate historical rehearsal payout evidence before projection: move the unchanged canonical atomic string into `proceedsMicroSolanaStable`, append it as fresh canonical stage evidence, and use the resulting content-addressed journal head. Do not retain a compatibility property or runtime fallback.
- Update the revision-56 identifier digest allowlist only through an explicit control change when a new canonical identifier is required.
- Regenerate the previous-chain comparison artifact from its approved source set when its content changes; never weaken its path or content binding.
- Amend an unpushed commit with the approved project identity. Never force-push an already shared history for this purpose.
- Rotate an exposed credential outside the repository; do not add it to an allowlist.
