import { digest } from './journal.mjs';
import { createPreparedProviderMutationAttempt } from './money-schemas.mjs';

const decimalPattern = /^(0|[1-9][0-9]*)$/;
const evmAddressPattern = /^0x[0-9a-fA-F]{40}$/;
const solanaAddressPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const rehearsalProfiles = new Set(['collector-only', 'relay-roundtrip']);
const relayStages = new Set(['outbound', 'return']);

export class RehearsalRestartInjectedError extends Error {
  constructor() {
    super('rehearsal restart injected after a fake irreversible effect');
    this.name = 'RehearsalRestartInjectedError';
  }
}

function assertConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('rehearsal stage driver config is invalid');
  if (!Number.isSafeInteger(config.chainId) || config.chainId <= 0) throw new Error('rehearsal stage driver chainId is invalid');
  if (!evmAddressPattern.test(config.contracts?.usdg ?? '')) throw new Error('rehearsal stage driver USDG asset is invalid');
  if (!Number.isInteger(config.contracts?.usdgDecimals) || config.contracts.usdgDecimals < 0 || config.contracts.usdgDecimals > 255) {
    throw new Error('rehearsal stage driver USDG decimals are invalid');
  }
  if (!solanaAddressPattern.test(config.relay?.solanaMint ?? '')) throw new Error('rehearsal stage driver Solana settlement asset is invalid');
  if (!solanaAddressPattern.test(config.rehearsal?.proceedsAccount ?? '')) {
    throw new Error('rehearsal stage driver dedicated proceeds account is invalid');
  }
  if (!rehearsalProfiles.has(config.rehearsal?.mode)) {
    throw new Error('rehearsal stage driver profile is invalid');
  }
  if (config.rehearsal.mode === 'relay-roundtrip'
    && (typeof config.execution?.rehearsalCapUsdg !== 'string'
      || !decimalPattern.test(config.execution.rehearsalCapUsdg)
      || config.execution.rehearsalCapUsdg === '0')) {
    throw new Error('relay-roundtrip rehearsal requires a positive explicit rehearsal cap');
  }
  return config;
}

function assertRepository(repository) {
  for (const method of [
    'readOperationalStageAttempt',
    'prepareStageAttempt',
    'markStageAttemptSentUnknown',
    'recordStageAttemptResponse',
    'reconcileStageAttempt',
  ]) {
    if (typeof repository?.[method] !== 'function') throw new Error(`rehearsal stage driver cycleRepository.${method} is required`);
  }
  return repository;
}

function fakeProviderForStage(providers, stage) {
  if (providers === null || providers === undefined) return null;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) {
    throw new Error('rehearsal fake providers are invalid');
  }
  const providerName = ['outbound', 'return'].includes(stage)
    ? 'relay'
    : ['purchase', 'open', 'epic-gate', 'buyback'].includes(stage)
      ? 'collector'
      : null;
  if (providerName === null) return null;
  const provider = providers[providerName];
  if (!provider || provider.kind !== 'hookemon.rehearsal-fake-provider.v1'
    || typeof provider.executeRehearsalEffect !== 'function') {
    throw new Error(`rehearsal fake ${providerName} provider is required`);
  }
  return Object.freeze({ name: providerName, provider });
}

function skipsRelayEffect(profile, stage) {
  return profile === 'collector-only' && relayStages.has(stage);
}

function assertContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) throw new Error('rehearsal stage context is invalid');
  if (typeof context.cycleId !== 'string' || context.cycleId.length === 0) throw new Error('rehearsal stage cycleId is invalid');
  if (typeof context.stage !== 'string' || context.stage.length === 0) throw new Error('rehearsal stage is invalid');
  if (typeof context.releaseAmountMicroUsdg !== 'string' || !decimalPattern.test(context.releaseAmountMicroUsdg)) {
    throw new Error('rehearsal stage release amount is invalid');
  }
  return context;
}

function effectId(cycleId, stage) {
  return `rehearsal:${cycleId}:${stage}`;
}

function stageRequestDigest(context) {
  return digest({
    schema: 'hookemon.rehearsal-stage-request.v1',
    cycleId: context.cycleId,
    stage: context.stage,
    releaseAmountMicroUsdg: context.releaseAmountMicroUsdg,
    effectId: effectId(context.cycleId, context.stage),
  });
}

function evidenceFor({ context, config, requestDigest, skipped }) {
  const sourceAmount = Object.freeze({
    chainId: `eip155:${config.chainId}`,
    assetId: `eip155:${config.chainId}/erc20:${config.contracts.usdg.toLowerCase()}`,
    decimals: config.contracts.usdgDecimals,
    amountAtomic: context.releaseAmountMicroUsdg,
  });
  const settlementAmount = Object.freeze({
    chainId: 'solana-mainnet',
    assetId: config.relay.solanaMint,
    decimals: 6,
    amountAtomic: context.releaseAmountMicroUsdg,
  });
  const zeroResidue = Object.freeze({
    ...settlementAmount,
    amountAtomic: '0',
    classification: 'none',
  });
  return Object.freeze({
    schema: 'hookemon.rehearsal-stage-evidence.v1',
    cycleId: context.cycleId,
    stage: context.stage,
    requestDigest,
    effectId: effectId(context.cycleId, context.stage),
    finalizedDeltas: Object.freeze(skipped ? [] : context.stage === 'payout' ? [settlementAmount] : [sourceAmount]),
    residues: Object.freeze(skipped ? [] : [zeroResidue]),
    ...(skipped
      ? {
        skipped: true,
        rehearsalMode: 'collector-only',
        reason: 'Relay legs are outside the collector-only rehearsal profile',
      }
      : {}),
    ...(context.stage === 'payout'
      ? { proceedsAccount: config.rehearsal.proceedsAccount, payoutConservation: Object.freeze({ proceeds: settlementAmount, allocated: settlementAmount }) }
      : {}),
  });
}

/**
 * A sealed, effectful driver for the declared fake rehearsal profile. It writes the same
 * provider-attempt transitions as production handlers. Collector-only records durable Relay-leg
 * skips; relay-roundtrip invokes the fake Relay provider. Its irreversible effects are deterministic
 * and fake, which lets a restart harness exercise `SENT_UNKNOWN` reconciliation without a second
 * call to a live provider.
 */
export function createRehearsalStageDriver({
  cycleRepository,
  config,
  providers = null,
  onEffect = async () => {},
  restartInjector = null,
} = {}) {
  const repository = assertRepository(cycleRepository);
  const resolvedConfig = assertConfig(config);
  if (resolvedConfig.execution?.providerMode === 'fake' && providers === null) {
    throw new Error('rehearsal fake providers are required for a fake execution profile');
  }
  if (typeof onEffect !== 'function') throw new Error('rehearsal stage driver onEffect must be a function');
  if (restartInjector !== null && typeof restartInjector !== 'function') throw new Error('rehearsal stage driver restartInjector must be a function or null');

  async function reconcile(context) {
    assertContext(context);
    const current = await repository.readOperationalStageAttempt(context.cycleId, context.stage);
    if (current === null) return null;
    if (current.attempt.state === 'RECONCILED') return current.reconciliationEvidence;
    if (current.attempt.state !== 'RESPONSE_RECORDED') {
      throw new Error(`rehearsal stage ${context.stage} has no recorded provider response to reconcile`);
    }
    const evidence = current.responseEvidence;
    if (!evidence || evidence.schema !== 'hookemon.rehearsal-stage-evidence.v1') {
      throw new Error(`rehearsal stage ${context.stage} recorded provider evidence is invalid`);
    }
    await repository.reconcileStageAttempt(context.cycleId, context.stage, evidence);
    return evidence;
  }

  async function execute(context) {
    assertContext(context);
    if (typeof context.assertMutationAllowed === 'function') await context.assertMutationAllowed({ boundary: 'mutation' });
    const requestDigest = stageRequestDigest(context);
    const current = await repository.prepareStageAttempt(
      context.cycleId,
      context.stage,
      createPreparedProviderMutationAttempt({ cycleId: context.cycleId, stage: context.stage, requestDigest }),
    );
    if (current.attempt.state !== 'PREPARED') {
      throw new Error(`rehearsal stage ${context.stage} already has a durable effect attempt`);
    }
    const skipped = skipsRelayEffect(resolvedConfig.rehearsal.mode, context.stage);
    const evidence = evidenceFor({ context, config: resolvedConfig, requestDigest, skipped });
    try {
      if (!skipped) {
        const fakeProvider = fakeProviderForStage(providers, context.stage);
        if (fakeProvider !== null) {
          await fakeProvider.provider.executeRehearsalEffect(Object.freeze({
            provider: fakeProvider.name,
            cycleId: context.cycleId,
            stage: context.stage,
            effectId: evidence.effectId,
          }));
        }
        await onEffect(Object.freeze({ cycleId: context.cycleId, stage: context.stage, effectId: evidence.effectId }));
      }
      await repository.recordStageAttemptResponse(context.cycleId, context.stage, evidence);
      if (!skipped && restartInjector !== null) {
        await restartInjector(Object.freeze({ cycleId: context.cycleId, stage: context.stage, effectId: evidence.effectId }));
      }
      await repository.reconcileStageAttempt(context.cycleId, context.stage, evidence);
    } catch (error) {
      const attempt = await repository.readOperationalStageAttempt(context.cycleId, context.stage);
      if (attempt?.attempt?.state === 'PREPARED') await repository.markStageAttemptSentUnknown(context.cycleId, context.stage);
      throw error;
    }
  }

  return Object.freeze({
    reconcile,
    execute,
    async commit({ evidence }) {
      if (!evidence || evidence.schema !== 'hookemon.rehearsal-stage-evidence.v1') {
        throw new Error('rehearsal stage commit evidence is invalid');
      }
    },
  });
}
