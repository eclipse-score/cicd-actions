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
const exec = require('@actions/exec');
const fs = require('fs');
const os = require('os');
const { NETRC_PATH, NETRC_ENTRY_REGEX } = require('./common');

async function cleanupNetrc() {
  core.startGroup('Cleanup qnx.com entry from .netrc');
  try {
    const netrcPath = NETRC_PATH;
    if (!fs.existsSync(netrcPath)) {
      core.info('.netrc does not exist, nothing to clean up.');
      return;
    }

    const original = fs.readFileSync(netrcPath, 'utf8');
    const cleaned = original.replace(NETRC_ENTRY_REGEX, '');

    if (cleaned === original) {
      core.info('No qnx.com entry found in .netrc, nothing to remove.');
    } else {
      fs.writeFileSync(netrcPath, cleaned, { mode: 0o600 });
      core.info('Removed qnx.com entry from .netrc.');
    }
  } catch (error) {
    core.warning(`Failed to clean up .netrc: ${error.message}`);
  } finally {
    core.endGroup();
  }
}

async function cleanupQnxLicense() {
  core.startGroup('Cleanup QNX license');
  try {
    const licenseDir = core.getInput('qnx-license-dir', { required: true });
    // Replace leading ~ with $HOME to match how the main action resolves the path
    const licenseDirAbsPath = licenseDir.replace(/^~/, os.homedir());

    core.info(`Removing QNX license directory: ${licenseDirAbsPath}`);

    if (!fs.existsSync(licenseDirAbsPath)) {
      core.info(`QNX license directory does not exist, nothing to remove: ${licenseDirAbsPath}`);
      return;
    }

    try {
      fs.rmSync(licenseDirAbsPath, { recursive: true, force: true });
      core.info(`Successfully removed: ${licenseDirAbsPath}`);
    } catch (e) {
      // If direct removal fails (e.g. root-owned files), retry with sudo
      core.info(`Direct removal failed (${e.message}), retrying with sudo...`);
      try {
        await exec.exec('sudo', ['rm', '-rf', licenseDirAbsPath]);
        core.info(`Successfully removed with sudo: ${licenseDirAbsPath}`);
      } catch (sudoError) {
        core.warning(`Failed to remove QNX license directory ${licenseDirAbsPath}: ${sudoError.message}`);
      }
    }
  } catch (error) {
    // Post actions must not cause the job to fail
    core.warning(`QNX license cleanup failed: ${error.message}`);
  } finally {
    core.endGroup();
  }
}

async function cleanupEnvVars() {
  core.startGroup('Unset environment variables set by setup-qnx-sdp');
  try {
    const vars = [
      'QNX_CREDENTIAL_HELPER',
      'QNXLM_LICENSE_FILE',
      'QNX_LICENSE_EXTSERVER_DELAY',
      'QNX_LICENSE_QUEUE_TIMEOUT',
    ];
    for (const name of vars) {
      // Remove from the current process so this post-action no longer sees them
      delete process.env[name];
      // Write an empty value to GITHUB_ENV so subsequent post-actions of other
      // actions in the workflow also no longer see them
      core.exportVariable(name, '');
      core.info(`Unset env var: ${name}`);
    }
  } finally {
    core.endGroup();
  }
}

async function run() {
  await cleanupEnvVars();
  await cleanupQnxLicense();
  await cleanupNetrc();
}

run();
