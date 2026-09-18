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

import * as core from '@actions/core';
import fs from 'node:fs';
import { formatBytes } from './cache-size.js';
import {
  EXECUTION_LOG_METRIC_NOTE,
  summarizeExecutionLog,
} from './execution-log.js';
import {
  invocationFilePaths,
  invocationLabel,
  invocationRootPath,
  listInvocations,
} from './invocation.js';
import {
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
} from './report-format.js';
import {
  TEST_CACHE_DISABLED_NOTE,
  TEST_CACHE_METRIC_NOTE,
  formatTestCacheReport,
  summarizeTestCacheFile,
  testCacheReportIsDisabled,
} from './test-cache.js';
import { profilingEnabled } from './profiling.js';
import { summarizeProfileFile } from './profile-analysis.js';

/** Report cache reuse from every captured build-like Bazel invocation. */
async function logExecutionCacheSummary(root = invocationRootPath()) {
  if (core.getInput('report-cache-hits').trim().toLowerCase() !== 'true') return null;

  const invocations = listInvocations(root)
    .filter((invocation) => invocation.metrics?.executionLog === true);
  if (invocations.length === 0) return null;

  const reports = [];
  for (const invocation of invocations) {
    const logPath = invocationFilePaths(invocation.directory).executionLog;
    let report;
    try {
      report = fs.existsSync(logPath)
        ? await summarizeExecutionLog(logPath)
        : unavailableExecutionReport();
    } catch (error) {
      core.warning(
        `Bazel ${invocationLabel(invocation)} execution-log analysis failed: ${error.stack || error}`,
      );
      report = unavailableExecutionReport();
    }
    reports.push({
      ...report,
      command: invocationLabel(invocation),
      baseCommand: invocation.command,
      targets: invocation.targets || [],
      sequence: invocation.sequence,
      startedAt: invocation.startedAt,
      finishedAt: invocation.finishedAt,
    });
  }
  if (reports.length === 0) return null;

  const aggregates = aggregateExecutionReports(reports);
  const visibleReports = aggregates.filter(hasObservedData);
  if (visibleReports.length > 0) {
    core.info('Bazel build cache');
    logTable(
      ['Command', 'Cached / total', 'Hit rate', 'Cache hits', 'Ran', 'Report'],
      visibleReports.map(executionTableRow),
    );
    core.info('');
  }
  core.startGroup('Bazel build cache details');
  core.info('Every captured Bazel build, run, test, and coverage invocation is reported separately.');
  core.info(EXECUTION_LOG_METRIC_NOTE);
  for (const report of reports) logExecutionReport(report);
  core.endGroup();
  return { reports, aggregates };
}

/** Report cached test attempts from every captured test and coverage invocation. */
async function logTestCacheSummary(root = invocationRootPath()) {
  if (core.getInput('report-test-cache-hits').trim().toLowerCase() !== 'true') return null;

  const invocations = listInvocations(root)
    .filter((invocation) => invocation.metrics?.testCache === true);
  if (invocations.length === 0) return null;

  const reports = [];
  for (const invocation of invocations) {
    const reportPath = invocationFilePaths(invocation.directory).testCache;
    const report = fs.existsSync(reportPath)
      ? await summarizeTestCacheFile(reportPath)
      : unavailableTestCacheReport();
    reports.push({
      ...report,
      command: invocationLabel(invocation),
      baseCommand: invocation.command,
      targets: invocation.targets || [],
      sequence: invocation.sequence,
      startedAt: invocation.startedAt,
      finishedAt: invocation.finishedAt,
    });
  }

  const aggregates = aggregateTestCacheReports(reports);
  const visibleReports = aggregates.filter(hasObservedData);
  const detailsNotes = [];
  const summaryNotes = [];
  if (reports.some(testCacheReportIsDisabled)) {
    if (visibleReports.length > 0) core.info(TEST_CACHE_DISABLED_NOTE);
    summaryNotes.push(TEST_CACHE_DISABLED_NOTE);
  }
  if (visibleReports.length > 0) {
    core.info('Bazel test cache');
    core.info(formatTestCacheReport(visibleReports));
  }
  if (reports.some((report) => report.available && report.partial)) {
    const note = 'Partial: only readable test-cache records are counted; some report data was incomplete.';
    detailsNotes.push(note);
    summaryNotes.push(note);
  }
  if (reports.some((report) => report.available && report.observed === 0)) {
    const note = 'No test runs were observed: the hit rate is n/a.';
    detailsNotes.push(note);
    summaryNotes.push(note);
  }
  core.startGroup('Bazel test cache details');
  core.info(TEST_CACHE_METRIC_NOTE);
  // The shared table (also used for the aggregate view above and the step
  // summary) has no target column, and the step summary itself is optional
  // (report-cache-step-summary), so list targets here to keep this the one
  // place a specific invocation's targets are always available.
  core.info('Per-invocation targets:');
  for (const report of reports) {
    core.info(`  ${report.command}: ${formatSummaryTargets(report.targets)}`);
  }
  core.info('Per-invocation details:');
  core.info(formatTestCacheReport(reports));
  for (const note of detailsNotes) core.info(note);
  core.endGroup();
  return { reports, aggregates, notes: summaryNotes };
}

/** Resolve the opt-out step-summary input; the job log is reported regardless. */
function writeCacheStepSummaryEnabled(value) {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error("Input 'report-cache-step-summary' must be one of: true, false");
}

/** Write grouped invocation details and a separate setup-cache restore table. */
async function writeCacheSummary(execution, tests, state) {
  if (!writeCacheStepSummaryEnabled(core.getInput('report-cache-step-summary'))) return;

  // Keep the summary opt-in with the two reporting inputs. Restore details
  // enrich an enabled report; they do not create an otherwise empty report.
  const reportingEnabled = core.getInput('report-cache-hits').trim().toLowerCase() === 'true' ||
    core.getInput('report-test-cache-hits').trim().toLowerCase() === 'true';
  if (!execution && !tests && !reportingEnabled) return;

  const invocationRows = [
    ...(execution?.reports || [])
      .map((report) => cacheSummaryRow('Build cache', report)),
    ...(tests?.reports || [])
      .map((report) => cacheSummaryRow('Test cache', report)),
  ];
  const invocationGroups = groupInvocationRows(invocationRows);
  const restoreRows = cacheRestoreSummaryRows(state);
  const notes = tests?.notes || [];

  let summary = core.summary.addHeading('Bazel cache summary').addEOL();
  summary = summary.addRaw(
    'Each invocation is shown once with its targets and duration. Cache results are grouped below the invocation; setup-cache restores are listed separately.\n\n',
  );
  if (invocationGroups.length === 0 && restoreRows.length === 0) {
    summary = summary.addRaw('No cache data was available for this job.\n\n');
  } else {
    for (const group of invocationGroups) {
      summary = summary.addHeading(formatInvocationHeading(group), 3).addEOL();
      summary = summary.addRaw(`**Targets:** ${group.targets}\n\n`);
      summary = summary.addRaw(
        '| Cache | Reused / total | Hit rate | Status |\n' +
        '| --- | ---: | ---: | --- |\n',
      );
      for (const row of group.rows) {
        summary = summary.addRaw(
          `| ${row.cache} | ${row.cached} | ${row.rate} | ${row.status} |\n`,
        );
      }
      summary = summary.addRaw('\n');
    }

    if (restoreRows.length > 0) {
      summary = summary.addHeading('Restored caches', 3).addEOL();
      summary = summary.addRaw(
        '| Cache | Restored / total | Rate | Status |\n' +
        '| --- | ---: | ---: | --- |\n',
      );
      for (const row of restoreRows) {
        summary = summary.addRaw(
          `| ${row.cache} | ${row.cached} | ${row.rate} | ${row.status} |\n`,
        );
      }
      summary = summary.addRaw('\n');
    }
  }
  for (const note of notes) summary = summary.addRaw(`${note}\n\n`);
  await summary.write();
}

function logExecutionReport(report) {
  for (const line of formatExecutionReport(report).trimEnd().split('\n')) core.info(line);
  core.info('');
}

/** Print a compact performance summary from the profiles already collected. */
function logProfileAnalysis(root = invocationRootPath()) {
  if (!profilingEnabled(core.getInput('enable-profiling'))) return;

  const profiles = listInvocations(root)
    .filter((invocation) => invocation.metrics?.profile === true)
    .map((invocation) => ({
      invocation,
      path: invocationFilePaths(invocation.directory).profile,
    }))
    .filter(({ path: profile }) => fs.existsSync(profile));
  if (profiles.length === 0) return;

  const summaries = [];
  for (const { invocation, path: profile } of profiles) {
    try {
      summaries.push({
        label: invocationLabel(invocation),
        summary: summarizeProfileFile(profile),
      });
    } catch (error) {
      core.warning(`Bazel profile analysis failed for ${profile}: ${error.stack || error}`);
    }
  }
  if (summaries.length === 0) return;

  core.startGroup('Bazel profile analysis');
  core.info('Action durations are cumulative across concurrent actions, not wall-clock time.');
  const summaryHeaders = ['Profile', 'Bazel', 'Elapsed', 'Critical path', 'Action events'];
  const summaryRows = summaries.map(({ label, summary }) => [
    label,
    summary.bazelVersion,
    formatDuration(summary.totalSeconds),
    formatDuration(summary.criticalPathSeconds),
    summary.actionEventCount.toString(),
  ]);
  logTable(summaryHeaders, summaryRows);

  const phaseRows = summaries.flatMap(({ label, summary }) => summary.phaseDurations.map((phase) => [
    label,
    `${phase.from} -> ${phase.to}`,
    formatDuration(phase.seconds),
  ]));
  if (phaseRows.length > 0) {
    core.info('Profile phase intervals:');
    logTable(['Profile', 'Interval', 'Duration'], phaseRows);
  }

  const actionRows = summaries.flatMap(({ label, summary }) => summary.actionStats.slice(0, 8).map((action) => [
    label,
    action.mnemonic,
    action.count.toString(),
    formatDuration(action.totalSeconds),
    formatDuration(action.maxSeconds),
  ]));
  if (actionRows.length > 0) {
    core.info('Slowest action classes by cumulative duration:');
    logTable(['Profile', 'Mnemonic', 'Count', 'Cumulative', 'Slowest'], actionRows);
  }
  core.endGroup();
}

function logTable(headers, rows) {
  const widths = headers.map((header, index) => Math.max(
    header.length,
    ...rows.map((row) => row[index].length),
  ));
  const border = `+${widths.map((width) => '-'.repeat(width + 2)).join('+')}+`;
  const formatRow = (row) =>
    `| ${row.map((value, index) => value.padEnd(widths[index])).join(' | ')} |`;

  core.info(border);
  core.info(formatRow(headers));
  core.info(border);
  for (const row of rows) core.info(formatRow(row));
  core.info(border);
}

/** Print one compact overview after all cache save attempts have completed. */
function logSaveSummary(results) {
  const headers = ['Cache', 'Before', 'After', 'Uploaded', 'Result'];
  const size = (value) => value === null ? 'unknown' : formatBytes(value);
  const rows = results.map((result) => [
    result.cache,
    size(result.sizeBefore),
    size(result.sizeAfter),
    result.uploaded ? 'yes' : 'no',
    result.status,
  ]);

  core.startGroup('Bazel cache save summary');
  core.info('Sizes are uncompressed local payloads; uploading does not remove local data.');
  logTable(headers, rows);
  core.endGroup();
}

export {
  logExecutionCacheSummary,
  logProfileAnalysis,
  logSaveSummary,
  logTestCacheSummary,
  writeCacheStepSummaryEnabled,
  writeCacheSummary,
};
