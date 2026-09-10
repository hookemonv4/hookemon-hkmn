/**
 * @typedef {object} ExternalChange
 * @property {number} fromVersion
 * @property {number} toVersion
 */

export function reconcileConfigurationForm({
  form,
  baseSnapshot,
  freshState,
  freshSnapshot,
  formFromState,
  baseVersion,
  formSnapshot = null,
}) {
  if (formSnapshot === baseSnapshot || formSnapshot === freshSnapshot) {
    return {
      form: formFromState(freshState),
      baseVersion: freshState.version,
      externalChange: null,
    };
  }
  return {
    form,
    baseVersion,
    externalChange: freshSnapshot !== baseSnapshot
      ? { fromVersion: baseVersion, toVersion: freshState.version }
      : null,
  };
}

export function mergeAuditEntries(current, incoming) {
  const entries = new Map(current.map(entry => [entry.sequence, entry]));
  for (const entry of incoming) entries.set(entry.sequence, entry);
  return [...entries.values()].sort((left, right) => Number(right.sequence) - Number(left.sequence));
}

export function describeRevisionConflict({ expectedVersion, currentVersion }) {
  return `Revisionskonflikt: Befehl basierte auf Konfigurationsstand ${expectedVersion}, aktueller Stand ist ${currentVersion}. Bitte Änderungen prüfen und erneut senden.`;
}
