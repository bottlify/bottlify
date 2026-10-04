# @bottlify/core

`@bottlify/core` runs a 32-bit Windows program in a browser tab. cork translates the program's x86
code to WebAssembly; the engine's layers answer its system calls — `kernel32`, `user32`, DirectX,
DirectSound, Winsock and the rest — on top of WebGPU, Web Audio, OPFS and WebSocket. The program
gets a `C:` drive, a registry, windows and messages, and runs unchanged.

## The smallest page

```js
import { createApp } from '@bottlify/core';

const canvas = document.querySelector('canvas');
// The program's PE image: here the server reads the bundle's entry for us.
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
  `Cross-Origin-Embedder-Policy: require-corp`) for `SharedArrayBuffer`. Sound needs it; without
  it the log is read by asking the engine instead of from shared memory, and guest memory is
  the engine's alone rather than shared with the workers beside it.

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

## What `createApp` returns

A controller: `run`, `pause`, `resume`, `stop`, `dispose`, events through `on`, and `input`,
`audio`, `files`, `session`, `log` and `diagnostics`. Every option and method is in
[api.md](api.md).

## Documents

- [api.md](api.md) — `createApp`'s options, the controller, the events.
- [configuration.md](configuration.md) — the module contract and each layer's configuration.
- [limits.md](limits.md) — what is not there, and where the engine differs from Windows.
- [../architecture.md](../architecture.md) — how it works inside: threads, startup, cork, how a
  DLL is made, graphics, sound, network, storage.
