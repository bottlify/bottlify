# What is left to carry over

`carried-knowledge.md` records the *lessons* taken from the earlier tree. This file records the
*work*: which pieces of that tree have been rebuilt here, which are deliberately not going to be,
and what remains. It is a checklist, not a design document, and it is expected to shrink.

Nothing here is copied. Every entry means "rebuild this against our contracts", and the earlier
tree is read for what the API does and what a real program needs, never for how to write it.

---

## Already rebuilt

| What it was there | Where it lives here |
|---|---|
| Thread and process blocks | `layers/win32/kernel32/teb.js` |
| Exception dispatch | `layers/win32/kernel32/seh.js`, `layers/win32/msvcrt/seh.js` |
| PE loading, imports, relocations, forwarders | `layers/loader/internal/` |
| Call thunking and marshalling | `layers/bridge/internal/` |
| Synthesised in-guest system modules | `layers/loader/internal/`, `layers/win32/` |
| The module registry | `src/system/registry.js` |
| A dirty-range tracker for buffer uploads | `layers/graphics/webgpu/internal/buffers.js` |
| Host access to the x87 stack | `layers/cpu/internal/fpu.js` |

---

## Not going to be rebuilt, and why

Only Windows system libraries are reimplemented. Anything a game ships in its own directory is
mapped and executed as real x86 code, which is what the loader is for. So these are read for
knowledge and never implemented:

`mss32`, `bass`, `openal`, `a3d`, `binkw32`, `smackw32`, `glide2x`, `galaxy`, `d3dx9`.

A title that needs one of them needs the loader to run it, not a reimplementation of it. If one of
them fails, the defect is in a generic layer underneath — that is rule 4, and it has held every
time so far.

The just-in-time compiler, the ahead-of-time cache and the differential oracle from that tree were
read only at the level of their commit messages. They are a substantial body of work and worth a
second pass, but only once something here needs to be fast; nothing does yet.

---

## Remaining, in the order the target titles ask for it

### 1. System libraries with nothing behind the name

`ntdll` first: a C runtime routes its allocator through `RtlAllocateHeap`, and its exception
handling through `RtlUnwind`. Then `shlwapi` and `oleaut32`, which COM-heavy code reaches for.

After those, roughly by how likely a title is to call them at all: `msvfw32`, `avifil32` and
`quartz` (video playback, where the codec itself ships with the game); `gdiplus` and `msimg32`;
`glu32`; `dbghelp` and `imagehlp`; `crypt32`; `iphlpapi`, `mpr` and `netapi32`; `msacm32`;
`setupapi`, `winspool`, `uxtheme`, `secur32`, `wintrust`, `oleacc`, `oledlg`.

The alternative C runtimes are their own group: `msvcp60`, `msvcp90`, `msvcr90`, `crtdll`. A
program links whichever one it was built against, and they are not interchangeable.

### 2. The loader's remaining pieces

- **Library name aliasing.** A program asks for a name that is not the one on disk, and the
  resolution rules are not obvious from the name alone.
- **Process creation.** `process-creation.md` is the plan; it was being implemented when this line
  was last checked (`kernel/internal/processes.js`, `win32/kernel32/spawn.js`).
- **Stack cleanup derived from a decorated name.** The only way to give an unknown export a stub
  that pops the right number of bytes, and small enough to be worth doing before it is needed.

### 3. Measurement

The frame pacer, the phase profiler, the frame-variance diagnostics, the lock tracker and the boot
timer. Rule 6 says these are built alongside the work, not after it, and the register in
`carried-knowledge.md` is unambiguous that in this domain a defect is found by measurement
rather than by reading code.

### 4. Diagnostics that check us against the specification

An argument-size checker exists (`tools/check-argbytes.mjs`). Still missing: the interface
validator for the drawing APIs, a metadata parser to check signatures in bulk, and the API coverage
census over a bundle — with the caveat `carried-knowledge.md` attaches to it, that a census
predicts nothing about whether a program will actually run.

### 5. The harness

The log hub, the symbol map, breakpoints by address and by API name, and the recorder. What exists:
`tools/launch-probe.mjs` for everything before a device is asked for, `tools/cdp_test/game.mjs` for
a real title in a browser with a GPU, and one journal carrying what the engine reports. Breakpoints
by address and by API name, and the recorder, do not exist.

### 6. Runtime services

Windowing, input routing, the dialog bridge and the archive reader.

### 7. Whole packages, each its own body of work

- **Container formats** — the installer readers. This is what turns a purchased copy into something
  this engine can mount. *Not started.* The other route to the same place is built: `@bottlify/installer`
  runs a distribution's own installer and keeps what it wrote (`../phases/phase-8-installers.md`).
- **Networking** — *partly built.* The guest-side socket bridge and the relay exist
  (`../phases/phase-9-networking.md`); the room manager, DirectPlay and `WSAAsyncSelect` do not.
- **Gamepad support.** *Done* — keyboard, mouse and gamepad reach the guest.
