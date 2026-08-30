#!/usr/bin/env node
// Smoke check for the DemoBank Next.js SPA fixture: seeds into a temp dir,
// asserts the expected files exist and the seed commit is deterministic,
// then cleans up. Network-free; safe for CI.
//
//   node examples/demo-bank/smoke-nextjs.mjs

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED_SCRIPT = path.join(HERE, 'seed-nextjs.mjs');

const EXPECTED_FILES = [
  // Configs
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'next.config.mjs',
  'next-env.d.ts',
  'eslint.config.mjs',
  'vitest.config.ts',
  '.gitignore',
  // Docs
  'README.md',
  'CONTRIBUTING.md',
  // Theme + design system
  'src/theme/tokens.css',
  'src/theme/components.css',
  'src/components/Button.tsx',
  'src/components/Field.tsx',
  'src/components/Form.tsx',
  'src/components/DataTable.tsx',
  'src/components/Stepper.tsx',
  'src/components/Card.tsx',
  'src/components/PageLayout.tsx',
  'src/components/index.ts',
  // Auth stub + app shell
  'src/auth/AuthProvider.tsx',
  'src/app/layout.tsx',
  'src/app/signed-in-badge.tsx',
  'src/app/page.tsx',
  // Exemplar pages
  'src/app/cards/page.tsx',
  'src/app/profile/page.tsx',
  // Ports, adapters, registry
  'src/services/registry.ts',
  'src/services/cards/port.ts',
  'src/services/cards/mock.ts',
  'src/services/profile/port.ts',
  'src/services/profile/mock.ts',
  // Contracts
  'contracts/cards.openapi.yaml',
  'contracts/profile.openapi.yaml',
  // Tests
  'tests/cards.page.test.tsx',
  'tests/profile.page.test.tsx',
];

const EXCLUDED_DIRS = ['node_modules', '.next', 'out'];

function fail(message) {
  process.stderr.write(`smoke-nextjs: FAIL: ${message}\n`);
  process.exitCode = 1;
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-bank-smoke-'));
const target = path.join(tempRoot, 'nextjs');

try {
  execFileSync(process.execPath, [SEED_SCRIPT, target], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  const missing = EXPECTED_FILES.filter(
    (file) => !fs.existsSync(path.join(target, file)),
  );
  if (missing.length > 0) {
    fail(`seeded repo is missing expected files:\n  - ${missing.join('\n  - ')}`);
  }

  for (const dir of EXCLUDED_DIRS) {
    if (fs.existsSync(path.join(target, dir))) {
      fail(`seeded repo must not contain ${dir}/`);
    }
  }

  const gitLog = execFileSync(
    'git',
    ['log', '--format=%an <%ae> %at', 'main'],
    { cwd: target, encoding: 'utf8' },
  ).trim();
  const commits = gitLog.length === 0 ? [] : gitLog.split('\n');
  if (commits.length !== 1) {
    fail(`expected exactly 1 seed commit, found ${commits.length}`);
  }
  // 1577836800 = 2020-01-01T00:00:00Z
  const expectedAuthor = 'Demo Bank <demo@example.invalid> 1577836800';
  if (commits[0] !== expectedAuthor) {
    fail(
      `seed commit is not deterministic:\n  expected: ${expectedAuthor}\n  actual:   ${commits[0]}`,
    );
  }

  if (process.exitCode !== 1) {
    process.stdout.write(
      `smoke-nextjs: OK (${EXPECTED_FILES.length} files verified in seeded repo)\n`,
    );
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
