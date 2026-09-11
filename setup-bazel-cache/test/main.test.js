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
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { invocationRootPath, listInvocations } from '../src/invocation.js';

for (const entry of ['src/main.js', 'dst/main/index.js']) {
  test(`${entry} installs working launchers without GITHUB_ACTION_PATH from another directory`, (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bazel action setup-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const fakeBin = path.join(root, 'bin');
    fs.mkdirSync(fakeBin);
    for (const command of ['bazel', 'bazelisk']) {
      fs.writeFileSync(path.join(fakeBin, command), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    }
    const pathFile = path.join(root, 'github-path');
    fs.writeFileSync(pathFile, '');
    // Disable cache transfers so the real action setup runs without GitHub
    // services. Reporting defaults still require invocation instrumentation.
    const env = {
      ...process.env,
      HOME: root,
      RUNNER_TEMP: root,
      GITHUB_WORKSPACE: root,
      GITHUB_PATH: pathFile,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      'INPUT_DISK-CACHE-KEY': 'launcher-regression',
      'INPUT_CACHE-SAVE-BRANCH-PATTERNS': 'main',
      'INPUT_ENABLE-PROFILING': 'auto',
      'INPUT_REPORT-CACHE-HITS': 'true',
      'INPUT_REPORT-TEST-CACHE-HITS': 'true',
    };
    for (const variable of ['GITHUB_ACTION_PATH', 'GITHUB_ENV', 'GITHUB_OUTPUT', 'GITHUB_STATE', 'GITHUB_STEP_SUMMARY']) {
      delete env[variable];
    }
    for (const cache of ['BAZELISK', 'DISK', 'REPOSITORY', 'EXTERNAL']) {
      for (const operation of ['RESTORE', 'SAVE']) {
        env[`INPUT_${cache}-CACHE-${operation}`] = 'false';
      }
    }
    const output = execFileSync(process.execPath, [fileURLToPath(new URL(`../${entry}`, import.meta.url))], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.match(output, /Bazel invocation instrumentation enabled/);
    const wrapperDirectory = fs.readFileSync(pathFile, 'utf8').trim();
    for (const command of ['bazel', 'bazelisk']) {
      const result = execFileSync(command, ['test', '//:example'], {
        cwd: root,
        env: {
          ...env,
          PATH: `${wrapperDirectory}${path.delimiter}${env.PATH}`,
          SETUP_BAZEL_CACHE_INVOCATION_ROOT: invocationRootPath(root),
          SETUP_BAZEL_CACHE_REPORT_CACHE_HITS: 'true',
          SETUP_BAZEL_CACHE_REPORT_TEST_CACHE_HITS: 'true',
        },
        encoding: 'utf8',
        timeout: 15000,
      });
      assert.match(result, /--execution_log_compact_file=/);
      assert.match(result, /--build_event_json_file=/);
      assert.match(result, /\/\/:example/);
    }
    assert.equal(listInvocations(invocationRootPath(root)).length, 2);
  });
}
