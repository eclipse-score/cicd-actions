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
import fs from 'node:fs';
import {
  deleteCacheByKey,
  save,
  shouldSaveRepositoryCache,
  restoredKeyState,
  skippedSaveSummary,
} from './cache.js';
import { cacheLabel } from './cache-keys.js';
import { formatBytes, logLocalCacheSize } from './cache-size.js';
import { createConfiguration } from './config.js';
import { configureExternalCache, saveExternalCaches } from './external.js';
import {
  invocationFilePaths,
  invocationRootPath,
  listInvocations,
} from './invocation.js';
import { profileArtifactName, profilingEnabled } from './profiling.js';
import {
  logExecutionCacheSummary,
  logProfileAnalysis,
  logSaveSummary,
  logTestCacheSummary,
  writeCacheSummary,
} from './report.js';

/** Optional diagnostics must not prevent another report or a cache save. */
async function reportSafely(name, report) {
  try {
    return await report();
  } catch {
    core.summary.emptyBuffer();
    core.info(`${name} unavailable; continuing post-step processing.`);
    return null;
  }
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

    const savedState = JSON.parse(state);
    const invocationRoot = savedState.invocationRoot || invocationRootPath();
    const executionReport = await reportSafely(
      'Bazel build cache report',
      () => logExecutionCacheSummary(invocationRoot),
    );
    const testReport = await reportSafely(
      'Bazel test cache report',
      () => logTestCacheSummary(invocationRoot),
    );
    await reportSafely(
      'Bazel cache summary',
      () => writeCacheSummary(executionReport, testReport, savedState),
    );
    await uploadProfiles(savedState.diskCacheKey, invocationRoot);
    logProfileAnalysis(invocationRoot);

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
    } = savedState;
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
    core.warning(`Bazel cache post-processing stopped: ${error.stack || error.message || error}`);
  }
}

/** Upload every captured profile without modifying the per-invocation files. */
async function uploadProfiles(diskCacheKey, root = invocationRootPath()) {
  if (!profilingEnabled(core.getInput('enable-profiling'))) return;

  const files = listInvocations(root)
    .filter((invocation) => invocation.metrics?.profile === true)
    .map((invocation) => invocationFilePaths(invocation.directory).profile)
    .filter((profile) => fs.existsSync(profile));
  if (files.length === 0) {
    core.info('Bazel profiling enabled, but no measured invocation produced a profile');
    return;
  }

  try {
    const artifactName = profileArtifactName(diskCacheKey);
    const artifact = new DefaultArtifactClient();
    const result = await artifact.uploadArtifact(
      artifactName,
      files,
      root,
      { compressionLevel: 0 },
    );
    core.info(
      `Uploaded ${files.length} Bazel profile(s) as '${artifactName}' ` +
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
