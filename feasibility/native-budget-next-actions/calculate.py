import json, pathlib, hashlib
root=pathlib.Path(__file__).resolve().parents[2]
out=root/'feasibility/native-budget-next-actions'
capital=json.loads((root/'feasibility/native-test-capital-20260908/calculation.json').read_text())
gas=json.loads((root/'feasibility/native-preflight-candidate-20260908/gas-inventory.json').read_text())
price=capital['valuation'];wei=int(price['nativeInputWei']);usd=int(price['nativeInputMicroUsd'])
def mark(value): return (value*usd+wei-1)//wei
newgas=int(gas['combinedMeasuredGasScenario']);gasprice=int(capital['gasSensitivity']['observedGasPriceWei'])
newfee=mark(newgas*gasprice)
old=capital['conditionalSubtotal'];subtotal=int(old['microUsdCeil'])-int(capital['gasSensitivity']['localExecutionFeeAtSnapshotMicroUsdCeil'])+newfee
result={'status':'CONDITIONAL_NOT_APPROVED','allInBudgetProven':False,'budgetMicroUsd':'250000000','baseCapitalWei':'60000000000000000','replacementMeasuredGas':str(newgas),'gasPriceSnapshotWei':str(gasprice),'replacementGasCostWei':str(newgas*gasprice),'replacementGasCostAtOldMarkMicroUsdCeil':str(newfee),'conditionalSubtotalMicroUsd':str(subtotal),'unmeasuredAllowanceMicroUsd':str(250000000-subtotal),'incomeCreditMicroUsd':'0','doubleCountingRules':['Replace local deployment/wiring with archive route gas; do not add route to old total.','Fee diversion and outbound pack principal are already within initial ETH capital.','0.415ETH cumulative turnover is recycled .02ETH float, not additional funding.','Existing SOL marked footprint is counted once; actual acquisition cost remains unknown.','No future buyback proceeds are credited.'],'snapshotLimit':'Gas price and Relay valuation are retained historical observations. Archive route gas is measured against its pinned fixture, not a transaction estimate for proposed future addresses.','inputs':{str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [root/'feasibility/native-test-capital-20260908/calculation.json',root/'feasibility/native-preflight-candidate-20260908/gas-inventory.json']}}
(out/'conditional-calculation.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'conditionalSubtotalMicroUsd':str(subtotal),'unmeasuredAllowanceMicroUsd':str(250000000-subtotal),'passes':False}))

# Refresh only market inputs from the retained 12:14 UTC quote/RPC observations.
# Measurement rows stay tied to their original synthetic execution, not future addresses.
from decimal import Decimal
read=lambda name:json.loads((out/name).read_text())
quote=read('relay-outbound-response.json');returned=read('relay-return-scenario-response.json')
for name,record in read('observations.json').items():
 assert hashlib.sha256((out/(name+'-response.json')).read_bytes()).hexdigest()==record['sha256']
for record in read('solana-measurement-sources.json'):
 assert hashlib.sha256((out/(record['name']+'-response.json')).read_bytes()).hexdigest()==record['responseSha256']
micro=lambda v:int(Decimal(v)*1000000)
qwei=int(quote['details']['currencyIn']['amount']);qusd=micro(quote['details']['currencyIn']['amountUsd'])
ceil=lambda n,d:(n+d-1)//d
mark=lambda v:ceil(v*qusd,qwei)
network={r['id']:r['result'] for r in read('evm-network-response.json')}
assert int(network[1],16)==4663
currentGasPrice=int(network[3],16)
item=quote['steps'][0]['items'][0]['data'];outboundGas=int(item['gas']);outboundMaxFee=int(item['maxFeePerGas'])
assert int(item['value'])==qwei and int(item['chainId'])==4663
solFee=read('solana-return-message-fee-response.json')['result'];rent=read('solana-token-account-rent-response.json')['result']
balance=read('solana-wallet-balance-response.json')['result']
solEstimate=returned['fees']['gas'];solNumerator=micro(solEstimate['amountUsd']);solDenominator=int(solEstimate['amount'])
solmark=lambda lamports:ceil(lamports*solNumerator,solDenominator)
accounts=read('solana-return-accounts-request.json')['params'][0]
accountResults=read('solana-return-accounts-response.json')['result']
missing=[key for key,value in zip(accounts,accountResults['value']) if value is None]
assert len(missing)==1 and missing[0]==returned['steps'][0]['items'][0]['data']['instructions'][0]['keys'][5]['pubkey']
# The 32 swaps have an intrinsic-only floor already counted historically. The model's separate
# seed and claim calls also omit their transaction intrinsic costs: include these two floors.
swapIntrinsic=int(gas['separateSwapIntrinsicLowerBound']);seedClaimIntrinsic=2*21000
rows={'initialEthCapital':mark(60000000000000000),'combinedMeasuredExecutionGas':mark(newgas*currentGasPrice),'swapIntrinsicFloor':mark(swapIntrinsic*currentGasPrice),'seedAndClaimIntrinsicFloor':mark(seedClaimIntrinsic*currentGasPrice),'outboundQuoteMaxFeeProduct':mark(outboundGas*outboundMaxFee),'entireExistingSolCapitalFootprint':solmark(balance['value'])}
updated=sum(rows.values())
result['historicalReproductionMicroUsd']=result['conditionalSubtotalMicroUsd']
result['refreshedSnapshot']={'sourceObservation':'2026-09-08T12:14:21Z retained quotes/RPC; later finalized Solana observations have individual timestamps','ethValuationNumeratorMicroUsd':str(qusd),'ethValuationDenominatorWei':str(qwei),'gasPriceWei':str(currentGasPrice),'rowsMicroUsdCeil':{k:str(v) for k,v in rows.items()},'conditionalSubtotalMicroUsd':str(updated),'unmeasuredAllowanceMicroUsd':str(250000000-updated),'allInBudgetProven':False,'incomeCreditMicroUsd':'0','gasFloorsAreNotUpperBounds':True}
result['providerFeeInventory']={'outboundGas':str(outboundGas),'outboundMaxFeePerGasWei':str(outboundMaxFee),'outboundMaxFeeProductWei':str(outboundGas*outboundMaxFee),'outboundProviderGasEstimateWei':quote['fees']['gas']['amount'],'outboundPrincipalWei':str(qwei),'outboundRelayerWei':quote['fees']['relayer']['amount'],'returnScenarioInputUsdcAtoms':returned['details']['currencyIn']['amount'],'returnScenarioGasEstimateLamports':str(solDenominator),'returnRelayerUsdcAtoms':returned['fees']['relayer']['amount'],'returnIncomeCreditMicroUsd':'0','rule':'Gas estimate and max-fee product are alternatives. Relayer gas/service are components of relayer total; relayer is inside quote principal. Return is a scenario, not buyback income.'}
result['solanaMeasured']={'messageFeeLamports':str(solFee['value']),'feeSlot':str(solFee['context']['slot']),'requiredSignatures':str(read('unsigned-return-message.json')['requiredSignatures']),'tokenAccountRentLamports':str(rent),'missingAccountAddresses':missing,'missingAccountCount':'1','existingWalletLamports':str(balance['value']),'existingWalletSlot':str(balance['context']['slot']),'messagePlusOneAccountRentLamports':str(solFee['value']+rent),'providerEstimatePlusOneAccountRentLamports':str(solDenominator+rent),'remainingExistingSolAfterProviderEstimateAndRentLamports':str(balance['value']-solDenominator-rent),'additionalSubtotalChargeMicroUsd':'0','rule':'Fee/rent spend down already counted SOL footprint; never add them again. getFeeForMessage is a fee observation, not simulation or transaction success. Account creation requires the actual selected path.'}
result['freshOutboundFit']={'measuredHistoricalProcessWei':capital['backwards']['measuredProcessWei'],'quotedPrincipalWei':str(qwei),'headroomWei':str(int(capital['backwards']['measuredProcessWei'])-qwei),'historicalClaimWei':str(int(capital['backwards']['newProcessPrincipalWei'])+int(capital['backwards']['historicalClaimOverNewQuoteWei'])),'historicalClaimShortfallWei':str(qwei-int(capital['backwards']['newProcessPrincipalWei'])-int(capital['backwards']['historicalClaimOverNewQuoteWei'])), 'requiredFreshFirstClaimWei':str(qwei), 'freshClaimFractionOfMeasuredProcess':str(Decimal(qwei)/Decimal(capital['backwards']['measuredProcessWei'])), 'proposedUnapprovedClaimLimitWei':'15000000000000000', 'headroomBelowProposedClaimLimitWei':str(15000000000000000-qwei), 'freshClaimFractionOfProposedLimit':str(Decimal(qwei)/Decimal(15000000000000000)),'rule':'Generated process capacity still covers this quote; the already measured historical claim amount does not. A fresh bounded claim/funding scenario must be measured, never assume historical claim pays a changed quote.'}
result['inputs'].update({str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in out.glob('*-response.json')})
(out/'conditional-calculation.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result['refreshedSnapshot'],indent=2));print(json.dumps(result['freshOutboundFit'],indent=2))
