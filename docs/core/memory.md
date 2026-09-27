# `memory` — the guest address space

What is mapped, who may touch it, and typed access to it. Sits directly on [`cpu`](./cpu.md),
which holds the raw bytes; every layer above reads and writes guest memory through this one.
Module machinery is described in [`README.md`](./README.md) and [`system.md`](./system.md).

## 1. Purpose

`memory` is a **registry and a validator, not an allocator**. Callers decide where things go —
an image loads at the base its headers demand, a stack is placed by the kernel, the heap by the
process assembler — and this layer records the decision, refuses layouts that overlap, and
answers whether a given access is legal. Every typed read and write is checked against that map
before it reaches the emulator, so an unmapped or wrongly-permitted access is an error with an
address in it rather than a silent write into whatever happened to be there.

It does not allocate, does not own the layout (the assembler in `src/app.js` does; see
[`host.md`](./host.md)), and does not implement guest-visible memory APIs such as
`VirtualAlloc` or heaps — those are `win32`'s, built on top of the regions registered here.

## 2. Contract

| field      | value      |
|------------|------------|
| `name`     | `memory`   |
| `version`  | `0.1.0`    |
| `requires` | `['cpu', 'log']`  |

Source: `src/layers/memory/module.js`, `src/layers/memory/internal/regions.js`,
`src/layers/memory/internal/accessors.js`.

### Configuration

The module reads no configuration options. `true`, `{}` and `undefined` are equivalent.

### API

Constants:

| member | values | meaning |
|--------|--------|---------|
| `Access` | `NONE 'none'`, `READ 'r'`, `READ_WRITE 'rw'`, `READ_EXECUTE 'rx'`, `READ_WRITE_EXECUTE 'rwx'` | What a region permits. |
| `RegionKind` | `LOW_MEM`, `IMAGE`, `THUNK_CODE`, `THUNK_DATA`, `STACK`, `RESERVED` | What a region holds; descriptive, for diagnostics. Permissions come from `access`, not from the kind. |

Region map:

| member | signature | meaning |
|--------|-----------|---------|
| `register` | `({ name, base, size, kind, access }) => Region` | Records a region. Throws on non-positive size, unknown access, or overlap with anything already mapped. |
| `unregister` | `(name) => void` | Gives a region back: its span is unmapped from then on and free for whatever is registered next. For memory whose owner is gone -- the stack of a thread that has exited, a library the program freed for the last time -- never for memory someone may still reach. Throws for an unknown name. |
| `protect` | `(name, access) => void` | Changes what a named region permits, the way `VirtualProtect` does. Throws for an unknown name or access. |
| `find` | `(address) => Region \| undefined` | The region containing an address. |
| `nextRegionAfter` | `(address) => Region \| undefined` | The mapped region with the lowest base strictly above an address, or `undefined` past the last one. Answers how far a free gap runs; a linear scan, unasked on the hot read/write path. |
| `list` | `() => Region[]` | Every region, lowest address first (a copy). |
| `assert` | `(address, length, 'read' \| 'write' \| 'execute') => Region` | Throws unless the whole span sits inside **one** region that permits the mode. A span across two adjacent regions is refused. |

Accessors (all validated through `assert`):

| member | signature | meaning |
|--------|-----------|---------|
| `readBytes` | `(address, length) => Uint8Array` | A **copy** of guest bytes. |
| `window` | `(address, length) => Uint8Array` | The emulator's own bytes, valid only until control returns to the guest. For a measured hot path. |
| `writeBytes` | `(address, bytes) => void` | Writes; routes to `cpu.writeData` when the target region is not executable, `cpu.writePhysical` otherwise. |
| `readU8` / `readU16` / `readU32` | `(address) => number` | Little-endian unsigned integers. `readU32` reads through the reader (below): in place out of the RAM the cpu lends, or through `cpu.readU32`, with nothing allocated. |
| `readU32sInto` | `(address, count, into, at = 0) => void` | `count` signed dwords, written into `into` starting at `at`: one span check for the whole run, then the span read through the reader -- out of the RAM the cpu lends, or in one call to `cpu.readU32sInto` (per word through `cpu.readU32` where the cpu has no such path) -- nothing allocated. A span a region boundary refuses falls back inside this call to a per-word read, so a caller never sees the boundary case. |
| `reader` | `() => DwordReader \| null` | The checked dword reads as an object: `readU32(address)` and `readU32sInto(address, count, into, at)`, the same checks and answers as the two above. For a caller on every host call's path -- the bridge's crossing -- which calls its methods without this layer's closures in the way (below). |
| `readF32sInto` | `(address, count, into) => void` | The float form of the same read, through `cpu.readF32`, for a fixed-count vector argument a handler decodes into a reused scratch. |
| `writeU8` / `writeU16` / `writeU32` | `(address, value) => void` | Little-endian writes through a shared scratch buffer. |
| `readCString` | `(address, limit = 4096) => string` | NUL-terminated Latin-1 string. Throws if no NUL within `limit` bytes (clamped to the region). |
| `readWideString` | `(address, limit = 8192) => string` | NUL-terminated UTF-16LE string; `limit` is in bytes. Throws if no terminator within it. |

Who is writing (see [§3](#who-writes-into-guest-memory)):

| member | signature | meaning |
|--------|-----------|---------|
| `writer` | `(name) => number` | The number a name's writes are charged under, resolved once by whoever registers the name. `-1` with no log registry. |
| `charging` | `(slot) => number` | Charges what follows to a number and answers who was being charged, for the caller to put back on the way out. A number outside the table leaves the charge where it was. |
| `chargeSlot` | `() => Int32Array \| null` | Who is being charged, as a one-element cell: what `charging` swaps, for a caller that swaps it itself with numbers `writer` gave it. `null` with no log registry. |

An instance owns its address space. `create()` may run more than once in the same realm (a
process replacement runs it again; the plan for two machines in one worker needs two at once), so
the region map, the accessors and the writer account live in the instance the api closes over,
and a second `create()` cannot take the first one's layout; `diagnostics()` answers for the most
recently created instance. After `dispose()`, a call that was in flight answers harmlessly rather
than throwing: `register` answers `null`, `find` and `nextRegionAfter` answer `undefined`, `list` answers `[]`,
`assert` answers `undefined` instead of validating, `writer`/`charging` answer `-1`, `reader`/
`chargeSlot` answer `null`, `readBytes`/
`window` answer an empty `Uint8Array`, `readU8`/`readU16`/`readU32` answer `0`, `readU32sInto`/
`readF32sInto` fill `into` with zeroes, `readCString`/`readWideString` answer `''`, `scanCString`
answers `{ index: -1, byte: 0 }`, and `unregister`/`protect`/`writeBytes`/`fillBytes`/`writeU8`/
`writeU16`/`writeU32` are no-ops.

### Diagnostics

`status` is `'created'` before `create()` and `'ready'` after.

| metric    | meaning | when it moves |
|-----------|---------|---------------|
| `regions` | Number of regions registered. | Every `register` and `unregister`. |
| `layout`  | One string per region, `name 0xbase+0xsize access`, lowest first. | Every `register`, `unregister` and `protect`. A layout that looks wrong usually explains a fault faster than the fault does. |

`diagnostics()` builds those strings on request and is for a one-off look. The layout is also
published as the `memory/regions` table of the log layer (`REGION_COLUMNS`: `name` as a journal
dictionary id, `base`, `size`, `access` as its index in `Access`; up to `REGION_ROWS` = 1024 rows,
lowest first), rewritten on every `register`, `unregister` and `protect`, which is rare. A reader
elsewhere names a page of guest code from it without asking this thread; with no registry (the log
layer stubbed) nothing is published and nothing else changes.

## 3. How it works

### The region map

`createRegionMap()` keeps a flat array of `{ name, base, size, kind, access }`. Registration
scans for overlap and throws — an overlap is a layout bug, and it is far cheaper to hear about
it at registration than to debug a guest whose stack grew into its own code. `protect` changes
permissions in place; `unregister` takes a region out and forgets the lookup cache below, the one
change that can make it name a region no longer there. A `version` counter is bumped by all three
so a caller that cached a region can tell when the cache is stale. `version` and `scans` are plain
fields of the map, not getters: a getter in that object literal put the whole map in V8's
dictionary mode, and `version`, read on every host read of guest memory, was a tenth of a host
call (`lstrlenA` in a loop under cork: 1219 -> 834 ns a call).

`find` is asked on every host read and write, thousands of times a frame, nearly always in the
region the last one hit, so the last hit is tried first and the fallback walk allocates nothing.
`nextRegionAfter` has no such cache: it is asked only when a `VirtualQuery` has already fallen
through `find` to the free branch, once per query rather than once per byte.

`executable(address)` (internal, not on the API) answers whether anything at an address could
be executed — `true` when nothing is known, which is the safe answer. The accessors use it to
pick between the two write paths the cpu layer offers.

### Accessors

`createAccessors({ raw, regions })` takes the cpu layer's API as `RawMemory`
(`readPhysical`, `writePhysical`, and optionally `readU32`, `readU32sInto`, `readF32` and
`writeData`). Three
decisions shape it:

- **Reads copy.** The emulator hands back a subarray of its own memory, and a caller holding two
  such windows and writing through one finds the other silently moved. `readBytes` slices;
  `window` is the explicit opt-out.
- **Dword reads are cached by region.** A host call reads several dwords — arguments on the
  stack, the fields behind them, the thread's last error in the TEB — almost all in a handful
  of regions; the accessor remembers the span and version of the last four regions reads fell
  in and skips `assert` while a read stays inside one. Asking the map every time cost a fifth of
  a call, and two entries missed on every read of the stack–TEB–data cycle a call makes.
- **Dword reads are one class for the realm.** `DwordReader` (`internal/reader.js`) makes them:
  a span checked against its own four remembered regions and the map's `version`, then read out
  of the RAM the cpu lends (`cpu.ramView`, a DataView over it taken once, and asked for again
  when a read finds it detached), or through `cpu.readU32`/`readU32sInto` where it lends none.
  Its methods are the class's, one set of functions for every machine a process makes, where the
  accessors and the api over them are closures each `create()` makes afresh: a later machine's
  start unoptimised and are compiled around what the machines before it left ([bridge](./bridge.md),
  "A process's second machine"), and the bridge reads a call's stack and its thread's last error
  on every call. `createAccessors({ raw, regions, charge, reader })` makes its dword reads through
  the reader when given one, and the module gives it one whenever the cpu reads dwords at all.
- **Writes that cannot be code skip the compiler.** `writeBytes` calls `cpu.writeData` unless
  the region is executable, in which case it calls `cpu.writePhysical`, which tells the
  emulator to discard compiled code on those pages. The cpu layer explains why the ordinary
  path is expensive; this is where the choice is made.

A string scan may read up to `limit` bytes but is clamped to the region, so a string at the end
of a mapped span is ordinary and the scan cannot wander into the next region.

### Who writes into guest memory

Every byte the host puts into the guest's address space passes through `writeBytes`, and by
itself that is one number for the whole run — the number that rises fastest in a stalling frame
and the one that cannot be acted on. So each write is charged to whoever is in flight: the
[bridge](./bridge.md) resolves each registered function's name to a number once and hands it to
`charging` around the call, restoring the previous number on the way out, so a handler that
calls guest code back into another host call nests without a stack of its own. The number being
charged is the one element of `chargeSlot`, which the bridge swaps itself: two stores a call
where `charging` was two calls into this layer. A write with no
host call in flight is charged to `<no host call>` rather than to whoever ran last.

The account is published as the `memory/writers` table (`WRITER_COLUMNS`: `name` as a journal
dictionary id, `bytes`, `writes`; `WRITER_ROWS` = 256), cumulative over the run, plus two
counters of the frame that just closed: `frameWriter` (the busiest writer's name id, `-1` if
nothing wrote) and `frameWriterBytes`. The busiest writer is found as the writes happen — a
stamp per row says whether its frame total belongs to this frame — so closing a frame bumps the
stamp instead of clearing anything.

Two properties are deliberate and both are pinned by tests:

- **A row is taken at a name's first write, not at its registration.** Registration order is the
  order the engine builds its libraries in, so rows taken there go to the first few dozen
  kernel32 functions, most of which never write a byte, and everything registered afterwards —
  which is most of what writes — ends up sharing the overflow row `<beyond the table>`. Taken at
  the first write, the table holds the writers.
- **The write path allocates nothing and touches no string.** A charge is an array read, a
  branch and four array operations; names are interned once, where a row is taken.

With the log layer stubbed nothing is published, no account is built, and the write path takes a
branch rather than a call.

### The address space, as it is laid out today

The memory layer does not choose the layout; the process assembler (`src/app.js`) and the
layers that own each piece register it. What a booted process looks like:

| region | placed by | kind / access | where |
|--------|-----------|---------------|-------|
| `entry-vector` | assembler | `THUNK_DATA` rw | 4 bytes at `cpu.layout.entryVector` (`0x7000`) |
| `boot-rom` | assembler | `LOW_MEM` rx | `0xF0000`, 64 KiB — registered so a fault report can name the engine's own stub |
| `thunks` | assembler | `THUNK_CODE`, rwx while written then `protect`ed to rx | `cpu.layout.thunkBase` (`0x100000`), `thunkCapacity` bytes |
| `stack` | assembler | `STACK` rw | Below `cpu.layout.initialStack` (`0x300000`), sized from the image's `SizeOfStackReserve` (floored at 64 KiB, clamped to the room above the thunks) |
| the program image | [`loader`](./loader.md) | `IMAGE` rwx | Its own `ImageBase` |
| system modules | loader `synthesise` | `IMAGE`, rwx then rx; `<name> .data` rw beside it for a module that exports variables | `0x02000000 + index * 0x00100000` |
| libraries the program ships, and those it loads by name | loader `map` | `IMAGE` rwx | Above the system modules and below the stack pool: a relocatable one at the next free base, one without relocations at its own base or not at all |
| `<name> as data at 0x…` | assembler | `IMAGE` r | A library `LoadLibraryEx` mapped as data, where a library would go |
| `process-startup` | assembler | `THUNK_CODE` rwx | 1 MiB where a library would fit -- after the libraries, or in the first gap below the stack pool: TLS blocks and the stub that attaches libraries |
| `stack-N` | [`kernel`](./kernel.md) | `STACK` rw | Pool at `0x08000000`, 64 MiB: a stack per thread, the image's `SizeOfStackReserve` unless `CreateThread` asked for another size, given back when the thread ends itself |
| `heap` | assembler | `THUNK_DATA` rw | `0x0c000000` to the end of RAM |

The heap is last and takes everything left because it is the part that has to be big. The
sizes and bases above are the assembler's constants, not this layer's; they are listed so a
reader of a `layout` diagnostic knows what to expect.

### How other layers use it

`kernel` reads and writes stack words (`readU32`/`writeU32`) when priming a thread and parking
one. `bridge` reads call frames through the guest's ESP — deliberately through this layer so a
wild ESP fails against the map rather than marshalling whatever lives there — and writes
callback frames and COM tables. `loader` registers each image and writes its bytes.
`win32` and the layers above it read arguments, structures and strings and write results
through the typed accessors.

## 4. Limitations and divergences

- **Not an allocator.** There is no `allocate`/`free`; `RegionKind.RESERVED` exists as a kind
  but nothing reserves guard bands today.
- **A region is removed only by its owner**, by name, once nothing can reach it: a thread's
  stack after the thread ended itself, a library the program freed for the last time, a library
  mapped as data once its last handle is freed. The system modules are never removed.
- **Coarse permissions.** One `access` per region. The loader maps an image as a single `rwx`
  span rather than per section (see [`loader.md`](./loader.md)); a guest writing into its own
  code is not caught here.
- **Permissions apply to the host's accesses**, not the guest's. A region marked `rx` refuses
  a host `writeU32`; the emulated processor runs at ring 0 with flat segments and no paging, so
  guest instructions are not checked against the map at all.
- **No canaries, no leases.** The layer's own `api.js` comment lists "leases on locked
  surfaces, canaries" among intended responsibilities; neither is implemented.
- **A span across two regions is refused** even when they are adjacent — adjacency is a
  coincidence of layout, not permission to treat them as one buffer.
- **Strings are Latin-1 / UTF-16LE**, decoded with `TextDecoder`; a code page other than that
  is not applied here.
- **Every failure is a thrown `Error`** with the address, length and region name in its
  message; nothing is reported as a Win32 status. Whoever handles the trap decides what the
  guest sees.

## 5. Tests

Unit tests (`npm test`, filter with `node --test src/layers/memory/internal/memory.test.js`
from `modules/core/`):

| test | what it pins |
|------|--------------|
| a layout that overlaps is refused when it is registered | Partial overlap is refused; butting up against a region's end is not an overlap. |
| a region given back is gone from every answer, and its span can be registered again | `unregister` reaches the lookup cache and the accessors, and frees the span. |
| access is checked against the region that holds it | `assert` per mode. |
| protect tightens a region after it has been filled in | `protect` and the `rwx → rx` pattern the thunk table uses. |
| a span may not run past its region, even into an adjacent one | The one-region rule. |
| typed accessors round-trip little-endian values | `readU8/16/32`, `writeU8/16/32`. |
| accessors refuse what the region map refuses | Accessors go through `assert`. |
| a read is a snapshot, not a window onto guest memory | `readBytes` copies. |
| C strings are read up to the NUL, and a missing one is an error | `readCString` and its limit. |
| a dword read remembers its region and forgets it when the map changes | The read cache and `version`. |
| a read of bytes remembers its region the way a dword read does | The same cache on `readBytes`. |
| readU32sInto validates the whole span once and reads without an intermediate view | One `assert` for a multi-word read. |
| readU32sInto hands a checked span to the machine in one call when it takes one | `raw.readU32sInto`: one call a span, signed as per word, and an unmapped span refused before any of it is read. |
| readU32sInto writes into the array at the given offset, for a call's ecx already there | The `at` parameter, for `thisFirst`. |
| readU32sInto falls back to per-word reads across a region boundary, answering the same words the whole-span path would | The rare case a thread's stack straddling two regions needs. |
| readU32sInto refuses an unmapped word with the same error readU32 gives | Same errors, one call or many. |
| readF32sInto decodes floats through raw.readF32 with one span check | The float form of the same read. |
| readF32sInto falls back without raw.readF32, decoding the same bits readU32 would | A build with no `cpu.readF32`. |
| with a reader the dword reads are its own: over a boundary word by word, refused where the map refuses | The accessors over `DwordReader`: nothing asked of the machine but its RAM, the same fallback and errors. |

`internal/reader.test.js` holds `DwordReader` to reading out of the RAM the machine lends, signed
into an array or unsigned alone and nothing else asked of the machine; to the region map's refusals;
to validating a call's stack, TEB and data once each until the map changes, and refusing a region
at once when its access moves; to asking again for RAM that moved (an emulator growing its memory)
and reading it where it is now; and to reading through the machine's own calls, checked the same,
where it lends no RAM. `internal/writers.test.js` holds the slot to what `charging` swaps, and
`module.test.js` the reader and the slot to the open instance.

The tests drive the accessors against an in-memory `RawMemory` and need no emulator. The
layer's behaviour under a running guest is exercised indirectly by every integration test
(`src/*.itest.js`) and by the kernel and bridge module tests, which use a real region map.
