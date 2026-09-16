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

import * as cache from '@actions/cache';
import * as core from '@actions/core';
import { cacheLabel, exactKey, isOwnedGenerationKey, keyPlan } from './cache-keys.js';
import { cachePaths, formatBytes, logLocalCacheSize } from './cache-size.js';

const RESTORE_RESULT = Object.freeze({
  FALSE: 'false',
  PARTIAL: 'partial',
  SKIPPED: 'skipped',
  TRUE: 'true',
  UNKNOWN: 'unknown',
});

const REPOSITORY_CACHE_GROWTH_PERCENT = 10;

/** Keep the restored generation key available to the post action. */
function restoredKeyState(cacheConfiguration) {
  return `setup-bazel-cache-restored-key-${cacheStateName(cacheConfiguration)}`;
}

/** Keep per-cache state names distinct when a family has a dynamic component. */
function cacheStateName(cacheConfiguration) {
  return [cacheConfiguration.name, ...(cacheConfiguration.keyComponents || [])].join('-');
}

/** Expose successful exact and fallback restores as true without losing internal detail. */
function restoreOutput(result) {
  return result === RESTORE_RESULT.TRUE || result === RESTORE_RESULT.PARTIAL
    ? RESTORE_RESULT.TRUE
    : RESTORE_RESULT.FALSE;
}

/** Decide whether repository auto mode should publish a cache generation. */
function shouldSaveRepositoryCache(mode, restoreResult, startSize, endSize) {
  if (mode === 'true') return true;
  if (mode !== 'auto') return false;
  if (restoreResult === RESTORE_RESULT.FALSE) return true;
  return (
    restoreResult === RESTORE_RESULT.TRUE ||
    restoreResult === RESTORE_RESULT.PARTIAL
  ) && repositoryCacheGrewByTenPercent(startSize, endSize);
}

/** Return whether the local repository cache grew by at least ten percent. */
function repositoryCacheGrewByTenPercent(startSize, endSize) {
  if (!Number.isFinite(startSize) || !Number.isFinite(endSize)) return false;
  if (startSize === 0) return endSize > 0;
  return (endSize - startSize) * 100 >= startSize * REPOSITORY_CACHE_GROWTH_PERCENT;
}

/** A failed job may publish only the standard caches that extend restored snapshots. */
function canSaveAfterFailure(restoreResults, saves) {
  if (saves.bazelisk && restoreResults.bazelisk !== RESTORE_RESULT.TRUE) return false;

  const selected = [];
  if (saves.disk) selected.push(restoreResults.disk);
  if (saves.repository) selected.push(restoreResults.repository);
  return selected.length > 0 && selected.every(
    (result) => result === RESTORE_RESULT.TRUE || result === RESTORE_RESULT.PARTIAL,
  );
}

/** Do not make a failed generational restore the newest cache snapshot. */
function shouldSave(cacheConfiguration, restoreResult) {
  return !(
    cacheConfiguration.generational &&
    restoreResult === RESTORE_RESULT.UNKNOWN
  );
}

/** Record a cache that was deliberately not selected for upload. */
function skippedSaveSummary(configuration, cacheConfiguration, status) {
  const sizeBefore = logLocalCacheSize(configuration, cacheConfiguration, 'Local payload before save');
  const sizeAfter = logLocalCacheSize(configuration, cacheConfiguration, 'Local payload after save');
  return {
    cache: cacheLabel(configuration, cacheConfiguration),
    sizeBefore,
    sizeAfter,
    uploaded: false,
    status,
  };
}

/** Keep exact-hit state names consistent between the main and post processes. */
function hitState(cacheConfiguration) {
  return `cache-hit-${cacheStateName(cacheConfiguration)}`;
}

/**
 * Restore the exact generation or the newest cache in the same family.
 * Cache outages are warnings because caching must never make a build unusable.
 * Sizes are returned alongside the result so callers can report a combined
 * restore summary without re-measuring the cache directory.
 */
async function restore(configuration, cacheConfiguration) {
  core.startGroup(`Restore ${cacheLabel(configuration, cacheConfiguration)} cache`);
  const sizeBefore = logLocalCacheSize(configuration, cacheConfiguration, 'Local size before restore');
  let result;
  let sizeAfter;
  try {
    const { key, restoreKeys } = await keyPlan(configuration, cacheConfiguration);
    const restoredKey = await cache.restoreCache(
      cachePaths(cacheConfiguration),
      key,
      restoreKeys,
      { segmentTimeoutInMs: 300000 }
    );
    if (!restoredKey) {
      core.info('No matching cache found');
      result = RESTORE_RESULT.FALSE;
    } else {
      core.info(`Restored ${restoredKey}`);
      core.saveState(restoredKeyState(cacheConfiguration), restoredKey);
      if (!cacheConfiguration.generational && restoredKey === key) {
        core.saveState(hitState(cacheConfiguration), 'true');
      }
      result = restoredKey === key ? RESTORE_RESULT.TRUE : RESTORE_RESULT.PARTIAL;
    }
  } catch (error) {
    core.warning(`Cache restore failed: ${error.stack || error}`);
    result = RESTORE_RESULT.UNKNOWN;
  } finally {
    sizeAfter = logLocalCacheSize(configuration, cacheConfiguration, 'Local size after restore');
    core.endGroup();
  }
  return { result, sizeBefore, sizeAfter };
}

/**
 * Publish a cache generation from the post action. Exact immutable content hits
 * are not uploaded again, while additive caches always receive a new generation.
 */
async function save(configuration, cacheConfiguration, restoreResult) {
  const label = cacheLabel(configuration, cacheConfiguration);
  core.startGroup(`Save ${label} cache`);
  const result = {
    cache: label,
    sizeBefore: logLocalCacheSize(configuration, cacheConfiguration, 'Local payload before save'),
    sizeAfter: null,
    uploaded: false,
    status: 'not attempted',
  };
  try {
    if (!cacheConfiguration.generational && core.getState(hitState(cacheConfiguration)) === 'true') {
      core.info(`Not saving exact ${label} cache hit`);
      result.status = 'exact cache hit';
      return result;
    }
    if (!shouldSave(cacheConfiguration, restoreResult)) {
      core.info(
        `Not saving ${label} cache because its restore failed; ` +
        'the existing generation is preserved.',
      );
      result.status = 'restore failed';
      return result;
    }
    if (result.sizeBefore === 0) {
      core.info(
        `Not saving ${label} cache because its local payload is empty; ` +
        'there is no cache archive to upload.',
      );
      result.status = 'empty payload';
      return result;
    }

    const key = await exactKey(configuration, cacheConfiguration);
    const cacheId = await cache.saveCache(cachePaths(cacheConfiguration), key);
    if (cacheId === -1) {
      core.info(`Cache save skipped for ${key}`);
      result.status = 'cache already exists';
    } else if (typeof cacheId === 'number' && cacheId >= 0) {
      const payload = result.sizeBefore === null ? 'size unavailable' : formatBytes(result.sizeBefore);
      core.info(`Saved ${key} (local payload: ${payload})`);
      result.uploaded = true;
      result.status = 'uploaded';
    } else {
      core.warning(`Cache save returned an unexpected cache id for ${key}: ${cacheId}`);
      result.status = 'upload not confirmed';
    }
  } catch (error) {
    core.warning(`Cache save failed: ${error.stack || error}`);
    result.status = 'upload failed';
  } finally {
    result.sizeAfter = logLocalCacheSize(configuration, cacheConfiguration, 'Local payload after save');
    core.endGroup();
  }
  return result;
}

/** Delete one prior generation without making cleanup required. */
async function deleteCacheByKey(cacheKey, {
  configuration,
  cacheConfiguration,
  token = core.getInput('token'),
  apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com',
  repository = process.env.GITHUB_REPOSITORY,
  ref = process.env.GITHUB_REF,
} = {}) {
  const permissionHint =
    'Grant the action actions: write (for example, via permissions) to enable automatic cleanup.';
  const cacheName = configuration && cacheConfiguration
    ? cacheLabel(configuration, cacheConfiguration)
    : (cacheConfiguration?.name || 'cache');

  if (!configuration || !cacheConfiguration || !isOwnedGenerationKey(
    configuration,
    cacheConfiguration,
    cacheKey,
  )) {
    core.info(
      `${cacheName} cache cleanup skipped because the previous key is not an ` +
      'owned setup-bazel-cache generation.',
    );
    return false;
  }

  if (!token) {
    core.info(`${cacheName} cache cleanup skipped because no GitHub token is available. ${permissionHint}`);
    return false;
  }
  if (!repository) {
    core.info(`${cacheName} cache cleanup skipped because GITHUB_REPOSITORY is not available. ${permissionHint}`);
    return false;
  }
  if (!ref) {
    core.info(`${cacheName} cache cleanup skipped because GITHUB_REF is not available. ${permissionHint}`);
    return false;
  }

  const [owner, repo, ...unexpectedParts] = repository.split('/');
  if (!owner || !repo || unexpectedParts.length > 0) {
    core.info(`${cacheName} cache cleanup skipped because GITHUB_REPOSITORY is invalid. ${permissionHint}`);
    return false;
  }

  try {
    // A leading slash would replace apiUrl's entire path, dropping a GitHub
    // Enterprise Server base path such as /api/v3. Resolve relatively instead.
    const url = new URL(
      `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/caches`,
      apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`,
    );
    url.searchParams.set('key', cacheKey);
    url.searchParams.set('ref', ref);
    const response = await fetch(url, {
      method: 'DELETE',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'setup-bazel-cache',
      },
    });

    if (response.ok) {
      core.info(`Deleted previous cache generation ${cacheKey}`);
      return true;
    }

    if (response.status === 401 || response.status === 403 || response.status === 404) {
      core.info(
        `${cacheName} cache cleanup skipped because the GitHub token lacks permission ` +
        `to delete caches. ${permissionHint}`,
      );
    } else {
      core.warning(
        `Cache cleanup failed for ${cacheKey}: ` +
        `GitHub API returned HTTP ${response.status} ${response.statusText}`,
      );
    }
  } catch (error) {
    core.warning(`Cache cleanup failed for ${cacheKey}: ${error.message || error}`);
  }
  return false;
}

export {
  canSaveAfterFailure,
  deleteCacheByKey,
  hitState,
  restore,
  restoredKeyState,
  restoreOutput,
  RESTORE_RESULT,
  repositoryCacheGrewByTenPercent,
  save,
  shouldSave,
  shouldSaveRepositoryCache,
  skippedSaveSummary,
};
