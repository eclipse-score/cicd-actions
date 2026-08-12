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
import { restore } from './cache.js';
import { createConfiguration } from './config.js';
import { ensureComparisonHistory, lockFileChanged } from './git.js';
import {
  isCacheSaveRef,
  needsLockFileCheck,
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
      throw new Error(`setup-bazel-cache supports Linux runners only, not '${process.platform}'.`);
    }

    const workspace = process.env.GITHUB_WORKSPACE;
    if (!workspace) throw new Error('GITHUB_WORKSPACE is not set.');

    const uniqueCacheName = core.getInput('unique-cache-name', { required: true });
    const mainBranch = core.getInput('main-branch') || 'main';
    const restoreConfiguration = parseRestoreConfiguration({
      skipCacheRestore: core.getInput('skip-cache-restore'),
      skipDiskCacheRestore: core.getInput('skip-disk-cache-restore'),
      skipRepositoryCacheRestore: core.getInput('skip-repository-cache-restore'),
    });
    if (restoreConfiguration.legacy) {
      // TODO(breaking-release): Remove together with the adapter in inputs.js.
      core.warning(
        "Input 'skip-cache-restore' is deprecated and will be removed in the next breaking release. " +
        "Use 'skip-disk-cache-restore' and 'skip-repository-cache-restore'."
      );
    }

    const configuration = createConfiguration(workspace, uniqueCacheName);
    if (fs.existsSync(configuration.bazelrc)) {
      throw new Error(
        `${configuration.bazelrc} already exists. setup-bazel-cache requires exclusive ownership of this file.`
      );
    }

    const cacheSave = isCacheSaveRef(process.env.GITHUB_REF, mainBranch);
    let checkoutHistory = 'skipped';
    let changed = null;
    if (needsLockFileCheck(restoreConfiguration, cacheSave)) {
      checkoutHistory = ensureComparisonHistory(workspace);
      changed = lockFileChanged(workspace);
    }
    const restoreModes = resolveRestoreConfiguration(restoreConfiguration, cacheSave, changed === true);

    core.setOutput('skip-disk-cache-restore', restoreModes.skipDisk.toString());
    core.setOutput('skip-repository-cache-restore', restoreModes.skipRepository.toString());
    core.setOutput('checkout-history', checkoutHistory);
    core.setOutput('lock-file-changed', changed === null ? 'unknown' : changed.toString());

    fs.writeFileSync(configuration.bazelrc, configuration.bazelrcContents, { flag: 'wx' });
    core.info(`Created ${configuration.bazelrc}`);

    if (restoreModes.skipBazelisk) core.info('Skipping Bazelisk cache restore');
    else await restore(configuration, configuration.caches.bazelisk);
    if (restoreModes.skipDisk) core.info('Skipping Bazel disk-cache restore');
    else await restore(configuration, configuration.caches.disk);
    if (restoreModes.skipRepository) core.info('Skipping Bazel repository-cache restore');
    else await restore(configuration, configuration.caches.repository);

    core.saveState(configuration.cacheSaveState, JSON.stringify({ cacheSave, uniqueCacheName, workspace }));
  } catch (error) {
    core.setFailed(error.stack || error.message);
  }
}

run();
