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
  cacheLabel,
  canSaveAfterFailure,
  logLocalCacheSize,
  RESTORE_RESULT,
  restore,
  restoreOutput,
} from './cache.js';
import { createConfiguration, installManagedBazelrc } from './config.js';
import {
  configureExternalCache,
  resolveOutputBase,
  restoreExternalCaches,
} from './external.js';
import { clearProfiles, profilingEnabled } from './profiling.js';
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
import { restoreSummaryRows } from './summary.js';

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
    const enableProfiling = profilingEnabled(core.getInput('enable-profiling'));
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
      externalCacheRestore: core.getInput('external-cache-restore'),
      externalCacheSave: core.getInput('external-cache-save'),
      repositoryCacheRestore: core.getInput('repository-cache-restore'),
      repositoryCacheSave: core.getInput('repository-cache-save'),
    });

    const configuration = createConfiguration(workspace, diskCacheKey, {
      enableProfiling,
      externalCacheEnabled: cacheModes.restore.external || cacheModes.save.external,
    });
    if (configuration.profiles) {
      clearProfiles(configuration.profiles);
      core.info('Bazel profiling enabled; later build/test invocations overwrite their profiles.');
    }

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

    fs.writeFileSync(configuration.bazelrc, configuration.bazelrcContents, { flag: 'wx' });
    core.info(`Created ${configuration.bazelrc}`);
    // Bazel supports the BAZELRC environment RC file starting with Bazel 9;
    // Bazel 8 and earlier require a standard rc file or an explicit --bazelrc.
    const bazelrcFiles = [process.env.BAZELRC, configuration.bazelrc].filter(Boolean);
    core.exportVariable('BAZELRC', bazelrcFiles.join(','));

    if (configuration.external) {
      installManagedBazelrc(configuration);
      core.info(`Added Bazel 8 compatibility import to ${configuration.userBazelrc}`);
      try {
        configureExternalCache(configuration, resolveOutputBase(workspace));
      } catch (error) {
        core.warning(`External cache disabled because Bazel output_base could not be resolved: ${error.stack || error}`);
        configuration.external = null;
        restores.external = false;
        saves.external = false;
      }
    }

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

    for (const cache of [configuration.caches.disk, configuration.caches.repository]) {
      fs.mkdirSync(cache.path, { recursive: true });
    }

    const restoreDetails = {
      bazelisk: await restoreCache(configuration, configuration.caches.bazelisk, restores.bazelisk),
      disk: await restoreCache(configuration, configuration.caches.disk, restores.disk),
      repository: await restoreCache(
        configuration,
        configuration.caches.repository,
        restores.repository,
      ),
    };
    restoreDetails.external = restores.external && configuration.external
      ? await restoreExternalCaches(configuration)
      : {
        result: RESTORE_RESULT.SKIPPED,
        sizeBefore: 0,
        sizeAfter: 0,
        manifest: null,
        repositories: {},
      };
    const restoreResults = {
      bazelisk: restoreDetails.bazelisk.result,
      disk: restoreDetails.disk.result,
      repository: restoreDetails.repository.result,
      external: restoreDetails.external.result,
    };
    setRestoreOutputs(restoreResults);
    logRestoreSummary(configuration, restoreDetails);
    const repositoryCacheStartSize = logLocalCacheSize(
      configuration,
      configuration.caches.repository,
      'Repository cache baseline after restore',
    );

    if (!configuration.external) {
      installManagedBazelrc(configuration);
      core.info(`Added Bazel 8 compatibility import to ${configuration.userBazelrc}`);
    }

    // The post condition is shared by all cache families. If external saving
    // is selected, suppress the whole failed-job path so external repositories
    // can only be published after a successful workflow.
    const failedJobCacheSaveAllowed =
      cacheSaveAllowed && !saves.external && canSaveAfterFailure(restoreResults, saves);
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
        externalCacheEnabled: Boolean(configuration.external),
        externalManifestRestoreResult: restoreDetails.external.manifest?.result || RESTORE_RESULT.SKIPPED,
        externalRepositoryRestoreResults: Object.fromEntries(
          Object.entries(restoreDetails.external.repositories).map(([name, detail]) => [name, detail.result]),
        ),
        outputBase: configuration.external?.outputBase || null,
        restoreResults,
        repositoryCacheStartSize,
      }),
    );
  } catch (error) {
    core.setFailed(error.stack || error.message);
  }
}

async function restoreCache(configuration, cacheConfiguration, shouldRestore) {
  if (!shouldRestore) {
    core.info(`Skipping ${cacheLabel(configuration, cacheConfiguration)} cache restore`);
    const size = logLocalCacheSize(configuration, cacheConfiguration, 'Local size without restore');
    return { result: RESTORE_RESULT.SKIPPED, sizeBefore: size, sizeAfter: size };
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
    `Cache directories: bazelisk=${configuration.caches.bazelisk.path}, ` +
    `disk=${configuration.caches.disk.path}, ` +
    `repository=${configuration.caches.repository.path}` +
    (configuration.external ? `, external=${configuration.external.root}` : ''),
  );
  core.endGroup();
}

/** Print a bordered, column-aligned table of pre-stringified cell values. */
function printTable(title, headers, rows) {
  const widths = headers.map((header, index) => Math.max(
    header.length,
    ...rows.map((row) => row[index].length),
  ));
  const border = `+${widths.map((width) => '-'.repeat(width + 2)).join('+')}+`;
  const formatRow = (row) =>
    `| ${row.map((value, index) => value.padEnd(widths[index])).join(' | ')} |`;

  core.info(title);
  core.info(border);
  core.info(formatRow(headers));
  core.info(border);
  for (const row of rows) core.info(formatRow(row));
  core.info(border);
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
    ['external', cacheModes.restore.external, restores.external, cacheModes.save.external, saves.external],
    ['repository', cacheModes.restore.repository, restores.repository, cacheModes.save.repository, saves.repository],
  ].map((row) => row.map((value) => value.toString()));
  printTable('Mode matrix:', headers, rows);
}

/** Print one compact overview of all restores once they have completed. */
function logRestoreSummary(configuration, restoreDetails) {
  printTable(
    'Restore summary (local uncompressed size after restore):',
    ['Cache', 'Result', 'Local size'],
    restoreSummaryRows(configuration, restoreDetails),
  );
}

function setRestoreOutputs({ bazelisk, disk, repository, external }) {
  core.setOutput('bazelisk-cache-restored', restoreOutput(bazelisk));
  core.setOutput('disk-cache-restored', restoreOutput(disk));
  core.setOutput('repository-cache-restored', restoreOutput(repository));
  core.setOutput('external-cache-restored', restoreOutput(external));
}

run();
