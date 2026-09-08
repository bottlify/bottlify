# Copyright © 2026 Bottlify Project
# Licensed under the Mozilla Public License, version 2.0
# See LICENSE for details

# Pinned build image for video-decoder.wasm. The Emscripten version is part of
# what makes the output reproducible: the same FFmpeg tag through a different
# emsdk is a different binary, so bump this only together with the recorded
# hashes in video-decoder-lock.json.
#
# Toolchain beyond emsdk itself, required by FFmpeg's own configure and Makefile:
#   - git       -> the pinned FFmpeg checkout
#   - make      -> the build
#   - pkg-config, python3 -> configure's probes and helper scripts
#   - nasm/yasm are deliberately absent: --disable-x86asm, there is no x86 here
FROM emscripten/emsdk:3.1.64

RUN apt-get update \
 && apt-get install -y --no-install-recommends git make pkg-config python3 \
 && rm -rf /var/lib/apt/lists/*

COPY build-decoder.sh /usr/local/bin/build-decoder.sh
RUN chmod +x /usr/local/bin/build-decoder.sh

ENTRYPOINT ["build-decoder.sh"]
