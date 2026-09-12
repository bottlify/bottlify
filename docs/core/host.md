# `createApp`: the public entry point

`createApp` is what a consumer imports from `@bottlify/core`. It takes a program and the surfaces
a browser offers — a canvas, an audio context, somewhere to keep files — and runs the program on
a thread of its own. This document is derived from `src/host/create.js`, `src/host/messages.js`,
`src/host/remote.js`, `src/host/serve.js`, `src/host/engine.worker.js` and the option typedef in
`src/app.js` (paths relative to `modules/core/`). The module graph underneath is described in
[`system.md`](./system.md).

## 1. Shape

```js
import { createApp } from '@bottlify/core';

const app = await createApp({
    executable,                                   // Uint8Array
    v86: { moduleUrl, wasmBytes },                // the emulator, shipped in the package
    canvas,                                       // or container, or neither
    bundle: { url, id },                          // the program's files, read by byte range
    storage: 'opfs',                              // where the session goes
    audio: { drained: true },                     // something will read the sound ring
});
app.input.attach(canvas);
app.on('frame', ({ width, height }) => {});
const speaker = new AudioWorkletNode(context, 'bottlify-output', {
    processorOptions: { ...app.audio.ring().memory, channels: app.audio.format().channels },
});
const code = await app.run();
await app.dispose();
```

`createApp` resolves once the engine has started: the emulator is loaded, the program is mapped,
the GPU device is open if there is a canvas, and the sound ring exists if the build has a mixer.
Nothing runs until `run()`.

## 2. Options

`createApp` takes `CreateAppOptions` (`src/host/create.js`): five options it consumes itself,
plus everything in `StartOptions` (`src/host/messages.js`), which is posted to the engine as it is.

### Consumed on the page

| option | type | meaning |
|---|---|---|
| `host` | `'worker' \| 'thread'` | Where the engine runs. Default: `'worker'` wherever `Worker` is a function, otherwise `'thread'`. See section 3. |
| `canvas` | `HTMLCanvasElement` | Adopted as the viewport. Its control is transferred to the engine; nothing on the page may draw to it afterwards. |
| `container` | `Element` | A canvas is created and appended to it, then treated as `canvas`. |
| `transfer` | `ArrayBuffer[]` | Buffers among the options to hand over rather than copy — the image, the emulator's binary, the decoder's. |
| `workerUrl` | `string \| URL` | Where to load the engine worker from, for a bundler that moves files. Default: `./engine.worker.js` beside the entry module. |

Neither `canvas` nor `container` means a run without a display: no GPU device is opened, and a
program that draws gets a truthful failure from the graphics layer. That is what a headless test
wants.

### `StartOptions`: what crosses to the engine

`StartOptions` is `AppOptions` (`src/app.js`) with everything that cannot cross a thread boundary
replaced by what it is built from. The worker rebuilds the object it needs.

| option | type | meaning |
|---|---|---|
| `executable` | `Uint8Array` | The PE32 image to run. Required. |
| `v86` | `{ moduleUrl: string, wasmBytes: ArrayBuffer }` | The emulator module and binary. Both are subpath exports of the package (`@bottlify/core/libv86.mjs`, `@bottlify/core/v86.wasm`). |
| `media` | `{ wasmBytes?: ArrayBuffer }` | The video decoder (`@bottlify/core/video-decoder.wasm`). Absent, the media layer comes up and reports that nothing can be played. |
| `bundle` | `{ url, store?, id?, prefix?, prefetch?, indexSha256?, retry? }` | A `.btl` mounted as the volume's read-only source, fetched by HTTP byte range from `url` (a `206` is the only accepted answer). `store: 'local'` (default) caches blocks in OPFS; `null` keeps nothing. `id` names the cache. `prefix` is where the bundle appears in the volume. `prefetch` (default on) fills the cache when idle. `indexSha256` is checked against the bundle's index. `retry: { attempts, baseDelayMs, maxDelayMs }` defaults to 6 / 250 / 10000. |
| `storage` | `'opfs' \| 'local' \| { files: { path, bytes }[] } \| null` | Where the session — files the program wrote plus the registry — is loaded from and saved to. `'opfs'` persists in the origin's private file system. `'local'` means `localStorage`, which a worker does not have (see section 9). An object seeds the volume and saves nothing. |
| `id` | `string` | Names the session and the bundle cache when neither option does. |
| `screen` | `{ width, height, bitsPerPixel }` | What the program is told its display is. |
| `audio` | `{ drained?, sampleRate?, mp3? }` | `drained: true` says something reads the far end of the sound ring — a program's play cursor then follows the sound rather than the clock. `mp3` (default true) offers the hosted MPEG provider to a program's sound middleware. |
| `device` | `{ fog?, mips?, skipTexture?, probeTexture?, dumpDraws?, maxDraws? }` | Diagnostic knobs for the GPU device the worker opens; there is no device object to pass. |
| `maxFps` | `number` | Most frames a second that reach the screen. Default 60; `0` presents at whatever rate the loop offers. |
| `log` | `{ categories?: Record<string, string>, capacity?: number }` | Which journal categories are on from the first instruction (`call.cpu`, `call.gpu`, `call.audio`, `call.video`, `call.input`, `call.net`, `call.com`, all off by default) and how many records the ring keeps. |
| `watch` | `{ libraries: Record<string, number[] \| null>, strings: number[] }` | Puts a watch in front of imports from the named libraries (a library name maps to `null` for every import, or to a list of ordinals), so calls between a program's own modules appear in the trace. |
| `hooks` | `HookSpec[]` | `{ module, offset, label, argBytes, lengths, strings? }` — a watch in front of a routine inside a program's own module, installed when that module loads. Rewrites the program's code; a diagnostic. |
| `collectOnExit` | `boolean` | Whether `run()` carries the volume's files back with the exit, for `session.export()`. |
| `pacing` | `'page' \| 'event'` | How the run loop waits in a worker. See section 6. |
| `imagePath`, `commandLine` | `string` | What the program believes it was loaded from and started with. Default `C:\app.exe`, quoted. |
| `refuseReplacement` | `boolean` | Stop rather than replace the process with a child it asks for. |
| `memorySize`, `heapSize`, `stackSize` | `number` | Guest RAM (a power of two), the heap's ceiling, the main thread's stack. |
| `quantum` | `number` | Guest instructions per scheduler turn. |
| `jit` | `Record<string, number>` | The emulator's compiler budgets, for measurement. |
| `record` | `number` | How many bridge events to keep for a replayable session; `0` keeps none. |
| `traceStrings`, `profileCalls` | `boolean` | Keep the text an argument pointed at; time every host call as a phase. Both cost, both off by default. |
| `signal` | `SharedArrayBuffer` | Set by `createApp` itself: the page's message counter (section 6). Not for a consumer to pass. |

Options of `AppOptions` that are functions — `watchImport`, `sample`, `onCall`, `pageHidden`, a
`storage` provider object, a `bundle.fetch`, a `device` object, a `pacing` object — are not in
`StartOptions` and cannot be given to `createApp`. They remain available to a caller that imports
the engine directly (`createApp` from `src/app.js`, not exported by the package).

## 3. What runs where

| place | what it does |
|---|---|
| **The page** (`src/host/create.js`, `src/host/remote.js`) | Creates the worker, transfers the canvas as an `OffscreenCanvas`, captures keyboard and mouse on the canvas and posts them, posts `document.hidden` on every change, keeps a mirror of the journal, hands the sound ring's shared memory to the audio worklet the page creates. The page does nothing per frame. |
| **The engine** (`src/host/engine.worker.js` → `src/host/serve.js` → `src/app.js`) | Everything else: the emulator, the Win32 layer, the mixer's pump, the GPU device — opened here because a `GPUDevice` is neither transferable nor cloneable — and the copy of every frame into the transferred canvas, one `copyTextureToTexture` per frame. |
| **The audio thread** (`dist/worklet.js`, from `src/layers/audio/output/worklet.js`) | The `bottlify-output` `AudioWorkletProcessor` reads the ring in shared memory; its read index is what a program's play cursor is built on when `audio.drained` is true. |

The device is requested with `texture-compression-bc` when the adapter offers it. An uncaptured
WebGPU validation error is written to the worker's console.

### `host: 'thread'`

The same engine, behind the same port protocol, on the calling thread: `openHost` makes a
`MessageChannel`, serves one end with `serveEngine` and hands the other to `createRemoteApp`. This
is what a runtime without `Worker` falls back to and what a headless test uses
(`src/host/create.itest.js` runs a fixture program this way with no canvas and checks the
controller answers exactly as it would from a worker). On the calling thread the run loop always
keeps the page's pacing whatever `pacing` asks, because that thread cannot block.

## 4. The message protocol (`src/host/messages.js`)

Three kinds go to the engine, two come back. Only requests carry an id.

| direction | `type` | fields | notes |
|---|---|---|---|
| to engine | `request` | `id`, `method`, `args[]` | Answered by id. `method` is a key of the worker's method table. |
| to engine | `input` | `event: HostInputEvent` | The input router's own event, never a DOM event. Unanswered. |
| to engine | `visibility` | `hidden: boolean` | Engine pacing only; the guest is never told. Unanswered. |
| from engine | `answer` | `id`, `result?` or `error?: Failure` | `Failure` is `{ message, reason?, traceText?, stack? }` — copied by name because a cloned `Error` keeps none of its own properties. |
| from engine | `event` | `name`, `payload` | An event the page subscribed to with `on`, or `frame`, which is always sent. |

The method table in `serve.js`: `start`, `run`, `pause`, `resume`, `stop`, `dispose`,
`diagnostics`, `trace`, `presented`, `log.recent`, `log.drain`, `log.setLevel`,
`log.setDefaultLevel`, `log.profile`, `log.frames`, `input.attach`, `input.detach`, `on`. Any
request other than `start` or `dispose` before a program has started is refused with `nothing has
been started`; a second `start` with `this worker is already running a program`.

`start` answers with `Started`: `{ audio: { memory: { control, samples }, sampleRate, channels } |
null, adapter: { vendor, architecture, description } }`. `run` answers with `{ code, registry,
files }`; `files` is empty unless `collectOnExit` was set.

The `frame` event is sent on the first presented frame and whenever the frame's size changes,
never per frame; its payload is `{ width, height, presented }`. A frame the presenter could not
copy raises `present-failed` with `{ index, message }`. Hooks report through `hook` with `{ label,
address }` or `{ label, refused }`.

A result crosses as it is when `structuredClone` accepts it; otherwise through JSON. A
`diagnostics` table is walked instead (`plain()` in `serve.js`), dropping functions and GPU handles
and keeping byte arrays, because passing a graphics table with the last frame's commands through
JSON cost the engine's thread tens of milliseconds per call.

## 5. The controller (`src/host/remote.js`)

`createApp` returns the object `createRemoteApp` builds, with `canvas` and `host` added.

| member | answers | notes |
|---|---|---|
| `run(runOptions?)` | `Promise<number>` | Exit code, once the journal mirror has caught up. `runOptions.maxTurns` bounds the turns the guest worked; `runOptions.timeoutMs` bounds the wall clock, which is the only bound a program that just waits ever reaches. |
| `pause()`, `resume()`, `stop()` | `Promise` | |
| `dispose()` | `Promise` | Ends the program and its device. With a canvas the worker stays alive for the next program in the same canvas; without one it is terminated. |
| `diagnostics(layer?)` | `Promise<ModuleDiagnostics[]>` | Every layer's table, or one layer's — the cheap read for a poll. |
| `trace()` | `Promise<string>` | Where the guest was: registers, a stack scan, the host calls in flight. |
| `presented()` | `Promise<{ count, history: Presented[] }>` | The last 600 presented frames: `{ index, at, ms, w, h, failed }`. |
| `frames()` | `number` | Frames shown as of the last `frame` event. Synchronous. |
| `traffic()` | `{ input, request, visibility, answer, event }` | Messages by kind since start, both ways. Synchronous. |
| `adapter` | `{ vendor, architecture, description }` | Who made the GPU adapter; empty strings without a device. |
| `on(name, handler)` | `() => void` | Subscribes; the first subscription to a name asks the engine to forward it. Handlers observe only — a handler across a port cannot answer. |
| `attachLog(sink)`, `detachLog(sink)` | synchronous | `sink(handle, text)` for what the program writes to its standard handles (the `output` event). |
| `log.recent(count?)`, `log.drain(since?, limit?)` | synchronous | From the page's mirror of the journal, refreshed every 200 ms, 4000 records a refresh, holding `log.capacity` or 4096 records. |
| `log.setLevel`, `log.setDefaultLevel`, `log.profile`, `log.frames` | `Promise` | |
| `log.areas()` | `string[]` | The `call.*` categories. |
| `audio.ring()` | `{ memory }` | The ring's shared buffers, handed over at start. Throws `this run has no sound ring` without a mixer. Synchronous. |
| `audio.format()` | `{ sampleRate, channels }` | Synchronous. |
| `input.attach(viewport)` | `DomInput` | Captures keyboard and mouse on `viewport` and posts them. The canvas's own `width`/`height` are stale once transferred, so positions are scaled by the last `frame` event. |
| `input.detach()`, `input.send(event)`, `input.poll()` | synchronous | |
| `session.export()` | `SessionFile[]` | Synchronous, once `run()` has resolved; throws `the program has not exited yet` before. Empty unless `collectOnExit`. |
| `registry()` | `{ toJSON() }` | The registry as of exit; same rule. |
| `canvas`, `host` | | The viewport adopted, or `null`; `'worker'` or `'thread'`. |

Events an engine emits and the page may subscribe to include `frame`, `output`, `exit`, `error`,
`cursor`, `unimplemented`, `divergence`, `message-box`, `library-loaded`, `library-missing`,
`libraries`, `bundle`, `bundle-retry`, `bundle-prefetch`, `bundle-unavailable`, `session`,
`process-create`, `process-replace`, `process-patched`, `debug` (the full list is what
`events.emit` is called with in `src/app.js`).

### What became asynchronous, and why

Everything that reads the engine's state crosses a thread, so it answers with a promise — in both
host modes, so a consumer writes against one shape. Three things stay synchronous by design: the
journal, because a reader polls it from a render loop and the page keeps a mirror; the sound ring,
because its memory was handed over once at start; and `session.export()`/`registry()`, because what
an exit left behind travels back with the exit itself.

The controller does not carry the engine's `debug`, `post`, `guestProfile`, `mainThread`,
`recordedSession`, `off`, `exitCode` or `replacements`. Those are reachable only by importing
`src/app.js` directly; `hooks` and `watch` in the options cover the debugging cases a page needs.

## 6. Pacing

The engine's run loop hands out scheduler turns and, between them, has to give the thread away
somehow. `src/app.js` takes that policy as `RunPacing` (`{ yield(pending), wait(until) }`) and
defaults to `pagePacing`: a yield through a `MessageChannel` macrotask every turn, and, when
nothing can run, a look again on a 4 ms timer (`IDLE_LOOK_MS`), or on a macrotask when the page is
hidden because a browser clamps a hidden page's timers to about a second and that stops the
machine rather than slowing it.

`serve.js` offers a second policy, `workerPacing`, when it is `threaded` and the start asked for
`pacing: 'event'`: turns run back to back until a host answer, a range or a message from the page
is pending, and an idle machine sleeps until the guest's own next deadline — a timed wait, a queue
timer, a device that wants feeding — or until the page posts. To see a waiting message without
yielding, the page counts every post in one shared `Int32Array` word (`signal`) that the loop reads
with `Atomics.load` between turns; where the origin has no shared memory the loop yields on a 1 ms
clock (`YIELD_MS`) instead.

`'page'` is the default in the worker too, on the strength of one measurement recorded in
`src/host/messages.js`: on a harness run through the launcher path, the same build in the same
worker over thirty seconds, `page` ran 1.95 G guest instructions and presented 866 frames, `event` 1.07 G and 469 —
because a host call answering woke the loop for a turn that retired nothing, seventy thousand
times, where the page's short look batches those answers. `'event'` stays available for the change
that batches those wakes, and is not the default until a measurement says it should be.

## 7. The worker as a build entry

`scripts/build.mjs` runs one esbuild pass with two entry points, `src/index.js` and
`src/host/engine.worker.js`, bundled separately because a worker is loaded by URL rather than
imported and each has to carry the engine it needs. The outputs:

| file | from | exported as |
|---|---|---|
| `dist/core.js` | `src/index.js` (renamed) | `@bottlify/core` |
| `dist/engine.worker.js` | `src/host/engine.worker.js` | `@bottlify/core/engine.worker.js` |
| `dist/worklet.js` | copied from `src/layers/audio/output/worklet.js` | `@bottlify/core/worklet.js` |
| `dist/vendor/libv86.mjs`, `v86.wasm` | copied from `vendor/prebuilt/` | `@bottlify/core/libv86.mjs`, `@bottlify/core/v86.wasm` |
| `dist/vendor/video-decoder.wasm` | copied from `vendor/prebuilt/` | `@bottlify/core/video-decoder.wasm` |
| `dist/vendor/manifest.json` | written | checksums and source release of each vendor artifact |
| `dist/checksums.json` | written | SHA-256 of every file under `dist/` |

The build is minified, without source maps, targets `es2022`, and stops if a vendor artifact is
missing from `vendor/prebuilt/` (`npm run fetch:v86`, `npm run fetch:video-decoder` put them
there, verified against `vendor-lock.json` and `video-decoder-lock.json`). `import.meta.env
.BOTTLIFY_VENDOR` is defined as `./vendor/` so the built module finds its emulator beside itself.
`createApp` finds `engine.worker.js` the same way, relative to `import.meta.url`; `workerUrl`
overrides that. `npm run check:package` (run by `prepublishOnly`) asserts the tarball carries every
file `exports` names and that the binaries are not stubs.

## 8. The worker's lifetime

A canvas can transfer its control once. `createApp` keeps a `WeakMap` from canvas to the host it
was handed to: disposing a program leaves that worker alive with its `OffscreenCanvas`, and the
next `createApp` on the same canvas starts in the same worker without transferring anything. A
host with no canvas is closed when its program is disposed. If `start` fails on a fresh host, the
host is closed and the canvas forgotten.

## 9. Limitations

- **A canvas is transferred once.** After `createApp` the page's canvas is a placeholder: its
  `width`/`height` attributes stay where the page left them while the worker draws at the program's
  resolution. Do not draw to it, and size the pointer space by the `frame` event, as `input.attach`
  does.
- **Pointer lock is not reachable through the controller.** `createDomInput` supports
  `pointerLock`, but the remote controller's `input.attach(viewport)` does not pass it, so a
  program that needs relative mouse motion gets it only while the page has otherwise locked the
  pointer.
- **`storage: 'local'` does not work in a worker.** `localStorage` does not exist there and the
  session provider throws saying so. Use `'opfs'`, or seed with `{ files }`.
- **No audio worker yet.** Output already runs on the audio thread (the worklet), but the mixer's
  pump, the DirectSound/waveOut/MSS buffer reads and the hosted MPEG provider's decoder callbacks
  run on the engine's thread. Measured on a harness run over 60 000 scheduler turns with
  the engine in a worker, the pump's self time was 921 ms of a 186 s run (0.5 %, 11 µs a turn); a
  device drawing under one percent of the thread is not what to move first. The seam a split would
  need — buffer writes copied into a block the audio worker owns, cursors in a shared control block
  read with `Atomics` — is recorded in `roadmap/registers/decisions-and-optimisations.md` (B12) and
  waits for a measurement that says the pump has become material.
- **`pacing: 'event'` is slower today** (section 6).
- **The engine's shared-memory signal needs a cross-origin-isolated page.** Without
  `SharedArrayBuffer` the worker still runs; it looks for messages on a clock instead.
- **Function-valued options do not cross** (section 2).
- **One program per worker at a time.** A second `start` is refused; a child process the program
  asks for replaces it inside the same engine.
