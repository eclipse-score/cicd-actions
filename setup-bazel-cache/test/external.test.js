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
import { createConfiguration } from '../src/config.js';
import {
  aggregateRestoreResult,
  configureExternalCache,
  discoverExternalRepositories,
  EXTERNAL_CACHE_MIN_SIZE,
  externalRepositoryCache,
  readExternalManifest,
  validateExternalRepositoryName,
} from '../src/external.js';
import { keyPlan, RESTORE_RESULT } from '../src/cache.js';

test('external cache configuration points at Bazel output_base external', () => {
  const configuration = createConfiguration('/workspace', 'test', {
    externalCacheEnabled: true,
    outputBase: '/tmp/bazel-output-base',
  });
  configureExternalCache(configuration, '/tmp/bazel-output-base');

  assert.equal(configuration.external.root, '/tmp/bazel-output-base/external');
  assert.equal(configuration.caches.externalManifest, configuration.external.manifest);
  assert.equal(configuration.external.minSize, EXTERNAL_CACHE_MIN_SIZE);
});

test('external repository cache uses an immutable identity key', () => {
  const configuration = createConfiguration('/workspace', 'test', {
    externalCacheEnabled: true,
    outputBase: '/tmp/bazel-output-base',
  });
  configureExternalCache(configuration, '/tmp/bazel-output-base');

  assert.deepEqual(externalRepositoryCache(configuration, 'rules_cc'), {
    files: configuration.external.identityFiles,
    generational: false,
    name: 'external-rules_cc',
    paths: [
      '/tmp/bazel-output-base/external/@rules_cc.marker',
      '/tmp/bazel-output-base/external/rules_cc',
    ],
  });
});

test('external cache names cannot escape the output external directory', () => {
  assert.equal(validateExternalRepositoryName('rules_cc~override'), 'rules_cc~override');
  assert.throws(() => validateExternalRepositoryName('../outside'), /Invalid external repository/);
  assert.throws(() => validateExternalRepositoryName('repo/name'), /Invalid external repository/);
  assert.throws(() => validateExternalRepositoryName('repo\nname'), /Invalid external repository/);
});

test('external discovery includes directories and ignores marker files and symlinks', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-bazel-cache-external-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'rules_cc'));
  fs.writeFileSync(path.join(root, '@rules_cc.marker'), 'marker');
  fs.mkdirSync(path.join(root, 'local_repo'));
  fs.rmSync(path.join(root, 'local_repo'), { recursive: true, force: true });
  fs.symlinkSync(path.join(root, 'rules_cc'), path.join(root, 'local_repo'));

  assert.deepEqual(discoverExternalRepositories(root), ['rules_cc']);
});

test('external manifest accepts repository names but rejects path-like entries', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-bazel-cache-manifest-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = path.join(root, 'manifest.txt');
  fs.writeFileSync(manifest, 'rules_cc\n\nfoo~override\n');
  assert.deepEqual(readExternalManifest(manifest), ['rules_cc', 'foo~override']);

  fs.writeFileSync(manifest, '../outside\n');
  assert.throws(() => readExternalManifest(manifest), /Invalid external repository/);
});

test('external repository keys do not fall back to a different dependency definition', async (context) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-bazel-cache-workspace-'));
  context.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, 'MODULE.bazel'), 'module(name = "test")\n');

  const configuration = createConfiguration(workspace, 'test', {
    externalCacheEnabled: true,
    outputBase: '/tmp/bazel-output-base',
  });
  configureExternalCache(configuration, '/tmp/bazel-output-base');
  const repository = externalRepositoryCache(configuration, 'rules_cc');
  const plan = await keyPlan(configuration, repository);

  assert.deepEqual(plan.restoreKeys, []);
  assert.match(plan.key, /external-rules_cc-[0-9a-f]{8,64}$/);
});

test('aggregate external restore succeeds only when the manifest and every repository restore', () => {
  assert.equal(
    aggregateRestoreResult(RESTORE_RESULT.PARTIAL, {
      rules_cc: RESTORE_RESULT.PARTIAL,
      rules_java: RESTORE_RESULT.TRUE,
    }),
    RESTORE_RESULT.PARTIAL,
  );
  assert.equal(
    aggregateRestoreResult(RESTORE_RESULT.PARTIAL, {
      rules_cc: RESTORE_RESULT.FALSE,
    }),
    RESTORE_RESULT.FALSE,
  );
  assert.equal(
    aggregateRestoreResult(RESTORE_RESULT.UNKNOWN, {}),
    RESTORE_RESULT.UNKNOWN,
  );
});
