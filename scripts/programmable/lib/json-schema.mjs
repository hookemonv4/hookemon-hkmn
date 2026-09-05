function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function typeMatches(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  return typeof value === type;
}

function pointerChild(path, key) {
  return `${path}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

function resolveReference(root, reference) {
  if (!reference.startsWith('#/')) throw new Error(`unsupported schema reference ${reference}`);
  return reference.slice(2).split('/').reduce((current, key) => current?.[key.replaceAll('~1', '/').replaceAll('~0', '~')], root);
}

export function validateJsonSchema(schema, value) {
  const failures = [];
  const validate = (node, candidate, path) => {
    if (node === true) return;
    if (node === false || node === undefined) {
      failures.push(`${path}: schema rejected value`);
      return;
    }
    if (node.$ref) {
      const reference = resolveReference(schema, node.$ref);
      if (reference === undefined) failures.push(`${path}: unresolved schema reference ${node.$ref}`);
      else validate(reference, candidate, path);
      return;
    }
    if (node.allOf) node.allOf.forEach((entry) => validate(entry, candidate, path));
    if (node.anyOf || node.oneOf) {
      const alternatives = node.anyOf ?? node.oneOf;
      let matches = 0;
      for (const alternative of alternatives) {
        const before = failures.length;
        validate(alternative, candidate, path);
        if (failures.length === before) matches += 1;
        else failures.splice(before);
      }
      const valid = node.oneOf ? matches === 1 : matches > 0;
      if (!valid) failures.push(`${path}: ${node.oneOf ? 'oneOf' : 'anyOf'} did not match`);
      return;
    }
    if (node.not) {
      const before = failures.length;
      validate(node.not, candidate, path);
      const matched = failures.length === before;
      failures.splice(before);
      if (matched) failures.push(`${path}: not schema matched`);
    }
    if (Object.hasOwn(node, 'const') && !jsonEqual(candidate, node.const)) failures.push(`${path}: expected constant`);
    if (node.enum && !node.enum.some((entry) => jsonEqual(candidate, entry))) failures.push(`${path}: value is not in enum`);
    if (node.type) {
      const types = Array.isArray(node.type) ? node.type : [node.type];
      if (!types.some((type) => typeMatches(candidate, type))) {
        failures.push(`${path}: expected ${types.join(' or ')}`);
        return;
      }
    }
    if (typeof candidate === 'string') {
      if (node.minLength !== undefined && candidate.length < node.minLength) failures.push(`${path}: string is too short`);
      if (node.pattern && !(new RegExp(node.pattern).test(candidate))) failures.push(`${path}: string does not match pattern`);
    }
    if (typeof candidate === 'number') {
      if (node.minimum !== undefined && candidate < node.minimum) failures.push(`${path}: number is below minimum`);
      if (node.maximum !== undefined && candidate > node.maximum) failures.push(`${path}: number is above maximum`);
    }
    if (Array.isArray(candidate)) {
      if (node.minItems !== undefined && candidate.length < node.minItems) failures.push(`${path}: array is too short`);
      if (node.maxItems !== undefined && candidate.length > node.maxItems) failures.push(`${path}: array is too long`);
      if (Array.isArray(node.prefixItems)) node.prefixItems.forEach((entry, index) => {
        if (index < candidate.length) validate(entry, candidate[index], pointerChild(path, index));
      });
      if (node.items && !Array.isArray(node.items)) candidate.forEach((entry, index) => validate(node.items, entry, pointerChild(path, index)));
    }
    if (candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)) {
      const properties = node.properties ?? {};
      for (const key of node.required ?? []) if (!Object.hasOwn(candidate, key)) failures.push(`${pointerChild(path, key)}: required property is missing`);
      for (const [key, entry] of Object.entries(candidate)) {
        if (Object.hasOwn(properties, key)) validate(properties[key], entry, pointerChild(path, key));
        else if (node.additionalProperties === false) failures.push(`${pointerChild(path, key)}: additional property is not allowed`);
        else if (node.additionalProperties && typeof node.additionalProperties === 'object') validate(node.additionalProperties, entry, pointerChild(path, key));
      }
    }
  };
  validate(schema, value, '');
  return failures;
}
