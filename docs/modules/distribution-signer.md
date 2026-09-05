# Distribution Signer

## Purpose

The distribution-signer module retains the EIP-712 approval and verification interfaces for the
Vault/Merkle distribution workflow. That workflow is not an approved Phase 3 Operations money
path. The callable signing functions therefore fail closed while the active interface authority is
provisional, rather than allowing retained source to create a signature.

## Public interface

- `signProductionDistributionApproval(fields, signerClient)` validates a
  `distribution-signer` client, computes the payout digest, revalidates the retained-custody
  authority, and only then calls the injected signer.
- `signProductionDistributionVerification(fields, signerClient)` follows the same sequence for a
  `verifier` client. The retained fixture distribution signer uses the same boundary. Both CLI
  paths record a refusal without writing a verification receipt.
- `assertPairedProductionPayoutSignatures(...)` verifies public signatures and configured
  addresses; it does not sign or mutate an external system.

## Invariants

- A provisional Phase 3 authority cannot produce an approval or verification signature through
  this module. The authority check is immediately before the injected signer call.
- An exact retained fixture authority is accepted only when the Node test-runner context marker is
  present. It is not a deployment authority or a general live caller override.
- Role validation occurs before the authority check. A caller with the wrong signer role receives
  a local role error and cannot reach a signing client.
- The module holds no credential, creates no fallback identity, and cannot establish a recipient
  entitlement on its own.

## State transitions

- `PROVISIONAL_PHASE3_PENDING_FEASIBILITY` leads to a refusal before the signer client is called.
- A future generic frozen authority still does not permit the historical signing interface. A new
  approved architecture must introduce a distinct retained-custody runtime path.
- Signature-pair verification remains read-only in either state.

## Operational commands

```sh
cd packages/adapters
node --test test/signing/payout-distribution.test.mjs test/signing/hookemon-verifier-production.test.mjs
```

## Recovery pointers

- Do not use this module to recover a missing Operations signature while the authority is
  provisional.
- Preserve the verifier's `failed/` record and reconcile the current CycleRepository journal.
- A future signing role needs an approved runtime path, not only a frozen interface authority; do
  not bypass the authority check.
