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
import { cachePrefix, exactKey, RESTORE_RESULT } from '../src/cache.js';
import { createConfiguration } from '../src/config.js';

test('cache families have explicit names', () => {
  const configuration = createConfiguration('/workspace', 'linux-debug');
  assert.equal(
    cachePrefix(configuration, configuration.caches.disk),
    `${configuration.baseKey}-disk-linux-debug-`
  );
  assert.equal(
    cachePrefix(configuration, configuration.caches.repository),
    `${configuration.baseKey}-repository-`
  );
});

test('restore results use a stable output vocabulary', () => {
  assert.deepEqual(RESTORE_RESULT, {
    FALSE: 'false',
    PARTIAL: 'partial',
    SKIPPED: 'skipped',
    TRUE: 'true',
    UNKNOWN: 'unknown',
  });
});

test('content-based cache keys contain a SHA-256 hash', async (context) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-bazel-cache-test-'));
  context.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, '.bazelversion'), '8.6.0\n');

  const configuration = createConfiguration(workspace, 'test');
  const key = await exactKey(configuration, configuration.caches.bazelisk);
  assert.match(key, new RegExp(`^${configuration.baseKey}-bazelisk-[a-f0-9]{64}$`));
});
