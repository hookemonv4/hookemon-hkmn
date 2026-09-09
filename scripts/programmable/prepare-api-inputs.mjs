#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { prepareApiInputs } from './lib/api-input-preparation.mjs';

try {
  const { values } = parseArgs({ options: Object.fromEntries(['source', 'cli-root', 'capabilities', 'metadata', 'output'].map(key => [key, { type: 'string' }])) });
  if (Object.values(values).length !== 5) throw new Error('Required: --source --cli-root --capabilities --metadata --output');
  const result = await prepareApiInputs({ source: values.source, cliRoot: values['cli-root'], capabilitiesPath: values.capabilities,
    metadataPath: values.metadata, output: values.output });
  console.log(JSON.stringify({ status: result.status, readyForPreflight: result.readyForPreflight, kernelCompatibility: result.kernelCompatibility }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
