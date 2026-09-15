# `loader` — PE images in guest memory

Turning an executable file into something the guest can run: parsing PE32 headers, mapping
sections, applying relocations, binding imports and delay imports, and synthesising the system
modules a program links against as real in-guest PE images with real export directories. Sits on
[`cpu`](./cpu.md), [`memory`](./memory.md) and `log`. Module machinery is described in
[`README.md`](./README.md) and [`system.md`](./system.md).

## 1. Purpose

The loader commits images to guest memory and records the region each occupies. Parsing and
layout are pure functions over host buffers (`internal/pe.js`, `internal/image.js`), so an
image can be built and inspected without an emulator; the module is what writes the result
through the memory layer and registers it.

It deliberately does not decide what an import binds to. Resolution is a parameter
(`resolveImport`) supplied by whoever assembles the process — wiring it as a dependency would
point the loader at `win32` and invert the layer graph. It also does not choose load addresses
for system modules, keep the process-wide module table (name/base lookup), or run `DllMain`:
the assembler in `src/app.js` does those on top of what this layer provides (see
[`host.md`](./host.md)).

## 2. Contract

| field      | value                          |
|------------|--------------------------------|
| `name`     | `loader`                       |
| `version`  | `0.1.0`                        |
| `requires` | `['cpu', 'memory', 'log']`     |

Source: `src/layers/loader/module.js` and `src/layers/loader/internal/{pe,image,synth,
delayload,tls,resources,dependencies,init}.js`. Of these, only `pe`, `image`, `synth` and
`delayload` are reached through the module API; `tls`, `resources`, `dependencies` and `init`
are pure helpers the process assembler imports directly.

### Configuration

The module reads no configuration options.

### API

Every function below takes a resolver of the shape
`(dll: string, name: string | null, ordinal: number | null) => number | null` — the guest address
to write into the IAT, or null when nothing provides the import — and an optional `missing`
hook of the same shape that says where a call to an unclaimed import should land.

| member | signature | meaning |
|--------|-----------|---------|
| `load` | `(file, { resolveImport, base?, missing?, name = 'image' }) => { base, entryPoint, unresolved }` | Map, relocate, bind ordinary and delay imports, register the region, write the bytes. One step, for an image with no mutual dependencies. |
| `map` | `(file, { base?, name = 'image' }) => Mapped` | Map and relocate without binding anything; register and write. Returns an opaque record for `bind`. |
| `bind` | `(mapped, resolveImport, missing?) => string[]` | Bind the import directory of a mapped image and write the image again. Returns what nothing claimed, as `"dll!name"` or `"dll!#ordinal"`. |
| `bindDelayed` | `(mapped, resolveImport, missing?) => string[]` | The same for the delay-load directory; appended to the record's `unresolved`. |
| `synthesise` | `({ name, base, exports, entryPoint? }) => { base, size, entryPoint, addressOf, ordinalOf }` | Put a system module into guest memory: a PE32 image whose exports jump to the given targets. `exports` is `{ name, target, ordinal? }[]`; `entryPoint` names the export that is its `DllMain`. |
| `list` | `() => { base, entryPoint, unresolved, name? }[]` | Every image this instance placed, in order. |

### Diagnostics

`status` is `'ready'` always.

| metric | meaning | when it moves |
|--------|---------|---------------|
| `images` | Images placed (`load`, `map`, `synthesise`). | Each placement. |
| `unresolved` | Every unclaimed import across all images. | Each `load`, `bind`, `bindDelayed`. An import nothing implements is not fatal at load time, so this is the only place it surfaces before the guest calls it. |

## 3. How it works

### Parsing (`internal/pe.js`)

`parsePe(bytes)` reads the DOS and PE signatures, requires machine `0x014c` (i386) and the
PE32 optional-header magic `0x10b`, and returns `imageBase`, `entryPointRva`, `sizeOfImage`,
`sectionAlignment`, `sizeOfHeaders`, `subsystem`, `stackReserve`, `stackCommit`, `relocatable`
(a non-empty base-relocation directory), the section table with its read/write/execute bits,
and every data directory. `rvaToFileOffset` maps an RVA through the sections — a section
occupies the larger of its virtual and raw sizes, and RVAs below `sizeOfHeaders` map
one-to-one.

`readImports` walks the import descriptors, reading the lookup table (ILT) or, when a linker
omitted it, the address table (IAT) before anything has overwritten it. Each entry is by name
(hint word then a C string) or by ordinal (top bit set), with the RVA of its IAT slot.

`readExports` reads the export directory by name and by ordinal — separate tables in the file,
joined by an index — and flags a **forwarder**: an export whose address falls inside the
directory itself is a string naming another library's export, not code.

### Mapping and relocation (`internal/image.js`)

`mapImage` allocates a zeroed buffer of `sizeOfImage`, copies the headers and each section's
raw bytes at its virtual address (a raw size larger than the virtual one is clipped), then
`applyRelocations` with `delta = loadBase - imageBase`. Only `IMAGE_REL_BASED_HIGHLOW` (type 3)
is applied; type 0 is padding; anything else throws. An image asked to load away from its
`ImageBase` without a relocation directory throws — plenty of executables of the era cannot be
moved.

Order is enforced by structure: zero, map, relocate, **then** bind. IAT addresses written by
binding are final and must not be shifted by a later relocation pass.

### Binding (`internal/image.js`, `internal/delayload.js`)

`bindImports` writes each resolved address into its IAT slot. An unclaimed import is recorded
rather than refused — a program that never calls it runs — and, if a `missing` hook is given,
the slot receives whatever that returns (typically a stub that reports the name), because a
slot left as the file wrote it holds the RVA of the name block and a call through it dies as
an invalid opcode with nothing naming the import.

`map` and `bind` are separate because a set of libraries that import each other cannot be
bound one at a time: binding the first needs the second's exports. Every image is mapped so
every base and export directory is settled, and only then is anything bound.

Delay-load descriptors are the same shape with one difference: `Attributes` bit 0 says whether
the addresses are RVAs or virtual addresses, and linkers of the era emit virtual addresses with
the bit clear. `readDelayImports` honours the bit and reports everything as RVAs. The tables
are bound **up front**, before the program runs, because a program that delay-loads carries its
own helper, which walks the library's export directory itself and refuses an address outside
that library's image — so the library has to exist in guest memory with the name in its
exports. What is given up is the point of delay loading: a library that would never have been
touched now has to exist.

### Synthesised system modules (`internal/synth.js`)

Patching an IAT covers calls a program makes through its own import table. It does nothing for
a program that resolves a name at run time, walks an export directory itself, or copies the
first bytes of an exported function — and all three are ordinary. So every system library is a
real PE32 DLL image in guest memory: one `.text` section with page-aligned section and file
alignment (so the emitted bytes are simultaneously the file and the mapping), a sixteen-byte
trampoline per export (`jmp rel32` to the bridge stub, padded with `int3`), then the export
directory with its function, name and name-ordinal tables and the strings.

Declared ordinals are honoured exactly and the rest are assigned above them, so an import by
number binds to the function the program compiled against. The name table is sorted so a
loader's binary search over it is correct. Trampolines come before the directory so no function
RVA falls inside the directory's range and reads as a forwarder. An `entryPoint` export
becomes `AddressOfEntryPoint`, for a module that has a `DllMain`.

`synthesise` registers the module as an `IMAGE` region, writes it, and `protect`s it to
`rx`. The returned `addressOf(name)` is the trampoline's address — and because the assembler
binds imports and answers `GetProcAddress` from the same map, the address a program takes at
run time is the one its import was bound to, and the two compare equal as they do on Windows.

### Where system modules go

The assembler places system modules at `0x02000000 + index * 0x00100000` (a megabyte apart) in
the order the layers list their libraries, then maps the libraries a program ships above them
(in dependency order from `planDependencies`, `internal/dependencies.js`: depth-first, a
dependency before what depends on it, cycles visited once, KnownDLL names skipped). A name that
is not a KnownDLL is looked for beside the program even when the engine has a table for it —
that file is what a Windows loader maps, and the table is only the fallback when the program did
not bring one (the set is `win32.knownDlls()`, from Wine's `[KnownDLLs]` registry defaults). The
run-time `LoadLibrary` path makes the same choice in `src/app.js`. Then the assembler places a
`process-startup` arena. The name/base module table (`byName`, `byBase`, `addressOf`,
`addressOfOrdinal`, `attached`) lives in `src/app.js`, not in this layer; `list()` here is the
flat record of what was placed.

### Thread-local storage and process start (`internal/tls.js`, `internal/init.js`)

`readTls` reads the TLS directory: the template bytes and zero-fill size every thread's block
starts from, the RVA of the **index dword** the loader must write its slot number into (left
zero, every lookup reads slot zero, which belongs to whichever image was given it — a wrong
answer rather than a missing one), and the callbacks to run with `DllMain`'s three arguments
before the entry point. All four addresses are stored as virtual addresses against the
preferred base and are converted to RVAs once, here.

`synthesiseProcessInit` emits the guest code that runs before the program's first instruction:
for each library in dependency order, allocate a TLS slot through the guest's own `TlsAlloc`,
write it to the index dword, `TlsSetValue` the prepared block, call each TLS callback, then
`DllMain(hinst, DLL_PROCESS_ATTACH, 1)` — `lpvReserved` is non-null because the library was
linked against, not loaded by name, and a library reads that to choose between two genuinely
different initialisations. The stub ends with a `jmp` to the program's entry. It is guest code
on the process's first thread, as a real loader does it, rather than host-driven callbacks.

### Resources (`internal/resources.js`)

`findResource(bytes, image, type, name, language?)`, `loadString(bytes, image, id, language?)`
and `listResources` read the three-level resource tree. Two traps the code names: every offset
within the tree is directory-relative but the leaf's `OffsetToData` is an RVA; and a named entry
is a counted UTF-16 string with no terminator. Strings live in bundles of sixteen under
`RT_STRING`.

## 4. Limitations and divergences

- **PE32, i386 only.** PE32+ (64-bit), other machines and non-PE files throw at `parsePe`.
- **One region per image, `rwx`.** Section permissions are read but not applied; the image is
  mapped as one span with the widest access. The module's own comment says per-section
  permissions arrive when the loader stops being the only thing writing there.
- **Only `HIGHLOW` relocations**; any other type throws.
- **Imports are bound eagerly**, delay imports included. There is no `LoadLibrary`-time
  binding here; a library loaded by name at run time is the assembler's and `win32`'s business.
- **Forwarders are detected, not followed** by this layer; the resolver is told the string
  through `readExports` and decides.
- **No bound-import, IAT-directory, exception, security, debug or CLR directories** are read.
- **Unresolved imports are not errors at load.** They appear in `unresolved` and in diagnostics; a
  call to one lands wherever `missing` pointed, or on the name block's RVA if no hook was given.
  What the assembler's hook does with the call — answer it or stop the process — is decided by
  the name and the library ([`win32.md`](./win32.md), "From a table to a module").
- **Images are never unmapped**; `list()` and the memory regions only grow.
- **Synthesised modules are console-subsystem DLLs** with one section and no resources,
  version information, or imports of their own; a program inspecting them beyond the export
  directory sees that.
- **Export names must be non-empty ASCII** and unique within a module; a declared ordinal
  must be a positive integer and unique.
- **TLS callbacks are capped at 64** per image — a guard against a missing terminator, not a
  real limit.

## 5. Tests

Unit tests (`npm test`; filter with `node --test src/layers/loader/internal/<file>` from
`modules/core/`). `pe.test.js` and `delayload.test.js` read real fixtures under
`modules/core/test/fixtures/`; the rest build images in memory. None needs an emulator.

| file | kind | covers |
|------|------|--------|
| `internal/pe.test.js` | contract | Headers of a real 32-bit console executable, refusals (no MZ, truncated PE header, wrong machine), import names, RVA translation past raw data, an image without relocations refusing to move, building the image binds the IAT, an unclaimed import is reported, the export directory round-trips the synthesiser's output, a forwarder is a string not code. |
| `internal/synth.test.js` | contract | The image parses as PE32 at its base, directory 0 leads to the exports, every name resolves to a trampoline that jumps to its stub, sorted name table, dense and explicit ordinals with gaps, signed displacements, an export-less module, invalid inputs refused, a pinned-and-assigned mix, an export as the entry point. |
| `internal/delayload.test.js` | contract | RVA versus VA descriptors reading the same, the report shaped like an ordinary import, slots as RVAs, ordinal imports, the terminator, images without the directory, binding both storage forms alike, unclaimed entries left as written or pointed by `missing`, bound/unload tables, multiple descriptors, the module-handle slot untouched. |
| `internal/tls.test.js` | contract | The four addresses come back as RVAs, template and zero-fill, callbacks in order to their terminator, images without callbacks or without TLS, an uninitialised template. |
| `internal/resources.test.js` | contract | Lookup by type and id, the leaf offset being an RVA, counted names, string bundles, absent slots and types, language selection, listing. |
| `internal/dependencies.test.js` | unit | KnownDLL names skipped even with a file beside the program, a non-KnownDLL the engine has a table for loaded from its file, that name not recorded missing when no file exists, shipped libraries found with dependencies first, cycles terminating, a missing library recorded not thrown, one load per library, case-insensitive names. |
| `internal/init.test.js` | unit | Attach order, the final jump into the program, libraries without an entry point skipped, `DllMain`'s three arguments. |

Integration (`npm run test:integration`): every `src/*.itest.js` maps a real fixture
executable through `load`/`map`/`bind` and runs it; `src/hello.itest.js` is the smallest.
`src/imports.itest.js` builds one that imports three names nothing exports and checks what each
stub does to the stack: the decorated and the C-runtime one answer zero and leave ESP right, the
undecorated Win32 one ends the run with a fault naming the import and its caller, and all three
are in `unresolved` at load.
