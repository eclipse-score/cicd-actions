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

// Pure data shaping and text formatting for the post-step cache report: no
// @actions/core or filesystem access, so every function here is testable with
// plain input/output assertions. report.js is the imperative shell that reads
// invocation files, calls into this module, and prints or writes the result.

import { DISABLED_CACHE_STATUS } from './test-cache.js';
import { formatInvocationSequence } from './invocation.js';
import { formatPercentage } from './format.js';

function unavailableExecutionReport() {
  return {
    hits: 0,
    executed: 0,
    observed: 0,
    hitRunners: [],
    executedRunners: [],
    available: false,
    partial: true,
  };
}

function unavailableTestCacheReport() {
  return {
    hits: 0,
    observed: 0,
    localHits: 0,
    remoteHits: 0,
    executed: 0,
    cacheSetting: 'unknown',
    completed: false,
    malformedLines: 0,
    validEvents: 0,
    readError: 'ENOENT',
    available: false,
    partial: true,
  };
}

function aggregateExecutionReports(reports) {
  const groups = new Map();
  for (const report of reports) {
    const current = groups.get(report.baseCommand) || {
      command: report.baseCommand,
      baseCommand: report.baseCommand,
      invocationCount: 0,
      hits: 0,
      executed: 0,
      observed: 0,
      hitRunners: new Map(),
      executedRunners: new Map(),
      available: false,
      partial: false,
    };
    current.invocationCount += 1;
    current.hits += report.hits;
    current.executed += report.executed;
    current.observed += report.observed;
    current.available ||= report.available !== false;
    current.partial ||= report.partial;
    mergeRunnerCounts(current.hitRunners, report.hitRunners);
    mergeRunnerCounts(current.executedRunners, report.executedRunners);
    groups.set(report.baseCommand, current);
  }
  return [...groups.values()].map((report) => ({
    ...report,
    hitRunners: sortRunnerCounts(report.hitRunners),
    executedRunners: sortRunnerCounts(report.executedRunners),
  }));
}

function aggregateTestCacheReports(reports) {
  const groups = new Map();
  for (const report of reports) {
    const current = groups.get(report.baseCommand) || {
      command: report.baseCommand,
      baseCommand: report.baseCommand,
      invocationCount: 0,
      hits: 0,
      observed: 0,
      localHits: 0,
      remoteHits: 0,
      executed: 0,
      cacheSettings: new Set(),
      available: false,
      partial: false,
    };
    current.invocationCount += 1;
    current.hits += report.hits;
    current.observed += report.observed;
    current.localHits += report.localHits;
    current.remoteHits += report.remoteHits;
    current.executed += report.executed;
    if (report.available && report.cacheSetting !== 'unknown') {
      current.cacheSettings.add(report.cacheSetting);
    }
    current.available ||= report.available !== false;
    current.partial ||= report.partial;
    groups.set(report.baseCommand, current);
  }
  return [...groups.values()].map((report) => ({
    ...report,
    cacheSetting: report.cacheSettings.size === 0
      ? 'unknown'
      : report.cacheSettings.size === 1
        ? [...report.cacheSettings][0]
        : 'mixed',
  }));
}

function mergeRunnerCounts(target, counts) {
  for (const { runner, count } of counts || []) {
    target.set(runner, (target.get(runner) || 0) + count);
  }
}

function sortRunnerCounts(counts) {
  return [...counts.entries()]
    .sort(([leftName, leftCount], [rightName, rightCount]) =>
      rightCount - leftCount || leftName.localeCompare(rightName))
    .map(([runner, count]) => ({ runner, count }));
}

/** Combine build and test metrics that belong to the same Bazel invocation. */
function groupInvocationRows(rows) {
  const groups = new Map();
  for (const row of [...rows].sort((left, right) => left.order - right.order)) {
    const key = row.sequence === undefined
      ? `label:${row.invocation || row.command}`
      : `sequence:${row.sequence}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        sequence: row.sequence,
        invocation: row.invocation,
        command: row.command,
        targets: row.targets,
        elapsed: row.elapsed,
        order: row.order,
        rows: [],
      };
      groups.set(key, group);
    }
    group.rows.push(row);
  }
  return [...groups.values()].sort((left, right) => left.order - right.order);
}

/** Give each invocation a compact heading that remains easy to correlate. */
function formatInvocationHeading(group) {
  const command = group.command || group.invocation || 'unknown';
  const sequence = group.sequence === undefined ? '' : ` · ${formatInvocationSequence(group.sequence)}`;
  return `${command}${sequence} · ${group.elapsed}`;
}

function hasObservedData(report) {
  return report.available === undefined
    ? report.observed > 0
    : report.available && report.observed > 0;
}

function cacheSummaryRow(cache, report) {
  const available = report.available !== false;
  const rate = available ? formatPercentage(report.hits, report.observed) : 'n/a';
  const command = report.baseCommand || report.command;
  return {
    invocation: report.command || command,
    command,
    sequence: report.sequence,
    targets: formatSummaryTargets(report.targets),
    elapsed: formatInvocationElapsed(report.startedAt, report.finishedAt),
    cache,
    cached: available ? `${report.hits} / ${report.observed}` : '—',
    rate,
    status: invocationStatus(report),
    // Sequence order makes repeated and concurrent Bazel commands easy to
    // correlate. Restore rows use a separate range and stay at the end.
    order: report.sequence === undefined
      ? 10000 + commandOrder(command) * 2 + (cache.startsWith('Test') ? 1 : 0)
      : report.sequence * 2 + (cache.startsWith('Test') ? 1 : 0),
  };
}

/** Keep user-provided target patterns in one Markdown table cell. */
function formatSummaryTargets(targets) {
  if (!Array.isArray(targets) || targets.length === 0) return 'not captured';
  return targets.map((target) => String(target)
    .replaceAll('\\', '\\\\')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('|', '\\|')
    .replaceAll('\r', ' ')
    .replaceAll('\n', ' ')).join(', ');
}

/** Use outcome words in the overview; report completeness belongs in details. */
function invocationStatus(report) {
  if (report.available === false) return 'Unavailable';
  if (report.partial) return 'Partial data';
  if (report.observed === 0) return 'No data';
  if (report.cacheSetting === 'mixed') return 'Mixed settings';
  if (report.cacheSetting === 'no') return DISABLED_CACHE_STATUS;
  return report.hits > 0 ? 'Used' : 'No hits';
}

function commandOrder(command) {
  return { build: 0, run: 1, test: 2, coverage: 3 }[command] ?? 99;
}

/** Format the actual wall-clock time recorded for one Bazel invocation. */
function formatInvocationElapsed(startedAt, finishedAt) {
  if (typeof startedAt !== 'string' || typeof finishedAt !== 'string') return 'n/a';
  const start = Date.parse(startedAt);
  const finish = Date.parse(finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(finish) || finish < start) return 'n/a';
  return formatDuration((finish - start) / 1000);
}

/** Show setup-time cache restores only when a restore was actually attempted. */
function cacheRestoreSummaryRows(state = {}) {
  const restoreResults = state.restoreResults || {};
  const caches = [
    ['bazelisk', 'Bazelisk cache'],
    ['repository', 'Repository cache'],
    ['external', 'External cache'],
  ];
  return caches.flatMap(([name, label], index) => {
    const result = String(restoreResults[name] || '').toLowerCase();
    if (!result || result === 'skipped') return [];
    const counts = name === 'external'
      ? externalRestoreCounts(state, result)
      : restoreCounts(result);
    return [{
      cache: label,
      elapsed: '—',
      ...counts,
      status: restoreStatusLabel(result, counts),
      order: 10 + index,
    }];
  });
}

/** Count external repository entries; the manifest is the fallback denominator. */
function externalRestoreCounts(state, aggregateResult) {
  const repositoryResults = Object.values(state.externalRepositoryRestoreResults || {})
    .map((result) => String(result).toLowerCase())
    .filter((result) => result && result !== 'skipped');
  if (repositoryResults.length === 0) return restoreCounts(aggregateResult);

  const hits = repositoryResults.filter((result) => result === 'true' || result === 'partial').length;
  return {
    cached: `${hits} / ${repositoryResults.length}`,
    rate: formatPercentage(hits, repositoryResults.length),
  };
}

function restoreCounts(result) {
  const restored = result === 'true' || result === 'partial';
  return {
    cached: restored ? '1 / 1' : result === 'false' ? '0 / 1' : '—',
    rate: restored ? '100%' : result === 'false' ? '0%' : '—',
  };
}

function restoreStatusLabel(result, counts) {
  if (result === 'unknown') return 'Unavailable';
  if (counts.cached !== '—' && Number.parseInt(counts.cached, 10) > 0) return 'Used';
  return result === 'true' || result === 'partial' ? 'Used' : 'Not used';
}

/**
 * This is the only place these per-invocation details are guaranteed to
 * appear: the step summary that also carries them is optional
 * (report-cache-step-summary), so this report must stand on its own.
 */
function formatExecutionReport({
  command, hits, observed, hitRunners, executedRunners, partial, targets, startedAt, finishedAt,
}) {
  const percentage = formatPercentage(hits, observed);
  const elapsed = formatInvocationElapsed(startedAt, finishedAt);
  const lines = [
    `Bazel ${command} cache: ${hits} / ${observed} cached (${percentage}) · ${elapsed}`,
    `  Targets: ${formatSummaryTargets(targets)}`,
    `  Cache hits: ${formatRunnerCounts(hitRunners, 'none', true)}`,
    `  Ran: ${formatRunnerCounts(executedRunners, 'none', false)}`,
  ];
  if (partial) {
    lines.push('Note: some cache details were incomplete; counts may be incomplete.');
  }
  return `${lines.join('\n')}\n\n`;
}

function executionTableRow({ command, hits, observed, hitRunners, executedRunners, partial }) {
  const percentage = formatPercentage(hits, observed);
  return [
    command,
    `${hits} / ${observed}`,
    percentage,
    formatRunnerCounts(hitRunners, 'none', true),
    formatRunnerCounts(executedRunners, 'none', false),
    partial ? 'Partial' : 'Complete',
  ];
}

function formatRunnerCounts(runners, emptyValue, cached) {
  if (runners.length === 0) return emptyValue;
  const totals = new Map();
  for (const { runner, count } of runners) {
    const label = friendlyRunnerLabel(runner, cached);
    totals.set(label, (totals.get(label) || 0) + count);
  }
  return [...totals.entries()].map(([label, count]) => `${count} ${label}`).join(', ');
}

/** Keep implementation-specific runner names out of the user-facing report. */
function friendlyRunnerLabel(runner, cached) {
  const normalized = runner.toLowerCase();
  if (cached) {
    if (normalized.includes('disk')) return 'disk cache';
    return 'shared cache';
  }
  return normalized.includes('remote') ? 'remote' : 'local';
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return 'unknown';
  if (seconds >= 60) return `${(seconds / 60).toFixed(1)} min`;
  return `${seconds.toFixed(1)} s`;
}

export {
  aggregateExecutionReports,
  aggregateTestCacheReports,
  cacheRestoreSummaryRows,
  cacheSummaryRow,
  executionTableRow,
  formatDuration,
  formatExecutionReport,
  formatInvocationHeading,
  formatSummaryTargets,
  groupInvocationRows,
  hasObservedData,
  unavailableExecutionReport,
  unavailableTestCacheReport,
};
