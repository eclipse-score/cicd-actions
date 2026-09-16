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
import path from 'node:path';
import { cacheLabel } from './cache-keys.js';

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

/** Return the paths that make up a cache payload, supporting one or many paths. */
function cachePaths(cacheConfiguration) {
  return cacheConfiguration.paths || [cacheConfiguration.path];
}

/** Measure all paths in a cache payload without double-counting identical paths. */
function localCacheSize(cacheConfiguration) {
  return [...new Set(cachePaths(cacheConfiguration))]
    .reduce((total, cachePath) => total + localPathSize(cachePath), 0);
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
function logLocalCacheSize(configuration, cacheConfiguration, label) {
  try {
    const paths = cachePaths(cacheConfiguration);
    const bytes = localCacheSize(cacheConfiguration);
    const details = bytes === 0
      ? `; path status: ${paths.map(describeLocalCachePath).join(', ')}`
      : '';
    core.info(`${label}: ${formatBytes(bytes)} uncompressed local data${details}`);
    return bytes;
  } catch (error) {
    core.warning(
      `Could not measure ${cacheLabel(configuration, cacheConfiguration)} cache size: ` +
      `${error.message || error}`,
    );
    return null;
  }
}

export {
  cachePaths,
  describeLocalCachePath,
  formatBytes,
  localCacheSize,
  localPathSize,
  logLocalCacheSize,
};
