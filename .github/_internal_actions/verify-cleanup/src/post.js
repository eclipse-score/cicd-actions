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
const fs = require('fs');
const os = require('os');

function expandPath(p) {
  return p.replace(/^~/, os.homedir());
}

function parseLines(raw) {
  return raw.split('\n').map(s => s.trim()).filter(Boolean);
}

async function run() {
  const failures = [];

  // ---- Check: paths must not exist ----------------------------------------
  const filesAbsent = core.getState('filesAbsent');
  if (filesAbsent) {
    core.startGroup('Verify files/directories are absent');
    for (const rawPath of parseLines(filesAbsent)) {
      const absPath = expandPath(rawPath);
      if (fs.existsSync(absPath)) {
        const msg = `FAIL: Expected path to be absent, but it exists: ${absPath}`;
        core.error(msg);
        failures.push(msg);
      } else {
        core.info(`PASS: Path is absent as expected: ${absPath}`);
      }
    }
    core.endGroup();
  }

  // ---- Check: env vars must be empty / unset --------------------------------
  const envVarsUnset = core.getState('envVarsUnset');
  if (envVarsUnset) {
    core.startGroup('Verify environment variables are unset');
    for (const varName of parseLines(envVarsUnset)) {
      const value = process.env[varName];
      if (value !== undefined && value !== '') {
        const msg = `FAIL: Expected env var '${varName}' to be unset/empty, but got: '${value}'`;
        core.error(msg);
        failures.push(msg);
      } else {
        core.info(`PASS: Env var '${varName}' is unset/empty as expected`);
      }
    }
    core.endGroup();
  }

  // ---- Check: files must not contain given substrings ----------------------
  const fileNotContains = core.getState('fileNotContains');
  if (fileNotContains) {
    core.startGroup('Verify file content is absent');
    for (const entry of parseLines(fileNotContains)) {
      const sep = entry.indexOf('|');
      if (sep === -1) {
        core.warning(`Ignoring malformed file-not-contains entry (missing '|' separator): ${entry}`);
        continue;
      }
      const filePath = expandPath(entry.slice(0, sep).trim());
      const substring = entry.slice(sep + 1).trim();

      if (!fs.existsSync(filePath)) {
        core.info(`PASS: File does not exist, content trivially absent: ${filePath}`);
        continue;
      }

      const content = fs.readFileSync(filePath, 'utf8');
      if (content.includes(substring)) {
        const msg = `FAIL: File '${filePath}' still contains '${substring}'`;
        core.error(msg);
        failures.push(msg);
      } else {
        core.info(`PASS: File '${filePath}' does not contain '${substring}'`);
      }
    }
    core.endGroup();
  }

  if (failures.length > 0) {
    core.setFailed(`verify-cleanup: ${failures.length} check(s) failed.`);
  } else {
    core.info('verify-cleanup: All checks passed.');
  }
}

run();
