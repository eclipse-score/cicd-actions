// *******************************************************************************
// Copyright (c) 2026 Contributors to the Eclipse Foundation
//
// See the NOTICE file(s) distributed with this work for additional
// information regarding copyright ownership.
//
// This program and the accompanying materials are made available under the
// terms of the Apache License 2.0 which is available at
// https://www.apache.org/licenses/LICENSE-2.0
//
// SPDX-License-Identifier: Apache-2.0
// *******************************************************************************

import { createHash } from 'node:crypto';

const PROFILE_ARTIFACT_PREFIX = 'bazel-profiles';
const PROFILE_ARTIFACT_MAX_LENGTH = 200;
const PROFILE_ARTIFACT_HASH_LENGTH = 10;

/** Build a readable, matrix-safe artifact name from the disk-cache key. */
function profileArtifactName(diskCacheKey) {
  const raw = typeof diskCacheKey === 'string' ? diskCacheKey : '';
  if (!raw) return `${PROFILE_ARTIFACT_PREFIX}-default`;

  const readable = raw
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const plainLimit = PROFILE_ARTIFACT_MAX_LENGTH - PROFILE_ARTIFACT_PREFIX.length - 1;
  if (readable === raw && readable.length <= plainLimit) {
    return `${PROFILE_ARTIFACT_PREFIX}-${readable}`;
  }

  const hash = createHash('sha256').update(raw).digest('hex').slice(0, PROFILE_ARTIFACT_HASH_LENGTH);
  const readableLimit = PROFILE_ARTIFACT_MAX_LENGTH - PROFILE_ARTIFACT_PREFIX.length - 2 - hash.length;
  const prefix = (readable || 'key').slice(0, readableLimit).replace(/-+$/g, '') || 'key';
  return `${PROFILE_ARTIFACT_PREFIX}-${prefix}-${hash}`;
}

/** Resolve the opt-out cache-reporting input. */
function cacheHitReportingEnabled(value) {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error("Input 'report-cache-hits' must be one of: true, false");
}

/** Resolve profiling input, enabling it automatically for GitHub debug runs. */
function profilingEnabled(value, runnerDebug = process.env.RUNNER_DEBUG === '1') {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'auto') return runnerDebug;
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error("Input 'enable-profiling' must be one of: auto, true, false");
}

export {
  cacheHitReportingEnabled,
  profileArtifactName,
  profilingEnabled,
};
