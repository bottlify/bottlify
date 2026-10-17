# Bottlify

[По-русски](README.ru.md)

## What it is

Bottlify is a set of JavaScript modules for running Windows x86 programs and games in a browser. A
page loads the modules and starts an ordinary `.exe` with them: the program runs right in the tab,
with no Windows, no plugin and nothing to install. The program itself does not know it is in a
browser: it sees Windows, a `C:` drive, a registry, windows, DirectX and sound.

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
- **[cork](modules/cork/README.md)** (`@bottlify/cork`): the x86 → WebAssembly translator. It
  translates the program's machine code into wasm, which the browser compiles for the device's own
  processor, so the same build runs on x86 and ARM alike.
- **[networking](modules/networking/README.md)** (`@bottlify/networking`, optional): TCP and UDP for
  a browser tab over one WebSocket, a relay server and its client. Without it a program reaches
  only the loopback inside its tab.
- **[installer](modules/installer/README.md)** (`@bottlify/installer`, optional): makes a bottle out
  of a game's installer, run unchanged inside the engine.

How the whole thing works (threads, startup, translation, Win32, graphics, sound, networking,
storage) is in [the architecture](docs/architecture.md). Each module is described in its own
README, linked above. Embedding `@bottlify/core`: [its API, configuration and
limits](docs/core/README.md). Plans are in [`roadmap/`](roadmap/README.md).

## Building and testing

```sh
npm ci
npm run fetch:video-decoder && npm run fetch:corpus   # the pinned decoder and cork's x86 corpus
npm run typecheck && npm run lint && npm test && npm run check:boundaries
npm run test:integration && npm run build
npm run cdp:probe   # boots the engine in a real headless Chrome
```

The modules are in `modules/`, development tools (the browser harness, import audits, benchmarks)
in `tools/`. The launcher and the bottle interface live in a repository of their own,
[`bottlify-ui`](https://github.com/bottlify/bottlify-ui).

Bottlify is licensed under the MPL-2.0. Components and code from others are listed in
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
