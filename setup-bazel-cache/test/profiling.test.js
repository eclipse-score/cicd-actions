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
  clearProfiles,
  existingProfiles,
  profilePaths,
  profilingEnabled,
} from '../src/profiling.js';

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
