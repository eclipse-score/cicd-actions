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
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { executionLogPaths } from '../src/execution-log.js';
import { testCachePaths } from '../src/test-cache.js';

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'post-reporting-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function runPost(
  root,
  enabled,
  summaryPath = path.join(root, 'summary.md'),
  state = { cacheSaveAllowed: false },
) {
  if (!fs.existsSync(summaryPath)) fs.writeFileSync(summaryPath, '');
  const output = execFileSync(process.execPath, [
    fileURLToPath(new URL('../src/post.js', import.meta.url)),
  ], {
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      RUNNER_TEMP: root,
      GITHUB_STEP_SUMMARY: summaryPath,
      'STATE_setup-bazel-cache-configuration': JSON.stringify(state),
      'INPUT_REPORT-CACHE-HITS': 'true',
      'INPUT_REPORT-TEST-CACHE-HITS': String(enabled),
      'INPUT_ENABLE-PROFILING': 'false',
    },
  });
  return { output, summary: fs.statSync(summaryPath).isFile() ? fs.readFileSync(summaryPath, 'utf8') : '' };
}

test('post reports unavailable data quietly and continues cache-save eligibility checks', (context) => {
  const root = fixture(context);
  const { output, summary } = runPost(root, true);
  assert.doesNotMatch(output, /::warning::|::error::/);
  assert.match(output, /Unavailable/);
  assert.match(output, /Cache saving is disabled on this ref/);
  assert.match(summary, /Unavailable/);
  assert.doesNotMatch(summary, /0%/);
});

test('test report preserves cache output and renders disabled, partial, and no-attempt states', (context) => {
  const root = fixture(context);
  fs.writeFileSync(executionLogPaths(root).test, execFileSync('zstd', ['-cq'], { input: Buffer.alloc(0) }));
  fs.writeFileSync(testCachePaths(root).test, [
    JSON.stringify({ structuredCommandLine: {
      commandLineLabel: 'canonical',
      sections: [{ optionList: { option: [{ optionName: 'cache_test_results', optionValue: '0' }] } }],
    } }),
    JSON.stringify({
      id: { testResult: { label: '//:disabled-test' } },
      testResult: { executionInfo: { strategy: 'local' } },
    }),
    JSON.stringify({ lastMessage: true }),
  ].join('\n'));
  fs.writeFileSync(testCachePaths(root).coverage, [
    '{"private":"DO_NOT_PRINT',
    JSON.stringify({ id: { testResult: { label: '//:t' } }, testResult: { cachedLocally: true } }),
  ].join('\n'));
  const baseline = runPost(root, false);
  fs.writeFileSync(path.join(root, 'summary.md'), '');
  const actual = runPost(root, true, path.join(root, 'summary.md'), {
    cacheSaveAllowed: false,
    restoreResults: {
      bazelisk: 'true',
      disk: 'partial',
      repository: 'false',
      external: 'skipped',
    },
  });
  assert.match(baseline.summary, /<h1>Bazel cache summary<\/h1>/);
  assert.match(actual.summary, /<h1>Bazel cache summary<\/h1>/);
  assert.match(actual.summary, /\| Cache \| Cached \/ total \| Hit rate \| Status \|/);
  assert.match(actual.summary, /\| test \(test cache \(off\)\) \| 0 \/ 1 \| 0% \| Disabled \|/);
  assert.match(actual.summary, /\| coverage \(test cache\) \| 1 \/ 1 \| 100% \| Partial data \|/);
  assert.match(actual.summary, /\| Bazelisk cache \| — \| — \| Restored \|/);
  assert.match(actual.summary, /\| Disk cache \| — \| — \| Partially restored \|/);
  assert.match(actual.summary, /\| Repository cache \| — \| — \| Miss \|/);
  assert.doesNotMatch(actual.summary, /\| External cache \|/);
  fs.writeFileSync(path.join(root, 'summary.md'), '');
  const withExternal = runPost(root, true, path.join(root, 'summary.md'), {
    cacheSaveAllowed: false,
    restoreResults: { external: 'true' },
  });
  assert.match(withExternal.summary, /\| External cache \| — \| — \| Restored \|/);
  assert.doesNotMatch(actual.summary, /0 \/ 0/);
  assert.doesNotMatch(actual.summary, /Local cache \| Shared cache \| Ran \|/);
  assert.match(actual.output, /Bazel test cache\n\+[-+]+\+/);
  assert.match(actual.output, /::group::Bazel test cache details/);
  assert.match(actual.output, /\+[-+]+\+/);
  assert.doesNotMatch(actual.output + actual.summary, /DO_NOT_PRINT|::warning::|::error::/);
  assert.doesNotMatch(actual.output + actual.summary, /cacheable spawns|BEP|Executed\/non-hits|Remote\/disk/);
});

test('summary write failures do not stop post-step processing', (context) => {
  const root = fixture(context);
  // A directory is accessible but cannot receive summary text.
  const { output } = runPost(root, true, root);
  assert.match(output, /Bazel cache summary unavailable/);
  assert.match(output, /Cache saving is disabled on this ref/);
  assert.doesNotMatch(output, /::error::/);
});

test('failed-job post condition retains the cache-save gate', () => {
  const manifest = fs.readFileSync(new URL('../action.yml', import.meta.url), 'utf8');
  assert.match(manifest, /post-if: success\(\) \|\| \(failure\(\) && env.SETUP_BAZEL_CACHE_ADDITIVE_SAVE == 'true'\)/);
});
