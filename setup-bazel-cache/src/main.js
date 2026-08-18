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
import { canSaveAfterFailure, RESTORE_RESULT, restore } from './cache.js';
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
  parseCacheSaveBranches,
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
    const rawCacheSaveBranches = core.getInput('cache-save-branches');
    const cacheSaveBranches = parseCacheSaveBranches(
      rawCacheSaveBranches,
      rawCacheSaveBranches.trim() ? undefined : resolveDefaultBranch(),
    );
    const cacheModes = parseCacheConfiguration({
      diskCacheRestore: core.getInput('disk-cache-restore'),
      diskCacheSave: core.getInput('disk-cache-save'),
      repositoryCacheRestore: core.getInput('repository-cache-restore'),
      repositoryCacheSave: core.getInput('repository-cache-save'),
    });

    const configuration = createConfiguration(workspace, diskCacheKey);

    const cacheSave = isCacheSaveRef(process.env.GITHUB_REF || '', cacheSaveBranches);
    const saves = resolveSaveModes(cacheModes.save, cacheSave);
    let checkoutHistory = 'skipped';
    let changed = null;
    if (needsLockFileCheck(cacheModes.restore, cacheSave)) {
      const comparisonBase = resolveComparisonBase();
      checkoutHistory = ensureComparisonHistory(workspace, comparisonBase);
      changed = lockFileChanged(workspace, comparisonBase);
    }
    const restores = resolveRestoreModes(cacheModes.restore, cacheSave, changed === true);

    setDecisionOutputs({
      cacheSave,
      checkoutHistory,
      changed,
      saves,
      restores,
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

    const failedJobCacheSave = cacheSave && canSaveAfterFailure(restoreResults, saves);
    core.setOutput('failed-job-cache-save', failedJobCacheSave.toString());
    core.exportVariable(
      configuration.additiveCacheSaveEnvironment,
      failedJobCacheSave.toString(),
    );
    core.saveState(
      configuration.cacheSaveState,
      JSON.stringify({ cacheSave, saves, diskCacheKey, workspace }),
    );
  } catch (error) {
    core.setFailed(error.stack || error.message);
  }
}

async function restoreCache(configuration, cacheConfiguration, shouldRestore) {
  if (!shouldRestore) {
    core.info(`Skipping ${cacheConfiguration.name} cache restore`);
    return RESTORE_RESULT.SKIPPED;
  }
  return restore(configuration, cacheConfiguration);
}

function setDecisionOutputs({
  cacheSave,
  checkoutHistory,
  changed,
  saves,
  restores,
}) {
  core.setOutput('cache-save', cacheSave.toString());
  core.setOutput('disk-cache-save', saves.disk.toString());
  core.setOutput('repository-cache-save', saves.repository.toString());
  core.setOutput('bazelisk-cache-restore', restores.bazelisk.toString());
  core.setOutput('disk-cache-restore', restores.disk.toString());
  core.setOutput('repository-cache-restore', restores.repository.toString());
  core.setOutput('checkout-history', checkoutHistory);
  core.setOutput('lock-file-changed', changed === null ? 'unknown' : changed.toString());
}

function setRestoreOutputs({ bazelisk, disk, repository }) {
  core.setOutput('bazelisk-cache-restored', bazelisk);
  core.setOutput('disk-cache-restored', disk);
  core.setOutput('repository-cache-restored', repository);
}

run();
