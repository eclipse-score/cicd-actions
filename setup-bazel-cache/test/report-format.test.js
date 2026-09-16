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
import test from 'node:test';
import {
  aggregateExecutionReports,
  cacheRestoreSummaryRows,
  cacheSummaryRow,
  executionTableRow,
  formatExecutionReport,
  formatSummaryTargets,
  groupInvocationRows,
} from '../src/report-format.js';

test('aggregating execution reports merges runner counts across invocations', () => {
  const reports = [
    {
      baseCommand: 'build', hits: 3, executed: 1, observed: 4, available: true, partial: false,
      hitRunners: [{ runner: 'linux-sandbox-disk', count: 3 }],
      executedRunners: [{ runner: 'linux-sandbox', count: 1 }],
    },
    {
      baseCommand: 'build', hits: 1, executed: 0, observed: 1, available: true, partial: false,
      hitRunners: [{ runner: 'linux-sandbox-disk', count: 1 }],
      executedRunners: [],
    },
  ];
  const [aggregate] = aggregateExecutionReports(reports);
  assert.equal(aggregate.hits, 4);
  assert.equal(aggregate.observed, 5);
  assert.deepEqual(aggregate.hitRunners, [{ runner: 'linux-sandbox-disk', count: 4 }]);
});

test('cache summary row reports n/a and dash for an unavailable report', () => {
  const row = cacheSummaryRow('Build cache', { available: false, baseCommand: 'build', command: '000-build' });
  assert.equal(row.rate, 'n/a');
  assert.equal(row.cached, '—');
  assert.equal(row.status, 'Unavailable');
});

test('cache summary row orders test rows just after their matching build row', () => {
  const build = cacheSummaryRow('Build cache', { hits: 1, observed: 1, available: true, sequence: 2 });
  const testRow = cacheSummaryRow('Test cache', { hits: 1, observed: 1, available: true, sequence: 2 });
  assert.equal(testRow.order, build.order + 1);
});

test('grouping invocation rows keeps repeated commands separate by sequence', () => {
  const groups = groupInvocationRows([
    { sequence: 0, command: 'build', targets: '//:a', elapsed: '1.0 s', order: 0 },
    { sequence: 1, command: 'build', targets: '//:b', elapsed: '2.0 s', order: 2 },
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.targets), ['//:a', '//:b']);
});

test('target patterns are escaped for a Markdown table cell', () => {
  assert.equal(formatSummaryTargets([]), 'not captured');
  assert.equal(formatSummaryTargets(['//pkg:a|b']), '//pkg:a\\|b');
});

test('the console execution report includes targets and elapsed time', () => {
  const text = formatExecutionReport({
    command: '000-build',
    hits: 3,
    observed: 4,
    hitRunners: [{ runner: 'linux-sandbox-disk', count: 3 }],
    executedRunners: [{ runner: 'linux-sandbox', count: 1 }],
    partial: false,
    targets: ['//:example'],
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:03.200Z',
  });
  assert.match(text, /^Bazel 000-build cache: 3 \/ 4 cached \(75%\) · 3\.2 s$/m);
  assert.match(text, /^ {2}Targets: \/\/:example$/m);
});

test('the aggregate execution table row omits targets and elapsed', () => {
  const row = executionTableRow({
    command: 'build', hits: 3, observed: 4, hitRunners: [], executedRunners: [], partial: true,
  });
  assert.deepEqual(row, ['build', '3 / 4', '75%', 'none', 'none', 'Partial']);
});

test('restore summary rows are omitted for caches that were never restored', () => {
  const rows = cacheRestoreSummaryRows({
    restoreResults: { bazelisk: 'true', disk: 'skipped', repository: 'false' },
  });
  assert.deepEqual(rows.map((row) => row.cache), ['Bazelisk cache', 'Repository cache']);
});
