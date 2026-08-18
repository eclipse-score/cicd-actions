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
  parseRepositoryCacheSave,
  parseRestoreConfiguration,
  resolveRestoreConfiguration,
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
        `setup-bazel-cache-experimental supports Linux runners only, not '${process.platform}'.`,
      );
    }

    const workspace = process.env.GITHUB_WORKSPACE;
    if (!workspace) throw new Error('GITHUB_WORKSPACE is not set.');

    const diskCacheName = core.getInput('disk-cache-name', { required: true });
    const rawCacheSaveBranches = core.getInput('cache-save-branches');
    const cacheSaveBranches = parseCacheSaveBranches(
      rawCacheSaveBranches,
      rawCacheSaveBranches.trim() ? undefined : resolveDefaultBranch(),
    );
    const repositoryCacheSaveRequested = parseRepositoryCacheSave(
      core.getInput('save-repository-cache'),
    );
    const restoreConfiguration = parseRestoreConfiguration({
      skipDiskCacheRestore: core.getInput('skip-disk-cache-restore'),
      skipRepositoryCacheRestore: core.getInput('skip-repository-cache-restore'),
    });

    const configuration = createConfiguration(workspace, diskCacheName);

    const cacheSave = isCacheSaveRef(process.env.GITHUB_REF || '', cacheSaveBranches);
    const repositoryCacheSave = cacheSave && repositoryCacheSaveRequested;
    let checkoutHistory = 'skipped';
    let changed = null;
    if (needsLockFileCheck(restoreConfiguration, cacheSave)) {
      const comparisonBase = resolveComparisonBase();
      checkoutHistory = ensureComparisonHistory(workspace, comparisonBase);
      changed = lockFileChanged(workspace, comparisonBase);
    }
    const restoreModes = resolveRestoreConfiguration(restoreConfiguration, cacheSave, changed === true);

    setDecisionOutputs({
      cacheSave,
      checkoutHistory,
      changed,
      repositoryCacheSave,
      restoreModes,
    });

    fs.writeFileSync(configuration.bazelrc, configuration.bazelrcContents, { flag: 'wx' });
    core.info(`Created ${configuration.bazelrc}`);
    const bazelrcFiles = [process.env.BAZELRC, configuration.bazelrc].filter(Boolean);
    core.exportVariable('BAZELRC', bazelrcFiles.join(','));

    const restoreResults = {
      bazelisk: await restoreCache(configuration, configuration.caches.bazelisk, restoreModes.skipBazelisk),
      disk: await restoreCache(configuration, configuration.caches.disk, restoreModes.skipDisk),
      repository: await restoreCache(
        configuration,
        configuration.caches.repository,
        restoreModes.skipRepository,
      ),
    };
    setRestoreOutputs(restoreResults);

    const failedJobCacheSave = cacheSave && canSaveAfterFailure(
      restoreResults,
      repositoryCacheSave,
    );
    core.setOutput('failed-job-cache-save', failedJobCacheSave.toString());
    core.exportVariable(
      configuration.additiveCacheSaveEnvironment,
      failedJobCacheSave.toString(),
    );
    core.saveState(
      configuration.cacheSaveState,
      JSON.stringify({ cacheSave, repositoryCacheSave, diskCacheName, workspace }),
    );
  } catch (error) {
    core.setFailed(error.stack || error.message);
  }
}

async function restoreCache(configuration, cacheConfiguration, skip) {
  if (skip) {
    core.info(`Skipping ${cacheConfiguration.name} cache restore`);
    return RESTORE_RESULT.SKIPPED;
  }
  return restore(configuration, cacheConfiguration);
}

function setDecisionOutputs({
  cacheSave,
  checkoutHistory,
  changed,
  repositoryCacheSave,
  restoreModes,
}) {
  core.setOutput('cache-save', cacheSave.toString());
  core.setOutput('repository-cache-save', repositoryCacheSave.toString());
  core.setOutput('skip-bazelisk-cache-restore', restoreModes.skipBazelisk.toString());
  core.setOutput('skip-disk-cache-restore', restoreModes.skipDisk.toString());
  core.setOutput('skip-repository-cache-restore', restoreModes.skipRepository.toString());
  core.setOutput('checkout-history', checkoutHistory);
  core.setOutput('lock-file-changed', changed === null ? 'unknown' : changed.toString());
}

function setRestoreOutputs({ bazelisk, disk, repository }) {
  core.setOutput('bazelisk-cache-restored', bazelisk);
  core.setOutput('disk-cache-restored', disk);
  core.setOutput('repository-cache-restored', repository);
}

run();
