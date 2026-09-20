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
    processorOptions: { ...app.audio.memory(), channels: app.audio.format().channels },
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
| `system` | `{ files: { path: string, bytes: Uint8Array }[] }` | The engine's own read-only volume, mounted under `C:\WINDOWS\system32\`. Each `path` is a bare DLL name and each `bytes` its contents — the DirectX End-User Runtime the engine plays DXSETUP's role for. Absent (or empty), the volume has no system layer and a `d3dx9_*` name is answered by the engine's own table. |
| `bundle` | `{ url, store?, id?, prefix?, prefetch?, indexSha256?, retry? }` | A `.btl` mounted as the volume's read-only source, fetched by HTTP byte range from `url` (a `206` is the only accepted answer). `store: 'local'` (default) caches blocks in OPFS; `null` keeps nothing. `id` names the cache. `prefix` is where the bundle appears in the volume. `prefetch` (default on) fills the cache when idle. `indexSha256` is checked against the bundle's index. `retry: { attempts, baseDelayMs, maxDelayMs }` defaults to 6 / 250 / 10000. |
| `storage` | `'opfs' \| 'local' \| { files: { path, bytes }[] } \| null` | Where the session — files the program wrote plus the registry — is loaded from and saved to. `'opfs'` persists in the origin's private file system. `'local'` means `localStorage`, which a worker does not have (see section 9). An object seeds the volume and saves nothing. |
| `id` | `string` | Names the session and the bundle cache when neither option does. |
| `screen` | `{ width, height, bitsPerPixel }` | What the program is told its display is. |
| `audio` | `{ drained?, sampleRate?, mp3?, shared? }` | `drained: true` says something reads the far end of the sound output — a program's play cursor then follows the sound rather than the clock. `mp3` (default true) offers the hosted MPEG provider to a program's sound middleware. `shared` (default `typeof SharedArrayBuffer === 'function'`) picks the mixer backend: a shared track table for a worklet to read, or the engine's own float ring when there is no `SharedArrayBuffer` to hand one. |
| `device` | `{ fog?, mips?, skipTexture?, probeTexture?, dumpDraws?, maxDraws? }` | Diagnostic knobs for the GPU device the worker opens; there is no device object to pass. |
| `graphics` | `{ compressedTextures?: boolean }` | Forwarded to the graphics layer as given (`docs/core/graphics.md`, the Configuration table). `AppOptions.graphics` also carries `presenter`, but nothing that builds `StartOptions` for a real caller ever sets one -- a presenter holds functions and cannot survive `postMessage` -- so in practice only `compressedTextures` crosses. |
| `maxFps` | `number` | Most frames a second that reach the screen. Default 60; `0` presents at whatever rate the loop offers. |
| `log` | `{ categories?: Record<string, string>, capacity?: number, bytes?: number }` | Which journal categories are on from the first instruction (`call.cpu`, `call.gpu`, `call.audio`, `call.video`, `call.input`, `call.net`, `call.com`, `call.hook`, all off by default), how many records the ring's index keeps (`capacity`), and how many bytes the records themselves are packed into (`bytes`, default 1 MiB) — a call area logging every argument as a string fills that budget far sooner than `capacity`'s own default (4096) assumes, so a caller capturing one at volume raises both together. |
| `watch` | `{ libraries: Record<string, number[] \| null>, strings: number[] }` | Puts a watch in front of imports from the named libraries (a library name maps to `null` for every import, or to a list of ordinals), so calls between a program's own modules appear in the trace. |
| `hooks` | `HookSpec[]` | `{ module, offset, label, argBytes, lengths, strings? }` — a watch in front of a routine inside a program's own module, installed when that module loads. Rewrites the program's code; a diagnostic. |
| `sidecarHooks` | `{ spec, source }` | A bundle's `hooks.json`/`hooks.mjs`, read from beside its `manifest.json` by whoever starts the run (never from inside the bundle). `spec` is the parsed `hooks.json`; `source` is `hooks.mjs`'s text, loaded as an ES module from a blob URL inside the engine's own worker. Replaces a guest function through the bridge's slot-hook mechanism (`bridge.md`'s `hook`), or one loop inside one through its site-hook mechanism (`bridge.md`'s `siteHook`), rather than rewriting code the way `hooks` above does — a different mechanism, not a second name for the same one. See `loader.md`'s "Sidecar hooks". A `slot` entry's kernel is called as `kernelFn(guest, args)`; a `site` entry's kernel is called as `kernelFn(guest, registers, frame)`, where `registers` is the same mutable eight-register object `bridge.siteHook`'s handler sees and `frame.base` is the image base of the entry's image, so a kernel can follow a data pointer the sidecar gave it as an RVA. `frame.gl.entry(name)` resolves one `OPENGL32.dll` entry point to a function the kernel calls with the raw dwords a guest call would push (a GLfloat as its bits, a GLdouble as two words low first, a pointer as a guest address) and keeps; it is the same handler the trap table binds, on the calling thread's current context, and answers `null` for a name the library does not implement or in a build with no OpenGL seam. A call made through it is not a trap — the bridge's `calls`/`hot` do not count it, nor do `recentDetailed`/`sequence`/`recent`/`calls()` or a `callPhases` phase; the `call.gpu` journal is its only trace — but it is written there exactly as a trapped call is, and counted in `kernelGlCalls`. Work issued through it before a throw or a `false` is not undone — the guest's own function then issues the pass again — so a kernel makes no GL call before every precondition it checks. Both share `guest`, a view bound- and region-checked the way any guest memory access is (an out-of-bounds or protected address throws, and the call falls through to the guest's own function rather than ending the run): `u8(at)`/`i32(at)`/`f32(at)` read one value, `writeU8(at, value)`/`writeF32(at, value)` write one, `u8s(at, count)`/`i32s(at, count)`/`f32s(at, count)` hand back a `Uint8Array`/`Int32Array`/`Float32Array` **view** over `count` elements at `at` — bounds-checked once for the whole span rather than once per element, and live: an index read or written through it is the guest's own memory, not a copy, on the same array either accessor reads (`app.js`'s `createGuestView`; built on `memory.window`, already the primitive `audio` and `graphics` read guest memory through with no allocation). `i32s`/`f32s` alias the machine's RAM directly and need a 4-byte-aligned span; an unaligned one throws, and the call falls through like any other bad address. `mismatch()` counts one of the kernel's own comparisons against the guest as disagreeing (`bridge.md`'s `reportHookMismatch`) — meaningful for a `slot` kernel only; a `site` kernel has no in-browser oracle (`loader.md`'s "Sidecar hooks"). A kernel may write anywhere in the program image, a thread's stack or the heap — the view is not ownership-checked — so a kernel that throws after writing part of what its guest function would have written in full leaves that partial write behind; the guest fallback runs on it uncorrected. |
| `collectOnExit` | `boolean` | Whether `run()` carries the volume's files back with the exit, for `session.export()`. |
| `pacing` | `'page' \| 'event'` | How the run loop waits in a worker. See section 6. |
| `imagePath`, `commandLine` | `string` | What the program believes it was loaded from and started with; this `commandLine` is the whole thing, `kernel32.GetCommandLineA`'s own answer, image path included. Default `C:\app.exe`, quoted. A bundle's `manifest.json` may carry its own `commandLine` (only the arguments, e.g. `+set s_realTimeDecoding 0`); a caller that reads a manifest builds `createApp`'s option as `"${imagePath}" ${manifest.commandLine}`, the quoted image path first. |
| `refuseReplacement` | `boolean` | Stop rather than replace the process with a child it asks for. |
| `memorySize`, `heapSize`, `stackSize` | `number` | Guest RAM (a power of two), the heap's ceiling, the main thread's stack. |
| `quantum` | `number` | Guest instructions per scheduler turn. |
| `jit` | `Record<string, number>` | The emulator's compiler budgets, for measurement. |
| `engine` | `'emulator' \| 'hybrid' \| 'cork' \| 'differential'` | Which execution engine runs the program (`docs/core/cpu.md`'s "Engines"). Default `emulator`. Chosen per launch: the launcher passes the person's choice for the bundle, or the manifest's suggestion. |
| `sampling` | `boolean` | The `cpu` layer's always-on guest sampler (`docs/core/cpu.md`'s "Sampling"). `false` turns it off, for a caller measuring the emulator's own compiler rather than the guest's code. Always on otherwise. |
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
| **The page** (`src/host/create.js`, `src/host/remote.js`) | Creates the worker, transfers the canvas as an `OffscreenCanvas`, captures keyboard and mouse on the canvas and posts them, posts `document.hidden` on every change, relays the log between the caller and the keeper, hands the sound ring's shared memory to the audio worklet the page creates. The page does nothing per frame. |
| **The log keeper** (`src/host/log.worker.js` → `src/host/keeper.js`) | Owns the log. Handed the journal's block, it polls it before the ring laps, keeps the history, works out the frames, the profile and the module attribution, and answers the page's reads. A `recent` or `drain` read polls the block first, so a tail right after an exit is not a tick stale; a `recent` longer than the keeper's own history (4 096 records) is read off the shared block itself, whose ring the engine sized (`log.capacity`/`log.bytes`), so a capture of a few frames of a call area is the ring's, not the mirror's. A process replacement hands it the next block rather than restarting it. The page's thread never keeps the log. |
| **The engine** (`src/host/engine.worker.js` → `src/host/serve.js` → `src/app.js`) | Everything else: the emulator, the Win32 layer, the mixer's pump, the GPU device — opened here because a `GPUDevice` is neither transferable nor cloneable — and the copy of every frame into the transferred canvas, one `copyTextureToTexture` per frame. |
| **The audio thread** (`dist/worklet.js`, from `src/layers/audio/output/worklet.js`) | With shared memory, the `bottlify-output` `AudioWorkletProcessor` resamples, scales and sums every open track's own PCM out of a shared track table -- converting and mixing both happen here now, not on the engine thread; its own count of what it consumed and produced is what a program's play cursor is built on when `audio.drained` is true. Without shared memory there is no worklet to read anything: the engine mixes into its own ring on its own thread instead, and only that thread can read it (`docs/core/audio.md`'s Mixer section). |

The device is requested with `texture-compression-bc` when the adapter offers it. An uncaptured
WebGPU validation error is written to the worker's console.

### `host: 'thread'`

The same engine, behind the same port protocol, on the calling thread: `openHost` makes a
`MessageChannel`, serves one end with `serveEngine` and hands the other to `createRemoteApp`. This
is what a runtime without `Worker` falls back to and what a headless test uses
(`src/host/create.itest.js` runs a fixture program this way with no canvas and checks the
controller answers exactly as it would from a worker). On the calling thread the run loop always
keeps the page's pacing, with the page's short yield interval, whatever `pacing` asks, because
that thread cannot block.

## 4. The message protocol (`src/host/messages.js`)

Three kinds go to the engine; answers and events come back, and — when a process is replaced —
the journal's next block. Only requests carry an id.

| direction | `type` | fields | notes |
|---|---|---|---|
| to engine | `request` | `id`, `method`, `args[]` | Answered by id. `method` is a key of the worker's method table. |
| to engine | `input` | `event: HostInputEvent` | The input router's own event, never a DOM event. Unanswered. |
| to engine | `visibility` | `hidden: boolean` | Engine pacing only; the guest is never told. Unanswered. |
| from engine | `answer` | `id`, `result?` or `error?: Failure` | `Failure` is `{ message, reason?, traceText?, stack? }` — copied by name because a cloned `Error` keeps none of its own properties. |
| from engine | `event` | `name`, `payload` | An event the page subscribed to with `on`, or `frame`, which is always sent. |
| from engine | `log-memory` | `memory`, `sequenceBase` | The journal's next block, posted when a process is replaced. Shared memory, so it crosses as a share; the page forwards it to the keeper as `attach`. Only sent where a block could be shared. |

The method table in `serve.js`: `start`, `run`, `pause`, `resume`, `stop`, `dispose`,
`answerMessageBox`, `diagnostics`, `trace`, `presented`, `guestProfile.available`,
`guestProfile.start`,
`guestProfile.read`, `guestProfile.stop`, `guestProfile.instructionStats`, `log.setLevel`,
`log.setDefaultLevel`, `input.attach`,
`input.detach`, `on`, and — only for a page without shared memory — `log.recent`, `log.drain`,
`log.profile`, `log.frames`, `log.counters`, `log.threads`, `log.guestByModule`. Any
request other than `start` or `dispose` before a program has started is refused with `nothing has
been started`; a second `start` with `this worker is already running a program`.

`start` answers with `Started`: `{ audio: { memory: { control, samples }, sampleRate, channels } |
null, log: LogMemory | null, adapter: { vendor, architecture, description } }`. `log` is the
journal's block and every layer's table descriptors — shared memory, so the answer shares it rather
than copying it; this is where the first block crosses, and a replacement gives the page the next
one with a `log-memory` message. The page forwards both to its keeper. It is null where the origin
has no `SharedArrayBuffer`, and the engine then answers the reading calls itself instead. `run`
answers with `{ code, registry, files }`; `files` is empty unless `collectOnExit` was set.

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
| `run(runOptions?)` | `Promise<number>` | Exit code, once the page's own last look at the journal is done, so a tail read right after is the tail. `runOptions.maxTurns` bounds the turns the guest worked; `runOptions.timeoutMs` bounds the wall clock, which is the only bound a program that just waits ever reaches. |
| `pause()`, `resume()`, `stop()` | `Promise` | |
| `answerMessageBox(id, button)` | `Promise<boolean>` | Answers the `message-box` the page was shown, with the id of the button pressed. The guest thread parked inside `MessageBox` resumes with it; a box nobody answers stays up. `false` when no box is standing under that id. |
| `dispose()` | `Promise` | Ends the program and its device. With a canvas the worker stays alive for the next program in the same canvas; without one it is terminated. |
| `diagnostics(layer?)` | `Promise<ModuleDiagnostics[]>` | Every layer's table, or one layer's. The **cold** description: a request to the engine's thread, and the only way to see a layer that publishes no table of its own. Not for a poll — what a poll wants is under `log` below. |
| `trace()` | `Promise<string>` | Where the guest was: registers, a stack scan, the host calls in flight. |
| `presented()` | `Promise<{ count, history: Presented[] }>` | The last 600 presented frames: `{ index, at, ms, w, h, failed }`. |
| `frames()` | `number` | Frames shown as of the last `frame` event. Synchronous. |
| `traffic()` | `{ input, request, visibility, answer, event }` | Messages by kind since start, both ways. Synchronous. |
| `guestProfile.available()` | `Promise<boolean>` | Whether the emulator was built with the by-address account. |
| `guestProfile.start(how?)` | `Promise<boolean>` | Starts it. `how.keepCode` leaves the compiled code alone, which makes the account the interpreter's own instructions: a block counts itself only if it was compiled with the account on, so a warm cache stays silent and what lands in the table is interpreted code, one instruction at a time. |
| `guestProfile.read()` | `Promise<{ entries: { address, instructions, hits }[], dropped } \| null>` | Where the guest ran, by address, weighted by instructions retired there. An entry whose `instructions` equals its `hits` was interpreted. |
| `guestProfile.stop()` | `Promise<void>` | |
| `guestProfile.instructionStats()` | `Promise<{ counters, opcodes } \| null>` | A profiler build's own counters and retired instructions by opcode; counts only grow, so a window is two readings. `null` without such a build. |
| `adapter` | `{ vendor, architecture, description }` | Who made the GPU adapter; empty strings without a device. |
| `on(name, handler)` | `() => void` | Subscribes; the first subscription to a name asks the engine to forward it, and is replayed everything already emitted under that name — up to the last 32 — before it sees anything live; a second subscription to the same name only ever sees what is live from then on. Handlers observe only — a handler across a port cannot answer. |
| `attachLog(sink)`, `detachLog(sink)` | synchronous | `sink(handle, text)` for what the program writes to its standard handles (the `output` event). |
| `log.recent(count?)`, `log.drain(since?, limit?)` | `Promise` | Answered by the keeper out of its history, which spans a process replacement. Each polls the current block first, so a read right after an exit sees the tail. A drain's `lost` counts every sequence asked for that cannot be handed over. |
| `log.frames(count?)`, `log.profile(worst?)` | `Promise` | The keeper's derived views of the profiler's frame and phase tables. |
| `log.counters(layer)`, `log.threads()`, `log.guestByModule()` | `Promise` | A layer's counters as a record; the kernel's thread table with its names resolved; retired instructions summed by the region each page is in, heaviest first. |
| `log.table(layer, name)`, `log.word(id)` | `Promise` | A published table as the keeper read it — a snapshot of its rows, not a live buffer — and what a name id in one means. |
| `log.stats()` | `Promise` | `{ written, capacity, lost, rejected }` of the journal. |
| `log.reading()` | `'shared' \| 'requests'` | Which way the log is being read: the keeper reading the block itself, or fed by the page's relay. |
| `log.memory()` | `LogMemory \| null` | The block of the current process, for a reader of the consumer's own. It follows a replacement; a consumer that wants to follow the log itself should ask the keeper. |
| `log.setLevel`, `log.setDefaultLevel` | `Promise` | A level is the writer's gate: only the thread that keeps a record can be told what to keep. |
| `log.areas()` | `string[]` | The `call.*` categories. |

Every `log` read above is a request to the keeper, whether or not the origin has shared memory: the
page holds no reader of its own and polls nothing. Without shared memory the keeper is fed by the
page relaying the engine's `log.drain` answers (4000 records a look, every 200 ms) and the derived
views — frames, profile, counters, threads, guest attribution — are answered by the engine instead;
`table` and `word` and `memory` answer nothing. `log.reading()` says which it is, and the launcher's
settings panel prints it.
| `audio.memory()` | `{ table }` with shared memory, `{ control, samples }` without | What crossed at `start`, for an `AudioWorkletNode`'s `processorOptions` (§1's snippet). Throws `this run has no sound output` without a mixer. Synchronous. There is no `ring()`/`table()` here: those are `src/app.js`'s own direct surface, reachable only by a caller that holds the engine itself rather than `createApp`'s controller (a test, `replace.itest.js`) -- `createApp` always crosses the port protocol, worker or not, and `memory()` is the only shape it hands over either way. |
| `audio.format()` | `{ sampleRate, channels }` | Synchronous. |
| `input.attach(viewport)` | `DomInput` | Captures keyboard and mouse on `viewport` and posts them. The canvas's own `width`/`height` are stale once transferred, so positions are scaled by the last `frame` event. |
| `input.detach()`, `input.send(event)`, `input.poll()` | synchronous | |
| `session.export()` | `SessionFile[]` | Synchronous, once `run()` has resolved; throws `the program has not exited yet` before. Empty unless `collectOnExit`. |
| `registry()` | `{ toJSON() }` | The registry as of exit; same rule. |
| `canvas`, `host` | | The viewport adopted, or `null`; `'worker'` or `'thread'`. |

Events an engine emits and the page may subscribe to include `frame`, `output`, `exit`, `error`,
`cursor`, `import-unresolved` (an import nothing implements, at bind time), `unimplemented` (one
such import called — the **first** call only, once per import per run, with its `count`; every
later call is counted for diagnostics and written to the journal but never announced again, so a
program calling a missing import in a loop cannot flood the page's queue; both events carry
`origin`, `'system'` or `'program'` — and a call to an
undecorated name of a system library ends the run as a `guest-fault` naming it), `divergence`, `message-box`, `clipboard` (`{ text }`, what a program copied, for the page to put on the browser clipboard), `library-loaded`, `library-missing`,
`libraries`, `bundle`, `bundle-retry`, `bundle-prefetch`, `bundle-unavailable`, `session`,
`process-create`, `process-replace`, `process-started`, `process-patched`, `hooks-bound`
(`{ image, bound, refused, pending }`, once per image the sidecar is bound against -- the
program image, each shipped library, and each library loaded at run time as it is mapped:
kernel names bound, refusal reasons by name, and the kernels still waiting for an image not yet
placed; a consumer that does not subscribe never sees a refused hook),
`hook-error` (`{ kernel, message, glCalls }`, a sidecar kernel threw -- the call falls through to
the guest's own function, no rate limit; `glCalls` is how many calls the kernel issued through
`frame.gl` before it threw, since those are not undone), `debug` (the full list is
what `events.emit` is called with in `src/app.js`).

### Construction-time events are not lost to a late subscriber

`buildApp` emits several of the names above -- `hooks-bound`, `libraries`, `bundle`,
`bundle-unbacked`, `process-create` and others -- before `createApp`'s own promise settles, which
in the host protocol is before the `start` request's answer is even posted back. The documented
pattern, `const app = await createApp(options); app.on(name, handler)`, therefore always calls
`on()` after those events already fired, in a worker, on a thread, or in-process.

`src/events.js`'s registry (`createEvents()`) closes that gap generically, with no event name
built into the mechanism: an emission for a name with no subscriber yet is kept, up to the last 32
for that name, and handed to the name's first subscriber, in order, before anything live -- then
never buffered again for that name, so a second subscriber to the same name sees only what is
live from then on. This is what the `on(name, handler)` row above promises, and it holds whether
the engine runs in a worker, on the calling thread, or is used directly by importing `src/app.js`,
because all three route `on`/`emit` through the same registry.

### What became asynchronous, and why

Everything that reads the engine's state by asking for it crosses a thread, so it answers with a
promise — in both host modes, so a consumer writes against one shape. The whole of `log` is in that
set now: every read is a request to the keeper, which holds the reader the page used to. What stays
synchronous is what does not have to ask: the sound ring, because its memory was handed over once at
start, and `session.export()`/`registry()`, because what an exit left behind travels back with the
exit itself.

That is the rule the log half is built on: **nothing a reader does may reach the engine's thread.**
The keeper is what makes that true on the page's side too — it drains the ring, keeps the history
and sums the derived views on a thread that is nobody else's. A poll of `diagnostics()` breaks the
rule, which is why the figures a poll wants — frames, phases, counters, threads, the guest
attribution — are published into tables instead and summed on the reader's side. `diagnostics()`
stays for the cold description and for the layers that publish no table yet (audio, graphics,
bridge, win32, media).

The controller does not carry the engine's `debug`, `post`, `guestProfile`, `mainThread`,
`recordedSession`, `off`, `exitCode` or `replacements`. Those are reachable only by importing
`src/app.js` directly; `hooks` and `watch` in the options cover the debugging cases a page needs.

## 6. Pacing

The engine's run loop hands out scheduler turns and, between them, has to give the thread away
somehow. `src/app.js` takes that policy as `RunPacing` (`{ yield(pending), wait(until) }`) and
defaults to `pagePacing`: a yield through a `MessageChannel` macrotask, and, when nothing can run,
a look again on a 4 ms timer (`IDLE_LOOK_MS`), or on a macrotask when the page is hidden because a
browser clamps a hidden page's timers to about a second and that stops the machine rather than
slowing it.

The yield is by need and by time, never by turn (`pacedYield`). The loop leaves the microtask
queue at once when the host may have something to deliver — a host call is suspended, a range is
in flight, a caller sits on an empty message queue, the last turn retired no instruction, or the
page's signal word says a message is waiting — and otherwise only once a bounded interval has
passed since the last trip ended: `PAGE_YIELD_MS` (2 ms) on a page's thread, where the gap between
tasks is where input, composition and the launcher's own interface happen, and `WORKER_YIELD_MS`
(4 ms) in a worker, whose thread is nobody else's and where the bound only limits how long a
decoder's output, a fetch's answer or the frame the guest just presented wait behind the guest. A
yield every turn was measured on a real title at fourteen hundred trips a second of over a
hundred microseconds each — the largest host phase of the run — because whatever the browser runs
in the gap is paid on every trip. The sound ring holds 200 ms and is topped up every turn, so it
needs no yield at all.

`serve.js` offers a second policy, `workerPacing`, when it is `threaded` and the start asked for
`pacing: 'event'`: the same yield on the worker's clock, and an idle machine that sleeps until the
guest's own next deadline — a timed wait, a queue timer, a device that wants feeding — or until a
host answer or a message from the page. To see a waiting message without yielding, the page counts
every post in one shared `Int32Array` word (`signal`) that the loop reads with `Atomics.load`
between turns; where the origin has no shared memory a message waits for the timed yield instead.

`'page'` is the default in the worker too, on the strength of one measurement recorded in
`src/host/messages.js`: on a harness run through the launcher path, the same build in the same
worker over thirty seconds, `page` ran 1.95 G guest instructions and presented 866 frames, `event` 1.07 G and 469 —
because a host call answering woke the loop for a turn that retired nothing, seventy thousand
times, where the page's short look batches those answers. `'event'` stays available for the change
that batches those wakes, and is not the default until a measurement says it should be.

## 7. The worker as a build entry

`scripts/build.mjs` runs one esbuild pass with three entry points, `src/index.js`,
`src/host/engine.worker.js` and `src/host/log.worker.js`, bundled separately because a worker is
loaded by URL rather than imported and each has to carry what it needs. The outputs:

| file | from | exported as |
|---|---|---|
| `dist/core.js` | `src/index.js` (renamed) | `@bottlify/core` |
| `dist/engine.worker.js` | `src/host/engine.worker.js` | `@bottlify/core/engine.worker.js` |
| `dist/log.worker.js` | `src/host/log.worker.js` | loaded by URL from `createApp` |
| `dist/worklet.js` | copied from `src/layers/audio/output/worklet.js` | `@bottlify/core/worklet.js` |
| `dist/vendor/libv86.mjs`, `v86.wasm` | copied from `vendor/prebuilt/` | `@bottlify/core/libv86.mjs`, `@bottlify/core/v86.wasm` |
| `dist/vendor/video-decoder.wasm` | copied from `vendor/prebuilt/` | `@bottlify/core/video-decoder.wasm` |
| `dist/vendor/directx/*.dll` | copied from `vendor/prebuilt/directx/`, when fetched | the DirectX runtime, handed to `createApp` as `system.files` |
| `dist/vendor/manifest.json` | written | checksums and source release of each vendor artifact |
| `dist/checksums.json` | written | SHA-256 of every file under `dist/` |

The build is minified, without source maps, targets `es2022`, and stops if a vendor artifact is
missing from `vendor/prebuilt/` (`npm run fetch:v86`, `npm run fetch:video-decoder` put them
there, verified against `vendor-lock.json` and `video-decoder-lock.json`). The DirectX runtime is
the one optional artifact: `npm run fetch:directx-runtime` fills `vendor/prebuilt/directx/` and
the build then copies it into `dist/vendor/directx/`, verified against
`directx-runtime-lock.json`; absent, the build still succeeds and the package simply has no system
volume. `import.meta.env.BOTTLIFY_VENDOR` is defined as `./vendor/` so the built module finds its
emulator beside itself.
`createApp` finds `engine.worker.js` the same way, relative to `import.meta.url`; `workerUrl`
overrides that. `npm run check:package` (run by `prepublishOnly`) asserts the tarball carries every
file `exports` names and that the binaries are not stubs.

`log.worker.js` is **not** one of `package.json`'s `exports` -- unlike `engine.worker.js`, which
is `@bottlify/core/engine.worker.js` -- because nothing outside `createApp` ever loads it by name;
`src/host/remote.js` reaches it with `new URL('./log.worker.js', import.meta.url)` from wherever
`core.js` itself resolved to. A consumer whose bundler rewrites `core.js` into a different file
without carrying its siblings has to copy `log.worker.js` beside the output by hand, since there is
no subpath a bundler's own `exports` resolution would otherwise find it through.

## 8. The worker's lifetime

A canvas can transfer its control once. `createApp` keeps a `WeakMap` from canvas to the host it
was handed to: disposing a program leaves that worker alive with its `OffscreenCanvas`, and the
next `createApp` on the same canvas starts in the same worker without transferring anything. A
host with no canvas is closed when its program is disposed. If `start` fails on a fresh host, the
host is closed and the canvas forgotten.

The keeper is per `createApp` rather than per canvas: each controller creates its own and ends it
when the application is disposed, so a second program in the same canvas gets a fresh keeper and
the first one's history and poll are gone with it.

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
- **Converting and mixing moved to the audio thread; the rest has not.** With shared memory the
  worklet resamples, scales and sums every track itself (`docs/core/audio.md`'s Mixer section,
  B12 superseded by the measurement below); still on the engine thread: the DirectSound cursor walk
  and its notifications (`feedBuffers`, run before every mix so a program waiting on a position is
  woken whether or not anything is listening), waveOut's own queue draining, and the hosted MPEG
  provider's decoder callbacks (`ASI_stream_process` and the WebCodecs path). Measured on a title's
  heaviest window, on a cross-origin-isolated page: the `pump` phase inclusive of the DirectSound
  feed and one copy went from 526 ms of a 19.4 s window (2.7 % of the worker) to 397.6 ms of a
  20.7 s window (1.9 %) -- a real improvement, but short of the < 200 ms / < 1.0 % this was designed
  for, and not for the reason a first read of the number suggests: the harness's stand-in reader
  (`test/page/game/harness.js`'s `drainTable`, standing in for the worklet this test harness never
  creates) runs in its own timer callback, outside the `pump` phase entirely, so it inflates the
  audio layer's overall self-time share (measured 2.1 %, down from 2.7 %) rather than the `pump`
  figure itself. What the design removed from `pump` (`convert`, `mixInto`/`ring.write`, the
  `readBytes` slice) leaves an expected residue of roughly 130-160 ms; the measured 397.6 ms is
  still about twice that, for a reason not yet named -- candidates include the byte-at-a-time masked
  copy in `write()`, whether `memory.window` is a plain subarray, and the span arithmetic feeding it,
  each measurable on a held profile. A genuine worklet on the browser's own audio-rendering thread --
  what the < 200 ms / < 1.0 % target assumes -- would separately show the layer's self-time share
  lower by roughly the reader's own cost (about 116 ms in this measurement); neither figure is
  verified through the launcher yet.
- **A page without shared memory has no audio worker at all**, not yet and not only-not-yet: a
  worklet needs shared memory to read anything, so a page that is not cross-origin isolated mixes
  on the engine thread the way this whole layer did before this split, in the one ring
  `output/ring.js` still keeps.
- **`pacing: 'event'` is slower today** (section 6).
- **The engine's shared-memory signal needs a cross-origin-isolated page.** Without
  `SharedArrayBuffer` the worker still runs; a message waits for the next timed yield, at most
  `WORKER_YIELD_MS`, instead of being seen between two turns.
- **Function-valued options do not cross** (section 2).
- **One program per worker at a time.** A second `start` is refused; a child process the program
  asks for replaces it inside the same engine.
