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
import { createConfiguration } from './config.js';
import {
  ensureComparisonHistory,
  lockFileChanged,
  resolveComparisonBase,
  resolveDefaultBranch,
} from './git.js';
import {
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

    const cacheSaveAllowed = isCacheSaveRef(
      process.env.GITHUB_REF || '',
      cacheSaveBranchPatterns,
    );
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
    const bazelrcFiles = [process.env.BAZELRC, configuration.bazelrc].filter(Boolean);
    core.exportVariable('BAZELRC', bazelrcFiles.join(','));

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
  core.info(`Cache saving allowed: ${cacheSaveAllowed}`);
  core.info(
    `Restore modes: requested bazelisk=${cacheModes.restore.bazelisk}, ` +
    `disk=${cacheModes.restore.disk}, repository=${cacheModes.restore.repository}; ` +
    `effective bazelisk=${restores.bazelisk}, disk=${restores.disk}, ` +
    `repository=${restores.repository}`,
  );
  core.info(
    `Save modes: requested bazelisk=${cacheModes.save.bazelisk}, ` +
    `disk=${cacheModes.save.disk}, repository=${cacheModes.save.repository}; ` +
    `effective bazelisk=${saves.bazelisk}, disk=${saves.disk}, ` +
    `repository=${saves.repository}`,
  );
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

function setRestoreOutputs({ bazelisk, disk, repository }) {
  core.setOutput('bazelisk-cache-restored', restoreOutput(bazelisk));
  core.setOutput('disk-cache-restored', restoreOutput(disk));
  core.setOutput('repository-cache-restored', restoreOutput(repository));
}

run();
