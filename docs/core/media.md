# media

Decoding the video and audio a program ships its cinematics in, and hosting the JPEG library a
program ships beside itself. See [README.md](README.md) for the layer map, [system.md](system.md)
for the module contract and [host.md](host.md) for how the decoder binary reaches a build.

## Purpose

A clip carries video and audio at once, and whoever plays one -- a DirectShow filter graph, a
library a game linked against directly -- reaches the same decoder; so it is neither a corner of
`graphics` nor of `audio` but a layer of its own, requiring only `log`, which is what lets the rest
of the engine assemble without it (`media: null` runs the game with no cinematics). It is not
DirectShow: it holds no COM interface, no filter graph and no reference clock. It answers in BGRA
frames and signed 16-bit PCM; when to show a frame and what to show it on belong to the caller.
Beside the video decoder it hosts `ijl15.dll`, the Intel JPEG Library redistributable, because a
program of this era decodes its textures through it and, run as guest code, that took a noticeable
share of the machine whenever textures arrived in a burst.

## Contract

| field | value |
|---|---|
| `name` | `media` |
| `version` | `0.1.0` |
| `requires` | `log` |

Source: `src/layers/media/module.js`.

### Configuration

| option | type | default | meaning |
|---|---|---|---|
| `wasmBytes` | `ArrayBuffer` | absent | The video decoder binary, `video-decoder.wasm`. Injected rather than fetched so the layer comes up under a test runner or in a worker without knowing which. Absent, `available()` is false, `open` rejects, and diagnostics carry the issue `No decoder binary was configured: nothing can be played.` |
| `readMemory`, `writeMemory`, `allocate` | `(address, length) => Uint8Array`, `(address, bytes) => void`, `(bytes) => address` | absent | Guest-memory thunks for the hosted JPEG library. All three present publishes `ijl15.dll`; any absent leaves `libraries()` empty. |
| `warn` | `(text) => void` | absent | Where the JPEG library reports what it refused. `src/app.js` routes it to the `divergence` event under the api name `ijl15`. |

Getting the binary: `npm run fetch:video-decoder` (`scripts/fetch-video-decoder.mjs`) downloads
it into `vendor/prebuilt/` from a pinned release and verifies it against
`modules/core/video-decoder-lock.json` (repository, tag, SHA-256 per artifact). It is a build
artifact and is not in git.

### Provided API

| member | what it is |
|---|---|
| `available()` | Whether a binary was configured. |
| `prepare()` | Instantiates the decoder without opening anything, so the cost lands where the caller chooses rather than on the frame a cinematic starts. |
| `open(bytes)` | A clip from the whole file in memory; a promise, because the first call instantiates the module. |
| `openAudio({ formatTag, sampleRate, channels })` | An elementary audio stream with no container, decoded a packet at a time inside the call: `feed(bytes)` answers with the interleaved 16-bit PCM that frame produced, `flush()` with what was still held, `close()`; `sampleRate` and `channels` say what comes out. Synchronous. Null when there is no binary, when the binary was built without the path (an issue in diagnostics says so), or when it is not instantiated yet -- asking starts it, so the next stream finds it. A tag the build cannot serve throws by name. |
| `closeAll()` | Drops every clip, for a teardown between games. |
| `libraries()` | `{ 'ijl15.dll' }` when the guest-memory thunks are configured, else `{}`. |
| `ordinals()` | `{ 'ijl15.dll': { 1..6 } }`, for a program that imports by number. |

A clip carries `width`, `height`, `fps`, `frameCount` (zero when the container does not say),
`codec` (the decoder's own short name), `fourcc`, `pixelFormat` (the source format before
conversion), `sampleRate`, `channels`, `hasVideo`, `hasAudio`, and four calls:

| call | contract |
|---|---|
| `decode()` | Advances the clip and answers `"frame"`, `"audio"` or `"end"`. `"audio"` means it stopped early because the sound it had decoded had nowhere left to go: take it with `readAudio()` and call again. |
| `frame()` | The current frame as BGRA -- the byte order of a 32-bit Windows surface, so a caller blits rather than converts -- as a view into the decoder's memory, valid until the next call into it. Null when there is no video. |
| `audioPending()`, `readAudio()` | Interleaved signed 16-bit PCM at the clip's own rate, copied out. Whatever is still held when the stream ends is still there to take. |
| `close()` | After which every call throws `media: <what> on a closed clip`. |

### Published libraries

| library | entry points | what they are |
|---|---|---|
| `ijl15.dll` | 6 | `ijlGetLibVersion` (1), `ijlInit` (2), `ijlFree` (3), `ijlRead` (4), `ijlWrite` (5), `ijlErrorStr` (6), with the ordinals the shipped library has. |

### `diagnostics()`

| metric | meaning |
|---|---|
| `configured` | Whether a binary was given -- separately from whether anything was decoded, because a binary nothing asked for looks the same as none until this is read. |
| `opened`, `frames`, `audioBytes`, `clips`, `heapBytes` | From the decoder once instantiated: clips ever opened, frames decoded, PCM bytes handed out, clips open now, the module's linear memory size. Absent until the first `open`. |
| `jpeg` | `{ decoded, failed, decodeMs, open }` from the JPEG library, or null when it is not published. |
| `issues` | The missing-binary message, when it applies. |

`status` is `'ready'` only once the decoder has been instantiated; before that it is `'created'`
even with a binary configured.

## How it works

### The video decoder

`src/layers/media/internal/decoder.js` is the JavaScript half of a standalone WebAssembly module
built out of upstream FFmpeg by `scripts/build-video-decoder.mjs`, with no JavaScript glue of its own. Every import the module declares
is answered here: `wasi_snapshot_preview1` and `env` are each a `Proxy` whose unknown names
answer a function returning zero, so a rebuild with a different codec set cannot turn into a link
error, and the two that need real behaviour are explicit -- `proc_exit` throws (a decoder that
decides to exit says so by failing the call it was inside) and `emscripten_notify_memory_growth`
does nothing (every view is taken from the live buffer at the moment of use).

The C surface is the module's `memory` and thirteen functions: `media_alloc`, `media_free`, `media_open(data, size)`,
`media_info(id, out)` (twelve `int32` fields: width, height, pixel format, codec id, fourcc, frame
count, fps numerator and denominator, sample rate, channels, has-video, has-audio),
`media_codec_name`, `media_decode` (status 0 frame, 1 end, 2 audio), `media_frame`,
`media_audio_pending`, `media_audio_read(id, out, max)`, `media_close`, and the packet-fed path
`media_open_audio(formatTag, sampleRate, channels)`, `media_feed_audio(id, data, size)`,
`media_flush_audio(id)`, which share the FIFO and the close. `open` copies the file into
a block the decoder then owns and names the refusal by code: invalid clip, out of memory, too
many clips open, container not recognised, neither video nor audio, no decoder for this stream.
Which containers and codecs the binary understands is decided in
`scripts/video-decoder/build-decoder.sh`, not in this tree; the tree's own test opens a RIFF WAVE file, which is the smallest container the build can
open, and the release is pinned by hash in `video-decoder-lock.json`.

Frames come out as BGRA because that is a 32-bit Windows surface's byte order; an 8- or 16-bit
source is converted on the way out, one pass over the frame.

### How DirectShow reaches it

`win32` sits below this layer and may not import it. `src/app.js` gives `win32` a `video.open(path)`
thunk that reads the whole file through the filesystem (waiting for a bundle's blocks) and calls
`media.open(bytes)`; the filter graph in `src/layers/win32/quartz/graph.js` calls it from
`RenderFile`, which parks the calling thread on the promise. A file this build cannot open -- no
binary, unreadable, unrecognised -- makes the graph answer `VFW_E_CANNOT_RENDER`, which is what a
machine with no codec installed answers. The graph's `tick` then decodes as far as its clock says,
and `src/app.js` copies each frame into the guest-owned surface the graph presents through
`graphics.present` and writes each audio block into a mixer track of the clip's own rate, holding
the picture back by how much of the film's sound is still owed when the audio ring is drained,
and not at all otherwise.

### The hosted JPEG library

`src/layers/media/internal/ijl.js` implements the library's published contract over
`JPEG_CORE_PROPERTIES`: a caller fills the structure, asks `ijlRead` for the parameters of a
buffer (`JBUFF_READPARAMS` describes the picture without decoding), sizes a DIB, then asks for the
whole image into it (`JBUFF_READWHOLEIMAGE`). A negative `DIBHeight` is top-down; rows honour
`DIBPadBytes`. YCbCr is converted to RGB or BGR when the caller asks for either; anything else --
a four-component picture in particular -- is handed over as the components lie, which is what a
texture format that stores its own channels wants. `ijlErrorStr` names the library's own codes.
`src/layers/media/internal/jpeg.js` is the decoder underneath: baseline sequential Huffman
(`SOF0`/`SOF1`), one to four components, any sampling factors, restart intervals, 8-bit samples,
components returned interleaved in the frame's order.

### When it is absent

`media: null` in the module configuration, or a build with no `wasmBytes`, comes up: `available()`
is false, `open` throws `media: this build has no decoder binary`, the filter graph refuses to
render, and the JPEG library is still published if its thunks are present. A build with the
thunks absent publishes no library and a program that ships `ijl15.dll` runs the copy it ships as
guest code.

## Limitations and divergences

- **One clip at a time is the intended use**; the binary refuses past its own limit (`too many
  clips are open`).
- **No seeking, no clock, no presentation.** A clip only advances; timing and display are the
  caller's (the filter graph's).
- **A frame is a view**, valid until the next call into the decoder; a caller that keeps one
  copies it.
- **Audio must be drained**: `decode()` stops with `"audio"` until `readAudio()` makes room.
- **The codec set is the binary's**, not documented in this tree; a stream it cannot decode is
  refused by name at `open`.
- **JPEG:** anything but sequential Huffman coding is refused as `IJL_PROGRESSIVE_UNSUPPORTED`,
  samples wider than 8 bits and malformed data as `IJL_ERR_DATA`; reading by file name (`JFILE_*`)
  answers `IJL_FILE_ERROR` and warns `ijl: reading a JPEG by file name is not supported`;
  `ijlWrite` warns `ijl: encoding is not supported`. `JBUFF_READHEADER` is answered as
  `READPARAMS` and `JBUFF_READENTROPY` as `READWHOLEIMAGE`. Every refusal is counted under
  `jpeg.failed` and reported through `warn`.
- The file header of `ijl.js` lists the structure's offsets in one order (`DIBWidth` at 4,
  `DIBHeight` at 8, ...) while the `OFFSET` table the code reads puts `DIBBytes` at 4 and
  `DIBWidth` at 8, with a note that the core fields are laid out channel-count-before-colour on
  both sides; the table is what runs.

## Tests

All under `npm test` from `modules/core` (`node --test "src/**/*.test.js"`); 19 `test()` cases.

| file | kind | what it pins |
|---|---|---|
| `src/layers/media/module.test.js` | Wiring | A build with no binary comes up and says so; a configured build is not instantiated until something is opened; `closeAll` is safe before anything was opened. |
| `src/layers/media/internal/decoder.test.js` | Contract against the real binary; skips with `video-decoder.wasm is absent: run npm run fetch:video-decoder` when it has not been fetched | A file the build cannot make sense of is refused by name; an empty file is refused; a WAVE clip reports what it holds and hands back every sample; a decoded clip is counted and `closeAll` lets it go. |
| `src/layers/media/internal/ijl.test.js` | Contract, over a flat guest memory | Ordinals; `ijlInit` clears the structure and sets the default quality; parameters without decoding; the whole image lands in the DIB four channels as they lie; row order, negative height and padding; refusals with the library's own codes and names. |
| `src/layers/media/internal/jpeg.test.js` | Byte-exact, against pictures computed from the definition of the transform | Streams built from coefficients with the file's own Huffman tables: no fixture from anywhere and nothing taken on trust from another decoder. |

No test in the tree decodes a video stream; the decoder's video path is exercised only through a
title in a CDP run, and no tracked scenario asserts on a decoded frame.
