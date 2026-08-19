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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createConfiguration,
  readBazeliskVersion,
  validateDiskCacheKey,
} from '../src/config.js';

test('configuration uses readable Linux cache names and a temporary bazelrc', () => {
  const configuration = createConfiguration('/workspace', 'build-debug');
  assert.equal(
    configuration.baseKey,
    `setup-bazel-cache-v1-linux-${os.arch()}`,
  );
  assert.equal(configuration.caches.disk.name, 'disk-11-build-debug');
  assert.equal(
    configuration.bazelrc,
    path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'setup-bazel-cache.bazelrc'),
  );
  assert.match(configuration.bazelrcContents, /^build --disk_cache=.*bazel-disk$/m);
  assert.match(configuration.bazelrcContents, /^common --repository_cache=.*bazel-repo$/m);
  assert.doesNotMatch(configuration.bazelrcContents, /output_base/);
  assert.equal(configuration.caches.disk.generational, true);
  assert.equal(configuration.caches.repository.generational, true);
  assert.equal(configuration.caches.bazelisk.keySuffix, 'default');
  assert.deepEqual(configuration.caches.repository.files, []);
  assert.equal(
    configuration.additiveCacheSaveEnvironment,
    'SETUP_BAZEL_CACHE_ADDITIVE_SAVE',
  );
});

test('Bazelisk version is read as a readable cache-key component', (context) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-bazel-cache-config-'));
  context.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, '.bazelversion'), '8.6.0\n');

  assert.equal(readBazeliskVersion(workspace), '8.6.0');
  assert.equal(createConfiguration(workspace, 'test').caches.bazelisk.keySuffix, '8.6.0');
});

test('post-save configuration can use the version captured during setup', () => {
  assert.equal(
    createConfiguration('/workspace', 'test', { bazeliskVersion: '8.6.0' })
      .caches.bazelisk.keySuffix,
    '8.6.0',
  );
});

test('disk cache keys are constrained to safe cache-key components', () => {
  assert.equal(validateDiskCacheKey('linux-debug'), 'linux-debug');
  assert.throws(() => validateDiskCacheKey(''), /printable characters without commas/);
  assert.throws(() => validateDiskCacheKey('a'.repeat(401)), /printable characters without commas/);
  assert.throws(() => validateDiskCacheKey('debug\nrelease'), /printable characters without commas/);
  assert.throws(() => validateDiskCacheKey('debug,release'), /printable characters without commas/);
});
