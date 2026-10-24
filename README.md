# Bottlify: run Windows games and programs in the browser

[По-русски](README.ru.md)

**Play old PC games and run Windows programs in a web browser**, with no Windows, no install and
no plugin. Try it at [bottlify.app](https://bottlify.app/).

Bottlify is a set of packages a web page uses for that: a Windows compatibility layer (in the spirit
of Wine) and an x86-to-WebAssembly translator. The page opens an ordinary `.exe`, and the program
runs as if Windows were around it, with a `C:` drive, a registry, windows, DirectX drawn through
WebGPU, and sound.

Supported: 32-bit programs, DirectDraw, Direct3D 7–10, OpenGL 1.1 with extensions, Vulkan,
DirectSound, DirectMusic, video through DirectShow and networking through Winsock.

## Why

Every device has a browser, from a phone to a desktop. Bottlify makes it a platform for programs
and games that already exist: a game sits "in a bottle" and opens from a link.

Plugins tried to make the browser a platform before: Flash, Java applets, Unity Web Player.
Programs had to be written for each of them, and when browsers dropped plugins, those games stopped
working. Bottlify relies only on standards every modern browser has (WebAssembly, WebGPU, Web
Audio, OPFS), and programs need no rewriting for it.

## What it is made of

- **[core](modules/core/README.md)** (`@bottlify/core`): a Windows environment written from scratch
  in JavaScript. `kernel32`, `user32`, `gdi32`, DirectX, OpenGL, DirectSound, Winsock and the rest
  of the system libraries, on top of WebGPU, WebAudio and OPFS. A page starts it with one call,
  `createApp()`.
- **[cork](modules/cork/README.md)** (`@bottlify/cork`): the x86 processor for core.
- **[networking](modules/networking/README.md)** (`@bottlify/networking`, optional): TCP and UDP for
  a browser tab over one WebSocket, a relay server and its client. Without it a program reaches
  only the loopback inside its tab.
- **[installer](modules/installer/README.md)** (`@bottlify/installer`, optional): makes a bottle out
  of a game's installer, run unchanged inside the engine.

How the whole thing works (threads, startup, translation, Win32, graphics, sound, networking,
storage) is in [the architecture](docs/architecture.md). Embedding `@bottlify/core`: [its API,
configuration and limits](docs/core/README.md). Plans are in [`roadmap/`](roadmap/README.md).

## Building and testing

```sh
npm ci
npm run fetch:video-decoder && npm run fetch:corpus   # the pinned decoder and cork's x86 corpus
npm run typecheck && npm run lint && npm test && npm run check:boundaries
npm run test:integration && npm run build
npm run cdp:probe   # boots the engine in a real headless Chrome
```

The modules are in [`modules/`](modules/), development tools (the browser harness, import audits,
benchmarks) in [`tools/`](tools/). The launcher and the bottle interface live in a repository of
their own, [`bottlify-ui`](https://github.com/bottlify/bottlify-ui).

Bottlify is licensed under the MPL-2.0. Components and code from others are listed in
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
