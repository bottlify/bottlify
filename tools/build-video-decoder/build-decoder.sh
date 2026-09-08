#!/usr/bin/env bash
# Copyright © 2026 Bottlify Project
# Licensed under the Mozilla Public License, version 2.0
# See LICENSE for details
#
# Builds video-decoder.wasm: a curated FFmpeg compiled to WebAssembly, linked
# with decoder.c. Runs inside the image built from Dockerfile.
#
#   build-decoder.sh <source_dir> <out_dir> <work_dir>
#
# LICENCE POSITION, and it is not a detail: neither --enable-gpl nor
# --enable-nonfree is passed. What comes out is FFmpeg under LGPL-2.1-or-later,
# which ships alongside an MPL-2.0 product as a separately licensed component
# whose corresponding source is the pinned tag below. Adding either flag
# relicenses the whole artifact; do not add them.
set -euo pipefail

SRC="${1:?usage: build-decoder.sh <source_dir> <out_dir> <work_dir>}"
OUT="${2:?usage: build-decoder.sh <source_dir> <out_dir> <work_dir>}"
WORK="${3:-/work}"

# Pinned, never a branch: the component names below are configure's names, and
# what a release calls them is part of what this pin holds still.
FFMPEG_TAG="n6.1"
FFMPEG_REPO="https://github.com/FFmpeg/FFmpeg.git"

SOURCE_DIR="${WORK}/ffmpeg"
INSTALL_DIR="${WORK}/ffmpeg-install"

mkdir -p "${OUT}" "${WORK}"

if [ ! -d "${SOURCE_DIR}/.git" ]; then
    git clone --depth 1 --branch "${FFMPEG_TAG}" "${FFMPEG_REPO}" "${SOURCE_DIR}"
fi

FFMPEG_COMMIT="$(git -C "${SOURCE_DIR}" rev-parse HEAD)"

# Component names here are configure's names, which are not always the name the
# runtime reports, and an unrecognised one is ignored in silence rather than
# refused -- so a typo does not fail the build, it produces a decoder that
# cannot open a file. Every name below is a configure component
# (--list-demuxers / --list-decoders / --list-parsers); the MPEG program-stream
# demuxer is the clearest trap, `mpegps` here and "mpeg" at runtime.
#
# What the set covers: the containers and codecs a Windows game of the late
# nineties and early two-thousands shipped its cinematics in. AVI carrying
# MPEG-4 part 2 with MP3 is the case that must work; the rest is the same era's
# long tail, which costs kilobytes each and is far cheaper to carry now than to
# discover missing later.
if [ ! -f "${INSTALL_DIR}/lib/libavcodec.a" ]; then
    cd "${SOURCE_DIR}"
    emconfigure ./configure \
        --prefix="${INSTALL_DIR}" \
        --disable-everything \
        --enable-demuxer=avi,mov,asf,wav,ogg,flv,dv \
        --enable-demuxer=mpegps,mpegvideo,mpegts \
        --enable-demuxer=bink,smacker,vmd,flic,roq,idcin,fourxm,str \
        --enable-decoder=mpeg4,msmpeg4v1,msmpeg4v2,msmpeg4v3,h263,h263i \
        --enable-decoder=mpeg1video,mpeg2video,wmv1,wmv2,wmv3,vc1,flv \
        --enable-decoder=cinepak,indeo2,indeo3,indeo4,indeo5,msvideo1,msrle \
        --enable-decoder=rawvideo,mjpeg,mjpegb,svq1,svq3,rpza,qtrle,smc,qdraw \
        --enable-decoder=qpeg,tscc,truemotion1,truemotion2,dvvideo,theora \
        --enable-decoder=vp3,vp5,vp6,vp6a,vp6f \
        --enable-decoder=bink,smacker,vmdvideo,flic,roq,idcin,interplay_video \
        --enable-decoder=mdec,fourxm \
        --enable-decoder=mp1,mp2,mp3,mp1float,mp2float,mp3float \
        --enable-decoder=wmav1,wmav2,vorbis,nellymoser,truespeech,qdm2 \
        --enable-decoder=binkaudio_dct,binkaudio_rdft,smackaud,vmdaudio \
        --enable-decoder=roq_dpcm,interplay_dpcm,xan_dpcm \
        --enable-decoder=pcm_u8,pcm_s8,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s32le \
        --enable-decoder=pcm_f32le,pcm_alaw,pcm_mulaw \
        --enable-decoder=adpcm_ms,adpcm_ima_wav,adpcm_ima_ws,adpcm_ima_qt \
        --enable-decoder=adpcm_ea,adpcm_xa,adpcm_swf,adpcm_4xm,adpcm_g726 \
        --enable-parser=mpeg4video,mpegvideo,mpegaudio,h263,vp3,vc1,vorbis \
        --enable-bsf=extract_extradata,mpeg4_unpack_bframes \
        --enable-avformat --enable-avcodec --enable-avutil \
        --enable-swscale --enable-swresample \
        --disable-programs --disable-doc --disable-autodetect \
        --disable-network --disable-debug \
        --disable-iconv --disable-zlib --disable-bzlib --disable-lzma --disable-sdl2 \
        --disable-x86asm --disable-inline-asm --disable-pthreads \
        --enable-cross-compile \
        --target-os=none \
        --arch=c \
        --cc=emcc \
        --cxx=em++ \
        --ar=emar \
        --ranlib=emranlib \
        --nm=llvm-nm \
        --extra-cflags="-O2"

    emmake make -j"$(nproc)" install-libs install-headers
fi

# --no-entry, because there is no main: without it the module imports one and
# the caller has to answer for something that is never called.
#
# Undefined symbols are tolerated for a related reason: a curated FFmpeg still
# references a handful of libc and host entry points -- time zones, file
# descriptors -- that this build's code paths never reach, and the JavaScript
# side answers any leftover import with a no-op rather than failing to
# instantiate.
emcc "${SRC}/decoder.c" \
    -I"${INSTALL_DIR}/include" \
    -L"${INSTALL_DIR}/lib" \
    -lavformat -lavcodec -lswscale -lswresample -lavutil \
    -O2 \
    --no-entry \
    -sSTANDALONE_WASM=1 \
    -sALLOW_MEMORY_GROWTH=1 \
    -sINITIAL_MEMORY=33554432 \
    -sERROR_ON_UNDEFINED_SYMBOLS=0 \
    -sEXPORTED_FUNCTIONS='["_media_alloc","_media_free","_media_open","_media_info","_media_codec_name","_media_decode","_media_frame","_media_audio_pending","_media_audio_read","_media_close"]' \
    -o "${OUT}/video-decoder.wasm"

cd "${OUT}"
sha256sum video-decoder.wasm > SHA256SUMS
cat SHA256SUMS
echo "ffmpeg ${FFMPEG_TAG} ${FFMPEG_COMMIT}"
