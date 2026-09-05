# Provider pre-call failure

## Detection

A provider mutation fails before the adapter capability is invoked. The durable attempt must record
`NOT_SENT`; provider response, signature, and chain evidence remain absent.

## Safe stop

Do not infer that the provider received the request. Preserve the prepared request digest and the
pre-call error. Do not create a replacement request or contact the provider manually.

## Runner behavior

The stage driver persists `PREPARED -> NOT_SENT` before an injected capability can receive the
request. It may return the same request to `PREPARED` for one lease-fenced retry; no provider,
signature, or broadcast evidence is recorded for that retry path.

## Operator recovery

Correct the local pre-call cause without changing the persisted request. Retry only the same
request through the current wallet lease after the driver returns `NOT_SENT` to `PREPARED`.

## Escalation

Escalate if any provider, signature, or chain evidence exists, because that contradicts the
pre-call classification and requires outcome reconciliation instead of retry.

## Evidence

The durable transition and reopen behavior are covered by the conformance test below.

## Recovery contract

Failure-matrix cells: Provider mutation:pre-call-failure
Owning work package: WP07-0
Expected outcome: terminal=none; attempt=NOT_SENT; next=retry
Test: packages/adapters/test/app/stage-driver.test.mjs — persists NOT_SENT before an injected capability and retries the same request after reopen
Alarm reason/code: OPEN FACT (WP07-0): no dedicated alarm reason/code is emitted for a provider pre-call failure.
Resume command: none supported; retry is allowed only after the durable NOT_SENT transition exists.
