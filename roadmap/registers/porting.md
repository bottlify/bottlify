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

A title that needs one of them needs the loader to run it, not a reimplementation of it. For
`d3dx9` this now has a mechanism rather than only a title's own copy: the engine ships the June
2010 DirectX End-User Runtime as a read-only system volume and the loader runs the real
`d3dx9_24…43.dll` from it whenever a program does not bring its own — so a title need not ship the
redistributable itself. The engine's own `d3dx9_25`/`d3dx9_26`/`d3dx9_27` function tables
(`layers/win32/d3dx9/`) still exist and still answer a program that ships neither the real DLL nor
finds the system volume mounted, but are shadowed by the real DLL the moment the volume is present
— the tables are the fallback now, not the primary path, and whether they are worth keeping once
the volume is always mounted is for the master plan to decide. If one of the other libraries
fails, the defect is in a generic layer underneath — that is rule 4, and it has held every time so
far.

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
`glu32`; `dbghelp` and `imagehlp`; `crypt32`; `iphlpapi` and `netapi32`; `msacm32`;
`setupapi`, `uxtheme`, `secur32`, `wintrust`, `oleacc`, `oledlg`.

`crypt32` (certificate stores, `CertOpenStore` and friends) is still one of these; `advapi32`'s own
CryptoAPI provider is not — hashing (MD5, SHA-1, SHA-256), RC4 and `CryptVerifySignatureA`, a real
RSA PKCS#1 v1.5 verification over a public key, already exist there (`layers/win32/advapi32/`),
because they are `advapi32`'s own exports (`CryptCreateHash`, `CryptEncrypt`, …), not `crypt32`'s.
`CryptGenKey` and `CryptSignHashA` still answer as a provider with no private key would — the
first hands out only a session key, the second fails with `NTE_BAD_KEY` and a divergence naming
the reason — since generating an RSA key pair is not built. `mpr` and `winspool` are built too,
both answering the state a title without a network share or a printer sees (`layers/win32/mpr/`,
`layers/win32/winspool/`).

The alternative C runtimes are their own group: `msvcp60`, `msvcp90`, `msvcr90`, `crtdll`. A
program links whichever one it was built against, and they are not interchangeable.

### 2. The loader's remaining pieces

- **Library name aliasing.** A program asks for a name that is not the one on disk, and the
  resolution rules are not obvious from the name alone.
- **Process creation.** `process-creation.md` is the plan; the replacement model it describes is
  built (`kernel/internal/processes.js`, `win32/kernel32/spawn.js`), and a redistributable
  installer is answered as a child that has already finished rather than handed over to. What
  remains is the case the register calls "two machines": a parent that must resume once its child
  has finished, rather than being replaced by it.
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
  runs a distribution's own installer and keeps what it wrote (`../phases-history.md` (Phase 8)).
- **Networking** — *partly built.* The guest-side socket bridge and the relay exist
  (`../phases-history.md` (Phase 9)); the room manager, DirectPlay and `WSAAsyncSelect` do not.
- **Gamepad support.** *Done* — keyboard, mouse and gamepad reach the guest.
