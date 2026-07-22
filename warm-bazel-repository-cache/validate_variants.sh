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

mapfile -t bazelrc_files < <(find . -type f \( -name '.bazelrc' -o -name '*.bazelrc' -o -name '.bazelrc.*' \))
if [[ ${#bazelrc_files[@]} -eq 0 ]]; then
  echo "no .bazelrc files were found for validation" >&2
  exit 1
fi

line_no=0
while IFS= read -r variant_line || [[ -n "$variant_line" ]]; do
  line_no=$((line_no + 1))

  if [[ -z "${variant_line//[[:space:]]/}" ]]; then
    continue
  fi

  read -r -a tokens <<< "$variant_line"

  config_arg=""
  config_count=0
  targets=()

  for token in "${tokens[@]}"; do
    if [[ "$token" == --config=* ]]; then
      config_arg="$token"
      config_count=$((config_count + 1))
      continue
    fi

    if [[ "$token" == --* ]]; then
      echo "Unsupported option '$token' in variants line $line_no. Only --config=<name> is supported in this action input." >&2
      exit 1
    fi

    targets+=("$token")
  done

  if [[ $config_count -gt 1 ]]; then
    echo "variants line $line_no contains more than one --config=... argument: $variant_line" >&2
    exit 1
  fi

  if [[ -n "$config_arg" ]]; then
    config_name="${config_arg#--config=}"
    if [[ -z "$config_name" ]]; then
      echo "variants line $line_no has an empty --config value: $variant_line" >&2
      exit 1
    fi

    escaped_config_name="$(printf '%s' "$config_name" | sed -E 's/[][\\.^$*+?(){}|]/\\\\&/g')"
    if ! grep -E -q "^[[:space:]]*[^:#[:space:]]+:${escaped_config_name}([[:space:]]|$)" "${bazelrc_files[@]}"; then
      echo "Unknown --config=$config_name in variants line $line_no. No matching <command>:<name> stanza found in .bazelrc files." >&2
      exit 1
    fi
  fi

  if [[ ${#targets[@]} -eq 0 ]]; then
    echo "variants line $line_no does not contain a target: $variant_line" >&2
    exit 1
  fi

  for target in "${targets[@]}"; do
    bazel query "$target" >/dev/null
  done
done <<< "$variants_input"
