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
  test(`${entry} warns and exits successfully when automatic cache setup requires a missing checkout`, (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bazel action failure-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const env = {
      // Commit hooks export Git paths that must not redirect fixture lookups
      // into the repository running this test.
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
      HOME: root,
      RUNNER_TEMP: root,
      GITHUB_WORKSPACE: root,
      GITHUB_REF: 'refs/heads/main',
      'INPUT_DISK-CACHE-KEY': 'missing-checkout-regression',
      'INPUT_CACHE-SAVE-BRANCH-PATTERNS': 'main',
      'INPUT_ENABLE-PROFILING': 'auto',
      'INPUT_REPORT-CACHE-HITS': 'true',
      'INPUT_REPORT-TEST-CACHE-HITS': 'true',
      'INPUT_REPORT-CACHE-STEP-SUMMARY': 'false',
    };
    for (const variable of ['GITHUB_ACTION_PATH', 'GITHUB_ENV', 'GITHUB_OUTPUT', 'GITHUB_STATE', 'GITHUB_STEP_SUMMARY']) {
      delete env[variable];
    }

    const output = execFileSync(process.execPath, [fileURLToPath(new URL(`../${entry}`, import.meta.url))], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.match(output, /::warning::Bazel cache setup stopped: .*Automatic disk-cache restore detection needs a repository checkout/);
    assert.doesNotMatch(output, /::error::|::save-state/);
  });

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
      // Commit hooks export Git paths that must not redirect fixture lookups
      // into the repository running this test.
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
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
      'INPUT_REPORT-CACHE-STEP-SUMMARY': 'true',
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
    assert.deepEqual(
      listInvocations(invocationRootPath(root)).map(({ targets }) => targets),
      [['//:example'], ['//:example']],
    );
  });
}


for (const entry of ['src/main.js', 'dst/main/index.js']) {
  test(`${entry} saves the nested workspace and its Bazel version for the post step`, (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bazel nested action-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const checkout = path.join(root, 'checkout');
    const nested = path.join(checkout, 'examples', 'integration');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(checkout, '.git'), 'gitdir: /tmp/worktree\n');
    fs.writeFileSync(path.join(checkout, '.bazelversion'), '8.1.0\n');
    fs.writeFileSync(path.join(nested, '.bazelversion'), '8.8.2\n');
    const stateFile = path.join(root, 'state');
    fs.writeFileSync(stateFile, '');
    const env = {
      // Commit hooks export Git paths that must not redirect fixture lookups
      // into the repository running this test.
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
      HOME: root,
      RUNNER_TEMP: root,
      GITHUB_WORKSPACE: checkout,
      GITHUB_STATE: stateFile,
      'INPUT_WORKING-DIRECTORY': 'examples/integration',
      'INPUT_DISK-CACHE-KEY': 'nested-workspace',
      'INPUT_CACHE-SAVE-BRANCH-PATTERNS': 'main',
      'INPUT_ENABLE-PROFILING': 'false',
      'INPUT_REPORT-CACHE-HITS': 'false',
      'INPUT_REPORT-TEST-CACHE-HITS': 'false',
      'INPUT_REPORT-CACHE-STEP-SUMMARY': 'false',
    };
    for (const variable of ['GITHUB_ACTION_PATH', 'GITHUB_ENV', 'GITHUB_OUTPUT', 'GITHUB_STEP_SUMMARY']) {
      delete env[variable];
    }
    for (const cache of ['BAZELISK', 'DISK', 'REPOSITORY', 'EXTERNAL']) {
      for (const operation of ['RESTORE', 'SAVE']) {
        env[`INPUT_${cache}-CACHE-${operation}`] = 'false';
      }
    }
    const output = execFileSync(process.execPath, [fileURLToPath(new URL(`../${entry}`, import.meta.url))], {
      cwd: root, env, encoding: 'utf8', timeout: 15000,
    });
    assert.doesNotMatch(output, /run after actions\/checkout/);
    const json = fs.readFileSync(stateFile, 'utf8').split('\n').find((line) => line.startsWith('{'));
    const state = JSON.parse(json);
    assert.equal(state.workspace, nested);
    assert.equal(state.workspaceDirectory, 'examples/integration');
    assert.equal(state.bazeliskVersion, '8.8.2');
    assert.equal(env.GITHUB_WORKSPACE, checkout);
  });
}
