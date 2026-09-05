import { FIXTURE_AUTHORIZATION_VALIDATED_AT, fixtureAuthorizationSlot } from './authorization.mjs';
import { stepAuthorizationNow } from './authorization-provider.mjs';
import { validateBinding } from './bindings.mjs';
import { FIXTURE_PROFILE } from './evidence-profile.mjs';
import { verifyDistributionVerificationReceipt } from '../distribution/manifest.mjs';
import { assertFrozenCycleControl } from '../operator/cycle-plan.mjs';
import { canonicalJson, CycleJournal, digest } from './journal.mjs';
import {
  cloneCycleReducerState,
  createCycleReducerState,
  assertFrozenControlBindings,
  deriveVaultPayoutAuthorization,
  deriveReturnedProceedsKey,
  evidenceForTransition,
  externalMutationIdentity,
  externalReconciliationEvidence,
  readClosedProceedsBasisHandoff,
  reduceCycleEvent,
  signedBytesDigest as computeSignedBytesDigest,
} from './reducer.mjs';
import {
  assertDigest,
  assertPlainObject,
  sameCanonical,
} from './schemas.mjs';

export class CycleRunner {
  #cycleStore;
  #evidenceProfile;
  #frozenControl;
  #journal;
  #state;

  constructor(cycleId, entries = [], options = {}) {
    this.#evidenceProfile = options.evidenceProfile ?? FIXTURE_PROFILE;
    if (!this.#evidenceProfile?.cycleStore || typeof this.#evidenceProfile.cycleStore.accepts !== 'function') throw new Error('evidence profile with a cycle store interface check is required');
    if (!this.#evidenceProfile.cycleStore.accepts(options?.cycleStore)) throw new Error('a cycle store satisfying this evidence profile\'s interface is required');
    this.#cycleStore = options.cycleStore;
    this.#frozenControl = options.frozenControl === undefined ? null : assertFrozenCycleControl(options.frozenControl);
    this.#journal = new CycleJournal(cycleId, entries);
    this.#state = createCycleReducerState(cycleId);

    const stored = this.#cycleStore.readCycle(cycleId);
    if (stored.version !== 0 && canonicalJson(stored.entries) !== canonicalJson(this.#journal.entries)) {
      throw new Error('journal entries do not match durable cycle store');
    }
    const transaction = this.#cycleStore.begin(cycleId, {
      expectedVersion: stored.version,
      expectedJournalHead: stored.journalHead,
    });
    for (const entry of this.#journal.entries) {
      if (stored.version === 0) transaction.stageEvent(entry);
      reduceCycleEvent(this.#state, entry, { cycleTransaction: transaction, evidenceProfile: this.#evidenceProfile });
      if (this.#frozenControl) assertFrozenControlBindings(this.#state, this.#frozenControl);
    }
    if (!this.#frozenControl && this.#state.frozenControl) throw new Error('trusted frozen cycle control is required for recovery');
    if (stored.version === 0 && this.#journal.entries.length !== 0) this.#persist(transaction);
    else {
      transaction.assertStagedRecordsPersisted();
      transaction.close();
    }
  }

  // The cycle store's commit is synchronous by contract for both profiles (see evidence-profile.mjs's
  // cycleStore.accepts and durable-store.mjs's commitSync): CycleRunner's own public API stays fully
  // synchronous for every existing (fixture) caller, and a disk-backed production store commits
  // durably (fsync'd) via its synchronous commitSync path rather than the store's own async commit()
  // (which durable-store.mjs still exposes, unused here, for callers that manage cycles outside a
  // running CycleRunner — archiving, admin listing). If a store's commit ever returned a thenable here,
  // that would silently race CycleRunner's return against unfinished disk I/O — so this fails loudly
  // instead of ever awaiting nothing.
  #persist(transaction) {
    const result = typeof this.#cycleStore.commitSync === 'function'
      ? this.#cycleStore.commitSync(transaction)
      : this.#cycleStore.commit(transaction);
    if (result && typeof result.then === 'function') throw new Error('cycle store commit must be synchronous; use commitSync for a disk-backed store');
  }

  static recover(cycleId, entries, options) {
    return new CycleRunner(cycleId, entries, options);
  }

  get entries() { return this.#journal.entries; }
  get cycleStoreSnapshot() { return this.#cycleStore.snapshot; }
  get state() { return { stage: this.#state.stage, version: this.#state.version, journalHead: this.#state.head }; }

  bindFrozenControl() {
    if (!this.#frozenControl) throw new Error('trusted frozen cycle control is required before binding');
    if (this.#journal.entries.length !== 0 || this.#state.frozenControl) throw new Error('frozen cycle control must be the first journal event');
    this.#commit('cycle-control-bound', { control: this.#frozenControl });
    return this.#frozenControl.controlDigest;
  }

  inspect() {
    const unresolved = [...this.#state.externalMutations.entries()]
      .filter(([, attempt]) => attempt.status === 'unresolved')
      .map(([requestDigest]) => requestDigest);
    return Object.freeze({
      cycleId: this.#journal.cycleId,
      stage: this.#state.stage,
      version: this.#state.version,
      journalHead: this.#state.head,
      controlDigest: this.#state.frozenControl?.controlDigest ?? null,
      planDigest: this.#state.frozenControl?.plan.planDigest ?? null,
      packSnapshotDigest: this.#state.frozenControl?.packSnapshot.snapshotDigest ?? null,
      payoutFundingPrepared: this.#state.payoutFundingPreparation !== null,
      unresolvedRequestDigest: unresolved.length === 1 ? unresolved[0] : null,
    });
  }

  prepareCollectorGenerateIntent(request) {
    const verified = this.#evidenceProfile.collector.assertRequest(request, 'generate');
    if (!this.#state.preflight || this.#state.stage !== 'prepared') throw new Error('prepared released-cycle preflight is required for Collector generation');
    const requestDigest = this.#evidenceProfile.collector.requestDigest(verified, 'generate');
    this.#commit('collector-generate-intent-prepared', { request: verified, requestDigest });
    return { ...verified, requestDigest };
  }

  prepareCollectorOpenIntent(request) {
    const verified = this.#evidenceProfile.collector.assertRequest(request, 'open');
    if (this.#state.stage !== 'purchase-finalized' || !this.#state.collector.verifiedStatus) throw new Error('verified ready Collector status is required before the open intent');
    const requestDigest = this.#evidenceProfile.collector.requestDigest(verified, 'open');
    this.#commit('collector-open-intent-prepared', { request: verified, requestDigest });
    return { ...verified, requestDigest };
  }

  // Journals the raw `authorization` input the caller supplied, never the evidence profile's verified/
  // normalized result: reduceCycleEvent's replay path re-verifies whatever is journaled through the
  // exact same evidenceProfile.collector.verifyMutationAuthorization call this method itself uses, so
  // the journaled value must be re-feedable into that same function unchanged (this is a no-op
  // distinction for the fixture profile, whose verified output already equals a validated clone of its
  // input — see collector.mjs assertFixtureCollectorMutationAuthorization).
  consumeCollectorMutationAuthorization({ request, binding, authorization }) {
    const action = authorization?.action ?? authorization?.actionKind;
    const verified = this.#evidenceProfile.collector.verifyMutationAuthorization(authorization, request, action, binding);
    this.#commit('collector-mutation-authorization-consumed', { request: this.#evidenceProfile.collector.assertRequest(request, action), binding: validateBinding(binding), authorization });
    return this.#evidenceProfile.collector.mutationAuthorizationDigest(verified);
  }

  recordVerifiedCollectorStatus(status) {
    const verified = this.#evidenceProfile.collector.assertVerifiedStatus(status);
    this.#commit('collector-status-verified', { status: verified });
    return structuredClone(verified);
  }

  recordFinalizedCollectorOpenCustody({ custody, rpcFinality }) {
    const verifiedCustody = this.#evidenceProfile.collector.assertVerifiedOpenCustody(custody);
    const verifiedFinality = this.#evidenceProfile.collector.assertVerifiedRpcFinality(rpcFinality, verifiedCustody);
    this.#commit('collector-open-custody-verified', { custody: verifiedCustody, rpcFinality: verifiedFinality });
    return { custody: structuredClone(verifiedCustody), rpcFinality: structuredClone(verifiedFinality) };
  }

  // `response` is the real Collector Crypt API response for the fixture-free (production) evidence
  // profile — this method never synthesizes a plausible-looking response for production, only for the
  // fixture profile's own simulated provider (omitting `response` there reproduces the exact literal
  // every existing fixture test already exercises).
  generateCollectorPack({ binding, response } = {}) {
    const exactBinding = validateBinding(binding);
    if (!this.#state.preflight || this.#state.stage !== 'prepared') throw new Error('prepared released-cycle preflight is required for Collector generation');
    let finalResponse = response;
    if (finalResponse === undefined) {
      if (this.#evidenceProfile.name !== 'fixture') throw new Error('a real Collector generate response is required for the production evidence profile');
      finalResponse = { schema: 'hookemon.fixture-collector-generate.v1', responseId: `fixture-collector-generate-${this.#journal.cycleId}`, cycleId: this.#journal.cycleId, pack: exactBinding.pack, quantity: 1, turbo: false, wallet: exactBinding.executionWallet, prizeWallet: 'fixture-destination-purchase' };
    }
    const verifiedResponse = assertPlainObject(finalResponse, ['schema', 'responseId', 'cycleId', 'pack', 'quantity', 'turbo', 'wallet', 'prizeWallet'], 'Collector generate response');
    if (!this.#evidenceProfile.collector.acceptsGenerateResponse(verifiedResponse, this.#journal.cycleId)) throw new Error('Collector generate response schema is not accepted by this evidence profile');
    this.#commit('collector-generate-consumed', { binding: exactBinding, preflightDigest: this.#state.preflight.preflightDigest, response: verifiedResponse });
    return structuredClone(verifiedResponse);
  }

  recordCollectorStatus() {
    throw new Error('independently signed complete Collector status is required; use recordVerifiedCollectorStatus');
  }

  openCollectorPack(input) {
    assertPlainObject(input, ['open', 'execution'], 'Collector open input');
    const open = this.#evidenceProfile.collector.assertRequest(input.open, 'open');
    const execution = this.#evidenceProfile.collector.assertVerifiedOpenExecution(input.execution);
    if (this.#state.collector.opened) {
      if (!sameCanonical(this.#state.collector.opened, open) || !sameCanonical(this.#state.collector.openExecution, execution)) throw new Error('Collector open binding is invalid');
      return { open: structuredClone(this.#state.collector.opened), execution: structuredClone(this.#state.collector.openExecution) };
    }
    this.#commit('collector-opened', { open, execution });
    return { open: structuredClone(open), execution: structuredClone(execution) };
  }

  // Journals the raw `approval` input, not the evidence profile's verified result — see the identical
  // note on consumeCollectorMutationAuthorization above; the same replay-idempotency requirement applies.
  recordPostOpenBuybackAuthorization(approval) {
    const verified = this.#evidenceProfile.postOpenBuyback.verify(approval);
    this.#commit('post-open-buyback-approval-consumed', { approval });
    return verified.fixtureApprovalDigest ?? verified.intentDigest;
  }

  #commit(kind, payload) {
    if (this.#frozenControl && kind !== 'cycle-control-bound' && !this.#state.frozenControl) throw new Error('frozen cycle control must be journaled before any cycle intent');
    const event = this.#journal.propose(kind, payload);
    const candidateState = cloneCycleReducerState(this.#state);
    const transaction = this.#cycleStore.begin(this.#journal.cycleId, {
      expectedVersion: this.#journal.entries.length,
      expectedJournalHead: this.#journal.head,
    });
    transaction.stageEvent(event);
    reduceCycleEvent(candidateState, event, { cycleTransaction: transaction, evidenceProfile: this.#evidenceProfile });
    if (this.#frozenControl) assertFrozenControlBindings(candidateState, this.#frozenControl);
    const candidateJournal = new CycleJournal(this.#journal.cycleId, [...this.#journal.entries, event]);
    this.#persist(transaction);
    this.#journal = candidateJournal;
    this.#state = candidateState;
    return event;
  }

  recordReleasedCyclePreflight(preflightValue) {
    const preflight = this.#evidenceProfile.preflight.verify(preflightValue);
    this.#commit('cycle-preflight-recorded', { preflight, preflightDigest: preflight.preflightDigest });
    return preflight.preflightDigest;
  }

  prepareExternalIntent(actionValue) {
    const action = this.#evidenceProfile.action.assert(actionValue);
    const digests = this.#evidenceProfile.action.digests(action);
    const entry = this.#commit('intent-prepared', { action, ...digests });
    return {
      cycleId: action.cycleId,
      actionKind: action.actionKind,
      requestDigest: digests.actionDigest,
      ...digests,
      journalHead: entry.digest,
    };
  }

  // Journals the raw `approvalValue` input, not the AuthorizationProvider's verified result — see the
  // identical note on consumeCollectorMutationAuthorization above; the same replay-idempotency
  // requirement applies (reduceCycleEvent's verifyApproval re-verifies whatever is journaled through
  // this exact same provider.verifyStepAuthorization call).
  recordOwnerAuthorization(approvalValue) {
    // A standing authority is accepted only while it is active at first use. A durable historical
    // first-use decision and daily-cap reservation need an approved journal schema before expired
    // authorizations can be replayed without rechecking the current authority.
    const approval = this.#evidenceProfile.authorization.provider.verifyStepAuthorization(approvalValue, stepAuthorizationNow(approvalValue));
    this.#commit('owner-approval-recorded', { approval: approvalValue });
    return this.#evidenceProfile.authorization.approvalKey(approval);
  }

  consumeAuthorizationOnce(expectedValue) {
    const expected = this.#evidenceProfile.authorization.provider.verifyStepAuthorization(expectedValue, stepAuthorizationNow(expectedValue));
    const actionDigest = this.#evidenceProfile.authorization.resolveActionDigest(this.#state, expected);
    if (!actionDigest) throw new Error('owner approval does not resolve to a prepared action');
    const recorded = this.#state.approvals.get(fixtureAuthorizationSlot(actionDigest, expected.authorizationKind));
    if (!recorded || !sameCanonical(recorded, expected)) throw new Error('recorded owner approval does not exactly match consumption');
    const approvalKey = this.#evidenceProfile.authorization.approvalKey(expected);
    this.#commit('owner-approval-consumed', {
      actionDigest,
      authorizationKind: expected.authorizationKind,
      subjectDigest: expected.subjectDigest,
      approvalKey,
      validatedAt: FIXTURE_AUTHORIZATION_VALIDATED_AT,
    });
    return approvalKey;
  }

  recordFixtureDecodedTransaction(input) {
    assertPlainObject(input, ['requestDigest', 'messageBytes'], 'fixture decode input');
    assertDigest(input.requestDigest, 'fixture decode request digest');
    const decoded = this.#evidenceProfile.message.decode(input.messageBytes);
    if (decoded.actionDigest !== input.requestDigest) throw new Error('decoded message request binding mismatch');
    const messageDigest = digest({ domain: this.#evidenceProfile.message.digestDomain, message: decoded });
    this.#commit('fixture-message-decoded', { actionDigest: input.requestDigest, messageBytes: input.messageBytes, messageDigest });
    return messageDigest;
  }

  recordSignedBytes(input) {
    const allowed = ['messageDigest', 'signedBytes'];
    const allowedWithDigest = [...allowed, 'signedBytesDigest'];
    assertPlainObject(input, Object.hasOwn(input, 'signedBytesDigest') ? allowedWithDigest : allowed, 'signed bytes input');
    const decoded = [...this.#state.decoded.entries()].find(([, value]) => value.messageDigest === input.messageDigest);
    if (!decoded) throw new Error('raw decoded transaction evidence is required before signed bytes');
    const calculated = computeSignedBytesDigest(input, this.#evidenceProfile.signedTransaction.digestDomain);
    const signedBytesDigest = input.signedBytesDigest ?? calculated;
    const verified = this.#evidenceProfile.signedTransaction.verify(input.signedBytes, decoded[1]);
    this.#commit('signed-bytes-recorded', {
      actionDigest: decoded[0],
      messageDigest: input.messageDigest,
      signedBytes: input.signedBytes,
      signedBytesDigest,
      broadcastSignature: verified.broadcastSignature,
    });
    return signedBytesDigest;
  }

  recordFixtureBlockhashValidity(evidenceValue) {
    const evidence = this.#evidenceProfile.blockhashValidity.verify(evidenceValue);
    this.#commit('blockhash-validity-verified', { evidence });
    return evidence.verificationDigest ?? evidence.observerConfirmationDigest;
  }

  broadcastPreparedTransactionOnce(input) {
    assertPlainObject(input, ['messageDigest', 'signedBytesDigest', 'broadcastSignature'], 'broadcast input');
    const signed = [...this.#state.signed.entries()].find(([, value]) => value.messageDigest === input.messageDigest);
    if (!signed) throw new Error('raw decoded and signed bytes evidence are required before broadcast');
    this.#commit('broadcast-recorded', { actionDigest: signed[0], ...input });
    return input.broadcastSignature;
  }

  appendCanonicalReceipt(receiptValue) {
    const receipt = this.#evidenceProfile.providerReceipt.verify(receiptValue);
    const receiptDigest = digest({ domain: this.#evidenceProfile.providerReceipt.digestDomain, receipt });
    this.#commit('provider-receipt-verified', { receipt, receiptDigest, registryKey: this.#evidenceProfile.providerReceipt.identityKey(receipt) });
    return receiptDigest;
  }

  recordExecutionAccountingEvidence(evidenceValue) {
    const evidence = this.#evidenceProfile.executionAccounting.verify(evidenceValue);
    this.#commit('execution-accounting-verified', { evidence });
    return evidence.verificationDigest;
  }

  consumeReceiptOnce(receiptDigest) {
    assertDigest(receiptDigest, 'receipt digest');
    const receipt = this.#state.receipts.get(receiptDigest);
    if (!receipt) throw new Error('verified provider receipt is unknown');
    const registryKey = this.#evidenceProfile.providerReceipt.identityKey(receipt);
    this.#commit('receipt-consumed', { receiptDigest, registryKey });
    return registryKey;
  }

  advanceCycleState(input) {
    assertPlainObject(input, ['expectedVersion', 'expectedJournalHead', 'next'], 'cycle transition input');
    const evidence = evidenceForTransition(this.#state, input.next, this.#evidenceProfile);
    this.#commit('cycle-transitioned', {
      expectedVersion: input.expectedVersion,
      expectedJournalHead: input.expectedJournalHead,
      from: this.#state.stage,
      next: input.next,
      evidence,
    });
    return this.state;
  }

  deriveOpenReconciliation() {
    if (this.#state.stage !== 'purchase-finalized') throw new Error('open reconciliation receipt prefix is missing');
    if (this.#state.collector.generated && !this.#state.collector.opened) throw new Error('Collector open response is required');
    return this.advanceCycleState({ expectedVersion: this.#state.version, expectedJournalHead: this.#state.head, next: 'open-reconciled' });
  }

  deriveClosedCycle() {
    if (this.#state.stage !== 'return-finalized') throw new Error('closed-cycle receipt prefix is missing');
    return this.advanceCycleState({ expectedVersion: this.#state.version, expectedJournalHead: this.#state.head, next: 'closed' });
  }

  close() {
    return this.deriveClosedCycle();
  }

  consumeReturnedProceedsOnce(input) {
    assertPlainObject(input, ['receiptDigest'], 'returned proceeds input');
    assertDigest(input.receiptDigest, 'returned proceeds receipt digest');
    const proceedsKey = deriveReturnedProceedsKey(this.#state, input.receiptDigest);
    this.#commit('proceeds-consumed', { receiptDigest: input.receiptDigest, proceedsKey });
    return proceedsKey;
  }

  readClosedProceedsBasisHandoff(input) {
    assertPlainObject(input, ['proceedsKey'], 'closed proceeds basis handoff input');
    assertDigest(input.proceedsKey, 'closed proceeds basis key');
    return readClosedProceedsBasisHandoff(this.#state, input.proceedsKey);
  }

  recordDistributionVerification(receiptValue) {
    const receipt = verifyDistributionVerificationReceipt(receiptValue);
    this.#commit('distribution-verification-recorded', { receipt });
    return receipt.receiptDigest;
  }

  preparePayoutFunding(input) {
    assertPlainObject(
      input,
      ['proceedsKey', 'verificationReceiptDigest', 'expiresAt', 'nonce'],
      'payout funding input',
    );
    assertDigest(input.proceedsKey, 'payout funding proceeds key');
    assertDigest(input.verificationReceiptDigest, 'payout funding verification receipt digest');
    const receipt = this.#state.distributionVerification;
    if (
      !receipt
      || receipt.proceedsKey !== input.proceedsKey
      || receipt.receiptDigest !== input.verificationReceiptDigest
    ) throw new Error('recorded distribution verification is required before payout funding preparation');
    const replayKey = digest({
      domain: 'hookemon.cycle-runner.payout-funding-once.v1',
      runnerCycleId: this.#journal.cycleId,
      proceedsKey: input.proceedsKey,
      verificationReceiptDigest: input.verificationReceiptDigest,
    });
    const vaultPayoutAuthorization = deriveVaultPayoutAuthorization(this.#state, receipt, {
      expiresAt: input.expiresAt,
      nonce: input.nonce,
    });
    const payload = {
      proceedsKey: input.proceedsKey,
      verificationReceiptDigest: input.verificationReceiptDigest,
      onchainCycleId: receipt.onchainCycleId,
      payoutId: receipt.payoutId,
      manifestDigest: receipt.manifestDigest,
      rootHash: receipt.rootHash,
      rootSum: receipt.rootSum,
      vaultPayoutAuthorization: vaultPayoutAuthorization.authorization,
      vaultPayoutAuthorizationDigest: vaultPayoutAuthorization.authorizationDigest,
      replayKey,
      intent: digest({
        domain: 'hookemon.cycle-runner.payout-funding.v4',
        replayKey,
        onchainCycleId: receipt.onchainCycleId,
        payoutId: receipt.payoutId,
        manifestDigest: receipt.manifestDigest,
        rootHash: receipt.rootHash,
        rootSum: receipt.rootSum,
        vaultPayoutAuthorizationDigest: vaultPayoutAuthorization.authorizationDigest,
        journalHead: this.#journal.head,
      }),
    };
    this.#commit('payout-funding-prepared', payload);
    return {
      authority: 'LOCAL_PREPARATION_ONLY_NOT_LIVE_FUNDING_AUTHORITY',
      ...payload,
    };
  }

  reconcileUnresolvedIntent(requestDigest) {
    assertDigest(requestDigest, 'intent digest');
    const attempt = this.#state.externalMutations.get(requestDigest);
    if (!attempt) throw new Error('durable external mutation attempt is required before reconciliation');
    if (attempt.status === 'externally-reconciled') return { status: attempt.status, journalHead: this.#journal.head };
    const evidence = externalReconciliationEvidence(this.#state, requestDigest);
    if (!evidence) return { status: 'unresolved', journalHead: this.#journal.head };
    this.#commit('external-mutation-reconciled', { requestDigest, actionKind: attempt.actionKind, evidence });
    return { status: 'externally-reconciled', journalHead: this.#journal.head };
  }

  // The heavier, manual "kick a stuck cycle" recovery path (design section 2.5's recovery table, owner
  // standing-authority key, deliberately not a dashboard button — see design section 5). Unlike
  // reconcileUnresolvedIntent (external confirmation the mutation landed) or the lighter, automatable
  // void path (proof it was never broadcast at all), this path exists for the case both of those
  // explicitly cannot resolve: a mutation this reducer itself recorded as broadcast, but which neither
  // independent observer (the provider API and the chain's own RPC, each under its own key) can ever
  // find landed, even after its own last-valid boundary passed. It requires two independently signed
  // "not found" observer attestations plus a fresh, single-use, expiry-checked owner-signed
  // authorization before the stale intent/action is retired, freeing the same action kind for a brand
  // new intent (its own fresh digest) to be prepared afterward through the ordinary
  // prepareExternalIntent path. See packages/runner/src/cycle/reducer.mjs's
  // 'external-mutation-superseded' handling for the exact verification.
  supersedeUnobservedIntent(input) {
    assertPlainObject(input, ['requestDigest', 'proof', 'authorization'], 'unobserved mutation supersession input');
    assertDigest(input.requestDigest, 'superseded mutation request digest');
    this.#commit('external-mutation-superseded', input);
    return { status: 'SUPERSEDED', requestDigest: input.requestDigest, journalHead: this.#journal.head };
  }

  executeAuthorizedExternalMutationOnce(requestDigest) {
    assertDigest(requestDigest, 'intent digest');
    const identity = externalMutationIdentity(this.#state, requestDigest, this.#evidenceProfile);
    const existing = this.#state.externalMutations.get(requestDigest);
    if (existing?.status === 'unresolved') throw new Error('external mutation is unresolved; provider and RPC reconciliation is required before any retry');
    if (existing) throw new Error('external mutation is already externally reconciled; retry is prohibited');
    this.#commit('external-mutation-attempted', { requestDigest, ...identity });
    return { status: 'unresolved', requestDigest, journalHead: this.#journal.head };
  }

  // Verifies a production provider receipt (Collector Crypt purchase/buyback, Relay-observed
  // outbound/return) through this runner's own production evidence profile — the injected chain
  // observer independently confirms the transaction before the receipt is accepted; no signature is
  // ever trusted on its own. Throws if this runner was constructed with the fixture profile: a fixture
  // cycle has no production observers/programIds to verify against.
  verifyProductionProviderReceipt(receiptValue) {
    if (this.#evidenceProfile.name !== 'production') throw new Error('verifyProductionProviderReceipt requires a CycleRunner constructed with the production evidence profile');
    return this.#evidenceProfile.providerReceipt.verify(receiptValue);
  }
}
