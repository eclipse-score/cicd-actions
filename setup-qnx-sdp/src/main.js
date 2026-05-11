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
const path = require('path');
const os = require('os');

async function prepareCredentialHelper(credHelper) {
  core.startGroup('Prepare qnx.com credential helper');
  try {
    let helperPath = credHelper;
    if (!path.isAbsolute(helperPath)) {
      helperPath = path.join(process.env.GITHUB_WORKSPACE, helperPath);
    }

    if (!fs.existsSync(helperPath)) {
      throw new Error(`Credential helper not found at ${helperPath}`);
    }

    const stat = fs.statSync(helperPath);
    if (!(stat.mode & 0o111)) {
      fs.chmodSync(helperPath, stat.mode | 0o111);
    }

    core.exportVariable('QNX_CREDENTIAL_HELPER', helperPath);
    core.info(`Using helper at: ${helperPath}`);
    await exec.exec('ls', ['-l', helperPath]);
  } finally {
    core.endGroup();
  }
}

async function prepareLicenseFile(qnxLicense, licenseDir) {
  core.startGroup('Prepare QNX license file');
  try {
    // Replace leading ~ with $HOME (tilde causes problems in GitHub Actions env handling)
    const resolvedDir = licenseDir.replace(/^~/, os.homedir());
    const licenseFile = path.join(resolvedDir, 'licenses');
    // Paths starting with '/' are assumed to be system directories that may need sudo
    const needsSudo = resolvedDir.startsWith('/');
    let fileOpSudo = false;

    // Try to create the directory, fall back to sudo if needed
    try {
      fs.mkdirSync(resolvedDir, { recursive: true });
    } catch (e) {
      if (needsSudo) {
        await exec.exec('sudo', ['mkdir', '-p', resolvedDir]);
      } else {
        throw e;
      }
    }

    // Determine whether sudo is required for writing the license file
    if (fs.existsSync(licenseFile)) {
      core.info(`License file already exists and will be overwritten: ${licenseFile}`);
      try {
        fs.accessSync(licenseFile, fs.constants.W_OK);
      } catch {
        fileOpSudo = needsSudo;
      }
    } else {
      try {
        fs.accessSync(resolvedDir, fs.constants.W_OK);
      } catch {
        fileOpSudo = needsSudo;
      }
    }

    const licenseContent = Buffer.from(qnxLicense, 'base64').toString();

    if (fileOpSudo) {
      // Write to a temp file outside the sudo-protected path, then copy with sudo
      const tmpFile = path.join(os.tmpdir(), `qnx_license_${process.pid}`);
      try {
        fs.writeFileSync(tmpFile, licenseContent, { mode: 0o600 });
        await exec.exec('sudo', ['cp', tmpFile, licenseFile]);
        await exec.exec('sudo', ['chmod', '644', licenseFile]);
      } finally {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore cleanup failure */ }
      }
    } else {
      fs.writeFileSync(licenseFile, licenseContent);
      fs.chmodSync(licenseFile, 0o644);
    }

    core.info('Prepared license file is located here:');
    if (fileOpSudo) {
      await exec.exec('sudo', ['ls', '-l', licenseFile]);
    } else {
      await exec.exec('ls', ['-l', licenseFile]);
    }
  } finally {
    core.endGroup();
  }
}

async function configureLicenseServer(licenseServer) {
  core.startGroup('Configure qnx license server');
  try {
    const workspace = process.env.GITHUB_WORKSPACE;
    const bazelrcPath = path.join(workspace, '.bazelrc');

    if (!fs.existsSync(bazelrcPath)) {
      core.warning('No .bazelrc file found in repository root. License server configuration added to user.bazelrc will have no effect!');
    } else {
      const bazelrcContent = fs.readFileSync(bazelrcPath, 'utf8');
      if (!bazelrcContent.includes('try-import %workspace%/user.bazelrc')) {
        core.warning("The .bazelrc file in repository root does not contain 'try-import %workspace%/user.bazelrc'. License server configuration added to user.bazelrc will have no effect!");
      }
    }

    core.exportVariable('QNXLM_LICENSE_FILE', licenseServer);
    core.exportVariable('QNX_LICENSE_EXTSERVER_DELAY', '59');
    core.exportVariable('QNX_LICENSE_QUEUE_TIMEOUT', '180');

    const userBazelrc = path.join(workspace, 'user.bazelrc');
    const entries = [
      `common --action_env=QNXLM_LICENSE_FILE=${licenseServer} --action_env=QNX_LICENSE_EXTSERVER_DELAY --action_env=QNX_LICENSE_QUEUE_TIMEOUT`,
      `common --test_env=QNXLM_LICENSE_FILE=${licenseServer} --test_env=QNX_LICENSE_EXTSERVER_DELAY --test_env=QNX_LICENSE_QUEUE_TIMEOUT`,
      // Required because the Bazel QNX toolchain uses /var/tmp/.qnx as QNX_CONFIGURATION_EXCLUSIVE;
      // that directory must be writable during the build.
      'common --sandbox_writable_path=/var/tmp'
    ].join('\n') + '\n';

    fs.appendFileSync(userBazelrc, entries);
  } finally {
    core.endGroup();
  }
}

async function configureNetrc(username, password) {
  core.startGroup('Configure access to qnx.com via .netrc');
  try {
    const netrcPath = path.join(os.homedir(), '.netrc');
    // Append a machine entry; create the file if it does not exist
    const entry = `\nmachine qnx.com\n  login ${username}\n  password ${password}\n`;
    fs.appendFileSync(netrcPath, entry);
    // Restrict .netrc permissions – readable only by the owner
    fs.chmodSync(netrcPath, 0o600);
    core.info('Configured qnx.com credentials in .netrc');
  } finally {
    core.endGroup();
  }
}

async function run() {
  try {
    // Read all inputs first so we can mask the sensitive ones immediately
    const qnxLicense = core.getInput('qnx-license', { required: true });
    const qnxUser = core.getInput('qnx-user', { required: true });
    const qnxPassword = core.getInput('qnx-password', { required: true });
    const credHelper = core.getInput('qnx-credential-helper');
    const licenseDir = core.getInput('qnx-license-dir', { required: true });
    const licenseServer = core.getInput('qnx-license-server');

    // Mask sensitive values in all subsequent log output
    core.startGroup('Configure secrets to be masked in logs');
    core.info('Masking secrets in logs: QNX_LICENSE, QNX_USER, QNX_PASSWORD');
    core.setSecret(qnxLicense);
    core.setSecret(qnxUser);
    core.setSecret(qnxPassword);
    core.endGroup();

    if (credHelper !== '') {
      await prepareCredentialHelper(credHelper);
    }

    await prepareLicenseFile(qnxLicense, licenseDir);

    if (licenseServer !== '') {
      await configureLicenseServer(licenseServer);
    }

    await configureNetrc(qnxUser, qnxPassword);
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
