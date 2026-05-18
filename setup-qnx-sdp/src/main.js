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
const { NETRC_PATH, buildNetrcEntry, exportVar } = require('./common');

async function prepareCredentialHelper(credHelper) {
  core.startGroup('Check for qnx.com credential helper existence');
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

    exportVar('QNX_CREDENTIAL_HELPER', helperPath);
    core.info(`Using helper at: ${helperPath}`);
    await exec.exec('ls', ['-l', helperPath]);
  } finally {
    core.endGroup();
  }
}

async function prepareLicenseFile(qnxLicense, licenseDir) {
  core.startGroup('Prepare QNX license file');
  try {
    const dir = licenseDir.trim();
    // Must not be empty or whitespace-only.
    if (!dir) {
      throw new Error(
        "'qnx-license-dir' must not be empty. " +
        "Provide either a home-relative path (e.g. ~/qnx/license) or an absolute path " +
        "that is at least two levels deep (e.g. /opt/score_qnx/license)."
      );
    }

    // Absolute paths must refer to at least a second-level directory (e.g. /opt/qnx, not /qnx)
    // to prevent accidental operations directly under the filesystem root.
    if (dir.startsWith('/') && !/^\/[^/]+\/[^/]/.test(dir)) {
      throw new Error(
        `'qnx-license-dir' value '${dir}' is too shallow. ` +
        'Absolute paths must be at least two levels deep (e.g. /opt/score_qnx), ' +
        'not directly under the filesystem root.'
      );
    }

    // Replace leading ~ with $HOME (tilde causes problems in GitHub Actions env handling)
    const licenseDirAbsPath = dir.replace(/^~/, os.homedir());
    const licenseFile = path.join(licenseDirAbsPath, 'licenses');
    // Paths outside the home directory are assumed to be system directories that may need sudo
    const needsSudo = !licenseDirAbsPath.startsWith(os.homedir());
    let fileOpSudo = false;

    // Try to create the directory, fall back to sudo if needed
    try {
      fs.mkdirSync(licenseDirAbsPath, { recursive: true });
    } catch (e) {
      if (needsSudo) {
        await exec.exec('sudo', ['mkdir', '-p', licenseDirAbsPath]);
      } else {
        throw e;
      }
    }

    // Determine whether sudo is required for writing the license file
    if (fs.existsSync(licenseFile)) {
      core.info(`License file already exists and will be overwritten: ${licenseFile}`);
      try {
        fs.accessSync(licenseFile, fs.constants.W_OK);
      } catch (e) {
        if (needsSudo) {
          fileOpSudo = true;
        } else {
          throw e;
        }
      }
    } else {
      try {
        fs.accessSync(licenseDirAbsPath, fs.constants.W_OK);
      } catch (e) {
        if (needsSudo) {
          fileOpSudo = true;
        } else {
          throw e;
        }
      }
    }

    const licenseContent = Buffer.from(qnxLicense, 'base64').toString();

    if (fileOpSudo) {
      // Write to a temp file outside the sudo-protected path, then copy to the target.
      // Use sudo for the copy operation to ensure correct permissions even if the target directory is root-owned.
      const tmpFile = path.join(os.tmpdir(), `qnx_license_${process.pid}`);
      // Hint: Using 600 permissions is not enough since then the Bazel sandbox cannot access the license file and the build aborts with an error message:
      // "You don't have a valid license for this product. QNX functionality will be disabled."
      try {
        fs.writeFileSync(tmpFile, licenseContent, { mode: 0o664 });
        await exec.exec('sudo', ['cp', tmpFile, licenseFile]);
        await exec.exec('sudo', ['chmod', '664', licenseFile]);
      } finally {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore cleanup failure */ }
      }
    } else {
      fs.writeFileSync(licenseFile, licenseContent, { mode: 0o664 });
      fs.chmodSync(licenseFile, 0o664);
    }

    core.info('Prepared license file is located here:');
    await exec.exec('ls', ['-l', licenseFile]);
  } finally {
    core.endGroup();
  }
}

async function configureLicenseServer(licenseServer) {
  core.startGroup('Configure qnx license server');
  try {
    const workspace = process.env.GITHUB_WORKSPACE;
    if (!workspace) {
      throw new Error('GITHUB_WORKSPACE environment variable is not set.');
    }
    const tryImportLine = 'try-import %workspace%/user.bazelrc';

    const workspaceBazelrc = path.join(workspace, '.bazelrc');
    const homeBazelrc = path.join(os.homedir(), '.bazelrc');

    const workspaceHasImport = fs.existsSync(workspaceBazelrc) &&
      fs.readFileSync(workspaceBazelrc, 'utf8').includes(tryImportLine);
    const homeHasImport = fs.existsSync(homeBazelrc) &&
      fs.readFileSync(homeBazelrc, 'utf8').includes(tryImportLine);

    if (!workspaceHasImport && !homeHasImport) {
      core.warning(
        `'${tryImportLine}' was not found in '${workspaceBazelrc}' or '${homeBazelrc}'. ` +
        'The license server configuration added to user.bazelrc will have no effect!'
      );
    }

    exportVar('QNXLM_LICENSE_FILE', licenseServer);
    exportVar('QNX_LICENSE_EXTSERVER_DELAY', '59');
    exportVar('QNX_LICENSE_QUEUE_TIMEOUT', '180');

    const userBazelrc = path.join(workspace, 'user.bazelrc');
    const entries = [
      `common --action_env=QNXLM_LICENSE_FILE=${licenseServer} --action_env=QNX_LICENSE_EXTSERVER_DELAY --action_env=QNX_LICENSE_QUEUE_TIMEOUT`,
      `common --test_env=QNXLM_LICENSE_FILE=${licenseServer} --test_env=QNX_LICENSE_EXTSERVER_DELAY --test_env=QNX_LICENSE_QUEUE_TIMEOUT`,
      // Required because the Bazel QNX toolchain uses /var/tmp/.qnx as QNX_CONFIGURATION_EXCLUSIVE;
      // that directory must be writable during the build.
      'common --sandbox_writable_path=/var/tmp'
    ].join('\n') + '\n';

    fs.appendFileSync(userBazelrc, entries);
    core.info('Added related Bazel configuration to user.bazelrc');
  } finally {
    core.endGroup();
  }
}

async function configureNetrc(username, password) {
  core.startGroup('Configure access to qnx.com via .netrc');
  try {
    // Append a machine entry; create the file if it does not exist
    const entry = buildNetrcEntry(username, password);
    fs.appendFileSync(NETRC_PATH, entry);
    // Restrict .netrc permissions – readable and writable only by the owner
    fs.chmodSync(NETRC_PATH, 0o600);
    core.info('Configured qnx.com credentials in .netrc');
    await exec.exec('ls', ['-l', NETRC_PATH]);
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

    if (credHelper.trim() !== '') {
      await prepareCredentialHelper(credHelper);
    }

    await prepareLicenseFile(qnxLicense, licenseDir);

    if (licenseServer !== '') {
      await configureLicenseServer(licenseServer);
    }

    await configureNetrc(qnxUser, qnxPassword);
  } catch (error) {
    core.setFailed(error);
  }
}

run();
