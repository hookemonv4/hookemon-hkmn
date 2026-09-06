import {
  getFinalizedTokenBalanceChanges,
  readAssociatedTokenAccount,
  readBlockHeight,
  readBlockhashValidity,
  readFinalizedSignatureStatus,
  readUsableLatestBlockhash,
} from '../../solana-rpc.mjs';
import { assertTypedAmount, MAXIMUM_PACK_BATCH_SIZE } from '../../../../runner/src/cycle/money-schemas.mjs';
import {
  decodeProviderTransaction,
  evaluate as evaluateTransactionPolicy,
} from '../../signing/transaction-policy.mjs';
import { collectorPolicyForStage } from '../../signing/collector-policy-loader.mjs';
import {
  assertCollectorPurchaseBindingV1,
  createCollectorPurchasePolicy,
} from '../../signing/collector-purchase-policy.mjs';
import { OPERATOR_SOLANA_ROLE, wrapTransactionPolicySignerClient } from '../../signing/signer-client.mjs';
import { requireCollectorOnlyMutationAuthority } from '../../../rehearsal/collector-only-authorization.mjs';
import { parseCollectorMachineContains } from '../../collector-crypt.mjs';
import {
  assertSolanaSignerFeeEnvelope,
  assertSolanaSignerMoneyConfiguration,
} from './solana-money-controls.mjs';

const canonicalUnsignedInteger = /^(0|[1-9][0-9]*)$/;
const DEFAULT_UNRESOLVED_CARD_DEADLINE_MINUTES = 30;
const MINIMUM_UNRESOLVED_CARD_DEADLINE_MINUTES = 5;
const MAXIMUM_UNRESOLVED_CARD_DEADLINE_MINUTES = 1440;

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function configuredSettlementAsset(config) {
  const asset = config?.collectorCrypt?.settlementAsset;
  if (!plainObject(asset)
    || typeof asset.chainId !== 'string' || asset.chainId.length === 0
    || typeof asset.assetId !== 'string' || asset.assetId.length === 0
    || !Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 255) {
    throw new Error('Collector purchase requires a configured settlementAsset with chainId, assetId, and decimals');
  }
  if (asset.chainId !== config?.solana?.chainId) throw new Error('Collector purchase settlementAsset chainId must match config.solana.chainId');
  return Object.freeze({ chainId: asset.chainId, assetId: asset.assetId, decimals: asset.decimals });
}

function atomicString(value, label) {
  if (typeof value === 'string' && canonicalUnsignedInteger.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'bigint' && value >= 0n) return value.toString();
  throw new Error(`${label} must be a canonical non-negative atomic amount`);
}

function typedAmount(asset, value, label) {
  return assertTypedAmount({ ...asset, amountAtomic: atomicString(value, label) }, label);
}

function requirePolicy(config, stage) {
  const bundlePolicy = collectorPolicyForStage(config, stage);
  if (bundlePolicy !== null) return bundlePolicy;
  const policy = config?.collectorCrypt?.[stage]?.policy;
  if (!plainObject(policy)) throw new Error(`Collector ${stage} requires a pinned transaction policy`);
  return policy;
}

/**
 * Fixture-only binding seam (offline simulation wiring): plain data under
 * `config.collectorCrypt.purchase.testFixtureBinding`, accepted only from the Node test runner and
 * never populated by `readEnvironment` or a production binding registry -- neither of those write
 * this key, so a real process never carries it regardless of this guard. A caller that declares the
 * key outside the Node test runner is refused rather than silently ignored, so a future production
 * wiring mistake fails loudly instead of falling back to the legacy evidence/static policy path.
 */
const FIXTURE_WRAPPER_FIELDS = Object.freeze(['binding', 'expectedDigest']);

function exactKeysOnly(value, fields) {
  if (!plainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every(field => Object.hasOwn(value, field));
}

function purchaseBindingFixture(config) {
  const purchaseConfig = config?.collectorCrypt?.purchase;
  if (!plainObject(purchaseConfig) || !Object.hasOwn(purchaseConfig, 'testFixtureBinding')) return null;
  if (process.env.NODE_TEST_CONTEXT === undefined) {
    throw new Error('Collector purchase fixture binding is available only from the Node test runner');
  }
  const fixture = purchaseConfig.testFixtureBinding;
  if (!exactKeysOnly(fixture, FIXTURE_WRAPPER_FIELDS) || typeof fixture.expectedDigest !== 'string' || fixture.binding === undefined) {
    throw new Error('Collector purchase fixture binding must supply exactly binding and expectedDigest');
  }
  return fixture;
}

/** Refuses a validated fixture binding whose chain/settlement identity does not match the same
 * native Collector settlement asset every other purchase check is already pinned to. */
function assertFixtureBindingMatchesSettlementAsset(binding, asset) {
  if (binding.chainId !== asset.chainId) {
    throw new Error('Collector purchase fixture binding chainId does not match the configured settlement asset');
  }
  if (binding.settlement.mint !== asset.assetId) {
    throw new Error('Collector purchase fixture binding settlement mint does not match the configured settlement asset');
  }
  if (binding.settlement.decimals !== asset.decimals) {
    throw new Error('Collector purchase fixture binding settlement decimals does not match the configured settlement asset');
  }
}

function requireSolanaConfiguration({ adapters, config, signerClient, stage }) {
  if (!adapters?.solana?.client) throw new Error(`Collector ${stage} requires a configured Solana RPC client`);
  if (!signerClient?.solana || typeof signerClient.solana.sign !== 'function') {
    throw new Error(`Collector ${stage} requires signerClient.solana.sign`);
  }
  if (typeof config?.solana?.chainId !== 'string' || config.solana.chainId.length === 0) {
    throw new Error(`Collector ${stage} requires config.solana.chainId`);
  }
}

function trustedSolanaDecodeOptions({ adapters, config, stage }) {
  if (typeof config?.solana?.blockhashContextResolver !== 'function') {
    throw new Error(`Collector ${stage} requires a trusted Solana blockhashContextResolver`);
  }
  return Object.freeze({
    family: 'solana',
    chainId: config.solana.chainId,
    lookupTableResolver: config.solana.lookupTableResolver,
    blockhashContextResolver: config.solana.blockhashContextResolver,
    currentBlockHeightResolver: async () => readBlockHeight(adapters.solana.client),
  });
}

async function decodeAndSignProviderTransaction({ transaction, stage, adapters, config, money, signerClient, policy = null }) {
  const decodeOptions = trustedSolanaDecodeOptions({ adapters, config, stage });
  const decoded = await decodeProviderTransaction({ ...decodeOptions, transaction });
  if (!decoded.blockhash || !(await readBlockhashValidity(adapters.solana.client, decoded.blockhash))) {
    throw new Error(`Collector ${stage} transaction blockhash is not valid before signing`);
  }
  // Resolved once per candidate and reused for evaluate/signer below, never re-resolved from
  // `requirePolicy` a second time -- a caller that already built a specific policy (the
  // fixture-bound per-pack policy from mutatePurchase) hands it in directly instead.
  const effectivePolicy = policy ?? requirePolicy(config, stage);
  evaluateTransactionPolicy(effectivePolicy, decoded);
  await assertSolanaSignerFeeEnvelope({
    client: adapters.solana.client,
    owner: config.accounts?.solana,
    money,
    decoded,
    nativeChainId: config.solana.chainId,
    stage: `Collector ${stage}`,
  });
  const signer = wrapTransactionPolicySignerClient({
    client: {
      role: signerClient.solana.role ?? OPERATOR_SOLANA_ROLE,
      async sign(request) {
        requireCollectorOnlyMutationAuthority(config);
        return signerClient.solana.sign(request);
      },
    },
    policy: effectivePolicy,
    decodeOptions,
    broadcast: async signed => {
      if (!(await readBlockhashValidity(adapters.solana.client, decoded.blockhash))) {
        throw new Error(`Collector ${stage} transaction blockhash expired before submission`);
      }
      requireCollectorOnlyMutationAuthority(config);
      return adapters.collectorCrypt.submitTransaction({ signedTransaction: signed.signedTxBase64 });
    },
  });
  return { signer, signed: await signer.sign(transaction) };
}

function expectedCardCountFromCatalog({ catalog, packType }) {
  if (!plainObject(catalog) || !Array.isArray(catalog.machines)) {
    throw new Error('purchase prepareRequest received an invalid Collector machine catalog');
  }
  const matches = catalog.machines.filter(machine => plainObject(machine) && machine.code === packType);
  if (matches.length !== 1) throw new Error('purchase prepareRequest requires exactly one configured Collector machine');
  return parseCollectorMachineContains(matches[0].contains);
}

async function expectedCardCountPerPack({ adapters, packType }) {
  if (typeof adapters?.collectorCrypt?.getMachines !== 'function') {
    throw new Error('purchase prepareRequest requires collector-crypt machine data');
  }
  const count = expectedCardCountFromCatalog({ catalog: await adapters.collectorCrypt.getMachines(), packType });
  // open() supports exactly one card per pack (the documented openPack response carries a single
  // nft_address). A catalog entry needing more is rejected here, at admission, before any pack in
  // the batch is purchased.
  if (count !== 1) throw new Error(`Collector machine "${packType}" needs an unsupported ${count}-card fan-out per pack`);
  return count;
}

/**
 * Purchase-stage quantity validation against the documented provider batch ceiling / shared
 * durable-journal payload bound (`MAXIMUM_PACK_BATCH_SIZE`, packages/runner/src/cycle/money-schemas.mjs).
 * Applied both to an explicitly configured quantity and to a durably admitted one
 * (`resolvePurchaseQuantity` below), so a replayed or corrupt admission record is never trusted
 * past this ceiling merely because it was durably admitted.
 *
 * This is defense-in-depth at the purchase stage, not the cycle's only such refusal, and does not
 * by itself mean "before any spend": purchase is the fourth operational stage
 * (`OPERATIONAL_CYCLE_STAGES`, packages/runner/src/cycle/money-schemas.mjs), after claim-process
 * and outbound, so an over-ceiling quantity that reached this point could already have claimed and
 * bridged funds. The pre-cycle enforcement point is `normalizePolicyAdmission`
 * (packages/runner/src/automation/policy-engine.mjs), which now applies this exact ceiling before
 * `CycleRepository` durably persists an admission at all -- i.e. before the cycle exists and
 * before claim-process can run. `buildAdmissionPlanner.plan` (packages/adapters/src/app/compose.mjs)
 * can still quote and admit an over-ceiling request before reaching that normalizer; closing that
 * remaining planner-side gap is out of this file's write-set (see
 * pack-quantity-corrected-report.md).
 */
function assertConfiguredPackQuantity(value, label = 'config.pack.quantity') {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAXIMUM_PACK_BATCH_SIZE) {
    throw new Error(`Collector purchase ${label} must be an integer from 1 through ${MAXIMUM_PACK_BATCH_SIZE}`);
  }
  return value;
}

/**
 * Refuses admission, before any spend, when purchasing `quantity` more packs could push the
 * outstanding held-position count or value past the operator's configured ceiling — even though
 * every individual position stays within limits at claim-process admission (a single multi-pack
 * batch can otherwise add several held positions in one already-admitted cycle). Silently does
 * nothing when the caller has no held-position read access (the current default, non-collector-only
 * preparation input) or the operator has not configured a ceiling.
 */
async function assertHeldHeadroom({ cycleRepository, context, config, quantity }) {
  if (typeof cycleRepository?.listHeldPositions !== 'function') return;
  const maxHeldPositions = config?.maxHeldPositions;
  const maxHeldValueMicroUsdg = config?.maxHeldValueMicroUsdg;
  const checksCount = Number.isSafeInteger(maxHeldPositions);
  const checksValue = typeof maxHeldValueMicroUsdg === 'string' && canonicalUnsignedInteger.test(maxHeldValueMicroUsdg);
  if (!checksCount && !checksValue) return;
  const positions = await cycleRepository.listHeldPositions({ includeResolved: false });
  if (checksCount) {
    const deficit = positions.length + quantity - maxHeldPositions;
    if (deficit > 0) {
      throw new Error(`purchase admission refused: HELD_LIMIT would exceed maxHeldPositions by ${deficit} position(s) (${positions.length} outstanding + ${quantity} requested > ${maxHeldPositions})`);
    }
  }
  if (checksValue) {
    const currentValue = positions.reduce((sum, position) => sum + BigInt(position.valueMicroUsdg ?? '0'), 0n);
    let worstCasePerPack = 0n;
    if (typeof context?.cycleId === 'string' && typeof cycleRepository.describeCycle === 'function') {
      const description = await cycleRepository.describeCycle(context.cycleId);
      if (typeof description?.releaseAmount === 'string' && canonicalUnsignedInteger.test(description.releaseAmount)) {
        worstCasePerPack = BigInt(description.releaseAmount) / BigInt(quantity);
      }
    }
    const projectedValue = currentValue + (worstCasePerPack * BigInt(quantity));
    const maximum = BigInt(maxHeldValueMicroUsdg);
    if (projectedValue > maximum) {
      throw new Error(`purchase admission refused: HELD_LIMIT would exceed maxHeldValueMicroUsdg by ${(projectedValue - maximum).toString()} (worst case ${projectedValue.toString()} > ${maximum.toString()})`);
    }
  }
}

/**
 * True only for the composed production execution profile (`config.execution.profile ===
 * 'production'`, packages/adapters/src/app/compose.mjs). Every other value -- 'rehearsal'
 * (including the explicitly authorized Collector-only rehearsal mode) and 'inspection', plus a
 * standalone caller that never built a full composed config (`probePurchase`'s dry-run path, or a
 * unit-test fixture) -- is treated as non-production here.
 */
function isProductionExecutionProfile(config) {
  return config?.execution?.profile === 'production';
}

/**
 * The authoritative per-cycle quantity and its typed per-pack/whole-batch settlement bounds.
 *
 * The durably admitted cycle (`cycleRepository.describeCycle(context.cycleId).admission`) is the
 * one source of truth for how many packs this cycle actually spends for: it is written once, at
 * admission, from the operator's `requestedOrders` at that moment
 * (`buildAdmissionPlanner.plan`, packages/adapters/src/app/compose.mjs), and it is immutable after
 * that. `config.pack.quantity` is not a second, competing source for an admitted cycle: it is
 * consulted only to refuse an explicit contradiction (protects a caller that pinned a specific
 * quantity, e.g. a signed or already-prepared request, from silently being redirected to a
 * different admitted quantity) and, for a genuinely unadmitted, non-production context
 * (`probePurchase`'s dry-run path, or a test fixture with no admission), as the sole bounded
 * default (1 when unset).
 *
 * A missing admission (no cycle-scoped repository/context at all, or a real cycle record whose
 * `admission` is null) is refused, not defaulted, whenever the composed config's execution
 * profile is `'production'` (pack-quantity-review.md P1): the production stage-driver always
 * supplies a fenced `describeCycle` and a durable cycle id, so an absent admission there is a
 * production invariant failure -- constructing an unpriced one-pack request instead would let a
 * legacy or partially composed production cycle spend with no admitted, typed purchase bound at
 * all. The bounded config/default fallback remains available for every other, explicitly
 * non-production context.
 *
 * Binding the bounds into the prepared request puts them under the request digest, so the amount
 * each pack may debit is fixed before anything is signed and cannot be renegotiated afterwards.
 */
async function resolvePurchaseQuantity({ cycleRepository, context, config, packType }) {
  const configuredQuantity = config?.pack?.quantity;
  if (configuredQuantity !== undefined) assertConfiguredPackQuantity(configuredQuantity);
  const hasCycleScope = typeof cycleRepository?.describeCycle === 'function' && typeof context?.cycleId === 'string';
  const admission = hasCycleScope ? (await cycleRepository.describeCycle(context.cycleId))?.admission ?? null : null;
  if (admission === null) {
    if (isProductionExecutionProfile(config)) {
      throw new Error('purchase prepareRequest requires a durable cycle admission in the production execution profile');
    }
    return { quantity: configuredQuantity === undefined ? 1 : configuredQuantity, bounds: null };
  }
  if (admission.packId !== packType) throw new Error('purchase prepareRequest pack does not match the admitted pack');
  const quantity = assertConfiguredPackQuantity(admission.quantity, 'admitted quantity');
  if (configuredQuantity !== undefined && configuredQuantity !== quantity) {
    throw new Error('purchase prepareRequest quantity does not match the admitted quantity');
  }
  const unit = admission.unitPurchase;
  const aggregate = admission.aggregatePurchase;
  if (BigInt(unit.amountAtomic) * BigInt(quantity) !== BigInt(aggregate.amountAtomic)) {
    throw new Error('purchase prepareRequest admitted aggregate is not the admitted unit times quantity');
  }
  return { quantity, bounds: Object.freeze({ unitPurchase: unit, aggregatePurchase: aggregate }) };
}

export async function preparePurchaseRequest({ adapters, config, cycleRepository, context }) {
  const playerAddress = config?.accounts?.solana;
  if (typeof playerAddress !== 'string' || playerAddress.length === 0) throw new Error('purchase prepareRequest requires HOOKEMON_SOLANA_ACCOUNT');
  const packType = config?.pack?.code;
  const { quantity, bounds } = await resolvePurchaseQuantity({ cycleRepository, context, config, packType });
  await assertHeldHeadroom({ cycleRepository, context, config, quantity });
  const request = {
    provider: 'collector-crypt',
    operation: 'purchase',
    playerAddress,
    quantity,
    ...(bounds === null ? {} : bounds),
  };
  if (typeof packType !== 'string' || packType.length === 0) return request;
  return { ...request, packType, expectedCardCountPerPack: await expectedCardCountPerPack({ adapters, packType }) };
}

export async function probePurchase({ adapters, config }) {
  if (!adapters.collectorCrypt) return { wouldPurchase: true, configured: false, reason: 'collector-crypt client is not configured' };
  const [catalog, status] = await Promise.all([adapters.collectorCrypt.getMachines(), adapters.collectorCrypt.getStatus()]);
  const evidence = {
    wouldPurchase: true,
    configured: true,
    machineCount: Array.isArray(catalog?.machines) ? catalog.machines.length : null,
    machineStatus: status.machineStatus,
    // probePurchase has no cycle context to admit against (it is the standalone dry-run/status
    // read), so config.pack.quantity's bounded default (1 when unset) is the only source here.
    quantity: assertConfiguredPackQuantity(config?.pack?.quantity ?? 1),
  };
  const packType = config?.pack?.code;
  if (typeof packType !== 'string' || packType.length === 0) return evidence;
  try {
    return { ...evidence, packType, expectedCardCountPerPack: expectedCardCountFromCatalog({ catalog, packType }) };
  } catch (error) {
    return { ...evidence, configured: false, packType, reason: error.message };
  }
}

function unresolvedCardDeadlineMinutes(config) {
  const value = config?.unresolvedCardDeadlineMinutes ?? DEFAULT_UNRESOLVED_CARD_DEADLINE_MINUTES;
  if (!Number.isSafeInteger(value)
    || value < MINIMUM_UNRESOLVED_CARD_DEADLINE_MINUTES
    || value > MAXIMUM_UNRESOLVED_CARD_DEADLINE_MINUTES) {
    throw new Error('purchase unresolvedCardDeadlineMinutes is invalid');
  }
  return value;
}

function pastDeadline(sinceMs, config, context) {
  const nowMs = context?.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('purchase reconciliation clock is invalid');
  return nowMs >= sinceMs + unresolvedCardDeadlineMinutes(config) * 60_000;
}

async function holdWholeCycle(cycleRepository, context, evidence) {
  if (typeof cycleRepository?.holdCycle !== 'function') throw new Error('purchase reconciliation requires cycleRepository.holdCycle');
  await cycleRepository.holdCycle(context.cycleId, 'HELD_DATA_UNVERIFIED', evidence);
  return null;
}

export async function mutatePurchase({ liveMode, adapters, signerClient, config, cycleRepository, context, request }) {
  if (liveMode !== true) throw new Error('stage-driver internal error: mutatePurchase reached without liveMode');
  if (!adapters?.collectorCrypt) throw new Error('purchase mutate requires a configured collector-crypt client');
  requireSolanaConfiguration({ adapters, config, signerClient, stage: 'purchase' });
  const asset = configuredSettlementAsset(config);
  const money = assertSolanaSignerMoneyConfiguration({ config, asset, stage: 'purchase' });
  const prepared = request ?? context?.request ?? await preparePurchaseRequest({ adapters, config });
  const quantity = assertConfiguredPackQuantity(prepared.quantity);
  if (!Number.isSafeInteger(prepared.expectedCardCountPerPack) || prepared.expectedCardCountPerPack < 1) {
    throw new Error('purchase mutation requires a positive prepared per-pack card-count expectation');
  }
  const account = await readAssociatedTokenAccount(adapters.solana.client, prepared.playerAddress, asset.assetId);
  if (!account.exists) throw new Error('purchase mutate requires the operator settlement token account to exist');
  if (account.decimals !== asset.decimals) throw new Error('purchase mutate settlement token account decimals do not match configured settlementAsset');

  // The batch may already be durably recorded from an interrupted prior attempt (crash after the
  // provider call returned, before every pack finished signing). Reuse it rather than requesting
  // a second batch under the same memo identity — a fresh generateYoloPacks call after the
  // provider already committed the first would be a genuine double purchase.
  let batch = await cycleRepository.readPackBatchRequest(context.cycleId, 'purchase');
  let unsignedTransactionsByMemo = null;
  // Set only when this invocation is about to generate a fresh batch under a validated fixture
  // binding. Carries an immutable trusted snapshot -- the factory parser's deep-frozen clone plus
  // the expected digest copied as a primitive -- captured entirely before `generateYoloPacks` is
  // awaited. The raw `{ binding, expectedDigest }` fixture object is never read again after this
  // preflight, so a provider callback that mutates it during the await (even to describe a binding
  // matching its own candidate) cannot change what this invocation already trusts.
  let trustedBinding = null;
  // Set only when this invocation resolved the legacy evidence/static policy at preflight. That
  // exact object -- not a re-resolved one -- is passed through decode/evaluate/sign below;
  // `requirePolicy` is never called a second time for it.
  let legacyPolicy = null;
  let admittedUnitAmountAtomic = null;
  if (batch === null) {
    requireCollectorOnlyMutationAuthority(config);

    // Canonical typed-money validation of the immutable admitted per-pack amount, and proof its
    // asset identity is exactly the configured native Collector settlement asset -- before the
    // durable intent write or any provider call.
    if (!plainObject(prepared.unitPurchase)) {
      throw new Error('purchase mutation requires the admitted unitPurchase amount');
    }
    const admittedUnitPurchase = assertTypedAmount(prepared.unitPurchase, 'purchase mutation admitted unitPurchase');
    if (admittedUnitPurchase.chainId !== asset.chainId || admittedUnitPurchase.assetId !== asset.assetId
      || admittedUnitPurchase.decimals !== asset.decimals) {
      throw new Error('purchase mutation admitted unitPurchase asset does not match the configured settlement asset');
    }
    admittedUnitAmountAtomic = admittedUnitPurchase.amountAtomic;

    // The one seam this task wires: validate a Node-test-only fixture binding (schema, digest,
    // and native chain/settlement identity) before ever calling generateYoloPacks, so a bad or
    // missing binding -- like a missing legacy evidence/static policy -- refuses before the
    // durable intent write or any provider generation, sign, or submit call.
    const fixture = purchaseBindingFixture(config);
    if (fixture !== null) {
      const validatedBinding = assertCollectorPurchaseBindingV1(fixture.binding, fixture.expectedDigest);
      assertFixtureBindingMatchesSettlementAsset(validatedBinding, asset);
      trustedBinding = Object.freeze({ binding: validatedBinding, expectedDigest: String(fixture.expectedDigest) });
    } else {
      legacyPolicy = requirePolicy(config, 'purchase');
    }

    // Persist exactly what is about to be requested -- cycle, quantity, and pack code -- before
    // the batch call itself. If the call's response is lost with no memo at all, this durable,
    // human-readable intent (not just the generic stage attempt's opaque request digest) is what
    // an operator correlates against provider support while the cycle stays held.
    await cycleRepository.recordPackBatchIntent(context.cycleId, 'purchase', {
      quantity,
      packType: prepared.packType ?? null,
      expectedCardCountPerPack: prepared.expectedCardCountPerPack,
      playerAddress: prepared.playerAddress,
    });

    const generated = await adapters.collectorCrypt.generateYoloPacks({
      playerAddress: prepared.playerAddress,
      quantity,
      ...(prepared.packType ? { packType: prepared.packType } : {}),
    });
    unsignedTransactionsByMemo = new Map(generated.packs.map(pack => [pack.memo, pack.transaction]));
    const packs = generated.packs.map((pack, packIndex) => ({
      packIndex,
      memo: pack.memo,
      expectedCardCount: prepared.expectedCardCountPerPack,
      packType: prepared.packType ?? null,
    }));
    batch = await cycleRepository.recordPackBatchRequest(context.cycleId, 'purchase', packs);
  }

  // Sign and broadcast every pack this invocation still holds unsigned bytes for. A pack whose
  // bytes were only ever in a crashed process's memory cannot be re-signed under its existing
  // memo; reconcileLivePurchase resolves it to "not purchased" once its deadline passes.
  if (unsignedTransactionsByMemo !== null) {
    for (const pack of batch.packs) {
      const transaction = unsignedTransactionsByMemo.get(pack.memo);
      if (transaction === undefined) continue;

      let policy;
      if (trustedBinding !== null) {
        // Read a fresh usable latest blockhash and current height from the configured fixture RPC
        // immediately before this pack's own policy and decode -- never a shared batch-wide read.
        // Neither the approved binding nor the provider API contract guarantees one blockhash for
        // a generated batch.
        const latest = await readUsableLatestBlockhash(adapters.solana.client);
        const currentHeight = await readBlockHeight(adapters.solana.client);
        const blockhashContext = Object.freeze({
          blockhash: latest.blockhash,
          lastValidBlockHeight: String(latest.lastValidBlockHeight),
          currentBlockHeight: currentHeight.toString(),
        });
        // A separate, real policy per pack, built only from the trusted binding snapshot, the
        // immutable admitted unit amount, the durable request digest, this durably recorded pack's
        // own memo, the independently read source ATA, the configured Operations payer, and this
        // pack's own fresh blockhash context -- never from the candidate `transaction` decoded
        // below.
        policy = createCollectorPurchasePolicy({
          binding: trustedBinding.binding,
          expectedDigest: trustedBinding.expectedDigest,
          cycleFacts: {
            operatorFeePayer: config.accounts.solana,
            sourceAta: account.address,
            amountAtomic: admittedUnitAmountAtomic,
            memoValue: pack.memo,
            requestDigest: context.requestDigest,
          },
          blockhashContext,
        });
      } else {
        policy = legacyPolicy;
      }

      const { signer, signed } = await decodeAndSignProviderTransaction({
        transaction,
        stage: 'purchase',
        adapters,
        config,
        money,
        signerClient,
        policy,
      });
      await signer.broadcast(signed);
    }
  }

  return { quantity, expectedCardCountPerPack: prepared.expectedCardCountPerPack };
}

async function reconcilePack({ adapters, config, context, asset, pack, playerAddress, deadlineSinceMs, unitPurchase = null }) {
  let packStatus;
  try {
    packStatus = await adapters.collectorCrypt.getPackStatus({ memo: pack.memo });
  } catch {
    return { determined: false };
  }
  if (packStatus.memo !== pack.memo) {
    return { determined: true, outcome: 'anomaly', evidence: { reason: 'pack status memo did not match', packStatus } };
  }
  if (packStatus.pack === null) {
    if (!pastDeadline(deadlineSinceMs, config, context)) return { determined: false };
    return {
      determined: true,
      outcome: 'notPurchased',
      packIndex: pack.packIndex,
      memo: pack.memo,
      evidence: { reason: 'no provider purchase evidence before the reconcile deadline' },
    };
  }
  if (!plainObject(packStatus.pack) || typeof packStatus.pack.transaction_signature !== 'string'
    || packStatus.pack.transaction_signature.length === 0 || packStatus.pack.token_mint !== asset.assetId) {
    return { determined: true, outcome: 'anomaly', evidence: { reason: 'pack status does not carry a documented purchase record', packStatus } };
  }
  const signature = packStatus.pack.transaction_signature;
  let signatureStatus;
  try {
    signatureStatus = await readFinalizedSignatureStatus(adapters.solana.client, signature);
  } catch {
    return { determined: false };
  }
  if (signatureStatus === null) return { determined: false };
  if (signatureStatus.err) {
    return {
      determined: true,
      outcome: 'notPurchased',
      packIndex: pack.packIndex,
      memo: pack.memo,
      evidence: { reason: 'provider purchase transaction finalized with an error', signature, signatureStatus },
    };
  }
  let entries;
  try {
    entries = await getFinalizedTokenBalanceChanges(adapters.solana.client, signature);
  } catch {
    return { determined: false };
  }
  const debits = entries.filter(entry => entry.owner === playerAddress && entry.mint === asset.assetId && BigInt(entry.postAmount) < BigInt(entry.preAmount));
  if (debits.length !== 1) {
    return { determined: true, outcome: 'anomaly', evidence: { reason: 'exact settlement debit was not observed', signature } };
  }
  const packCost = typedAmount(asset, BigInt(debits[0].preAmount) - BigInt(debits[0].postAmount), 'purchase pack cost');
  if (packCost.amountAtomic === '0') {
    return { determined: true, outcome: 'anomaly', evidence: { reason: 'observed settlement debit was zero', signature } };
  }
  // The finalized debit is reconciled against the per-pack bound this cycle was admitted for. A
  // larger actual debit is held as an anomaly rather than accepted: an amount nobody authorized must
  // never be relabelled as this pack's price just because the chain finalized it.
  if (unitPurchase !== null) {
    if (unitPurchase.chainId !== packCost.chainId || unitPurchase.assetId !== packCost.assetId
      || unitPurchase.decimals !== packCost.decimals) {
      return {
        determined: true,
        outcome: 'anomaly',
        evidence: { reason: 'observed settlement debit is not in the admitted purchase asset', signature, packCost, unitPurchase },
      };
    }
    if (BigInt(packCost.amountAtomic) > BigInt(unitPurchase.amountAtomic)) {
      return {
        determined: true,
        outcome: 'anomaly',
        evidence: { reason: 'observed settlement debit exceeds the admitted per-pack bound', signature, packCost, unitPurchase },
      };
    }
  }
  return {
    determined: true,
    outcome: 'purchased',
    packIndex: pack.packIndex,
    memo: pack.memo,
    signature,
    expectedCardCount: pack.expectedCardCount,
    packCost,
  };
}

export async function reconcileLivePurchase({ adapters, config, cycleRepository, context }) {
  const batch = await cycleRepository.readPackBatchRequest(context.cycleId, 'purchase');
  if (batch === null) {
    const record = await cycleRepository.readOperationalStageAttempt(context.cycleId, 'purchase');
    if (record?.attempt?.state !== 'SENT_UNKNOWN' || !Number.isSafeInteger(record.sentAtMs)) return null;
    if (!pastDeadline(record.sentAtMs, config, context)) return null;
    const intentRecord = await cycleRepository.readPackBatchIntent(context.cycleId, 'purchase');
    return holdWholeCycle(cycleRepository, context, {
      stage: 'purchase',
      attempt: record.attempt,
      sentAtMs: record.sentAtMs,
      deadlineMinutes: unresolvedCardDeadlineMinutes(config),
      // The pre-call intent (quantity, pack code) is the durable, human-readable record of what
      // was requested when no memo ever came back to check provider status against.
      intent: intentRecord?.intent ?? null,
      reason: 'purchase batch generation remained sent-unknown past the reconcile deadline with no durably generated pack',
    });
  }
  if (!adapters?.collectorCrypt || !adapters?.solana?.client) return null;
  const asset = configuredSettlementAsset(config);
  // The wallet that actually made this purchase is bound durably at the pre-call intent, not
  // re-derived from the live operator config -- a config change (wallet rotation, environment
  // swap) between purchase and a later restart/reconcile must never change which address this
  // cycle's settlement debit is attributed to.
  const intentRecord = await cycleRepository.readPackBatchIntent(context.cycleId, 'purchase');
  if (intentRecord === null) throw new Error('purchase reconciliation requires the pre-call intent that must exist alongside any recorded batch');
  const playerAddress = intentRecord.intent.playerAddress;
  // Read from the cycle's own immutable admission, like playerAddress above, so a later
  // configuration change cannot move the bound each finalized debit is reconciled against.
  const admittedUnitPurchase = typeof cycleRepository.describeCycle === 'function'
    ? ((await cycleRepository.describeCycle(context.cycleId))?.admission?.unitPurchase ?? null)
    : null;

  const outcomes = [];
  for (const pack of batch.packs) {
    const result = await reconcilePack({
      adapters, config, context, asset, pack, playerAddress,
      deadlineSinceMs: batch.requestedAtMs,
      unitPurchase: admittedUnitPurchase,
    });
    if (!result.determined) return null;
    if (result.outcome === 'anomaly') {
      return holdWholeCycle(cycleRepository, context, {
        stage: 'purchase',
        packIndex: pack.packIndex,
        memo: pack.memo,
        ...result.evidence,
      });
    }
    outcomes.push(result);
  }

  const purchased = outcomes.filter(outcome => outcome.outcome === 'purchased');
  return {
    quantity: batch.packs.length,
    packs: outcomes.map(outcome => (outcome.outcome === 'purchased'
      ? {
        packIndex: outcome.packIndex,
        memo: outcome.memo,
        status: 'purchased',
        signature: outcome.signature,
        expectedCardCount: outcome.expectedCardCount,
        packCost: outcome.packCost,
      }
      : { packIndex: outcome.packIndex, memo: outcome.memo, status: 'not_purchased' })),
    purchasedCount: purchased.length,
  };
}
