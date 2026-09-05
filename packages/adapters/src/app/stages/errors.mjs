// Shared error type every refusing stage module throws — a single definition so
// `stage-driver.mjs`/tests can `instanceof`-check it regardless of which stage module raised it.
export class LiveModeIntegrationPendingError extends Error {
  constructor(stage, reason) {
    super(`stage "${stage}" live-mode mutation is INTEGRATION_PENDING: ${reason}`);
    this.name = 'LiveModeIntegrationPendingError';
    this.stage = stage;
  }
}

/** Thrown by a `reconcileLive*` function when a durably-recorded broadcast is confirmed —
 * finalized (Robinhood Chain) or found by `getSignatureStatuses` (Solana) — to have *failed*
 * on-chain (a `reverted` transaction receipt, or a non-null `err` in a signature status), never
 * silently reported as null (which an operator could mistake for merely "still pending") or as
 * non-null completion evidence (which would make `AutomatedCycleService` mark the stage COMPLETE
 * over a failed mutation). Throwing here halts the automated loop's current pass with a named,
 * `instanceof`-checkable failure instead of either extreme — the cycle's FAILED/DEGRADED recovery
 * path (`authorizeFundingAfterFailure`, `recordDegradedReturn`) is a separate, human-in-the-loop
 * concern this stage-driver seam does not resolve on its own.
 */
export class StageMutationRevertedError extends Error {
  constructor(stage, reason, details = {}) {
    super(`stage "${stage}" live-mode mutation failed on-chain: ${reason}`);
    this.name = 'StageMutationRevertedError';
    this.stage = stage;
    Object.assign(this, details);
  }
}

/** Thrown by `open.mjs`'s live `mutateOpen` (WP-36) when the open transaction's own post-token-
 * balance state (`solana-rpc.mjs`'s `getTransactionTokenBalanceChanges`) does not narrow to
 * exactly one candidate mint credited to the operator wallet — zero candidates (the transaction
 * did not actually mint anything into the operator's own wallet, or hasn't landed as expected) or
 * more than one (an ambiguous transaction this package refuses to guess a single mint from,
 * per product/SOURCE_BOUNDARY.md's evidence rule: "never guess"). `candidateMints` is the exact
 * list found, empty or with 2+ entries, for a human/operator to inspect directly rather than this
 * package silently picking one. */
export class AmbiguousCardMintError extends Error {
  constructor(stage, signature, candidateMints, details = {}) {
    super(
      `stage "${stage}": the open transaction ${signature} does not narrow to exactly one candidate `
      + `card mint credited to the operator wallet (found ${candidateMints.length}: `
      + `${JSON.stringify(candidateMints)}) — refusing to guess`,
    );
    this.name = 'AmbiguousCardMintError';
    this.stage = stage;
    this.signature = signature;
    this.candidateMints = candidateMints;
    Object.assign(this, details);
  }
}

export class RehearsalProceedsUnobservableError extends Error {
  constructor(reason, details = {}) {
    super(`collector-only rehearsal proceeds are unobservable: ${reason}`);
    this.name = 'RehearsalProceedsUnobservableError';
    Object.assign(this, details);
  }
}

export class RehearsalRecipientAccountMissingError extends Error {
  constructor(recipients) {
    super(`collector-only rehearsal recipient token accounts are missing: ${recipients.join(', ')}`);
    this.name = 'RehearsalRecipientAccountMissingError';
    this.recipients = [...recipients];
  }
}
