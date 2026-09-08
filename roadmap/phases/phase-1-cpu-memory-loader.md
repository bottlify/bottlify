# Phase 1 — CPU, memory, loader. Roadmap

> Working document for the phase. Source of truth is `../00-bottlify-master-plan.md` (below: Master
> Plan). Phase 0 is closed — its plan is `phase-0-skeleton.md` / `phase-0-core-module.md`, and the
> directory layout conventions are `docs/core/infrastructure.md`.

## 0. What Phase 1 is

Phase 1 = "CPU, memory, loader" from the Master Plan: the bridge to v86, memory regions with
permissions and typed accessors, a PE loader, and the minimal kernel32 surface a console
application needs.

**Phase acceptance (Master Plan):** a native 32-bit `hello.exe` prints to the console and exits
correctly. The test is reproducible and runs in CI.

Everything about scheduling, threads and preemption is Phase 2; the full call bridge (marshaling,
callbacks, async parking) and the wide Win32 surface are Phase 3. This phase is deliberately
single-threaded.

## 1. Decisions fixed on entry

These were settled by measurement, not argument — a throwaway spike drove real v86 with each of
them before they were written down (Master Plan §16.1: a hypothesis is built on data).

| decision | value | evidence / consequence |
|---|---|---|
| boot path | **no SeaBIOS**: our own 64 KiB boot ROM passed as `bios: { buffer }` | v86 loads a bios image at `0x100000 - size`, so 64 KiB lands at `0xF0000` and the reset vector `F000:FFF0` falls inside it. Spike: 18 instructions executed in total — all ours, zero BIOS code |
| protected mode | entered by **our own stub executing real instructions** (`lgdt` → `CR0.PE=1` → far jump), not by poking CPU internals | v86's derived segment/descriptor caches stay consistent by construction. Spike: `CR0.PE=1`, flat 4 GiB code/data segments, 32-bit code writes RAM and it reads back through `read_memory` |
| guest → host trap | **I/O port write** (`OUT dx, eax`) with a handler registered via `cpu.io.register_write` | Spike: value `0x12345678` arrived intact in the JS handler. This is the minimal bridge slice; the real `bridge` layer stays Phase 3 |
| access to v86 internals | `emulator.v86.cpu` / `cpu.io`, confined to `layers/cpu` | Already the rule ("only cpu may touch vendor"), enforced by `check:boundaries`. A cleaner exposed accessor is a candidate patch for our fork (Master Plan §8.1) |
| execution quantum | **not in this phase** | The instruction-counted quantum (§12.2) is the scheduler's concern, i.e. Phase 2. `get_instruction_counter()` already reports exact counts when Phase 2 needs it |
| local v86 build | **prebuilt artifacts for development**; the reproducible Docker build stays a CI-only gate | The dev machine has no `rustc`/`cargo`/`clang`/`make` and Docker is unavailable/unreliable there. CI (Linux) runs the `vendor` job unchanged |

Consequence of the last row worth stating plainly: `dist/vendor/` is a build output, and a developer
without the toolchain consumes it rather than producing it. Nothing about the reproducibility
guarantee changes — it just lives where it can actually run.

## 2. Structure at the end of the phase

```
modules/core/src/layers/
├── cpu/
│   ├── api.js            # interface: boot/run/stop, registers, physical memory, traps
│   ├── module.js         # BottlifyModule (no longer a stub)
│   ├── config.js         # memory size, trap port, boot ROM parameters
│   ├── diagnostics.js
│   └── internal/
│       ├── v86-host.js   # the ONLY file that knows about vendor/v86
│       ├── boot-rom.js   # generates the 64 KiB ROM: GDT, 16-bit init, protected-mode entry
│       └── traps.js      # I/O port trap channel: registration and dispatch
├── memory/
│   ├── api.js            # regions, permissions, typed accessors
│   └── internal/{regions.js, accessors.js}
├── loader/
│   ├── api.js            # load a PE image into guest memory
│   └── internal/{pe-headers.js, sections.js, relocations.js, imports.js}
└── win32/kernel32/       # the minimal console surface (see P1.5)
```

Per-DLL layout inside `win32/` follows `docs/core/infrastructure.md`.

## 3. Steps

### P1.1 — cpu: cold start into protected mode

`layers/cpu` stops being a stub. Generates the boot ROM (GDT + 16-bit init + 32-bit entry), builds
the v86 instance, exposes: `boot(config)`, `run()`, `stop()`, `readReg32/writeReg32`,
`readPhysical/writePhysical`, `diagnostics()`.

**Done when:** a test boots the CPU with no SeaBIOS, asserts `CR0.PE` is set and segments are flat,
executes a known stub, and reads the value it wrote back out of guest memory.

### P1.2 — cpu: trap channel

An I/O port as the guest→host call channel: registration, a dispatch table keyed by trap id, and a
register snapshot handed to the handler (the guest passes the trap id and arguments through
registers/stack).

**Done when:** guest code performing `OUT` reaches a registered handler, which sees the trap id and
can both read and write the guest's registers.

### P1.3 — memory: regions and typed accessors

The region registry and validator (Master Plan §8.2, §13.1): region kinds, permissions, typed
accessors instead of raw byte-array indexing, and validation of application-supplied pointers.
Allocation and leases beyond what the loader needs are not in this phase.

**Done when:** regions can be registered and looked up; typed read/write works; an access outside a
region, or one violating its permissions, is rejected in the debug build.

### P1.4 — loader: PE32

Parsing and mapping a PE32 image: headers, section mapping with permissions, base relocations,
import resolution (by name and by ordinal), and the TLS directory. Imports resolve to trap thunks —
each imported function gets a guest-side address that traps to its host implementation.

**Done when:** a checked-in PE fixture is mapped into guest memory, its imports are bound to thunk
addresses, and its entry point is known. Unit tests cover the parsing paths directly.

### P1.5 — win32/kernel32: the minimal console surface

Determined empirically from the fixture's import table rather than guessed: at minimum
`GetStdHandle`, `WriteFile`/`WriteConsoleA`, `ExitProcess`, plus whatever the CRT startup actually
pulls in (`GetCommandLineA`, `GetModuleHandleA`, `GetProcAddress`, `GetStartupInfoA`, the heap
functions, …). Console output goes to the `log` module, which is where a host-side test can observe
it.

**Done when:** the guest's writes to stdout arrive on the host side, and `ExitProcess` cleanly ends
the run with the guest's exit code.

### P1.6 — acceptance

The fixture is **generated, not compiled**: `tools/make-pe.mjs` writes a 1 KiB PE32 console
executable byte by byte (`modules/core/test/fixtures/hello.exe`). No toolchain is needed to
reproduce it, and every byte in the file is accounted for by that script.

What keeps this honest rather than circular — testing our loader against our own idea of PE —
is that **real Windows is the oracle**: the same binary runs natively and prints the same line
(verified: exit code 0, `Hello from Bottlify`). A fixture that only our loader accepts would be
worthless; this one is accepted by the reference implementation first.

**Done when:** the fixture runs under Bottlify and produces the same output it produces on
Windows, with the guest's exit code intact, in CI. (The native half of that comparison only runs
on a Windows host; CI is Linux, so there it is the recorded expectation.)

## 4. Order and dependencies

P1.1 → P1.2 → P1.4; P1.3 can proceed in parallel with P1.2 once P1.1 exists (the loader needs it).
P1.5 needs P1.2 and P1.4. P1.6 closes the phase.

## 5. Deliberately NOT in Phase 1

- Threads, scheduler, context switching, the instruction-counted quantum — Phase 2.
- The full `bridge` layer: calling-convention marshaling, guest callbacks, async parking — Phase 3.
  This phase has exactly one trap shape (a synchronous call that returns).
- The wide Win32 surface (user32, gdi32, advapi32/registry) — Phase 3; the filesystem module and
  sessions — Phase 4. `hello.exe` touches neither disk nor registry.
- Breakpoints and the full harness verb vocabulary — grown from real debugging need
  (Master Plan §16.7), not built speculatively here.
- Any real-mode/BIOS service emulation: nothing in the execution model needs it (§1).

## 6. Open questions

- **How is the trap id passed?** Encoded in the port number, in a register, or in the thunk's own
  code — decide during P1.2 with the thunk layout from P1.4 in view, since the two have to agree.
