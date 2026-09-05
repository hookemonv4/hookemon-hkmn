// Per-action-kind field derivation (WP-35): the real account/asset fields for each of the four
// CycleRunner action kinds, built from real configuration (never a fixture literal) via
// `action-builder.mjs`'s `buildProductionAction`. `funding.mjs` calls `buildReturnAction` once, to
// compute `returnActionDigest` — the one `IPegCycleVault.FundingAuthorization` field this scheme
// still applies to (`payout.mjs` reuses that exact value verbatim, never recomputing it — see
// `funding.mjs`'s own header for why `outboundActionDigest` no longer uses this scheme at all: it
// is a literal `keccak256` of real Relay route calldata bytes instead, computed in `funding.mjs`
// directly). `buildOutboundAction`/`buildPurchaseAction`/`buildBuybackAction` remain here as
// general per-action-kind builders (structurally validated by `assertProductionAction`) for any
// future stage module that needs one — no current live stage module calls them.
import { deriveAssociatedTokenAddress, CIRCLE_USD_MINT } from '../../solana-rpc.mjs';
import { assertMoneyConfiguration } from '../../../../runner/src/cycle/money-schemas.mjs';
import { buildProductionAction } from './action-builder.mjs';

function requireMoneyConfiguration(config) {
  if (!config?.moneyConfiguration) throw new Error('leg actions require MoneyConfigurationV1');
  let money;
  try {
    money = assertMoneyConfiguration(config.moneyConfiguration, 'leg action money configuration');
  } catch (error) {
    throw new Error(`leg actions require MoneyConfigurationV1: ${error.message}`);
  }
  if (money.assets.usdg.chainId !== '4663') {
    throw new Error('leg actions require MoneyConfigurationV1 for the configured EVM chain');
  }
  if (money.assets.solanaStablecoin.assetId !== CIRCLE_USD_MINT || money.assets.solanaStablecoin.decimals !== 6) {
    throw new Error('leg actions require MoneyConfigurationV1 for the configured Solana stablecoin');
  }
  return money;
}

function requireValidityEvidence(value) {
  const fields = ['recentBlockhash', 'currentHeight', 'lastValidHeight'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== fields.length || !fields.every(field => Object.hasOwn(value, field))) {
    throw new Error('leg actions require explicit validity evidence');
  }
  return value;
}

function policyCircleUsdAccountFor(config, money) {
  return deriveAssociatedTokenAddress(config.accounts.solana, money.assets.solanaStablecoin.assetId).toBase58();
}

function configuredPackBinding(config, money) {
  const wallet = config.accounts.solana;
  const refundTokenAccount = policyCircleUsdAccountFor(config, money);
  return {
    sourceChainId: Number(money.assets.usdg.chainId),
    executionCluster: 'mainnet-beta',
    circleDollarMint: money.assets.solanaStablecoin.assetId,
    circleDollarDecimals: money.assets.solanaStablecoin.decimals,
    pack: config.pack.code,
    quantity: 1,
    turbo: false,
    executionWallet: wallet,
    refundTokenAccount,
    refundTokenAccountOwner: wallet,
  };
}

/** The policy wallet's own Circle USD associated token account — the fixed refund/purchase token
 * account every action after the first one is bound to (docs/modules/cycle-runner.md: "The first
 * fixture action fixes the execution wallet, NFT custody wallet, refund token account ... for all
 * four actions"). Computed locally (no RPC round trip: this is a deterministic PDA derivation), so
 * every stage that needs it derives the exact same address. */
export function policyCircleUsdAccount(config) {
  return policyCircleUsdAccountFor(config, requireMoneyConfiguration(config));
}

export function packBinding(config) {
  const money = requireMoneyConfiguration(config);
  return configuredPackBinding(config, money);
}

export function buildOutboundAction({ cycleId, preflightDigest, custody, config, principalAmount, feePayer, validity }) {
  const money = requireMoneyConfiguration(config);
  const binding = configuredPackBinding(config, money);
  return buildProductionAction({
    actionKind: 'outbound',
    cycleId,
    preflightDigest,
    custody,
    binding,
    principalAmount,
    minimumReceive: money.minimums.solanaReceive.amountAtomic,
    nativeGasAmount: money.evm.nativeReserve.amountAtomic,
    feePayer: feePayer ?? config.accounts.evm,
    sourceAccount: custody.returnAccount,
    inputAsset: 'USDG',
    outputAsset: money.assets.solanaStablecoin.assetId,
    mint: money.assets.solanaStablecoin.assetId,
    tokenAccount: custody.returnAccount,
    destination: binding.executionWallet,
    validity: requireValidityEvidence(validity),
  });
}

export function buildPurchaseAction({ cycleId, preflightDigest, custody, config, principalAmount, feePayer, validity }) {
  const money = requireMoneyConfiguration(config);
  const binding = configuredPackBinding(config, money);
  return buildProductionAction({
    actionKind: 'purchase',
    cycleId,
    preflightDigest,
    custody,
    binding,
    principalAmount,
    minimumReceive: money.minimums.solanaReceive.amountAtomic,
    nativeGasAmount: money.solana.lamportReserve.amountAtomic,
    feePayer: feePayer ?? binding.executionWallet,
    sourceAccount: binding.executionWallet,
    inputAsset: money.assets.solanaStablecoin.assetId,
    outputAsset: 'collector-pack-nft',
    mint: money.assets.solanaStablecoin.assetId,
    tokenAccount: binding.refundTokenAccount,
    destination: binding.executionWallet,
    validity: requireValidityEvidence(validity),
  });
}

export function buildBuybackAction({ cycleId, preflightDigest, custody, config, minimumReceive, nftMint, nftCustodyAccount, feePayer, validity }) {
  const money = requireMoneyConfiguration(config);
  const binding = configuredPackBinding(config, money);
  return buildProductionAction({
    actionKind: 'buyback',
    cycleId,
    preflightDigest,
    custody,
    binding,
    principalAmount: minimumReceive,
    minimumReceive,
    nativeGasAmount: money.solana.lamportReserve.amountAtomic,
    feePayer: feePayer ?? binding.executionWallet,
    sourceAccount: binding.executionWallet,
    inputAsset: nftMint,
    outputAsset: money.assets.solanaStablecoin.assetId,
    mint: money.assets.solanaStablecoin.assetId,
    tokenAccount: binding.refundTokenAccount,
    destination: binding.refundTokenAccount,
    nftMint,
    nftCustodyAccount: nftCustodyAccount ?? binding.executionWallet,
    validity: requireValidityEvidence(validity),
  });
}

export function buildReturnAction({ cycleId, preflightDigest, custody, config, principalAmount, feePayer, validity }) {
  const money = requireMoneyConfiguration(config);
  const binding = configuredPackBinding(config, money);
  return buildProductionAction({
    actionKind: 'return',
    cycleId,
    preflightDigest,
    custody,
    binding,
    principalAmount,
    minimumReceive: money.minimums.returnUsdg.amountAtomic,
    nativeGasAmount: money.solana.lamportReserve.amountAtomic,
    feePayer: feePayer ?? binding.executionWallet,
    sourceAccount: binding.refundTokenAccount,
    inputAsset: money.assets.solanaStablecoin.assetId,
    outputAsset: 'USDG',
    mint: money.assets.solanaStablecoin.assetId,
    tokenAccount: binding.refundTokenAccount,
    destination: custody.returnAccount,
    validity: requireValidityEvidence(validity),
  });
}
