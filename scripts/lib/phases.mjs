export const PHASES = [
  'init', 'spec', 'architecture', 'feasibility', 'redteam', 'tasks', 'build', 'ship',
];

export const PHASE_SET = new Set(PHASES);

export function assertFrameworkPhase(phase, label = 'phase') {
  if (!PHASE_SET.has(phase)) throw new Error(`invalid ${label} ${String(phase)}`);
  return phase;
}
