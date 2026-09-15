# audio

The sound APIs a Win32 program was written against, mixed into one stream that leaves the engine
through a ring in shared memory. See [README.md](README.md) for the layer map, [system.md](system.md)
for the module contract and [host.md](host.md) for what the page has to do with the ring.

## Purpose

A program of this era plays music through one API and effects through another, and expects the
machine to add them together. This layer owns DirectSound (`DSOUND.dll`), hosts the MPEG Layer 3
provider a sound middleware loads beside a program (`Mp3dec.asi`), and provides the mixer that
`win32`'s wave-out surface (`WINMM.dll`, `src/layers/win32/winmm/functions.js`) also writes into.
Every source becomes 48 kHz stereo float, is added into one block, and is written ahead into a
ring; a WebAudio worklet on the page reads the other end. The ring's read index is the only
feedback channel, and a program's play cursor is built on it rather than on a clock, so what the
program believes has played and what a person has heard are the same number.

## Contract

| field | value |
|---|---|
| `name` | `audio` |
| `version` | `0.1.0` |
| `requires` | `win32`, `bridge`, `memory` |

Source: `src/layers/audio/module.js`. The DirectSound seam imports `IUNKNOWN_METHODS` from
`src/layers/win32/ole32/objects.js`, which `requires` admits.

### Configuration

| option | type | default | meaning |
|---|---|---|---|
| `drained` | boolean | `false` | Whether something is reading the far end of the ring. `false` means the mixer is never fed from DirectSound buffers (`refusedFills` counts each refusal), `available()` is false, and a program's cursors advance against the clock alone. |
| `memory` | `{ control, samples }` | absent | The storage of an existing ring. Given, the mixer's output is that ring rather than a new one, continuing its written/read counts. Set by `createApp` on a rebuilt machine so a process replacement mixes into the sound output its reader already holds. |
| `sampleRate` | number | `48000` | The mixer's output rate. Every track is resampled to it. |
| `allocate` | `(bytes) => address` | page-aligned addresses from `0x50000000`, never written | Guest memory for a sound buffer's samples and the provider's tables. The default lets the model run with no guest at all. |
| `now` | `() => ms` | `Date.now` | The guest's clock; cursors advance against it. |
| `publishInterface` | `(object, iid) => address` | `() => 0` | The bridge's vtable publisher; the default refuses rather than publishing into nowhere. |
| `signal` | `(eventHandle) => void` | absent | Sets an event an `IDirectSoundNotify` position names. |
| `callGuest` | `(entry, args, thread?) => Promise<number>` | `bridge.callGuest` | Runs a guest routine, for device enumeration and the provider's registration. |
| `currentThread` | `() => thread` | `() => undefined` | Whose call the provider is answering, read before it awaits. |
| `resolveImport` | `(library, name) => address \| null` | `() => null` | The guest address of an export, of the sound middleware or of the provider itself. |
| `openAudio` | `(shape) => AudioStream | null` | absent | The media layer's packet-fed decoder, handed down by the assembling caller. Present, the provider decodes each frame inside the call that fed it (`createSynchronousDecoder`) and falls back to WebCodecs per stream when it answers null. |
| `decoder` | `Decoder` | from `openAudio`, else `createWebCodecsDecoder()` | The MPEG decoder behind the provider; a test substitutes one. |
| `mp3` | boolean | `true` | Whether `Mp3dec.asi` is published at all. `false` leaves a program to run the decoder it ships. |
| `warn` | `(text) => void` | absent | Where the provider reports a failure. |

### Provided API

| member | what it is |
|---|---|
| `libraries()` | `{ 'DSOUND.dll', 'Mp3dec.asi' }` (the second only when `mp3 !== false`), shaped like a `win32` library's tables. |
| `output()` | The mixer: `open(format)`, `pump(frames?)`, `ring`, `sampleRate`, `channels`, `capacityFrames`, `consumed()`, `diagnostics()`. Handed down to `win32` by the assembling caller because `win32` sits below this layer. |
| `pump(frames?)` | Mixes ahead into the ring; called once a scheduler turn by whoever drives the machine, before the turn yields. |
| `available()` | `config.drained`. |
| `feeding()` | `{ sink, fills, refusedFills, notified, fedRanges, fedBytes, tracksOpen }`. |
| `buffers()` | Every DirectSound buffer a program created. |
| `dsound()`, `mp3()` | The seam and the provider objects, for whoever is measuring. |
| `decoder()` | Which decoder stands behind the provider and how its streams were served: `{ name: 'synchronous', opens, fallbackOpens, paddedFrames }`, `{ name: 'webcodecs' }` or `{ name: 'custom' }`. Also under `diagnostics().metrics.decoder`. |
| `behind()` | Turns a track's backlog was dropped for being past its moment. |

### Published libraries

| library | entry points | what they are |
|---|---|---|
| `DSOUND.dll` | 7 | `DirectSoundCreate`, `DirectSoundCreate8`, `DirectSoundEnumerateA/W`, `DirectSoundCaptureCreate`, `DirectSoundCaptureCreate8` (both `DSERR_UNSUPPORTED`: there is no capture device), `DllCanUnloadNow`. |
| `Mp3dec.asi` | 11 | `DllMain`, `PROVIDER_query_attribute`, `ASI_startup`, `ASI_shutdown`, `ASI_error`, `ASI_stream_open`, `ASI_stream_process`, `ASI_stream_seek`, `ASI_stream_close`, `ASI_stream_attribute`, `ASI_stream_set_preference`. Nothing is imported by name; the middleware finds these through the tables `DllMain` registers. |

Interfaces published (`src/layers/audio/dsound/seam.js`): `IDirectSound` and `IDirectSound8`
(8 slots after `IUnknown`), `IDirectSoundBuffer` (18) and `IDirectSoundBuffer8` (21),
`IDirectSoundNotify` (1). `IDirectSound3DListener` and `IDirectSound3DBuffer` are deliberately
not declared, so `QueryInterface` answers `E_NOINTERFACE` rather than handing back a table that
ends after `IUnknown`.

### `diagnostics()`

| metric | meaning |
|---|---|
| `libraries` | Library names published. |
| `buffers`, `playing`, `published`, `creations`, `calls`, `events`, `refusedInterfaces`, `cooperativeLevel`, `enumerations` | From the seam: how many buffers exist and play, interfaces published, every buffer asked for with its flags and answer, per-method call counts, the last calls in order, interface ids refused, the last cooperative level, how often devices were enumerated. |
| `mp3` | `{ registered, provider, opens, failedOpens, open, samplesOut, waits, lastError, recent, streams[] }` -- per stream `size`, `read`, `inputDone`, `frames`, `rate`, `channels`, `fed`, `decoded`, `done`, `position`, `preferences`. |
| `tracks`, `queuedFrames`, `ringFilled`, `produced`, `consumed`, `deviceBlocks`, `starvedBlocks`, `starvedFrames`, `shortfall`, `perTrack`, `idlePumps`, `pumps` | From the mixer and ring. `starvedBlocks`/`starvedFrames` are the audible artifact itself, counted by the worklet; `deviceBlocks` is how often it asked. |
| `behindTurns` | Backlogs dropped. |
| `sink`, `fills`, `refusedFills`, `notified`, `fedRanges`, `fedBytes`, `tracksOpen` | The feeding path. With `sink` false every other number is legitimately zero. |
| `bufferDetail` | One line per secondary buffer: status, cursors, size, frequency. |

## How it works

### Mixer and ring

`src/layers/audio/output/mixer.js` keeps one track per open source. A track converts on write:
8-bit unsigned or 16-bit signed PCM, mono or stereo, at any rate, becomes interleaved stereo
float at the output rate through a linear resampler whose state (`pos`, `tail`) carries across
buffer boundaries, so a stream delivered in thousands of small pieces joins without a
discontinuity; at the output's own rate the path is an exact copy. Each track keeps a ledger of
`{ frames, bytes }` per buffer written so `playedBytes()` credits whole buffers exactly rather
than reconstructing bytes from a rate ratio, and retires ledger entries behind the cursor so the
walk does not grow with the run. `pump()` first calls `fill` (the DirectSound feed), then mixes the
longest pending block among unpaused tracks into the ring, adding each track scaled by its
`gain`; a track short of the block is counted under `shortfall` and its own `short`. A track's
`played()` is what it mixed less what still sits in the ring, held monotonic.

`src/layers/audio/output/ring.js` is the one place sound crosses out. A ring of interleaved
float32 frames with a five-slot `Int32Array` control block -- `WRITTEN`, `READ`,
`STARVED_BLOCKS`, `STARVED_FRAMES`, `BLOCKS` -- allocated as `SharedArrayBuffer` where the
environment allows and ordinary memory where it does not. Indices are monotonic; the difference
is the fill; capacity rounds up to a power of two. `write` takes as many frames as fit and never
blocks, because holding a guest thread is the one cost this engine will not pay for sound. `read`
fills what is not there with silence and counts only real frames as consumed, so a play cursor
never runs through a gap nobody filled. Default capacity is `sampleRate / 5`: two hundred
milliseconds at 48 kHz, 9,600 frames, rounded to 16,384.

`src/layers/audio/output/worklet.js` is the far end, an `AudioWorkletProcessor` registered as
`bottlify-output`. It is loaded by URL rather than imported (the build copies it to
`dist/worklet.js`) and duplicates the ring's twenty lines of read logic knowingly, because
importing across the worklet boundary is not possible; the five control-slot constants are the
whole of what has to stay in step. Per block it adds one to `BLOCKS`, copies what is there, fills
the rest with silence, advances `READ` by the real frames only, and on a short block adds to
`STARVED_BLOCKS` and `STARVED_FRAMES`. A mono graph over the stereo ring takes the left channel.
The page does: `audioWorklet.addModule(<worklet url>)`, then
`new AudioWorkletNode(context, 'bottlify-output', { outputChannelCount: [channels], processorOptions: { control, samples, channels } })`
with `control` and `samples` from `app.audio.ring().memory` and `channels` from
`app.audio.format()`, and assembles the engine with `audio.drained: true`. A post of `'stop'` to
the node's port ends the processor.

Pump timing is the assembling caller's: `src/app.js` calls `sound.pump()` once per scheduler
turn, before the turn yields to the browser, so the ring is topped up before the thread may be
taken for composition or garbage collection.

### DirectSound

`src/layers/audio/dsound/buffers.js` is a buffer without the COM: a pair of cursors advancing
against the guest's clock at `frequency * blockAlign` bytes per second, the write cursor leading
the play cursor by 30 ms while playing and trailing it by 15 ms when stopped so a locked range
from the write cursor covers nearly the whole buffer. A lock that runs off the end comes back as
two ranges. Volume and pan are hundredths of a decibel within the documented bounds; `gain` is the
volume as a factor. `drainPlayed()` hands back the byte ranges the play cursor has passed since it
was last asked -- what a person hears -- and `drainNotifications()` the events whose positions it
crossed. Looping, `SetCurrentPosition`, `SetFrequency` (zero restores the format's rate) and
`Restore` (always succeeds; nothing here loses a buffer) are modelled; a duplicate shares its
original's samples with cursors of its own.

`src/layers/audio/dsound/seam.js` publishes the interfaces above with one method list per
descriptor shared by every object (a list per buffer was a stub table per buffer, and the stub
table is finite), and one adapter per object so identity survives. `DirectSoundCreate` hands out
the one root object every time. `GetCaps` names every `PRIMARY*` and `SECONDARY*` mono/stereo/8/16
flag plus `CONTINUOUSRATE` and `CERTIFIED`, and writes every hardware field as zero;
`EMULDRIVER` is deliberately not set, because a middleware reading it concludes DirectSound is not
really there. `SetFormat` succeeds on the primary and is refused on a secondary.
`DirectSoundEnumerateA/W` call the guest's callback twice -- the primary driver with a null GUID,
then one device -- and stop early if the callback returns FALSE; without `callGuest` they succeed
having named nothing. The module's `feedBuffers` runs before every mix: it drains every buffer's
notifications and signals them whether or not anything is listening (a program that waits on a
position must be woken even in a silent build), then, when `drained`, opens a mixer track per
secondary buffer on first play and writes the drained byte ranges from guest memory into it,
resetting a track whose backlog exceeds the ring's capacity and counting that under `behind`.

### The hosted MPEG provider

`src/layers/audio/asi/provider.js` stands in for the Layer 3 decoder a sound middleware loads
from beside a program. The middleware `LoadLibrary`s the file, expects its `DllMain` to register
two interfaces -- `"ASI codec"` and `"ASI stream"` -- through the middleware's own `RIB`
entry points (`_RIB_provider_library_handle@0`, `RIB_register_interface`, resolved through
`resolveImport` against `mss32.dll`), and then calls the registered functions directly. The
tables are written into guest memory once, with the entry types, attribute tokens and data
subtypes the redistributable decoder registers, because the middleware compares the numbers.

Decoding is hosted. `ASI_stream_open` reads the compressed stream through the middleware's fetch
callback in `FETCH_CHUNK` (65,536-byte) pieces from a guest scratch block, each read continuing
from where the last stopped (offset -1) because the callback was measured miscounting a named
offset outside its window; the size stated at open is advisory. `src/layers/audio/asi/mp3.js`
scans frame headers (MPEG 1, 2 and 2.5, skipping an ID3v2 tag, probing the first 262,144 bytes
for a frame) and cuts the stream at frame boundaries. Each frame goes to the decoder as it is
read: with `openAudio` configured that is the media layer's hosted decoder, which answers inside
`feed` (`createSynchronousDecoder`), so every fed frame's samples are in hand before the request
that read it returns and a frame the decoder rejects is made up with silence (`paddedFrames`);
without it, or per stream when the media layer answers null, the platform's `AudioDecoder`
(WebCodecs, codec `'mp3'`) decodes them and `interleave16` turns each `AudioData` into
interleaved 16-bit samples. Before the stream is handed over, `LEAD_FRAMES` (8) frames are read
ahead and kept in front of the position; an `ASI_stream_process` that has fed enough and finds
it not yet decoded -- only the platform decoder, which was measured answering up to a second
late while a program starts -- waits (counted in `waits`) rather than answering short, which holds
the guest thread and whatever lock it took. With the hosted decoder `waits` stays at zero. `seek` finds
the frame at or after the byte offset, `attribute` answers rates, widths, channels, position and
percent done, `set_preference` records requested rate, width and channels.

The provider is off when `config.mp3 === false`; then the program runs the decoder it ships as
guest code. It is also inert on a platform with no `AudioDecoder`: `createWebCodecsDecoder().open`
throws, and the open fails with a message `ASI_error` returns.

## Limitations and divergences

- **Nothing is heard unless the page drains the ring.** With `drained: false` the cursors still
  advance and notifications still fire, but no sample leaves a DirectSound buffer, by design.
- **No 3D audio.** `IDirectSound3DListener` and `IDirectSound3DBuffer` answer `E_NOINTERFACE`;
  pan is applied, position is not.
- **No capture.** Both capture entry points answer `DSERR_UNSUPPORTED`.
- **`SetCooperativeLevel` is recorded and not enforced.** Windows refuses `SetFormat` on the
  primary below `DSSCL_PRIORITY`; this layer does not. The seam's own comment notes it has no
  reporter to say so through -- there is no `divergence` hook in this layer.
- **`IDirectSoundBuffer8`'s `SetFX`, `AcquireResources`, `GetObjectInPath`, and
  `IDirectSound8::VerifyCertification`** are declared and unimplemented (`E_NOTIMPL` from the
  right slot).
- **Resampling is linear.** Cheap and click-free at block boundaries by construction; not the last
  word on quality.
- **One buffer's backlog past 200 ms is dropped**, not delayed: the program's current sound is the
  one meant to be heard.
- **The provider's requests block the guest** when the decoder falls more than the lead behind.
- **A stream's fetch callback is read serially through guest calls**, one chunk per crossing.

Reported at runtime: `starvedBlocks`/`starvedFrames` (holes a person heard), `shortfall` and
`perTrack.short` (a track mixed short while another carried the block), `behindTurns`,
`refusedFills`, `refusedInterfaces` by id, the provider's `lastError`, `recent` requests and
`waits`, and every `warn` the provider raises.

## Tests

All under `npm test` from `modules/core` (`node --test "src/**/*.test.js"`); 132 `test()` cases.

| file | kind | what it pins |
|---|---|---|
| `src/layers/audio/module.test.js` | Wiring | A sound a program plays actually reaches the ring with its own bytes at its own gain; nothing is read out with no sink; a stall costs time rather than unread sound; a program waiting on a position is woken even with nothing listening; `mp3: false` withholds the provider. |
| `src/layers/audio/output/mixer.test.js` | Unit | Format conversion, resampling across seams, the ledger's exact byte credit, pausing, `played()` monotonic, shortfall counting. |
| `src/layers/audio/output/ring.test.js` | Unit | Fill and room, short writes, silence on a short read, starvation counters, `clear`. |
| `src/layers/audio/dsound/buffers.test.js` | Contract | Cursor motion against the clock, write lead and stopped margin, wrapped locks, volume/pan bounds, notifications, duplicates, `drainPlayed` ranges. |
| `src/layers/audio/dsound/seam.test.js` | Contract, over a flat guest memory | Every slot's argument count, structure layouts (`WAVEFORMATEX`, `DSBUFFERDESC` in both sizes, `DSCAPS` at 96 bytes), caps flags, refusals, enumeration through a guest callback, identity through the publisher. |
| `src/layers/audio/asi/provider.test.js` | Contract, with a substitute decoder | Table registration through `RIB`, chunked continuing fetch, lead decoding, immediate answers, seek forward and back, preferences, a frameless stream, a failing decoder, a platform with none. |
| `src/layers/audio/asi/mp3.test.js` | Unit | Frame-header parsing for each MPEG version, ID3 skipping, frame scanning, `interleave16` over planar and interleaved `AudioData`. |

Whether sound is audible on a real page is not covered by the unit suite; the ring's starvation
counters are what a browser run reports.
