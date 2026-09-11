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
import {
  claimInvocation,
  finishInvocation,
  initializeInvocationStore,
  invocationRootPath,
} from '../src/invocation.js';

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'post-reporting-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function runPost(
  root,
  enabled,
  summaryPath = path.join(root, 'summary.md'),
  state = { cacheSaveAllowed: false, invocationRoot: invocationRootPath(root) },
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

function varint(value) {
  const bytes = [];
  let remaining = BigInt(value);
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining !== 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0n);
  return Buffer.from(bytes);
}

function field(number, wireType, value) {
  const key = varint((BigInt(number) << 3n) | BigInt(wireType));
  if (wireType === 0) return Buffer.concat([key, varint(value)]);
  return Buffer.concat([key, varint(value.length), value]);
}

function compressedExecutionLog() {
  const spawn = Buffer.concat([
    field(11, 2, Buffer.from('local')),
    field(12, 0, 1),
    field(14, 0, 1),
  ]);
  const entry = field(7, 2, spawn);
  return execFileSync('zstd', ['-cq'], { input: Buffer.concat([varint(entry.length), entry]) });
}

test('post omits unavailable data quietly and continues cache-save eligibility checks', (context) => {
  const root = fixture(context);
  const { output, summary } = runPost(root, true);
  assert.doesNotMatch(output, /::warning::|::error::/);
  assert.doesNotMatch(output, /Unavailable/);
  assert.match(output, /Cache saving is disabled on this ref/);
  assert.doesNotMatch(summary, /Unavailable/);
  assert.doesNotMatch(summary, /0%/);
});

test('test report preserves cache output and renders disabled, partial, and no-attempt states', (context) => {
  const root = fixture(context);
  const invocationRoot = invocationRootPath(root);
  initializeInvocationStore(invocationRoot);
  const testInvocation = claimInvocation(invocationRoot, 'test', {
    executionLog: true,
    testCache: true,
    profile: false,
  });
  fs.writeFileSync(testInvocation.files.executionLog, execFileSync('zstd', ['-cq'], { input: Buffer.alloc(0) }));
  fs.writeFileSync(testInvocation.files.testCache, [
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
  finishInvocation(testInvocation, 0);
  const coverageInvocation = claimInvocation(invocationRoot, 'coverage', {
    executionLog: true,
    testCache: true,
    profile: false,
  });
  fs.writeFileSync(coverageInvocation.files.testCache, [
    '{"private":"DO_NOT_PRINT',
    JSON.stringify({ id: { testResult: { label: '//:t' } }, testResult: { cachedLocally: true } }),
  ].join('\n'));
  finishInvocation(coverageInvocation, 0);
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
  assert.match(actual.summary, /\| Invocation \| Targets \| Cache \| Cached \/ total \| Hit rate \| Status \|/);
  assert.match(actual.summary, /\| 000-test \| not captured \| Test cache \| 0 \/ 1 \| 0% \| ⚠️ Disabled \|/);
  assert.match(actual.summary, /⚠️ Disabled means test-result caching was turned off for this invocation/);
  assert.match(actual.summary, /\| 001-coverage \| not captured \| Test cache \| 1 \/ 1 \| 100% \| Partial data \|/);
  assert.match(actual.summary, /\| — \| — \| Bazelisk cache \| 1 \/ 1 \| 100% \| Used \|/);
  assert.match(actual.summary, /\| — \| — \| Repository cache \| 0 \/ 1 \| 0% \| Not used \|/);
  assert.doesNotMatch(actual.summary, /Disk cache/);
  assert.doesNotMatch(actual.summary, /\| External cache \|/);
  fs.writeFileSync(path.join(root, 'summary.md'), '');
  const withExternal = runPost(root, true, path.join(root, 'summary.md'), {
    cacheSaveAllowed: false,
    restoreResults: { external: 'false' },
    externalManifestRestoreResult: 'true',
    externalRepositoryRestoreResults: {
      'repo-a': 'true',
      'repo-b': 'partial',
      'repo-c': 'false',
    },
  });
  assert.match(withExternal.summary, /\| External cache \| 2 \/ 3 \| 66.67% \| Used \|/);
  assert.match(actual.summary, /\| 000-test \| not captured \| Build cache \| 0 \/ 0 \| n\/a \| No data \|/);
  assert.doesNotMatch(actual.summary, /Local cache \| Shared cache \| Ran \|/);
  assert.match(actual.output, /Bazel test cache\n\+[-+]+\+/);
  assert.match(actual.output, /⚠️ Disabled means test-result caching was turned off for this invocation/);
  assert.equal(
    actual.output.match(/⚠️ Disabled means test-result caching was turned off for this invocation/g)?.length,
    1,
  );
  assert.match(actual.output, /::group::Bazel test cache details/);
  assert.match(actual.output, /\+[-+]+\+/);
  assert.doesNotMatch(
    actual.output + actual.summary,
    /Unavailable: no readable test-cache data|Build-cache and test-cache percentages are different views/,
  );
  assert.doesNotMatch(actual.output + actual.summary, /DO_NOT_PRINT|::warning::|::error::/);
  assert.doesNotMatch(actual.output + actual.summary, /cacheable spawns|BEP|Executed\/non-hits|Remote\/disk/);
});

test('summary lists repeated invocations with their target patterns', (context) => {
  const root = fixture(context);
  const invocationRoot = invocationRootPath(root);
  initializeInvocationStore(invocationRoot);
  for (let sequence = 0; sequence < 3; sequence += 1) {
    const invocation = claimInvocation(invocationRoot, 'test', {
      executionLog: true,
      testCache: true,
      profile: false,
    }, [`//:test-${sequence}`]);
    fs.writeFileSync(invocation.files.executionLog, compressedExecutionLog());
    fs.writeFileSync(invocation.files.testCache, [
      JSON.stringify({
        id: { testResult: { label: `//:test-${sequence}` } },
        testResult: { cachedLocally: true },
      }),
      JSON.stringify({ lastMessage: true }),
    ].join('\n'));
    finishInvocation(invocation, 0);
  }

  const { output, summary } = runPost(root, true);
  assert.match(summary, /\| Invocation \| Targets \| Cache \| Cached \/ total \| Hit rate \| Status \|/);
  for (let sequence = 0; sequence < 3; sequence += 1) {
    assert.match(
      summary,
      new RegExp(`\\| 00${sequence}-test \\| \\/\\/:test-${sequence} \\| Build cache \\| 1 \\/ 1 \\| 100% \\| Used \\|`),
    );
    assert.match(
      summary,
      new RegExp(`\\| 00${sequence}-test \\| \\/\\/:test-${sequence} \\| Test cache \\| 1 \\/ 1 \\| 100% \\| Used \\|`),
    );
  }
  assert.doesNotMatch(summary, /test \(3 invocations\)/);
  assert.match(output, /000-test/);
  assert.match(output, /001-test/);
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
