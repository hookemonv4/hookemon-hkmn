# Phase 3 draft package

This directory is a content-addressed `ADDRESS_DERIVATION_PENDING` package. It binds the recorded request envelope and build inputs, but it is not a signable request or a provider POST body.

`package-manifest.json` now owns the source-bundle coverage declaration. It lists the implementation sources from `submission.json`, the Standard JSON input, and the three compiler artifacts. Attestation evidence and the project metadata image remain explicit unresolved fields. The source-bundle builder refuses to create a manifest until both paths are concrete and committed; it never fills them with a guessed file name.

Rebuild a disposable package with the package builder:

```sh
node scripts/programmable/build-launch-package.mjs \
  --artifacts release/phase3/artifacts \
  --standard-json-inputs release/phase3/build-info \
  --launch-inputs release/phase3/launch-inputs.json \
  --address-manifest release/phase3/address-manifest.json \
  --request-materialization-root . \
  --output /private/tmp/hookemon-phase3-package
```

Verify the committed draft with:

```sh
node scripts/programmable/verify-launch-package.mjs --allow-unverified
```

Without `--allow-unverified`, verification intentionally reports the unresolved launch-intent commitment. Resolve the provider graph preimage, the metadata image, and attestation evidence before treating a regenerated package as preflight-ready.
