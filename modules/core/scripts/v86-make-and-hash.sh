#!/usr/bin/env bash
# Copyright Bottlify Project 2026
# Licenses and contributions: THIRD-PARTY-NOTICES.md
#
# Builds v86 from a checked-out submodule and copies the distributable
# artifacts into the output directory.
set -euo pipefail

SRC="${1:?usage: v86-make-and-hash.sh <src_dir> <out_dir>}"
OUT="${2:?usage: v86-make-and-hash.sh <src_dir> <out_dir>}"

mkdir -p "${OUT}"

make -C "${SRC}" all

cp "${SRC}/build/libv86.js"   "${OUT}/libv86.js"
cp "${SRC}/build/v86.wasm"    "${OUT}/v86.wasm"
cp "${SRC}/bios/seabios.bin"  "${OUT}/seabios.bin"
cp "${SRC}/bios/vgabios.bin"  "${OUT}/vgabios.bin"

for f in libv86.js v86.wasm seabios.bin vgabios.bin; do
  sha256sum "${OUT}/${f}"
done