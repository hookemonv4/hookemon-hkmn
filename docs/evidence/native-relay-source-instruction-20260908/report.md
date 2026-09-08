# Relay Solana source-instruction evidence

Checked 2026-09-08, completed at 10:51 UTC, against Hookemon base `43d099f9a8c54d1281cf54b082e81aa3284f491a`. The published source and official oracle IDL establish the decoder below. They do not yet establish that this source produced the currently deployed Solana executable. Keep the active Relay binding null pending that provenance and the separate destination runtime/payment evidence.

| `relay-native-route.v1` source field | Source-derived value |
| --- | --- |
| `programId` | `99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2` |
| `discriminatorHex` | `0b9c60da27a3b413` |
| `dataLengthBytes` | `48` |
| `amountOffsetBytes` | `8` |
| `orderIdOffsetBytes` | `16` |

These offsets follow `deposit_token(ctx, amount: u64, id: [u8; 32])`, not pattern matching against the quote. Relay's [program source at 458a64c](https://github.com/relayprotocol/relay-depository/blob/458a64c310a3504aaf37e112af9a8707c9eb11ad/packages/solana-vm/programs/relay-depository/src/lib.rs#L308) and mainnet `Anchor.toml` declare the same program ID. Its manifest specifies Anchor 0.30.1. That version generates the first eight SHA256 bytes of `global:deposit_token`, followed by serialized arguments in declaration order. Borsh represents the u64 as eight little-endian bytes and the fixed array as exactly 32 bytes. The independently published [official oracle IDL at 55b22de](https://github.com/relayprotocol/relay-protocol-oracle/blob/55b22de6358c212c22eebb48d2df5b793a16e863/src/services/attestation/vm/solana-vm/idls/RelayDepositoryIdl.ts#L67) explicitly agrees on discriminator and argument types. Retained Anchor and Borsh sources document the encoding.

The captured unsigned return has one instruction and decodes to 25,000,000 USDC atoms and deposit ID `0xb5568b3a6212f2e4737ecde017642acd9550ac488e186a2f8c9de8426e005f4e`. This equals `protocol.v2.orderId`; it does **not** equal quote/status request ID `0x17888557223056cdba536ad90ca3e11a885a8eff7627cb0d109ac04352e18e98`. `protocol.v2.paymentDetails` agrees on program, currency and amount. Original instruction accounts/data and ALT `Hm9fUgcn7qwDaiNTFiGh6pNtVATgnaRcmK6Bbx6EMZfP` are retained without modification. This old quote is scenario evidence, not a fresh signable return.

The source transfers the specified token amount into the vault and emits the supplied ID with depositor, mint and net amount. The [oracle implementation](https://github.com/relayprotocol/relay-protocol-oracle/blob/55b22de6358c212c22eebb48d2df5b793a16e863/src/services/attestation/vm/solana-vm/index.ts#L193) decodes `deposit_token` and emits that ID as `depositId`; its separate `onchainId` derives from chain, transaction and instruction index. Account 2 is the credited depositor and account 4 the mint. Here the depositor equals the quoted sender. The deposit handler itself does not validate a destination recipient, quote request ID or order signature. Therefore the complete authenticated order and destination payment relationship must remain separately checked. No signed-order cryptographic verification or successful destination transfer is claimed by this evidence.

## Runtime observation and remaining provenance

Official public RPC `https://api.mainnet-beta.solana.com` returned an executable program account owned by the upgradeable loader at finalized slot 445319600. It references ProgramData `6y7C7Lfh1WRRbKohE2FQmFBD2asw3yMi17kStwEcAWWF`. Its separately fetched finalized observation at slot 445319652 reports 394,621 account bytes, last deployment slot 386211280 and a present upgrade authority. Full account response bytes are retained compressed. SHA256 of all account data is `e9a2015b0f5f16a8270ba91cce4eadae3f57198ed2bcb8ef43d19b9b07821e18`. SHA256 after the loader's documented 45-byte metadata is `93a89aef6dd30e66f4cda6d3dafecddbfe58ecc98e5596dbc832feaf5eed9e91`. This is a raw runtime-region fingerprint including any padding, not a claimed reproducible-build hash.

[OtterSec's read-only status endpoint](https://verify.osec.io/status/99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2), linked by [Solana's official verified-build guide](https://solana.com/docs/programs/verified-builds), returned `is_verified: false`, empty source/build hashes and no verification timestamp. That establishes this service has no successful verification to supply; it does not establish that verification is impossible.

OPEN FACT: the exact deployed executable has not been matched to the pinned Relay source/IDL by a reproducible build. Resolve using a locally isolated, pinned toolchain build of the Relay repository and comparison with the current ProgramData executable, or an existing verifiable build record providing the exact source commit, build arguments and matching executable hash. Do not submit an onchain verification record or remote build job under this read-only task. The closest verified alternative is the source-derived decoder and captured-byte regression, with native runtime admission still closed. An upgradeable program also needs a runtime observation tied to the actual finalized source transaction; a historical source fingerprint alone cannot authorize future executions.

## Reproduction and scope

Run `python3 docs/evidence/native-relay-source-instruction-20260908/verify.py` offline. It checks source hashes, source/IDL layout, captured program/amount/order/account agreement, distinct request ID, and compressed RPC hashes. `derived.json` is evidence only, never a release-binding input by itself. `retained-files.json` covers all retained bytes. `sources.json` records exact fetch URLs and content hashes; request JSON files reproduce the two public RPC reads. Re-fetching later may yield different slots or runtime bytes.

No provider mutation, secret read, signature, broadcast, deployment, release-binding edit or execution claim occurred. Source instruction layout is established; deployed-source equivalence and finalized destination native delivery remain separate requirements.
