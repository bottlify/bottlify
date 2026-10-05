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
| `mode` | `'auto'` \| `'compatible'` \| `'isolated'` \| `'workers'` | `'auto'` | How much rides on shared memory. `isolated`: the guest's memory is a `SharedArrayBuffer` the graphics worker reads unlocked bytes from and writes read-backs into in place. `compatible`: it is the engine thread's own, and what crosses to another thread is copied. `workers`: `isolated`, with the page's input and visibility written into a ring in shared memory that the engine reads between turns, and an idle engine sleeping on that ring's doorbell rather than looking again on a timer; requests are still posted; and a child process running beside its parent from `CreateProcess` on. `auto` is `isolated` on a cross-origin isolated page and `compatible` elsewhere, never `workers`; `isolated` or `workers` where memory cannot be shared is refused at `createApp`. The run's mode is in the `app` layer's diagnostics, and in `workers` its pacing's counts (`pacing`: messages read from the ring, yields to the event loop, sleeps and wake-ups, and translation batches heard by the doorbell their worker rings). |
| `processWorkers` | boolean | `false` | In the `workers` mode, a child process runs in a worker of its own: its machine there, the run's registry, volume, windows and ids reached across a link to the engine's thread, and so are named events, semaphores and mutexes; its own windows are found and sent to by every other process across the same link. With a graphics worker, its Direct3D 8 and 9 devices draw there and the run shows their frames. |
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
| `graphics` | `{ compressedTextures?, maxFrameLatency?, lendMemory?, guestCode? }` | `false`, 3, `true`, `true` | BC-compressed texture upload where the GPU has `texture-compression-bc`; how many frames the GPU may still be drawing when `Present` returns (0: no bound); the last two as [configuration.md](configuration.md#graphics) says. |
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
| `record` | number | 0 | How many events at the bridge to keep for a replay. |
| `hooks` | `HookSpec[]` | — | Watches placed in front of routines inside the program's own modules as they load. |
| `watch` | `{ libraries, strings }` | — | Watch calls from one guest module into another, by library and ordinal. |
| `refuseReplacement` | boolean | `false` | Stop instead of replacing the process with a child it asks for. |
| `exitNotice` | boolean | `true` | A program that exits with code 0 raises a `message-box` event saying it finished. |
| `sampling` | boolean | `true` | The cpu layer's guest sampler. |
| `device.*` | | | `dumpDraws`, `dumpEvery`, `maxDraws`, `skipTexture`, `probeTexture`, `keepImages`, `fog`, `mips`: per-draw dumps and one-variable-off runs of the graphics layer. |
| `pacing` | `'page'` \| `'event'` | `'page'` | How the run loop waits in a worker: a short look every turn, or sleep until something is due. |

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
| `audio.memory()`, `audio.format()` | The output's shared table and `{ sampleRate, channels }`, for the `AudioWorkletNode`. |
| `adapter` | `{ vendor, architecture, description }` of the GPU the engine opened. |
| `canvas`, `host` | The viewport and where the engine runs. |
| `frames()`, `presented()` | Frames shown so far; the history of presents. |
| `files.list(path)`, `files.read(path)` | The volume as the program sees it. |
| `session.export()`, `registry().toJSON()` | After the exit: the files the program wrote (with `collectOnExit`) and its registry. |
| `attachLog(sink)`, `detachLog(sink)` | What the program writes to its standard handles, as `(handle, text)`. |
| `diagnostics(layer?)` | Every layer's diagnostics, or one layer's. A request to the engine thread, not for polling. |
| `report()` | Everything the engine can say about the run in one answer: every layer's diagnostics, the phase profile and recent frames, `trace()`, the threads, the guest's time by module, and the guest's code (`hotCode`, 4 KiB pages as base64) around its most-sampled addresses. The app layer's table lists the divergences said so far (`divergences`, the first 128); the devices drawing in the graphics worker are asked for their own counters and waited for, up to a second, so the graphics table carries them. A request, not for polling. |
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
| `divergence` | `{ api, detail }` | A call answered differently from Windows. |
| `error` | the failure | A failure inside the engine. |
| `present-failed` | the failure | A frame could not be shown. |
| `bundle`, `bundle-*` | details | The bundle was opened; a fetch is retried, a block is unavailable, prefetch, translations it carries. |
| `libraries`, `libraries-missing`, `library-*`, `import-unresolved`, `unimplemented` | names | Which DLLs were bound, which are missing, which imports nothing implements. |
| `process-*` | details | A child process was created, started, replaced or ended. |
| `session` | `{ changes }` | The program changed files on the volume; the session is saved shortly after. |
