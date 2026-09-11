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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  hasCheckoutMetadata,
  PRECHECKOUT_WARNING,
  warnIfMissingCheckout,
} from '../src/workspace.js';

test('checkout metadata is detected for a normal checkout directory', (context) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-bazel-cache-workspace-'));
  context.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, '.git'));

  assert.equal(hasCheckoutMetadata(workspace), true);
  const warnings = [];
  assert.equal(warnIfMissingCheckout(workspace, (warning) => warnings.push(warning)), false);
  assert.deepEqual(warnings, []);
});

test('checkout metadata is detected for a worktree git file', (context) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-bazel-cache-workspace-'));
  context.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, '.git'), 'gitdir: /tmp/worktree\n');

  assert.equal(hasCheckoutMetadata(workspace), true);
  const warnings = [];
  assert.equal(warnIfMissingCheckout(workspace, (warning) => warnings.push(warning)), false);
  assert.deepEqual(warnings, []);
});

test('missing checkout metadata produces the actionable warning text', (context) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-bazel-cache-workspace-'));
  context.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

  assert.equal(hasCheckoutMetadata(workspace), false);
  const warnings = [];
  assert.equal(warnIfMissingCheckout(workspace, (warning) => warnings.push(warning)), true);
  assert.deepEqual(warnings, [PRECHECKOUT_WARNING]);
  assert.match(warnings[0], /run after actions\/checkout/);
  assert.match(warnings[0], /workspace-dependent Bazel cache setup/);
});
