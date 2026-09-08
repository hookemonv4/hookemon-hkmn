# Native hook constructor digest preimages

At source revision `248a9bede74081421e6f37d2642705324d99fabb`, no complete native preimage formula was found for `ConstructorConfig.bindingDigest` or `runtimeDigest`. Both are nonzero, immutable expected commitments; their semantics are not arbitrary owner-selected nonces. The approved reproducibility requirement still requires exact attributable evidence. This investigation supplies no digest value, approval, or provider request.

The source references and their exact SHA-256 identities are recorded in `sources.json`. Inspection used the existing pinned official CLI 4.1.0 archive, without a new download or credentials.

| Source | Verified behavior |
| --- | --- |
| `packages/contracts/src/HookemonHook.sol:185-186,209-215` | Passes the two constructor values directly into `HookemonIssuance`. |
| `packages/contracts/src/launch/HookemonIssuance.sol:84-100` | Rejects zero, then stores immutable expected binding-manifest and runtime-authority digests. It does not calculate either preimage. |
| Same file, lines 163-169 and 193-196 | Plan must equal the immutable expected digests; observation must equal the plan. These checks establish consistency, not external provenance. The file's opening documentation explicitly disclaims provider attestation from caller-supplied observations. |
| `scripts/launch/derive-addresses.mjs:1277-1290` | Validates nonzero bytes32 and normalizes case. No domain, canonical document, or preimage derivation. |
| `packages/contracts/src/bindings/RobinhoodBindings.sol:69-100,209-211` | Historical function computes `keccak256(abi.encode("HOOKEMON_IMMUTABLE_LAUNCH_BINDING_R54_A3", binding))`, after historical revision/provider/asset validation. Binding includes hook address, salt, init-code hash, pool ID and runtime-set digest. It is not called by the hook constructor. |
| `specs/requirements.json`, `REQ-provider-binding-1` and `REQ-provider-binding-3` | Requires attributable, versioned, reproducible binding evidence. Does not specify the two constructor preimages. Revision-71 conversion patch does not add a formula. |
| Pinned CLI `src/api-client.mjs:1557-1567` | The only matching identifier is `exactSourceBinding.bindingDigest`, a SHA-256 hosted-build/finalized-transaction source-verification response. Its schema and authority differ from the custom hook's issuance commitments. No alias or conversion is documented. |

The official CLI source search covered all `src/**/*.mjs` for the four identifiers listed in `sources.json`. This is a bounded negative result, not a claim that all possible provider documentation lacks a formula. The [pinned official release](https://github.com/programmablehq/PROGRAMMABLE/releases/tag/programmable-launch-v4.1.0) is reproducible from the recorded archive URL and digest.

Using the historical binding function would not solve this: it rejects a native/revision-71 binding, and incorporating its final hook address/init-code hash in the hook's own constructor preimage gives the dependency cycle `digest -> initCodeHash -> hookAddress/poolId -> digest`. A hash of the fully materialized hook runtime also depends on its embedded immutable digests. Test constants, a bytecode template hash without a specified normalization rule, and the CLI's unrelated response digest cannot substitute for the missing contract.

## OPEN FACT

Missing: an approved native document schema, hashing algorithm/domain, authority source and acyclic field set for each constructor commitment. Resolution: adopt and test an explicit predeployment commitment contract, or identify an existing authoritative issuance integration that defines both exact preimages. The closest verified path keeps token/custody/address-independent preparation moving and leaves these two fields unset. `proposal.md` supplies an actionable predeployment design for review; it is not active specification or a provider fact.

No provider POST, deployment, signing, broadcast, source change, active release edit, or test digest was performed. No broad test suite was run; this is source and dependency analysis.
