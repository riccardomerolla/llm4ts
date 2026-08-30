#!/usr/bin/env node
// Seed the DemoBank Next.js SPA fixture into a standalone git repository.
//
//   node examples/demo-bank/seed-nextjs.mjs [target-dir] [--force]
//
// target-dir defaults to .demo-bank/nextjs (relative to the current working
// directory). --force overwrites an existing target. node_modules, .next and
// out are never copied. The initial commit is deterministic: fixed author
// "Demo Bank <demo@example.invalid>" and fixed date 2020-01-01T00:00:00Z.
//
// Offline note: the fixture commits pnpm-lock.yaml. To install without
// network in the seeded repo, warm the pnpm store once while online
// (`pnpm install --ignore-workspace` in examples/demo-bank/nextjs), then run
// `pnpm install --ignore-workspace --offline` in the seeded copy.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SOURCE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'nextjs',
);

const EXCLUDED_NAMES = new Set(['node_modules', '.next', 'out', '.git']);

const AUTHOR_NAME = 'Demo Bank';
const AUTHOR_EMAIL = 'demo@example.invalid';
const COMMIT_DATE = '2020-01-01T00:00:00Z';

function fail(message) {
  process.stderr.write(`seed-nextjs: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  let targetDir = null;
  let force = false;
  for (const arg of argv) {
    if (arg === '--force') {
      force = true;
    } else if (arg.startsWith('--')) {
      fail(`unknown option: ${arg}`);
    } else if (targetDir === null) {
      targetDir = arg;
    } else {
      fail(`unexpected argument: ${arg}`);
    }
  }
  return {
    targetDir: path.resolve(targetDir ?? path.join('.demo-bank', 'nextjs')),
    force,
  };
}

function git(cwd, args, env = {}) {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, ...env },
  });
}

const { targetDir, force } = parseArgs(process.argv.slice(2));

if (!fs.existsSync(SOURCE_DIR)) {
  fail(`fixture source not found: ${SOURCE_DIR}`);
}

if (fs.existsSync(targetDir)) {
  if (!force) {
    fail(`target already exists: ${targetDir} (use --force to overwrite)`);
  }
  fs.rmSync(targetDir, { recursive: true, force: true });
}

fs.mkdirSync(targetDir, { recursive: true });
fs.cpSync(SOURCE_DIR, targetDir, {
  recursive: true,
  filter: (source) => !EXCLUDED_NAMES.has(path.basename(source)),
});

git(targetDir, ['init', '--quiet', '-b', 'main']);
git(targetDir, ['add', '-A']);
git(
  targetDir,
  [
    '-c',
    `user.name=${AUTHOR_NAME}`,
    '-c',
    `user.email=${AUTHOR_EMAIL}`,
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'Seed DemoBank Next.js SPA fixture',
  ],
  {
    GIT_AUTHOR_NAME: AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: AUTHOR_EMAIL,
    GIT_AUTHOR_DATE: COMMIT_DATE,
    GIT_COMMITTER_NAME: AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: AUTHOR_EMAIL,
    GIT_COMMITTER_DATE: COMMIT_DATE,
  },
);

process.stdout.write(`Seeded DemoBank Next.js fixture at ${targetDir}\n`);
