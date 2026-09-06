# Programmable V4 preflight

The V4 source-bundle digest and launch-attempt nonce rules are settled by the [provider statement of 2026-09-05](../admission/provider-statement-2026-09-05.json). The request remains read-only: it does not sign, broadcast, deploy, or create a launch.

## Source bundle

`sourceDescriptor.sourceBundleDigest` is:

```text
keccak256(utf8("programmable.source-bundle.v2") || 0x00 || utf8(JCS(sourceBundleManifest)))
```

`0x00` is exactly one byte. `JCS` is [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785), including UTF-16 property-name ordering, RFC string escaping, ECMAScript integer serialization, and UTF-8 output. The manifest builder rejects floating-point values, duplicate paths, a listed missing file, and a symlink in any listed path component. It records only regular files with mode `100644` and `symlinkTarget: null`; entries are sorted by the UTF-8 bytes of `path` and must match the claimed Git commit byte-for-byte.

The generated package declaration at [`../package/package-manifest.json`](../package/package-manifest.json) explicitly covers:

- The seven `implementation.sourcePaths` from `release/phase3/submission.json`, recursively.
- `release/phase3/build-info/launch.json` as the Standard JSON input.
- `release/phase3/artifacts/custody.json`, `hook.json`, and `token.json` as compiler artifacts.

The descriptor uses `schemaVersion: "2.0.0"`, kind `deterministic-source-bundle`, and the launch wallet as `controllerWallet`. `sourceLineageNonce` is currently the initial lineage string `"1"`. Until the provider documents those two derivations, `bundleContentSha256` is the SHA-256 digest of the JCS manifest bytes and `publicOriginCommitment` is `keccak256(JCS({repositoryUrl, sourceCommit, sourceTree}))`. These are explicit local assumptions for the next preflight response to confirm or reject; they are not launch authorization.

OPEN FACT — source-bundle coverage is incomplete.

Missing: a committed attestation evidence file and the selected project metadata image with repository-relative paths. Resolve: commit those two inputs, replace the two unresolved coverage fields in the package declaration, regenerate the package, and run preflight again. Verified alternative: keep the coverage declaration explicit and refuse manifest materialization before any provider POST.

## Launch attempt and retries

For a new attempt, the tool generates one cryptographically random 32-byte nonce, rejects all-zero output, and formats it as `0x` plus 64 lowercase hex characters. It persists that nonce, the request's RFC 8785 bytes and SHA-256 digest, and the V4 idempotency-header state in a mode-`600` record. The default record is outside the repository at `~/.hookemon/programmable/launch-attempt.json`; its evidence directory is a sibling outside the repository. Use `--launch-attempt <path>` to choose another outside-repository location.

The retained V4 contract does not define an idempotency header, so the record explicitly stores that no header or key is available. A retry reuses the stored nonce and request bytes byte-for-byte. `--new-launch-attempt` is required to create a record at an unused path; an existing record is never replaced. The tool atomically reserves each request and allows at most five preflight requests per attempt; it removes secret-looking fields and the configured API key from evidence.

## Commands

Use the same attempt record for dry-run and preflight. Create the record explicitly with `--new-launch-attempt`; the dry-run then prints a secret-stripped request and the subsequent command sends exactly the stored bytes.

```sh
node scripts/programmable/preflight.mjs \
  --repository-url "$(git remote get-url origin)" \
  --source-commit "$(git rev-parse HEAD)" \
  --source-tree "$(git rev-parse HEAD^{tree})" \
  --launch-attempt /private/tmp/hookemon-launch-attempt.json \
  --new-launch-attempt \
  --dry-run

node scripts/programmable/preflight.mjs \
  --repository-url "$(git remote get-url origin)" \
  --source-commit "$(git rev-parse HEAD)" \
  --source-tree "$(git rev-parse HEAD^{tree})" \
  --launch-attempt /private/tmp/hookemon-launch-attempt.json
```

The source flags must be the exact lowercase 40-hex object IDs for the current `HEAD` and its tree. `--status <requestId>` remains read-only and does not create or alter an attempt record.

The command deliberately reads package evidence from `HEAD`, not uncommitted files. Commit a regenerated package before preflight; otherwise it exits locally without a provider request.

If the provider rejects public-origin or provenance because the public repository default branch is still the initial squash `37c0f95`, the command preserves the rejection in the external evidence path it prints. The owner must run `~/.hookemon/push-live.sh --reseed` before retrying that same immutable request; do not change the stored nonce or request bytes.

If an interrupted preflight leaves a `.reservation.lock`, verify that no preflight process is active before removing only that confirmed stale lock. A numbered `.pending.json` permanently consumes a slot in the five-request cap because the provider may already have received it. Do not delete or retry it without an explicit owner accepted-risk decision.
