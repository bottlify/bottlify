# API

```js
import { createApp } from '@bottlify/core';
const app = await createApp(options);
```

`createApp` starts the engine, mounts the volume, loads the program and its libraries, and resolves
with a controller once the program is ready to run. On failure it rejects with an `Error` whose
`reason` names the cause (`gpu`: the canvas gives no WebGPU context).

The package also exports `assembleModules` (the layers without a program, see
[configuration.md](configuration.md)), `createLogReader` (reads the log from shared memory) and
`openSpeaker` (the page's audio output, below).

## The speaker

`openSpeaker({ worklet?, latencyHint? })`, called inside the click or touch that starts a run and
before any await, opens the audio context, sets `navigator.audioSession.type` to `playback` where
the browser has it, and starts the worklet loading (`worklet`: its URL, the package's `worklet.js`
beside `core.js` by default). It answers a speaker:

| Member | What it does |
| --- | --- |
| `ready(timeoutMs = 1000)` | `{ running: true }` once the worklet is loaded and the context runs, or `{ running: false, reason }`. A context still stopped is kept open and started at the person's next gesture. |
| `audioOptions()` | The `audio` option for `createApp`: `{ drained: true, sampleRate }`, and `port` on a page without shared memory. |
| `connect(app)` | Plays the built app: the worklet node, reading its track table and every process's beside it, or fed from the port. Once per speaker. |
| `volume(level)` | What is heard, 0 silent; the program's cursors move as they would. |
| `suspend()`, `resume()` | Holds it with a paused run; nothing else starts it again. A stop the browser made on its own (`interrupted` on a phone, a device change) is resumed when the context says so and at the next gesture. |
| `close()` | Stops the worklet and closes the context. |
| `context`, `state()` | The `AudioContext` and its state. |

## Options

The options reach the engine's worker by `postMessage`, so every value must be data.

### What runs

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `executable` | `Uint8Array` | required | The program's PE image. Only 32-bit x86 (PE32) is accepted. |
| `imagePath` | string | `'C:\app.exe'` | Where the program believes it was loaded from, and its start directory. |
| `commandLine` | string | the quoted `imagePath` | What `GetCommandLine` answers. If you compose it, quote argv[0] yourself. |
| `engine` | `'cork'` \| `'emulator'` | `'cork'` | What runs the x86 code: cork, which the package carries, or a v86 emulator the caller brings in `v86`; `'emulator'` without one is refused. |
| `mode` | `'auto'` \| `'compatible'` \| `'isolated'` | `'auto'` | How much uses shared memory. `isolated`: guest memory is a `SharedArrayBuffer`; the graphics worker reads unlocked bytes from it and writes read-backs into it in place. `compatible`: guest memory belongs to the engine thread, and whatever crosses to another thread is copied. `auto`: `isolated` on a cross-origin isolated page, `compatible` elsewhere. `isolated` where memory cannot be shared is refused at `createApp`. The `app` layer's diagnostics show the run's mode. |
| `concurrency` | `1` \| `2` \| `4` | `1` | How many processes run at once. `1`: the program runs on the engine's thread, and a child runs in its parent's place until it exits. `2` or `4`: every process, the page's program included, runs in its own worker, and a child runs beside its parent from `CreateProcess` on; a child beyond that count runs beside its parent, taking turns with it in the parent's worker. The engine's thread then runs no program and keeps the run's system (registry, volume, bundle, session, windows, ids, named events, semaphores and mutexes, journal, sound output, presenter), which each process reaches over a link; what a process in a worker shares and draws through the run, and what it cannot have yet, is in [limits.md](limits.md#processes). More than one process needs shared memory and runs `isolated`; asked for in `compatible` mode or where memory cannot be shared, the run is `compatible` with `1` and a `fallback` event says so. With more than one, the page's input and visibility go into a ring in shared memory that the engine reads between turns, and an idle engine sleeps on its doorbell instead of handing its thread back to the browser to look for input. At any concurrency the page's input goes to the process whose window should have it: the pointer to the window holding the mouse or under it, the keyboard to the window with the run's single focus. Where no window has it, it goes to no program, except in a run with no window showing, where the page is the console: the last-started process still running gets it. The `app` layer's diagnostics carry `concurrency`, `fallback` and the pacing counts (`pacing`). |
| `windows` | `'win2000'` \| `'winxp'` \| `'win7'` \| `'win10'` | `'winxp'` | The Windows the program sees; `GetVersionEx`, `RtlGetVersion`, the registry, system file versions and profile folders agree. Windows 10 reports 6.2 to a program whose manifest does not declare it. |
| `graphicsApi` | `'directx7'` \| `'directx8'` \| `'directx9'` \| `'directx10'` \| `'opengl'` | every API | The graphics the program gets. `directxN` keeps every DirectX up to N (DirectDraw, Direct3D 8, 9, then Direct3D 10 with DXGI); `opengl` keeps OpenGL alone. Only those system DLLs exist and only their code is built. The registry, `DirectXSetupGetVersion`, DxDiag and the DLLs' file versions report DirectX 7.0, 8.1 or 9.0c (9.0c for 9 and 10). Absent: every API, DirectX 9.0c. |
| `memorySize` | number | 1 GiB | Guest RAM in bytes, a power of two; reserved, not committed. |
| `heapSize` | number | the rest of RAM | How much the program's heaps may allocate. |
| `stackSize` | number | the image's stack reserve | The main thread's stack. |
| `quantum` | number | 100 000 | Guest instructions per scheduler turn. |
| `preemption` | boolean | `false` | End a turn early when a thread of higher priority is due. |
| `unattended` | boolean | `false` | Nobody is at the screen: every modal dialog and message box gets its default button, and each answer is reported as a `divergence` event. |
| `cork` | `{ moduleUrl?, config? }` | the package's | Where cork is loaded from, and its settings ([configuration.md](configuration.md#cpu)). |
| `v86` | `{ moduleUrl, wasmBytes }` | none | The caller's own v86 build, for `engine: 'emulator'`; the package carries none. |
| `zstd` | `{ wasmUrl?, wasmBytes? }` | the package's | The bundle decoder's wasm build; without it a JavaScript decoder is used. |
| `media` | `{ wasmBytes }` | none | The video decoder (FFmpeg in wasm). Without it the program is told no clip can be played. |

### Display, input and sound

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `canvas` | `HTMLCanvasElement` | none | The viewport. Its control is transferred once; a second program in the same canvas reuses the worker. |
| `container` | `Element` | none | Instead of `canvas`: a canvas is made inside it. With neither, the run has no display. |
| `host` | `'worker'` \| `'thread'` | `'worker'` where `Worker` exists | Where the engine runs. `thread` runs it on the calling thread over the same protocol. |
| `workerUrl` | string \| `URL` | beside the module | Where `engine.worker.js` is loaded from, for a bundler that moves it. |
| `transfer` | `Transferable[]` | none | Buffers in the options to hand over instead of copying (the wasm binaries). |
| `screen` | `{ width, height, bitsPerPixel }` | 640 × 480, 32 | The display the program is told it has. |
| `desktop` | `{ picture? }` | none | What the desktop shows where no window is: `picture` is `{ width, height, bits }`, 32 bits a pixel (B, G, R, unused), top row first, scaled to the screen. Absent: the desktop colour. |
| `maxFps` | number | 60 | Accepted, not applied yet ([limits.md](limits.md#graphics)). |
| `graphics` | `{ compressedTextures?, maxFrameLatency?, lendMemory?, guestCode?, driverRules?, videoMemory? }` | `false`, 3, `true`, `true`, `'legacy'`, the `graphicsApi` preset's | `compressedTextures`: upload BC-compressed textures where the GPU has `texture-compression-bc`. `maxFrameLatency`: how many frames the GPU may still be drawing when `Present` returns (0: no bound). `lendMemory`, `guestCode`, `driverRules`: see [configuration.md](configuration.md#graphics). `videoMemory`: the card's memory in megabytes, overriding the preset's. |
| `device.graphicsWorker` | `true` \| `'pixels'` \| `false` | `true` | Draw Direct3D 7–9 and OpenGL in a graphics worker that sends each frame back as an `ImageBitmap`; `'pixels'` sends the frame's bytes instead; `false` draws on the engine thread. |
| `audio` | `{ drained?, sampleRate?, mp3?, port? }` | `false`, none, `true`, none | `drained`: an `AudioWorkletNode` really reads the output, so play cursors follow the sound rather than a clock. `sampleRate`: the `AudioContext`'s rate. `mp3: false`: the program decodes MP3 with the library it ships instead of the engine's provider. `port`: on a page without shared memory, the engine's end of a `MessageChannel` whose other end the worklet holds; the mix is posted down it ([README.md](README.md#sound)). |

### Storage, bundles and discs

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `bundle` | `{ url \| file, id?, prefix?, store?, prefetch?, indexSha256?, retry? }` | none | A `.btl` mounted read-only on `C:`, under `prefix` (`App`: `C:\App`). It is read a block at a time, by HTTP `Range` from `url` or as slices of `file` (a `Blob`, such as a bundle kept in OPFS on this device), and fetched blocks are kept in OPFS under `id` (`store: null` keeps none, as a bundle already on the device needs). `prefetch` (on) fills the cache while nothing is being read; `indexSha256` (from the manifest) is checked against the bundle's index; `retry` is `{ attempts: 6, baseDelayMs: 250, maxDelayMs: 10000 }`. |
| `storage` | `'opfs'` \| `'local'` \| `{ files }` \| `null` | `null` | Where the session (the files the program wrote, and its registry) lives: `opfs` in the origin's file system, `local` in `localStorage`; `{ files }` seeds it for this run only; `null` keeps nothing. |
| `id` | string | none | Names the session, and the bundle cache when `bundle.id` is absent. |
| `files` | `{ path, bytes }[]` | none | Edits laid over the session at every start; they win over what the program last saved. The bundle never changes. |
| `discs` | `{ image, letter? }[]` | none | Disc images mounted as CD-ROM drives, `D:` or the next free letter. `image` is a `Blob` (read a range at a time) or bytes. |
| `collectOnExit` | boolean | `false` | The run's exit carries the files the program wrote, for `session.export()`. |

### Network

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `network` | `{ module, url, room, token? }` | none | The relay Winsock goes through: the URL of a module exporting `connectRelay` (`@bottlify/networking`'s client), the relay's `ws(s)://` address, and the room to join. Without it Winsock has only the loopback adapter. |

### Diagnostics

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `log` | `{ categories?, capacity?, bytes? }` | none | Call areas recorded from the first instruction (`{ 'call.gpu': 'trace' }`), and the journal's size: `capacity` records, `bytes` of ring (1 MiB). |
| `traceStrings` | boolean | `false` | Keep the text an argument points at in the journal. |
| `profileCalls` | boolean | `false` | Time every host call as a phase of its own. |
| `sampleJs` | boolean | `false` | Run the browser's JavaScript sampler on the engine's thread in 2 s windows; its top functions are the `js` diagnostics table. Needs `Document-Policy: js-profiling` ([README.md](README.md)) and the engine on a window's thread: Chrome offers the sampler to no worker, so with the engine in one the table says it is not measured. |
| `record` | number | 0 | How many events at the bridge to keep for a replay. |
| `hooks` | `HookSpec[]` | none | Watches placed in front of routines inside the program's own modules as they load. |
| `watch` | `{ libraries, strings }` | none | Watch calls from one guest module into another, by library and ordinal. |
| `refuseReplacement` | boolean | `false` | Stop instead of replacing the process with a child it asks for. |
| `exitNotice` | boolean | `true` | A program that exits with code 0 raises a `message-box` event saying it finished. |
| `sampling` | boolean | `true` | The cpu layer's guest sampler. |
| `device.*` | | | `dumpDraws`, `dumpEvery`, `maxDraws`, `skipTexture`, `probeTexture`, `keepImages`, `fog`, `mips`: per-draw dumps and one-variable-off runs of the graphics layer. |
| `pacing` | `'page'` \| `'event'` | `'page'` | How the run loop waits in a worker: a short look every turn, or sleep until something is due. |
| `pendingYieldMs` | number | `1` | While other guest threads still have work, how often, in milliseconds, the run loop yields to the event loop to hear an outstanding host answer (a call parked on the device, a range in flight). A turn that ran nothing yields at once. Lower hears answers sooner, at the cost of more event-loop round trips. |

The `log` table's phases show where the engine thread's time goes (`topPhases`; `phasesSelfMs`
for all of them together). A host call is the phase `trap`, timed one call in about 32 and weighted
as all of them. The work a Direct3D 8 or 9 call does before its method is the phase `ring-sync`
inside it, timed and weighted with the call. It is made of `ring-unlocked` (buffers the program let
go of), `ring-take` (calls the program left in the command ring) and, inside that, `ring-held`
(buffers still locked that those calls may read). The graphics worker's thread has no phase
table: `graphics.worker.phases` holds its totals since it started, `batch-read` (each batch of
calls read and played; its `selfMs` excludes the sweep) and `batch-sweep` (the once-a-frame look
at objects whose count reached zero). It is `null` until the worker has answered a diagnostics
request, and in a build that times nothing. `graphics.worker.latency` is the bound on the frames
the worker's GPU may still be drawing (`graphics.maxFrameLatency`), summed over the devices drawn
there: `held` and `heldMs` count the presents that waited for the GPU to finish a frame, and
`peak` is the most frames it was behind. A wait on a present in `graphics.worker.waits` that
`heldMs` does not account for was the worker's thread, not the GPU. `graphics.worker.handoff`
times the frames the worker sends to be shown, one at a time: how long each waited there for the
one before (`waitedMs`), its way to the thread that shows it (`thereMs`), showing it (`showMs`),
and the answer's way back (`back`), each a sum with its worst. Together they bound the frames shown
a second, whatever the worker draws; `graphics.worker.dropped` counts those a newer one replaced.
Where the two threads share memory, the thread that shows the frames also writes the number of each
one it shows into a word the worker reads at every present: a frame then goes as soon as the one
before it was shown, not once the answer has come through the worker's queue, and `back.early`
counts the frames that went so.

## The controller

| Member | What it does |
| --- | --- |
| `run({ maxTurns? })` | Runs the program; resolves with its exit code. |
| `pause()`, `resume()`, `stop()` | Hold, continue, or end the run. |
| `dispose()` | Ends the run and frees the engine; the worker stays with the canvas. |
| `on(name, handler)` | Subscribes to an event (below); returns the function that unsubscribes. |
| `answerMessageBox(id, button)` | Answers a `message-box` event with the id of the button pressed. |
| `input.attach(canvas, { pointerLock? })`, `input.detach()` | Capture keyboard, mouse and gamepads from the canvas, or stop. |
| `input.send(event)`, `input.poll()` | Send an input event yourself; poll the gamepads (call once a frame). An event is `{ kind, ... }`: `key` (`code` a `KeyboardEvent.code`, `down`), `text` (`text`, the character the `key` press sent just before it typed: it rides on that press and reaches no one alone), `type` (`text`, characters with no key behind them, delivered as Windows delivers `SendInput`'s Unicode input: a `VK_PACKET` press and release each, and `WM_CHAR` from `TranslateMessage`), `paste` (`text`, for the clipboard), `pointerMove` (`x`, `y` in the picture's pixels, and/or `dx`, `dy`), `pointerButton` (`button` `left`/`right`/`middle`/`x1`/`x2`, `down`), `wheel` (`delta` in multiples of 120), `focus` (`gained`), `padAxis` (`axis`, `value` -1..1), `padButton` (`index`, `down`). |
| `input.showKeyboard()`, `input.hideKeyboard()`, `input.keyboardShown()` | A phone's on-screen keyboard, typing into the game. `showKeyboard` must be called inside a touch's own handler (`click`, `touchend`), the only moment a phone shows its keyboard; it focuses a field the engine keeps beside the attached canvas and answers whether the field took the focus. What is typed reaches the program as a keyboard with keys would send it: each character on the US layout's key that types it, with Shift held where needed (so `WM_KEYDOWN`, `GetAsyncKeyState` and DirectInput see it), a character no key there types as `type`, a line break as Enter and a deletion as Backspace; a paired keyboard's keys go through as keys. Put away by the phone's own button, the keyboard leaves the game the focus. `false` with no canvas attached. |
| `input.route()` | Clicks and key taps driven from outside, one step at a time. `click(x, y, { button? })` and `key(code, frames?)` queue steps; `tick()` sends the next and returns how many are left (call it once a frame, or on a timer for a program that does not present). A click first pushes the pointer far up and left, on the next step moves it from the corner to the point and presses, and releases on the step after. A program that moves its own cursor by relative motion (DirectInput) thus clicks where the window's pointer is, wherever it had put its cursor. |
| `audio.memory()`, `audio.format()` | The output's shared table and `{ sampleRate, channels }`, for the `AudioWorkletNode`. |
| `adapter` | `{ vendor, architecture, description }` of the GPU the engine opened. |
| `canvas`, `host` | The viewport and where the engine runs. |
| `frames()`, `presented()` | Frames shown so far; the history of presents. |
| `files.list(path)`, `files.read(path)` | The volume as the program sees it. |
| `session.export()`, `registry().toJSON()` | After the exit: the files the program wrote (with `collectOnExit`) and its registry. |
| `attachLog(sink)`, `detachLog(sink)` | What the program writes to its standard handles, as `(handle, text)`. |
| `diagnostics(layer?)` | Every layer's diagnostics, or one layer's; a request to the engine thread, not for polling. Besides the layers' tables, a `windows` table lists the run's windows as every process reports them: every process's top-level windows, topmost first, each with its process, title, class, visibility and rectangle, and the run's foreground and captured windows. |
| `report()` | Everything the engine can say about the run in one answer: every layer's diagnostics, the phase profile and recent frames, `trace()`, the threads, guest time by module, and the guest code around its most-sampled addresses (`hotCode`, 4 KiB pages as base64). The app layer's table lists the divergences reported so far (`divergences`, the first 128). Devices drawing in the graphics worker are asked for their counters and awaited for up to a second, so the graphics table includes them. A request, not for polling. |
| `translationPool()` | The run's pool of translation workers (`cork.pool`) as it stands: how many workers it holds and how many are idle, how many work for each process, how many it opened and lent, the joins and leaves its driver decided, and a journal of the last decisions (`start`, `join`, `leave`, `exit`, each with the process, the time and the workers it had after). `null` where the run has none. |
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
| `cursor-moved` | `{ x, y }` | The cursor moved, by the pointer or by the program: its position as a fraction of the viewport each way. A locked pointer has no browser cursor, so the page draws the program's here. |
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
