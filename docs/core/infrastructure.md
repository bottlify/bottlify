# `@bottlify/core` — source layout

How `modules/core/src/` is physically organised: naming conventions, the directory tree as it
stands, and how a guest DLL whose two halves live in different layers is joined. The module graph
itself (`requires`, enforced by `scripts/check-boundaries.mjs`) is in [`system.md`](./system.md);
this file records how that graph maps onto directories.

## 1. Naming conventions

- **No `.dll` suffix in directory names**: `win32/kernel32/`, not `win32/kernel32.dll/`. A suffix
  on a directory reads as a file extension.
- **No nesting by guest filesystem path**: not `win32/system32/kernel32/`. Which guest path a DLL
  resolves from is the loader's and filesystem's concern at runtime; the source layout encodes the
  implementation boundary, not a fact about the guest.
- **The layer is called `win32`, not `win`.** Win32 is the name of the API contract, not a claim
  about the guest's bitness.
- **A layer's own machinery goes in `internal/`**; a guest-visible library or a backend gets a
  directory named for it. `api.js` is the layer's JSDoc interface, `module.js` its
  `BottlifyModule`, and `*.test.js` sits beside what it tests.

## 2. The tree

Test files are omitted. Every `src/layers/<name>/` has `api.js` and `module.js`; they are not
repeated below.

```
modules/core/src/
├── index.js               # what the package exports: createApp, assembleModules, createLogReader
├── core.js                # assembleModules: registry → plan → scoped hosts → CoreInstance
├── app.js                 # the engine: assembles the layers, maps the process, binds imports,
│                          #   the run loop and its pacing, process replacement
├── events.js              # the event registry a consumer's `on` hooks into
├── storage.js             # sessions: files + registry, packed; 'local', 'opfs', a provider
├── letterbox.js           # fitting a clip onto a display of another shape
├── trace.js               # what was happening when it went wrong: registers, stack scan
├── *.itest.js             # whole fixture programs through the engine
│
├── system/                # the module contract; imports no layer
│   ├── contract.js        #   typedefs only
│   ├── config.js          #   { name: boolean | object } → toggles
│   ├── registry.js        #   active set, topological order, stub installation
│   ├── host.js            #   the scoped host a module is handed
│   └── stub.js            #   NOT_IMPLEMENTED stand-ins
│
├── host/                  # where the engine runs: the page's end and the worker's end
│   ├── create.js          #   createApp as exported: picks worker or thread, keeps the canvas's host
│   ├── messages.js        #   the port protocol, typedefs only
│   ├── remote.js          #   the page's controller: requests, events, input capture, journal mirror
│   ├── serve.js           #   the engine's end: method table, device, presenter, pacing
│   └── engine.worker.js   #   the worker entry: serveEngine on the worker's global scope
│
└── layers/
    ├── index.js           # defaultModules(), in dependency order
    ├── log/internal/      # journal.js profiler.js ring.js
    ├── cpu/internal/      # cork-host.js translation-store.js thunks.js context.js faults.js
    │                      #   ports.js samples.js; v86-host.js boot-rom.js fpu.js for a caller's v86
    ├── memory/internal/   # regions.js accessors.js
    ├── kernel/internal/   # threads.js switch.js sync.js handles.js time.js processes.js stacks.js
    ├── bridge/            # replay.js — recorded sessions replayed through the real bridge
    │   ├── internal/      #   conventions.js dispatch.js parking.js callback.js vtable.js
    │   └── sessions/      #   recorded runs that went wrong, one JSON each, with a README
    ├── loader/internal/   # pe.js image.js dependencies.js delayload.js tls.js resources.js
    │                      #   synth.js (in-guest module synthesis) init.js hooks.js
    │                      #   mangling.js (what a C++ name says of its stack)
    ├── filesystem/internal/
    │   ├── tree.js paths.js handles.js errors.js memory-store.js opfs-store.js
    │   └── bundle/        #   format.js source.js cache.js crc32.js
    ├── media/internal/    # decoder.js (FFmpeg wasm) jpeg.js ijl.js (the hosted JPEG library)
    │
    ├── win32/             # one directory per guest-visible library
    │   ├── kernel32/      #   process, threading, sync, slimsync, critical, heap, files, vfs,
    │   │                  #   mapping, modules, resources, seh, iocp, console, locale,
    │   │                  #   environment, profile, spawn
    │   ├── user32/        #   windows, messages, paint, dialogs, controls, frame, display, objects,
    │   │                  #   system, cursors, rawinput, keys
    │   │                  #   (keys.js: the physical-key table input's router and dom also use)
    │   ├── gdi32/         #   objects, drawing (the ABI in front of an injected drawing service), structs
    │   ├── advapi32/      #   the registry and the rest
    │   ├── ole32/  oleaut32/
    │   ├── msvcrt/        #   strings, formatting, io (descriptors), stdio (streams), globals,
    │   │                  #   startup, threads, seh, eh, cxx and the rest
    │   ├── ntdll/
    │   ├── winmm/         #   timeGetTime, the wave-out queue, notifications, its thread, mmio
    │   ├── wsock32/       #   sockets, loopback, sockaddr, the transport contract (also ws2_32, mswsock)
    │   ├── quartz/        #   the DirectShow filter graph and its interfaces
    │   ├── shell32/       #   launching, fileop (SHFileOperation), the namespace, shell links
    │   ├── comctl32/      #   image lists, progress, treeview, tab, propsheet
    │   ├── comdlg32/  imm32/  version/  wininet/  shlwapi/  and the smaller libraries
    │
    ├── graphics/          # requires win32, bridge, memory — a sibling of win32, not inside it
    │   ├── webgpu/        #   the one backend: backend.js contract.js
    │   │   └── internal/  #   pipeline, shaders, fixedfunction, programmable, textures, buffers,
    │   │                  #   bindings, vertexformat, viewport, presenter, pacer, profiler,
    │   │                  #   reference (the software model frames are checked against), fake-device
    │   ├── gdi/           #   the drawing half of gdi32: blit, brush, context, dib, rop, shapes, surface, text
    │   ├── ddraw/         #   objects, blit, caps, constants, structs
    │   ├── d3d7/          #   device, caps, constants, load, process (ProcessVertices)
    │   ├── d3d8/          #   device, render, renderstates, stagestates, stateblock, structs, validity
    │   ├── d3d9/          #   device, interfaces, resources, declaration, shader, wgsl, stateblock, caps, …
    │   ├── d3d10/         #   device, dxgi, resources, states, render, sm4, dxbc, wgsl, gpuformats, com
    │   ├── opengl/        #   context*, state, matrix, lighting, texture, arrays, pipeline, raster,
    │   │                  #   pixelformat, wgl, extensions, exports
    │   ├── vulkan/        #   instance, physical, device, commands, handles, spirv, runtime
    │   └── seam/          #   what the guest sees: exports.js vtables.js iids.js com.js structs.js
    │                      #   shadow.js raster.js privatedata.js, and one file per library —
    │                      #   ddraw, d3d7, d3d8, d3d9, d3d10, vulkan
    │
    ├── audio/             # requires win32, bridge, memory
    │   ├── output/        #   mixer.js ring.js worklet.js (the AudioWorkletProcessor, shipped as dist/worklet.js)
    │   ├── dsound/        #   buffers.js seam.js
    │   └── asi/           #   provider.js mp3.js — the MPEG provider a sound middleware loads, hosted
    │
    └── input/             # requires win32, bridge, memory
        ├── router.js      #   one event stream into the message queue, raw input and the polled state
        ├── dom.js         #   keyboard and mouse captured on a canvas (runs on the page)
        ├── xinput.js      #   XInput, answered as a machine with no pad
        └── dinput/        #   devices.js seam.js — DirectInput and DirectInput8
```

Libraries a program sees, by the layer that publishes them: `win32` synthesises `KERNEL32`,
`USER32`, `GDI32`, `ADVAPI32`, `ole32`, `OLEAUT32`, `msvcrt`, `ntdll`, `WINMM`, `WSOCK32`, `WS2_32`,
`MSWSOCK`, `SHELL32`, `COMCTL32`, `COMDLG32`, `IMM32`, `VERSION`, `WININET`; `graphics` publishes
`DDRAW`, `D3D8`, `D3D9`, `D3D10`, `DXGI`, `OPENGL32`, `vulkan-1`; `audio` publishes `DSOUND` and
answers as `Mp3dec.asi` to a program's `mss32`; `input` publishes `DINPUT`, `DINPUT8`, `XINPUT9_1_0`
and `XINPUT1_4`; `media` answers as `ijl15`. Direct3D 7 is reached through `DDRAW`, DirectShow
through `ole32`'s class factory.

## 3. A DLL whose halves live in two layers

`win32` requires neither `graphics`, `audio`, `media` nor `input` (the graph would otherwise have a
cycle: those three require `win32`), yet several of its libraries need them. The mechanism is
decided and in use: the upper layer's service arrives in win32's **configuration** as a thunk the
assembler (`src/app.js`) hands down, resolved lazily through `core.api(...)`, and the win32 file is
the guest ABI in front of it. A build without the upper layer gets a thunk that answers `null`, and
the entry points then fail truthfully — `FALSE`, a null handle, a cursor that advances on the clock
— rather than reporting success and doing nothing.

| library | half in `win32/` | half elsewhere | joined by |
|---|---|---|---|
| `gdi32` | `win32/gdi32/` — handles, objects, regions, palettes, the argument reading | `graphics/gdi/` — the pixels: blit, shapes, text, DIBs | `config.graphics` |
| `winmm` | `win32/winmm/` — the clock, the wave-out queue and its done flags | `audio/output/` — the mixer the queue's play cursor comes from | `config.output` |
| `quartz` | `win32/quartz/` — the filter graph, its events and interfaces | `media/internal/` — the decoder that gives it frames | `config.video` |
| `user32` cursor and key state | `win32/user32/` — `GetCursorPos`, `ClipCursor`, `GetKeyState` | `input/router.js` — the polled state | `config.cursor`, `config.clipCursor`, `config.keyState` |
| `wsock32` | `win32/wsock32/` — sockets, the loopback address space | outside the package: the embedder's transport (`@bottlify/networking` is one) | `transport.js`, a callback contract |

The same pattern runs downwards too. `audio` cannot reach `kernel` to set an event, so the
assembler hands it `signal(handle)`; `media` cannot reach `memory` or win32's heap, so it gets
`readMemory`, `writeMemory`, `allocate`. What the graph does not express as an edge, the
assembler expresses as configuration, and nothing else may.

## 4. Open questions

- **A React binding.** A `@bottlify/core/react` subpath keeps one version and one release; a
  separate package keeps the dependency graph cleaner for non-React consumers. Not started; the
  core stays framework-agnostic either way.
- **A second worker for the audio layer.** The seam is designed and the reason it is not crossed
  is a measurement; see [`host.md`](./host.md) §9.
- **Glide.** The one drawing API in the original scope with no directory and no code.
