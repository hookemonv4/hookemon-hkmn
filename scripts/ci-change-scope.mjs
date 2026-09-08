import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// This file is loaded alone from the protected base. Keep it free of local imports.
const PRESENTATION_FILES = new Set([
  'apps/web/app/page.tsx',
  'apps/web/app/HookemonJourney.tsx',
  'apps/web/app/CardShowcase3D.tsx',
  'apps/web/app/RevealManager.tsx',
  'apps/web/app/SocialLinks.tsx',
  'apps/web/app/globals.css',
  'apps/web/app/hoenn-theme.css',
  'apps/web/app/PublicCycleTracker.module.css',
  'apps/web/lib/comic-scroll.ts',
  'apps/web/lib/journey-route.ts',
  'apps/web/lib/scroll-reveal.ts',
  'apps/web/public/comic-production/index.html',
  'apps/web/public/comic-production/packs.html',
  'apps/web/public/comic-production/cycles.html',
  'apps/web/public/comic-production/holders.html',
  'apps/web/public/comic-production/transparency.html',
  'apps/web/public/comic-production/adventure.css',
  'apps/web/public/comic-production/iconic-gallery.css',
  'apps/web/public/comic-production/packs.css',
  'apps/web/public/comic-production/information-pages.css',
  'apps/web/public/comic-production/pokemon-cries.css',
  'apps/web/tests/rendered-html.test.mjs',
  'apps/web/tests/comic-production.test.mjs',
  'apps/web/tests/comic-scroll.test.mjs',
  'apps/web/tests/journey-scroll.test.mjs',
  'apps/web/tests/scroll-reveal.test.mjs',
]);
const PRESENTATION_MEDIA = [
  /^apps\/web\/public\/audio\/pokemon\/[A-Za-z0-9][A-Za-z0-9._-]*\.mp3$/,
  /^apps\/web\/public\/showcase\/[A-Za-z0-9][A-Za-z0-9._-]*\.webp$/,
  /^apps\/web\/public\/comic\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|mp4)$/,
];
const EVENTS = new Set(['pull_request', 'push', 'workflow_dispatch']);
const COMMIT_ID = /^[0-9a-f]{40}$/;

function git(cwd, args) {
  // Ambient Git configuration must not redirect the repository or replace commit objects.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  });
  return execFileSync('git', [
    '--no-replace-objects', '--no-optional-locks',
    '-c', 'core.fsmonitor=false', '-c', 'core.excludesFile=/dev/null',
    ...args,
  ], { cwd, env, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function readChanges(raw) {
  if (raw.length === 0) return [];
  if (raw.at(-1) !== 0) throw new Error('Git diff is not NUL terminated');
  const fields = new TextDecoder('utf-8', { fatal: true }).decode(raw).split('\0');
  fields.pop();
  if (fields.length % 2 !== 0) throw new Error('Git diff has an incomplete record');
  const changes = [];
  for (let index = 0; index < fields.length; index += 2) {
    const header = /^:([0-7]{6}) ([0-7]{6}) [0-9a-f]{40} [0-9a-f]{40} ([A-Z])$/.exec(fields[index]);
    const path = fields[index + 1];
    if (!header || !path) throw new Error('Git diff has an invalid raw record');
    changes.push({ beforeMode: header[1], afterMode: header[2], status: header[3], path });
  }
  return changes;
}

export function classifyCiChanges({ base, head, event, cwd = process.cwd() }) {
  if (!COMMIT_ID.test(base ?? '') || !COMMIT_ID.test(head ?? '')) {
    throw new Error('base and head must be complete lowercase 40-character commit IDs');
  }
  if (!EVENTS.has(event)) throw new Error('event must be pull_request, push, or workflow_dispatch');
  if (git(cwd, ['rev-parse', '--is-inside-work-tree']).toString().trim() !== 'true') {
    throw new Error('cwd must be inside a Git worktree');
  }
  for (const [name, id] of [['base', base], ['head', head]]) {
    if (git(cwd, ['cat-file', '-t', id]).toString().trim() !== 'commit') {
      throw new Error(`${name} must identify a commit object`);
    }
  }
  try {
    git(cwd, ['merge-base', '--is-ancestor', base, head]);
  } catch {
    throw new Error('base must be a provable ancestor of head');
  }
  const changes = readChanges(git(cwd, [
    'diff', '--raw', '-z', '--no-abbrev', '--no-renames', '--no-ext-diff', '--no-textconv',
    '--no-relative', '--ignore-submodules=none', base, head, '--',
  ]));
  const paths = [...new Set(changes.map(change => change.path))].sort();
  let reason = 'presentation-only';
  if (event === 'workflow_dispatch') reason = 'manual-event';
  else if (changes.length === 0) reason = 'empty-diff';
  else if (changes.some(change => change.status !== 'M' || change.beforeMode !== '100644' || change.afterMode !== '100644')) {
    // Additions, deletions and renames also require the full lane, even for allowed names.
    reason = 'non-regular-or-structural-change';
  } else if (paths.some(path => !PRESENTATION_FILES.has(path) && !PRESENTATION_MEDIA.some(pattern => pattern.test(path)))) {
    reason = 'outside-presentation-allowlist';
  }
  return {
    schema: 'hookemon.ci-scope.v1', base, head,
    scope: reason === 'presentation-only' ? 'presentation' : 'full',
    webRequired: true, reason, paths,
  };
}

function main(argv) {
  const options = {};
  const flags = new Set(['--base', '--head', '--event', '--github-output']);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!flags.has(flag) || Object.hasOwn(options, flag) || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      throw new Error('Usage: ci-change-scope.mjs --base <commit> --head <commit> --event <event> [--github-output <path>]');
    }
    options[flag] = argv[index + 1];
  }
  const result = classifyCiChanges({ base: options['--base'], head: options['--head'], event: options['--event'] });
  if (options['--github-output']) {
    appendFileSync(options['--github-output'], `scope=${result.scope}\nweb-required=true\nbase=${result.base}\nhead=${result.head}\n`);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`ci-change-scope: ${error.message}\n`);
    process.exitCode = 1;
  }
}
