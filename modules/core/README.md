# `@bottlify/core`

Runs an unchanged 32- or 64-bit Windows program in a browser tab. This package is the Windows the program
sees: the system libraries, DirectX, OpenGL, sound, input and files, written from scratch on
WebGPU, Web Audio and OPFS. Part of [Bottlify](https://github.com/bottlify/bottlify).

## Install

```sh
npm install @bottlify/core
```

## Use

```js
import { createApp } from '@bottlify/core';

const canvas = document.querySelector('canvas');
const executable = new Uint8Array(await (await fetch('/bundles/demo/entry')).arrayBuffer());

const app = await createApp({
    canvas,
    executable,
    imagePath: 'C:\\App\\demo.exe',
    bundle: { url: '/bundles/demo/bundle.btl', id: 'demo' },   // the program's files, read on demand
    storage: 'opfs', id: 'demo',                               // saves and settings, kept per id
});
app.input.attach(canvas);
await app.run();
```

The page needs WebGPU (`https://` or `localhost`) and a server that answers HTTP Range requests for
the bundle. With the headers `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` the engine shares memory with its workers and runs
faster.

## Documentation

- [Getting started, serving a bottle, modes, sound](https://bottlify.app/docs/core/)
- [API](https://bottlify.app/docs/core/api.html),
  [configuration](https://bottlify.app/docs/core/configuration.html),
  [limits](https://bottlify.app/docs/core/limits/)
- [How it works](https://bottlify.app/docs/architecture/)

MPL-2.0; components distributed with it are listed in `THIRD-PARTY-NOTICES.md`.
