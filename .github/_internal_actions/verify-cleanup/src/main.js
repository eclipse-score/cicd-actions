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

'use strict';

const core = require('@actions/core');

async function run() {
  // Save all inputs as action state so the post step can read them back after
  // the action under test has completed its own post step.
  core.saveState('filesAbsent', core.getInput('files-absent'));
  core.saveState('envVarsUnset', core.getInput('env-vars-unset'));
  core.saveState('fileNotContains', core.getInput('file-not-contains'));
  core.info('verify-cleanup: registered – post step will assert cleanup after the action under test.');
}

run();
