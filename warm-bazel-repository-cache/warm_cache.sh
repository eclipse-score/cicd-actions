#!/usr/bin/env bash

# *******************************************************************************
# Copyright (c) 2026 Contributors to the Eclipse Foundation
#
# See the NOTICE file(s) distributed with this work for additional
# information regarding copyright ownership.
#
# This program and the accompanying materials are made available under the
# terms of the Apache License Version 2.0 which is available at
# https://www.apache.org/licenses/LICENSE-2.0
#
# SPDX-License-Identifier: Apache-2.0
# *******************************************************************************

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <variants-input>" >&2
  exit 2
fi

variants_input="$1"

mapfile -t variants < <(printf '%s\n' "$variants_input" | sed '/^[[:space:]]*$/d')
if [[ ${#variants[@]} -eq 0 ]]; then
  echo "No variants were provided."
  exit 1
fi

max_attempts=10
failed_variants=()

for variant in "${variants[@]}"; do
  read -r -a fetch_args <<< "$variant"
  if [[ ${#fetch_args[@]} -eq 0 ]]; then
    echo "Skipping empty bazel fetch arguments entry"
    continue
  fi

  success=false

  for attempt in $(seq 1 "$max_attempts"); do
    echo "Running bazel fetch ${variant} (attempt ${attempt}/${max_attempts})"
    bazel_fetch_cmd=(bazel fetch)

    if "${bazel_fetch_cmd[@]}" "${fetch_args[@]}"; then
      echo "Successfully fetched dependencies for arguments '${variant}'"
      success=true
      break
    fi

    if [[ "$attempt" -lt "$max_attempts" ]]; then
      backoff_seconds=$((attempt * 20))
      echo "bazel fetch failed (likely transient). Retrying in ${backoff_seconds}s..."
      sleep "$backoff_seconds"
    fi
  done

  if [[ "$success" != "true" ]]; then
    echo "bazel fetch failed for arguments '${variant}' after ${max_attempts} attempts"
    failed_variants+=("${variant}")
  fi
done

if [[ ${#failed_variants[@]} -ne 0 ]]; then
  echo "Bazel fetch failed for the following variants:"
  for variant in "${failed_variants[@]}"; do
    echo "  - ${variant}"
  done
  exit 1
fi
