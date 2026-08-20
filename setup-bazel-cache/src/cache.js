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

/** Generate the readable, prune-compatible timestamp generation suffix. */
function generationSuffix() {
  return Date.now().toString();
}

/** Decide whether repository auto mode should publish a cache generation. */
function shouldSaveRepositoryCache(mode, restoreResult) {
  return mode === 'true' || (mode === 'auto' && restoreResult === RESTORE_RESULT.FALSE);
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
  logLocalCacheSize,
  localPathSize,
};
