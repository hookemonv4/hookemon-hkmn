// The dashboard is a transport boundary over the single operator authority. It never edits policy
// state directly and never starts recovery on its own: a validated command becomes exactly one
// `operatorControl.execute` call, where the runner owns durable state and effect guards.
export class OperatorControlUnavailable extends Error {
  constructor() {
    super('operator control authority is unavailable');
    this.code = 'OPERATOR_CONTROL_UNAVAILABLE';
  }
}

export async function applyDecision({ requestId = undefined, expectedVersion, command, operatorControl }) {
  if (!operatorControl || typeof operatorControl.execute !== 'function') throw new OperatorControlUnavailable();
  const input = { expectedRevision: expectedVersion, command };
  if (requestId !== undefined) input.requestId = requestId;
  return operatorControl.execute(input);
}
