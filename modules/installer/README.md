# `@bottlify/installer`

Makes a bottle out of a program's installer when all you have is `Setup.exe` or a disc image. The
setup runs unchanged inside [`@bottlify/core`](https://www.npmjs.com/package/@bottlify/core), with
its own wizard; what it installs becomes the bottle. Part of
[Bottlify](https://github.com/bottlify/bottlify).

## Install

```sh
npm install @bottlify/installer @bottlify/core
```

## Use

```js
import { createApp } from '@bottlify/core';
import { prefixOptions, collectFrom, publish } from '@bottlify/installer';

const media = { name: 'Setup.exe', bytes: new Uint8Array(await file.arrayBuffer()) };
const { executable, imagePath, storage } = prefixOptions(media);   // the setup in C:\Install
const app = await createApp({ canvas, executable, imagePath,
    storage: { files: await storage.load() }, collectOnExit: true });
app.input.attach(canvas);
await app.run();                                // the person clicks through the wizard
const prefix = collectFrom(app, media);         // the installed tree, registry, system32 additions
await publish({ prefix, id: 'mygame', endpoint: { url: '', token } });   // to a bottle server
```

`discOptions(media)` does the same for a disc image, and `silentOptions(media)` runs a known setup
unattended. The bottle server is `@bottlify/installer/server`.

## Documentation

[Installing from a terminal or a browser, how it works, the bottle server](https://github.com/bottlify/bottlify/blob/main/docs/installer/README.md)

MPL-2.0.
