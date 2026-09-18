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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  formatTestCacheReport,
  formatTestCacheTableRow,
  summarizeTestCacheFile,
  testCacheReportingEnabled,
} from '../src/test-cache.js';

function event(id, result) {
  return JSON.stringify({ id: { testResult: id }, testResult: result });
}

function commandLine(value) {
  return JSON.stringify({
    structuredCommandLine: {
      commandLineLabel: 'canonical',
      sections: [{
        sectionLabel: 'command options',
        optionList: { option: [{ optionName: 'cache_test_results', optionValue: value }] },
      }],
    },
  });
}

function finalEvent() {
  return JSON.stringify({ lastMessage: true });
}

test('test-cache reporting input accepts only explicit booleans', () => {
  assert.equal(testCacheReportingEnabled('true'), true);
  assert.equal(testCacheReportingEnabled(' FALSE '), false);
  assert.throws(() => testCacheReportingEnabled('auto'), /report-test-cache-hits/);
});

test('BEP test attempts count local, remote/disk, executed, retries, and shards', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-bazel-cache-bep-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const report = path.join(directory, 'test.bep.json');
  fs.writeFileSync(report, [
    commandLine('yes'),
    event({ label: '//pkg:test', configuration: { id: 'k8' }, run: 1, shard: 0, attempt: 1 }, { cachedLocally: true }),
    event({ label: '//pkg:test', configuration: { id: 'k8' }, run: 1, shard: 1, attempt: 1 }, { executionInfo: { cachedRemotely: true } }),
    event({ label: '//pkg:test', configuration: { id: 'k8' }, run: 1, shard: 0, attempt: 2 }, { executionInfo: { cachedRemotely: true } }),
    event({ label: '//pkg:test', configuration: { id: 'k8' }, run: 2, shard: 0, attempt: 1 }, { executionInfo: { cachedRemotely: true } }),
    event({ label: '//pkg:other', configuration: { id: 'k8' }, run: 1, shard: 0, attempt: 1 }, { executionInfo: { strategy: 'local' } }),
    finalEvent(),
  ].join('\n') + '\n');

  const summary = await summarizeTestCacheFile(report);
  assert.equal(summary.partial, false);
  assert.equal(summary.cacheSetting, 'yes');
  assert.deepEqual({
    hits: summary.hits,
    observed: summary.observed,
    localHits: summary.localHits,
    remoteHits: summary.remoteHits,
    executed: summary.executed,
  }, { hits: 4, observed: 5, localHits: 1, remoteHits: 3, executed: 1 });
});

test('local classification takes precedence and duplicate BEP records are ignored', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-bazel-cache-bep-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const report = path.join(directory, 'test.bep.json');
  const id = { label: '//pkg:test', configuration: { id: 'k8' }, run: 1, shard: 0, attempt: 1 };
  fs.writeFileSync(report, [
    event(id, { cachedLocally: true, executionInfo: { cachedRemotely: true } }),
    event(id, { cachedLocally: true, executionInfo: { cachedRemotely: true } }),
    finalEvent(),
  ].join('\n'));

  const summary = await summarizeTestCacheFile(report);
  assert.equal(summary.observed, 1);
  assert.equal(summary.localHits, 1);
  assert.equal(summary.remoteHits, 0);
});

test('a canonical command line without an explicit cache flag uses Bazel auto', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-bazel-cache-bep-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const report = path.join(directory, 'test.bep.json');
  fs.writeFileSync(report, [
    JSON.stringify({ structuredCommandLine: { commandLineLabel: 'canonical', sections: [] } }),
    finalEvent(),
  ].join('\n'));

  const summary = await summarizeTestCacheFile(report);
  assert.equal(summary.cacheSetting, 'auto');
});

test('malformed and truncated BEP input preserves valid attempts and marks the report partial', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-bazel-cache-bep-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const report = path.join(directory, 'test.bep.json');
  fs.writeFileSync(report, [
    event({ label: '//pkg:test', attempt: 1 }, { executionInfo: { strategy: 'local' } }),
    '{"truncated":',
  ].join('\n'));

  const summary = await summarizeTestCacheFile(report);
  assert.equal(summary.observed, 1);
  assert.equal(summary.executed, 1);
  assert.equal(summary.partial, true);
  assert.equal(summary.malformedLines, 1);
});

test('missing BEP input is represented as an unavailable partial report', async () => {
  const summary = await summarizeTestCacheFile(
    path.join(os.tmpdir(), 'setup-bazel-cache-no-such-bep-file.json'),
  );
  assert.equal(summary.partial, true);
  assert.equal(summary.observed, 0);
  assert.equal(summary.cacheSetting, 'unknown');
  assert.equal(summary.available, false);
  assert.equal(summary.readError, 'ENOENT');
});

test('disabled test-result caching reports zero hits with the effective setting', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-bazel-cache-bep-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const report = path.join(directory, 'test.bep.json');
  fs.writeFileSync(report, [
    commandLine('no'),
    event({ label: '//pkg:test', attempt: 1 }, { executionInfo: { strategy: 'local' } }),
    finalEvent(),
  ].join('\n'));

  const summary = await summarizeTestCacheFile(report);
  assert.equal(summary.cacheSetting, 'no');
  assert.equal(summary.hits, 0);
  assert.equal(summary.observed, 1);
  assert.match(formatTestCacheReport([{ command: 'test', ...summary }]), /0%/);
});

async function summarize(context, records) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bep-regression-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'events.json');
  fs.writeFileSync(file, records.join('\n'));
  return summarizeTestCacheFile(file);
}

test('zero attempts are n/a even with caching disabled; observed hits are never overwritten', async (context) => {
  const empty = await summarize(context, [commandLine('no'), finalEvent()]);
  assert.match(formatTestCacheTableRow({ command: 'test', ...empty }), /0 \/ 0 \| n\/a/);
  assert.match(formatTestCacheTableRow({ command: 'test', ...empty }), /Disabled \| No attempts/);
  const hit = await summarize(context, [
    commandLine('no'), event({ label: '//:t' }, { cachedLocally: true }), finalEvent(),
  ]);
  assert.match(formatTestCacheTableRow({ command: 'test', ...hit }), /1 \/ 1 \| 100%/);
});

test('malformed middle records and JSON primitives cannot hide subsequent valid attempts', async (context) => {
  const summary = await summarize(context, [
    event({ label: '//:first' }, {}), '{broken', 'null', '[]',
    JSON.stringify({ testResult: {} }),
    event({ label: '//:invalid' }, { cachedLocally: 'true' }),
    event({ label: '//:last' }, { cachedLocally: true }), finalEvent(),
  ]);
  assert.equal(summary.observed, 2);
  assert.equal(summary.hits, 1);
  assert.equal(summary.malformedLines, 5);
  assert.equal(summary.completed, true);
  assert.equal(summary.partial, true);
});

test('announcements, summaries, and aborted events are not test attempts', async (context) => {
  const summary = await summarize(context, [
    JSON.stringify({ children: [{ testResult: { label: '//:t' } }] }),
    JSON.stringify({ testSummary: { totalRunCount: 20 } }),
    JSON.stringify({ id: { testResult: { label: '//:t' } }, aborted: { reason: 'USER_INTERRUPTED' } }),
    event({ label: '//:actual' }, { executionInfo: { strategy: 'remote' } }), finalEvent(),
  ]);
  assert.equal(summary.observed, 1);
  assert.equal(summary.executed, 1);
  assert.equal(summary.hits, 0);
});

test('identity ignores property order and omitted zero values but distinguishes configurations', async (context) => {
  const summary = await summarize(context, [
    event({ label: '//:t', configuration: { id: 'a' }, attempt: 1 }, {}),
    event({ attempt: 1, shard: 0, run: 0, configuration: { id: 'a' }, label: '//:t' }, {}),
    event({ label: '//:t', configuration: { id: 'b' }, attempt: 1 }, {}),
    finalEvent(),
  ]);
  assert.equal(summary.observed, 2);
});

test('canonical settings normalize all Bazel aliases and ignore the original command line', async (context) => {
  for (const [expected, aliases] of [
    ['yes', ['yes', 'true', '1', 't', 'Y']],
    ['no', ['no', 'false', '0', 'f', 'N']],
    ['auto', ['auto']],
    ['unknown', ['unrecognized']],
  ]) {
    for (const alias of aliases) {
      const summary = await summarize(context, [
        commandLine('no').replace('canonical', 'original'),
        commandLine(alias), finalEvent(),
      ]);
      assert.equal(summary.cacheSetting, expected, alias);
    }
  }
  const unknown = await summarize(context, [finalEvent()]);
  assert.equal(unknown.cacheSetting, 'unknown');
});

test('canonical option replacement and malformed metadata do not fall back to a false default', async (context) => {
  const canonical = JSON.parse(commandLine('no'));
  canonical.structuredCommandLine.sections[0].optionList.option.push({
    optionName: 'cache_test_results', optionValue: 'yes',
  });
  assert.equal((await summarize(context, [JSON.stringify(canonical), finalEvent()])).cacheSetting, 'yes');
  canonical.structuredCommandLine.sections = 42;
  const malformed = await summarize(context, [
    JSON.stringify(canonical), event({ label: '//:t' }, {}), finalEvent(),
  ]);
  assert.equal(malformed.cacheSetting, 'unknown');
  assert.equal(malformed.observed, 1);
  assert.equal(malformed.partial, true);
});

test('empty and unreadable files are unavailable; a complete failed invocation is valid', async (context) => {
  const empty = await summarize(context, []);
  assert.equal(empty.available, false);
  assert.match(formatTestCacheTableRow({ command: 'test', ...empty }), /— \| n\/a/);
  const unreadable = await summarizeTestCacheFile(os.tmpdir());
  assert.equal(unreadable.available, false);
  assert.equal(unreadable.readError, 'EISDIR');
  const failed = await summarize(context, [
    event({ label: '//:t' }, { status: 'FAILED' }),
    JSON.stringify({ finished: { exitCode: { code: 1 } } }), finalEvent(),
  ]);
  assert.equal(failed.partial, false);
  const unfinished = await summarize(context, [event({ label: '//:t' }, {})]);
  assert.equal(unfinished.partial, true);
  assert.equal(unfinished.observed, 1);
});
