"""Generate a review patch only; never write active architecture files."""
import copy
import difflib
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

OUT = Path(__file__).resolve().parent
BASE = '56f185e07dfafe5533df617ec1dad473ecb63f68'
PROPOSAL = '31b7935514ebf85da805677128e2555eecc7fef5'
REQUIREMENTS_HASH = '750a12abf47a771d1181dd6a1782c1b6fbcc4eebb4632e5d1927bf52f4193425'

def git(*args):
    return subprocess.check_output(['git', '--no-replace-objects', *args]).decode()

def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()

def replace(text, old, new):
    assert text.count(old) == 1, old
    return text.replace(old, new, 1)

def literal(value):
    return json.dumps(value, ensure_ascii=False)

proposal = json.loads(git('show', PROPOSAL + ':decisions/native-eth-interface/proposal.json'))
assert proposal['proposedRequirementsSha256'] == REQUIREMENTS_HASH
source = git('show', BASE + ':architecture/interfaces.json')
original = json.loads(source)
text = source
# Exact textual edits preserve the entire unrelated Collector subtree and formatting.
for old, new in [
 ('"requirementsRevision": 67', '"requirementsRevision": 71'),
 ('"source": "Approved Phase 3 plan sections 4, 6, 9, and 11"', '"source": "Native revision 71 proposal 31b79355 applied to PR39 56f185e; pending coordinator integration and feasibility freeze"'),
 ('ONE_HOOK_ONE_POOL_ID_ONE_USDG_LIABILITY_DOMAIN', 'ONE_HOOK_ONE_POOL_ID_ONE_NATIVE_ETH_LIABILITY_DOMAIN'),
 ('GROSS_USDG_QUOTE_VOLUME', 'GROSS_NATIVE_ETH_QUOTE_VOLUME'),
 ('"supportedCombinations": 8', '"supportedCombinations": 4'),
 ('"minimumGrossAtomicUsdg": "1000"', '"minimumGrossWei": "1000"'),
 ('uint256 amountAtomicUsdg', 'uint256 amountWei'),
 ('"entryBound": "N"', '"entryBound": 64'),
 ('"xmax": {"chainId": 4663, "assetId": "USDG", "decimals": 6, "amountAtomic": "500000000000"}', '"xmax": {"unit": "wei", "constructorField": "processClaimLimitMaxWei", "value": null, "status": "REQUIRED_EXPLICIT_LAUNCH_INPUT", "valuationCeilingMicroUsd": "500000000000", "rule": "positive integer derived conservatively from the approved launch valuation; never use the USD ceiling as wei"}'),
 ('"steps": ["Permit2 pull at most 240000000 atomic USDG", "PositionManager mint full HKMN allocation to custody", "return unused USDG to payer"]', '"steps": ["payable seed: msg.value equals amount0Max", "approve HKMN only; read slot0 immediately before mint; compute exact native and HKMN debts with pinned TickMath/SqrtPriceMath rounding", "bound both debts; send only nativeDebt into PositionManager MINT_POSITION plus SETTLE_PAIR", "verify full-range position ownership/key/liquidity in permanent custody", "refund msg.value minus nativeDebt to payer; clear HKMN Permit2/ERC20 allowances"]'),
 ('"evmUsdg": {"chainId": 4663, "assetId": "USDG", "decimals": 6}', '"evmNative": {"chainId": "4663", "assetId": "native", "decimals": 18}'),
 ('"productionReturnMinimum": {"chainId": 4663, "assetId": "USDG", "decimals": 6, "amountAtomic": "0"}', '"productionReturnMinimum": {"chainId": "4663", "assetId": "native", "decimals": 18, "amountAtomic": "0"}'),
 ('"schema": "hookemon.relay-leg.v1"', '"schema": "hookemon.relay-leg.v2"'),
 ('exactly one RelayLegV1', 'exactly one RelayLegV2'),
 ('"settlement": "SETTLED only after this process observes both finalized chain deltas through its own RPC clients and attributes the destination delta by matching amount, time window, and memo or relayRequestId; Relay status alone never settles a leg"', '"settlement": "SETTLED only after independently authenticated source and destination finality with exact persisted request/leg attribution; native destination requires native-payment-proof.v1 and no ending balance delta or synthetic Transfer event; Solana evidence remains unchanged; Relay status alone never settles a leg"'),
 ('"schema": "hookemon.custody-ledger.v2"', '"schema": "hookemon.custody-ledger.v3"'),
 ('"scope": ' + literal(original['cycleExecution']['custodyLedger']['scope']), '"scope": "Selected native ETH canonical row only; preserve historical ERC20 readers and the separate Solana evidence boundary"'),
 ('"verifiedCurrentBalance": ' + literal(original['cycleExecution']['custodyLedger']['verifiedCurrentBalance']), '"verifiedCurrentBalance": "CustodyBalanceObservationV1 | null; native identity requires an independent public/archive/public-recheck finalized native balance producer; null only on first-ever write; no observation erasure or schema downgrade"'),
 ('"admissionRule": ' + literal(original['cycleExecution']['custodyLedger']['admissionRule']), '"admissionRule": "Missing native observation with unresolved claim or current custody marks exposure unvalued; separately authenticate USD valuation for additional liquid exposure; reconcile reservations so principal is counted once"'),
 ('"source": "decisions/ADR-0026-custody-ledger-v2-migration.md"', '"historicalSource": "decisions/ADR-0026-custody-ledger-v2-migration.md"'),
 ('"sourceDigest": "sha256:1157569815b5da153388ab6431a19a09eedeeefbf39cda494a67e636bdf23ef5"', '"historicalSourceDigest": "sha256:1157569815b5da153388ab6431a19a09eedeeefbf39cda494a67e636bdf23ef5"'),
 ('"model": "direct-per-holder-usdg-transfer"', '"model": "direct-per-holder-native-ETH-value-transfer"'),
 ('"frozenRecipient": "quarantine-liability"', '"rejectingRecipient": "quarantine-liability-without-blocking-other-recipients"'),
 ('"finality": "exact-finalized-recipient-delta"', '"finality": "producer-authenticated exact native-payment-proof.v1 bound to persisted signed transaction; no ending recipient balance delta"'),
 ('"frozenRecipient": "quarantine the liability without blocking the rest of the manifest"', '"rejectingRecipient": "failed payment quarantines the unpaid liability; no success credit or automatic resend; other recipients continue"'),
 ('"USDG-decimals-pause-freeze"', '"native-ETH-identity-and-finalized-payment-producer"'),
]:
    text = replace(text, old, new)
text = replace(text, '"architectureRevision": 10', '"architectureRevision": 11')
text = replace(text, '"held": "HELD_* is fail-closed, alarmed, never-auto-sold, and blocks-new-claims-in-v1"', '"held": "Pending epic decisions do not independently refuse claims; refuse only at the unchanged held count/cost limits or unresolved custody/valuation boundaries. Never auto-sell held cards."')
text = replace(text, '"return": "finalized-cycle-attributed-delta-only"', '"return": "finalized-cycle-attributed-native-payment-proof-only; preserve separate Solana proceeds evidence"')
text = replace(text, '"states": ["PREPARED", "SIGNED", "BROADCAST", "FINALIZED"],', '"states": ["PREPARED", "SIGNED", "BROADCAST", "FINALIZED", "REFUSED"],')
# Rename module record references only; do not touch transactionPolicy itself.
for old, new in [('RelayLegV1', 'RelayLegV2'), ('CustodyLedgerV2', 'CustodyLedgerV3'), ('MoneyConfigurationV1', 'MoneyConfigurationV2'), ('quarantineFrozenRecipient', 'quarantineRejectingRecipient')]:
    start = text.index('  "moduleInterfaces":')
    text = text[:start] + text[start:].replace(old, new)

versions = {
 'money-configuration': 2, 'operator-configuration': 4, 'policy-admission': 3,
 'policy-cycle': 5, 'process-liability-evidence': 2, 'custody-ledger': 3,
 'claim-process-request': 2, 'outbound-relay-request': 2, 'return-relay-request': 2,
 'relay-intent': 2, 'relay-leg': 2, 'return-leg-destination-proof': 2,
 'direct-payout-request': 2, 'direct-payout-state': 2, 'direct-payout-result': 2,
 'native-payment-proof': 1, 'quote-usd-valuation': 1,
}
native = {
 'status': 'PROPOSED_PENDING_COORDINATOR_INTEGRATION',
 'requirementsRevision': 71, 'requirementsSha256': REQUIREMENTS_HASH,
 'proposalCommit': git('rev-parse', PROPOSAL).strip(), 'historicalBaselineCommit': BASE,
 'launchEligible': False,
 'selectedToken': 'packages/contracts/src/launch/HKMNToken.sol',
 'quoteCurrency': {'wireAddress': '0x0000000000000000000000000000000000000000', 'currencyIndex': 0, 'assetId': 'native', 'decimals': 18},
 'currency1': 'HKMN; reversed ordering and non-native quote configurations revert',
 'feeCases': ['ETH-input-exact-input', 'ETH-input-exact-output', 'ETH-output-exact-input', 'ETH-output-exact-output'],
 'feeAccounting': {'minimumGrossWei': '1000', 'belowMinimum': '999 reverts; 1000 succeeds', 'basisPoints': [10, 40, 250], 'rounding': 'independent lifetime cumulative numerator/remainder per stream; never per-trade ceil or reset on claims', 'conservation': 'funded wei conservation and cumulative numerator arithmetic are separate unit-correct invariants'},
 'claimCeilings': {'processClaimLimit6hWei': None, 'processClaimLimitMaxWei': None, 'status': 'EXPLICIT_POSITIVE_INTEGER_LAUNCH_INPUTS_REQUIRED', 'initialAtMostMaximum': True, 'maximumValuationCeilingMicroUsd': '500000000000'},
 'claimProof': 'ProcessClaimed is emitted only after successful native value payment; bind trusted hook runtime, cycle, decoded values and log index; reject balance-growth assumptions',
 'seed': {'payable': True, 'selectorTupleUnchanged': True, 'nativeMaximum': 'msg.value == amount0Max', 'refundWei': 'msg.value - exactNativeDebt', 'refundRecipient': 'payer, which may differ from launchAuthority', 'rejectingPayer': 'revert entire seed-local transaction', 'forbidden': ['SWEEP', 'aggregate-balance refund', 'zero PositionManager balance assumption'], 'debtSources': {'v4-core': '46c6834698c48bc4a463a86d8420f4eb1d7f3b75', 'v4-periphery': 'dce236d4e2057422d0791d9a973a58765eb46f65'}},
 'schemas': {key: f'hookemon.{key}.v{version}' for key, version in versions.items()},
 'history': 'Keep old readers; native execution rejects USDG fields, old money versions and old digests; no automatic journal/signature/receipt migration. Final nested wrapper inventory belongs to bot integration.',
 'configuration': {'assets.usdg': 'assets.eth', 'minimums.returnUsdg': 'minimums.returnEth', 'minimums.robinhoodReceive': 'retain key with native TypedAmount', 'operatorControls': 'MicroUsdg suffix becomes MicroUsd; preserve 55/165/495 USD outer rails and tighter owner caps', 'releaseAmountWei': 'native principal integer string', 'releaseCostMicroUsd': 'independently authenticated commitment cost; never reuse the principal scalar as USD'},
 'usdControls': {'unit': 'integer-string micro-USD; not a transferable asset; no USDC/USD parity assumption', 'heldCostBasis': 'attributed purchase cost only; no insured value, quote, or market-value substitute', 'maxHeldCount': 10, 'maxHeldValueMicroUsd': '5000000000', 'valuation': 'exact fetched quote amountUsd bound to request/quote digest, chain/currency/atomic amount and expiry; costs up, proceeds down; freeze cost basis at commitment', 'missingValuation': 'refuse new risk; allow observation and authorized recovery'},
 'custody': {'expectedCycleAsset': 'singular TypedAmount or null; preserve once-only obligations', 'gasReserve': 'separate native TypedAmount', 'gasSpent': 'separate native TypedAmount; never claimed principal, proceeds or entitlement'},
 'nativePaymentProof': {'producer': 'adapter-only authenticated RPC/release evidence; reauthenticate persisted proof after restart', 'kinds': ['direct', 'hook-claim', 'relay-return', 'relay-refund'], 'required': ['chainId', 'assetId', 'decimals', 'transactionHash', 'transactionDigest', 'blockNumber', 'blockHash', 'source', 'recipient', 'amountWei', 'calldataDigest', 'receiptStatus', 'evidenceDigest'], 'direct': 'persisted signed bytes/hash and sender nonce', 'relay': 'exact request/order metadata, source finality, emitter runtime at finalized payment checkpoint, log index, recipient/value and successful inner payment; unique positive attribution; provider status alone is insufficient', 'notAdmitted': ['ending balance delta', 'synthetic Transfer', 'SolverNativeTransfer alone', 'cleanupNativeViaCall by analogy']},
 'legacyFamily': 'Frozen and excluded; preserve shared FeeAccounting ERC20 transfer seam and historical embedded HKMNToken; no WETH fallback',
}
text = text.rstrip()[:-1] + ',\n  "nativeMigration": ' + json.dumps(native, indent=2).replace('\n', '\n  ') + '\n}\n'
# Attach the comma to the preceding root member without introducing formatting churn.
text = text.replace('\n,\n  "nativeMigration"', ',\n  "nativeMigration"')
result = json.loads(text)
assert result['transactionPolicy'] == original['transactionPolicy']
raw_collector = source[source.index('  "transactionPolicy":'):source.index('  "eligibilitySnapshot":')]
assert raw_collector in text
assert result['feeContract']['streams'] == original['feeContract']['streams']
assert result['freezeRules'] == original['freezeRules']
assert result['phaseBoundary'] == original['phaseBoundary']
assert result['launch']['positionCustody'] == original['launch']['positionCustody']
assert result['cycleExecution']['purchaseRequest'] == original['cycleExecution']['purchaseRequest']
assert result['cycleExecution']['custodyLedger']['nonEvmEvidenceConstructionContract'] == original['cycleExecution']['custodyLedger']['nonEvmEvidenceConstructionContract']

path2 = 'architecture/provisional-interfaces.json'
provisional = git('show', BASE + ':' + path2)
ptext = replace(provisional, '"requirementsRevision": 65', '"requirementsRevision": 71')
for old, new in [('RelayLegV1', 'RelayLegV2'), ('CustodyLedgerV2', 'CustodyLedgerV3'), ('MoneyConfigurationV1', 'MoneyConfigurationV2'), ('quarantineFrozenRecipient', 'quarantineRejectingRecipient'), ('chain-4663 USDG', 'chain-4663 native ETH')]:
    ptext = ptext.replace(old, new)
ptext = replace(ptext, 'The initial process-claim limit X remains a launch input; Xmax, processClaimMaxCount, and the emergency rotation delay are fixed by revision 65.', 'Positive processClaimLimit6hWei and processClaimLimitMaxWei are explicit launch inputs bound to current valuation and the existing USD ceiling; count cap 64 and rotation delay 43200 seconds remain fixed.')
ptext = replace(ptext, 'The live recipient-count and gas envelope must be measured before a claim is allowed.', 'The live recipient-count and gas envelope must be measured before claim; producer-authenticated native payment proof is required and rejecting-recipient liabilities are quarantined.')
ptext = replace(ptext, 'The adapter must persist reconciliation evidence proving the insured-value unit against the machine instantBuyback percentage; absent or contradictory evidence enters HELD_DATA_UNVERIFIED.', 'Preserve insured-value evidence for the existing epic decision only; held exposure uses attributed purchase costMicroUsd, never insured or market value. Missing unit/valuation evidence refuses new risk and permits observation/recovery.')
assert json.loads(ptext)['status'] == 'PROVISIONAL'
patch = ''.join(difflib.unified_diff(source.splitlines(True), text.splitlines(True), 'a/architecture/interfaces.json', 'b/architecture/interfaces.json'))
patch += ''.join(difflib.unified_diff(provisional.splitlines(True), ptext.splitlines(True), 'a/' + path2, 'b/' + path2))
(OUT / 'native-machine-interfaces.patch').write_text(patch)
verification = {'schema': 'hookemon.native-machine-interface-verification.v1', 'baseCommit': BASE, 'proposalCommit': native['proposalCommit'], 'requirementsSha256': REQUIREMENTS_HASH, 'patchSha256': sha(patch), 'checks': {'collectorSubtreeByteIdentical': True, 'collectorSubtreeSha256': sha(raw_collector), 'feeStreamsPreserved': True, 'legacyFreezeAndPhaseBoundaryPreserved': True, 'permanentCustodyPreserved': True, 'solanaPurchaseAndObservationPreserved': True, 'nativeFeeCombinations': result['feeContract']['supportedCombinations'], 'minimumGrossWei': result['feeContract']['minimumGrossWei'], 'explicitCeilingsRemainUnset': all(value is None for key, value in native['claimCeilings'].items() if key.endswith('Wei')), 'launchEligible': False}, 'outputs': {'architecture/interfaces.json': sha(text), path2: sha(ptext)}}
with tempfile.TemporaryDirectory(prefix='hookemon-machine-patch-') as directory:
    root = Path(directory)
    (root / 'architecture').mkdir()
    (root / 'architecture/interfaces.json').write_text(source)
    (root / path2).write_text(provisional)
    subprocess.run(['git', 'apply', '--check', str(OUT / 'native-machine-interfaces.patch')], cwd=root, check=True)
    subprocess.run(['git', 'apply', str(OUT / 'native-machine-interfaces.patch')], cwd=root, check=True)
    for path, digest in verification['outputs'].items():
        assert sha((root / path).read_text()) == digest
verification['checks']['patchAppliesToExactBaseline'] = True
(OUT / 'verification.json').write_text(json.dumps(verification, indent=2) + '\n')
print(json.dumps(verification['checks']))
