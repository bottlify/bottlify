# `cpu` — guest execution

The layer that runs x86 code. It is the only part of `@bottlify/core` that knows an emulator is
underneath: everything above it speaks in terms of running, stopping, registers, physical memory
and traps. Module machinery is described in [`README.md`](./README.md) and
[`system.md`](./system.md); the process assembler that drives this layer is in
[`host.md`](./host.md).

## 1. Purpose

`cpu` owns the emulated processor: it boots the machine straight into 32-bit protected mode with a
64 KiB ROM of its own (no BIOS), runs guest code in slices bounded by retired instructions, hands
out guest-side call stubs that trap into the host, captures and restores a thread's complete CPU
state, reports processor exceptions by name, and exposes the zstd decoder the emulator carries.

It deliberately does not know what a trap *means* (that table is the bridge's), when a thread
should be switched (the kernel's), or what is mapped where (the memory layer's). It emits
stubs and reports numbers; it captures contexts and restores them on request. Guest RAM is
reached through `readPhysical`/`writePhysical` with no validation — validation is what the memory
layer adds on top.

## 2. Contract

| field      | value                    |
|------------|--------------------------|
| `name`     | `cpu`                    |
| `version`  | `0.1.0`                  |
| `requires` | `['log']`                |

Source: `src/layers/cpu/module.js`. The layer is the only one allowed to touch `vendor/`
(enforced by `scripts/check-boundaries.mjs`), and it does so by dynamic `import(moduleUrl)` at
`boot()` time rather than by a static import, so the several hundred kilobytes of emulator never
enter the type check or the bundle.

### Configuration

| option          | type                       | default             | meaning |
|-----------------|----------------------------|---------------------|---------|
| `memorySize`    | number (power of two)      | `1 GiB`             | Guest RAM. Reserved, not committed: the host pays for pages the guest touches. Must be a power of two; the emulator requires it. |
| `trapPort`      | number                     | `0xb077`            | The I/O port a stub writes its trap id to. |
| `entryVector`   | number                     | `0x7000`            | Linear address of the dword the ROM jumps through to enter guest code. |
| `initialStack`  | number                     | `0x300000`          | ESP the ROM sets before jumping into the guest. |
| `thunkBase`     | number                     | `0x100000`          | Where the stub table is placed. Low, so everything between it and `initialStack` can be the first thread's stack. |
| `thunkCapacity` | number (bytes)             | `16384 * 16`        | Room reserved for the stub table: 16 384 slots of 16 bytes. Every import and every COM method takes one; none is ever given back. |
| `jit`           | `Record<number, number>`   | `undefined`         | The emulator's compiler budgets by config index (1 = pages one module may span, 3 = extra basic blocks discovery may follow, 6 = chaining). For measurement, not production. |

Chaining (index 6) is switched on automatically when the running engine validates a wasm tail
call and the caller has not set the knob (`tailCallsSupported()` in `internal/v86-host.js`).

### API

`create()` returns the API below; nothing that needs a running emulator works until `boot()` has
been called, and each such method throws `cpu: boot() must be called before the guest can run`
otherwise.

| member | signature | meaning |
|--------|-----------|---------|
| `layout` | `{ entryVector, initialStack, thunkBase, thunkCapacity, memorySize, romBase, romSize }` | The addresses the layer owns, for whoever lays out the address space. |
| `boot` | `({ moduleUrl, wasmBytes }) => Promise<void>` | Instantiates the emulator, drives the ROM to protected mode, registers the trap port. Throws if already booted. |
| `booted` | `() => boolean` | Whether `boot()` has completed. |
| `fault` | `() => GuestFault \| null` | The fault that stopped the machine, with a `text` description, or null: a processor exception read off its frame, or one the host raised. |
| `raiseFault` | `({ name, detail, eip, calledFrom? }) => void` | Records a fault of the host's own naming (`vector` -1, `detail` is the whole report), to be found by the same poll as an exception. Only the record: called from inside a trap, the caller sends the stub's return into the park loop, whose `hlt` is what ends the slice. |
| `run` / `stop` | `() => void` | Free-running mode (the emulator's own loop). The scheduler does not use these; it uses `runSlice`. |
| `readPhysical` | `(address, length) => Uint8Array` | A **window** on guest RAM — a subarray of the emulator's memory, not a copy. |
| `writePhysical` | `(address, bytes) => void` | Writes through the emulator, which invalidates any compiled code on the pages touched. |
| `readU32` | `(address) => number` | One dword, with nothing allocated. |
| `writeData` | `(address, bytes) => void` | Writes straight into RAM without telling the compiler. Only for memory the guest can never execute; the caller is responsible for that being true. |
| `readReg32` / `writeReg32` | `(name[, value])` | `eax ecx edx ebx esp ebp esi edi`, plus `eip` and `eflags` (the latter read through the emulator's accessor so lazy arithmetic flags are folded in). Unknown names throw. |
| `registerTrap` | `(name, popBytes, { preserveResult?, forwardTo?, saveRegisters?, pushEdx?, holdEip? }) => { id, address }` | Takes a stub slot; written into guest memory immediately if the table has already been laid down. Throws when the table is full. `saveRegisters` (`pushad`) or `pushEdx` (just EDX) run before the trap even without `forwardTo`; `holdEip` emits neither `ret` nor a jump, for a caller that decides EIP itself while handling the trap (the bridge's `hook`, EDX alone, or its `siteHook`, every register, together with `saveRegisters`). |
| `thunkImage` | `() => Uint8Array` | The stub table so far, to be written at `layout.thunkBase`. Marks the table as written. |
| `parkAddress` | `() => number` | Slot 0 of the table: `hlt; jmp` — where a terminating or blocking call returns to. |
| `onTrap` | `(handler: (id) => void) => void` | Who gets non-fault trap ids. The bridge claims this. |
| `runSlice` | `(maxInstructions) => number` | Runs at most that many instructions (to the end of the basic block the bound falls in) and returns how many retired. The scheduler's unit of progress. |
| `captureContext` | `() => Context` | The running thread's complete CPU state as an opaque record. |
| `restoreContext` | `(context, threadBase) => void` | Restores a context, pointing FS at `threadBase` (the TEB). The TEB is a parameter so a restore that forgets it is not expressible. |
| `resumeContextAt` | `(context, { eip, returnValue, esp? }) => void` | Redirects a saved context: EIP, EAX and optionally ESP. |
| `newContext` | `({ entry, stackTop }) => Context` | A context for a thread that has not run: the current machine state as a template, positioned at its entry and stack. |
| `decompressZstd` | `(packed, expectedLength) => Uint8Array` | Synchronous zstd decode through the emulator's own decoder. |
| `instructionCount` | `() => number` | Instructions retired since boot, exact past the emulator's own 32-bit counter. |
| `compiledModules` / `interpretedSteps` / `hostWrittenBytes` | `() => number` | Compiler and host-write counters (see diagnostics). |
| `profile` | `{ available, start, stop, read, instructionStats }` | The emulator's address-weighted profile and event counters, present only in a profiler build of the emulator. |
| `inProtectedMode` | `() => boolean` | `CR0.PE`. |
| `eip` | `() => number` | Where the guest is right now. |
| `forwardSave` | `32` | Bytes a forwarding stub pushes (`pushad`) before it traps. |
| `fpu` | `{ setResult, get, pop, depth, controlWord }` | The x87 stack, for a handler that returns a `double` or takes one from ST(n). |

An instance owns its emulator. `create()` may run more than once in the same realm (a process
replacement runs it again; the plan for two machines in one worker needs two at once), so the
emulator, the stub table and the fault record live in the instance the api closes over, and a
second `create()` cannot take the first one's machine; `diagnostics()` answers for the most
recently created instance. **A second boot is a second instance's own first boot**, not a
continuation of another one's: `boot()`'s "already booted" refusal reads only this instance's own
state, so a process replacement's fresh cpu instance boots cleanly while the machine it is
replacing is still standing (or already disposed) — it never sees the other instance's emulator
and never throws on its account. After `dispose()`, this instance answers exactly as one that has
never booted: `booted()` is `false`, `diagnostics()` reports `status: 'created'`, `fault()` is
`null`, `raiseFault()` is a no-op, and every method that needs a running emulator throws the same
`cpu: boot() must be called before the guest can run` a never-booted instance already throws —
there is no separate "disposed" refusal, because a disposed machine and one that has not started
yet are the same state from a caller's perspective.

### Diagnostics

`diagnostics()` answers `status: 'created'` until `boot()`, `'ready'` after. Metrics:

| metric          | meaning | when it moves |
|-----------------|---------|---------------|
| `running`       | Whether `run()`/`runSlice()` has been called and `stop()` has not. | On `run`, `runSlice`, `stop`. |
| `instructions`  | Total retired instructions. | Every slice. |
| `protectedMode` | `CR0.PE`. | Set during `boot()`, never cleared. |
| `traps`         | Slots taken in the stub table, park loop included. | Every `registerTrap`. |
| `trapCapacity`  | Slots available in total. | Fixed at `boot()`. |
| `trapCrossings` | Times the guest has left its own code for ours — every import, COM method and fault comes through the one trap port. | Every crossing. |
| `jit`           | `{ disabled, maxPages, loopSafety, cache, tableFree, compiledSteps, interpretedSteps, entries, interpretedDispatches, f80Conversions, codePageWrites, modulesLostToWrites, hotnessLostToWrites, chaining, chained, chainMissed, chainRefused, flagsDead, slowWrites, codePageWritesKept, x87TagLost, x87Sites, dirtyPages, finalised, published, discarded, hostWrites, hostWrittenBytes, refused }` | Per slice / per host write. Counters the emulator build does not carry read `-1`. `refused` is the first error a compiled module failed to publish with — a compiler that silently fails leaves every instruction interpreted, which is correct and several times slower. `published` is the last 4096 `[slot, start]` pairs `codegen_finalize` was called with, oldest first — `start` is the guest linear address the compiled unit begins at, for naming a JIT unit by the guest function it compiles once joined against the arrival order of the debugger's own `wasm://` script-parsed events. |
| `eip`           | The guest's instruction pointer. | Continuously; sampling it names a loop no host call would reveal. |

`jit.cache` is the emulator's own cache-size counter, which a release build compiles out (it
reads zero always); `compiledSteps` versus `interpretedSteps` is the number that says whether the
compiler is alive.

`diagnostics()` is the cold path: it reads thirty emulator exports and builds an object, and is
for a one-off look. The same figures are published once a frame into the `cpu/counters` table of
the log layer (`CPU_COUNTERS` in `module.js`: `running`, `instructions`, `protectedMode`, `traps`,
`trapCapacity`, `eip`, `trapCrossings`, and every numeric `jit.*` field), sampled when the profiler's
frame closes; a reader elsewhere takes them from shared memory and never asks this thread.
`jit.dirtyPages`, `jit.x87Sites` and `jit.refused` are strings and stay in `diagnostics()` only.

Some of that row is copied into every frame's own row as well (`FRAME_DELTAS` in the log layer), so
that one slow frame can be told apart from one busy frame without a second run: an emulator that
refused to answer reports `-1` rather than a record, and the sampler checks for that, because reading
fields off a number would leave every counter — and every frame's figure subtracted from it — `NaN`.

## 3. How it works

### The boot ROM

`internal/boot-rom.js` builds a 64 KiB image that the emulator maps as its BIOS at
`0xF0000` (`ROM_BASE`). The reset vector `F000:FFF0` is a far jump into eighteen instructions:
`cli`, `lgdt`, `lidt`, set `CR0.PE`, far jump to a flat 32-bit code segment, load flat data
segments, set ESP to `initialStack`, and `jmp dword [entryVector]`. The mode switch is done by
real guest instructions rather than by poking emulator fields, so every descriptor cache inside
the emulator is consistent by construction.

The jump into guest code is *indirect through RAM* on purpose: the ROM is needed to construct
the emulator, but the entry point is only known after the loader has mapped an image, which
needs an emulator to write into. The entry vector breaks that cycle.

The ROM also installs an IDT with a gate for each of the first 32 vectors. Each gate points at a
sixteen-byte stub that writes `FAULT_TRAP_BASE + vector` (`0xf000 + n`) to the trap port and
then halts. Without those gates the emulator has nowhere to send a fault and stops the machine
with the same message for a divide by zero, a bad pointer and an illegal instruction.

### Bring-up before anyone sees the machine

`createV86Host()` (`internal/v86-host.js`) drives the ROM itself during `boot()`, with the entry
vector temporarily pointing at a two-byte spin (`BRING_UP_PARK`). It single-steps up to 64
slices until EIP lands on the spin, checks `CR0.PE`, then sets EIP back to `GUEST_JUMP` — the
`jmp dword [entryVector]` instruction — and leaves the machine there. The reason is that every
thread's context is a copy of the machine as it stood when the thread was created; a context
captured before the mode switch would carry real mode into every thread that ever runs.

The boot code is then retired: the real-mode init and the prologue up to `GUEST_JUMP`
(`DEAD_BOOT_CODE`) are overwritten with `int3`. A guest that strays into the ROM — a return
through a wrecked stack lands anywhere — would otherwise run `mov cr0, eax` with whatever EAX
holds and turn paging on, or reload the stack and start the program over; instead it faults at
its first byte there, and `describeFault` names it `guest jumped into the boot ROM at …`.

### Slices and the quantum

`runSlice(n)` calls the emulator's `run_slice(n)` and returns retired instructions. Granularity
is a basic block: the emulator runs whole blocks, so a slice runs to the end of the block the
bound falls in. The bound is in guest instructions rather than wall time, so the preemption
point does not move with host speed. After every slice the 32-bit instruction counter is folded
into a JavaScript number (`instructionCount()`), which is exact as long as reads are less than
2^32 instructions apart.

The emulator has no double fault: an exception it cannot deliver — a page fault while pushing
the frame for a page fault, which paging over a bad directory produces — recurses until the
host's stack is exhausted and surfaces as a `RangeError`. `runSlice` catches that one error,
records a `double fault at <eip>: a page fault at <cr2> while delivering a fault` (vector 8,
`detail` set; EIP is still on the instruction that faulted first, and CR2 holds the last address
that would not translate) and halts the machine, so the run ends through `fault()` like any
other.

### Traps and the stub table

`internal/thunks.js` emits the guest-side stubs. Each is sixteen bytes at
`thunkBase + id * 16`: `mov dx, port; mov eax, id; out dx, eax; ret popBytes` (or plain `ret`
for cdecl). Slot 0 is the park loop (`hlt; jmp $-1`) — a handler that ends or blocks the
calling thread cannot stop the emulator from inside the trap callback, so the return address is
redirected here and the machine is stopped from outside.

Two variants: a stub reached by a `ret` (`preserveResult`) first moves EAX to ECX so the trap id
can use EAX; a forwarding stub (`forwardTo`) does `pushad`, traps, then `jmp`s into the real
guest function — the host restores EAX and EDX from the saved block and drops it, so the callee
sees the registers exactly as its caller set them.

The trap port write handler in `v86-host.js` calls whatever `onTrap` installed. In
`module.js` that handler first checks for a fault id (`0xf000..0xf01f`): if so it reads the
exception frame (`internal/faults.js`), records it as `lastFault`, stops the machine and returns
— never throws, because an exception raised inside the emulator's port write is lost crossing
back into wasm. Every other id goes to the bridge's dispatcher.

### Contexts

`internal/context.js` lists every field that must move with a thread: the eight general
registers, EIP and `previous_ip`, all segment tables (selectors, offsets, null flags, limits,
access bytes), the *five* lazy-flag fields together (`flags`, `flags_changed`, `last_op1`,
`last_result`, `last_op_size` — the raw `flags` word is missing OF/SF/AF/PF while
`flags_changed` is non-zero), the x87 registers with `fpu_stack_ptr` and `fpu_stack_empty`
(the tag word — there is no other, and MMX zeroes both), control/status words and instruction
pointers, XMM registers with MXCSR, and `in_hlt`. `setThreadBase` writes the FS segment offset,
which is how a TEB travels with the thread.

### The x87 stack

`internal/fpu.js` reads and writes the emulator's FPU state directly in its linear memory, at
offsets taken from the emulator's global-pointer table (`STACK_EMPTY`, `STACK_PTR`,
`CONTROL_WORD`, `ST`). A `double` is converted to and from 80-bit extended precision by hand.
`setResult` pushes like the processor would, refusing to overwrite an occupied register (it
leaves an indefinite value, as a real overflow does). Inside a compiled block the pinned build
keeps the stack top and the empty-register mask in that module's own locals rather than these
globals, writing them back together with the general registers at every point JS can next run
(chaining to another module, the fault/exit exits, and the port-write trap the engine's context
switch goes through), so this file's reads always see the current thread's values; `emms` resets
the stack top to zero along with the tag word.

### Host writes and the compiler

Every `writePhysical` goes through the emulator's `write_memory`, which discards compiled code
for the pages written. That is the right price for mapping an image and the wrong one for a
handler writing a structure field, so `writeData` writes straight into RAM; the memory layer
decides between the two by asking its region map whether the target could ever be executed.
`hostWrittenBytes` and `jit.discarded` say how much that costs in a run.

### zstd

The emulator's wasm exports the zstd decoder it reads compressed disk images with.
`decompressZstd` uses it synchronously in 64 KiB chunks, allocating and freeing its context and
output within the emulator's linear memory before returning. This is the only decompressor
available that answers without a promise, which a guest file read needs — the CPU is stopped
inside one instruction and cannot await.

### What of `vendor/v86` is used

`libv86.mjs` (the `V86` class: `add_listener`, `run`, `stop`, `write_memory`,
`get_instruction_counter`, `io.register_write`, and the `cpu` object's typed views over its
state) and `v86.wasm` (or `v86-profiler.wasm`), via `wasm_fn`. Views over the emulator's
memory are taken once and again only when the memory has grown -- which detaches the buffer
they were on, so a view reading as empty is the signal -- rather than through its proxies, which
create a fresh typed array per property access, or through the buffer accessor on every read. Two emulator methods are wrapped for counting:
`codegen_finalize` (published modules, and the first refusal) and `jit_clear_func` (discarded
ones).

## 4. Limitations and divergences

- **A fault halts the machine.** A fault stub does not `iret` and there is no guest exception
  dispatch in this layer. What `fault()` reports is for whoever drives the machine to act on.
- **Only the first 32 vectors** have gates. Hardware interrupts are not delivered; the guest
  runs with `IF` clear from the ROM's `cli`.
- **Ring 0, flat segments, no paging.** The guest runs at CPL 0 with two flat 4 GiB
  descriptors; there is no user/kernel split and `CR3` is never set. Frame reads in
  `faults.js` assume no stack switch for that reason.
- **Trap ids are 32-bit port writes**; ids `0xf000..0xf01f` are reserved for faults and the
  bridge allocates from zero upward.
- **The stub table is finite** (`thunkCapacity`) and slots are never freed. `registerTrap`
  throws when full; the one caller that can act on that (the COM publisher) turns it into an
  out-of-memory answer to the guest.
- **`readPhysical` is a window**, not a copy; a caller that keeps it keeps a value that
  changes under it.
- **`writeData` trusts its caller** that the target is not executable.
- **One machine per process.** State lives on the module object; a second concurrent build
  would need it hoisted into a per-instance record.
- **The FPU offsets are the emulator's**, not an architectural fact; a change in the vendored
  build could move them.
- **Profiler counters** (`profile.*`, `instructionStats`, most of `jit.*`) exist only in a
  build of the emulator that carries them; they answer `null` or `-1` otherwise.

## 5. Tests

Unit tests (no emulator; `npm test` runs `src/**/*.test.js`):

| file | covers |
|------|--------|
| `internal/boot-rom.test.js` | ROM size and placement, reset vector, GDT/IDT contents, the indirect jump, every fault stub reporting its own vector and stopping, the retired boot code ending exactly at the guest jump. |
| `internal/faults.test.js` | A host-raised fault reads as its sentence, a stand-in for an undeliverable exception keeps its vector, a breakpoint in the retired boot code is an excursion, the live guest jump is not, processor exceptions read as before. |
| `internal/thunks.test.js` | Stub encoding per convention, forwarding stubs and their register save, a hook stub's single `push edx` and its held EIP (no `ret`, no `jmp`), refusal when the table is full, the default capacity. |
| `internal/context.test.js` | Context round trips, lazy flags travelling together, x87 stack pointer/tag word, the TEB being part of the switch. |
| `internal/fpu.test.js` | Double to extended conversion (sign of zero, explicit leading bit), push/pop, overflow refusal, control word. |

Integration tests (`npm run test:integration` runs `src/**/*.itest.js`; they need the prebuilt
emulator in `modules/core/vendor/prebuilt/` — `npm run fetch:v86`):

| file | covers |
|------|--------|
| `internal/v86-host.itest.js` | Booting to protected mode, the instruction count past 2^32, registers by name, slice bounds on loops, x87 arithmetic, flags, string instructions, compiled-code chaining, profiler builds. |
| `internal/quantum.itest.js` | A slice is bounded by retired instructions to a page, compiled or interpreted. |
| `module.itest.js` | The frame's account of the interpreter; an exception the processor cannot deliver ends as a named double fault rather than a host stack overflow; a guest straying into the retired boot code is reported as an excursion. |
| `internal/context.itest.js` | An x87 thread survives interruption by MMX; pending arithmetic flags survive a switch. |
| `internal/zstd.itest.js` | A frame decodes byte for byte, scratch is returned, a short frame is an error. |

Filter to one file with `node --test src/layers/cpu/internal/thunks.test.js` from
`modules/core/`.
