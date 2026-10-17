# `@bottlify/installer`

Make a bottle out of a game's installer. This is for whoever hosts the games, not for the people
who play them. A player opens a page and presses Start; this package is how the bottle behind that
page was made when all you had was `Setup.exe` or a disc image.

The installer runs inside the engine, unchanged: its own wizard, its own dialogs, clicked through
by a person or answered unattended. When it exits, what it wrote (the installed tree, the
registry keys, the runtime DLLs it put in `system32`) is the bottle.

## Three ways to do it

### 1. From a terminal, headless

```sh
node tools/install-watch.mjs Setup.exe --collect-to installed/mygame --shots shots
node tools/make-btl.mjs pack installed/mygame mygame --root="C:\Program Files\Vendor\Game"
node tools/play.mjs mygame
```

`install-watch` runs the setup in Node with no browser, prints every few seconds what each of its
processes is doing and which windows it shows, and with `--shots` saves the screen as PNGs, so you
can see where a wizard waits. A wizard that waits for you is driven by input given in advance:
`--key Enter@40` presses Enter forty seconds in, `--click 320,400@55` clicks a point of the screen.
`--collect` prints a `COLLECT root … entry …` line (the directory the setup installed to and the
program to start) and the files; `--collect-to DIR` also writes that tree out, with the registry
in `.bottlify\registry.json`, for `make-btl`. Give `make-btl pack` the root as `--root` and, if its
guess differs, the entry as `--entry`: the bottle is then mounted where the setup put it, so the
paths it wrote into the registry hold. Its header lists every option
(`--minutes`, `--screen 1024x768`, `--list`, `--cat` a setup's log, `--attended`, …).

A setup that has an unattended mode (Wise, InstallShield, WinZip and WinRAR self-extractors) can
skip the wizard altogether: `silentOptions(media)` below.

### 2. In the browser, with the wizard on screen

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
library. The bottle server listens on 127.0.0.1:8788 by default (`--port`, `--host`); without a
token it refuses to start, because it writes gigabytes to disk for whoever holds one.

### 3. From your own code

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

`endpoint.url` is where the bottle server is, as the page reaches it. The server sends no CORS
headers, so serve it from the page's own origin (a reverse proxy passing `/bottles/` to it, as the
launcher's server does); `url: ''` is that origin.

`discOptions(media)` does the same for a disc image (mounted as `D:`, started from its
`autorun.inf`), and `silentOptions(media)` returns the command line and answer files that run a
known setup unattended, or null when the setup is not one it knows.

## How it works

### A prefix, not a capture step

The engine already has both halves of an overlay: a bundle is read-only and the
writable layer sits on top of it. So an install is a bundle-shaped hole. Mount
nothing beneath, let the program write, and keep the writable layer whole.
This is Wine's model, and it removes the hardest part of the alternative. Nothing has to
diff anything, because by construction everything in that layer is what the
installer produced.

The one thing there before the program runs is the program itself: a distribution
reads its own file (an appended archive, an overlay, a resource), so it has to
be somewhere the guest can open. `prefixOptions` seeds it at `C:\Install\` and
`collect` subtracts it again by path, so it is never mistaken for output.

The registry comes out beside the files and travels as one of them,
`.bottlify\registry.json`, so an unpacked prefix describes itself and the packed
form has nothing the unpacked form lacks. The engine reads it when it mounts the
bottle, beneath whatever registry the bottle's session has saved since: a key the
installer made is there before the program's first instruction, and a value the
program changed afterwards stays changed.

What the installation added to `C:\WINDOWS\system32` comes out too, under
`.bottlify\system32\` (`SYSTEM_PATH`) beside the registry: a setup puts the
runtime its program links against there (the D3DX libraries a DirectX setup
installs), and the program looks for it nowhere else. The engine maps that
directory back to `C:\WINDOWS\system32\` when it mounts the bottle, its files
read a block at a time and copied up on a write like any other file of the
bottle, so the loader finds those libraries by its ordinary search. A file there
named like a library the engine synthesises as Windows' own is not carried,
because mounted back it would be mapped in place of the engine's: `collectFrom`
sorts against the app's `systemLibraries()`, which leaves out the D3DX helpers
the engine's table only stands in for, and the prefix lists what it left out as
`answered`.

The manifest says where the installation put the tree, `root`
(`C:\Program Files\Vendor\Game`), and `placementOf(manifest)` answers where to
mount the bottle and start its program from: there again, so the install path the
registry names, and the working directory a launcher changes to, are the bottle's
own. A bottle without a root on C: (made by hand, or published before the root was
recorded) is mounted at `C:\App`, as any bundle is.

### From a disc image

A disc image (`.iso`, ISO 9660 with Joliet names; told apart by its contents,
never its name: `isDiscImage`) is not unpacked and not seeded. `discOptions(media)`
reads only as much of it as finding its program takes (the descriptors, the
directories, `autorun.inf` and that program) and hands `createApp` the image
itself under `discs`: the engine mounts it as D:, a CD-ROM, read-only, with the
disc's label and serial number, and reads it a range at a time from the file the
person chose.

The program is the disc's own answer, the one AutoPlay reads: `open=` in the
`[autorun]` section of `autorun.inf` at the root, a command line relative to the
root, taken apart the way CreateProcess takes apart an unquoted one (the shortest
run of words that names a file on the disc, `.exe` added to a bare name); then
`shellexecute=` when it names a program rather than a document; then `setup.exe`
at the root. It starts as `D:\<program>` with the arguments the disc gives it, in
the disc's root as AutoPlay starts it (`startDirectory`, `D:\`, which a menu in a
subfolder relies on to find the setup by a relative name), and `entry` names
another program on the disc instead, started where it lives. Anything it starts in turn
(an autorun menu starting the setup) runs on the same machine, with the disc still
in its drive.

Nothing of the disc is ever in what the install produced, so `collectFrom` has
nothing to subtract. `discOptions(media, { silent: true })` reads the unattended
mode off the program and the files beside it, as `silentOptions` does for an
installer: the command line starts the program from the disc, and the answers go
in `C:\Install`.

### Running without the wizard

`silentOptions(media)` is the other way through: the engine's own unattended
mode, when the engine is recognised from the bytes of the entry: the runtime
a Wise stub extracts, the `_winzip_` section of a WinZip self-extractor, the RAR
signature behind a WinRAR SFX, the InstallShield player with its `data1.cab`,
`engine32.cab` and `setup.ini` behind or beside it. It answers with the command
line, the files the engine reads its answers from (a Wise values file, an
InstallShield response file keyed by the product GUID) and the destination,
`C:\App`, which is where a bundle is mounted; the caller seeds the files, runs
with that command line, and reads the volume for progress. Null means the
family is not known and the wizard has to be run.

Two limits are the engines' own. A WinRAR SFX of this generation reads no
destination switch, so the tree lands where the archive's script says and
`destination` is null. A Wise script overrides its destination only where it
marked `MAINDIR` as read from the values file; one that fixes the path in the
script keeps it.

### Two kinds of bottle

A **local** bottle is that prefix. It never leaves the machine, never gets
packed, and is bounded only by the origin's storage quota.

A **shared** bottle is the packed form, and it is what this package uploads.
Packed on the way out rather than after: `pack.js` compresses and blocks the tree
in the browser and hands the bytes straight to the request, so what crosses the
wire is smaller than the installed tree and nothing is written locally at all.

`pack.js` is a second writer for a format `@bottlify/core/bundle/node` already
writes, and the two agree because both take the layout constants and the
checksum from `@bottlify/core/bundle`, which the engine's reader uses too. Two departures, both
forced: deflate only (a browser's `CompressionStream` has no zstd), and no
whole-bundle digest (`crypto.subtle` cannot hash incrementally, so the server
computes that one as the bytes pass through).

## The bottle server's routes

Private from the start. An upload belongs to whoever owns the bottle, and
publishing it is a separate act; a server with no token refuses to start.

Its routes, all authenticated with the token:

- `/bottles/<id>/blocks?at=<offset>`: packed block bytes, in order. A part out
  of order is refused rather than leaving a hole the digest never saw.
- `/bottles/<id>/finish`: the header and the index, which do not exist until the
  last block has been packed and so cannot travel in the stream. The server
  writes them where they belong, computes the block region's digest, and writes
  `manifest.json` beside `bundle.btl`.
- `/bottles/<id>/manifest`: a bottle's settings changed in its `manifest.json`
  without sending it again: `title`, `description`, `source` (a web address
  the bottle's files came from, or nothing), `year` (when the program
  came out), `rightsHolder` (who owns it now), `version`, `labels`
  (`demo`, `benchmark`, `test`), `kind` (`game`, `application`), `windows`,
  `graphics`. Any other field is refused; the entry and the bundle record are
  the upload's.
- `/bottles/<id>/art/cover`, `/bottles/<id>/art/wallpaper`: a picture (PNG,
  JPEG, WebP or GIF, by its `Content-Type`) kept beside the manifest under a
  name taken from its bytes and named there as `./<name>`: `coverLarge` and
  `coverSmall` for the cover, `wallpaper` for the stage. A JPEG cover is kept
  only as two smaller JPEGs, fitted into 800×1200 for the details panel and
  400×600 for the card; a cover in another format is kept as given, in both.
  The one it replaces is removed.
- `DELETE /bottles/<id>`: the bottle removed whole, for everyone: its bundle,
  its manifest and its pictures. Refused while it is still being uploaded.

`publish()`'s own `manifest` option passes straight through to that file, field
for field, so a title's own launch arguments travel with it: `commandLine` is
the arguments the program is started with, appended after the quoted image
path (`docs/core/api.md`'s `commandLine` option), for example
`"commandLine": "+set s_realTimeDecoding 0"`, a setting a program only reads
from its command line, set there instead of by editing the bundle.

`windows` is the Windows the bottle runs under, optional: one of `win2000`,
`winxp`, `win7` and `win10` (`docs/core/api.md`'s `windows` option), and absent
means the engine's default, XP with its third service pack. Whatever starts the
bottle passes it to `createApp`, and the install itself runs under the same one
(`prefixOptions(media, { windows })`), since an installer acts on the Windows it
finds. Any other value is refused by `publish()` before anything is sent, naming
the four, as the engine would refuse it when the bottle first started.

## Limits

A setup runs on the same engine as a game, with the same gaps: one that calls an API the engine
does not have stops there, and `install-watch` shows where. Run a setup headless first; what it
reports is the list of what is missing. `BOTTLIFY_INSTALLER=<a distribution> npm run
test:integration -w @bottlify/installer` runs one as a test and reports how far it got.
