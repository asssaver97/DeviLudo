#!/usr/bin/env bash
set -Eeuo pipefail
source_file=${1:?source file is required}
output_file=${2:?output file is required}
[[ -f $source_file && $output_file == /* ]]
command -v cc >/dev/null
command -v pkg-config >/dev/null
pkg-config --exists json-c
cc -std=c17 -O2 -D_FORTIFY_SOURCE=2 -fstack-protector-strong -Wall -Wextra -Werror \
  $(pkg-config --cflags json-c) "$source_file" -o "$output_file" \
  $(pkg-config --libs json-c)
chmod 0555 "$output_file"
