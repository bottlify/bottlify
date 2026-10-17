# API

```js
import { createApp } from '@bottlify/core';
const app = await createApp(options);
```

`createApp` starts the engine, mounts the volume, loads the program and its libraries, and resolves
with a controller once the program is ready to run. It rejects with an `Error` whose `reason` says
what failed (`gpu` when the canvas gives no WebGPU context).

The package also exports `assembleModules` (the layers without a program, see
[configuration.md](configuration.md)) and `createLogReader` (a reader of the log's shared memory).

## Options

Everything below crosses to the engine's worker by `postMessage`, so every value is data.

### What runs

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `executable` | `Uint8Array` | required | The program's PE image. Only 32-bit x86 (PE32) is accepted. |
| `imagePath` | string | `'C:\app.exe'` | Where the program believes it was loaded from; also its start directory. |
| `commandLine` | string | the quoted `imagePath` | What `GetCommandLine` answers. Quote argv[0] yourself if you compose it. |
| `engine` | `'cork'` \| `'emulator'` | `'cork'` | Who runs the x86 code: cork, which the package carries, or a v86 emulator the caller brings (`v86`); without one `'emulator'` is refused. |
| `mode` | `'auto'` \| `'compatible'` \| `'isolated'` | `'auto'` | How much rides on shared memory. `isolated`: the guest's memory is a `SharedArrayBuffer` the graphics worker reads unlocked bytes from and writes read-backs into in place. `compatible`: it is the engine thread's own, and what crosses to another thread is copied. `auto` is `isolated` on a cross-origin isolated page and `compatible` elsewhere; `isolated` where memory cannot be shared is refused at `createApp`. The run's mode is in the `app` layer's diagnostics. |
| `concurrency` | `1` \| `2` \| `4` | `1` | How many processes run at once. 1: the program runs on the engine's thread, and a child runs in its parent's place until it exits. 2 or 4: every process runs in a worker of its own, the program the page started too, and a child runs beside its parent from `CreateProcess` on; the engine's thread runs no program and keeps the run's system -- registry, volume, bundle, session, windows, ids, named events, semaphores and mutexes, journal, sound output, presenter -- which each process reaches across a link. With a graphics worker a process's Direct3D 8 and 9 devices draw there, its DirectDraw and GDI pictures are shown by the run, its sound mixes on the run's shared track table, and the screen is composed of every process's picture by the run's windows. The page's input goes to the process of the window that should have it -- a pointer to the window holding the mouse or under it, the keyboard to the window with the run's one focus -- at any concurrency; where no window has it, to no program, except in a run with no window showing, whose console the page is: there the process started last of those standing has it. A child past that many runs beside its parent, in its parent's worker. More than one needs shared memory and runs `isolated`; asked for in `compatible` mode or where memory cannot be shared, the run is `compatible` with 1 and a `fallback` event says so. With more than one, the page's input and visibility are written into a ring in shared memory the engine reads between turns, and an idle engine sleeps on its doorbell; the `app` layer's diagnostics carry `concurrency`, `fallback` and the pacing's counts (`pacing`). |
| `windows` | `'win2000'` \| `'winxp'` \| `'win7'` \| `'win10'` | `'winxp'` | The Windows the program sees: `GetVersionEx`, `RtlGetVersion`, the registry, system file versions and profile folders all agree. Windows 10 reports 6.2 to a program whose manifest does not declare it. |
| `graphicsApi` | `'directx7'` \| `'directx8'` \| `'directx9'` \| `'directx10'` \| `'opengl'` | every API | The graphics the program gets. `directxN` keeps every DirectX up to N (DirectDraw, then Direct3D 8, 9, then Direct3D 10 with DXGI); `opengl` keeps OpenGL alone. Only those system DLLs exist and only their code is built. The registry, `DirectXSetupGetVersion`, DxDiag and the DLLs' file versions report DirectX 7.0, 8.1 or 9.0c (9.0c for 9 and 10). Absent: every API, DirectX 9.0c. |
| `memorySize` | number | 1 GiB | Guest RAM in bytes, a power of two. Reserved, not committed. |
| `heapSize` | number | the rest of RAM | How much the program's heaps may allocate. |
| `stackSize` | number | the image's stack reserve | The main thread's stack. |
| `quantum` | number | 100 000 | Guest instructions per scheduler turn. |
| `preemption` | boolean | `false` | End a turn early when a thread of higher priority is due. |
| `unattended` | boolean | `false` | Nobody is at the screen: every modal dialog and message box is answered with its default button, and each answer is reported as a `divergence` event. |
| `cork` | `{ moduleUrl?, config? }` | the package's | Where cork is loaded from, and its settings ([configuration.md](configuration.md#cpu)). |
| `v86` | `{ moduleUrl, wasmBytes }` | — | A v86 build of the caller's own, for `engine: 'emulator'`; the package carries none. |
| `zstd` | `{ wasmUrl?, wasmBytes? }` | the package's | The bundle decoder's wasm build; without it a JavaScript decoder is used. |
| `media` | `{ wasmBytes }` | — | The video decoder (FFmpeg in wasm). Without it the program is told no clip can be played. |

### Display, input and sound

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `canvas` | `HTMLCanvasElement` | — | The viewport. Its control is transferred once; a second program in the same canvas reuses the worker. |
| `container` | `Element` | — | Instead of `canvas`: a canvas is made inside it. With neither, the run has no display. |
| `host` | `'worker'` \| `'thread'` | `'worker'` where `Worker` exists | Where the engine runs. `thread` runs it on the calling thread over the same protocol. |
| `workerUrl` | string \| `URL` | beside the module | Where `engine.worker.js` is loaded from, for a bundler that moves it. |
| `transfer` | `Transferable[]` | — | Buffers in the options to hand over instead of copying (the wasm binaries). |
| `screen` | `{ width, height, bitsPerPixel }` | 640 × 480, 32 | The display the program is told it has. |
| `desktop` | `{ picture? }` | — | What the desktop shows where no window is: `picture` is `{ width, height, bits }`, 32 bits a pixel (B, G, R, unused), top row first, scaled to the screen. Absent, the desktop colour. |
| `maxFps` | number | 60 | Accepted, not applied yet ([limits.md](limits.md#graphics)). |
| `graphics` | `{ compressedTextures?, maxFrameLatency?, lendMemory?, guestCode?, driverRules?, videoMemory? }` | `false`, 3, `true`, `true`, `'legacy'`, the `graphicsApi` preset's | BC-compressed texture upload where the GPU has `texture-compression-bc`; how many frames the GPU may still be drawing when `Present` returns (0: no bound); the next three as [configuration.md](configuration.md#graphics) says; the card's memory in megabytes, which overrides the preset's. |
| `device.graphicsWorker` | `true` \| `'pixels'` \| `false` | `true` | Draw Direct3D 7–9 and OpenGL in a graphics worker that sends each frame back as an `ImageBitmap`; `'pixels'` sends the frame's bytes instead; `false` draws on the engine thread. |
| `audio` | `{ drained?, sampleRate?, mp3?, port? }` | `false`, —, `true`, — | `drained`: an `AudioWorkletNode` really reads the output, so play cursors follow the sound rather than a clock. `port`: on a page without shared memory, the engine's end of a `MessageChannel` whose other end the worklet holds; the mix is posted down it (see [README.md](README.md#sound)). `sampleRate`: the `AudioContext`'s rate. `mp3: false`: the program decodes MP3 with the library it ships instead of the engine's provider. |

### Storage, bundles and discs

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `bundle` | `{ url \| file, id?, prefix?, store?, prefetch?, indexSha256?, retry? }` | — | A `.btl` mounted read-only on `C:`, under `prefix` (`App`, so `C:\App`). Read a block at a time with HTTP `Range` from `url`, or as a slice of `file` -- a `Blob`, such as a bundle kept in OPFS on this device; fetched blocks are kept in OPFS under `id` (`store: null` keeps none, which a bundle already on the device needs). `prefetch` (on) fills the cache when nothing is read; `indexSha256` (from the manifest) is checked against the bundle's index; `retry` is `{ attempts: 6, baseDelayMs: 250, maxDelayMs: 10000 }`. |
| `storage` | `'opfs'` \| `'local'` \| `{ files }` \| `null` | `null` | Where the session lives: the files the program wrote and its registry. `opfs` keeps it in the origin's file system, `local` in `localStorage`, `{ files }` seeds it for this run only. `null` keeps nothing. |
| `id` | string | — | Names the session (and the bundle cache when `bundle.id` is absent). |
| `files` | `{ path, bytes }[]` | — | Edits laid over the session at every start; they win over what the program last saved. The bundle never changes. |
| `discs` | `{ image, letter? }[]` | — | Disc images mounted as CD-ROM drives, `D:` or the next free letter. `image` is a `Blob` (read a range at a time) or bytes. |
| `collectOnExit` | boolean | `false` | The run's exit carries the files the program wrote, for `session.export()`. |

### Network

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `network` | `{ module, url, room, token? }` | — | The relay Winsock goes through: the URL of a module exporting `connectRelay` (`@bottlify/networking`'s client), the relay's `ws(s)://` address, and the room to join. Without it, Winsock has the loopback adapter only. |

### Diagnostics

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `log` | `{ categories?, capacity?, bytes? }` | — | Call areas recorded from the first instruction (`{ 'call.gpu': 'trace' }`), and the journal's size: `capacity` records, `bytes` of ring (1 MiB). |
| `traceStrings` | boolean | `false` | Keep the text an argument points at in the journal. |
| `profileCalls` | boolean | `false` | Time every host call as a phase of its own. |
| `sampleJs` | boolean | `false` | Run the browser's JavaScript sampler on the engine's thread, in 2 s windows; its top functions are the `js` diagnostics table. Needs `Document-Policy: js-profiling` (see [the README](README.md)), and a window: Chrome offers the sampler to no worker, so with the engine in one the table says it is not measured. |
| `record` | number | 0 | How many events at the bridge to keep for a replay. |
| `hooks` | `HookSpec[]` | — | Watches placed in front of routines inside the program's own modules as they load. |
| `watch` | `{ libraries, strings }` | — | Watch calls from one guest module into another, by library and ordinal. |
| `refuseReplacement` | boolean | `false` | Stop instead of replacing the process with a child it asks for. |
| `exitNotice` | boolean | `true` | A program that exits with code 0 raises a `message-box` event saying it finished. |
| `sampling` | boolean | `true` | The cpu layer's guest sampler. |
| `device.*` | | | `dumpDraws`, `dumpEvery`, `maxDraws`, `skipTexture`, `probeTexture`, `keepImages`, `fog`, `mips`: per-draw dumps and one-variable-off runs of the graphics layer. |
| `pacing` | `'page'` \| `'event'` | `'page'` | How the run loop waits in a worker: a short look every turn, or sleep until something is due. |
| `pendingYieldMs` | number | `1` | How often, in milliseconds, the run loop gives its thread to the event loop to hear an outstanding host answer (a call parked on the device, a range in flight) while other guest threads still have work. A turn that ran nothing looks at once. Lower hears answers sooner at the cost of more trips round the event loop. |

Where the engine thread's time goes is the `log` table's phases (`topPhases`, and `phasesSelfMs`
for all of them together). A host call is the phase `trap`, timed one call in about 32 and weighed
as all of them; the work a Direct3D 8 or 9 call does before its method is a phase inside it,
`ring-sync`, made of `ring-unlocked` (buffers the program let go of), `ring-take` (the calls the
program left in the command ring) and, inside that, `ring-held` (buffers still locked that those
calls may read) -- timed with the call and weighed as it is. The graphics worker's thread has no
phase table: `graphics.worker.phases` holds its totals since it started, `batch-read` (each batch
of calls read and played; `selfMs` without the look below) and `batch-sweep` (the look at objects
at a count of zero, once a frame), and is `null` until the worker has answered a diagnostics ask
or in a build that times nothing.

## The controller

| Member | What it does |
| --- | --- |
| `run({ maxTurns? })` | Runs the program; resolves with its exit code. |
| `pause()`, `resume()`, `stop()` | Hold, continue, or end the run. |
| `dispose()` | Ends the run and frees the engine; the worker stays with the canvas. |
| `on(name, handler)` | Subscribes to an event (below); returns the function that unsubscribes. |
| `answerMessageBox(id, button)` | Answers a `message-box` event with the id of the button pressed. |
| `input.attach(canvas, { pointerLock? })`, `input.detach()` | Capture keyboard, mouse and gamepads from the canvas, or stop. |
| `input.send(event)`, `input.poll()` | Send an input event yourself; poll the gamepads (call once a frame). |
| `input.route()` | Clicks and key taps driven from outside, a step at a time: `click(x, y, { button? })` and `key(code, frames?)` queue, `tick()` sends the next step and returns how many are left (call it once a frame, or on a timer for a program that does not present). A click pushes the pointer far up and left, then on the next step moves it from the corner to the point and presses, and releases on the step after, so a program that moves a cursor of its own by relative motion (DirectInput) clicks where the window's pointer is, wherever it had put its cursor. |
| `audio.memory()`, `audio.format()` | The output's shared table and `{ sampleRate, channels }`, for the `AudioWorkletNode`. |
| `adapter` | `{ vendor, architecture, description }` of the GPU the engine opened. |
| `canvas`, `host` | The viewport and where the engine runs. |
| `frames()`, `presented()` | Frames shown so far; the history of presents. |
| `files.list(path)`, `files.read(path)` | The volume as the program sees it. |
| `session.export()`, `registry().toJSON()` | After the exit: the files the program wrote (with `collectOnExit`) and its registry. |
| `attachLog(sink)`, `detachLog(sink)` | What the program writes to its standard handles, as `(handle, text)`. |
| `diagnostics(layer?)` | Every layer's diagnostics, or one layer's. A request to the engine thread, not for polling. Beside the layers', a `windows` table holds the run's windows as every process tells them: the top-level windows of every process, the topmost first, each with its process, title, class, visibility and rectangle, and the run's foreground and captured windows. |
| `report()` | Everything the engine can say about the run in one answer: every layer's diagnostics, the phase profile and recent frames, `trace()`, the threads, the guest's time by module, and the guest's code (`hotCode`, 4 KiB pages as base64) around its most-sampled addresses. The app layer's table lists the divergences said so far (`divergences`, the first 128); the devices drawing in the graphics worker are asked for their own counters and waited for, up to a second, so the graphics table carries them. A request, not for polling. |
| `translationPool()` | The run's pool of translation workers as it stands (`cork.pool`): how many workers it holds and how many are idle, how many work for each process, how many it opened and lent, the joins and leaves its driver decided, and its journal of the last decisions (`start`, `join`, `leave`, `exit`, each with the process, the time and the workers it had after). `null` where the run has none. |
| `trace()`, `traffic()` | The last host calls as text; messages counted by kind. |
| `log.*` | The journal and counters: `recent`, `drain`, `setLevel`, `setDefaultLevel`, `areas`, `profile`, `frames`, `counters`, `table`, `threads`, `guestByModule`, `stats`, `memory`. |
| `guestProfile.*` | Where the guest ran, by address (`available`, `start`, `read`, `stop`). |

## Events

| Event | Payload | When |
| --- | --- | --- |
| `frame` | `{ width, height, presented }` | A frame reached the canvas, the first or after a resize. Always sent. |
| `exit` | `{ code }` | The program ended. |
| `message-box` | `{ id, text, caption, type, buttons, defaultButton, icon }` | The program shows a message box; answer it with `answerMessageBox`. |
| `output` | `{ handle, text }` | The program wrote to a standard handle. |
| `cursor` | `{ width, height, hotSpot, bgra, shown }` | The program's cursor changed. |
| `clipboard` | `{ text }` | The program put text on the clipboard. |
| `open-url` | `{ url }` | The program asked the shell to open an address (a link, a `.url` shortcut); the page decides whether to open it. |
| `divergence` | `{ api, detail }` | A call answered differently from Windows. |
| `error` | the failure | A failure inside the engine. |
| `fallback` | `{ asked, detail, mode, concurrency }` | The run could not have what it asked for (`concurrency` without shared memory) and runs as `mode` and `concurrency` say; `detail` says why. |
| `present-failed` | the failure | A frame could not be shown. |
| `bundle`, `bundle-*` | details | The bundle was opened; a fetch is retried, a block is unavailable, prefetch, translations it carries. |
| `libraries`, `libraries-missing`, `library-*`, `import-unresolved`, `unimplemented` | names | Which DLLs were bound, which are missing, which imports nothing implements. |
| `process-*` | details | A child process was created, started, replaced or ended. |
| `session` | `{ changes }` | The program changed files on the volume; the session is saved shortly after. |
