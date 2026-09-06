# `@bottlify/core` — layer directory layout

Durable, git-tracked record of how `modules/core/src/layers/` is physically organized: naming
conventions, the full directory tree (including the per-DLL/per-backend layout inside `win32`,
`graphics`, `audio`, `input`), and the a few DLLs that don't fit cleanly in one layer. The module
graph itself (`requires`, enforced by `scripts/check-boundaries.mjs`) is documented in
[`README.md`](./README.md) and doesn't change here — this file only records how that graph maps onto
directories inside each already-existing layer.

## 1. Naming conventions

- **No `.dll` suffix in directory names**: `win32/kernel32/`, not `win32/kernel32.dll/`. This is
  what Wine does (`dlls/kernel32/`, `dlls/user32/`, …) — a convention proven on exactly this class
  of problem; a `.dll` suffix on a directory name is visually confused with a file extension.
- **No nesting by guest filesystem path**: not `win32/system32/kernel32/`. Which guest path a DLL
  resolves from (`System32`, `SysWOW64`, the game's own directory) is the concern of
  loader/filesystem at runtime (KnownDLLs, PATH, SxS), not source organization. The source layout
  encodes the implementation boundary, not a fact about the guest filesystem.
- **The layer is called `win32`, not `win`.** "Win32" is the name of the API contract itself, not a
  claim about the guest's bitness: Wine calls it Win32 in 64-bit builds too. Bitness (win64
  someday) is a matter of a given DLL implementation's configuration/build, not a directory rename:
  real DLL names don't change between x86 and x64 Windows.

## 2. The full layer tree

```
modules/core/src/layers/
├── cpu/                  # bridge to v86 — one implementation, the only layer with access to vendor/v86
├── memory/                # address space: regions, permissions, leases — one implementation
├── kernel/                # threads, scheduler, context switch, time, synchronization, handles
│                          #   (this is OUR execution engine — not the guest-facing kernel32 facade, see win32/kernel32/)
├── bridge/                # traps, calling-convention marshaling, callbacks, async parking
├── loader/                # PE: headers, relocations, imports, TLS, in-guest module synthesis
├── log/                   # ✦ levels, categories, ring buffers, sinks
├── filesystem/            # ✦ VFS, OPFS, CoW overlay, sessions, registry
│
├── win32/                 # guest-visible ABI — one directory per DLL
│   ├── kernel32/
│   ├── user32/
│   ├── gdi32/             # device contexts, bitmaps, text — the non-rendering half (see §3)
│   ├── advapi32/
│   ├── ole32/
│   ├── oleaut32/
│   ├── msvcrt/
│   ├── comctl32/
│   ├── shell32/
│   ├── winmm/              # timers/joystick only — the audio half lives elsewhere (see §3)
│   └── winsock/             # a thin stub/error only — the real implementation lives in @bottlify/networking (see §3)
│
├── graphics/               # ✦ sibling of win32 (requires win32+bridge+memory), not nested inside it
│   ├── webgpu/              # our own compositor/presentation backend, no guest DLL
│   ├── gdi/                 # BitBlt/StretchBlt — the rendering half of gdi32.dll
│   ├── ddraw/
│   ├── d3d7/
│   ├── d3d8/
│   ├── d3d9/
│   ├── opengl/
│   └── glide/               # "as needed" — the lowest-priority target class
│
├── audio/                  # ✦ sibling of win32
│   ├── webaudio/            # SAB ring + AudioWorklet, our own backend
│   ├── dsound/
│   ├── dshow/               # video playback
│   ├── winmm/               # waveOut/waveIn/MCI-audio — the audio half of winmm.dll
│   └── msacm/               # audio compression manager; some titles' own audio
│                            #   libraries import it and will not load without it
│
└── input/                   # ✦ sibling of win32
    ├── keyboard/
    ├── mouse/                # including capture and relative movement
    ├── gamepad/              # including a virtual gamepad for touch devices
    └── dinput/
```

The order of directories inside `win32/graphics/audio/input` doesn't dictate implementation order —
that's set by the phase plan (see `CLAUDE.md` for the current phase and the six governing rules).

## 3. Cross-cutting splits: a DLL that doesn't fit in one layer

Three DLLs conceptually belong to `win32`, but really split into two halves: the one that just keeps
OS-level bookkeeping — pure `win32`; the one that actually does something (draws pixels, plays
sound, moves packets) — needs a resource that `win32` can't reach by the dependency graph (`win32`
has no `requires` on graphics/audio/networking).

| DLL         | half in `win32/`                       | half elsewhere                                          |
|-------------|-----------------------------------------|-----------------------------------------------------------|
| `gdi32.dll` | device contexts, bitmaps, text          | `graphics/gdi/` — BitBlt/StretchBlt, the real blitting     |
| `winmm.dll` | timers, joystick                        | `audio/winmm/` — waveOut/waveIn/MCI-audio                  |
| `winsock.dll` | a stub/error code when networking isn't installed | `@bottlify/networking` — a separate npm package, not part of `@bottlify/core` at all |

This isn't a problem invented here — each of these DLLs legitimately belongs both to `win32`'s
enumeration and to the phase that actually implements its working half (winmm's audio half lands
with the audio phase, winsock's real implementation with the networking phase). The layout above
makes that explicit in the directory tree instead of leaving it an implicit overlap between
documents.

## 4. Open questions

- **DX10 isn't in the graphics phase's declared scope.** The current backend order is:
  `ddraw → d3d7 → d3d8 → d3d9 → opengl 1.x/2.x → glide` (targets: WC3, WoW, CS 1.6, titles up to
  2010). If DX10 is a deliberate scope expansion rather than an oversight, it needs writing in
  explicitly before creating `graphics/d3d10/`.
- **The physical mechanism for the gdi32/winmm split.** Two neighboring directories for one guest
  DLL (as above) is the simplest option, but not the only one: an alternative is a single DLL entry
  point in `win32/` that, when an active `graphics`/`audio` module is present, delegates the call
  through an explicit port (not via `requires`, but through something like optional injection at
  `create` time). Decide this before `win32`, `graphics`, and `audio` reach the implementation of
  these specific functions — right now this is only directory layout, behavior hasn't been written
  yet.
