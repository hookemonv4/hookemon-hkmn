# Tracked Project Fixtures

## Purpose

The tracked-project fixture helper builds disposable test projects from Git-index-listed paths. It keeps untracked worktree data out of copied fixtures.

## Public interface

- `copyTrackedProjectFiles(sourceRoot, targetRoot)` copies the selected source paths into a separate target root.
- `scripts/tests/helpers/tracked-project.mjs` provides the helper to control tests. Application code does not import it.

## Invariants

- `git ls-files -z` selects source paths. The helper copies current working-tree bytes for tracked files, not a committed snapshot.
- Git metadata, ignored and other untracked files remain outside the fixture.
- Each source entry exists as a regular file or an internal symlink whose resolved target stays inside the source root.
- Source and target roots do not overlap through lexical paths, real paths, or aliases.
- The requested target root and its existing path components contain no symlinks.
- The helper validates every source entry before it creates the target root.

## State transitions

1. The helper resolves the source root and asks Git for index-listed paths.
2. It validates every source file and symlink.
3. It validates target aliases and source-target separation.
4. It creates the target root, copies regular files, and recreates internal symlinks.

## Operational commands

```sh
node --test scripts/tests/tracked-project.test.mjs
```

## Recovery pointers

- Discard a partially populated target after a copy failure, repair the source or target path, and create a new fixture.
- Add a required fixture input to the Git index. Do not copy ignored or other untracked paths around the helper.
- Use a target outside the source tree with no symlinked path components.
