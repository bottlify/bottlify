# `@bottlify/installer`

Adding a title by running its installer, in the browser.

Press Add, choose a distribution, and its own wizard runs — real windows, real
dialogs, clicked through by a person. When the program exits, what is left on the
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
form has nothing the unpacked form lacks. **The engine does not read it back on
mount yet**; writing it is this side of that contract.

## Two kinds of bottle

A **local** bottle is that prefix. It never leaves the machine, never gets
packed, and is bounded only by the origin's storage quota.

A **shared** bottle is the packed form, and it is what this package uploads.
Packed on the way out rather than after: `pack.js` compresses and blocks the tree
in the browser and hands the bytes straight to the request, so what crosses the
wire is smaller than the installed tree and nothing is written locally at all.

`pack.js` is a second writer for a format `tools/btl.mjs` already writes, and the
two agree because both take the layout constants and the checksum from the
reader in `core/src/layers/filesystem/internal/bundle/`. Two departures, both
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
