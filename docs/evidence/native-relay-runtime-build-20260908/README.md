# Relay source/runtime local build candidate

The pinned local build succeeded in 113.498 seconds. Its ELF matches the previously recorded finalized Relay runtime under the inspected solana-verify hash algorithm: `01fd4b74bfecbbced90084938e458e4cf0373afeb4741402e0ca145ccec256d1`. This establishes the candidate source/build equivalence for the recorded ProgramData observation at slot445319652. It does not authorize transactions or establish equivalence after an upgrade. The compressed candidate ELF, full compiler output and exact command are retained here.

The investigated Relay source is commit `458a64c310a3504aaf37e112af9a8707c9eb11ad`, preserved below provider evidence commit `e4ab739cca27ec818fa143ff00ea1928a4ed3904`. Its source declares the observed mainnet program ID. Cargo.lock format 3 resolves anchor-lang/anchor-spl 0.30.1 and solana-program 1.18.26. The manifest's `solana-program = "1.16"` is a range, not the resolved compiler version. The Relay README recommends latest stable Rust/Solana and `anchor build`; it does not record the actual deployment compiler, flags or build image. No rust-toolchain file or Solana build workflow was found in that source tree. Therefore the command below is a pinned candidate build, not a recovered deployment recipe.

The inspected solana-verify source at `17e839a8d5911cea3cac1bb5a810bcb2f6a13293` selects a container from the resolved Solana version. For 1.18.26 it selects `solanafoundation/solana-verifiable-build@sha256:ec2e20e1f80607150a71e4c72adfe64be24347ed0b4fb741c32b34eaf7549a25`. The retained Dockerfile pins an amd64 Rust base and the Solana installer checksum. The running container reports Rust1.75.0, Solana CLI/cargo-build-sbf1.18.26 and platform-tools v1.41; these are measured rather than inferred from the SDK crate version. The verifier itself documents that post-install toolchain/platform-tools verification remains follow-up work.

On this Darwin arm64 machine, PATH discovery found Docker client 29.5.2 (API1.54), but no rustc, cargo, rustup, solana, cargo-build-sbf, anchor, podman or solana-verify. The client uses desktop-linux. `build-attempt.json` records the actual first container command and failure. The coordinator then explicitly authorized starting the installed local Docker Desktop engine. A normal start logged a sandbox permission error; an approved escalated start succeeded. The public image pull uses an empty workspace-local Docker configuration and the existing local socket. No installer, wallet or registry credential was accessed. The Docker-managed image cache is outside the source mount under this extended local-engine authorization.

The earlier finalized ProgramData observation at slot445319652 remains the comparison target. The runtime region has 394576 bytes including 7567 trailing zero bytes. Applying the inspected verifier's exact trailing-zero removal gives SHA256 `01fd4b74bfecbbced90084938e458e4cf0373afeb4741402e0ca145ccec256d1`. This differs intentionally from the earlier padded runtime-region SHA256. `verify.py` reproduces the calculation offline from the retained RPC response and optionally compares a candidate ELF. It does not treat an absent candidate as a match. The candidate was compared successfully; `runtime-comparison.json` also records its raw file hash and length, and `candidate.so.gz` retains its exact bytes.

## Reproduction

The following local build steps require an already available Docker engine capable of linux/amd64. Run from this worktree; all host source and output files stay in `.session/relay-runtime`. The source archive was already fetched and extracted there in this investigation. Do not edit program IDs or Cargo.lock to make a candidate match.

```bash
mkdir -p .session/relay-runtime
curl -fLsS https://codeload.github.com/relayprotocol/relay-depository/tar.gz/458a64c310a3504aaf37e112af9a8707c9eb11ad -o .session/relay-runtime/source.tar.gz
tar -xzf .session/relay-runtime/source.tar.gz -C .session/relay-runtime
python3 docs/evidence/native-relay-runtime-build-20260908/build-candidate.py
relay_source="$PWD/.session/relay-runtime/relay-depository-458a64c310a3504aaf37e112af9a8707c9eb11ad/packages/solana-vm"
python3 docs/evidence/native-relay-runtime-build-20260908/verify.py "$relay_source/target/deploy/relay_depository.so"
```

The command implements the inspected verifier's container build path, library manifest location, sparse registry and locked dependency rules. It neither deploys nor calls verify-from-repo, uploads a verification PDA, submits a remote job or signs anything. A container build may download pinned dependencies into the disposable container; the Docker engine manages its image cache outside the source mount, so the coordinator explicitly authorized the installed local engine and this cache for the candidate build.

The observed source/runtime equivalence is now established for this pinned build and the captured runtime. The earlier OtterSec `is_verified:false` describes that service's missing attestation; it is not a contradictory local hash result. OPEN FACT: equivalence at a future source transaction's finality remains unknown because this program is upgradeable. Re-read finalized program/ProgramData at the relevant slot, recompute the normalized hash, and compare it to this authenticated build before treating source layout as execution authority. The closest verified evidence is the matching historical ELF and recorded finalized runtime, which remain usable for offline review without inventing a future upgrade state.

## Sources and retained evidence

- [Relay pinned repository](https://github.com/relayprotocol/relay-depository/tree/458a64c310a3504aaf37e112af9a8707c9eb11ad/packages/solana-vm): retained README, workspace manifest and full lockfile.
- [Solana verified-builds tool pinned source](https://github.com/Ellipsis-Labs/solana-verifiable-build/tree/17e839a8d5911cea3cac1bb5a810bcb2f6a13293): retained README, main.rs, image map and 1.18.26 Dockerfile. main.rs768-825 defines runtime hashing; build selection starts951.
- Previous source/runtime observation: `../native-relay-source-instruction-20260908/`, including its source references, raw finalized RPC response and upgradeable-loader metadata derivation.

Validation: one locked candidate build succeeded; Cargo.lock SHA256 remained `404c84d345721e8bda32f65893004ba9ef8110a122eff0fb730355851cc464ca`. The offline comparator reproduced the recorded account, padded region and normalized runtime hashes, then returned `match:true` for the actual generated ELF. No full Hookemon suite was run for this evidence-only task.
