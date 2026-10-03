# `@bottlify/core`

Run an original Win32 x86 program in a browser tab.

The package is an x86 machine running in a Web Worker -- the program's own code translated to
WebAssembly by cork, this project's translator -- with a from-scratch Win32 and DirectX layer
written on top of it. There is no Windows underneath: the PE loader maps the executable and
synthesises a real in-guest module for each system library. Calls that leave the program and
enter `kernel32`, `user32`, `gdi32`, `ole32`, `winmm`, `wsock32`, DirectDraw, Direct3D 7/8/9 or
OpenGL are answered by this package, and its rendering goes out through WebGPU, its sound through
WebAudio, and its filesystem into OPFS.

## What it can do today

This is early. What has actually been measured in this repository:

- A windowed 32-bit program starts, registers its window class, pumps its message loop, mounts its
  own archives, creates Direct3D 8 textures and presents lit, fogged frames on a real GPU. One
  commercial title has been driven this far — to its main menu.
- Threads run under a scheduler whose quantum is retired guest instructions; the bridge marshals
  `stdcall`, `cdecl` and `thiscall`, calls back into guest code, and places COM interfaces in guest
  memory.

What that means in practice: expect to be bringing a program up, not playing it. Anything past a
menu is unproven, there are no performance numbers worth quoting yet, and a program that needs an
API this package does not implement will say so in the log rather than work.

Where behaviour differs from the API being reproduced, the call still succeeds and the divergence is
reported as a warning in the run's journal — so a state that was accepted and not honoured is
visible rather than silent.

## Install

```sh
npm install @bottlify/core
```

Node 22+ to build against; a browser with WebGPU to run in.

## Use

`createApp()` needs the program to run; the translator ships inside this package and is found
beside it. The video decoder is a subpath export, so a bundler resolves it the same way it
resolves the entry point.

```js
import { createApp } from '@bottlify/core';

// Vite: `?url` resolves a bare specifier through the package's `exports` and emits the file as an
// asset. webpack 5 and Parcel do the same for a `.wasm` import through an asset/resource rule.
import decoderWasmUrl from '@bottlify/core/video-decoder.wasm?url';

const load = async url=>(await fetch(url)).arrayBuffer();

const app = await createApp({
    executable: new Uint8Array(await (await fetch('/game/game.exe')).arrayBuffer()),
    // Optional. Left out, the media layer comes up and reports that nothing can be played.
    media: { wasmBytes: await load(decoderWasmUrl) },
    // Where the program is told it was loaded from, so it looks for its data next to itself.
    imagePath: 'C:\\App\\game.exe',
});

await app.run();
```

Without a bundler — native ES modules, or Node — the same subpath resolves through
`import.meta.resolve('@bottlify/core/video-decoder.wasm')`.

The v86 emulator is an engine a caller may select, and the package does not carry it:
`createApp({ engine: 'emulator', v86: { moduleUrl, wasmBytes } })` runs the build the caller
brings, and `engine: 'emulator'` without one is refused as not installed.

The controller `createApp()` returns also carries `stop()`, `dispose()`, `diagnostics()` and an
`input.attach(canvas)` for handing it a surface to draw on and read events from.

## Where the wasm comes from

`video-decoder.wasm` is FFmpeg compiled to WebAssembly by this repository's `vendor` workflow. It
is not compiled by the package build and not committed: the build pulls a pinned release, verifies
it against a checked-in lock, and copies it into `dist/vendor/`. `dist/vendor/manifest.json` records the SHA-256 and the release each artifact
came from, and `dist/checksums.json` covers everything in the package.

## Documentation

[`docs/core/`](https://github.com/bottlify/bottlify/tree/main/docs/core) documents `createApp`'s
options and controller, the module contract and each layer's configuration, and what is not there
yet.

## Licence

MPL-2.0. See `LICENSE`, and `THIRD-PARTY-NOTICES.md` for the components distributed with it.
