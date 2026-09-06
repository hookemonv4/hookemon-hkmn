/**
 * RFC 8785 JSON Canonicalization Scheme (JCS).
 *
 * JCS delegates primitive serialization to ECMAScript JSON serialization and
 * orders object property names by their UTF-16 code units. Values with lone
 * UTF-16 surrogates are rejected because RFC 8785 requires interoperable JSON.
 */

function fail(message, path) {
  throw new TypeError(`${message} at ${path}`);
}

function assertUnicodeScalarString(value, path) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) fail('JCS rejects a lone surrogate', path);
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) fail('JCS rejects a lone surrogate', path);
  }
}

function compareUtf16(left, right) {
  const commonLength = Math.min(left.length, right.length);
  for (let index = 0; index < commonLength; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function serialize(value, path) {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      assertUnicodeScalarString(value, path);
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) fail('JCS rejects a non-finite number', path);
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      fail(`JCS cannot serialize ${typeof value}`, path);
  }

  if (Array.isArray(value)) {
    const values = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) fail('JCS rejects a sparse array', `${path}/${index}`);
      values.push(serialize(value[index], `${path}/${index}`));
    }
    return `[${values.join(',')}]`;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail('JCS requires a plain object', path);
  }

  const keys = Object.keys(value);
  for (const key of keys) assertUnicodeScalarString(key, `${path}/${key}`);
  keys.sort(compareUtf16);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(value[key], `${path}/${key}`)}`).join(',')}}`;
}

export function jcsCanonicalize(value) {
  return serialize(value, '$');
}

export function jcsBytes(value) {
  return Buffer.from(jcsCanonicalize(value), 'utf8');
}
