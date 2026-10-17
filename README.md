# Bottlify

Bottlify runs Windows x86 programs and games in a browser tab, with no Windows, no plugin and
nothing to install. It is four packages; the first two run a program, the other two are optional:

- **[core](modules/core/README.md)** (`@bottlify/core`): a Windows environment written from scratch
  in JavaScript: `kernel32`, `user32`, `gdi32`, DirectX, OpenGL, DirectSound, Winsock and the rest
  of the system libraries, on top of WebGPU, WebAudio and OPFS. A page starts it with one call,
  `createApp()`; the engine runs in a Web Worker, and graphics, translation and sound each have a
  thread of their own.
- **[cork](modules/cork/README.md)** (`@bottlify/cork`, [in Russian](modules/cork/README.ru.md)):
  our x86 → WebAssembly translator and its runtime. It translates the program's machine code into
  wasm, which the browser compiles for the device's own processor, so the same build runs on x86
  and ARM machines alike.
- **[networking](modules/networking/README.md)** (`@bottlify/networking`, optional): TCP and UDP for
  a browser tab over one WebSocket, a relay server and its client. Without it a program reaches
  only the loopback inside its tab.
- **[installer](modules/installer/README.md)** (`@bottlify/installer`, optional): makes a bottle out
  of a game's installer, run unchanged inside the engine.

## What it covers

- **Programs:** 32-bit PE images; the loader maps them and gives every system library a real
  module in guest memory, so `GetProcAddress` answers the address an import was bound to. Threads
  run under a scheduler whose quantum is retired guest instructions.
- **Graphics:** DirectDraw, Direct3D 7, 8, 9 and 10 (with DXGI), OpenGL 1.x and Vulkan, all through
  one WebGPU backend, on a graphics worker of its own.
- **Sound and video:** DirectSound, DirectMusic and waveOut through a mixer an `AudioWorklet` plays;
  video through DirectShow over an FFmpeg build compiled to WebAssembly.
- **Files and network:** a program's files come out of a bundle read by byte range, and what it
  writes persists as a session; sockets go through a WebSocket relay (`@bottlify/networking`).

Every layer (`cpu`, `memory`, `kernel`, `bridge`, `loader`, `log`, `filesystem`, `win32`,
`graphics`, `audio`, `input`, `media`) is a module with a declared interface, and the system runs
without any one of them, degraded but not broken.

## Documentation

- [`docs/architecture.md`](docs/architecture.md): how Bottlify works inside: threads, startup,
  cork, the system libraries, graphics, sound, networking and storage
  ([in Russian](docs/architecture.ru.md)).
- [`docs/core/`](docs/core/README.md): `@bottlify/core` for its users: the
  [API](docs/core/api.md), the [configuration](docs/core/configuration.md) and the current
  [limits](docs/core/limits.md).
- [`roadmap/`](roadmap/README.md): the plan: [x86-64](roadmap/x64.md),
  [Direct3D 11 and 12](roadmap/direct3d.md), [OpenGL 2.0 to 4.x](roadmap/opengl.md), and
  [`decisions.md`](roadmap/decisions.md).

## Building and testing

```sh
npm ci
npm run fetch:video-decoder && npm run fetch:corpus   # the pinned decoder and cork's x86 corpus
npm run typecheck && npm run lint && npm test && npm run check:boundaries
npm run test:integration && npm run build
npm run cdp:probe   # boots the engine in a real headless Chrome
```

## Layout

- `modules/<package>/`: the four packages above. In `modules/core/`, `src/system/` holds the
  module contract, `src/layers/<name>/` one directory per layer, `src/host/` the page and worker
  ends of `createApp`.
- `tools/` holds development tools: the browser harness (`cdp_test/`), import audits, benchmarks.
- `docs/` and `roadmap/` are described above.

The launcher and the bottle interface live in a repository of their own,
[`bottlify-ui`](https://github.com/bottlify/bottlify-ui).

Bottlify is licensed under the MPL-2.0. Components and code from others are listed in
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
