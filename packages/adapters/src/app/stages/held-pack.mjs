function durablePackId(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function addDurableIdentity(candidates, value, source) {
  const packId = durablePackId(value);
  if (packId !== null) candidates.push({ packId, source });
}

function assertNoDurableDisagreement(candidates, memo) {
  const identities = new Set(candidates.map(candidate => candidate.packId));
  if (identities.size > 1) {
    throw new Error(`held card attribution found conflicting durable pack identities for memo ${memo}`);
  }
}

/**
 * Resolves the immutable pack identity that produced a held card.
 *
 * Plan admissions bind each memo to its per-order request. Legacy admissions use the persisted
 * batch response and admission-level pack id. Configuration is retained only for old journals
 * that have neither durable source.
 */
export async function heldPackIdForMemo({ cycleRepository, cycleId, memo, config }) {
  const candidates = [];
  const cycle = typeof cycleRepository?.describeCycle === 'function'
    ? await cycleRepository.describeCycle(cycleId)
    : null;
  const admission = cycle?.admission ?? null;

  if (admission?.schema === 'hookemon.policy-admission.v4') {
    const orders = Array.isArray(admission.orders) ? admission.orders : [];
    if (typeof cycleRepository?.readPackOrderRequest === 'function') {
      for (const order of orders) {
        const request = await cycleRepository.readPackOrderRequest(cycleId, order.orderIndex);
        const matches = Array.isArray(request?.packs)
          ? request.packs.filter(pack => pack?.memo === memo)
          : [];
        if (matches.length > 1) {
          throw new Error(`held card attribution found multiple durable pack records for memo ${memo}`);
        }
        if (matches.length === 1) {
          const pack = matches[0];
          addDurableIdentity(candidates, pack.packType, `pack order ${order.orderIndex} request`);
          addDurableIdentity(candidates, order.packId, `admission order ${order.orderIndex}`);
          break;
        }
      }
    }
  } else if (typeof cycleRepository?.readPackBatchRequest === 'function') {
    const request = await cycleRepository.readPackBatchRequest(cycleId, 'purchase');
    const matches = Array.isArray(request?.packs)
      ? request.packs.filter(pack => pack?.memo === memo)
      : [];
    if (matches.length > 1) {
      throw new Error(`held card attribution found multiple durable pack records for memo ${memo}`);
    }
    if (matches.length === 1) {
      addDurableIdentity(candidates, matches[0].packType, 'legacy purchase batch request');
    }
  }

  if (admission?.schema === 'hookemon.policy-admission.v3') {
    addDurableIdentity(candidates, admission?.packId, 'legacy admission');
  }

  assertNoDurableDisagreement(candidates, memo);
  if (candidates.length > 0) return candidates[0].packId;

  const configured = durablePackId(config?.pack?.code);
  if (configured !== null) return configured;
  throw new Error(`held card attribution requires a durable pack identity for memo ${memo}`);
}

export async function existingHeldPackOutcome({ cycleRepository, cycleId, memo, packIndex }) {
  if (typeof cycleRepository?.listHeldPositions !== 'function') return null;
  const positions = await cycleRepository.listHeldPositions({ cycleId, includeResolved: true });
  const position = (Array.isArray(positions) ? positions : []).find(candidate => candidate?.memo === memo) ?? null;
  if (position === null) return null;
  return {
    packIndex,
    memo,
    expectedCardCount: 1,
    mint: position.mint,
    decision: 'held',
    terminalState: position.terminalState,
    reason: position.reason,
    heldPosition: {
      positionId: position.positionId,
      evidenceDigest: position.evidenceDigest,
      terminalState: position.terminalState,
      reason: position.reason,
    },
  };
}
