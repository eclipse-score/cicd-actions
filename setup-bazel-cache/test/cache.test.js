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
  cachePrefix,
  canSaveAfterFailure,
  keyPlan,
  RESTORE_RESULT,
} from '../src/cache.js';
import { createConfiguration } from '../src/config.js';

test('cache families have explicit names', () => {
  const configuration = createConfiguration('/workspace', 'linux-debug');
  assert.equal(
    cachePrefix(configuration, configuration.caches.disk),
    `${configuration.baseKey}-disk-11-linux-debug-`
  );
  assert.equal(
    cachePrefix(configuration, configuration.caches.repository),
    `${configuration.baseKey}-repository-`
  );
});

test('disk cache family names cannot prefix-match another configuration', async (context) => {
  context.mock.method(Date, 'now', () => 1700000000000);

  const build = createConfiguration('/workspace', 'build');
  const buildRelease = createConfiguration('/workspace', 'build-release');
  const buildPlan = await keyPlan(build, build.caches.disk);
  const buildReleasePlan = await keyPlan(buildRelease, buildRelease.caches.disk);

  assert.equal(buildReleasePlan.key.startsWith(buildPlan.restoreKeys[0]), false);
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

test('failed jobs may save only when every selected cache restore was additive', () => {
  const additive = {
    bazelisk: RESTORE_RESULT.TRUE,
    disk: RESTORE_RESULT.PARTIAL,
    repository: RESTORE_RESULT.PARTIAL,
  };
  assert.equal(canSaveAfterFailure(additive, { bazelisk: true, disk: true, repository: true }), true);

  assert.equal(
    canSaveAfterFailure({ ...additive, disk: RESTORE_RESULT.FALSE }, { bazelisk: true, disk: true, repository: true }),
    false,
  );
  assert.equal(
    canSaveAfterFailure({ ...additive, disk: RESTORE_RESULT.SKIPPED }, { bazelisk: true, disk: true, repository: true }),
    false,
  );
  assert.equal(
    canSaveAfterFailure({ ...additive, disk: RESTORE_RESULT.UNKNOWN }, { bazelisk: true, disk: true, repository: true }),
    false,
  );
  assert.equal(
    canSaveAfterFailure(
      { ...additive, bazelisk: RESTORE_RESULT.PARTIAL },
      { bazelisk: true, disk: true, repository: true },
    ),
    false,
  );
  assert.equal(canSaveAfterFailure({ ...additive, repository: RESTORE_RESULT.FALSE }, {
    bazelisk: true,
    disk: true,
    repository: false,
  }), true);
  assert.equal(canSaveAfterFailure({ ...additive, disk: RESTORE_RESULT.FALSE }, {
    bazelisk: true,
    disk: false,
    repository: true,
  }), true);
  assert.equal(canSaveAfterFailure({ ...additive, bazelisk: RESTORE_RESULT.FALSE }, {
    bazelisk: false,
    disk: true,
    repository: true,
  }), true);
  assert.equal(canSaveAfterFailure(additive, {
    bazelisk: false,
    disk: false,
    repository: false,
  }), false);
});

test('content-based cache keys do not restore snapshots for other content', async (context) => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), 'setup-bazel-cache-test-'),
  );
  context.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, '.bazelversion'), '8.6.0\n');

  const configuration = createConfiguration(workspace, 'test');
  const plan = await keyPlan(configuration, configuration.caches.bazelisk);
  assert.match(
    plan.key,
    new RegExp(`^${configuration.baseKey}-bazelisk-8\\.6\\.0$`),
  );
  assert.deepEqual(plan.restoreKeys, []);
});

test('repository cache uses one rolling generation family for all configurations', async (context) => {
  let timestamp = 1700000000000;
  context.mock.method(Date, 'now', () => timestamp);

  const configuration = createConfiguration('/workspace', 'test');
  const prefix = cachePrefix(configuration, configuration.caches.repository);
  const first = await keyPlan(configuration, configuration.caches.repository);
  assert.equal(first.key, `${prefix}${timestamp}`);
  assert.deepEqual(first.restoreKeys, [prefix]);

  timestamp += 1;
  const second = await keyPlan(configuration, configuration.caches.repository);
  assert.equal(second.key, `${prefix}${timestamp}`);
  assert.deepEqual(second.restoreKeys, [prefix]);
});
