# Startup: from createApp to the first instruction

```mermaid
%%{init: {"theme": "base", "sequence": {"mirrorActors": false, "messageMargin": 24, "noteMargin": 8, "actorMargin": 40}, "themeVariables": {"fontFamily": "Inter, Segoe UI, Helvetica, Arial, sans-serif", "fontSize": "13px", "actorBkg": "#FFFFFF", "actorBorder": "#2F3A40", "actorTextColor": "#1B2328", "actorLineColor": "#9AA6AC", "signalColor": "#5C6970", "signalTextColor": "#1B2328", "noteBkgColor": "#F3F5F6", "noteBorderColor": "#9AA6AC", "noteTextColor": "#1B2328", "labelBoxBkgColor": "#F3F5F6", "labelBoxBorderColor": "#9AA6AC", "labelTextColor": "#1B2328", "loopTextColor": "#1B2328"}}}%%
sequenceDiagram
  participant S as Server
  participant P as Page
  participant K as Log keeper
  participant E as Engine
  participant G as Graphics
  participant T as Translation
  participant O as OPFS
  participant A as AudioWorklet
  Note over S,P: the launcher, ui/src/engine/session.js
  P->>S: /engine/core.js, /bundles/id/entry, the video decoder's wasm
  P->>P: AudioContext, addModule(worklet.js)
  Note over P,E: createApp, core/src/host/
  P->>E: new Worker(engine.worker.js)
  P->>K: new Worker(log.worker.js)
  P->>E: the canvas as an OffscreenCanvas, the start request
  E->>E: WebGPU device
  E->>G: new Worker(graphics.worker.js)
  G-->>E: its own WebGPU device is open
  E->>S: WebSocket /relay, if networking is wanted
  Note over E,O: the engine's createApp, core/src/app.js
  E->>O: cork's translation directory
  E->>S: /engine/cork/index.js
  E->>E: layers in requires order
  E->>O: session: registry and files from last time
  E->>S: bundle header and table of contents (Range)
  E->>O: block cache, translations from the bundle
  E->>E: loader: .exe, DLLs, TLS, the program's main thread into the scheduler
  E->>T: new Worker(translator.worker.js), lent to the process by the run's pool
  E-->>P: start answer: voice table, journal memory
  P->>K: journal memory
  P->>A: new AudioWorkletNode(voice table, or a port for the mix)
  P->>E: run
  Note over E: the program's first instruction
  loop every frame
    E->>G: a batch of Direct3D and OpenGL calls
    G-->>E: frame as ImageBitmap
    E->>E: presenter: frame into the OffscreenCanvas
  end
```

The order matters in three places.

- **The WebGPU device and the graphics thread open before the layers.** The engine's `createApp`
  receives the graphics thread in its device options (`device.worker`), so the `graphics` layer knows
  while it is being built where Direct3D and OpenGL will draw.
- **The session is applied before the program's first instruction,** so the program sees its saves
  and registry from the very start. A session in the origin's file system is read and laid on the
  volume a file at a time, and the volume's writable layer stands on the run's page file
  ([storage.md](storage.md)) where the engine's thread has one.
- **The program starts only on `run`,** once the page has attached the log, input and sound.
  Libraries' `DllMain` and TLS callbacks are the program's code too: a stub at the start of the main
  thread calls them, not the host. Every thread made later begins in a stub of its own that calls
  them with `DLL_THREAD_ATTACH` before its start routine, and with `DLL_THREAD_DETACH` when it
  ends, under the same loader lock (`kernel32/thread-calls.js`). The process's end and the last
  `FreeLibrary` tell each image's TLS callbacks `DLL_PROCESS_DETACH` before its `DllMain`
  (`kernel32/dllentry.js`).

With processes at once (`concurrency` 2 or 4), the engine thread builds the run's system instead:
it mounts the bundle, lays the session and the page's files on the volume, makes the registry and
opens the journal and the sound output (`buildSystemHost` in [`core/src/app.js`](../../modules/core/src/app.js)). The steps from
the layers to the program's first instruction run in the program's process thread.

Where to look in the code: `ui/src/engine/session.js` (what the launcher passes),
[`core/src/host/create.js`](../../modules/core/src/host/create.js) and `remote.js` (the page side), `serve.js` (the engine side),
[`core/src/app.js`](../../modules/core/src/app.js) (`createApp`, `buildApp`, the loader).
