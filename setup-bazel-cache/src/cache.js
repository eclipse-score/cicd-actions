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

const RESTORE_RESULT = Object.freeze({
  FALSE: 'false',
  PARTIAL: 'partial',
  SKIPPED: 'skipped',
  TRUE: 'true',
  UNKNOWN: 'unknown',
});

/** Return the stable cache-family prefix used for fallback restores. */
function cachePrefix(configuration, cacheConfiguration) {
  return `${configuration.baseKey}-${cacheConfiguration.name}-`;
}

/**
 * Create a unique save key. Content caches use a reproducible hash while the
 * disk cache uses generations so main can publish refreshed build outputs.
 */
async function exactKey(configuration, cacheConfiguration) {
  const prefix = cachePrefix(configuration, cacheConfiguration);
  if (cacheConfiguration.optimized) return `${prefix}${Date.now()}`;
  const hash = await glob.hashFiles(cacheConfiguration.files.join('\n'), configuration.workspace, {
    followSymbolicLinks: false,
  });
  return `${prefix}${hash}`;
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
  try {
    const key = await exactKey(configuration, cacheConfiguration);
    const restoredKey = await cache.restoreCache(
      cacheConfiguration.paths,
      key,
      [cachePrefix(configuration, cacheConfiguration)],
      { segmentTimeoutInMs: 300000 }
    );
    if (!restoredKey) {
      core.info('No matching cache found');
      return RESTORE_RESULT.FALSE;
    }
    core.info(`Restored ${restoredKey}`);
    if (!cacheConfiguration.optimized && restoredKey === key) {
      core.saveState(hitState(cacheConfiguration), 'true');
    }
    return restoredKey === key ? RESTORE_RESULT.TRUE : RESTORE_RESULT.PARTIAL;
  } catch (error) {
    core.warning(`Cache restore failed: ${error.stack || error}`);
    return RESTORE_RESULT.UNKNOWN;
  } finally {
    core.endGroup();
  }
}

/**
 * Publish a cache generation from the post action. Exact content hits are not
 * uploaded again, while the mutable disk cache always receives a new generation.
 */
async function save(configuration, cacheConfiguration) {
  if (!cacheConfiguration.optimized && core.getState(hitState(cacheConfiguration)) === 'true') {
    core.info(`Not saving exact ${cacheConfiguration.name} cache hit`);
    return;
  }

  core.startGroup(`Save ${cacheConfiguration.name} cache`);
  try {
    const key = await exactKey(configuration, cacheConfiguration);
    await cache.saveCache(cacheConfiguration.paths, key);
    core.info(`Saved ${key}`);
  } catch (error) {
    core.warning(`Cache save failed: ${error.stack || error}`);
  } finally {
    core.endGroup();
  }
}

export { cachePrefix, exactKey, RESTORE_RESULT, restore, save };
