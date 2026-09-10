import { digest } from '../../../../runner/src/cycle/journal.mjs';

export function requestDigest(context, request) {
  if (!context || typeof context.cycleId !== 'string' || typeof context.stage !== 'string') {
    throw new Error('stage-driver context must include cycleId and stage');
  }
  return digest({
    schema: 'hookemon.operational-stage-request.v1',
    cycleId: context.cycleId,
    stage: context.stage,
    request,
  });
}
