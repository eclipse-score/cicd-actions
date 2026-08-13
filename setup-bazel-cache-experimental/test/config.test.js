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

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createConfiguration, validateUniqueCacheName } from '../src/config.js';

test('configuration uses readable Linux cache names and owns the bazelrc', () => {
  const configuration = createConfiguration('/workspace', 'build-debug');
  assert.equal(
    configuration.baseKey,
    `setup-bazel-cache-experimental-v1-linux-${os.arch()}`,
  );
  assert.equal(configuration.caches.disk.name, 'disk-build-debug');
  assert.equal(configuration.bazelrc, path.join(os.homedir(), '.bazelrc'));
  assert.match(configuration.bazelrcContents, /^build --disk_cache=.*bazel-disk$/m);
  assert.match(configuration.bazelrcContents, /^common --repository_cache=.*bazel-repo$/m);
  assert.doesNotMatch(configuration.bazelrcContents, /output_base/);
  assert.equal(configuration.caches.disk.generational, true);
  assert.equal(configuration.caches.repository.generational, true);
  assert.deepEqual(configuration.caches.repository.files, []);
  assert.equal(
    configuration.additiveCacheSaveEnvironment,
    'SETUP_BAZEL_CACHE_EXPERIMENTAL_ADDITIVE_SAVE',
  );
});

test('unique cache names are constrained to safe cache-key components', () => {
  assert.equal(validateUniqueCacheName('linux-debug'), 'linux-debug');
  assert.throws(() => validateUniqueCacheName(''), /printable characters without commas/);
  assert.throws(() => validateUniqueCacheName('a'.repeat(401)), /printable characters without commas/);
  assert.throws(() => validateUniqueCacheName('debug\nrelease'), /printable characters without commas/);
  assert.throws(() => validateUniqueCacheName('debug,release'), /printable characters without commas/);
});
