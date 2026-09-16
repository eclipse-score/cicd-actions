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

import * as glob from '@actions/glob';
import { formatCacheKeyPrefix } from './keys.js';

/** Keep content-addressed keys readable while retaining 64 bits of identity. */
const CACHE_HASH_LENGTH = 16;

/** Return the stable cache-family prefix used for fallback restores. */
function cachePrefix(configuration, cacheConfiguration) {
  return formatCacheKeyPrefix(
    configuration.baseKey,
    configuration.platform,
    cacheConfiguration.name,
    cacheConfiguration.keyComponents,
  );
}

/** The real, stable cache-key prefix shown in logs instead of the internal short name. */
function cacheLabel(configuration, cacheConfiguration) {
  return cachePrefix(configuration, cacheConfiguration).replace(/\/$/, '');
}

/** Generate the readable timestamp generation suffix owned by this action. */
function generationSuffix() {
  return Date.now().toString();
}

/** Build the primary key and ordered fallback prefixes for one cache. */
async function keyPlan(configuration, cacheConfiguration) {
  const prefix = cachePrefix(configuration, cacheConfiguration);
  let contentPrefix = prefix;
  if (cacheConfiguration.keySuffix !== undefined) {
    contentPrefix = `${prefix}version-${encodeURIComponent(cacheConfiguration.keySuffix)}`;
  } else if (cacheConfiguration.files.length > 0) {
    const hash = await glob.hashFiles(
      cacheConfiguration.files.join('\n'),
      configuration.workspace,
      { followSymbolicLinks: false },
    );
    contentPrefix = `${prefix}content-${hash.slice(0, CACHE_HASH_LENGTH)}`;
  }

  if (!cacheConfiguration.generational) {
    return { key: contentPrefix, restoreKeys: [] };
  }

  const generationPrefix = contentPrefix === prefix ? prefix : `${contentPrefix}/`;
  const generationRestorePrefix = `${generationPrefix}generation-`;
  const restoreKeys = generationPrefix === prefix
    ? [generationRestorePrefix, prefix]
    : [generationRestorePrefix, `${prefix}generation-`, prefix];
  return {
    key: `${generationRestorePrefix}${generationSuffix()}`,
    restoreKeys,
  };
}

/** Create the primary cache key used by focused key-generation tests and saves. */
async function exactKey(configuration, cacheConfiguration) {
  return (await keyPlan(configuration, cacheConfiguration)).key;
}

/** Return whether a key is one of this action's own timestamped generations. */
function isOwnedGenerationKey(configuration, cacheConfiguration, cacheKey) {
  if (!cacheConfiguration.generational || typeof cacheKey !== 'string') return false;
  const prefix = `${cachePrefix(configuration, cacheConfiguration)}generation-`;
  return cacheKey.startsWith(prefix) && /^\d+$/.test(cacheKey.slice(prefix.length));
}

export {
  cacheLabel,
  cachePrefix,
  exactKey,
  isOwnedGenerationKey,
  keyPlan,
};
