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
import { DefaultArtifactClient } from '@actions/artifact';
import path from 'node:path';
import {
  cacheLabel,
  deleteCacheByKey,
  formatBytes,
  logLocalCacheSize,
  save,
  shouldSaveRepositoryCache,
  restoredKeyState,
  skippedSaveSummary,
} from './cache.js';
import { createConfiguration } from './config.js';
import { configureExternalCache, saveExternalCaches } from './external.js';
import {
  EXECUTION_LOG_METRIC_NOTE,
  existingExecutionLogs,
  executionLogPaths,
  summarizeExecutionLog,
} from './execution-log.js';
import {
  TEST_CACHE_HEADERS,
  TEST_CACHE_METRIC_NOTE,
  formatTestCacheReport,
  formatTestCacheTableRow,
  summarizeTestCacheFile,
  testCachePaths,
} from './test-cache.js';
import { existingProfiles, profilePaths, profilingEnabled } from './profiling.js';
import { summarizeProfileFile } from './profile-analysis.js';

const PROFILE_ARTIFACT_NAME = 'bazel-profiles';

/** Report cacheable spawns from the latest invocation of each Bazel command. */
async function logExecutionCacheSummary() {
  if (core.getInput('report-cache-hits').trim().toLowerCase() !== 'true') return;

  const logs = executionLogPaths();
  const existing = existingExecutionLogs(logs);
  if (existing.length === 0) return;

  const reports = [];
  for (const [command, logPath] of existing) {
    try {
      reports.push({ command, ...(await summarizeExecutionLog(logPath)) });
    } catch (error) {
      core.warning(`Bazel ${command} execution-log analysis failed: ${error.stack || error}`);
    }
  }
  if (reports.length === 0) return;

  core.info('Bazel build cache');
  logTable(
    ['Command', 'Cached / total', 'Hit rate', 'Cache hits', 'Ran', 'Report'],
    reports.map(executionTableRow),
  );
  core.info('');
  core.startGroup('Bazel build cache details');
  core.info('Latest Bazel invocation only; repeated calls overwrite earlier data.');
  core.info(EXECUTION_LOG_METRIC_NOTE);
  for (const report of reports) logExecutionReport(report);
  core.endGroup();

  try {
    let summary = core.summary.addHeading('Bazel build cache report (latest invocation only)');
    summary = summary.addRaw(
      'This report covers only the latest Bazel invocation. Repeated calls overwrite earlier data.\n\n',
    );
    summary = summary.addRaw(`${EXECUTION_LOG_METRIC_NOTE}\n\n`);
    summary = summary.addRaw(
      '| Command | Cached / total | Hit rate | Cache hits | Ran | Report |\n' +
      '| --- | ---: | ---: | --- | --- | --- |\n',
    );
    for (const report of reports) summary = summary.addRaw(formatExecutionTableRow(report));
    await summary.write();
  } catch (error) {
    core.warning(`Bazel cache report summary could not be written: ${error.stack || error}`);
  }
}

/** Report cached test attempts from the latest test and coverage invocations. */
async function logTestCacheSummary() {
  if (core.getInput('report-test-cache-hits').trim().toLowerCase() !== 'true') return;

  const reports = [];
  for (const [command, reportPath] of Object.entries(testCachePaths())) {
    reports.push({ command, ...(await summarizeTestCacheFile(reportPath)) });
  }

  core.info('Bazel test cache');
  core.info(formatTestCacheReport(reports));
  const notes = [];
  if (reports.some((report) => !report.available)) notes.push(
    'Unavailable: no readable test-cache data. The command may not have run or may have used another report path.',
  );
  if (reports.some((report) => report.available && report.partial)) notes.push(
    'Partial: only readable test-cache records are counted; some report data was incomplete.',
  );
  if (reports.some((report) => report.cacheSetting === 'no')) notes.push(
    'Disabled: test-result caching was turned off for this invocation.',
  );
  if (reports.some((report) => report.available && report.observed === 0)) notes.push(
    'No test runs were observed: the hit rate is n/a.',
  );
  core.startGroup('Bazel test cache details');
  core.info(TEST_CACHE_METRIC_NOTE);
  for (const note of notes) core.info(note);
  core.info('The build-cache and test-cache percentages are different views of cache reuse; do not combine them.');
  core.endGroup();

  try {
    let summary = core.summary.addHeading('Bazel test cache');
    summary = summary.addRaw(`${TEST_CACHE_METRIC_NOTE}\n\n`);
    summary = summary.addRaw(
      `| ${TEST_CACHE_HEADERS.join(' | ')} |\n` +
      '| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |\n',
    );
    for (const report of reports) summary = summary.addRaw(formatTestCacheTableRow(report));
    summary = summary.addRaw('\n');
    for (const note of notes) summary = summary.addRaw(`${note}\n\n`);
    summary = summary.addRaw(
      'The build-cache and test-cache percentages are different views of cache reuse; do not combine them.\n\n',
    );
    await summary.write();
  } catch {
    core.summary.emptyBuffer();
    core.info('Bazel test cache: step summary unavailable; see the job log.');
  }
}

/** Optional diagnostics must not prevent another report or a cache save. */
async function reportSafely(name, report) {
  try {
    await report();
  } catch {
    core.summary.emptyBuffer();
    core.info(`${name} unavailable; continuing post-step processing.`);
  }
}

function logExecutionReport(report) {
  for (const line of formatExecutionReport(report).trimEnd().split('\n')) core.info(line);
  core.info('');
}

function formatExecutionReport({ command, hits, observed, hitRunners, executedRunners, partial }) {
  const percentage = observed === 0 ? 'n/a' : `${((hits / observed) * 100).toFixed(2).replace(/\.00$/, '')}%`;
  const label = command === 'build' ? 'build/run' : command;
  const lines = [
    `Bazel ${label} cache: ${hits} / ${observed} cached (${percentage})`,
    `  Cache hits: ${formatRunnerCounts(hitRunners, 'none', true)}`,
    `  Ran: ${formatRunnerCounts(executedRunners, 'none', false)}`,
  ];
  if (partial) {
    lines.push('Note: some cache details were incomplete; counts may be incomplete.');
  }
  return `${lines.join('\n')}\n\n`;
}

function executionTableRow({ command, hits, observed, hitRunners, executedRunners, partial }) {
  const label = command === 'build' ? 'build/run' : command;
  const percentage = observed === 0 ? 'n/a' : `${((hits / observed) * 100).toFixed(2).replace(/\.00$/, '')}%`;
  return [
    label,
    `${hits} / ${observed}`,
    percentage,
    formatRunnerCounts(hitRunners, 'none', true),
    formatRunnerCounts(executedRunners, 'none', false),
    partial ? 'Partial' : 'Complete',
  ];
}

function formatExecutionTableRow(report) {
  return `| ${executionTableRow(report).map(escapeTableCell).join(' | ')} |\n`;
}

function escapeTableCell(value) {
  return value.replaceAll('|', '\\|');
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

/** Print a compact performance summary from the profiles already collected. */
function logProfileAnalysis() {
  if (!profilingEnabled(core.getInput('enable-profiling'))) return;

  const files = existingProfiles(profilePaths());
  if (files.length === 0) return;

  const summaries = [];
  for (const profile of files) {
    try {
      summaries.push(summarizeProfileFile(profile));
    } catch (error) {
      core.warning(`Bazel profile analysis failed for ${profile}: ${error.stack || error}`);
    }
  }
  if (summaries.length === 0) return;

  core.startGroup('Bazel profile analysis');
  core.info('Action durations are cumulative across concurrent actions, not wall-clock time.');
  const summaryHeaders = ['Profile', 'Bazel', 'Elapsed', 'Critical path', 'Action events'];
  const summaryRows = summaries.map((summary) => [
    path.basename(summary.name),
    summary.bazelVersion,
    formatDuration(summary.totalSeconds),
    formatDuration(summary.criticalPathSeconds),
    summary.actionEventCount.toString(),
  ]);
  logTable(summaryHeaders, summaryRows);

  const phaseRows = summaries.flatMap((summary) => summary.phaseDurations.map((phase) => [
    path.basename(summary.name),
    `${phase.from} -> ${phase.to}`,
    formatDuration(phase.seconds),
  ]));
  if (phaseRows.length > 0) {
    core.info('Profile phase intervals:');
    logTable(['Profile', 'Interval', 'Duration'], phaseRows);
  }

  const actionRows = summaries.flatMap((summary) => summary.actionStats.slice(0, 8).map((action) => [
    path.basename(summary.name),
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
  const widths = headers.map((header, index) => Math.max(
    header.length,
    ...rows.map((row) => row[index].length),
  ));
  const border = `+${widths.map((width) => '-'.repeat(width + 2)).join('+')}+`;
  const formatRow = (row) =>
    `| ${row.map((value, index) => value.padEnd(widths[index])).join(' | ')} |`;

  core.startGroup('Bazel cache save summary');
  core.info('Sizes are uncompressed local payloads; uploading does not remove local data.');
  core.info(border);
  core.info(formatRow(headers));
  core.info(border);
  for (const row of rows) core.info(formatRow(row));
  core.info(border);
  core.endGroup();
}

/**
 * Save caches after the caller's steps. State written by main proves setup
 * completed and carries the already-resolved permission to write caches.
 */
async function run() {
  try {
    const state = core.getState('setup-bazel-cache-configuration');
    if (!state) {
      core.info('Setup did not complete; caches will not be saved');
      return;
    }

    await reportSafely('Bazel build cache report', logExecutionCacheSummary);
    await reportSafely('Bazel test cache report', logTestCacheSummary);
    await uploadProfiles();
    logProfileAnalysis();

    const {
      cacheSaveAllowed,
      repositoryCacheSaveMode = 'true',
      saves,
      diskCacheKey,
      workspace,
      bazeliskVersion,
      restoreResults,
      repositoryCacheStartSize = null,
      externalCacheEnabled = false,
      externalManifestRestoreResult = 'skipped',
      externalRepositoryRestoreResults = {},
      outputBase = null,
    } = JSON.parse(state);
    if (!cacheSaveAllowed) {
      core.info('Cache saving is disabled on this ref');
      return;
    }

    const configuration = createConfiguration(workspace, diskCacheKey, {
      bazeliskVersion,
      externalCacheEnabled,
      outputBase,
    });
    if (configuration.external) configureExternalCache(configuration, outputBase);
    const results = [];
    if (saves.bazelisk) {
      results.push(await save(configuration, configuration.caches.bazelisk, restoreResults?.bazelisk));
    } else {
      core.info('Bazelisk cache saving is disabled for this job');
      results.push(skippedSaveSummary(configuration, configuration.caches.bazelisk, 'disabled'));
    }
    if (saves.disk) {
      const diskResult = await save(
        configuration,
        configuration.caches.disk,
        restoreResults?.disk,
      );
      results.push(diskResult);
      if (diskResult.uploaded) {
        await cleanupPreviousGeneration(configuration, configuration.caches.disk);
      }
    } else {
      core.info('Disk cache saving is disabled for this job');
      results.push(skippedSaveSummary(configuration, configuration.caches.disk, 'disabled'));
    }
    const repositoryCacheSizeBeforeSave = repositoryCacheSaveMode === 'auto'
      ? logLocalCacheSize(
        configuration,
        configuration.caches.repository,
        'Repository cache size before automatic save decision',
      )
      : null;
    if (
      saves.repository &&
      shouldSaveRepositoryCache(
        repositoryCacheSaveMode,
        restoreResults?.repository,
        repositoryCacheStartSize,
        repositoryCacheSizeBeforeSave,
      )
    ) {
      const repositoryResult = await save(
        configuration,
        configuration.caches.repository,
        restoreResults?.repository,
      );
      results.push(repositoryResult);
      if (repositoryResult.uploaded) {
        await cleanupPreviousGeneration(configuration, configuration.caches.repository);
      }
    } else if (saves.repository && repositoryCacheSaveMode === 'auto') {
      if (repositoryCacheStartSize === null || repositoryCacheSizeBeforeSave === null) {
        core.info(
          'Repository cache automatic save skipped because its start or end size could not be measured',
        );
      } else {
        core.info(
          'Repository cache automatic save skipped because the local cache grew by less than 10% ' +
          `(${formatBytes(repositoryCacheStartSize)} -> ${formatBytes(repositoryCacheSizeBeforeSave)})`,
        );
      }
      results.push(skippedSaveSummary(configuration, configuration.caches.repository, 'existing cache preserved'));
    } else {
      core.info('Repository cache saving is disabled for this job');
      results.push(skippedSaveSummary(configuration, configuration.caches.repository, 'disabled'));
    }
    if (saves.external && configuration.external) {
      results.push(...await saveExternalCaches(
        configuration,
        externalManifestRestoreResult,
        externalRepositoryRestoreResults,
        cleanupPreviousGeneration,
      ));
    } else if (saves.external) {
      core.info('External cache saving is disabled because its output base was not resolved');
    }
    logSaveSummary(results);
  } catch (error) {
    core.setFailed(error.stack || error.message);
  }
}

/** Upload the last build and test profiles without modifying them. */
async function uploadProfiles() {
  if (!profilingEnabled(core.getInput('enable-profiling'))) return;

  const profiles = profilePaths();
  const files = existingProfiles(profiles);
  if (files.length === 0) {
    core.info('Bazel profiling enabled, but no build or test profile was produced');
    return;
  }

  try {
    const artifact = new DefaultArtifactClient();
    const result = await artifact.uploadArtifact(
      PROFILE_ARTIFACT_NAME,
      files,
      path.dirname(files[0]),
      { compressionLevel: 0 },
    );
    core.info(
      `Uploaded ${files.length} Bazel profile(s) as '${PROFILE_ARTIFACT_NAME}' ` +
      `(artifact ${result.id ?? 'unknown'}, ${result.size ?? 'unknown'} bytes)`,
    );
  } catch (error) {
    core.warning(`Bazel profile upload failed: ${error.stack || error}`);
  }
}

/** Remove only the prior generation restored by this action, after upload. */
async function cleanupPreviousGeneration(configuration, cacheConfiguration) {
  const previousKey = core.getState(restoredKeyState(cacheConfiguration));
  if (!previousKey) {
    core.info(
      `${cacheLabel(configuration, cacheConfiguration)} cache cleanup skipped because no previous ` +
      'cache generation was restored',
    );
    return;
  }

  await deleteCacheByKey(previousKey, {
    configuration,
    cacheConfiguration,
  });
}

run();
