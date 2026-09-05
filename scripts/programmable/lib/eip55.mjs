import { keccak256Hex } from './keccak.mjs';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function toEip55Address(value) {
  if (!ADDRESS.test(value ?? '')) throw new Error('value is not an EVM address');
  const lowercase = value.slice(2).toLowerCase();
  const hash = keccak256Hex(Buffer.from(lowercase, 'utf8')).slice(2);
  return `0x${[...lowercase].map((character, index) => {
    if (!/[a-f]/.test(character)) return character;
    return hash[index] >= '8' ? character.toUpperCase() : character;
  }).join('')}`;
}

export function isEip55Address(value) {
  return ADDRESS.test(value ?? '') && value === toEip55Address(value);
}

export function requireEip55Address(value, label = 'value') {
  if (!isEip55Address(value)) throw new Error(`${label} must use EIP-55 checksum casing`);
  return value;
}

export function requireEip55Addresses(value, label = 'value') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => requireEip55Addresses(entry, `${label}[${index}]`));
    return value;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) requireEip55Addresses(entry, `${label}.${key}`);
    return value;
  }
  if (typeof value === 'string' && ADDRESS.test(value)) requireEip55Address(value, label);
  return value;
}
