import { createPrivateKey, sign } from 'node:crypto';

import { fixtureCycleEscrowObservationDigest } from '../../src/operator/cycle-escrow-observation.mjs';

const cycleEscrowObservationPrivateKey = createPrivateKey({
  key: Buffer.from('302e020100300506032b657004220420f75053261c9eca22d26e4323f3993f50d1456dee1daef9051ae13a3f33f24422', 'hex'),
  format: 'der',
  type: 'pkcs8',
});

export function signFixtureCycleEscrowObservationDigest(digest) {
  return sign(null, Buffer.from(digest, 'utf8'), cycleEscrowObservationPrivateKey).toString('base64url');
}

export function signFixtureCycleEscrowObservation(value) {
  const withDigest = { ...value, verificationDigest: fixtureCycleEscrowObservationDigest(value) };
  return {
    ...withDigest,
    verificationSignature: signFixtureCycleEscrowObservationDigest(withDigest.verificationDigest),
  };
}
