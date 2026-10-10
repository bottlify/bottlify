# `@bottlify/core`

Run a 32-bit Windows program in a browser tab — the original `.exe`, unchanged.

The package is a machine and an operating system written for the web: the program's x86 code runs
on an execution engine in a Web Worker, and its calls into Windows — `kernel32`, `user32`, `gdi32`,
DirectDraw, Direct3D 7–10, OpenGL, DirectSound, Winsock and the rest — are answered by this package,
drawing with WebGPU, playing through Web Audio and keeping files in the origin's private file
system (OPFS). There is no Windows underneath and no Windows code inside.

The engine is **cork**, the translator in [`modules/cork`](../cork/README.md), which ships built
inside this package. The **v86** emulator is the other engine, when you bring a build of it
(below); then cork is not loaded at all.

This is early software: some programs run to their menus and further, many stop at an API that is
not there yet, and the log names it when they do. [`docs/core/limits.md`](../../docs/core/limits.md)
says what is missing.

## Play a game in three commands

From a checkout of this repository, with Node 22 or later:

```sh
npm ci && npm run build                                   # builds modules/core/dist
node tools/make-btl.mjs pack "/path/to/My Game" mygame     # bundles/mygame/bundle.btl + manifest.json
node tools/play.mjs mygame                                 # prints http://127.0.0.1:8080/?bottle=mygame
```

Open the address in Chrome or Edge (WebGPU) and press Start.

- **The folder** is the game as it is installed: its `.exe`, its DLLs, its data. `pack` takes a
  directory, not an archive: unpack a `.zip` first (`unzip game.zip -d game`).
- **The entry** — the program to start — is guessed as the largest `.exe` that is not a setup or a
  launcher. If the guess is wrong, set `"entry"` in `bundles/mygame/manifest.json` (a path inside
  the bundle, e.g. `"Bin\\Game.exe"`) and delete `bundles/mygame/entry` if it exists.
- **An installer** instead of an installed folder: see [`@bottlify/installer`](../installer/README.md)
  — it runs the setup inside the engine and makes the bottle from what it installed.
- Other bottle commands: `node tools/make-btl.mjs verify mygame`, `list mygame [pattern]`,
  `extract mygame [file]`.

## A bottle on your own page

A page needs three things served from one origin:

| Path | What | From |
| --- | --- | --- |
| `/bottlify/` | the engine: `core.js`, its workers, `worklet.js`, `cork/`, `vendor/` | `modules/core/dist` after `npm run build` |
| `/bundles/<id>/bundle.btl`, `manifest.json` | the bottle, read a block at a time | `make-btl pack` |
| `/bundles/<id>/entry` | the program's image, which `createApp` takes as bytes | `node tools/make-btl.mjs extract <id>` |

`bundle.btl` must be served with **HTTP Range** support (`206 Partial Content`): the engine never
downloads a game whole, it reads the blocks the program asks for and keeps them in OPFS. nginx,
Caddy, Apache, `npx http-server` and most CDNs do this; Python's `http.server` does not.

Optional, and recommended: serve every response with

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

so the page is cross-origin isolated and the engine shares memory with its workers (the `isolated`
mode). Without them it runs in the `compatible` mode, which works anywhere, an iframe on another
site included, and copies what crosses between threads. WebGPU needs `https://` or `localhost`.

The page itself is [`tools/play/index.html`](../../tools/play/index.html): copy it as it is, or
take the part that matters:

```html
<canvas id="screen" width="640" height="480"></canvas>
<button id="start">Start</button>
<script type="module">
import { createApp } from '/bottlify/core.js';

const id = 'mygame';
document.getElementById('start').onclick = async()=>{
    const manifest = await (await fetch(`/bundles/${id}/manifest.json`)).json();
    const executable = new Uint8Array(await (await fetch(`/bundles/${id}/entry`)).arrayBuffer());
    const canvas = document.getElementById('screen');
    const app = await createApp({
        canvas,
        executable,
        imagePath: `C:\\App\\${manifest.entry}`,          // the bottle is mounted at C:\App
        bundle: { url: `/bundles/${id}/bundle.btl`, id, indexSha256: manifest.bundle.indexSha256 },
        storage: 'opfs', id,                             // saves and settings, kept per bottle
    });
    app.input.attach(canvas);
    app.on('message-box', box=>app.answerMessageBox(box.id, box.defaultButton));
    console.log('exit code', await app.run());
};
</script>
```

The full page adds sound (an `AudioWorklet` fed by the engine, both with and without isolation) and
a bottle made by the installer, which is mounted where its setup put it rather than at `C:\App`.
Sound needs the click: a browser starts audio only from a person's gesture.

`node tools/play.mjs <id> [--port 8080] [--compatible]` is a local server for exactly this layout,
with Range and the isolation headers (`--compatible` leaves them off). The player page takes two more
things from its address for a measurement: `&executors=3` runs the program's threads on three
executors at once (`createApp`'s `executors`), and `&cork={"checkReads":true}` sets the
translator's settings (`EngineConfig`).

## Install as a package

```sh
npm install @bottlify/core      # or: npm install <checkout>/modules/core
```

```js
import { createApp } from '@bottlify/core';
```

`createApp` finds its workers, `cork/` and `vendor/` beside `core.js`; a bundler that moves files
takes `workerUrl` and `cork: { moduleUrl }`. The FFmpeg video decoder is a subpath,
`@bottlify/core/video-decoder.wasm`, handed in as `media: { wasmBytes }`; without it a program is
told no clip can be played. Every option, the controller and the events:
[`docs/core/api.md`](../../docs/core/api.md).

### Without cork: v86

```js
const app = await createApp({ executable, engine: 'emulator',
    v86: { moduleUrl: '/v86/libv86.mjs', wasmBytes: await (await fetch('/v86/v86.wasm')).arrayBuffer() } });
```

The package carries no v86; `engine: 'emulator'` without a build is refused.

### In Node

The same `createApp` runs headless in Node — no canvas, the engine on the calling thread. That is
how the tests run programs, and it suits console programs and installers:

```js
import { readFile } from 'node:fs/promises';
import { createApp } from '@bottlify/core';

const app = await createApp({ executable: new Uint8Array(await readFile('tool.exe')) });
app.on('output', ({ text })=>process.stdout.write(text));
console.log('exit code', await app.run());
await app.dispose();
```

## What else is in the package

| Export | What it is |
| --- | --- |
| `@bottlify/core` | `createApp`, `assembleModules` (the layers without a program), `createLogReader` |
| `@bottlify/core/bundle`, `/bundle/node` | the `.btl` format's constants; reading and writing bundles in Node |
| `@bottlify/core/iso` | reading ISO 9660 disc images |
| `@bottlify/core/worklet.js` | the sound output's `AudioWorklet` |

## Documentation

- [`docs/core/`](../../docs/core/README.md) — the page, the modes, sound; [`api.md`](../../docs/core/api.md)
  every option and event; [`configuration.md`](../../docs/core/configuration.md) each layer's
  settings; [`limits.md`](../../docs/core/limits.md) what is not there yet.
- [`docs/architecture.md`](../../docs/architecture.md) — how it works inside.
- [`@bottlify/networking`](../networking/README.md) — multiplayer and the internet for the program.

## Licence

MPL-2.0. See `LICENSE`, and `THIRD-PARTY-NOTICES.md` for the components distributed with it.
