// *******************************************************************************
// Copyright (c) 2026 Contributors to the Eclipse Foundation
//
// See the NOTICE file(s) distributed with this work for additional
// information regarding copyright ownership.
//
// This program and the accompanying materials are made available under the
// terms of the Apache License Version 2.0 which is available at
// https://www.apache.org/licenses/LICENSE-2.0
//
// SPDX-License-Identifier: Apache-2.0
// *******************************************************************************

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ensureComparisonHistory,
  lockFileChanged,
  resolveComparisonBase,
  resolveDefaultBranch,
} from '../src/git.js';

/** Create the minimal spawnSync-like result needed by Git policy tests. */
function result(status, stderr = '') {
  return { status, stderr };
}

test('default branch is read from the repository event payload', () => {
  const readFile = () => JSON.stringify({ repository: { default_branch: 'trunk' } });
  assert.equal(resolveDefaultBranch('/event.json', readFile), 'trunk');
});

test('missing default branch metadata is rejected', () => {
  const readFile = () => JSON.stringify({ repository: {} });
  assert.throws(
    () => resolveDefaultBranch('/event.json', readFile),
    /repository\.default_branch.*missing or invalid/,
  );
});

test('existing parent commit is reused', () => {
  const calls = [];
  const git = (_workspace, args) => {
    calls.push(args);
    return result(0);
  };
  assert.equal(ensureComparisonHistory('/workspace', 'HEAD^', git), 'existing');
  assert.equal(calls.length, 2);
});

test('a shallow checkout is deepened once', () => {
  let parentChecks = 0;
  const git = (_workspace, args) => {
    if (args[0] === 'fetch') return result(0);
    if (args.includes('HEAD^^{commit}')) return result(parentChecks++ === 0 ? 1 : 0);
    return result(0);
  };
  assert.equal(ensureComparisonHistory('/workspace', 'HEAD^', git), 'deepened');
});

test('a multi-commit push fetches its exact comparison base', () => {
  const comparisonBase = 'a'.repeat(40);
  let baseChecks = 0;
  const git = (_workspace, args) => {
    if (args[0] === 'fetch') {
      assert.deepEqual(
        args,
        ['fetch', '--no-tags', '--depth=1', 'origin', comparisonBase],
      );
      return result(0);
    }
    if (args.includes(`${comparisonBase}^{commit}`)) {
      return result(baseChecks++ === 0 ? 1 : 0);
    }
    return result(0);
  };
  assert.equal(
    ensureComparisonHistory('/workspace', comparisonBase, git),
    'fetched',
  );
});

test('missing history fails with actionable guidance', () => {
  const git = (_workspace, args) => args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree'
    ? result(0)
    : result(1);
  assert.throws(
    () => ensureComparisonHistory('/workspace', 'HEAD^', git),
    /fetch-depth: 0/,
  );
});

test('lock-file git diff status is mapped strictly', () => {
  assert.equal(lockFileChanged('/workspace', 'base', () => result(0)), false);
  assert.equal(lockFileChanged('/workspace', 'base', () => result(1)), true);
  assert.throws(
    () => lockFileChanged('/workspace', 'base', () => result(128, 'bad revision')),
    /bad revision/,
  );
});

test('push events compare the full pushed commit range', () => {
  const before = 'a'.repeat(40);
  const readFile = () => JSON.stringify({ before });
  assert.equal(resolveComparisonBase('push', '/event.json', readFile), before);
});

test('non-push events compare the previous commit', () => {
  assert.equal(resolveComparisonBase('workflow_dispatch'), 'HEAD^');
  assert.equal(resolveComparisonBase('merge_group'), 'HEAD^');
});

test('malformed push bases are rejected', () => {
  const readFile = () => JSON.stringify({ before: 'not-a-sha' });
  assert.throws(
    () => resolveComparisonBase('push', '/event.json', readFile),
    /not a valid Git commit SHA/,
  );
});


test('nested lock-file comparison ignores a change to the root module lock', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bazel nested git-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nested = path.join(root, 'nested');
  fs.mkdirSync(nested);
  // Git exports repository and index paths while running commit hooks. Strip
  // those variables so every fixture operation stays inside the temporary repo.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  const git = (...args) => execFileSync('git', [
    '-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.org',
    '-c', 'commit.gpgsign=false', ...args,
  ], { stdio: 'pipe', env });
  const compareGit = (workspace, args) => spawnSync('git', ['-C', workspace, ...args], {
    encoding: 'utf8', env,
  });
  git('init', '-q');
  fs.writeFileSync(path.join(root, 'MODULE.bazel.lock'), 'root v1');
  fs.writeFileSync(path.join(nested, 'MODULE.bazel.lock'), 'nested v1');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'initial modules');
  fs.writeFileSync(path.join(root, 'MODULE.bazel.lock'), 'root v2');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'root module only');
  assert.equal(lockFileChanged(root, 'HEAD^', compareGit), true);
  assert.equal(lockFileChanged(nested, 'HEAD^', compareGit), false);
  fs.writeFileSync(path.join(nested, 'MODULE.bazel.lock'), 'nested v2');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'nested module only');
  assert.equal(lockFileChanged(root, 'HEAD^', compareGit), false);
  assert.equal(lockFileChanged(nested, 'HEAD^', compareGit), true);
});
