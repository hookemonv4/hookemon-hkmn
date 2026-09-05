import { resolve } from 'node:path';

export function parsePhaseThreeReleaseRebuildOptions(argv, defaults) {
  const options = { ...defaults };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== '--release-directory' && flag !== '--release-plan-output') {
      throw new Error(`unknown rebuild option: ${flag}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a path`);
    if (flag === '--release-directory') options.releaseDirectory = resolve(value);
    else options.releasePlanPath = resolve(value);
    index += 1;
  }
  return options;
}
