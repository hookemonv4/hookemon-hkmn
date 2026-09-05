# V4 Pack Validation

## Purpose

Pack validation ensures that framework packs compose without ambiguous identifiers, unsupported core versions, dependency cycles, or overlapping owned paths.

## Public interface

- `node scripts/v4.mjs pack validate <pack-directory>` validates one pack.
- `node scripts/v4.mjs pack validate <pack-a> <pack-b> ...` validates and composes several packs.
- `validatePack()` and `composePacks()` provide the same behavior to control tests.

## Invariants

- A manifest is read once and must be a JSON object with every required field.
- IDs and namespaces use lowercase hyphenated identifiers.
- Versions are strict semantic versions and `coreCompat` must include the installed framework core.
- Every contribution field is an array.
- A pack cannot depend on itself, a missing pack, or a dependency cycle.
- Pack IDs and namespaces are unique across a composition.
- Owned paths are repository-relative and reject traversal, backslashes, empty segments, case-folded collisions, hierarchical overlaps, trailing dots or spaces, and Windows device names.
- Blocking advisories make the pack invalid.

## State transitions

Pack validation is stateless. A manifest is either valid by itself, valid only within a complete dependency composition, or rejected with deterministic errors.

## Operational commands

```sh
node scripts/v4.mjs pack validate packs/base
node --test scripts/tests/packs.test.mjs
```

## Recovery pointers

- Correct the manifest rather than suppressing a validation error.
- Add every declared dependency to the composition command.
- Rename or narrow path ownership when two packs overlap.
- Keep the vendored base-pack digest synchronized through the dependency verification flow.
