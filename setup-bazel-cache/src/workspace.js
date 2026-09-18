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

import fs from 'node:fs';
import path from 'node:path';

/** Return whether actions/checkout has populated the configured workspace. */
function hasCheckoutMetadata(workspace) {
  return fs.existsSync(path.join(workspace, '.git'));
}

const PRECHECKOUT_WARNING =
  'setup-bazel-cache should run after actions/checkout. Move checkout before this action so workspace-dependent Bazel cache setup can work correctly.';

/** Emit the pre-checkout warning only when checkout metadata is absent. */
function warnIfMissingCheckout(workspace, warn) {
  if (hasCheckoutMetadata(workspace)) return false;
  warn(PRECHECKOUT_WARNING);
  return true;
}

export { hasCheckoutMetadata, PRECHECKOUT_WARNING, warnIfMissingCheckout };
