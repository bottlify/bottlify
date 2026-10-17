# @bottlify/core

`@bottlify/core` runs a 32-bit Windows program in a browser tab. cork translates the program's x86
code to WebAssembly; the engine's layers answer its system calls (`kernel32`, `user32`, DirectX,
DirectSound, Winsock and the rest) on top of WebGPU, Web Audio, OPFS and WebSocket. The program
gets a `C:` drive, a registry, windows and messages, and runs unchanged.

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

The engine runs in a worker of its own and takes the canvas over (`transferControlToOffscreen`).
The page needs:

- **WebGPU** for any picture: https, or `localhost`.
- **Cross-origin isolation** (`Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Embedder-Policy: require-corp`) for `SharedArrayBuffer`, which the `isolated` mode
  runs on. Without it the engine runs `compatible`: the log is read by asking the engine instead
  of from shared memory, guest memory is the engine's alone, and sound is mixed on the engine's
  thread and posted to the worklet.
- **`Document-Policy: js-profiling`** on the page and on every worker script, only for
  `sampleJs`: the browser grants its JavaScript sampler to a document or worker served with it.
  Without it the `js` diagnostics table says the sampler was refused; nothing else changes.

## Which mode, and why

`createApp({ mode })` decides how much of the engine rides on shared memory, and through it what the
page has to allow.

| Mode | Choose it when | What it gives | What it costs |
| --- | --- | --- | --- |
| `isolated` | The page can be cross-origin isolated: your own origin serves the player and everything it loads, and nothing on it has to come from a site that does not opt in | The guest's memory is shared with the workers beside the engine: the graphics worker reads what a program unlocked straight out of it rather than from a copy made per unlock, and sound plays from shared memory | The page is isolated: an iframe, image or script from another origin loads only if it sends `Cross-Origin-Resource-Policy` or CORS headers, and a sign-in pop-up from another origin cannot reach back to the page through `window.opener` |
| `compatible` | The page cannot be isolated (the player sits in another site's iframe, or next to third-party content or sign-in pop-ups), or the program draws little and gains nothing from sharing: an installer, a console tool such as SteamCMD | Runs on any page | What crosses to another thread is copied, sound included: it is mixed on the engine's thread and posted to the worklet, and lags further behind the picture (see [limits.md](limits.md)) |
| `auto` | You want what the page allows: the default | `isolated` on an isolated page, `compatible` elsewhere | |

The network does not depend on the mode: the relay is a WebSocket to the page's own origin, which
isolation does not touch. `isolated` on a page that cannot share memory is refused by `createApp`
rather than run as something else.

`createApp({ concurrency })` is how many processes run at once. With 1, the default, the program
runs on the engine's thread, and a child runs in its parent's place until it exits. With 2 or 4,
every process runs in a worker of its own, the program too, and a child runs beside its parent
from `CreateProcess` on: a launcher and the game it starts both keep running, and the engine's
thread keeps only what the processes share. This needs shared memory, so the run is `isolated`;
asked for in `compatible` mode or on a page that cannot share memory, the run starts `compatible`
with one process at a time and says so with a `fallback` event. With more than one process, the
engine also reads the page's input between two turns of the program and sleeps on shared memory
when idle, instead of giving its thread back to the browser to look for input.

## Sound

Sound is mixed on the browser's audio thread from a table the engine writes into shared memory:

```js
const audio = new AudioContext();
await audio.audioWorklet.addModule(workletUrl);   // the package's worklet.js, served by your page
const app = await createApp({ ...options, audio: { drained: true, sampleRate: audio.sampleRate } });
const { channels } = app.audio.format();
const node = new AudioWorkletNode(audio, 'bottlify-output', {
    outputChannelCount: [channels],
    processorOptions: { table: app.audio.memory().table, channels },
});
node.connect(audio.destination);
```

On a page that is not cross-origin isolated there is no table to share. The engine mixes on its own
thread and posts the mix down a channel the page makes, one end to the engine, the other to the
worklet:

```js
const sound = new MessageChannel();
const app = await createApp({ ...options,
    audio: { drained: true, sampleRate: audio.sampleRate, port: sound.port2 } });
const node = new AudioWorkletNode(audio, 'bottlify-output', {
    outputChannelCount: [2], processorOptions: { channels: 2 },
});
node.port.postMessage({ type: 'feed', port: sound.port1 }, [sound.port1]);
node.connect(audio.destination);
```

## What `createApp` returns

A controller: `run`, `pause`, `resume`, `stop`, `dispose`, events through `on`, and `input`,
`audio`, `files`, `session`, `log` and `diagnostics`. Every option and method is in
[api.md](api.md).

## Documents

- [api.md](api.md): `createApp`'s options, the controller, the events.
- [configuration.md](configuration.md): the module contract and each layer's configuration.
- [limits.md](limits.md): what is not there, and where the engine differs from Windows.
- [../architecture.md](../architecture.md): how it works inside: threads, startup, cork, how a
  DLL is made, graphics, sound, network, storage.
