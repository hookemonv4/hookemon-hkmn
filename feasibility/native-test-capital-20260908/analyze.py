#!/usr/bin/env python3
"""Offline scenario arithmetic only; no production budget policy or execution authority."""
from pathlib import Path
from decimal import Decimal
import json,hashlib
P=Path(__file__).resolve().parent
load=lambda n:json.loads((P/n).read_text())
ceil=lambda n,d:(n+d-1)//d
micro=lambda s:int(Decimal(s)*1000000)
q=load('relay-outbound-response.json');r=load('relay-return-scenario-response.json')
source=json.loads((P.parent/'native-funding/results.json').read_text());s=next(x for x in source['scenarios'] if x['swapCount']=='32')
principal=int(q['details']['currencyIn']['amount']); quoted_usd=micro(q['details']['currencyIn']['amountUsd'])
def usd(wei):return ceil(wei*quoted_usd,principal)
def downusd(wei):return wei*quoted_usd//principal
solPriceNum=micro(r['fees']['gas']['amountUsd']); solPriceDen=int(r['fees']['gas']['amount'])
solUsd=lambda lamports:ceil(lamports*solPriceNum,solPriceDen)
gasprice=int(next(a['result'] for a in load('evm-network-response.json') if a['id']==3),16)
sol={a['id']:a['result'] for a in load('solana-balances-response.json')}
network={a['id']:a['result'] for a in load('evm-network-response.json')}
wallets={a['id']:int(a['result'],16) for a in load('evm-wallets-response.json')}
assert int(network[1],16)==4663
assert all(v==0 for v in wallets.values()) and not sol[2]['value']
assert q['details']['currencyIn']['currency']['decimals']==18 and q['details']['currencyIn']['currency']['address']=='0x'+'0'*40
assert q['details']['currencyOut']['currency']['decimals']==6 and q['details']['currencyOut']['currency']['address']=='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
minimumGross=ceil(principal*10000,250)
fees={k:minimumGross*bps//10000 for k,bps in [('process',250),('treasury',40),('programmable',10)]}
assert minimumGross*250//10000>=principal and (minimumGross-1)*250//10000<principal
assert int(q['details']['currencyOut']['amount'])==25000000
assert int(s['earnedProcessWei'])>=principal
assert int(s['seedRefundWei'])+int(s['poolRemainingWei'])+int(s['traderRemainingWei'])+int(s['feeLiabilitiesWei'])==int(s['initialCapitalWei'])
assert int(q['fees']['relayer']['amount'])==int(q['fees']['relayerGas']['amount'])+int(q['fees']['relayerService']['amount'])
assert int(r['fees']['relayer']['amount'])==int(r['fees']['relayerGas']['amount'])+int(r['fees']['relayerService']['amount'])
stages={k:int(s[k]) for k in ['tokenDeploymentGasLocal','hookDeploymentGasLocal','custodyDeploymentGasLocal','graphWiringGasLocal','seedGasLocal','swapExecutionGasLocal','claimGasLocal']}
measuredGas=sum(stages.values());swapIntrinsic=int(s['swapCount'])*21000
outTx=q['steps'][0]['items'][0]['data'];outQuotedMax=int(outTx['gas'])*int(outTx['maxFeePerGas'])
baseCapital=int(s['initialCapitalWei']);baselineUsd=usd(baseCapital)
# These reservations are illustrative measured-term pricing, not an all-in cost bound.
measuredGasWei=measuredGas*gasprice; intrinsicWei=swapIntrinsic*gasprice
selectedSolFootprint=sol[1]['value'];conditionalTerms=baselineUsd+usd(measuredGasWei+intrinsicWei+outQuotedMax)+solUsd(selectedSolFootprint)
public=[a for a in load('collector-catalog.json') if a.get('public') and not a.get('archived')]; statuses={a['code']:a for a in load('collector-status.json')['gachas']};opened=[a for a in public if statuses.get(a['code'],{}).get('isOpen') and a.get('contains')==1]; cheapest=min(opened,key=lambda a:a['price']['amount']);assert cheapest['code']=='pokemon_25' and cheapest['price']['amount']==25
result={'schema':'hookemon.native-test-capital-evidence.v1','allInBudgetProven':False,'scope':'Captured scenario arithmetic; no selected funding plan or current valuation authority','budgetMicroUsd':'250000000','sourceFundingResultsSha256':hashlib.sha256((P.parent/'native-funding/results.json').read_bytes()).hexdigest(),'catalog':{'lowestOpenPublicSingleCardCode':cheapest['code'],'priceUsdcAtoms':'25000000','catalogPrice':cheapest['price'],'publicUnarchivedCount':len(public),'openSingleCardCount':len(opened)},'valuation':{'nativeSource':'relay-outbound-response.json details.currencyIn','nativeInputWei':str(principal),'nativeInputMicroUsd':str(quoted_usd),'impliedUsdPerEthNumerator':str(quoted_usd*10**12),'impliedUsdPerEthDenominator':str(principal),'usdc25DisplayedMicroUsd':str(micro(q['details']['currencyOut']['amountUsd'])),'solSource':'relay-return-scenario-response.json fees.gas (provider estimate ratio only)','solLamports':str(solPriceDen),'solMicroUsd':str(solPriceNum),'executionValidity':'not established; no configured quoteValidityMs or authenticated process capability; protocol order deadlines are not quote TTL'},'backwards':{'newProcessPrincipalWei':str(principal),'minimumGrossWei':str(minimumGross),'minimumFeesWei':{k:str(v) for k,v in fees.items()},'minimumTotalFeeDiversionWei':str(sum(fees.values())),'measuredGrossWei':s['grossExecutedWei'],'measuredProcessWei':s['earnedProcessWei'],'measuredProcessHeadroomWei':str(int(s['earnedProcessWei'])-principal),'historicalClaimOverNewQuoteWei':str(int(s['historicalBridgePrincipalClaimedWei'])-principal),'modelFreshClaimExecuted':False},'capital':{'initialWei':str(baseCapital),'initialMicroUsdCeil':str(baselineUsd),'lockedSeedWei':s['seedLockedWei'],'lockedSeedMicroUsdCeil':str(usd(int(s['seedLockedWei']))),'reusableFloatWei':s['initialTradingFloatWei'],'reusableFloatMicroUsdCeil':str(usd(int(s['initialTradingFloatWei']))),'grossTurnoverIsNotFreshCapital':True,'measuredFeeDiversionWei':s['feeLiabilitiesWei'],'feeDiversionInsideInitialCapital':True,'packPrincipalInsideInitialCapital':True,'minimumTraderAfterBuyWei':s['minimumAfterBuyWei'],'headroomBeforeAdditionalCostsMicroUsd':str(250000000-baselineUsd)},'gasSensitivity':{'observedGasPriceWei':str(gasprice),'localExecutionGasByStage':stages,'localExecutionGasTotal':str(measuredGas),'localExecutionFeeAtSnapshotWei':str(measuredGasWei),'localExecutionFeeAtSnapshotMicroUsdCeil':str(usd(measuredGasWei)),'swapIntrinsicOnlyGas':str(swapIntrinsic),'swapIntrinsicOnlyFeeWei':str(intrinsicWei),'swapIntrinsicOnlyFeeMicroUsdCeil':str(usd(intrinsicWei)),'outboundProviderGas':outTx['gas'],'outboundProviderMaxFeePerGas':outTx['maxFeePerGas'],'outboundProviderMaxFeeProductWei':str(outQuotedMax),'outboundProviderMaxFeeProductMicroUsdCeil':str(usd(outQuotedMax)),'notCompleteTransactionGas':True},'balances':{'evmBlockNumber':str(int(network[2]['number'],16)),'evmBlockHash':network[2]['hash'],'launchWei':'0','launchNonce':'0','operationsWei':'0','operationsNonce':'0','solanaLamports':str(selectedSolFootprint),'solanaSlot':sol[1]['context']['slot'],'solanaUsdcTokenAccountCount':len(sol[2]['value']),'solanaUsdcAtoms':'0','rentFor165BytesLamports':str(sol[3]),'observedSolFootprintScenarioMicroUsdCeil':str(solUsd(selectedSolFootprint)),'existingSolOriginalAcquisitionCostMicroUsd':None},'returnScenario':{'inputUsdcAtoms':r['details']['currencyIn']['amount'],'quotedOutputWei':r['details']['currencyOut']['amount'],'minimumOutputWei':r['details']['currencyOut']['minimumAmount'],'gasEstimateLamports':r['fees']['gas']['amount'],'relayerFeeUsdcAtoms':r['fees']['relayer']['amount'],'actualFutureBuybackUsdcAtoms':None,'incomeCreditedToBudget':'0'},'conditionalSubtotal':{'description':'Initial0.06ETH + local execution-gas pricing + swap intrinsic floor + outbound quoted max-fee product + entire existingSOL mark; NOT full bound. No double-counted pack/provider-fee principal.','microUsdCeil':str(conditionalTerms),'unmeasuredRemainingAllowanceMicroUsd':str(250000000-conditionalTerms),'unknownAdditionalCostMicroUsd':None,'passesBudget':False}}
(P/'calculation.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
