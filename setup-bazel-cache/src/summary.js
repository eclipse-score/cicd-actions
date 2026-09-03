// *******************************************************************************
// Copyright (c) 2026 Contributors to the Eclipse Foundation
//
// See the NOTICE file(s) distributed with this work for additional
// information regarding copyright ownership.
//
// This program and the accompanying materials are made available under the
// terms of the Apache License 2.0 which is available at
// https://www.apache.org/licenses/LICENSE-2.0
//
// SPDX-License-Identifier: Apache-2.0
// *******************************************************************************

import {
  cacheLabel,
  formatBytes,
  RESTORE_RESULT,
} from './cache.js';
import {
  externalCacheLabel,
  externalRepositoryCache,
} from './external.js';

/** Describe a restore result with the plain-language reason shown alongside it. */
function describeRestoreResult(result) {
  switch (result) {
    case RESTORE_RESULT.TRUE: return 'true (exact hit)';
    case RESTORE_RESULT.PARTIAL: return 'partial (older generation)';
    case RESTORE_RESULT.FALSE: return 'false (miss)';
    case RESTORE_RESULT.SKIPPED: return 'skipped (disabled)';
    case RESTORE_RESULT.UNKNOWN: return 'unknown (restore error)';
    default: return result;
  }
}

/**
 * Convert restore details into the rows shown by the main-action summary.
 * External restore details contain a manifest and dynamic repository entries;
 * keeping those entries separate makes a missing repository visible instead of
 * hiding it in the aggregate external result.
 */
function restoreSummaryRows(configuration, restoreDetails) {
  const size = (value) => value === null ? 'unknown' : formatBytes(value);
  const row = (label, detail) => [
    label,
    describeRestoreResult(detail.result),
    size(detail.sizeAfter),
  ];
  const rows = Object.entries(restoreDetails)
    .filter(([name]) => name !== 'external')
    .map(([name, detail]) => row(
      cacheLabel(configuration, configuration.caches[name]),
      detail,
    ));
  const external = restoreDetails.external;

  if (!external) return rows;
  if (external.manifest) {
    rows.push(row(
      cacheLabel(configuration, configuration.caches.externalManifest),
      external.manifest,
    ));
  }
  for (const [name, detail] of Object.entries(external.repositories)) {
    rows.push(row(
      cacheLabel(configuration, externalRepositoryCache(configuration, name)),
      detail,
    ));
  }

  // A manifest can restore successfully but still fail while being parsed.
  // Keep that aggregate error visible in addition to the component details.
  if (external.result === RESTORE_RESULT.UNKNOWN) {
    rows.push(row(externalCacheLabel(configuration), external));
  }

  // There is no manifest detail when the complete external family was skipped
  // or its output base could not be resolved, so retain one aggregate row.
  if (!external.manifest && Object.keys(external.repositories).length === 0) {
    rows.push(row(externalCacheLabel(configuration), external));
  }
  return rows;
}

export {
  describeRestoreResult,
  restoreSummaryRows,
};
