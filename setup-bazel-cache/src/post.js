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

import * as core from '@actions/core';
import { save } from './cache.js';
import { createConfiguration } from './config.js';

/**
 * Save caches after the caller's steps. State written by main proves setup
 * completed and carries the already-resolved permission to write caches.
 */
async function run() {
  try {
    const state = core.getState('setup-bazel-cache-experimental-configuration');
    if (!state) {
      core.info('Setup did not complete; caches will not be saved');
      return;
    }

    const { cacheSave, repositoryCacheSave, diskCacheName, workspace } = JSON.parse(state);
    if (!cacheSave) {
      core.info('Cache saving is disabled on this ref');
      return;
    }

    const configuration = createConfiguration(workspace, diskCacheName);
    await save(configuration, configuration.caches.bazelisk);
    await save(configuration, configuration.caches.disk);
    if (repositoryCacheSave) {
      await save(configuration, configuration.caches.repository);
    } else {
      core.info('Repository cache saving is disabled for this job');
    }
  } catch (error) {
    core.setFailed(error.stack || error.message);
  }
}

run();
