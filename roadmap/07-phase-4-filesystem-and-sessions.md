# 07 — Phase 4: filesystem, bundles and sessions. Roadmap

> Working document for the phase. Source of truth is `00-bottlify-master-plan.md` (below: Master
> Plan). Phase 3 is closed — its plan is `06-phase-3-bridge-and-win32.md`.

## 0. What Phase 4 is

Phase 4 = "filesystem and sessions" from the Master Plan: a virtual filesystem, a copy-on-write
overlay over OPFS, the user layer and session sync, and the bundle a game arrives in.

**Phase acceptance (Master Plan):** an application writes a file, the tab is closed, it is reopened
on another machine under the same account — the file is there.

The bundle format is the part with a decision in it. Everything else follows from a contract that is
already written down; the format has to be chosen against measurements of real games, and choosing
it wrong is expensive to undo once bundles exist.

## 1. The bundle: two files, not one

A bundle is **the game and nothing else**, plus a manifest beside it:

```
bundles/<id>/manifest.json     what the game is: title, description, cover, version, entry point
bundles/<id>/bundle.btl        the game's files, and only those
```

The split is the decision. Catalogue data changes for reasons that have nothing to do with the
bytes — a description is corrected, a cover is replaced, a title is translated — and a format that
carries it inside means rewriting gigabytes to fix a typo. It is also read by things that will never
open the archive: a catalogue page lists a hundred games without touching a single one of them.

The manifest also records **how the bundle was written** — format version, codec, block size, size
and digest — so a reader knows what it must be able to decode before it fetches anything, and so a
later bundle can use a different codec without the format changing.

### 1.1. Why `.btl` looks the way it does

Shaped by how it will be read: over HTTP, by a browser, a few kilobytes at a time, in whatever order
the game seeks.

| decision | why |
|---|---|
| fixed 40-byte header at the very front | one small range request tells a reader where everything is |
| data cut into fixed-size blocks (1 MiB) | a hundred bytes at a random offset costs one block, not a file. A megabyte keeps the index of a five-gigabyte bundle under a megabyte and still gives a compressor something to work with |
| a codec **per block**, not per bundle | game data is mostly already-compressed archives with a few executables mixed in, and the two want opposite answers |
| index at the end | writing is a single forward pass over the input and never seeks back to patch a size |
| index is deflated JSON | it is read once, and a schema that can grow without a format version is worth more here than bytes |
| paths stored as the guest asks for them | backslash-separated, relative to the root, matched case-insensitively, listed in the case they were created with |
| empty directories recorded explicitly | nothing about a file list would put them back, and a program that writes into one fails if it is missing (§13.6) |

### 1.2. Which codec — measured, not assumed

Both games in `C:\Games`, sampled by byte offset across the whole tree so the sample is proportional
to what a bundle actually contains, 1 MiB blocks:

**Warcraft III: The Frozen Throne** (1.09 GiB, 210 files)

| codec | ratio | pack MiB/s | unpack MiB/s |
|---|---|---|---|
| deflate-raw/6 | 97.4% | 46 | 275 |
| deflate-raw/9 | 97.4% | 45 | 273 |
| brotli/5 | 95.9% | 98 | 322 |
| brotli/9 | 95.2% | 13 | 216 |
| zstd/3 | 96.4% | 247 | 568 |
| zstd/12 | 96.1% | 72 | 535 |
| zstd/19 | **95.1%** | 19 | 515 |

**World of Warcraft 1.12.1** (5.02 GiB, 48 files)

| codec | ratio | pack MiB/s | unpack MiB/s |
|---|---|---|---|
| deflate-raw/9 | 99.6% | 53 | 670 |
| brotli/9 | 99.4% | 35 | 621 |
| zstd/3 | 99.6% | 443 | 628 |
| zstd/19 | **99.3%** | 23 | 522 |

The distribution behind those numbers, measured separately on whole small files with deflate/9:

| kind | Warcraft III | World of Warcraft |
|---|---|---|
| `.mpq`, `.w3x`, `.w3m`, `.avi` | 97–99% | 97–99% |
| `.exe`, `.dll`, `.ax`, `.asi` | 33–47% | 46–48% |
| `.txt`, `.html`, `.dat` | 17–33% | 17–45% |

So: the bulk of a game is an already-compressed archive and will not move, and the few tens of
megabytes that do move are executables and text. **That is an argument for a per-block decision
rather than for a better compressor** — the best codec in the table buys 2.6 points on one game and
0.3 on the other over the one every browser already has.

**Chosen: `deflate-raw`, per block, kept only when it saves at least 4%.**

- It is the only codec a browser can decode at a random offset with no dependency at all
  (`DecompressionStream('deflate-raw')`). Brotli and zstd are available to HTTP as content encodings
  but not to random access, so either would mean vendoring a WASM decoder — a new third-party
  dependency in a project that keeps exactly one.
- What that dependency would buy, measured: about 29 MiB on Warcraft III and 20 MiB on World of
  Warcraft. Forty-nine megabytes across six gigabytes is not the price of a decoder in the critical
  path of every read.
- The 4% threshold matters more than the codec. Below it the saving is not worth decompressing on
  every future read, and on this data most blocks land at "saves nothing at all" — so the threshold
  is what keeps the archive fast rather than merely small.
- A cheap probe (deflate the first 96 KiB at level 1) decides whether to compress the block at all.
  Without it the build is dominated by compressing data that will be stored anyway.

**The result, on the real games:**

| bundle | files | in | out | ratio | blocks compressed | build |
|---|---|---|---|---|---|---|
| `warcraft-iii-frozen-throne` | 212 | 1112.0 MiB | 1086.9 MiB | 97.7% | 166 / 1276 | 15 s |
| `world-of-warcraft-classic` | 48 | 5137.3 MiB | 5120.7 MiB | 99.7% | 113 / 5171 | 57 s |

Both verified by reading every file back and comparing against the digest written with it: 0 corrupt.
Both rebuild byte-for-byte identical from the same input, which is what makes a bundle cacheable by
content and checkable against one somebody else built.

This is what "different games use different compression" turns out to mean in practice: the policy
is the same and the *outcome* differs — Warcraft III compresses 13% of its blocks, World of Warcraft
2% — and the manifest records what each one ended up being. A game that is mostly loose data would
compress most of its blocks under exactly the same rule.

### 1.3. Why not ZIP64

ZIP64 is the obvious candidate and deserves a straight answer: it is universal, every operating
system opens it, it handles files past 4 GiB, it stores or deflates per entry, and a reader can work
over HTTP range requests. A bundler that emitted it would let anyone inspect or repack a bundle with
tools they already have.

It is the wrong *runtime* format for one structural reason: **ZIP compresses per entry, not per
block.** A compressed entry is a single deflate stream, and there is no way into the middle of one
except from its beginning. Measured on the largest file in the World of Warcraft bundle, a 1821 MiB
archive, reading 64 KiB at 60% of the way in:

| | to read 64 KiB at 60% |
|---|---|
| `.btl`, per-block | **2.97 ms** — one block fetched and inflated |
| one deflate stream per entry | **4567 ms** — 1093 MiB inflated to get there |

Three orders of magnitude, on the access pattern a game does constantly: seeking into a big archive
to pull one asset out of it.

That is not a defect of ZIP; it is what a single stream means. The escape is to store the entry
uncompressed, which is exactly what a Store-only ZIP does — and then the format buys nothing over
a plain directory while giving up the 25 MiB and 17 MiB that per-block compression saves on these
two games at no read cost at all. The other way out — one ZIP entry per megabyte of every file —
is `.btl` reinvented inside a container, with the central directory paying for the privilege.

The interchange argument is real and is answered separately: the bundler can learn to **read** a zip
so a game that arrives as one can be packed without unzipping it first. That belongs with the
bundler phase. Nothing about it makes ZIP the shape the engine reads at runtime.

## 1.4. Where files come from, and how they get in

Three kinds of bytes reach a running program, and they are not the same kind of thing:

| | changes | size | who writes it |
|---|---|---|---|
| the bundle | never | gigabytes | nobody: it is content-addressed and immutable |
| the overlay | constantly | megabytes | the guest, and whoever pushes files in |
| the session record | on save | kilobytes | us: which bundle, which overlay generation, the registry |

Treating them alike is the mistake to avoid. The bundle is **cached, not synced** — it is named by
its own digest, so a cached copy never needs revalidating and two people playing the same game share
the same bytes. Only the overlay and the session record are worth sending anywhere.

### Pushing files in from outside

Something other than the guest has to be able to put files into the volume: a save restored from the
cloud, a config a page hands over, a patch. The writable store already has the shape for it, but
writing straight into the store is wrong, for a reason worth stating: **the overlay indexes the
store once, at mount.** A write that goes behind its back is invisible until the next mount, and the
program keeps reading what was there before.

So the layer gets one explicit entry point rather than a back door:

```
filesystem.apply(changes)    // [{ path, bytes } | { path, delete: true }, ...]
```

with three properties that are the whole design:

- **It goes through the overlay**, so the index, the tombstones and any open handle see it.
- **It is a batch and it is atomic.** Half an applied save is worse than none: a program reads a
  header written by the new one and a body left by the old. OPFS has no transaction, so the pattern
  is write-aside then swap, with a journal naming the batch.
- **It refuses to overwrite a file the guest holds open**, and says which. A save being rewritten
  under a program that has it open is not a case anybody can make correct; the caller decides
  whether to wait or to fail, and the layer will not pretend it worked.

### The chain, and what should not be in it

The obvious chain is `cloud <-> localStorage <-> OPFS`. **localStorage should not be in it at all**,
for four reasons in ascending order of finality:

1. It is synchronous, so every touch blocks the thread it is on.
2. It is capped at about 5 MB — a single save file can exceed that.
3. It stores strings, so bytes have to be base64'd: a third more of a budget that was already small.
4. **It does not exist in a Worker.** The engine runs in one. There is no way to reach it from where
   the filesystem lives, and routing through the page to get at it would mean posting every write
   across a message port to a slower, smaller store.

So the chain is:

```
cloud  <->  session record + overlay  <->  OPFS        (the guest's writes)
cloud   ->  bundle, by digest          ->  OPFS cache  (immutable, evictable, never uploaded)
```

Where a small key-value store is genuinely wanted — "which session was last open" — it is IndexedDB
or a file in OPFS, both of which a worker can reach.

### Syncing without losing a save

A save is the one thing a user cannot be asked to lose, so the conflict rule is chosen for that
rather than for tidiness:

- The session carries a **generation** that increments on every upload, and the last known remote
  generation is stored with it.
- Uploading with a stale generation is a conflict. On conflict **both versions are kept** — the
  remote stays, the local becomes a second session the user can open — and nothing is merged
  automatically. Per-file last-writer-wins silently destroys a save whenever two machines played
  offline, and the user finds out weeks later.
- Only the overlay and the registry travel. The bundle is named by digest; a machine that lacks it
  fetches it from wherever bundles come from.

## 2. Steps

### P4.1 — the bundle format ✅

`tools/btl.mjs` (read and write) and `tools/make-btl.mjs` (pack, verify, list). Nine tests over
data shaped like the real thing: mixed compressible and incompressible content, range reads across
block boundaries, case-insensitive lookup, empty directories, corruption detection, reproducibility.

Found by testing rather than by reading: a directory holding only another directory was being
recorded as empty.

### P4.2 — the virtual filesystem

Windows path semantics (case-insensitive lookup preserving created case, both separators, drive
letters, `.` and `..`, trailing dots and spaces, reserved device names, `*`/`?` matching only in
enumeration), a read-only source with a copy-on-write overlay, tombstones for deletions, and file
handles with a position.

**Done when:** a program writes to a file that exists only in the bundle, reads it back changed, and
the bundle is untouched.

### P4.3 — the Win32 file API

`CreateFileA` and the rest over the VFS, including the parts programs actually depend on: the error
code after a *successful* `CreateFile`, `SetFilePointer`'s ambiguous 0xFFFFFFFF, and
`FindFirstFile`/`FindNextFile` filling `WIN32_FIND_DATAA`.

**Done when:** a fixture creates a file, writes, seeks, reads it back, enumerates the directory it is
in, and deletes it.

### P4.4 — OPFS as the writable layer, and `apply`

The overlay's store, in the browser. The VFS is written against an injected store precisely so this
is a backing implementation rather than a rewrite. With it, the `apply(changes)` entry point from
§1.4: atomic, through the overlay, refusing to overwrite what the guest holds open.

**Done when:** the acceptance below holds within one browser, and a batch applied while a program is
running is either wholly visible to it or wholly refused.

### P4.5 — mounting a bundle as the source

The reader from P4.1 moved into the core as the VFS's read-only source, fetching block ranges rather
than whole files, so a game starts before it has downloaded.

**Done when:** a program reads a file out of a bundle it never downloaded whole.

### P4.6 — sessions

The user layer: which bundle, the overlay's contents, and the registry hive, saved and restored.
The registry already serialises to JSON and back, which was built for this.

**Done when:** the Master Plan's acceptance — write, close, reopen elsewhere, the file is there.

## 3. What this phase deliberately does not do

- **No installer.** Running a game's own setup program needs a lot of Win32 that is now present but
  untested for that path; the Master Plan puts it after Phase 3 and it can wait for a real target.
- **No streaming download policy.** P4.5 makes range reads possible; deciding what to prefetch is a
  question for a game that actually runs.
- **No server.** Sessions sync to something; what that something is belongs with delivery.
