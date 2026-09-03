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
import test from 'node:test';
import { createConfiguration } from '../src/config.js';
import { configureExternalCache, externalRepositoryCache } from '../src/external.js';
import { cacheLabel, RESTORE_RESULT } from '../src/cache.js';
import { restoreSummaryRows } from '../src/summary.js';

test('restore summary lists the external manifest and repositories separately', () => {
  const configuration = createConfiguration('/workspace', 'linux-debug', {
    externalCacheEnabled: true,
    outputBase: '/tmp/bazel-output-base',
  });
  configureExternalCache(configuration, '/tmp/bazel-output-base');
  const details = {
    bazelisk: {
      result: RESTORE_RESULT.TRUE,
      sizeAfter: 1024,
    },
    disk: {
      result: RESTORE_RESULT.PARTIAL,
      sizeAfter: 2 * 1024 * 1024,
    },
    repository: {
      result: RESTORE_RESULT.FALSE,
      sizeAfter: 0,
    },
    external: {
      result: RESTORE_RESULT.FALSE,
      manifest: {
        result: RESTORE_RESULT.TRUE,
        sizeAfter: 42,
      },
      repositories: {
        rules_cc: {
          result: RESTORE_RESULT.TRUE,
          sizeAfter: 500 * 1024 * 1024,
        },
        rules_java: {
          result: RESTORE_RESULT.FALSE,
          sizeAfter: 0,
        },
      },
    },
  };

  assert.deepEqual(restoreSummaryRows(configuration, details), [
    [cacheLabel(configuration, configuration.caches.bazelisk), 'true (exact hit)', '1.00 KiB'],
    [cacheLabel(configuration, configuration.caches.disk), 'partial (older generation)', '2.00 MiB'],
    [cacheLabel(configuration, configuration.caches.repository), 'false (miss)', '0 B'],
    [cacheLabel(configuration, configuration.caches.externalManifest), 'true (exact hit)', '42 B'],
    [cacheLabel(configuration, externalRepositoryCache(configuration, 'rules_cc')), 'true (exact hit)', '500 MiB'],
    [cacheLabel(configuration, externalRepositoryCache(configuration, 'rules_java')), 'false (miss)', '0 B'],
  ]);
});

test('restore summary keeps a single external row when no component was restored', () => {
  const configuration = createConfiguration('/workspace', 'linux-debug');
  const details = {
    bazelisk: { result: RESTORE_RESULT.SKIPPED, sizeAfter: 0 },
    external: {
      result: RESTORE_RESULT.SKIPPED,
      sizeAfter: 0,
      repositories: {},
    },
  };

  assert.deepEqual(restoreSummaryRows(configuration, details), [
    [cacheLabel(configuration, configuration.caches.bazelisk), 'skipped (disabled)', '0 B'],
    [`${configuration.baseKey}/${configuration.platform}/external`, 'skipped (disabled)', '0 B'],
  ]);
});
