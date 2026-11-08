# Inside Bottlify

Paths without a prefix are relative to [`modules/`](../../modules/) in bottlify; paths starting with `ui/` are
relative to the root of bottlify-ui. Where a diagram and the code disagree, the code is right.

The pages, in the order they build on each other:

- [Threads: who starts whom, and why](threads.md)
- [Startup: from createApp to the first instruction](startup.md)
- [cork, the execution core](cork.md)
- [Win32 in JavaScript: how a DLL comes about](win32.md)
- [Graphics](graphics.md)
- [Sound](sound.md)
- [Networking](networking.md)
- [Storage](storage.md)

## What it is

What Bottlify is and why it exists is in the [README](../../README.md). This document is how it works.
The table shows what in Bottlify gives a program what it needs from Windows and from the machine,
and which web API that runs on. The server plays no part in a frame: it only serves files and
forwards network traffic.

| What an application needs | What provides it | What it runs on |
| --- | --- | --- |
| An x86 processor | cork, translating x86 to wasm | WebAssembly |
| System DLLs | the `win32` layer: functions in JS that the program sees as real PE images | |
| DirectDraw, Direct3D 7–10, OpenGL, Vulkan, GDI | the `graphics` layer | WebGPU |
| DirectSound, waveOut, DirectMusic | the `audio` layer | AudioWorklet, SharedArrayBuffer where the page has it |
| Several processors | the `cpu` layer's executors, each a worker over the program's memory | Web Workers, SharedArrayBuffer |
| DirectInput, XInput, window messages | the `input` layer | keyboard and mouse events, Gamepad API |
| DirectShow cinematics | the `media` layer, FFmpeg in wasm | WebAssembly |
| A disk | a bundle read block by block, with a session on top | fetch with Range, OPFS |
| Winsock | `wsock32` and the relay | WebSocket |

### Why games

The idea behind Bottlify is a game in a bottle, so the engine is built first of all for games. For
a game, speed is part of being correct: a game that draws 10 frames a second instead of 60 does
not work, however right its arithmetic is.

A game is also the best test for a system like this:

- **A game exercises everything at once.** Integer code, x87 and SSE, Direct3D, sound, input, files,
  threads, sometimes the network: one run goes through nearly every layer of the engine.
- **A game measures itself.** Many games ship built-in benchmarks and timedemos: the same scene
  every time, and frames per second at the end. Two runs compare as numbers, so a regression shows at
  once rather than by eye.
- **Gaps show at once.** A missing function makes the program stop with `unimplemented import` and
  that function's name. An inexact one shows as a misplaced picture, a click in the sound or lost
  frames. Each such failure points at a specific place in the engine.
- **There are a great many games.** Thousands of programs from different years, engines and
  compilers make a huge ready-made test suite nobody has to write.

The engine is never bent to fit one game: when a game stumbles, the shared layer it stumbled on is
fixed, and the fix reaches every program that takes the same path. So although what games need is
the most developed part today (DirectX and OpenGL, sound, input, cinematics and networking), it
works for any application.

## What it is made of

The repository has four `@bottlify/` packages:

| Package | What is inside |
| --- | --- |
| `@bottlify/core` | Our Windows environment: Win32 and DirectX, the loader, the scheduler, files, and `createApp`, which starts it all |
| `@bottlify/cork` | The x86 → wasm translator and its runtime. The engine does not import it; it loads it by URL |
| `@bottlify/networking` | The client and server of the relay that applications reach the network through |
| `@bottlify/installer` | Installing an application with its own installer, and packing bundles |

For debugging there is also **bottlify-ui**, a repository of its own: a React launcher and a local
server that serves the application, the engine, the bundles and the relay from one address.

The engine is split into layers, and any of them can be switched off without breaking the rest.
Each layer has its own interface, configuration and tests, and talks to other layers only through
what it declares in `requires`. A layer switched off that another needs is replaced by a stub:
with `graphics: null`, for instance, a game runs with no picture. The module contract and the
`npm run check:boundaries` check are in [`core/configuration.md`](../core/configuration.md#the-module-contract).

| Layer | Responsible for | `requires` |
| --- | --- | --- |
| `log` | the journal, counters, phase profile | |
| `cpu` | running x86 code through cork, trapping calls into the bridge | `log` |
| `memory` | the program's address space: reservation, pages, protection | `cpu`, `log` |
| `kernel` | processes, threads, the scheduler, wait objects | `cpu`, `memory`, `log` |
| `loader` | loading PE images and building the system DLLs | `cpu`, `memory`, `log` |
| `bridge` | calling conventions, parking threads, callbacks, COM in the program's memory | `cpu`, `kernel`, `memory`, `log` |
| `filesystem` | the bundle, the block cache, the `C:` drive, the files the program writes | `log` |
| `win32` | kernel32, user32, gdi32, advapi32, ole32, msvcrt, winmm, wsock32 and some thirty more DLLs | `bridge`, `kernel`, `memory`, `loader`, `filesystem`, `media`, `log` |
| `graphics` | DirectDraw, Direct3D 7/8/9/10, OpenGL, Vulkan and the WebGPU backend under them | `win32`, `bridge`, `memory` |
| `audio` | DirectSound, DirectMusic, the mixer, MP3 for Miles | `win32`, `bridge`, `memory` |
| `input` | DirectInput, XInput, keyboard and mouse in the message queue | `win32`, `bridge`, `memory` |
| `media` | the video decoder (FFmpeg in wasm) and `ijl15.dll` | `log` |
