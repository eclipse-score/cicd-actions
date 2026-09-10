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

function runPost(root, enabled, summaryPath = path.join(root, 'summary.md')) {
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
      'STATE_setup-bazel-cache-configuration': JSON.stringify({ cacheSaveAllowed: false }),
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

test('test report preserves spawn output and renders disabled, partial, and no-attempt states', (context) => {
  const root = fixture(context);
  fs.writeFileSync(executionLogPaths(root).test, execFileSync('zstd', ['-cq'], { input: Buffer.alloc(0) }));
  fs.writeFileSync(testCachePaths(root).test, [
    JSON.stringify({ structuredCommandLine: {
      commandLineLabel: 'canonical',
      sections: [{ optionList: { option: [{ optionName: 'cache_test_results', optionValue: '0' }] } }],
    } }),
    JSON.stringify({ lastMessage: true }),
  ].join('\n'));
  fs.writeFileSync(testCachePaths(root).coverage, [
    '{"private":"DO_NOT_PRINT',
    JSON.stringify({ id: { testResult: { label: '//:t' } }, testResult: { cachedLocally: true } }),
  ].join('\n'));
  const baseline = runPost(root, false);
  fs.writeFileSync(path.join(root, 'summary.md'), '');
  const actual = runPost(root, true);
  assert.ok(actual.summary.startsWith(baseline.summary));
  assert.ok(actual.output.startsWith(baseline.output.split('Cache saving is disabled')[0]));
  assert.match(actual.summary, /0 \/ 0 \| n\/a.*Disabled \| No attempts/);
  assert.match(actual.summary, /1 \/ 1 \| 100%.*Partial/);
  assert.match(actual.output, /\+[-+]+\+/);
  assert.doesNotMatch(actual.output + actual.summary, /DO_NOT_PRINT|::warning::|::error::/);
});

test('summary write failures do not stop post-step processing', (context) => {
  const root = fixture(context);
  // A directory is accessible but cannot receive summary text.
  const { output } = runPost(root, true, root);
  assert.match(output, /step summary unavailable/);
  assert.match(output, /Cache saving is disabled on this ref/);
  assert.doesNotMatch(output, /::error::/);
});

test('failed-job post condition retains the cache-save gate', () => {
  const manifest = fs.readFileSync(new URL('../action.yml', import.meta.url), 'utf8');
  assert.match(manifest, /post-if: success\(\) \|\| \(failure\(\) && env.SETUP_BAZEL_CACHE_ADDITIVE_SAVE == 'true'\)/);
});
