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
import {
  canSaveAfterFailure,
  logLocalCacheSize,
  RESTORE_RESULT,
  restore,
  restoreOutput,
} from './cache.js';
import { createConfiguration, installManagedBazelrc } from './config.js';
import {
  ensureComparisonHistory,
  lockFileChanged,
  resolveComparisonBase,
  resolveDefaultBranch,
} from './git.js';
import {
  cacheSaveDisallowReason,
  isCacheSaveRef,
  needsLockFileCheck,
  parseCacheSaveBranchPatterns,
  parseCacheConfiguration,
  resolveRestoreModes,
  resolveSaveModes,
} from './inputs.js';

/**
 * Configure Bazel and restore the selected caches before the caller's build.
 * Validation happens before any side effect so invalid configuration cannot
 * leave behind a partial setup or trigger an unnecessary cache download.
 */
async function run() {
  try {
    if (process.platform !== 'linux') {
      throw new Error(
        `setup-bazel-cache supports Linux runners only, not '${process.platform}'.`,
      );
    }

    const workspace = process.env.GITHUB_WORKSPACE;
    if (!workspace) throw new Error('GITHUB_WORKSPACE is not set.');

    const diskCacheKey = core.getInput('disk-cache-key', { required: true });
    const rawCacheSaveBranchPatterns = core.getInput('cache-save-branch-patterns');
    const cacheSaveBranchPatterns = parseCacheSaveBranchPatterns(
      rawCacheSaveBranchPatterns,
      rawCacheSaveBranchPatterns.trim() ? undefined : resolveDefaultBranch(),
    );
    const cacheModes = parseCacheConfiguration({
      bazeliskCacheRestore: core.getInput('bazelisk-cache-restore'),
      bazeliskCacheSave: core.getInput('bazelisk-cache-save'),
      diskCacheRestore: core.getInput('disk-cache-restore'),
      diskCacheSave: core.getInput('disk-cache-save'),
      repositoryCacheRestore: core.getInput('repository-cache-restore'),
      repositoryCacheSave: core.getInput('repository-cache-save'),
    });

    const configuration = createConfiguration(workspace, diskCacheKey);

    const ref = process.env.GITHUB_REF || '';
    const cacheSaveAllowed = isCacheSaveRef(ref, cacheSaveBranchPatterns);
    const cacheSaveReason = cacheSaveDisallowReason(ref, cacheSaveBranchPatterns);
    const saves = resolveSaveModes(cacheModes.save, cacheSaveAllowed);
    let checkoutHistory = 'skipped';
    let changed = null;
    if (needsLockFileCheck(cacheModes.restore, cacheSaveAllowed)) {
      const comparisonBase = resolveComparisonBase();
      checkoutHistory = ensureComparisonHistory(workspace, comparisonBase);
      changed = lockFileChanged(workspace, comparisonBase);
    }
    const restores = resolveRestoreModes(
      cacheModes.restore,
      cacheSaveAllowed,
      changed === true,
    );

    logDecision({
      cacheModes,
      cacheSaveAllowed,
      cacheSaveReason,
      cacheSaveBranchPatterns,
      checkoutHistory,
      configuration,
      changed,
      restores,
      saves,
    });

    setDecisionOutputs({
      cacheSaveAllowed,
      checkoutHistory,
      changed,
    });

    fs.writeFileSync(configuration.bazelrc, configuration.bazelrcContents, { flag: 'wx' });
    core.info(`Created ${configuration.bazelrc}`);
    // Bazel supports the BAZELRC environment RC file starting with Bazel 9;
    // Bazel 8 and earlier require a standard rc file or an explicit --bazelrc.
    const bazelrcFiles = [process.env.BAZELRC, configuration.bazelrc].filter(Boolean);
    core.exportVariable('BAZELRC', bazelrcFiles.join(','));

    for (const cache of [configuration.caches.disk, configuration.caches.repository]) {
      for (const cachePath of cache.paths) fs.mkdirSync(cachePath, { recursive: true });
    }

    const restoreResults = {
      bazelisk: await restoreCache(configuration, configuration.caches.bazelisk, restores.bazelisk),
      disk: await restoreCache(configuration, configuration.caches.disk, restores.disk),
      repository: await restoreCache(
        configuration,
        configuration.caches.repository,
        restores.repository,
      ),
    };
    setRestoreOutputs(restoreResults);
    core.info(
      `Restore summary: bazelisk=${restoreResults.bazelisk}, ` +
      `disk=${restoreResults.disk}, repository=${restoreResults.repository}`,
    );

    core.saveState('setup-bazel-cache-user-bazelrc', configuration.userBazelrc);
    installManagedBazelrc(configuration);
    core.info(`Added Bazel 8 compatibility import to ${configuration.userBazelrc}`);

    const failedJobCacheSaveAllowed =
      cacheSaveAllowed && canSaveAfterFailure(restoreResults, saves);
    core.setOutput(
      '_failed-job-cache-save-allowed',
      failedJobCacheSaveAllowed.toString(),
    );
    core.exportVariable(
      configuration.additiveCacheSaveEnvironment,
      failedJobCacheSaveAllowed.toString(),
    );
    core.info(`Additive cache save after job failure: ${failedJobCacheSaveAllowed}`);
    core.saveState(
      configuration.cacheSaveState,
      JSON.stringify({
        cacheSaveAllowed,
        repositoryCacheSaveMode: cacheModes.save.repository,
        saves,
        diskCacheKey,
        workspace,
        bazeliskVersion: configuration.caches.bazelisk.keySuffix,
        restoreResults,
      }),
    );
  } catch (error) {
    core.setFailed(error.stack || error.message);
  }
}

async function restoreCache(configuration, cacheConfiguration, shouldRestore) {
  if (!shouldRestore) {
    core.info(`Skipping ${cacheConfiguration.name} cache restore`);
    logLocalCacheSize(cacheConfiguration, 'Local size without restore');
    return RESTORE_RESULT.SKIPPED;
  }
  return restore(configuration, cacheConfiguration);
}

function setDecisionOutputs({
  cacheSaveAllowed,
  checkoutHistory,
  changed,
}) {
  core.setOutput('cache-save-branch-evaluated', cacheSaveAllowed.toString());
  core.setOutput('_checkout-history', checkoutHistory);
  core.setOutput('_lock-file-changed', changed === null ? 'unknown' : changed.toString());
}

function logDecision({
  cacheModes,
  cacheSaveAllowed,
  cacheSaveReason,
  cacheSaveBranchPatterns,
  checkoutHistory,
  configuration,
  changed,
  restores,
  saves,
}) {
  core.startGroup('Bazel cache decision');
  core.info(`Ref: ${process.env.GITHUB_REF || '(unknown)'}`);
  core.info(`Cache-save branch patterns: ${cacheSaveBranchPatterns.join(', ')}`);
  core.info(
    `Cache saving allowed: ${cacheSaveAllowed}` +
    (cacheSaveAllowed
      ? ''
      : ` (${cacheSaveReason})`),
  );
  logModeTable(cacheModes, restores, saves);
  if (cacheModes.restore.disk === 'auto' && cacheSaveAllowed) {
    core.info(
      `Automatic disk-cache decision: MODULE.bazel.lock changed=${changed === null ? 'unknown' : changed}; ` +
      `checkout history=${checkoutHistory}`,
    );
  }
  core.info(`Bazelisk version key: ${configuration.caches.bazelisk.keySuffix}`);
  core.info(`Bazelrc: ${configuration.bazelrc}`);
  core.info(
    `Cache directories: bazelisk=${configuration.caches.bazelisk.paths.join(',')}, ` +
    `disk=${configuration.caches.disk.paths.join(',')}, ` +
    `repository=${configuration.caches.repository.paths.join(',')}`,
  );
  core.endGroup();
}

function logModeTable(cacheModes, restores, saves) {
  const headers = [
    'Cache',
    'Restore requested',
    'Restore effective',
    'Save requested',
    'Save effective',
  ];
  const rows = [
    ['bazelisk', cacheModes.restore.bazelisk, restores.bazelisk, cacheModes.save.bazelisk, saves.bazelisk],
    ['disk', cacheModes.restore.disk, restores.disk, cacheModes.save.disk, saves.disk],
    ['repository', cacheModes.restore.repository, restores.repository, cacheModes.save.repository, saves.repository],
  ].map((row) => row.map((value) => value.toString()));
  const widths = headers.map((header, index) => Math.max(
    header.length,
    ...rows.map((row) => row[index].length),
  ));
  const border = `+${widths.map((width) => '-'.repeat(width + 2)).join('+')}+`;
  const formatRow = (row) =>
    `| ${row.map((value, index) => value.padEnd(widths[index])).join(' | ')} |`;

  core.info('Mode matrix:');
  core.info(border);
  core.info(formatRow(headers));
  core.info(border);
  for (const row of rows) core.info(formatRow(row));
  core.info(border);
}

function setRestoreOutputs({ bazelisk, disk, repository }) {
  core.setOutput('bazelisk-cache-restored', restoreOutput(bazelisk));
  core.setOutput('disk-cache-restored', restoreOutput(disk));
  core.setOutput('repository-cache-restored', restoreOutput(repository));
}

run();
