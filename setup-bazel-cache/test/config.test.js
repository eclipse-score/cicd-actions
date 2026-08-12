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
import { createConfiguration } from '../src/config.js';

test('configuration uses readable Linux cache names and owns the bazelrc', () => {
  const configuration = createConfiguration('/workspace', 'build-debug');
  assert.equal(configuration.baseKey, `setup-bazel-cache-v1-linux-${os.arch()}`);
  assert.equal(configuration.caches.disk.name, 'disk-build-debug');
  assert.equal(configuration.bazelrc, path.join(os.homedir(), '.bazelrc'));
  assert.match(configuration.bazelrcContents, /^build --disk_cache=.*bazel-disk$/m);
  assert.match(configuration.bazelrcContents, /^common --repository_cache=.*bazel-repo$/m);
  assert.doesNotMatch(configuration.bazelrcContents, /output_base/);
  assert.deepEqual(configuration.caches.repository.files, [
    '/workspace/MODULE.bazel',
    '/workspace/MODULE.bazel.lock',
  ]);
});
