/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * media layer -- decoding the video and audio a program of this era ships its
 * cinematics in.
 *
 * Requires: log.
 *
 * Why this is a layer of its own rather than a corner of graphics: what it
 * decodes is not a drawing API and not a sound API. A clip carries both halves
 * at once, and whoever plays one -- a video renderer, a waveform device, a
 * library a game linked against directly -- reaches the same decoder. Sitting
 * beside filesystem, requiring nothing but log, is also what lets the rest of
 * the engine be assembled without it: `media: null` and the game runs with no
 * cinematics, which is the practical test this project applies to a module.
 *
 * What this layer is not: it is not DirectShow, and it holds no COM interface,
 * no filter graph and no reference clock. It answers in frames and PCM; when
 * to show one and what to show it on belong to the caller.
 *
 * Configuration:
 *
 * ```js
 * {
 *     wasmBytes: ArrayBuffer,   // video-decoder.wasm
 * }
 * ```
 *
 * The binary is injected rather than fetched, for the same reason the emulator's
 * is: this layer must come up under a test runner and inside a worker without
 * knowing which of the two it is in, and where the bytes come from is the
 * decision of whoever assembles the engine. A build given none still assembles;
 * it reports `available() === false` and refuses to open anything, which is the
 * right answer to a cinematic and the wrong answer to starting up.
 *
 * Getting the binary: `npm run fetch:video-decoder` takes it from the pinned
 * release. It is a build artifact and is not in git.
 *
 * The API a consumer sees:
 *
 * - `available()` -- whether this build can decode at all
 * - `prepare()` -- instantiates the decoder ahead of the first open
 * - `open(bytes)` -- a clip, from the whole file in memory
 * - `openAudio({ formatTag, sampleRate, channels })` -- an elementary audio
 *   stream with no container, decoded a packet at a time inside the call that
 *   fed it: `feed(bytes)` answers with the interleaved 16-bit PCM that frame
 *   produced, `flush()` with what the decoder still held, `close()`. Null when
 *   the build cannot serve one, so the caller can fall back; synchronous,
 *   because the caller is a hosted codec answering a call that cannot wait.
 * - `closeAll()` -- drops every clip and stream, for a teardown between games
 *
 * A clip carries its own description (`width`, `height`, `fps`, `frameCount`,
 * `codec`, `fourcc`, `pixelFormat`, `sampleRate`, `channels`, `hasVideo`,
 * `hasAudio`) and four calls:
 *
 * - `decode()` -- advances it, answering `"frame"`, `"audio"` or `"end"`.
 *   `"audio"` means it stopped early because the sound it had decoded had
 *   nowhere left to go: take it with `readAudio()` and call again.
 * - `frame()` -- the current frame as BGRA, a view into the decoder's memory
 *   that is valid until the next call into it.
 * - `audioPending()` / `readAudio()` -- interleaved signed 16-bit PCM, copied
 *   out, at the clip's own sample rate.
 * - `close()`
 *
 * Frames come out as BGRA because that is the byte order of a 32-bit Windows
 * surface: a caller blits them rather than converting them. A clip in an 8-bit
 * or 16-bit format is converted on the way out, which costs a pass over the
 * frame; if a caller ever needs the source format untouched, that is a second
 * output path in decoder.c rather than a conversion undone here.
 *
 * @typedef {import("../../system/contract.js").ModuleConfig} Config
 */
