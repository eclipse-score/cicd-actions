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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const TEST_CACHE_METRIC_NOTE =
  'Each test run counts separately, including retries and parallel test pieces. Latest invocation per command.';
const TEST_CACHE_HEADERS = [
  'Command', 'Cached / total', 'Hit rate', 'Local cache', 'Shared cache',
  'Ran', 'Caching', 'Status',
];

function testCacheReportingEnabled(value) {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error("Input 'report-test-cache-hits' must be one of: true, false");
}

function testCachePaths(runnerTemp = process.env.RUNNER_TEMP || os.tmpdir()) {
  return Object.fromEntries(['test', 'coverage'].map((command) => [
    command, path.join(runnerTemp, `setup-bazel-cache-${command}.bep.json`),
  ]));
}

function clearTestCacheReports(reports) {
  for (const report of Object.values(reports)) fs.rmSync(report, { force: true });
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Stream BEP records without retaining outputs, environment, or command lines.
 * Only attempt identities are retained for deduplication; counters grow as valid
 * results arrive. Bad records must not hide later valid attempts.
 */
async function summarizeTestCacheFile(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const state = {
    hits: 0, observed: 0, localHits: 0, remoteHits: 0, executed: 0,
    cacheSetting: 'unknown', completed: false, malformedLines: 0,
    validEvents: 0, readError: null, seenIds: new Set(),
  };
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (!isObject(event)) throw new Error('Expected a BEP object');
        consumeEvent(state, event);
        state.validEvents += 1;
      } catch {
        // JSON errors can contain fragments of the event (including secrets).
        // Report counts only, never the raw record or JSON parser exception.
        state.malformedLines += 1;
      }
    }
  } catch (error) {
    state.readError = error.code || 'READ_ERROR';
  } finally {
    lines.close();
    stream.destroy();
  }
  const { seenIds, validEvents, ...report } = state;
  void seenIds;
  return {
    ...report,
    available: validEvents > 0,
    partial: Boolean(state.readError) || state.malformedLines > 0 || !state.completed,
  };
}

function consumeEvent(state, event) {
  if (event.lastMessage === true) state.completed = true;
  if (event.structuredCommandLine?.commandLineLabel === 'canonical') {
    state.cacheSetting = 'unknown';
    state.cacheSetting = cacheTestResultsSetting(event.structuredCommandLine);
  }
  if (event.testResult === undefined) return;
  const result = event.testResult;
  const id = event.id?.testResult;
  if (!isObject(result) || !isObject(id) || typeof id.label !== 'string' || !id.label) {
    throw new Error('Invalid test-result identity or payload');
  }
  if (id.configuration !== undefined &&
      (!isObject(id.configuration) ||
       (id.configuration.id !== undefined && typeof id.configuration.id !== 'string'))) {
    throw new Error('Invalid configuration');
  }
  const dimensions = ['run', 'shard', 'attempt'].map((name) => id[name] ?? 0);
  if (dimensions.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('Invalid attempt dimensions');
  }
  if (result.executionInfo !== undefined && !isObject(result.executionInfo)) {
    throw new Error('Invalid execution info');
  }
  for (const flag of [result.cachedLocally, result.executionInfo?.cachedRemotely]) {
    if (flag !== undefined && typeof flag !== 'boolean') throw new Error('Invalid cache flag');
  }
  const identity = JSON.stringify([id.label, id.configuration?.id ?? '', ...dimensions]);
  if (state.seenIds.has(identity)) return;
  state.seenIds.add(identity);
  state.observed += 1;
  // Locally replayed results can retain the original execution metadata.
  // Local reuse therefore takes precedence over the remote/disk flag.
  if (result.cachedLocally === true) state.localHits += 1;
  else if (result.executionInfo?.cachedRemotely === true) state.remoteHits += 1;
  else state.executed += 1;
  state.hits = state.localHits + state.remoteHits;
}

/** Canonical options already resolve rc/config overrides; the original event does not. */
function cacheTestResultsSetting(commandLine) {
  const sections = commandLine.sections ?? [];
  if (!Array.isArray(sections)) throw new Error('Invalid command-line sections');
  let setting = 'auto';
  for (const section of sections) {
    if (!isObject(section)) throw new Error('Invalid command-line section');
    if (section.optionList === undefined) continue;
    if (!isObject(section.optionList)) throw new Error('Invalid option list');
    const options = section.optionList.option ?? [];
    if (!Array.isArray(options)) throw new Error('Invalid options');
    for (const option of options) {
      if (!isObject(option)) throw new Error('Invalid option');
      if (option.optionName !== 'cache_test_results') continue;
      // Bazel's TriStateConverter accepts the same aliases as BooleanConverter.
      const value = String(option.optionValue ?? '').toLowerCase();
      if (['yes', 'true', '1', 't', 'y'].includes(value)) setting = 'yes';
      else if (['no', 'false', '0', 'f', 'n'].includes(value)) setting = 'no';
      else setting = value === 'auto' ? 'auto' : 'unknown';
    }
  }
  return setting;
}

function testCacheRow(report) {
  const { command, hits, observed, localHits, remoteHits, executed, cacheSetting, partial, available } = report;
  const rate = !available || observed === 0
    ? 'n/a' : `${((hits / observed) * 100).toFixed(2).replace(/\.00$/, '')}%`;
  const setting = { yes: 'Enabled', no: 'Disabled', auto: 'Auto', unknown: 'Unknown' }[cacheSetting];
  const status = !available
    ? 'Unavailable'
    : observed === 0
      ? 'No attempts'
      : partial
        ? 'Partial data'
        : cacheSetting === 'no'
          ? 'Disabled'
          : hits > 0
            ? 'Used'
            : 'No hits';
  return [
    command, available ? `${hits} / ${observed}` : '—', rate,
    ...[localHits, remoteHits, executed].map((count) => available ? String(count) : '—'),
    setting || 'Unknown',
    status,
  ];
}

function formatTestCacheTableRow(report) {
  return `| ${testCacheRow(report).join(' | ')} |\n`;
}

/** Use the same columns and values in the terminal and GitHub summary. */
function formatTestCacheReport(reports) {
  const rows = [TEST_CACHE_HEADERS, ...reports.map(testCacheRow)];
  const widths = TEST_CACHE_HEADERS.map((_, column) =>
    Math.max(...rows.map((row) => row[column].length)));
  const border = `+${widths.map((width) => '-'.repeat(width + 2)).join('+')}+`;
  const line = (row) => `| ${row.map((cell, column) => cell.padEnd(widths[column])).join(' | ')} |`;
  return [border, line(rows[0]), border, ...rows.slice(1).map(line), border].join('\n');
}

export {
  TEST_CACHE_HEADERS,
  TEST_CACHE_METRIC_NOTE,
  clearTestCacheReports,
  formatTestCacheReport,
  formatTestCacheTableRow,
  summarizeTestCacheFile,
  testCachePaths,
  testCacheReportingEnabled,
};
