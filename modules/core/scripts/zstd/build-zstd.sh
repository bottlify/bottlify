#!/usr/bin/env bash
# Copyright © 2026 Bottlify Project
# Licensed under the Mozilla Public License, version 2.0
# See LICENSE for details
#
# Builds zstd.wasm from zstd.c: one freestanding C file to WebAssembly with
# clang and wasm-ld, no libc, no entry, the memory exported and growable.
#
#   build-zstd.sh <zstd.c> <out_dir>
#
# Runs inside the image built from Dockerfile.zstd (clang pinned there), or on
# any machine with clang and lld that can target wasm32 (`--native` of
# build-zstd.mjs, the owner's Ubuntu VM). The output is a function of the
# source and the compiler alone, so the same source through the same image
# gives the same bytes, which is what the reproducibility check demands.
set -euo pipefail

SRC="${1:?usage: build-zstd.sh <zstd.c> <out_dir>}"
OUT="${2:?usage: build-zstd.sh <zstd.c> <out_dir>}"
CLANG="${CLANG:-$(command -v clang-16 || command -v clang)}"

mkdir -p "${OUT}"
"${CLANG}" --target=wasm32 -O3 -nostdlib -ffreestanding -fno-exceptions \
    -Wall -Wextra -Werror \
    -Wl,--no-entry -Wl,--export-memory -Wl,--export=__heap_base \
    -Wl,--initial-memory=1048576 -Wl,-z,stack-size=65536 \
    -o "${OUT}/zstd.wasm" "${SRC}"

cd "${OUT}"
sha256sum zstd.wasm > zstd.SHA256SUMS
echo "zstd.wasm: $(stat -c %s zstd.wasm) bytes, $(cut -c1-16 zstd.SHA256SUMS)..."
