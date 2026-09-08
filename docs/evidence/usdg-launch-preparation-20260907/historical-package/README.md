# Hookemon unsigned launch preparation

This package is incomplete and cannot be signed. The latest saved public response is ready with backend source `19e07aa548a6365a51fa2cf4275b8cab8505aa53`; `evidence/provider-capabilities-resume.json` retains a redacted review context. Earlier unavailable responses remain historical evidence. The unchanged request packer selects a native/token pool; the documented inventory V3 model uses different source and economics. Neither is evidence for the frozen HKMN/USDG launch. No reservation, signature, spend, broadcast or deployment was performed.

The source inputs at `9b5161749dbbf50a92c4b17e96e3f2102deb9898` match the inspected `origin/main` at `e5ffd4a4d5297ad8a5d8b8e6abe10b5cf9e9260f` for contract source, Phase 3 release files and owner inputs. The retained bytecode CI evidence is explicitly bound to its own head and job; no existing green test was repeated. `integrity.json` binds this package's files by SHA-256.

## Model and public identity

Hookemon / HKMN has one billion tokens with 18 decimals and a complete canonical-market allocation. The frozen market is a seeded, full-range USDG/HKMN Uniswap v4 pool with spacing 60 and ticks -887220 to 887220. Swaps move the pool price; there is no separate issuance/redemption bonding-curve contract in this release. The pool fee field is zero, while the hook collects 3% on the executed USDG side: 2.5% process, 0.4% treasury and 0.1% Programmable, with carried rounding remainders.

`public-tags.json` contains editorial discovery labels, outside the provider request schema. The candidate metadata preserves owner text and the immutable image digest, with its URL unset. Its present-tense card-operation description is an intended product description, not proof of live operation; `evidence/metadata-review.md` proposes qualified copy. No metadata has been published by this task. The token name/symbol are explicit source constants; the generic provider binding label reflects schema limitations, not uncertainty about those constants.

## Wallet review

`unsigned-transactions.preview.json` is a semantic preview, not executable wallet JSON. It describes the provider graph transaction, exact USDG approval to Permit2, exact Permit2 approval to the derived hook, and the separate liquidity seed. Each has zero intended native call value; gas is additional. Exact calldata, target addresses, salts, constructor/runtime materializations and permit windows require a current documented USDG route and source identity convention.

The graph must initialize token allocation, custody binding and the hook in that order. The permanent position custody is a separate target. Existing source ABI and release declarations are authoritative inputs, not a completed V2 graph. The lower of the derived HKMN and fixed USDG addresses selects currency0. Both historical 240-USDG price candidates remain recorded; neither has been selected.

The 250 USD total funding ceiling is not spend approval. The historical 240 USDG release seed and locally tested 100 USDG seed plus 50 USDG trading capital are distinct. `costs.json` records the measured 9,371,967 EVM gas subtotal from separate local fixtures, unpriced costs and the full-budget inequality. USDG/USD parity is not assumed. The 25.298644 USDG process claim recycles existing capital. No all-in cost bound is proven.

## Remaining inputs

`open-facts.json` names each missing fact, a concrete resolution path and the verified alternative. Exact USDG admission, source-lineage/origin commitments, final capital choice and affirmative claim-count approval are required before final construction. Fresh wallet nonce, gas estimate and short permit windows belong at final preparation. Bot integration, live Collector compatibility and complete-cycle acceptance remain with the original task.

After direct owner authorization, fresh authenticated V4 and MultiRole launch-list GETs both returned HTTP 200 with empty lists. This proves read access, not create/preflight scope or launch admission. The later public capability response is ready; exact HKMN/USDG admission remains unproven. The owner also authorized this package push, draft pull request and progress handoff; signing, spending and launching remain excluded.

Provider sources: [capabilities](https://api.programmable.market/v4/chains/4663/multi-role-custom-launches/capabilities), [guide](https://api.programmable.market/v4/chains/4663/multi-role-custom-launches/guide.md), and [request packer](https://api.programmable.market/v4/chains/4663/multi-role-custom-launches/request-packer.mjs). The latest capability response and guide are redacted review derivatives. `evidence/normalization.json` records their original hashes and source commit; these derivatives must not be used as exact provider wire inputs. The packer SHA-256 is `747c2e15b9f0ae04e6416550535d4ad9382130889cfc5d6b49d081d9b5f6e55c` and matches the descriptor. Public chain readback is pinned to the block in `evidence/chain-observation.json`; proxy shell hashes do not prove implementation or full proxy configuration.

`constructor-bindings.json` enumerates the exact compiled constructor fields, known values, unresolved inputs, initializer selectors and compiler immutable offsets. `finalization.md` records the remaining derivation and wallet-review sequence. No ABI field is inferred from a historical manifest alone.

The image reference points to the unchanged PNG already in the Phase 3 package. Its JSON descriptor deliberately is not a provider image-artifact envelope. Restore and review the original URL and envelope only when constructing a complete request.
