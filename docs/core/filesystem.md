# `filesystem` — the volume a Win32 program sees

Source: `modules/core/src/layers/filesystem/`. Module contract and host machinery:
[`system.md`](./system.md), [`host.md`](./host.md); layer index: [`README.md`](./README.md). The
Win32 file API built on top of this layer is described in [`win32.md`](./win32.md).

## 1. Purpose

`filesystem` is the volume: drive letters, Windows path rules, a read-only source under a writable
layer (copy-on-write), open files with positions and sharing, the bundle reader that turns a
`.btl` container into that read-only source, and the disc reader that turns an ISO 9660 image into
a read-only drive of its own. It reports failures by name and hands back handle
objects rather than numbers.

It is not the Win32 file API. Which error number `CreateFile` answers with, what a `HANDLE` is
worth, and how a read that cannot be served yet parks a guest thread are decisions of the caller
implementing that API (`src/layers/win32/kernel32/vfs.js`). Nothing here reaches for a browser API
on its own: the stores are injected, and the one browser-backed store in the tree (OPFS) is used
only where the assembler hands it in. It requires `log`.

## 2. Contract

| field      | value |
|------------|-------|
| `name`     | `filesystem` |
| `version`  | `0.1.0` |
| `requires` | `['log']` |

### Configuration (`src/layers/filesystem/api.js`, `src/layers/filesystem/module.js`)

| option          | type                                                        | default                      | meaning |
|-----------------|-------------------------------------------------------------|------------------------------|---------|
| `drives`        | `{ [letter]: { source?: SourceStore \| null, system?: SourceStore \| null, writable?: WritableStore } }` | `{}` → `C:` on an in-memory writable store | Volumes to mount. A missing `writable` is an in-memory store; a missing `source` is a drive with no bundle; a missing `system` is a drive with no engine volume. |
| `system`        | `SourceStore \| null`                                       | `null`                       | The engine's own read-only layer, mounted beneath every bundle. `source` wins where both name a path, and a write to a file only `system` holds is `ACCESS_DENIED`. Per-mount `system` overrides it. |
| `openFileLimit` | `number`                                                    | `4096`                       | Most files open at once. |
| `onChanged`     | `(changes: { path, kind }[]) => void`                       | none                         | Told, once per file and after the writes settle, that the writable layer changed. |

The store contracts are in `src/layers/filesystem/internal/memory-store.js`: a `SourceStore` is
`{ list(), stat(path), read(path, offset, length) }`, and a `WritableStore` adds `write`,
`truncate`, `remove`, `mkdir`. Store paths are backslash-separated and relative to the mount root; a
store folds no case and invents no directories — every Windows rule lives one level up.

### Provided API

| method | one line |
|--------|----------|
| `ErrorCode`, `Disposition`, `SeekFrom` | The vocabularies (below). |
| `mount(letter, { source?, system?, writable?, readOnly?, volume? })` | Mount or replace a drive. `letter` must be a single letter. `readOnly: true` is read-only media, a disc: every write, create and delete on the drive is `WRITE_PROTECTED`, and its writable layer is an empty one of its own. `volume` is what the drive says of itself -- for a disc `{ kind: 'cdrom', label, serial, size, unicode }` -- kept as given for `volume()`. |
| `drives() → string[]` | Mounted letters, in mount order. |
| `volume(letter)` | `{ readOnly, ...volume }` as the drive was mounted, or `null` for a letter nothing is mounted under. |
| `resolve(path)` | `{ drive, components, device, wildcard, path }` without touching the volume — how a caller learns a path names a device before opening it. |
| `currentDirectory() → string` | The current directory as a full path. |
| `setCurrentDirectory(path)` | Move it; refuses a path that is not an existing directory. |
| `stat(path)` | `{ name, path, directory, size, modified, hidden, readOnly }` or `null`. `readOnly` is the drive's; `hidden` and `modified` are the source's where it records them (a disc does), the overlay's otherwise. |
| `list(path, pattern?)` | Entries of a directory, filtered by a wildcard; a trailing wildcard component of `path` is taken as the pattern when none is given. |
| `createDirectory(path) → boolean` | `true` when created, `false` when it was already there. |
| `removeDirectory(path)` / `deleteFile(path)` | Remove; a directory must be empty. |
| `rename(from, to)` | Copy then delete, chunked, so a file from the read-only source can be moved. |
| `open(path, { read?, write?, shareRead?, shareWrite?, disposition? })` | A handle object. Defaults: read `true`, write `false`, share read `true`, share write `false`, `OPEN_EXISTING`. |
| `read(handle, length) → Uint8Array` / `write(handle, bytes) → number` | At the handle's position, which moves. |
| `seek(handle, offset, from?)` / `position(handle)` / `size(handle)` | Position and size; a seek may land past the end. |
| `setEndOfFile(handle)` | Cut or extend the file at the position. |
| `close(handle)` | Release it. |
| `openFiles()` | Every open handle, for diagnostics and `apply`. |
| `onChanged(handler)` | Replace the change listener. |
| `apply(batch) → number` | Put files in from outside: `{ path, bytes?, delete? }[]`, through the overlay; refused whole if any named file is open. |
| `export(letter?) → { path, bytes }[]` | Everything the writable layer holds — what a session is made of. The source is never in it. |

An instance owns its volume. `create()` may run more than once in the same realm (a process
replacement runs it again; the plan for two machines in one worker needs two at once), so the
drives, the open files and the current directory live in the instance the api closes over, and a
second `create()` cannot take the first one's volume; `diagnostics()` answers for its own graph's
instance. After `dispose()`, a call that was in flight answers the way it would for a file
that is not there rather than dereferencing what disposal took away: `stat()` and `open()` answer
`null`, `list()`/`drives()`/`openFiles()`/`export()` answer empty, `currentDirectory()` and
`resolve()` answer an empty path, the handle calls (`read()` an empty buffer, `write()` and the
position and size calls zero) and the mutating calls are no-ops, and nothing throws.

`ErrorCode` (`src/layers/filesystem/internal/errors.js`): `INVALID_PATH`, `INVALID_PARAMETER`,
`NO_SUCH_DRIVE`, `NOT_FOUND`, `PATH_NOT_FOUND`, `ALREADY_EXISTS`, `NOT_A_DIRECTORY`,
`IS_A_DIRECTORY`, `DIRECTORY_NOT_EMPTY`, `ACCESS_DENIED`, `WRITE_PROTECTED`, `SHARING_VIOLATION`,
`IS_DEVICE`, `INVALID_HANDLE`. `NOT_FOUND` and `PATH_NOT_FOUND` are told apart because Win32 tells them apart.
Every failure is an `Error` with a `code` from this set. `Disposition` is `CREATE_NEW`,
`CREATE_ALWAYS`, `OPEN_EXISTING`, `OPEN_ALWAYS`, `TRUNCATE_EXISTING`; `SeekFrom` is `BEGIN`,
`CURRENT`, `END`.

### `diagnostics()` metrics

| field | what it is |
|-------|------------|
| `volumes["C:"].files` / `.directories` | Nodes indexed in the overlay tree. |
| `volumes["C:"].tombstones` | Source entries deleted by the program and hidden. |
| `volumes["C:"].copied` | Files present in both layers — copied up on first write. |
| `volumes["C:"].layered` | Whether the drive has a source. |
| `volumes["D:"].readOnly` / `.kind` / `.label` | Present for read-only media: `true`, and for a disc `'cdrom'` and its label. |
| `handles.open` / `.opened` / `.closed` | Open handles now, and totals. |
| `handles.byPath` | Up to forty paths, ordered by bytes read, as `"n opens, m bytes"` — which files a run actually spent its reads on. |
| `current` | The current directory as a full path. |

## 3. How it works

### Paths (`src/layers/filesystem/internal/paths.js`)

- Both `\` and `/` separate; the canonical separator is `\`. `formatPath` renders `C:\` for a root
  and `C:\Game\Data` otherwise.
- Names fold with the invariant lower-case mapping (`foldName`), never the locale. Lookup is
  case-insensitive; enumeration reports the spelling a name was created with.
- Trailing dots and spaces are stripped from a component before lookup, as Win32 does, so
  `"file.txt "` finds `file.txt`. A component containing `< > : " |` or a control character is
  `INVALID_PATH`. `*` and `?` are legal in a pattern and refused by anything that opens a file.
- `.` and `..` survive parsing and are applied by `normalise`; `..` at a root stays at the root.
- Reserved device names (`CON PRN AUX NUL COM1–9 LPT1–9`, with or without an extension or a
  trailing colon) are devices in every directory: `C:\Game\nul` is the null device. `resolve`
  reports the device; every call that would touch the volume fails with `IS_DEVICE` carrying the
  device's name.
- UNC paths and the `\\?\` namespaces are refused (`INVALID_PATH`) rather than half-supported.
- The current directory is kept the way Win32 keeps it: one current drive plus a directory
  remembered per drive visited, so `C:data` and `D:data` are two files. The process starts at the
  root of the first drive mounted.
- `matchName` implements enumeration's wildcard rules rather than shell globbing: `*.` matches only
  names without an extension, `*.*` matches `readme`, and `?` may match nothing at the end of a name
  or before its last dot.

### The overlay (`src/layers/filesystem/internal/tree.js`)

Two read-only layers, a bundle `source` and the engine's `system` volume, and one writable layer
are indexed into a single tree of nodes at mount (`SourceStore.list()` is called once and never
again — a source that changes behind the overlay's back is out of contract). Three rules do the
work: a lookup finds the writable layer first, then the bundle, then the system volume; the first
write to a bundle-only file copies it up (`copyUp`), so the bundle is never modified; deleting
something that came from the bundle leaves a **tombstone**, because the bundle would otherwise hand
it back on the next enumeration. The system volume is genuinely read-only: a write, truncate,
create or delete aimed at a file only it holds is `ACCESS_DENIED`, the way a system directory is
refused to a program that is not an administrator, and nothing is copied up on the way. A file in
both the bundle and the system volume is the bundle's, by bytes and by spelling. Creating a
directory over a read-only directory joins it rather than hiding what it put there; a directory is
refused for removal while anything — including source-only content — is still in it. A node is the
single answer to "does this exist, in which layer, under what spelling".

### Open files (`src/layers/filesystem/internal/handles.js`)

A handle carries an intent, a position and nothing else; the bytes live in the overlay, so two
handles on one file see each other's writes immediately. Sharing is checked in both directions,
as Win32 does: a second open is refused when its access is not covered by what the first shared,
*and* when its sharing does not cover what the first already took. A write past the end extends the
file with zeroes. The table hands back objects; the win32 layer gives them numbers.

### Bundles as the read-only source

`src/bundle-node.js` (published as `@bottlify/core/bundle/node`, and what `tools/btl.mjs` re-exports)
writes the `.btl` container on a host; `src/layers/filesystem/internal/bundle/` reads it in the
engine; `src/bundle.js` (`@bottlify/core/bundle`) publishes the constants and checksum both share.

- **Format** (`format.js`): a 0x28-byte header — magic `BTL1`, format version (1 or 2 readable),
  block size, index offset/length/codec — then blocks back to back, then a deflated JSON index
  listing files (`path, size, firstBlock, blocks, sha256`), blocks (`offset, packed, codec, crc`
  from version 2) and recorded empty directories. Blocks are numbered across the container; a file
  is a run of them. The writer's default block size is 256 KiB (`DEFAULT_BLOCK_SIZE = 1 << 18`).
  Each block is stored with its own codec — `STORED` (0), `DEFLATE_RAW` (1) or `ZSTD` (2) — chosen
  per block by the writer. `openBundle(fetchRange, decode, { verifyIndex })` reads only the header
  and index, checks them against each other, and answers `rangesFor(file, offset, length)`: the
  blocks a read touches and which bytes of each.
- **Translations** (optional): the index may name one more run of blocks, `translations: { size,
  firstBlock, blocks, sha256 }` -- a translation seed, what the translator made of the bundle's
  code on one machine (`docs/core/cpu.md`, the translation cache). It is not a file of the volume,
  its blocks come after every file's, and the bundle's digest (`sha256` in the writer's summary)
  stays that of the game's blocks alone. A reader that does not know the entry skips it, and a
  bundle without it reads as before; the format version is unchanged. `writeBundle({
  translations })` packs one, and `attachTranslations(path, seed)` puts one into a bundle already
  written -- where the index was, or over the seed it replaces, with a new index after it, the
  game's blocks untouched -- or takes it out (`null`); the index's digest changes with it, so the
  manifest's `indexSha256` must be written again. `verifyBundle` checks the seed's digest too and
  names it `<translations>` when it is damaged. Under a translating engine `mountBundle` fetches
  the seed's blocks in one request, each checked against its CRC-32 as a read's are, and hands them
  to the translation store before the program's first instruction, unless that store has taken this
  seed already (it keeps the seed's digest); the background fill leaves those blocks out, and an
  `emulator` launch never fetches them. The event `bundle-translations` says what the store took.
- **Source** (`source.js`): `createBundleSource({ bundle, readBlock, decode, cacheBlocks = 16,
  prefix })` is a `SourceStore`. A guest read is synchronous, so `read` serves only blocks already
  resident: it asks `readBlock(index, offset, packed)` for the stored bytes, decodes them, keeps the
  last sixteen decoded blocks in an LRU, and if any block is absent throws an error with
  `code === 'BLOCK_MISS'` and `blocks: [{ index, offset, packed }]` naming *every* missing block in
  ascending order, so one round trip satisfies the retry. `BLOCK_MISS` is deliberately not an
  `ErrorCode`: it is a request for bytes, not a failure. `prefix` places the whole bundle under a
  directory: the engine mounts it under `App`, so a game lives at `C:\App\…` rather than at the
  root, where "where do I live" would happen to work whether the program answered it right or not.
- **Block cache** (`cache.js`): where fetched blocks live between the network and a read. With a
  synchronous store (`resolveBlockStore('local')` → OPFS through `createOpfsStore`, worker-only) a
  block occupies the fixed slot `index * blockSize` in `/<name>.blocks`, and a presence bitmap
  `/<name>.present` makes a second session cheap; a bitmap of the wrong size belongs to another
  bundle and is discarded. A zstd block is stored packed (the emulator's zstd decoder answers
  synchronously); a deflate block is stored inflated at fetch time, because no synchronous inflate
  exists in a browser. Without a store the fallback is a bounded heap LRU (at least 64 MiB or 32
  blocks) that pins the blocks of the read being served, so a single large read cannot evict its
  own blocks and deadlock.
- **Fetching, read-ahead and prefetch** live in the assembler, `src/app.js` (`mountBundle`), not in
  this layer: a retrying range fetch that treats a short read as a failure, groups of absent blocks
  fetched in requests of up to 16 MiB with six in flight, per-block CRC-32 checks (a damaged group
  is re-asked whole), 2 MiB of read-ahead when a miss lands where a forward reader was expected,
  and a background fill of the whole bundle in container order, one request at a time, that stands
  aside whenever a read is parked and is off when there is no durable store.

### Disc images (`src/layers/filesystem/internal/iso/`)

A disc image is a read-only drive of its own rather than a layer under a bundle: an installer
started from a disc finds its archives beside itself, on a drive that answers as a CD-ROM, and
nothing of the disc ever lands in the writable layer, so nothing has to be told apart afterwards.

- **Reader** (`iso9660.js`, published as `@bottlify/core/iso`): written from ECMA-119 and the
  Joliet specification. `openIso(read)` reads the volume descriptors from sector 16 to the
  terminator and walks the directory tree of the Joliet supplementary descriptor where there is
  one (escape sequences `%/@`, `%/C`, `%/E`), of the primary descriptor otherwise. `read(offset,
  length)` may answer at once or with a promise: the page reads a chosen file asynchronously, the
  engine synchronously, and the image's own `read(entry, offset, length)` answers in the manner it
  was given. Opening reads the descriptors and the directories and no file; a file's bytes are
  read when asked for, a range at a time. Names are the Joliet ones as the files carry them, or
  the primary tree's, with the `;1` version and the dot of a name without an extension dropped, as
  Windows shows them. A file recorded as several extents (the multi-extent flag) reads as one;
  an interleaved file is read unit by unit, the gaps skipped; an associated file is not a file of
  its own and is left out. The existence bit is `hidden`; the recording time, with its zone, is
  `modified`. `volume` is `{ label, serial, blockSize, blocks, size, joliet }`: the label of the
  descriptor the tree was read from, and the serial number Windows reports for a disc -- the bytes
  of that descriptor summed four ways into the four bytes of a word, the first byte into the most
  significant. A directory reached twice, a tree deeper than 64 levels or wider than 2^20 entries
  is a damaged image and refused. `isIsoImage(read)` tells an image apart by its contents: a
  volume descriptor at sector 16.
- **Source** (`source.js`): `createIsoSource(image)` is a `SourceStore` over an image opened with a
  synchronous reader; one opened with an asynchronous reader is refused on the first read rather
  than handing a promise to a guest read. `chunkedReads(read, { size })` is that reader with the
  last sixty-four 64 KiB-aligned chunks kept, so an installer reading a cabinet's headers a few bytes
  at a time costs one read of the image per chunk; a read of 256 KiB or more goes straight through.
- **Mounting** is the assembler's (`src/discs.js`, the `discs` option of
  [`host.md`](./host.md)): a `Blob` is read with `FileReaderSync` in a worker, a range at a time;
  on a thread without it, into memory once. The drive is mounted `readOnly` with
  `volume: { kind: 'cdrom', label, serial, size, unicode }`, on D: or the first free letter after
  it.
- **Read-only media**: the overlay refuses every change on the drive with `WRITE_PROTECTED` before
  it looks the name up -- the device refuses, not the file, so a name that is not there is refused
  the same way; an open asking for write access is refused the same way in the handle table. An
  open to read an existing file succeeds whatever its disposition; one that would create or empty
  a file is refused.

### The system volume

A second read-only layer can sit under the bundle: the engine's own volume, mounted at
`C:\WINDOWS\system32\`, holding whatever files the host hands `createApp` as `system.files` (bare
names, which the layer prefixes with the system directory) as though the machine had always had
them. The engine carries none of its own, and the build packages none: the DirectX End-User
Runtime's side-by-side DLLs (`d3dx9_*`, `d3dcompiler_*` and the rest) are put in `system32` by the
setup a title's installer runs, as on a machine that never had them, and land in the writable
layer like any other file an installer writes. A title's own file of the same name, in the bundle,
still wins over this layer. The layer is refused for writing as a volume, not merely as a source.

### The session (what the program wrote)

The writable layer of the volume is in-memory in every configuration `createApp` builds; what
persists is a **session**: `export()` of the writable layer plus the registry (see
[`win32.md`](./win32.md)). The overlay announces a change once per path on a microtask after the
writes settle (`onChanged`), and the assembler's `storage` option (`'local'` for `localStorage`,
`'opfs'`, a provider with `load`/`save`, or a bare loader) decides where it goes. A restored
session comes back through `apply()` before the program's first instruction. Nothing is ever pulled
in behind a running program's back, and the source is never uploaded — a bundle is named by its
digest and fetched.

### The OPFS store (`src/layers/filesystem/internal/opfs-store.js`)

A `WritableStore` over `FileSystemSyncAccessHandle`. `open(path)` is asynchronous and makes a file
answerable; every byte operation is synchronous on what is already open, and a byte operation on a
path nobody opened is `INVALID_HANDLE`. Sync handles exist only inside a worker, so on the main
thread `open` fails with `ACCESS_DENIED` rather than hanging. A sync handle is an origin-wide
exclusive lock, so handles are pooled, bounded and closed least-recently-used first. In the current
tree its consumer is the bundle block cache.

## 4. Limitations and divergences

- **No UNC, no `\\?\`**, no alternate data streams, no reparse points, no junctions.
- **No timestamps or attributes.** `stat` reports `directory` and `size` only; the win32 layer
  synthesises file times.
- **Sources are indexed once.** A source that gains or loses files after mount is not seen.
- **Rename is copy-and-delete**, chunked by 1 MiB. It is not atomic, and a rename onto an existing
  name is `ALREADY_EXISTS`.
- **`apply` refuses the whole batch** if any entry names a file the program holds open.
- **`export` reads whole files into memory**, one per writable file.
- **A bundle read is served or missed, never awaited** here; a caller that does not handle
  `BLOCK_MISS` gets a thrown error. The engine's `vfs.js` fetches once and retries once — a second
  miss is a fetch that did not deliver.
- **Format versions 1 and 2 only**; version 1 blocks arrive without checksums.
- **A disc is read as ISO 9660 and Joliet only.** Rock Ridge is not read, and neither is UDF: a
  disc that carries a UDF volume beside its ISO 9660 one (a DVD of the era, a bridge disc) is read
  through its ISO 9660 tree and reported as `CDFS`, where Windows would mount the UDF one. One
  image per drive, and no way to change the disc in a drive while a program runs.
- **The heap block cache is not persistence**: a build without OPFS pays the network again for
  anything it let go.
- **`handles.byPath` tracks at most 4096 distinct paths.**

Nothing in this layer reports at runtime on its own; failures are thrown to the caller, and the
engine journals what its callers decide to say.

## 5. Tests

`node:test` unit tests over the in-memory store, no browser needed; run with `npm test` from
`modules/core`. The bundle tests write a fixture with `src/bundle-node.js` and read it back.

| file | covers |
|------|--------|
| `src/layers/filesystem/internal/paths.test.js` | Drive parsing, separators, trailing dots/spaces, `.`/`..`, devices everywhere, refused namespaces, wildcard rules, per-drive current directory. |
| `src/layers/filesystem/internal/tree.test.js` | Both layers as one volume, case-preserving enumeration, copy-up on write, tombstones, merge with source directories, distinct failures, diagnostics, and the system volume: a file only it holds is read from it, a bundle file of the same name wins, and every mutation is `ACCESS_DENIED`. |
| `src/layers/filesystem/internal/handles.test.js` | Positions, reads past the end, zero-filled extension, dispositions, sharing in both directions, `SetEndOfFile`, closed handles, the per-path report. |
| `src/layers/filesystem/internal/memory-store.test.js` | The seeded store. |
| `src/layers/filesystem/internal/opfs-store.test.js` | Over a fake OPFS: mount walk, synchronous read/write, zero-fill, nested directories, the handle pool, the exclusive lock, main-thread refusal. |
| `src/layers/filesystem/internal/bundle/bundle.test.js` | Byte-exact round trip through all three codecs, ranges across blocks, reads past the end, case folding, empty directories, `BLOCK_MISS` naming every absent block, LRU eviction, header checks. |
| `src/layers/filesystem/internal/bundle/cache.test.js` | Slot arithmetic, the presence bitmap across sessions, a foreign bitmap discarded, the heap fallback and its pinning. |
| `src/layers/filesystem/internal/bundle/crc32.test.js` | The checksum. |
| `src/layers/filesystem/internal/iso/iso9660.test.js` | Over images written by `iso.fixture.js` (both descriptors, both trees, path tables): the Joliet tree preferred and its names kept, the primary tree's names cleaned, byte-exact reads whole and in pieces from a synchronous and an asynchronous reader, opening that reads no file, multi-extent and interleaved files, the hidden bit and the recording time in UTC, the serial number, refusal of what is not an image and of a directory that contains itself, the source store and the chunked reader. |
| `src/layers/filesystem/module.test.js` | The module comes up with no configuration; case; relative paths; drives isolated; search patterns; wildcards refused outside enumeration; devices reported; the source survives everything; diagnostics before and after; a disc mounted as D: reads like any other drive, reports its volume, hidden names and recording times, and refuses every change as `WRITE_PROTECTED`. |
| `src/discs.test.js` | The first free letter from D; a `Blob` read a range at a time through `FileReaderSync`, and whole without it; mounted discs as CD-ROM drives; a letter asked for that is taken is refused. |

Integration tests that drive a bundle and a session through the whole engine live beside the
application entry point (`src/bundle.itest.js`, `src/session.itest.js`; `npm run test:integration`).
`src/disc.itest.js` runs a program started from a disc image: the drive is a CD-ROM labelled as
the disc is, on CDFS, the current directory is the disc's root, a file on it reads, a create there
fails with `ERROR_WRITE_PROTECT`, and a copy to C: lands whole; and the image crosses the port
protocol as the `Blob` it was chosen as.
