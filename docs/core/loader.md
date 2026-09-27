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
delayload,tls,resources,dependencies,init,mangling}.js`. Of these, only `pe`, `image`, `synth` and
`delayload` are reached through the module API; `tls`, `resources`, `dependencies`, `init` and
`mangling` are pure helpers the process assembler imports directly.

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
| `synthesise` | `({ name, base, exports, entryPoint? }) => { base, size, entryPoint, addressOf, ordinalOf }` | Put a system module into guest memory: a PE32 image whose exports jump to the given targets. `exports` is `{ name, target \| data, ordinal? }[]`; `entryPoint` names the export that is its `DllMain`. |
| `list` | `() => { base, entryPoint, unresolved, name? }[]` | Every image this instance placed, in order. |
| `bindHooks` | `(spec, image, register, resolveHandler, allocate?) => { bound, refused }` | Binds a bundle's sidecar hooks (`internal/hooks.js`) against an image already placed. `allocate` is guest heap room for a `site` entry's trampoline; omit it when `spec` holds only `slot` entries. See "Sidecar hooks" below. |

### Diagnostics

`status` is `'ready'` always.

| metric | meaning | when it moves |
|--------|---------|---------------|
| `images` | Images placed (`load`, `map`, `synthesise`). | Each placement. |
| `unresolved` | Every unclaimed import across all images. | Each `load`, `bind`, `bindDelayed`. An import nothing implements is not fatal at load time, so this is the only place it surfaces before the guest calls it. |
| `hooksBound`, `hooksRefused` | Kernel names bound, and refusal reasons, from the last `bindHooks`. | Each `bindHooks`. |

## 3. How it works

### Parsing (`internal/pe.js`)

`parsePe(bytes)` reads the DOS and PE signatures, requires machine `0x014c` (i386) and the
PE32 optional-header magic `0x10b`, and returns `imageBase`, `entryPointRva`, `sizeOfImage`,
`sectionAlignment`, `sizeOfHeaders`, `subsystem`, `stackReserve`, `stackCommit`, `relocatable`
(a non-empty base-relocation directory), `library` (the COFF header's `IMAGE_FILE_DLL`: only a
library's imports are resolved and its entry point run when a program loads one by name), the
section table with its read/write/execute bits, and every data directory. `rvaToFileOffset` maps
an RVA through the sections — a section occupies the larger of its virtual and raw sizes, and RVAs
below `sizeOfHeaders` map one-to-one.

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
real PE32 DLL image in guest memory: a `.text` section with page-aligned section and file
alignment (so the emitted bytes are simultaneously the file and the mapping), a sixteen-byte
trampoline per export (`jmp rel32` to the bridge stub, padded with `int3`), then the export
directory with its function, name and name-ordinal tables and the strings. An export given
`data` rather than a target is a variable: its address is the bytes, in a `.data` section of its
own on the pages after the code, each aligned like a slot, named in the section table as
initialised read-write data -- the runtime's `_iob`, twenty records, is one of those. A program
and the runtime's own functions both write those variables (a stream's `_flag`, the file mode),
where the code beside them stays read-only; a module that exports no variable is the one
section. An export given `code` is a function that is code of its own -- the C runtime's
compiled `@guestCode` functions ([`win32.md`](./win32.md)) -- placed in `.text` after the
directory's strings, each aligned like a slot: read-only, and on no page a variable shares. A
write from the host moves its page on for cork, and a translation formed from a page that moved
is dropped when it lands, so a function on the page of a variable the host keeps writing (a
standard stream's record in `_iob`) was never translated at all. Such a function's `jumps` name
the displacements in it that are a `jmp rel32` to a guest address -- the host stub a function
hands a call to -- filled in here, where the function's own address is known.

Declared ordinals are honoured exactly and the rest are assigned above them, so an import by
number binds to the function the program compiled against. The name table is sorted so a
loader's binary search over it is correct. Trampolines come before the directory so no function
RVA falls inside the directory's range and reads as a forwarder. An `entryPoint` export
becomes `AddressOfEntryPoint`, for a module that has a `DllMain`.

`synthesise` registers the module as an `IMAGE` region, writes it, and `protect`s it to
`rx`; a `.data` section is a region of its own, `<name> .data`, left `rw`. The returned
`addressOf(name)` is the trampoline's address — and because the assembler binds imports and
answers `GetProcAddress` from the same map, the address a program takes at run time is the one
its import was bound to, and the two compare equal as they do on Windows.

### Where system modules go

The assembler places system modules at `0x02000000 + index * 0x00100000` (a megabyte apart) in
the order the layers list their libraries, then maps the libraries a program ships above them
(in dependency order from `planDependencies`, `internal/dependencies.js`: depth-first, a
dependency before what depends on it, cycles visited once, KnownDLL names skipped, and the
executable's own file name counted as already there, as Windows looks in the loaded-module list
before the disk -- a library that imports from the program is bound to the program itself, not to
a second copy read off the volume whose entry point would run the program's start-up as a
`DllMain`). Every shipped library is mapped before any is bound, and they are bound after the
program's own image is mapped and known by name. A library goes at the next base nothing holds
if it carries relocations; one without relocations goes at its own preferred base when that lies
in the modules' space and nothing holds it, and is otherwise refused and reported missing, as the
PE format says a loader refuses an image whose base is not available. Nothing is placed at or
above the pool of thread stacks: a library that does not fit below it is refused as `no room`,
whether the program shipped it or loads it at run time. A name that is not a KnownDLL is
looked for on the volume, even when the engine has a table for it — that
file is what a Windows loader maps, and the table is only the fallback when the program did not
bring one (the set is `win32.knownDlls()`, from Wine's `[KnownDLLs]` registry defaults). The
redistributable runtimes a layer stands in for -- `audio.runtimes()` (the MPEG provider a sound
library loads by full path out of its own directory) and `media.runtimes()` (the JPEG library) --
are answered from the table the same way, whoever's copy the program brought: that is the decision
that such a runtime is ours (`roadmap/decisions.md`), and a copy found first runs the whole decoder
as emulated x86 (`answeredByEngine` in `src/app.js`). The
search order is `libraryCandidates` in `src/app.js`: the program's own directory first, then
`C:\WINDOWS\system32\` and `C:\WINDOWS\`, which is where a title's DirectX setup puts the runtime —
so a title that imported `d3dx9_26.dll` without shipping one, once its installer has run, is bound
to the real redistributable in `system32`, not to the engine's `d3dx9_*` table. The run-time
`LoadLibrary` path makes the same choice. Then the assembler places a `process-startup` arena where a library would fit.
The name/base module table (`byName`, `byBase`, `addressOf`, `addressOfOrdinal`, `attached`,
`loaded`, `references`) lives in `src/app.js`, not in this layer; `list()` here is the flat record
of what was placed. Whether a library is loaded, which `GetModuleHandle` and `PEB->Ldr` answer
about, how `LoadLibraryEx`'s flags map a library, and how `FreeLibrary` unloads one are the
assembler's too ([`win32.md`](./win32.md), "The process model").

The program's own image is in that table too, known by its file name as well as its base: a
program that loads or asks for a handle to itself by name is handed the mapping it is already
running from, as Windows hands back a module already loaded rather than a second copy at the one
base an image without relocations can take. Its export directory is read the same way a shipped
library's is, so an export a program declares for itself binds and resolves by name and by
ordinal, whether the caller is `GetProcAddress(GetModuleHandle(NULL), ...)` or another module's
import of the program that loads it (`src/app.js`, `buildApp`).

### Sidecar hooks (`internal/hooks.js`)

A bundle may carry `hooks.json` (and a matching `hooks.mjs`) next to its `manifest.json`,
outside the bundle itself. `bindHooks(spec, image, register, resolveHandler)` binds each entry
of `spec.hooks` against `image` -- the name, base, `sizeOfImage` and `timeDateStamp` of what was
actually loaded, from whoever assembles the process -- and reports what it bound and what it
refused; this layer names no title and knows nothing of what a hook computes.

`bindHooks` is called once per image the process places -- the program image first, then each
library the bundle shipped, then every library the program loads at run time, the moment it is
mapped and before its `DllMain` runs -- and binds the entries addressed to that image. An entry
addressed to an image not yet placed is neither bound nor refused but *pending*, reported as
`hooksPending` in the diagnostics until the image it names is placed (a mismatched `imagePath`
basename therefore shows as a kernel that stays pending, never as one bound). The results
accumulate across calls: `hooksBound`/`hooksRefused` list every image's outcome. One addressed to
`image.name` (case-insensitively) is checked, in order, and refused with a reason the moment any of
these does not hold, each a former silent corruption were it not: the loaded image's
`timeDateStamp`/`sizeOfImage` must equal the entry's `check` (`planHook`, `internal/hooks.js`) --
a hook for a build this is not is refused rather than patched blind; the guest word currently at
`image.base + entry.slot.rva` must equal `image.base + entry.target.rva` -- the slot must still
point at the function the sidecar disassembled, or something already changed it and a second
change would compound on top of an assumption nobody checked; and `entry.convention.registers`
must have exactly two entries -- FASTCALL with `this`, the one convention `bridge.hook` marshals
today. A refused entry's kernel is named in the reason string, in `hooksRefused`.

A bound entry calls `resolveHandler(entry)` for what the hook actually does -- typically a lookup
into the bundle's `hooks.mjs` module by `entry.kernel` -- and, given a handler, `register({ name,
argBytes, target, handler })`, which the assembler wires to `bridge.hook`. The stub address
`register` returns -- a number, exactly what `bridge.hook` answers -- is written into the slot
with `memory.writeU32`; an answer that is not a nonzero integer (`bridge.hook` answers 0 once
disposed) is refused and named, and the slot keeps the guest's own function. The bundle's own
image is never touched, only the one data word the sidecar named.

**A `site` entry**, the second form, replaces one loop or span inside a function rather than a
whole function reached through a slot -- for a static function taken by `call rel32` from inside
its own module, under a compiler-private register convention no vtable or import ever names:

```json
{
    "image": "program.exe",
    "check": { "timeDateStamp": "0x414221a3", "sizeOfImage": "0x271f000" },
    "site": { "rva": "0x73676", "bytes": "8b 57 04 8b 07 8b 4b 30", "lengths": [3, 2, 3] },
    "resume": { "rva": "0x737a3", "bytes": "8b 0d d8 82 a5 02", "stackAdjust": 8 },
    "function": { "rva": "0x734f0", "bytes": "83 ec 3c 8b 15 40 0e 2e" },
    "kernel": "loop.faces",
    "mode": "replace"
}
```

`bindHooks` checks a `site` entry (`planSiteHook`, `internal/hooks.js`) the same way as a `slot`
entry -- the image name and the `check` -- plus three byte pins rather than one, since a site is
mid-function and depends on the compiler's own register allocation there, unlike a slot's data
word: the bytes at `image.base + site.rva` must equal `site.bytes`, the bytes at `resume.rva` must
equal `resume.bytes`, and the bytes at `function.rva` must equal `function.bytes` -- a pin on the
function the site sits inside of, since the same site bytes could in principle recur elsewhere.
`site.lengths` must sum to `site.bytes`' own length and be at least five (the minimum a near jump
needs to replace), and the displaced instructions it describes must hold no relative branch (a
near call or jump, a short jump, a two-byte conditional jump) -- none of these can be moved to a
trampoline. Any failure refuses the entry by kernel name, naming which pin or check failed.

A bound `site` entry allocates a trampoline through the `allocate` callback -- the displaced bytes
plus a jump back to `site.rva + displacedLength`, the same shape a diagnostic watch's own
trampoline takes (`app.js`'s `debug.hook`) -- then `register({ name, site: true, trampoline,
resume: image.base + resume.rva, stackAdjust: resume.stackAdjust, handler })`, which the assembler
wires to `bridge.siteHook`. The site itself is then patched: a near jump to the stub address
`register` answered, padded with `nop` out to `displacedLength`, written through
`memory.protect`/`memory.writeBytes`/`memory.protect` -- the same discipline a diagnostic watch's
code patch uses, even though the program image is already `rwx` today and the protect toggle is a
no-op. Since the image is executable, the write routes through the emulator's own physical-memory
path and invalidates whatever was compiled from the bytes underneath; binding happens once, before
the program's first instruction runs, so nothing is compiled yet to discard. `allocate` may be
omitted by a caller whose spec holds only `slot` entries; a `site` entry bound with no `allocate`
is refused by name rather than throwing.

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

### Decorated C++ names (`internal/mangling.js`)

`mangledCall(name)` reads a Visual C++ decorated name (`?...`) for what a stub standing in for it
must know: its calling convention, from the convention letter, and how many bytes of arguments the
callee pops -- the sum of its parameters' sizes, a member's `this` travelling in `ECX` for
`thiscall`, the hidden pointer a class returned by value goes through, and nothing for `cdecl`.
Only as much of the grammar is read as it takes to find where each parameter ends: names,
templates, pointers and references to anything, and the back-references that shorten a repeated
one. What the name does not carry -- the size of a class passed or returned by value, whether a
constructor takes the flag a class with virtual bases passes to it -- answers `argBytes: null`, not
a guess. A name that is not a decorated function answers `null`.

### Resources (`internal/resources.js`)

`findResource(bytes, image, type, name, language?)`, `loadString(bytes, image, id, language?)`
and `listResources` read the three-level resource tree. Two traps the code names: every offset
within the tree is directory-relative but the leaf's `OffsetToData` is an RVA; and a named entry
is a counted UTF-16 string with no terminator. Strings live in bundles of sixteen under
`RT_STRING`. A language named is that language alone; none named is LANG_NEUTRAL, the search
Windows makes: `UI_LANGUAGE` (0x0409, the answer `GetUserDefaultUILanguage` gives, read from here),
its primary language with `SUBLANG_NEUTRAL`, 0x0000, 0x0400, English, and only then the first
entry -- so a program carrying its dialogs and strings in many languages gets en-US rather than
whichever sorts first. `FindResource`, `LoadString`, dialogs and menus all look up this way.

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
- **This layer never unmaps an image**; `list()` only grows. A library the program loaded by
  name and freed for the last time is unmapped by the assembler, its region given back to the
  memory layer.
- **Synthesised modules are console-subsystem DLLs** with a code section, a data section when
  they export a variable, and no resources, version resource or imports of their own; a program
  inspecting them beyond the export directory sees that. (`VERSION.dll` answers a version block
  for them all the same; see [`win32.md`](./win32.md).)
- **Export names must be non-empty ASCII** and unique within a module; a declared ordinal
  must be a positive integer and unique.
- **TLS callbacks are capped at 64** per image — a guard against a missing terminator, not a
  real limit.
- **One convention per hook.** `bindHooks` refuses any `convention.registers` other than exactly
  two; a stack-only or single-register hook is not built today.
- **A hook's fallback is a redirect, not a call frame `bindHooks` builds.** `register`'s caller
  (the bridge) decides what happens at `target`; this layer only validates the sidecar and moves
  the one guest word.
- **A site entry's trampoline and patch are `bindHooks`' own, not the bridge's.** Only the guest
  word write is common between the two forms; a site entry additionally allocates a trampoline and
  writes a code patch here, before ever calling `register`.
- **No in-browser oracle for a site hook.** A slot hook's kernel may compare its own answer against
  the guest's *at the next crossing it sees* (unsound for some write targets; see
  [`bridge.md`](./bridge.md) "Slot hooks"); a site hook has no return value and no single write
  target to compare that way. A site kernel is checked offline instead, against the real function
  in the real emulator, before it is ever bound in `replace` mode.
- **A `site` patch and a `debug.hook` watch must not overlap.** `debug.hook` relocates a routine's
  opening bytes off a disassembly supplied when it is called, and a site's patch changes what is
  actually there; a watch whose displaced span ends inside a site's eight patched bytes would
  relocate part of the site's own jump. The hazard is the same one self-modified code already
  poses to any watch — a stale disassembly — and is not guarded against in code.

## 5. Tests

Unit tests (`npm test`; filter with `node --test src/layers/loader/internal/<file>` from
`modules/core/`). `pe.test.js` and `delayload.test.js` read real fixtures under
`modules/core/test/fixtures/`; the rest build images in memory. None needs an emulator.

| file | kind | covers |
|------|------|--------|
| `internal/pe.test.js` | contract | Headers of a real 32-bit console executable, refusals (no MZ, truncated PE header, wrong machine), import names, RVA translation past raw data, an image without relocations refusing to move, a program not a library until its COFF header says `IMAGE_FILE_DLL`, building the image binds the IAT, an unclaimed import is reported, the export directory round-trips the synthesiser's output, a forwarder is a string not code. |
| `internal/synth.test.js` | contract | The image parses as PE32 at its base, directory 0 leads to the exports, every name resolves to a trampoline that jumps to its stub, sorted name table, dense and explicit ordinals with gaps, signed displacements, an export-less module, invalid inputs refused, a pinned-and-assigned mix, an export as the entry point, variables in a writable data section apart from the code, a function that is code of its own in `.text` below every variable's page and never also a variable. |
| `internal/mangling.test.js` | contract | A C runtime class's member is `thiscall` popping its parameters only, a class returned by value goes through a hidden pointer, `stdcall` pops every parameter (eight bytes for the wide ones), `fastcall` only what did not fit in `ECX` and `EDX`, `cdecl` nothing; what the name does not carry is not known, and a name that is not a decorated function is not read as one. |
| `internal/delayload.test.js` | contract | RVA versus VA descriptors reading the same, the report shaped like an ordinary import, slots as RVAs, ordinal imports, the terminator, images without the directory, binding both storage forms alike, unclaimed entries left as written or pointed by `missing`, bound/unload tables, multiple descriptors, the module-handle slot untouched. |
| `internal/tls.test.js` | contract | The four addresses come back as RVAs, template and zero-fill, callbacks in order to their terminator, images without callbacks or without TLS, an uninitialised template. |
| `internal/resources.test.js` | contract | Lookup by type and id, the leaf offset being an RVA, counted names, string bundles, absent slots and types, language selection, listing. |
| `module.test.js` | unit | A synthesised module's variables a writable region beside its read-only code; `bindHooks` on a stub machine: a good entry writes the registered stub address into the slot, a check mismatch and a wrong slot value are each refused and counted with nothing registered, an entry for another image is refused by name, a kernel `resolveHandler` does not provide is refused by name; a `site` entry (a three-`mov`, no-branch fixture): a good one allocates a trampoline and patches the site with a jump to the registered stub, a byte-pin mismatch leaves the site untouched and refused by name, a kernel nothing provides and a registration answering no address are each refused, an entry with no `allocate` is refused rather than throwing, and one wired to the real `bridge.siteHook` writes the address the bridge itself answered. |
| `internal/dependencies.test.js` | unit | KnownDLL names skipped even with a file beside the program, a non-KnownDLL the engine has a table for loaded from its file, that name not recorded missing when no file exists, shipped libraries found with dependencies first, cycles terminating, a missing library recorded not thrown, one load per library, case-insensitive names, a library importing from the program bound to the program rather than given a copy of it. |
| `internal/hooks.test.js` | contract | `planHook`'s decision: a good entry resolves the slot and target against the loaded base, a wrong image name, a `timeDateStamp`/`sizeOfImage` mismatch, a slot not holding the target, an unsupported convention; `planSiteHook`'s decision on the same real bytes: a good entry resolves the site and resume addresses, a wrong image name, a stale build, each of the three byte pins failing named, `site.lengths` not summing to the site bytes, a sum under five bytes, a relative branch among the displaced instructions; `parseHexBytes` round-trips a hex string. |
| `internal/init.test.js` | unit | Attach order, the final jump into the program, libraries without an entry point skipped, `DllMain`'s three arguments. |

Integration (`npm run test:integration`): every `src/*.itest.js` maps a real fixture
executable through `load`/`map`/`bind` and runs it; `src/hello.itest.js` is the smallest.
`src/imports.itest.js` builds one that imports four names nothing exports and checks what each
stub does to the stack: the decorated one, the C-runtime one and a `thiscall` member of a C
runtime class answer zero and leave ESP right (the member having popped its one argument), the
undecorated Win32 one ends the run with a fault naming the import and its caller, and all four
are in `unresolved` at load.
