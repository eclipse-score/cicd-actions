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
import test from 'node:test';
import { fileURLToPath } from 'node:url';

for (const bundled of [false, true]) {
  const entry = (phase) => fileURLToPath(new URL(
    bundled ? `../dst/${phase}/index.js` : `../src/${phase}.js`,
    import.meta.url,
  ));
  const run = (phase, env) => execFileSync(process.execPath, [entry(phase)], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 15000,
  });
  const label = bundled ? 'bundle' : 'source';

  test(`${label}: invalid setup inputs warn, exit successfully, and do not enable cache saving`, () => {
    // Validation fails before setup writes files or records successful state.
    const output = run('main', {
      GITHUB_WORKSPACE: process.cwd(),
      'INPUT_DISK-CACHE-KEY': 'failure-regression',
      'INPUT_ENABLE-PROFILING': 'invalid',
    });
    assert.match(output, /::warning::Bazel cache setup stopped: .*enable-profiling/);
    assert.doesNotMatch(output, /::error::|::save-state/);

    const postOutput = run('post', { 'STATE_setup-bazel-cache-configuration': '' });
    assert.match(postOutput, /Setup did not complete; caches will not be saved/);
    assert.doesNotMatch(postOutput, /::error::/);
  });

  test(`${label}: malformed post-step state warns and exits successfully`, () => {
    const output = run('post', { 'STATE_setup-bazel-cache-configuration': '{invalid' });
    assert.match(output, /::warning::Bazel cache post-processing stopped: SyntaxError/);
    assert.doesNotMatch(output, /::error::/);
  });
}
