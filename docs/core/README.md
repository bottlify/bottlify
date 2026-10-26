# @bottlify/core

`@bottlify/core` runs an unchanged 32-bit Windows program in a browser tab: its layers answer the
program's calls into Windows on WebGPU, Web Audio, OPFS and WebSocket
([how it works](../architecture.md)).

## The smallest page

```js
import { createApp } from '@bottlify/core';

const canvas = document.querySelector('canvas');
// The program's PE image, beside the bundle (`node tools/make-btl.mjs extract demo`).
const executable = new Uint8Array(await (await fetch('/bundles/demo/entry')).arrayBuffer());

const app = await createApp({
    canvas,
    executable,
    imagePath: 'C:\\App\\demo.exe',                        // where the program thinks it lives
    bundle: { url: '/bundles/demo/bundle.btl', id: 'demo' }, // mounted read-only at C:\App
    storage: 'opfs',                                         // saves and registry, kept per id
    id: 'demo',
});
app.input.attach(canvas);
const exitCode = await app.run();
await app.dispose();
```

The engine runs in its own worker and takes the canvas over (`transferControlToOffscreen`). The
page needs:

- **WebGPU** for any picture: https, or `localhost`.
- **Cross-origin isolation** (`Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Embedder-Policy: require-corp`) for `SharedArrayBuffer`, which the `isolated` mode
  runs on. Without it the engine runs `compatible`: the log is read by asking the engine, guest
  memory belongs to the engine alone, and sound is mixed on the engine's thread and posted to the
  worklet.
- **`Document-Policy: js-profiling`** on the page and every worker script, only for `sampleJs`:
  the browser grants its JavaScript sampler only to a document or worker served with it. Without
  it the `js` diagnostics table says the sampler was refused; nothing else changes.

## Play a game in three commands

From a checkout of this repository, with Node 22 or later:

```sh
npm ci && npm run build                                   # builds modules/core/dist
node tools/make-btl.mjs pack "/path/to/My Game" mygame     # bundles/mygame/bundle.btl + manifest.json
node tools/play.mjs mygame                                 # prints http://127.0.0.1:8080/?bottle=mygame
```

Open the address in Chrome or Edge (WebGPU) and press Start.

- **The folder** is the game as installed: its `.exe`, its DLLs, its data. `pack` takes a
  directory, not an archive: unpack a `.zip` first (`unzip game.zip -d game`).
- **The entry**, the program to start, is guessed as the largest `.exe` that is not a setup or a
  launcher. If the guess is wrong, set `"entry"` in `bundles/mygame/manifest.json` (a path inside
  the bundle, e.g. `"Bin\\Game.exe"`) and delete `bundles/mygame/entry` if it exists.
- **From an installer** rather than an installed folder:
  [`@bottlify/installer`](../installer/README.md) runs the setup inside the engine and makes the
  bottle from what it installed.
- Other bottle commands: `node tools/make-btl.mjs verify mygame`, `list mygame [pattern]`,
  `extract mygame [file]`.

## Serving a bottle

A page needs three things served from one origin:

| Path | What | From |
| --- | --- | --- |
| `/bottlify/` | the engine: `core.js` and its `core-*.js` chunks, its workers, `worklet.js`, `cork/`, `vendor/` | `modules/core/dist` after `npm run build` |
| `/bundles/<id>/bundle.btl`, `manifest.json` | the bottle, read a block at a time | `make-btl pack` |
| `/bundles/<id>/entry` | the program's image, which `createApp` takes as bytes | `node tools/make-btl.mjs extract <id>` |

Serve `bundle.btl` with **HTTP Range** support (`206 Partial Content`): the engine never downloads
a game whole, it reads the blocks the program asks for and keeps them in OPFS. nginx, Caddy,
Apache, `npx http-server` and most CDNs do this; Python's `http.server` does not.

The whole player page is [`tools/play/index.html`](../../tools/play/index.html): beyond the
smallest page it plays sound, which is why it starts on a click, and mounts a bottle made by the
installer where its setup put it.

`node tools/play.mjs <id> [--port 8080] [--compatible]` is a local server for exactly this layout,
with Range and the isolation headers (`--compatible` leaves them off). For a measurement the player
page takes two more settings from its address: `&executors=3` runs the program's threads on three
executors at once (`createApp`'s `executors`), and `&cork={"checkReads":true}` sets the
translator's settings (`EngineConfig`).

## Install as a package

```sh
npm install @bottlify/core      # or: npm install <checkout>/modules/core
```

```js
import { createApp } from '@bottlify/core';
```

`createApp` finds its workers, `cork/` and `vendor/` beside `core.js`; for a bundler that moves
files, pass `workerUrl` and `cork: { moduleUrl }`. The page itself loads only the side that talks
to the engine's worker: the engine is in `core-*.js` chunks beside `core.js`, loaded only for
`host: 'thread'` or `assembleModules`, so they must be served with it but cost a page nothing
otherwise. `cork/` is the build of the `@bottlify/cork`
version the package depends on, installed with it. Another cork named by `moduleUrl` must implement
the same engine contract (its `contract` export); one that does not is refused at start. The FFmpeg video decoder is a subpath,
`@bottlify/core/video-decoder.wasm`, passed as `media: { wasmBytes }`; without it a program is told
no clip can be played. Every option, the controller and the events:
[`docs/core/api.md`](api.md).

### Without cork: v86

```js
const app = await createApp({ executable, engine: 'emulator',
    v86: { moduleUrl: '/v86/libv86.mjs', wasmBytes: await (await fetch('/v86/v86.wasm')).arrayBuffer() } });
```

The package carries no v86; `engine: 'emulator'` without a build is refused.

### In Node

The same `createApp` runs headless in Node, with no canvas and the engine on the calling thread.
The tests run programs this way, and it suits console programs and installers:

```js
import { readFile } from 'node:fs/promises';
import { createApp } from '@bottlify/core';

const app = await createApp({ executable: new Uint8Array(await readFile('tool.exe')) });
app.on('output', ({ text })=>process.stdout.write(text));
console.log('exit code', await app.run());
await app.dispose();
```

## What is in the package

| Export | What it is |
| --- | --- |
| `@bottlify/core` | `createApp`, `assembleModules` (the layers without a program), `createLogReader` |
| `@bottlify/core/bundle`, `/bundle/node` | the `.btl` format's constants; reading and writing bundles in Node |
| `@bottlify/core/iso` | reading ISO 9660 disc images |
| `@bottlify/core/worklet.js` | the sound output's `AudioWorklet` |

## Which mode

`createApp({ mode })` sets how much of the engine uses shared memory, and so what the page must
allow.

| Mode | Choose it when | What it gives | What it costs |
| --- | --- | --- | --- |
| `isolated` | The page can be cross-origin isolated: your origin serves the player and everything it loads, and nothing on it comes from a site that does not opt in | Guest memory is shared with the workers beside the engine: the graphics worker reads what a program unlocked straight from it, not from a copy per unlock, and sound plays from shared memory | An iframe, image or script from another origin loads only if it sends `Cross-Origin-Resource-Policy` or CORS headers, and a sign-in pop-up from another origin cannot reach the page through `window.opener` |
| `compatible` | The page cannot be isolated (it sits in another site's iframe, or next to third-party content or sign-in pop-ups), or the program draws little and gains nothing from sharing: an installer, a console tool such as SteamCMD | Runs on any page | Everything that crosses to another thread is copied. Sound is mixed on the engine's thread, posted to the worklet, and lags further behind the picture ([limits.md](limits.md)) |
| `auto` | The default: you want what the page allows | `isolated` on an isolated page, `compatible` elsewhere | |

`createApp` refuses `isolated` on a page that cannot share memory rather than run in another mode.
The network works in every mode: the relay is a WebSocket to the page's own origin, which isolation
does not affect.

`createApp({ concurrency })` sets how many processes run at once. A child runs beside its parent
from `CreateProcess` on, so a launcher keeps running beside the program it starts. With `1` (the
default) the two take turns on one thread; with `2` or `4` every process, the program included,
runs in its own worker. That needs shared memory: without it the
run starts `compatible` with one process at a time and sends a `fallback` event. The full rules are
under `concurrency` in [api.md](api.md).

## Sound

Sound is mixed on the browser's audio thread. `openSpeaker` opens the page's side of it -- the
audio context and the package's worklet -- and must be called inside the click or touch that starts
the run, before anything is awaited: a phone's browser starts sound in that handler and nowhere
else.

```js
import { createApp, openSpeaker } from '@bottlify/core';

button.onclick = async()=>{
    const speaker = openSpeaker();                // first, inside the gesture
    const { running, reason } = await speaker.ready();
    const app = await createApp({ ...options, audio: running ? speaker.audioOptions() : undefined });
    if (running) speaker.connect(app);
    else await speaker.close();                   // and say why: `reason`
};
```

The speaker sets the page's audio session to playback, so a phone's silent switch does not mute the
game; resumes a context the browser stopped on its own (a call, the app in the background) as soon
as it may, and at the person's next gesture; and finds the worklet beside itself in the package
(`openSpeaker({ worklet })` names another URL). With cross-origin isolation the worklet reads a
track table the engine writes into shared memory; without it, `audioOptions()` carries the port the
engine posts its mix down. `speaker.volume(level)` turns what is heard down without the program
knowing, `suspend()` and `resume()` hold it with a paused run, and `close()` ends it.

## What `createApp` returns

A controller: `run`, `pause`, `resume`, `stop`, `dispose`, events through `on`, and `input`,
`audio`, `files`, `session`, `log` and `diagnostics`. [api.md](api.md) lists every option and
method.

## Documents

- [api.md](api.md): `createApp`'s options, the controller, the events.
- [configuration.md](configuration.md): the module contract and each layer's configuration.
- [limits.md](limits.md): what is missing, and where the engine differs from Windows.
- [../architecture.md](../architecture.md): how it works inside: threads, startup, cork, how a
  DLL is made, graphics, sound, network, storage.
