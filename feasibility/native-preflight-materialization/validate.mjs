import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { default: Ajv2020 } = await import(pathToFileURL(resolve(process.argv[2], 'node_modules/ajv/dist/2020.js')));
const root = 'feasibility/native-preflight-materialization';
const schema = JSON.parse(await readFile('feasibility/native-provider-admission/create-schema.json', 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false, logger: false });
const validate = ajv.compile(schema);
const results = {};
for (const [name, path] of Object.entries({ original: 'release/phase3/package/create-request.json', proposed: `${root}/proposed-create-request.json` })) {
  const valid = validate(JSON.parse(await readFile(path, 'utf8')));
  results[name] = { valid, errorCount: validate.errors?.length ?? 0, errors: structuredClone(validate.errors ?? []) };
}
results.scope = 'JSON Schema2020-12 structural/allOf/pattern validation using pinned AJV8.17.1; format annotations disabled. No cryptographic, runtime, economics or server admission claim.';
await writeFile(`${root}/validation.json`, JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify({ original: results.original.errorCount, proposed: results.proposed.errorCount, valid: results.proposed.valid }));
