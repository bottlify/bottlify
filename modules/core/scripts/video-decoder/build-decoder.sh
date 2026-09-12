#!/usr/bin/env bash
# Copyright © 2026 Bottlify Project
# Licensed under the Mozilla Public License, version 2.0
# See LICENSE for details
#
# Builds video-decoder.wasm: a curated FFmpeg compiled to WebAssembly, linked
# with decoder.c. Runs inside the image built from Dockerfile.video-decoder, in
# two phases so that the image can hold the compiled libraries as a layer:
#
#   build-decoder.sh libs <ffmpeg_source_dir> <work_dir>
#   build-decoder.sh link <ffmpeg_source_dir> <work_dir> <decoder_c> <out_dir>
#
# The build is out-of-tree so that nothing lands back in the source checkout.
#
# LICENCE POSITION, and it is not a detail: neither --enable-gpl nor
# --enable-nonfree is passed. What comes out is FFmpeg under LGPL-2.1-or-later,
# which ships alongside an MPL-2.0 product as a separately licensed component
# whose corresponding source is upstream FFmpeg at the commit the image pins.
# Adding either flag relicenses the whole artifact; do not add them.
set -euo pipefail

PHASE="${1:?usage: build-decoder.sh libs|link ...}"
SRC="${2:?usage: build-decoder.sh <phase> <ffmpeg_source_dir> <work_dir> ...}"
WORK="${3:?usage: build-decoder.sh <phase> <ffmpeg_source_dir> <work_dir> ...}"

BUILD_DIR="${WORK}/ffmpeg-build"
INSTALL_DIR="${WORK}/ffmpeg-install"

# Component names here are configure's names, which are not always the name the
# runtime reports, and an unrecognised one is ignored in silence rather than
# refused -- so a typo does not fail the build, it produces a decoder that
# cannot open a file. Every name below is a configure component
# (--list-demuxers / --list-decoders / --list-parsers); the MPEG program-stream
# demuxer is the clearest trap, `mpegps` here and "mpeg" at runtime. The lists
# are variables rather than literal flags only so that the check after configure
# can assert the same names against the generated headers.
#
# What the set covers: the containers and codecs a Windows program of the late
# nineties and early two-thousands shipped its cinematics in. AVI carrying
# MPEG-4 part 2 with MP3 is the case that must work; the rest is the same era's
# long tail, which costs kilobytes each and is far cheaper to carry now than to
# discover missing later. The MPEG audio decoders also serve the packet-fed
# path in decoder.c, which needs no demuxer at all.
DEMUXERS="avi,mov,asf,wav,ogg,flv,dv"
DEMUXERS="${DEMUXERS},mpegps,mpegvideo,mpegts"
DEMUXERS="${DEMUXERS},bink,smacker,vmd,flic,roq,idcin,fourxm,str"

DECODERS="mpeg4,msmpeg4v1,msmpeg4v2,msmpeg4v3,h263,h263i"
DECODERS="${DECODERS},mpeg1video,mpeg2video,wmv1,wmv2,wmv3,vc1,flv"
DECODERS="${DECODERS},cinepak,indeo2,indeo3,indeo4,indeo5,msvideo1,msrle"
DECODERS="${DECODERS},rawvideo,mjpeg,mjpegb,svq1,svq3,rpza,qtrle,smc,qdraw"
# tscc is absent on purpose and not by oversight: its decoder inflates with
# zlib, and --disable-zlib below is what keeps this artifact free of a second
# vendored library. A TSCC clip is a screen capture, not a cinematic.
DECODERS="${DECODERS},qpeg,truemotion1,truemotion2,dvvideo,theora"
DECODERS="${DECODERS},vp3,vp5,vp6,vp6a,vp6f"
DECODERS="${DECODERS},bink,smacker,vmdvideo,flic,roq,idcin,interplay_video"
DECODERS="${DECODERS},mdec,fourxm"
DECODERS="${DECODERS},mp1,mp2,mp3,mp1float,mp2float,mp3float"
DECODERS="${DECODERS},wmav1,wmav2,vorbis,nellymoser,truespeech,qdm2"
DECODERS="${DECODERS},binkaudio_dct,binkaudio_rdft,smackaud,vmdaudio"
DECODERS="${DECODERS},roq_dpcm,interplay_dpcm,xan_dpcm"
DECODERS="${DECODERS},pcm_u8,pcm_s8,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s32le"
DECODERS="${DECODERS},pcm_f32le,pcm_alaw,pcm_mulaw"
DECODERS="${DECODERS},adpcm_ms,adpcm_ima_wav,adpcm_ima_ws,adpcm_ima_qt"
DECODERS="${DECODERS},adpcm_ea,adpcm_xa,adpcm_swf,adpcm_4xm,adpcm_g726"

PARSERS="mpeg4video,mpegvideo,mpegaudio,h263,vp3,vc1,vorbis"

BSFS="extract_extradata,mpeg4_unpack_bframes"

build_libs() {
    mkdir -p "${BUILD_DIR}" "${INSTALL_DIR}"
    cd "${BUILD_DIR}"
    emconfigure "${SRC}/configure" \
        --prefix="${INSTALL_DIR}" \
        --disable-everything \
        --enable-demuxer="${DEMUXERS}" \
        --enable-decoder="${DECODERS}" \
        --enable-parser="${PARSERS}" \
        --enable-bsf="${BSFS}" \
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
        --nm="${EMSDK}/upstream/bin/llvm-nm" \
        --extra-cflags="-O2"

    # The silence above is the whole reason for this: the generated headers are
    # the only place that say what configure actually accepted, so every
    # requested name is asserted against them and a name that stopped existing
    # fails the build here rather than at the first file a program tries to
    # play. Components live in config_components.h, not config.h -- reading only
    # the latter finds nothing and looks exactly like a build with no codecs.
    cat config.h config_components.h > "${WORK}/enabled.h"
    missing=""
    for group in "DEMUXER:${DEMUXERS}" "DECODER:${DECODERS}" \
                 "PARSER:${PARSERS}" "BSF:${BSFS}"; do
        kind="${group%%:*}"
        for name in $(printf '%s' "${group#*:}" | tr ',' ' '); do
            macro="CONFIG_$(printf '%s' "${name}" | tr '[:lower:]' '[:upper:]')_${kind}"
            if ! grep -qE "^#define ${macro} 1$" "${WORK}/enabled.h"; then
                missing="${missing} ${kind}:${name}"
            fi
        done
    done
    if [ -n "${missing}" ]; then
        echo "configure did not enable:${missing}" >&2
        exit 1
    fi

    emmake make -j"$(nproc)" install-libs install-headers
}

# --no-entry, because there is no main: without it the module imports one and
# the caller has to answer for something that is never called.
#
# Undefined symbols are tolerated for a related reason: a curated FFmpeg still
# references a handful of libc and host entry points -- time zones, file
# descriptors -- that this build's code paths never reach, and the JavaScript
# side answers any leftover import with a no-op rather than failing to
# instantiate.
#
# The export list is the C surface decoder.js answers to; a function missing
# here is a function the JavaScript side finds absent and treats as a build
# without it.
link_decoder() {
    DECODER_C="${4:?usage: build-decoder.sh link <ffmpeg_source_dir> <work_dir> <decoder_c> <out_dir>}"
    OUT="${5:?usage: build-decoder.sh link <ffmpeg_source_dir> <work_dir> <decoder_c> <out_dir>}"
    mkdir -p "${OUT}"
    emcc "${DECODER_C}" \
        -I"${INSTALL_DIR}/include" \
        -L"${INSTALL_DIR}/lib" \
        -lavformat -lavcodec -lswscale -lswresample -lavutil \
        -O2 \
        --no-entry \
        -sSTANDALONE_WASM=1 \
        -sALLOW_MEMORY_GROWTH=1 \
        -sINITIAL_MEMORY=33554432 \
        -sERROR_ON_UNDEFINED_SYMBOLS=0 \
        -sEXPORTED_FUNCTIONS='["_media_alloc","_media_free","_media_open","_media_info","_media_codec_name","_media_decode","_media_frame","_media_audio_pending","_media_audio_read","_media_close","_media_open_audio","_media_feed_audio","_media_flush_audio"]' \
        -o "${OUT}/video-decoder.wasm"

    cd "${OUT}"
    sha256sum video-decoder.wasm > SHA256SUMS
    cat SHA256SUMS
}

case "${PHASE}" in
    libs) build_libs ;;
    link) link_decoder "$@" ;;
    *) echo "unknown phase: ${PHASE} (libs|link)" >&2; exit 2 ;;
esac
