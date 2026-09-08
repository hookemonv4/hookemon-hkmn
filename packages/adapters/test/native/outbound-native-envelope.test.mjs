import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractRelayEvmTransactions } from '../../src/app/stages/outbound.mjs';
const raw = JSON.parse(readFileSync(new URL('./relay-outbound-captured.json', import.meta.url)));
function input() { return { steps: structuredClone(raw.steps), requestId: raw.requestId, operationsAccount: raw.details.sender,
  depository: raw.steps[0].items[0].data.to, amountAtomic: raw.details.currencyIn.amount, orderId: raw.protocol.v2.orderId }; }
test('native outbound admits exactly the captured native value deposit with original request/order binding', () => {
  const args = input(); const before = JSON.stringify(args.steps);
  const plans = extractRelayEvmTransactions(args);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].transaction.value, '10243579001330370');
  assert.equal(plans[0].transaction.data.slice(0, 10), '0x49290c1c');
  assert.equal(JSON.stringify(args.steps), before);
});
test('native outbound refuses extra approval, wrong payer, amount, target, order and missing request binding', () => {
  for (const mutate of [x => x.steps[0].items.push(structuredClone(x.steps[0].items[0])),
    x => { x.steps[0].items[0].data.value = '1'; }, x => { x.steps[0].items[0].data.to = raw.details.sender; },
    x => { x.steps[0].items[0].data.from = x.depository; }, x => { x.orderId = `0x${'ff'.repeat(32)}`; },
    x => { x.steps[0].items[0].data.data = '0x095ea7b3'; }, x => { delete x.steps[0].items[0].check; delete x.steps[0].requestId; }]) {
    const args = input(); mutate(args); assert.throws(() => extractRelayEvmTransactions(args));
  }
});
