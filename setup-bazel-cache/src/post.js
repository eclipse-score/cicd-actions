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
import { existingProfiles, profilePaths, profilingEnabled } from './profiling.js';

const PROFILE_ARTIFACT_NAME = 'bazel-profiles';

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

    await uploadProfiles();

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

/** Upload the last build and test profiles without analyzing them in CI. */
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
