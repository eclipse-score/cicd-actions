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
import * as glob from '@actions/glob';
import fs from 'node:fs';
import path from 'node:path';

const RESTORE_RESULT = Object.freeze({
  FALSE: 'false',
  PARTIAL: 'partial',
  SKIPPED: 'skipped',
  TRUE: 'true',
  UNKNOWN: 'unknown',
});

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
const REPOSITORY_CACHE_GROWTH_PERCENT = 10;

/** Keep the restored generation key available to the post action. */
function restoredKeyState(cacheConfiguration) {
  return `setup-bazel-cache-restored-key-${cacheConfiguration.name}`;
}

/** Return the uncompressed size of one local path without following symlinks. */
function localPathSize(root) {
  const pending = [root];
  let bytes = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    let entry;
    try {
      entry = fs.lstatSync(current);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }

    if (entry.isSymbolicLink()) continue;
    if (!entry.isDirectory()) {
      bytes += entry.size;
      continue;
    }

    for (const child of fs.readdirSync(current)) {
      pending.push(path.join(current, child));
    }
  }

  return bytes;
}

/** Format local cache sizes compactly for one-line action log messages. */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const unitIndex = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    BYTE_UNITS.length - 1,
  );
  const value = bytes / (1024 ** unitIndex);
  const precision = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${BYTE_UNITS[unitIndex]}`;
}

/** Describe a cache path when its aggregate payload is empty. */
function describeLocalCachePath(cachePath) {
  try {
    const entry = fs.lstatSync(cachePath);
    if (entry.isSymbolicLink()) return `${cachePath}: symlink (ignored)`;
    if (!entry.isDirectory()) return `${cachePath}: file (${formatBytes(entry.size)})`;

    const directEntries = fs.readdirSync(cachePath).length;
    if (directEntries === 0) return `${cachePath}: empty directory`;
    return `${cachePath}: directory with ${directEntries} direct entries and ` +
      `${formatBytes(localPathSize(cachePath))} recursive payload`;
  } catch (error) {
    if (error.code === 'ENOENT') return `${cachePath}: missing`;
    return `${cachePath}: unavailable (${error.message || error})`;
  }
}

/** Log a best-effort local size without allowing diagnostics to affect caching. */
function logLocalCacheSize(cacheConfiguration, label) {
  try {
    const bytes = localPathSize(cacheConfiguration.path);
    const details = bytes === 0
      ? `; path status: ${describeLocalCachePath(cacheConfiguration.path)}`
      : '';
    core.info(`${label}: ${formatBytes(bytes)} uncompressed local data${details}`);
    return bytes;
  } catch (error) {
    core.warning(
      `Could not measure ${cacheConfiguration.name} cache size: ${error.message || error}`,
    );
    return null;
  }
}

/** Expose successful exact and fallback restores as true without losing internal detail. */
function restoreOutput(result) {
  return result === RESTORE_RESULT.TRUE || result === RESTORE_RESULT.PARTIAL
    ? RESTORE_RESULT.TRUE
    : RESTORE_RESULT.FALSE;
}

/** Return the stable cache-family prefix used for fallback restores. */
function cachePrefix(configuration, cacheConfiguration) {
  return `${configuration.baseKey}-${cacheConfiguration.name}-`;
}

/** Generate the readable timestamp generation suffix owned by this action. */
function generationSuffix() {
  return Date.now().toString();
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

/** A failed job may publish only caches that extend successfully restored snapshots. */
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
function skippedSaveSummary(cacheConfiguration, status) {
  const sizeBefore = logLocalCacheSize(cacheConfiguration, 'Local payload before save');
  const sizeAfter = logLocalCacheSize(cacheConfiguration, 'Local payload after save');
  return {
    cache: cacheConfiguration.name,
    sizeBefore,
    sizeAfter,
    uploaded: false,
    status,
  };
}

/** Build the primary key and ordered fallback prefixes for one cache. */
async function keyPlan(configuration, cacheConfiguration) {
  const prefix = cachePrefix(configuration, cacheConfiguration);
  let contentPrefix = prefix;
  if (cacheConfiguration.keySuffix) {
    contentPrefix = `${prefix}${cacheConfiguration.keySuffix}`;
  } else if (cacheConfiguration.files.length > 0) {
    const hash = await glob.hashFiles(
      cacheConfiguration.files.join('\n'),
      configuration.workspace,
      { followSymbolicLinks: false },
    );
    contentPrefix = `${prefix}${hash}`;
  }

  if (!cacheConfiguration.generational) {
    return { key: contentPrefix, restoreKeys: [] };
  }

  const generationPrefix = `${contentPrefix}${contentPrefix === prefix ? '' : '-'}`;
  return {
    key: `${generationPrefix}${generationSuffix()}`,
    restoreKeys: generationPrefix === prefix ? [prefix] : [generationPrefix, prefix],
  };
}

/** Create the primary cache key used by focused key-generation tests and saves. */
async function exactKey(configuration, cacheConfiguration) {
  return (await keyPlan(configuration, cacheConfiguration)).key;
}

/** Keep exact-hit state names consistent between the main and post processes. */
function hitState(cacheConfiguration) {
  return `cache-hit-${cacheConfiguration.name}`;
}

/**
 * Restore the exact generation or the newest cache in the same family.
 * Cache outages are warnings because caching must never make a build unusable.
 */
async function restore(configuration, cacheConfiguration) {
  core.startGroup(`Restore ${cacheConfiguration.name} cache`);
  logLocalCacheSize(cacheConfiguration, 'Local size before restore');
  try {
    const { key, restoreKeys } = await keyPlan(configuration, cacheConfiguration);
    const restoredKey = await cache.restoreCache(
      [cacheConfiguration.path],
      key,
      restoreKeys,
      { segmentTimeoutInMs: 300000 }
    );
    if (!restoredKey) {
      core.info('No matching cache found');
      return RESTORE_RESULT.FALSE;
    }
    core.info(`Restored ${restoredKey}`);
    core.saveState(restoredKeyState(cacheConfiguration), restoredKey);
    if (!cacheConfiguration.generational && restoredKey === key) {
      core.saveState(hitState(cacheConfiguration), 'true');
    }
    return restoredKey === key ? RESTORE_RESULT.TRUE : RESTORE_RESULT.PARTIAL;
  } catch (error) {
    core.warning(`Cache restore failed: ${error.stack || error}`);
    return RESTORE_RESULT.UNKNOWN;
  } finally {
    logLocalCacheSize(cacheConfiguration, 'Local size after restore');
    core.endGroup();
  }
}

/**
 * Publish a cache generation from the post action. Exact immutable content hits
 * are not uploaded again, while additive caches always receive a new generation.
 */
async function save(configuration, cacheConfiguration, restoreResult) {
  core.startGroup(`Save ${cacheConfiguration.name} cache`);
  const result = {
    cache: cacheConfiguration.name,
    sizeBefore: logLocalCacheSize(cacheConfiguration, 'Local payload before save'),
    sizeAfter: null,
    uploaded: false,
    status: 'not attempted',
  };
  try {
    if (!cacheConfiguration.generational && core.getState(hitState(cacheConfiguration)) === 'true') {
      core.info(`Not saving exact ${cacheConfiguration.name} cache hit`);
      result.status = 'exact cache hit';
      return result;
    }
    if (!shouldSave(cacheConfiguration, restoreResult)) {
      core.info(
        `Not saving ${cacheConfiguration.name} cache because its restore failed; ` +
        'the existing generation is preserved.',
      );
      result.status = 'restore failed';
      return result;
    }
    if (result.sizeBefore === 0) {
      core.info(
        `Not saving ${cacheConfiguration.name} cache because its local payload is empty; ` +
        'there is no cache archive to upload.',
      );
      result.status = 'empty payload';
      return result;
    }

    const key = await exactKey(configuration, cacheConfiguration);
    const cacheId = await cache.saveCache([cacheConfiguration.path], key);
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
    result.sizeAfter = logLocalCacheSize(cacheConfiguration, 'Local payload after save');
    core.endGroup();
  }
  return result;
}

/** Return whether a key is one of this action's own timestamped generations. */
function isOwnedGenerationKey(configuration, cacheConfiguration, cacheKey) {
  if (!cacheConfiguration.generational || typeof cacheKey !== 'string') return false;
  const prefix = cachePrefix(configuration, cacheConfiguration);
  return cacheKey.startsWith(prefix) && /^\d+$/.test(cacheKey.slice(prefix.length));
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
  const cacheName = cacheConfiguration?.name || 'cache';

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
    const url = new URL(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/caches`,
      apiUrl,
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
      core.info(`Deleted previous ${cacheName} cache generation ${cacheKey}`);
      return true;
    }

    if (response.status === 401 || response.status === 403 || response.status === 404) {
      core.info(
        `${cacheName} cache cleanup skipped because the GitHub token lacks permission ` +
        `to delete caches. ${permissionHint}`,
      );
    } else {
      core.warning(
        `${cacheName} cache cleanup failed for ${cacheKey}: ` +
        `GitHub API returned HTTP ${response.status} ${response.statusText}`,
      );
    }
  } catch (error) {
    core.warning(`${cacheName} cache cleanup failed for ${cacheKey}: ${error.message || error}`);
  }
  return false;
}

export {
  cachePrefix,
  canSaveAfterFailure,
  exactKey,
  keyPlan,
  RESTORE_RESULT,
  restore,
  restoreOutput,
  save,
  skippedSaveSummary,
  shouldSaveRepositoryCache,
  shouldSave,
  formatBytes,
  describeLocalCachePath,
  deleteCacheByKey,
  isOwnedGenerationKey,
  logLocalCacheSize,
  localPathSize,
  repositoryCacheGrewByTenPercent,
  restoredKeyState,
};
