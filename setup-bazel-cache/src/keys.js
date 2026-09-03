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

const CACHE_KEY_NAMESPACE = 'setup-bazel-cache';

/**
 * Encode a dynamic cache-key component without introducing a structural slash.
 *
 * URL encoding keeps ordinary dots and underscores readable while ensuring a
 * slash supplied by a caller cannot accidentally become another key level.
 * The input restrictions are retained so existing cache-key validation stays
 * consistent across the readable key format.
 */
function formatCacheComponent(value, label = 'cache component') {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('__') ||
    value.includes('._') ||
    value.includes('_.')
  ) {
    throw new Error(
      `${label} must not be empty or contain an ambiguous dot/underscore sequence ` +
      "(the reserved '__' sequence is also rejected).",
    );
  }
  return encodeURIComponent(value);
}

/** Build the stable platform prefix shared by all keys in one cache family. */
function formatCacheKeyPrefix(baseKey, platform, family, components = []) {
  return [baseKey, platform, family, ...components].join('/') + '/';
}

export {
  CACHE_KEY_NAMESPACE,
  formatCacheComponent,
  formatCacheKeyPrefix,
};
