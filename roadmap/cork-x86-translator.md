# Cork — the user-mode x86 translator that replaces the vendored emulator

**Status:** decided 2026-09-20, not yet started. This document is the design and the plan; the
first milestone below is where the work begins.

## 1. Why

Graphics run on the machine's GPU, so every title is bound by the processor side: how fast the
program's own x86 code runs. Today that is the vendored full-system emulator (`v86`, forked and
patched), which translates x86 to WebAssembly one basic block at a time. Measured on a 2004 OpenGL
title's held views, on an Apple M4 Pro:

| view | guest instructions/s | ns per instruction | of the frame |
|---|---|---|---|
| plain corridor | 430 M | 2 | 58 of 92 ms |
| GUI-heavy room (x87, GUI layout) | 143 M | 3 | 34 of 72 ms |
| lit scene, after two per-title kernels | 394 M | 1 | 30 of 56 ms |

A processor of the title's own era retired 3–4 G instructions/s on the same code. So the
emulator runs this class of program **10–25× slower than the hardware it was written for**, on a
machine that would run the same code natively 5–10× faster than that hardware. The gap is a
factor of about a hundred, and it is where the product's frame budget goes.

The gap is structural, not a matter of patches:

- One x86 instruction becomes ~30 wasm operations (measured with the emulator's own opstats),
  which the browser then compiles again; a second translation layer over a first that already
  lost the shape of the code.
- Every load and store goes through address translation and a TLB, because the emulator is built
  to run an operating system with paging. This machine's guest has no paging: the address space is
  flat and identity-mapped from the first instruction.
- x87 is emulated as a register stack in memory, one instruction at a time; SSE is emulated lane by
  lane. Programs of the era are x87-heavy (47 % of JIT time on the GUI-heavy view above).
- Translation units are pages, invalidated as pages; register values are not carried across
  blocks; code that fails the translator's conditions runs interpreted at 50–100 ns per
  instruction.
- Every host call is a trap out of wasm into JavaScript and back, about 1 µs — the cost of 3 000
  instructions — and a 3D title of the era makes 25–30 thousand of them per frame.

Patching the emulator's generator (an x87 stack tracker, SSE inlining, memory fast paths) has
been measured at single-digit to low-double-digit percent each, and every patch fights the
emulator's own invariants for a system it must still be able to boot. The per-title kernels that
bought the third row above are a workaround for one program, not a property of the engine.

**Goal:** 0.5–1 ns per instruction on the code programs actually run — 3–5× today, at or above
the speed of the processor the programs were written for — as a property of the engine, for
every title. Two to three times is the floor that makes the current library playable; the design
below is sized for the larger figure because the same work delivers it.

## 2. What cork is

Cork is a **user-mode x86-32 → WebAssembly translator with a runtime**, built as the engine's
`cpu` layer. It is not an emulator of a computer. It translates the program's code ahead of
execution into wasm functions that the browser compiles to native code, and it runs those with
the guest's flat memory as their memory. JavaScript is the compiler, never the processor: nothing
of cork's own JavaScript runs inside a hot loop.

Scope of the instruction set: what 32-bit Windows programs of 1995–2008 actually execute —
general-purpose integer, x87, MMX, SSE, SSE2 (SSE3/SSSE3 as found), the string instructions,
`cpuid`, `rdtsc`, the few system instructions a user-mode program touches (`fs:` segment reads
for the thread block, `cli`/`sti`/`in`/`out` only as the traps this engine already defines). The
decoder refuses what it does not know and reports it by opcode, so the set grows from measured
need, never by guess.

The name: a cork is what keeps the program in the bottle. The layer stays `cpu`; cork is what is
behind it, as the emulator is today.

## 3. What is taken from the vendored emulator, and how

The emulator is BSD-2 licensed; taking code from it would be lawful with attribution. This
project's rule is that engine code is written fresh against a contract, with reference material
answering "how does this behave", never "how do I write this" — and that rule holds here. What
is taken is knowledge and test data, not source:

- **Instruction semantics and the corner cases** the emulator's decoder tables and instruction
  implementations encode: flag results per instruction, the x87 exceptions and precision
  behaviour, undefined-flag conventions programs depend on, the MMX/x87 register aliasing, the
  `rep` prefix edge cases. Read from the source, written into cork's own tables and tests.
- **The nasm instruction test corpus** (`tests/nasm`, 135 cases with expected register state):
  reused as test data — an oracle input, not code — with its attribution in
  `THIRD-PARTY-NOTICES.md` when the first case is imported.
- **The emulator itself as an oracle.** This is the largest single asset: a second, independent
  implementation of every instruction cork will implement, already running every program in the
  library. The differential harness (§6) runs the same code on both and compares register and
  memory state; a cork instruction is not done until it agrees with the emulator on generated
  inputs, and a program is not migrated until whole slices agree.
- **Measured lessons of its generator**, each already paid for once: page-granular units cost
  more than they save on straight-line code; f64 for x87 is exact enough for the programs of the
  era and 3× cheaper than 80-bit; lazy flags pay everywhere; an interpreter fallback is needed
  for code that cannot be translated (self-modifying stretches, instructions met once); the
  trap-port contract (`out` to a port carrying a call number) is a good boundary and stays.
- **The `cpu` layer contract** — `runSlice`, register access, memory windows, traps, the
  instruction counter and the sampler — is unchanged. Everything above the layer (kernel, bridge,
  loader, win32, graphics) neither knows nor cares which implementation is behind it; that
  boundary is what makes the replacement possible at all.

## 4. What is left out, deliberately

Everything a computer needs that a program does not:

- **Paging, TLB, page tables, CR registers.** The guest address space is flat; a guest address
  is a wasm memory offset plus a constant. A load is one wasm load.
- **Privilege levels, the GDT/LDT/IDT, task switching, real and virtual-8086 modes, 16-bit
  code.** The guest runs ring-3 protected mode from its first instruction; the engine's ROM
  only ever put the processor there. Segment registers are constants except `fs`, which is a
  per-thread base the translator folds in.
- **Devices, the BIOS, interrupts, the PIC/PIT/APIC, DMA, disk and network models.** The
  engine's own layers are the machine; the only "device" is the trap port.
- **Multiprocessor semantics.** Threads are the kernel layer's, run one at a time on one
  translated state; a context switch swaps the register file, and `lock`-prefixed instructions
  are plain (they still behave as atomic because nothing runs concurrently).
- **A boot path.** Cork starts at an entry point with a register file, never from reset.
- **Timing fidelity of instructions.** The scheduler quantum is retired instructions, as today;
  `rdtsc` and the clock stay the kernel's virtual time.

What is *not* left out: precise exceptions where a program can observe them (`#UD`, `#DE`, a
fault at an unmapped or protected address, `int 3`), reported the way the engine reports them
today so structured exception handling keeps working; self-modifying code (unpackers write code
once, some titles patch themselves); the instruction counter and the sampler; the ability to run
code cork has not translated yet.

## 5. Architecture

### 5.1 Memory

One `WebAssembly.Memory` (shared, as today — the audio worklet and the log keeper read it) holds
guest RAM at a fixed offset. A guest address `a` is wasm address `BASE + a`; the translator emits
`i32.load offset=BASE` and the browser's wasm bounds check is the only check. Regions the engine
marks inaccessible (the page at zero, guard pages, protected image ranges) are enforced by the
memory layer's map on the *host* side today; cork keeps a compact page-permission bitmap and
emits a check only for stores into pages that hold translated code (§5.6) and for the null page
(one compare on a base register, rarely taken).

### 5.2 Registers and flags

The eight general registers, `eip`, and the FPU/SSE state live in a small state block in memory
between translated regions and in wasm locals inside one. The translator allocates locals per
region: a register read into a local at region entry, written back at exit or before a call out.
Flags are **lazy**: an arithmetic instruction records its result and operands in locals; a flag
is materialised only where a later instruction reads it (a conditional branch, `adc`, `pushf`,
`setcc`), and the common case — a `cmp` followed by `jcc` — compiles to one wasm compare.

### 5.3 x87

The x87 stack is eight `f64` registers plus a top-of-stack index the translator tracks
statically within a region (the emulator's tracker patch proved the technique): `fld/fmul/fstp`
sequences compile to `f64.load/f64.mul/f32.demote/f32.store` on locals. Where the stack shape is
unknown at region entry (a region reached from several places with different depths) the region
begins with a materialisation from the state block. Precision is f64, rounded to f32 on 32-bit
stores, as the emulator does and as the differential harness will confirm the programs accept;
80-bit results are not reproduced. The FPU control word's rounding mode and precision control are
honoured where the program sets them (`fldcw`), because compilers of the era set PC=24 around
divisions and programs compare results across that.

### 5.4 SSE and MMX

SSE registers are `v128` locals; `addps/mulps/shufps/cmpps/minps/maxps/rsqrtps` and the integer
SSE2 set map to wasm SIMD instructions, one for one where wasm has the operation and a short
sequence where it does not. MMX registers alias the x87 mantissas, as on the hardware; a region
that mixes them materialises through the state block. `rsqrtps`/`rcpps` are computed exactly
(`1/sqrt`, `1/x` in f32), as the emulator does today, so results stay bit-identical to what the
library's programs already run against.

### 5.5 Translation units and control flow

The unit is a **region**: a set of basic blocks reachable from an entry within a code range,
grown along fall-through and direct branches until it meets an indirect jump, a return, a call
into another range, or a size cap. Regions are compiled into one wasm module per batch (tens of
regions per module: instantiation is per module and costs milliseconds, which is why the emulator's
one-unit-per-page design showed up in profiles as re-tiering). Direct calls within the translated
set are direct wasm calls; indirect jumps and returns go through a hash of translated entries with
the state block as the fallback. Hotness is by execution count in the fallback path; cold code is
run by the fallback tier (§6) until it earns translation.

### 5.6 Self-modifying code and invalidation

Translated ranges are recorded per 4 KiB page in a bitmap. A store compiles to a plain wasm store
unless the *static* target page cannot be proved code-free, in which case it is followed by one
bitmap test; a store into a page holding translated code invalidates that page's regions (they
return to the fallback tier and are retranslated on next entry) — the same contract the engine's
loader relies on today when it patches a site hook or maps a library.

### 5.7 Traps, exceptions, threads, counting

- A **trap** is the existing `out dx, al` to the trap port: compiled as a call to an imported
  host function with the state block synchronised before and after it. Batching of host calls
  (recording several calls into a ring and crossing once) is a later, separate change and is not
  what cork depends on.
- An **exception** (`#UD`, `#DE`, a refused address, `int 3`) leaves the region with `eip` and
  the register file exactly as at the faulting instruction — the translator keeps enough
  information per potential fault site to reconstruct them — and the engine's existing fault path
  reports it or dispatches it to the program's handler.
- A **thread switch** is the scheduler's, between slices: the register file is swapped in the
  state block; nothing in a region is thread-aware.
- **Instruction counting** is per region entry and per loop back-edge (a constant added to a
  counter), which is what the quantum and the sampler read; the sampler's attribution improves
  because the count is credited at loop edges rather than at wherever a page unit happened to
  exit.

### 5.8 The translation cache

A region's wasm is a pure function of the code bytes it was made from. Translations are stored
per bundle in the browser's storage, keyed by image identity (build stamp, size) and code range
hash: the second start of a program translates nothing it ran the first time, and a bundle
sidecar may carry translations made ahead of time. This is the mechanism the per-title
"precompiled stubs in a sub-bundle" idea reduces to — with no per-title code, only per-title
cache contents.

## 6. Compatibility and the fallback

The `cpu` layer keeps its contract and gains a configuration field: `engine: 'emulator' |
'cork' | 'hybrid'`, default `emulator` until cork passes the migration criteria below.

- **`hybrid`** runs both behind one register file and one memory: cork executes the regions it
  has translated; everything else — cold code, an instruction cork refuses, a page invalidated by
  a store — runs on the emulator, which is the fallback tier. The switch between them is a
  register-file copy at region boundaries. This is the mode the migration is done in: the first
  milestone translates one hot loop and the program is otherwise untouched.
- **`differential`** (test builds only) runs a slice on cork and the same slice on the emulator
  from the same state and compares every register, the flags a program can read, the x87 state
  and every memory word written. This is how an instruction is accepted and how a program is
  migrated. The harness lives beside the layer's tests and drives the library's demos.
- **`cork`** alone: the emulator is not loaded. Reached when the fallback tier has been exercised
  to zero on the library's demos, and the fallback for a refused instruction becomes cork's own
  interpreter (small, table-driven, correct, slow — it exists for the instruction met once, not
  for running programs).

Nothing above the `cpu` layer changes in any mode. Diagnostics grow `engine`, the translated
share of retired instructions, region counts and cache hits.

## 7. Media: what changes and what does not

With a 3–5× faster processor, more of what a program ships runs as the program shipped it: a
title's own video and audio codec libraries (the DLLs it carries) execute as guest code at a
speed that no longer needs a host substitute. That is the engine's preferred path — the program's
own bytes, unmodified.

The host video decoder (`video-decoder.wasm`, built from FFmpeg) stays for what is *not* in the
bundle: the codecs a Windows machine of the era provided as system components — Cinepak, Indeo,
MPEG-1/2, WMV, Video for Windows RLE — which the engine must supply because the program expects
the operating system to have them. Cork does not remove that need; it only removes the cases
where a shipped decoder had to be replaced for speed. Whether those system codecs are better
served by the FFmpeg build or by decoders written in this project's own JavaScript is a separate
decision, taken per codec by size and by the cost of the toolchain, not by cork.

## 8. Milestones and acceptance

Each milestone is measured on the same held demo windows the engine's other work is measured on
(guest instructions per frame, ns per instruction, ms per frame on a real browser and GPU), with
the emulator-only run of the same window as the control.

1. **Differential harness.** A driver that runs a code range on both engines from one state and
   diffs the result; the nasm corpus imported as its first inputs; `hybrid` mode plumbing with
   zero translated regions (the program runs exactly as today). *Accept:* the corpus passes on
   the emulator through the new harness; a program's demo runs to completion in `hybrid` with
   no region translated and identical instruction counts.
2. **Integer and SSE regions.** Decoder, IR, region former, wasm emitter, lazy flags, v128
   lanes, the cache. *Accept:* the hottest SIMD loops of the 2004 title (the ones the sidecar
   kernels replaced by hand) translate and agree with the emulator on generated inputs bit for
   bit; guest ms on the lit-scene window drops by the share those loops held.
3. **x87.** The stack tracker, `fldcw` modes, transcendental and integer conversions with the
   emulator's results as the reference. *Accept:* the GUI-heavy window's ns per instruction
   halves; every demo in the library still runs to completion in `hybrid`.
4. **Whole programs.** Calls, returns, indirect branches through the entry hash, exceptions,
   self-modifying code, thread switches. *Accept:* three titles of different engines run their
   demos in `hybrid` with ≥ 95 % of retired instructions translated, and the frame budget on each
   is within the master plan's thresholds.
5. **`cork` alone.** The interpreter tier for refused instructions; the emulator no longer
   loaded by default. *Accept:* the library's demos run with the emulator absent; the vendored
   emulator and its Docker pipeline are removed from the package.

## 9. Risks, named

- **Exactness.** A program that compares floating-point results across code paths (animation
  blending, culling) sees a different picture if cork and the emulator round differently. The
  differential harness is the answer, and f64-for-x87 is kept because the library already runs on
  it.
- **Precise state at faults inside a region.** Reconstructing registers at an arbitrary
  instruction costs metadata; the design keeps it per fault-capable instruction, not per
  instruction. Programs that fault deliberately (guard pages, `int 3` debugging leftovers) are
  in the library and will find any gap.
- **Translation latency on first run.** A large program translates megabytes of code once; the
  cache (§5.8) makes it once per bundle per machine, and the fallback tier keeps the program
  running while regions compile.
- **The wasm module count.** Each instantiation costs milliseconds and each module a tier-up in
  the browser; batching regions per module and the cache are what keep this from reproducing the
  emulator's re-tiering problem.
- **Scope creep toward x86-64.** The IR is designed so a 64-bit decoder and register file can be
  added later; nothing in the first five milestones builds it.
