# audio

The sound APIs a Win32 program was written against, mixed into one stream that leaves the engine
through a ring in shared memory. See [README.md](README.md) for the layer map, [system.md](system.md)
for the module contract and [host.md](host.md) for what the page has to do with the ring.

## Purpose

A program of this era plays music through one API and effects through another, and expects the
machine to add them together. This layer owns DirectSound (`DSOUND.dll`), hosts the MPEG Layer 3
provider a sound middleware loads beside a program (`Mp3dec.asi`), and provides the mixer that
`win32`'s wave-out surface (`WINMM.dll`, `src/layers/win32/winmm/functions.js`) also writes into.
On a page with shared memory every source's own PCM is written, unconverted, into a per-track ring
in a shared track table; the audio worklet resamples, scales and sums the tracks on the audio
thread and reports what it consumed per track. Without shared memory the engine converts and mixes
into one float ring itself and whoever drives the page reads it. Either way a reader's own count of
what it consumed is the only feedback channel, and a program's play cursor is built on it rather
than on a clock, so what the program believes has played and what a person has heard are the same
number.

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
| `memory` | `{ control, samples }` without `shared`, `{ table }` with it | absent | The storage of an existing mixer output. Given, the mixer's output is that storage rather than a new one, continuing its written/read counts. Set by `createApp` on a rebuilt machine so a process replacement mixes into the sound output its reader already holds. |
| `shared` | boolean | `false` | Which backend: the engine mixer (`createEngineMixer`) or the shared track table (`createSharedMixer`), read by a worklet on a page with `SharedArrayBuffer`. An environment question the assembling caller answers, never guessed here. |
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
| `ordinals()` | `{ 'DSOUND.dll': { 1, 2, 3, 6, 11, 12 } }`, for a program that imports by number; the assembling caller merges it with `win32`'s and `media`'s and synthesises each library with those numbers. |
| `output()` | The mixer: `open(format)`, `pump(frames?)`, `sampleRate`, `channels`, `capacityFrames`, `consumed()`, `diagnostics()`, plus `ring`/`memory` (engine backend) or `table`/`memory` (shared backend). Handed down to `win32` by the assembling caller because `win32` sits below this layer. |
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
| `DSOUND.dll` | 7 | `DirectSoundCreate`, `DirectSoundCreate8`, `DirectSoundEnumerateA/W`, `DirectSoundCaptureCreate`, `DirectSoundCaptureCreate8` (both `DSERR_UNSUPPORTED`: there is no capture device), `DllCanUnloadNow`. Six carry Windows' ordinals (`dsound.spec`): `DirectSoundCreate` 1, `DirectSoundEnumerateA` 2, `DirectSoundEnumerateW` 3, `DirectSoundCaptureCreate` 6, `DirectSoundCreate8` 11, `DirectSoundCaptureCreate8` 12; `DllCanUnloadNow` is numbered above them. |
| `Mp3dec.asi` | 11 | `DllMain`, `PROVIDER_query_attribute`, `ASI_startup`, `ASI_shutdown`, `ASI_error`, `ASI_stream_open`, `ASI_stream_process`, `ASI_stream_seek`, `ASI_stream_close`, `ASI_stream_attribute`, `ASI_stream_set_preference`. Nothing is imported by name; the middleware finds these through the tables `DllMain` registers. |

Interfaces published (`src/layers/audio/dsound/seam.js`): `IDirectSound` (8 slots after
`IUnknown`) and `IDirectSound8` (9, `VerifyCertification` last), `IDirectSoundBuffer` (18) and
`IDirectSoundBuffer8` (21), `IDirectSoundNotify` (1). Which of them an object answers
`QueryInterface` for follows Windows: the object `DirectSoundCreate` returns is `IDirectSound`
alone, the one `DirectSoundCreate8` returns is both; a secondary buffer is `IDirectSoundBuffer`
and `IDirectSoundBuffer8`, the primary buffer only the first; `IDirectSoundNotify` is there only
on a buffer created with `DSBCAPS_CTRLPOSITIONNOTIFY`. `IDirectSound3DListener` and
`IDirectSound3DBuffer` are deliberately not declared, so `QueryInterface` answers `E_NOINTERFACE`
rather than handing back a table that ends after `IUnknown`.

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

### Mixer

`src/layers/audio/output/mixer.js` keeps one track per open source, behind one surface --
`open(format)`, `pump()`, `consumed()`, `diagnostics()`, a track's `write(pcm)`, `played()`,
`playedBytes()`, `pending()`, `reset()`, `close()`, `retune(rate)`, `gain`, `balance`, `paused` --
and two backends behind
that surface, chosen by `createMixer({ shared })`. `shared` is an environment question, not a
mixer one: shared memory is what a worklet needs to read the far end at all, so the assembling
caller answers it (`src/app.js` with `typeof SharedArrayBuffer === 'function'`) rather than the
mixer guessing; `createMixer()` with no options is always the engine backend, which is what every
test that does not ask for `shared: true` keeps exercising.

**Without shared memory** (`createEngineMixer`, unchanged from before this backend split): a track
converts on write -- 8-bit unsigned or 16-bit signed PCM, mono or stereo, at any rate, becomes
interleaved stereo float at the output rate through a linear resampler whose state (`pos`, `tail`)
carries across buffer boundaries, so a stream delivered in thousands of small pieces joins without
a discontinuity; at the output's own rate the path is an exact copy. Each track keeps a ledger of
`{ frames, bytes }` per buffer written so `playedBytes()` credits whole buffers exactly rather than
reconstructing bytes from a rate ratio, and retires ledger entries behind the cursor so the walk
does not grow with the run. `pump()` first calls `fill` (the DirectSound feed), then mixes the
longest pending block among unpaused tracks into `src/layers/audio/output/ring.js` -- the one place
sound crosses out on this path, a ring of interleaved float32 frames with a five-slot `Int32Array`
control block (`WRITTEN`, `READ`, `STARVED_BLOCKS`, `STARVED_FRAMES`, `BLOCKS`) -- adding each
track scaled by its `gain` and each side by its `balance` (`[left, right]` multipliers, `[1, 1]`
until set); a track short of the block is counted under `shortfall` and its own `short`.
`retune(rate)` reads what is written from then on as recorded at that rate; what is queued was
converted already, so the change falls exactly where the bytes change. A track's `played()` is
what it mixed less what still sits in the ring, held monotonic.
This is the only backend a reader without shared memory can use at all -- the test-page harness,
any page that is not cross-origin isolated -- because nothing but this thread can read an ordinary
`ArrayBuffer`; `test/page/game/harness.js`'s `drainSound` reads this ring on the engine thread for
exactly that reason, and a measurement taken through it still carries this backend's own
converting-and-mixing cost.

**With shared memory** (`createSharedMixer`): the engine writes each track's own guest PCM,
unconverted, into a per-track byte ring inside one `SharedArrayBuffer` "track table" (`SLOTS = 32`
slots of `SLOT_BYTES = 65536` bytes each, one 64-byte header per slot ahead of it, a 32-byte global
header ahead of all of them -- `output/mix.js`'s `TABLE_BYTES`); `write` copies as many bytes as fit
into the slot's ring and advances `WRITTEN`, and nothing here converts or mixes at all, so `pump()`
only calls `fill` and touches no `Float32Array`. `output/worklet.js` -- the audio thread --
resamples, scales by `GAIN` and each side by what `LEFT_CUT` and `RIGHT_CUT` take off it (stored as
the loss, so a header written without them plays both sides whole), and sums every slot into each
output block from that same table; `played()` is `MIXED_FRAMES`, the reader's own count of output
frames it has produced from a slot; `playedBytes()` is `READ`, the reader's own count of guest bytes
it has consumed, exact by construction (no ledger: a program waiting for one small buffer back is
credited it once the reader has looked at those bytes at all, not when a ledger decides to retire an
entry). A slot's header also carries `RATE`, `CHANNELS`, `BITS` (the format `open` was called with;
`retune` rewrites `RATE`, which then applies to whatever is still unread in the slot too, and the
track's 200 ms capacity with it), `PAUSED`, `STATE` (`STATE_FREE`/`STATE_OPEN`/`STATE_CLOSING`) and
`GENERATION` (bumped on open and on a backlog drop; the reader resets its resampler seam when it
changes) and `DROP_TO` (see below); every field has exactly one writer per phase of the slot's life
-- `STATE` is the one exception stated as a handoff rather than a single owner: the engine writes
`OPEN`/`CLOSING`, the reader alone writes `FREE`, and a slot the engine has closed is never reused
until the reader has made that move -- and every access is `Atomics.load`/`store`, with neither side
ever waiting on the other. A track opened when every slot is already taken -- not "already open"; a
track's slot is spent for as long as it is `STATE_OPEN`, which lasts until its buffer is both
released and freed by the reader, so the real ceiling is every buffer *ever* played in the session,
not every buffer open at once -- gets a silent fallback track instead: writes are accepted and
immediately credited so the program is never held up, but nothing is heard, and
`diagnostics().fallbackTracks` counts it. A buffer's DirectSound seam closes its track and drops the
buffer from its own walk once the program has released it, so the slot returns to the pool the
moment nothing can reach the buffer any more.

**The backlog policy** is the same 200 ms this layer always allowed, built on different machinery
per backend: the engine backend's `track.pending() > mixer.capacityFrames` still calls `reset()`,
which still drops the queue; the shared backend's `track.reset()` sets `DROP_TO` to the slot's
current `WRITTEN` and bumps `GENERATION`, and the reader skips ahead to `DROP_TO` before its next
read of that slot. Either way the caller -- `module.js`'s `feedBuffers` -- counts the drop under
`behind`.

`output/mix.js` is the arithmetic both backends' readers need: the table's layout constants,
`resampleInto` (one slot, one output block) and `mixBlock` (every slot, one output block, the
starvation counters). No imports, because `output/worklet.js` -- the audio thread -- cannot import
across the worklet boundary and duplicates this file's `WORKLET-SHARED`-marked region verbatim
instead (`export` stripped, the one difference); `worklet.test.js` asserts the two copies match, so
a change to the arithmetic that is not carried to both is a failing test rather than silent drift.
A mono graph over a stereo mix takes the left channel. The page does:
`audioWorklet.addModule(<worklet url>)`, then
`new AudioWorkletNode(context, 'bottlify-output', { outputChannelCount: [channels], processorOptions: { ...app.audio.memory(), channels } })`
with `channels` also from `app.audio.format()`, and assembles the engine with `audio.drained: true`.
`app.audio.memory()` is `{ table }` with shared memory, `{ control, samples }` without -- the
`Started.audio.memory` union `src/host/messages.js` and `src/host/serve.js` carry across a worker,
unchanged either way. A post of `'stop'` to the node's port ends the processor.

Pump timing is the assembling caller's: `src/app.js` calls `sound.pump()` once per scheduler
turn, before the turn yields to the browser, so the engine backend's ring is topped up (and the
shared backend's DirectSound feed runs) before the thread may be taken for composition or garbage
collection.

### DirectSound

`src/layers/audio/dsound/buffers.js` is a buffer without the COM: a pair of cursors advancing
against the guest's clock at `frequency * blockAlign` bytes per second, the write cursor leading
the play cursor by 30 ms while playing and trailing it by 15 ms when stopped so a locked range
from the write cursor covers nearly the whole buffer. A lock that runs off the end comes back as
two ranges. Volume and pan are hundredths of a decibel within the documented bounds; `gain` is the
volume as a factor and `balance` the pan as one per side, as `SetPan` documents it: the side the
sound is panned away from loses the pan in hundredths of a decibel, the other stays whole, and
`DSBPAN_LEFT`/`DSBPAN_RIGHT` silence the far side. `drainPlayed()` hands back the byte ranges the
play cursor has passed since it was last asked -- what a person hears -- and
`drainNotifications()` the events whose positions it passed, in the order it reached them: the span
runs from where the cursor stood, inclusive, to where it stands, exclusive, so the position playback
starts at is the first one passed, a one-shot that ran out has passed the rest of its buffer, and a
position is never passed twice in one lap. `DSBPN_OFFSETSTOP` is no position: it is delivered once
when playback stops, by `Stop` (inside the call) or at the end of a one-shot, and never while a loop
goes round. Looping, `SetCurrentPosition`, `SetFrequency` (zero restores the format's rate) and
`Restore` (always succeeds; nothing here loses a buffer) are modelled; a duplicate shares its
original's samples and capabilities with cursors of its own.

`src/layers/audio/dsound/seam.js` publishes the interfaces above with one method list per
descriptor shared by every object (a list per buffer was a stub table per buffer, and the stub
table is finite), and one adapter per object so identity survives. Every `DirectSoundCreate` or
`DirectSoundCreate8` makes an object of its own that counts its references (the bridge frees an
interface pointer whose release answers zero), and each object has one primary buffer: asking again
hands it back with its count raised and ignores the new description, and it cannot be duplicated
(`DSERR_INVALIDCALL`). A description of the primary that names a format is refused with
`DSERR_INVALIDPARAM` -- its format is the device's, set through `SetFormat`. The device keeps its
primary: after the program's last `Release` the same pointer still answers (the publisher's adapter
answers the bridge's `reachable()` for it while the device lives), and the seam's `pruneReleased`
drops it only once the device and every reference to it are gone. Through `DirectSoundCreate8`'s
object a `DSBCAPS_CTRL3D` buffer must be mono and cannot have `DSBCAPS_CTRLPAN`
(`DSERR_INVALIDPARAM`); `DirectSoundCreate`'s object accepts both, as the older interface does. The
device's `GetCaps` names every `PRIMARY*` and `SECONDARY*` mono/stereo/8/16 flag plus
`CONTINUOUSRATE`, and writes every hardware field as zero; `EMULDRIVER` is deliberately not set,
because a middleware reading it concludes DirectSound is not really there, and `CERTIFIED` is not
set either, which `IDirectSound8::VerifyCertification` agrees with by answering `DS_UNCERTIFIED`.

A secondary buffer's size is rounded up to a whole number of frames. A buffer's `GetCaps` reports
the flags it was created with plus where it is mixed: `DSBCAPS_LOCSOFTWARE`, or `LOCHARDWARE` when
that was asked for and accepted. A control is only there if the buffer was created with it:
`Get`/`SetVolume`, `Get`/`SetPan` and `Get`/`SetFrequency` answer `DSERR_CONTROLUNAVAIL` without
`DSBCAPS_CTRLVOLUME`, `CTRLPAN` or `CTRLFREQUENCY` (a null pointer is refused first), and the primary
buffer never has a frequency. `IDirectSoundBuffer8::SetFX` answers `DSERR_CONTROLUNAVAIL` without
`DSBCAPS_CTRLFX`; with it, the arguments are checked, a buffer playing or locked is refused with
`DSERR_INVALIDCALL`, and clearing a chain is `DS_OK`. `SetFormat` succeeds on the primary and is
refused on a secondary.
`DirectSoundEnumerateA/W` call the guest's callback twice -- the primary driver with a null GUID,
then one device -- and stop early if the callback returns FALSE; without `callGuest` they succeed
having named nothing. The module's `feedBuffers` runs before every mix: it drains every buffer's
notifications and signals them whether or not anything is listening (a program that waits on a
position must be woken even in a silent build); closes and drops the track of any buffer the program
has fully released (`references` at zero) before anything else, so a released buffer's slot is not
held for the rest of the session, and drops those buffers -- and any primary nothing can reach --
from the seam's walk; then, when `drained`, opens a mixer track per secondary buffer on first play
and writes the drained byte ranges from guest memory into it, resetting a track whose backlog
exceeds the ring's capacity and counting that under `behind`. Every fill hands the track the
buffer's current `gain` and `balance`, and retunes it when the buffer's frequency has changed since,
so a program's `SetFrequency` is heard as a change of pitch and the track consumes bytes at the rate
the cursor drains them.

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
- **No effects.** `IDirectSoundBuffer8::SetFX` on a buffer created with `DSBCAPS_CTRLFX` answers
  `E_NOTIMPL` for any chain it would have to host; `AcquireResources` and `GetObjectInPath` are
  declared and unimplemented (`E_NOTIMPL` from the right slot).
- **A retune on the shared backend reaches back a little.** The slot has one `RATE` and no marker
  in its bytes, so a new frequency also applies to what the reader has not yet consumed, a turn's
  worth at most; the engine backend applies it exactly from the next bytes.
- **Resampling is linear.** Cheap and click-free at block boundaries by construction; not the last
  word on quality.
- **One buffer's backlog past 200 ms is dropped**, not delayed: the program's current sound is the
  one meant to be heard.
- **A slot's `SLOT_BYTES` (65,536 bytes) is a second, harder cap behind the 200 ms policy, on the
  shared backend.** `feedBuffers` (`module.js`) does not re-offer what a short `write()` left over
  the way the engine ring's own caller does; a range is already in DirectSound's past by the time it
  is drained, so there is nothing later to offer it to. Reached only when a turn's backlog is
  already near the 200 ms policy's own limit, and bounded to what that policy would have dropped a
  turn later regardless.
- **A page without shared memory mixes on the engine thread**, in the one float ring
  `output/ring.js` still keeps: nothing else can read an ordinary `ArrayBuffer`, so this is not a
  choice this layer makes but the ceiling a page without `SharedArrayBuffer` has.
- **A 33rd DirectSound buffer open at once on a page with shared memory is silent.** `SLOTS = 32` is
  a generous ceiling for a title of this era, and a track opened past it gets a fallback that
  accepts writes and credits them so the program is never held up, but mixes nothing; counted in
  `diagnostics().fallbackTracks`. A released buffer's slot returns to the pool once the reader has
  freed it, so the ceiling is buffers open at the same time, not buffers played over a session.
- **The provider's requests block the guest** when the decoder falls more than the lead behind.
- **A stream's fetch callback is read serially through guest calls**, one chunk per crossing.

Reported at runtime: `starvedBlocks`/`starvedFrames` (holes a person heard), `shortfall` and
`perTrack.short` (a track mixed short while another carried the block), `behindTurns`,
`refusedFills`, `refusedInterfaces` by id, the provider's `lastError`, `recent` requests and
`waits`, and every `warn` the provider raises.

## Tests

All under `npm test` from `modules/core` (`node --test "src/**/*.test.js"`).

| file | kind | what it pins |
|---|---|---|
| `src/layers/audio/module.test.js` | Wiring | A sound a program plays actually reaches the ring (or the slot, with shared memory) with its own bytes at its own gain and pan; a buffer retuned while it plays is heard at the rate its cursor moves, and its slot is told the new rate; DirectSound's ordinals are offered; nothing is read out with no sink; a stall costs time rather than unread sound; a program waiting on a position is woken even with nothing listening; `mp3: false` withholds the provider; a shared-memory backlog past 200 ms also counts `behind`; a released DirectSound buffer frees its slot, 40 over a session, none falling back. |
| `src/layers/audio/output/mixer.test.js` | Unit | The engine backend: format conversion, resampling across seams, the ledger's exact byte credit, pausing, `played()` monotonic, shortfall counting, a balance per side on top of the gain, a retune taking effect from the next write. The shared backend: `write` puts the guest's own bytes into the slot and calls no conversion; a retune rewrites `RATE` and the capacity; in output frames agreeing with the engine backend's own unit; `pump()` allocates no `Float32Array`; `playedBytes()` credits a probe once `READ` passes it and restarts at zero after `reset()`; a backlog sets `DROP_TO` without letting a write overrun what the reader has not read; a closed slot is freed by the reader and reused; a machine attaching to an inherited table sweeps every slot the previous one left open. |
| `src/layers/audio/output/mix.test.js` | Unit | `resampleInto` over a byte ring matches `convert()` sample for sample across three buffers; a `GENERATION` change resets the seam; a `DROP_TO` ahead of `READ` is honoured; gain and pause; `WRITTEN`/`READ` crossing 2^31 bytes does not stall the ring. |
| `src/layers/audio/output/worklet.test.js` | Unit, over a loaded copy of the real `worklet.js` | The `WORKLET-SHARED` region is textually identical to `mix.js`'s, `export` aside; two tracks at different gains come out summed; a balance reaches the audio thread one side at a time; a silent block counts `STARVED_BLOCKS`/`STARVED_FRAMES`; `MIXED_FRAMES` and `READ` advance by exactly what was mixed. |
| `src/layers/audio/output/ring.test.js` | Unit | Fill and room, short writes, silence on a short read, starvation counters, `clear`. |
| `src/layers/audio/dsound/buffers.test.js` | Contract | Cursor motion against the clock, write lead and stopped margin, wrapped locks, volume/pan bounds and the pan law, notifications (the start position passed first, a one-shot's last frame as it ends, `DSBPN_OFFSETSTOP` on a stop and never on a lap), duplicates, `drainPlayed` ranges. |
| `src/layers/audio/dsound/seam.test.js` | Contract, over a flat guest memory | Every slot's argument count, `IDirectSound8`'s twelfth slot, structure layouts (`WAVEFORMATEX`, `DSBUFFERDESC` in both sizes, `DSCAPS` at 96 bytes), device and buffer caps flags, a size rounded to whole frames, controls refused without their flags, `SetFX`, which interfaces each object answers, one object per create with its own count and one primary that outlives its last release while its device lives and is pruned after, a primary described with a format refused, DirectSound 8's rules for 3D buffers, `Stop` setting `DSBPN_OFFSETSTOP`, refusals, enumeration through a guest callback, identity through the publisher, the ordinals through the real synthesiser. |
| `src/layers/audio/asi/provider.test.js` | Contract, with a substitute decoder | Table registration through `RIB`, chunked continuing fetch, lead decoding, immediate answers, seek forward and back, preferences, a frameless stream, a failing decoder, a platform with none. |
| `src/layers/audio/asi/mp3.test.js` | Unit | Frame-header parsing for each MPEG version, ID3 skipping, frame scanning, `interleave16` over planar and interleaved `AudioData`. |

Whether sound is audible on a real page is not covered by the unit suite; the starvation counters
either backend reports are what a browser run reports.
