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
 * Encode a dynamic cache-key component without introducing a structural dot.
 *
 * A doubled underscore is reserved for this encoding. Rejecting it at the
 * boundary makes the mapping reversible while retaining ordinary underscores
 * exactly as users supplied them. A dot next to an underscore is rejected as
 * well: both `._` and `_.` would otherwise produce the same three-underscore
 * sequence after encoding.
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
  return value.replaceAll('.', '__');
}

/** Build the stable prefix shared by all keys in one cache family. */
function formatCacheKeyPrefix(baseKey, family, platform, components = []) {
  return [baseKey, family, platform, ...components].join('.') + '.';
}

export {
  CACHE_KEY_NAMESPACE,
  formatCacheComponent,
  formatCacheKeyPrefix,
};
