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

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  cacheHitReportingEnabled,
  clearProfiles,
  existingProfiles,
  profileArtifactName,
  profilePaths,
  profilingEnabled,
} from '../src/profiling.js';

test('cache-hit reporting defaults accept only explicit boolean values', () => {
  assert.equal(cacheHitReportingEnabled('true'), true);
  assert.equal(cacheHitReportingEnabled(' FALSE '), false);
  assert.throws(() => cacheHitReportingEnabled('auto'), /report-cache-hits/);
});

test('profiling defaults to GitHub Actions debug runs', () => {
  assert.equal(profilingEnabled('auto', false), false);
  assert.equal(profilingEnabled('auto', true), true);
  assert.equal(profilingEnabled('true', false), true);
  assert.equal(profilingEnabled('false', true), false);
  assert.throws(() => profilingEnabled('unexpected', false), /auto, true, false/);
});

test('profile paths use stable build and test filenames', () => {
  const profiles = profilePaths('/runner-temp');

  assert.deepEqual(profiles, {
    build: '/runner-temp/setup-bazel-cache-build.profile.gz',
    test: '/runner-temp/setup-bazel-cache-test.profile.gz',
  });
});

test('profile artifact names identify matrix cache keys without unsafe characters', () => {
  assert.equal(profileArtifactName('linux-debug'), 'bazel-profiles-linux-debug');
  assert.notEqual(profileArtifactName('linux/debug'), profileArtifactName('linux-debug'));
  assert.match(profileArtifactName('linux/debug'), /^bazel-profiles-linux-debug-[0-9a-f]{10}$/);
  assert.equal(profileArtifactName(), 'bazel-profiles-default');
  assert.ok(profileArtifactName('x'.repeat(400)).length <= 200);
});

test('profile discovery and cleanup only handle the managed files', (context) => {
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-bazel-cache-profiling-'));
  context.after(() => fs.rmSync(runnerTemp, { recursive: true, force: true }));
  const profiles = profilePaths(runnerTemp);
  const unrelated = path.join(runnerTemp, 'unrelated.profile.gz');

  fs.writeFileSync(profiles.build, 'build profile');
  fs.writeFileSync(unrelated, 'unrelated profile');

  assert.deepEqual(existingProfiles(profiles), [profiles.build]);
  clearProfiles(profiles);
  assert.equal(fs.existsSync(profiles.build), false);
  assert.equal(fs.existsSync(unrelated), true);
});
