# How the installer works

## A prefix, not a capture step

The engine's volume is already an overlay: a read-only bundle with a writable layer on top. An
install mounts nothing beneath, lets the program write, and keeps the writable layer whole. This
is Wine's model. Nothing has to be diffed, because by construction everything in that layer is
what the installer produced.

The one thing present before the program runs is the program itself: a distribution reads its own
file (an appended archive, an overlay, a resource), so the guest must be able to open it.
`prefixOptions` seeds it at `C:\Install\`, and `collect` subtracts it again by path, so it is
never mistaken for output.

The registry comes out beside the files as one of them, `.bottlify\registry.json`, so an unpacked
prefix describes itself and the packed form has nothing the unpacked form lacks. The engine reads
it when it mounts the bottle, beneath whatever registry the bottle's session has saved since: a
key the installer made is there before the program's first instruction, and a value the program
changed afterwards stays changed.

What the installation added to `C:\WINDOWS\system32` comes out too, under `.bottlify\system32\`
(`SYSTEM_PATH`) beside the registry: a setup puts there the runtime its program links against
(the D3DX libraries a DirectX setup installs), and the program looks for it nowhere else. When the
engine mounts the bottle it maps that directory back to `C:\WINDOWS\system32\`, its files read a
block at a time and copied up on a write like any other file of the bottle, so the loader finds
those libraries by its ordinary search. A file there named like a library the engine synthesises
as Windows' own is not carried, because mounted back it would be mapped in place of the engine's:
`collectFrom` sorts against the app's `systemLibraries()`, which leaves out the D3DX helpers the
engine's table only stands in for, and the prefix lists what it left out as `answered`.

The manifest records where the installation put the tree, `root`
(`C:\Program Files\Vendor\Game`), and `placementOf(manifest)` says where to mount the bottle and
start its program: there again, so the install path the registry names, and the working directory
a launcher changes to, are the bottle's own. A bottle without a root on C: (made by hand, or
published before the root was recorded) is mounted at `C:\App`, as any bundle is.

## From a disc image

A disc image (`.iso`, ISO 9660 with Joliet names, recognised by its contents, never its name:
`isDiscImage`) is neither unpacked nor seeded. `discOptions(media)` reads only what finding its
program takes (the descriptors, the directories, `autorun.inf` and that program) and hands
`createApp` the image itself under `discs`: the engine mounts it as D:, a read-only CD-ROM with
the disc's label and serial number, and reads it a range at a time from the file the person chose.

The program is the disc's own answer, the one AutoPlay reads: `open=` in the `[autorun]` section
of `autorun.inf` at the root, a command line relative to the root, split the way CreateProcess
splits an unquoted one (the shortest run of words that names a file on the disc, `.exe` added to a
bare name); then `shellexecute=` when it names a program rather than a document; then `setup.exe`
at the root. It starts as `D:\<program>` with the disc's arguments, in the disc's root as AutoPlay
starts it (`startDirectory`, `D:\`, which a menu in a subfolder relies on to find the setup by a
relative name). `entry` names another program on the disc instead, started where it lives.
Whatever it starts in turn (an autorun menu starting the setup) runs on the same machine, with the
disc still in its drive.

Nothing of the disc ends up in what the install produced, so `collectFrom` has nothing to
subtract. `discOptions(media, { silent: true })` reads the unattended mode off the program and the
files beside it, as `silentOptions` does for an installer: the command line starts the program
from the disc, and the answers go in `C:\Install`.

## Running without the wizard

`silentOptions(media)` uses the setup engine's own unattended mode, when it recognises the setup
engine from the entry's bytes: the runtime a Wise stub extracts, the `_winzip_` section of a WinZip
self-extractor, the RAR signature behind a WinRAR SFX, the InstallShield player with its
`data1.cab`, `engine32.cab` and `setup.ini` behind or beside it. It answers with the command line,
the files the setup engine reads its answers from (a Wise values file, an InstallShield response
file keyed by the product GUID) and the destination, `C:\App`, where a bundle is mounted. The
caller seeds the files, runs with that command line, and reads the volume for progress. Null means
the family is unknown and the wizard has to run.

Two limits belong to the setup engines. A WinRAR SFX of this generation reads no destination
switch, so the tree lands where the archive's script says and `destination` is null. A Wise script
overrides its destination only where it marked `MAINDIR` as read from the values file; one that
fixes the path in the script keeps it.

## Two kinds of bottle

A **local** bottle is that prefix. It never leaves the machine, is never packed, and is bounded
only by the origin's storage quota.

A **shared** bottle is the packed form, which this package uploads. It is packed on the way out:
`pack.js` compresses and blocks the tree in the browser and hands the bytes straight to the
request, so what crosses the wire is smaller than the installed tree and nothing is written
locally.

`pack.js` is a second writer of the format `@bottlify/core/bundle/node` writes; the two agree
because both take the layout constants and the checksum from `@bottlify/core/bundle`, which the
engine's reader uses too. It departs in two ways, both forced: deflate only (a browser's
`CompressionStream` has no zstd), and no whole-bundle digest (`crypto.subtle` cannot hash
incrementally, so the server computes that one as the bytes pass through).
