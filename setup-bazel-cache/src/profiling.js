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

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const PROFILE_ARTIFACT_PREFIX = 'bazel-profiles';
const PROFILE_ARTIFACT_MAX_LENGTH = 200;
const PROFILE_ARTIFACT_HASH_LENGTH = 10;
const PROFILE_NAMES = Object.freeze({
  build: 'setup-bazel-cache-build.profile.gz',
  test: 'setup-bazel-cache-test.profile.gz',
});

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

/** Return the fixed profile paths used by the managed Bazel configuration. */
function profilePaths(runnerTemp = process.env.RUNNER_TEMP || os.tmpdir()) {
  return Object.fromEntries(
    Object.entries(PROFILE_NAMES).map(([command, fileName]) => [
      command,
      path.join(runnerTemp, fileName),
    ]),
  );
}

/** Remove profiles left by an earlier action invocation in the same job. */
function clearProfiles(profiles) {
  for (const profile of Object.values(profiles)) {
    fs.rmSync(profile, { force: true });
  }
}

/** Return only profiles produced by the current job invocation. */
function existingProfiles(profiles) {
  return Object.values(profiles).filter((profile) => fs.existsSync(profile));
}

export {
  cacheHitReportingEnabled,
  clearProfiles,
  existingProfiles,
  profileArtifactName,
  profilePaths,
  profilingEnabled,
};
