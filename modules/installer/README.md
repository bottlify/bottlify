# `@bottlify/installer`

Adding a title by running its installer, in the browser.

Press Add, choose a distribution -- an installer, or a disc image -- and its own
wizard runs — real windows, real dialogs, clicked through by a person. When the program exits, what is left on the
volume is the game, and this package turns that into a bottle.

```
a file the person chose        @bottlify/core                @bottlify/installer
--------------------------     --------------                -------------------
Setup.exe -----------------> prefixOptions() ---> createApp({ storage, imagePath })
                                    |
                             the person clicks through the wizard
                                    |
                             app exits ---------> collectFrom(app, media)
                                                        |
                                                  publish({ prefix, endpoint })
                                                        |  packed here, a part
                                                        v  at a time
                                                  bottle server --> bundle.btl
                                                                    manifest.json
```

## A prefix, not a capture step

The engine already has both halves of an overlay: a bundle is read-only and the
writable layer sits on top of it. So an install is a bundle-shaped hole. Mount
nothing beneath, let the program write, and keep the writable layer whole —
Wine's model, and it deletes the hardest part of the alternative. Nothing has to
diff anything, because by construction everything in that layer is what the
installer produced.

The one thing there before the program runs is the program itself: a distribution
reads its own file — an appended archive, an overlay, a resource — so it has to
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
runtime its program links against there -- the D3DX libraries a DirectX setup
installs -- and the program looks for it nowhere else. The engine maps that
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
own. A bottle without a root on C: -- made by hand, published before the root was
recorded -- is mounted at `C:\App`, as any bundle is.

## From a disc image

A disc image (`.iso`, ISO 9660 with Joliet names; told apart by its contents,
never its name: `isDiscImage`) is not unpacked and not seeded. `discOptions(media)`
reads only as much of it as finding its program takes -- the descriptors, the
directories, `autorun.inf` and that program -- and hands `createApp` the image
itself under `discs`: the engine mounts it as D:, a CD-ROM, read-only, with the
disc's label and serial number, and reads it a range at a time from the file the
person chose.

The program is the disc's own answer, the one AutoPlay reads: `open=` in the
`[autorun]` section of `autorun.inf` at the root, a command line relative to the
root, taken apart the way CreateProcess takes apart an unquoted one (the shortest
run of words that names a file on the disc, `.exe` added to a bare name); then
`shellexecute=` when it names a program rather than a document; then `setup.exe`
at the root. It starts as `D:\<program>` with the arguments the disc gives it, and
`entry` names another program on the disc instead. Anything it starts in turn --
an autorun menu starting the setup -- runs on the same machine, with the disc still
in its drive.

Nothing of the disc is ever in what the install produced, so `collectFrom` has
nothing to subtract. `discOptions(media, { silent: true })` reads the unattended
mode off the program and the files beside it, as `silentOptions` does for an
installer: the command line starts the program from the disc, and the answers go
in `C:\Install`.

## Running without the wizard

`silentOptions(media)` is the other way through: the engine's own unattended
mode, when the engine is recognised from the bytes of the entry -- the runtime
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

## Two kinds of bottle

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

## The server

Private from the start. An upload belongs to whoever owns the bottle, and
publishing it is a separate act; a server with no token refuses to start.

```
BOTTLIFY_UPLOAD_TOKEN=... node src/server/cli.js --root bundles --port 8788
```

Two routes, both `POST` and both authenticated:

- `/bottles/<id>/blocks?at=<offset>` — packed block bytes, in order. A part out
  of order is refused rather than leaving a hole the digest never saw.
- `/bottles/<id>/finish` — the header and the index, which do not exist until the
  last block has been packed and so cannot travel in the stream. The server
  writes them where they belong, computes the block region's digest, and writes
  `manifest.json` beside `bundle.btl`.

`publish()`'s own `manifest` option passes straight through to that file, field
for field, so a title's own launch arguments travel with it: `commandLine` is
the arguments the program is started with, appended after the quoted image
path (`docs/core/host.md`'s `commandLine` option), for example
`"commandLine": "+set s_realTimeDecoding 0"` — a setting a program only reads
from its command line, set there instead of by editing the bundle.

`windows` is the Windows the bottle runs under, optional: one of `win2000`,
`winxp`, `win7` and `win10` (`docs/core/host.md`'s `windows` option), and absent
means the engine's default, XP with its third service pack. Whatever starts the
bottle passes it to `createApp`, and the install itself runs under the same one
(`prefixOptions(media, { windows })`), since an installer acts on the Windows it
finds. Any other value is refused by `publish()` before anything is sent, naming
the four, as the engine would refuse it when the bottle first started.

## Turning it on

Installing is a developer feature and appears nowhere unless the launcher's
configuration says so. `ui/public/config.json`, absent by default:

```json
{
  "allowInstall": true,
  "upload": { "url": "http://127.0.0.1:8788", "token": "the same token" }
}
```

## What works today

**Family C — the publisher's own single-process installer — is the target, and it
does not finish yet.** Run one against the engine and see for yourself:

```
BOTTLIFY_INSTALLER=<a distribution> npm run test:integration -w @bottlify/installer
```

Everything below the wizard is reachable without a browser, so that test runs
headless and reports how far the program got. Anything that extracts a payload
and starts a second program cannot start at all: `CreateProcess` refuses,
deliberately, and nothing here pretends otherwise.
