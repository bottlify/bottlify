# `@bottlify/installer`

Make a bottle from a game's installer when all you have is `Setup.exe` or a disc image. This
package is for whoever hosts the games; a player only opens the page and presses Start.

The installer runs inside the engine, unchanged: its own wizard and dialogs, clicked through by a
person or answered unattended. When it exits, what it wrote (the installed tree, the registry
keys, the runtime DLLs it put in `system32`) is the bottle.

## Three ways to do it

### From a terminal, headless

```sh
node tools/install-watch.mjs Setup.exe --collect-to installed/mygame --shots shots
node tools/make-btl.mjs pack installed/mygame mygame --root="C:\Program Files\Vendor\Game"
node tools/play.mjs mygame
```

`install-watch` runs the setup in Node with no browser. Every few seconds it prints what each of
the setup's processes is doing and which windows it shows; with `--shots` it saves the screen as
PNGs, so you can see where a wizard waits. Input given in advance drives a wizard that waits for
you: `--key Enter@40` presses Enter forty seconds in, `--click 320,400@55` clicks a point of the
screen. `--collect` prints a `COLLECT root … entry …` line (the directory the setup installed to
and the program to start) and the files; `--collect-to DIR` also writes that tree out, with the
registry in `.bottlify\registry.json`, for `make-btl`. Pass the root to `make-btl pack` as
`--root` and, if its guess differs, the entry as `--entry`: the bottle is then mounted where the
setup put it, so the paths the setup wrote into the registry hold. The script's header lists every
option (`--minutes`, `--screen 1024x768`, `--list`, `--cat` a setup's log, `--attended`, …).

A setup with an unattended mode (Wise, InstallShield, WinZip and WinRAR self-extractors) can skip
the wizard altogether: see `silentOptions(media)` below.

### In the browser, with the wizard on screen

The launcher ([bottlify-ui](https://github.com/bottlify/bottlify-ui)) has an Add button for this,
shown only where its configuration allows installing. A browser cannot be handed a file from a
terminal, so the person picks the setup in the page:

```sh
# the bottle server, which receives what the page packs
BOTTLIFY_UPLOAD_TOKEN=some-secret npm run bottles -w @bottlify/installer -- --root ../../bundles
# the launcher, beside this checkout, with public/config.json saying
#   { "allowInstall": true, "upload": { "token": "some-secret" } }
npm run ui
```

Open the launcher, press Add, choose `Setup.exe` or an `.iso`. The setup's own wizard runs in the
page; when it exits, the page packs what it installed and uploads it, and the bottle appears in the
library. The bottle server listens on 127.0.0.1:8788 by default (`--port`, `--host`). Without a
token it refuses to start, because it writes gigabytes to disk for whoever holds one.

### From your own code

```js
import { createApp } from '@bottlify/core';
import { prefixOptions, collectFrom, publish } from '@bottlify/installer';

const media = { name: 'Setup.exe', bytes: new Uint8Array(await file.arrayBuffer()) };
const { executable, imagePath, storage } = prefixOptions(media);   // the setup in C:\Install
const app = await createApp({ canvas, executable, imagePath,
    storage: { files: await storage.load() },   // an empty C: with the setup on it
    collectOnExit: true });                     // keep what it writes for collectFrom
app.input.attach(canvas);
await app.run();                                // the person clicks through the wizard
const prefix = collectFrom(app, media);         // the installed tree, registry, system32 additions
await publish({ prefix, id: 'mygame', endpoint: { url: '', token } });   // POST /bottles/mygame/…
```

`endpoint.url` is the bottle server's address as the page reaches it. The server sends no CORS
headers, so serve it from the page's own origin (a reverse proxy passing `/bottles/` to it, as the
launcher's server does); `url: ''` means that origin.

`discOptions(media)` does the same for a disc image (mounted as `D:`, started from its
`autorun.inf`), and `silentOptions(media)` returns the command line and answer files that run a
known setup unattended, or null for a setup it does not know.

## Limits

A setup runs on the same engine as a game, with the same gaps: one that calls an API the engine
lacks stops there, and `install-watch` shows where. Run a setup headless first; what it reports is
the list of what is missing. `BOTTLIFY_INSTALLER=<a distribution> npm run
test:integration -w @bottlify/installer` runs one as a test and reports how far it got.
