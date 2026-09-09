#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { assembleLaunchDelivery, verifyLaunchDelivery } from './lib/launch-delivery.mjs';

try {
  const { values } = parseArgs({ options: { source: { type: 'string' }, output: { type: 'string' }, verify: { type: 'string' } } });
  if (values.verify ? values.output : !values.source || !values.output) throw new Error('use --source WORKTREE --output NEW_DIRECTORY, or --verify DIRECTORY [--source WORKTREE]');
  const result = values.verify ? verifyLaunchDelivery({ directory: values.verify, sourceRoot: values.source })
    : assembleLaunchDelivery({ sourceRoot: values.source, outputDirectory: values.output });
  console.log(JSON.stringify(result));
  if (result.freshness === 'STALE') process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ status: 'FAILED', message: error.message, readyForPreflight: false }));
  process.exitCode = 1;
}
