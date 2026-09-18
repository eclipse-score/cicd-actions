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

/** Format a hit rate as a percentage, or 'n/a' when nothing was observed. */
function formatPercentage(count, total) {
  if (total === 0) return 'n/a';
  return `${((count / total) * 100).toFixed(2).replace(/\.00$/, '')}%`;
}

export {
  formatPercentage,
};
