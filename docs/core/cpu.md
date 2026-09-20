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

### Engines

The layer runs a program on one of two execution engines, chosen per launch. The vendored
emulator is the one everything below describes. The other is a translator package
(`@bottlify/cork`, `modules/cork`), which the layer loads at `boot()` by a module URL in its
configuration, the way it loads the emulator, and which implements the executor contract the
layer defines in `src/layers/cpu/engine.js`: an `EngineFactory` that takes the layer's memory,
a `StateLayout` naming where every register lives, and the host functions translated code may
call, and answers a `Runtime` (`entryOf`, `run`, `noteHot`, `translatePending`,
`invalidatePage`, `diagnostics`). The layer never imports an engine package — `check:boundaries`
refuses it — so a launch that selects the emulator runs with no translator installed, and a
launch that selects the translator loads nothing of the emulator. The `engine` configuration
field selects one per launch; `internal/hybrid-host.js` composes the emulator's host with a
translator's runtime on one register file. `diagnostics()` reports the selected engine as
`metrics.engine` and the translator's own report as `metrics.cork` (null when none is
attached).

Under `hybrid` with a translator (`engineUrl` names its module; without one, hybrid is the
emulator under another name, proven by identical instruction counts) the slice is shared:
while the guest stands at an address the translator has an entry for, the translator runs it
with what remains of the slice's budget, and when it leaves for an untranslated address, a
fault (the emulator then re-executes the instruction and raises it the ordinary way) or a
trap, the emulator takes a turn with the rest -- and gives it back: the runtime sets the
emulator's per-page handoff bit for every page a published region spans (`handoffPage`,
cleared when the page holds none), and the emulator's slice returns as soon as it reaches
such a page having retired something, so the two go round within one slice until the budget
is spent. An emulator build without the export runs its turn to a boundary of its own and
ends the slice; `cork.handoffMisses` counts the slices that so ended inside a page the
translator holds (`Runtime.holdsPage`), zero with the export. Between regions, translated
code needs no slice loop at all where the engine has tail calls: every region function is
placed in one function table shared by every module, every entry (block start, x87 top) is
mirrored into an open-addressing hash in the translator's tables (65 536 slots of the
address, the table index, the label and the top), and an exit for an untranslated address
with budget left probes that hash in the epilogue and tail-calls the region found -- a
return, an indirect jump or a call into translated code costs no crossing, and a hot
region's direct callees are formed in the same batch so the call and the return both hit. A block whose conditional branch comes back to its own start is a wasm loop with the back
edge a direct branch, the slice's budget looked at on that edge as on any jump. A region ends at a run of zero bytes
(two all-zero instructions in a row are a page's fill, not code: a region that walked past
a call that never returns once decoded eight kilobytes of it). Candidates come from two places: the
layer's sampler, which hands every hot bucket over at the address its last slice ended on
whenever that address is a new one, and the translator's own count of untranslated exits by
target address (`cork.missThreshold`, default 64), which is what finds a stub reached only
through such exits -- the sampler sees only where budgets run out. An address a region formed
nothing at (every block of it leaves at once) is not tried again until its page moves.
A block that would leave before retiring anything (nothing decoded, its first instruction
left out) has no entry, so a transfer never spins on it. The host's call channel is
translated too: `out dx, eax` to the trap port (`cork.trapPort`, the layer's own) writes the
state block back with EIP past the instruction and the count charged, calls the `trap`
import from inside the region -- the cpu layer's, which runs the handler the port write would
have reached (`raiseTrap` on the emulator's host, the same handler and the same count) and
answers whether it moved EIP or stopped the machine -- takes the state back into the locals
and goes on after the write, or leaves untranslated where the handler put EIP. A region
holding x87 registers in its locals takes the older form instead, a `trap` exit past the
instruction that the hybrid host answers the same way; either way a call into the bridge
costs no emulator turn. `out` to any other port, `in`,
`cli`, `sti`, `int n`, `int3` and `into` are the emulator's, before the instruction. A fault
translated code detects (a divide by zero, an undefined instruction, an access the page
table refuses) leaves before the instruction with the registers as they were, and the
emulator re-executes it and raises it through the same vector and report a program on the
emulator alone gets. The same hash is given to the
emulator (`handoffHash`, the fork's `bottlify_handoff_hash`): its slice then returns only at
an address the hash holds, not anywhere in a flagged page, which would otherwise hand a page
half translated back one instruction at a time. A page flagged for handoff is one the
emulator's own compiler leaves alone: what it compiled there is dropped when the flag is set
and the page is not compiled again while flagged, since generated code runs a page's blocks
without returning to the slice loop where the handoff is checked -- the emulator interprets
it, and its interpreter's own loop returns at an entry as the slice loop does, until the
translator takes it. Without tail calls the map
alone answers and the slice loop crosses between regions as before. The translator's layout is the emulator's
own register file, read off its typed views at boot (`stateLayout`), and its tables take the
top of the guest RAM (`engine.js`'s `TABLES_RESERVE`; the layer reports the RAM below it as
the memory's size), so a switch between the two copies nothing. Translated code adds what it
retired to the emulator's own counter word, so `instructionCount()` and the sampler are
unchanged. Candidates come from the sampler: once a frame, every 64-byte bucket credited past
`cork.hotThreshold` instructions is handed to the translator at the exact address its last
slice ended on, and the pending batch is compiled and instantiated there and then -- paced
by frames (`cork.feed: 'frame'`, the default) or, for a run without a presenter such as a
test, after every slice (`'slice'`), never inside one. The batch is compiled on the engine
thread rather than through the promise form: a batch is a few regions and the baseline
compiler takes well under a millisecond per region, while the promise's result is a task the
host's own yield was seen not to run for a whole program's length. Each region is its own
module, the unit the translation cache keeps: a region's module is a pure function of its
bytes, its entry, the x87 top it was compiled for, the layout and this emitter, so with a
store (`cork.store`, `cork.bundleId`; `createApp` resolves `'local'` to the origin's private
file system in the engine's own thread, a directory per bundle, as it does the block store)
the second run of a program takes every region it ran before from the store -- the region
is still formed, a decode, which gives its hash; what is saved is the emitting and the
encoding, and the report says `cacheHits`/`cacheMisses`. A record of another emitter
version, feature set or layout is a miss. A region with x87 instructions in it is compiled for the x87 stack top it is entered
with, and its entries are keyed by address and top (`entryOf(eip, x87Top)`, the top read off
the emulator's `fpu_stack_ptr` before every turn); a region without them is entered with any
top. A lookup that misses at an address compiled for another top queues that top for the
next batch. The translator keeps every x87 value as a double, as the emulator does; the
emulator's tagged-double form is read and written directly, a true 80-bit register it left is
converted inline. The control word is honoured at run time: rounding control rounds the
integer stores and `frndint`, precision control set to single rounds every arithmetic
result's mantissa to 24 bits (extended is treated as double); the SSE conversions that round
read the MXCSR rounding control the same way; a NaN an operation makes carries the
processor's negative sign whatever the host's default NaN is; exception masks are not
honoured, an exception behaves as masked. The transcendentals (`fsin`, `fcos`, `fsincos`,
`fptan`, `fpatan`, `f2xm1`, `fyl2x`, `fyl2xp1`) go through the host's `Math`, imported by every
translated module, as the emulator's do, so the two agree on one engine. `fnstenv` and
`fnsave` write the protected-mode environment as the emulator does (the instruction and data
pointers zero, which neither keeps); `fldenv` and `frstor` read it back into the locals and
leave for the next block, since the top they set is known only at run time and every block
is compiled for one -- the entry hash re-enters the code compiled for whatever the top then
is. Within a region, only the blocks compiled for the stack in the entry's shape (its top,
no registers exchanged) are entries; a block compiled for another shape is reached from
inside the region alone, where the edge brings the stack into it, since entered from outside
it would push, pop and write the top back for a stack the machine does not have. A block
whose shape the tracking does not know keeps the top the machine had. An MMX instruction
holds every x87 register with the top at zero, as the processor does, and `emms` empties them
again, whichever order the two come in within one run. `fxsave` and `fxrstor` still end a region and run on the emulator. A store translated code makes into a page the emulator's own compiler compiled is
seen too: the store checks the emulator's byte-per-page "has code" table beside the
translator's own flags (`layout.codePages`, the fork's `bottlify_page_has_code_ptr`) and
leaves `stale` with the address and width, and the runtime dirties the emulator's cache for
that range (`dirtyCode`, the fork's `jit_dirty_cache`) as the emulator's own stores do. A
host write into guest memory (`writePhysical`, `writeData`, `fillData`) invalidates the
translator's regions on every page it touches, as it already dirties the emulator's.

Translated code tests a page-flag table before every load and store (one byte per 4 KiB page
of the address space, kept in the memory after the guest RAM): a page beyond RAM is
inaccessible from boot and an access to it is a precise `#GP` with the registers as before
the instruction; a page that holds translated code makes a store into it leave translated
code with a `stale` exit right after the instruction, so the runtime can drop what it
translated there -- a store into the code's own bytes, that is: beside the flag the table
keeps, per page, the first and last 32-byte granule holding translated code, and a store
into the page's data next to its code (a small image keeps both in one page, and a loop
storing into its own page went volatile after eight such stores) is no store into code. The null page is *not* marked, because the emulator lets a program read
address 0 today and the two engines must agree; marking it, and projecting the memory
layer's read-only regions into the table, is a policy switch this layer's owner throws when
the emulator is no longer the reference for it.

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
| `memorySize`    | number (power of two)      | `1 GiB`             | Guest RAM. Reserved, not committed: the host pays for pages the guest touches. Must be a power of two; the emulator requires it. With an engine other than `emulator` the top `TABLES_RESERVE` (4 MiB) is the translator's tables, and `layout.memorySize` reports the rest. |
| `engineUrl`     | string                     | none                | The translator's entry module, imported at `boot()` under `hybrid`; `createApp` resolves it from `cork.moduleUrl` or the package beside core. Absent, `hybrid` runs with no translator. |
| `cork`          | `EngineConfig`             | `{}`                | The translator's own settings (`engine.js`): `hotThreshold`, `maxRegionBlocks`, `maxRegionBytes`, `batchRegions`, `feed`, `missThreshold`, and `leaveOut`, the instruction classes (`x87`, `mmx`, `sse`) a run leaves to the emulator so a defect can be localised by class; such a run keeps no translation store. |
| `trapPort`      | number                     | `0xb077`            | The I/O port a stub writes its trap id to. |
| `entryVector`   | number                     | `0x7000`            | Linear address of the dword the ROM jumps through to enter guest code. |
| `initialStack`  | number                     | `0x300000`          | ESP the ROM sets before jumping into the guest. |
| `thunkBase`     | number                     | `0x100000`          | Where the stub table is placed. Low, so everything between it and `initialStack` can be the first thread's stack. |
| `thunkCapacity` | number (bytes)             | `16384 * 16`        | Room reserved for the stub table: 16 384 slots of 16 bytes. Every import and every COM method takes one; none is ever given back. |
| `jit`           | `Record<number, number>`   | `undefined`         | The emulator's compiler budgets by config index (1 = pages one module may span, 3 = extra basic blocks discovery may follow, 6 = chaining). For measurement, not production. |
| `sampling`      | `boolean`                  | `true`              | Whether `runSlice` credits an address bucket per slice (see "Sampling" below). Always on; `false` is the only way to turn it off, for a caller measuring the emulator itself. |
| `engine`        | `'emulator' \| 'hybrid' \| 'cork' \| 'differential'` | `'emulator'` | Which execution engine runs the program (see "Engines" above). An unknown name is refused by `create()` with `cpu: unknown engine "x" (…)`; `cork` and `differential` are refused with `cpu: engine "cork" is not built yet` until their steps land. `hybrid` without `engineUrl` composes the emulator's host with no translator attached and runs a program exactly as `emulator` does, to the instruction. |

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
| `cork`          | The translator's report (`EngineDiagnostics` in `engine.js`): regions, entries, modules, `translatedShare`, invalidations, volatile pages, exits by kind, refused opcodes. `null` without a translator. The frame counters carry `cork.regions`, `cork.invalidations` and `cork.share` (cumulative), and the frame's own `cork.frameShare` (the share of the frame's instructions the translator ran), `cork.frameTranslateMs` and `cork.frameLeaves` (times translated code came back to the host in the frame). | Per slice, per frame. |
| `samples`       | `{ slices, overflow, top: [{ address, instructions, samples }] }` — where every slice since boot has gone, by 64-byte address bucket; `top` is the 64 heaviest by instructions, reported by each bucket's own address rather than by rank. | Every slice that retired at least one instruction (see "Sampling" below). |

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

### Sampling

Every slice that retires at least one instruction credits the address it ended at
(`internal/samples.js`) — a slice that retired nothing is a parked thread's turn and says
nothing about where the guest's own code runs hot, so it is skipped. Addresses are bucketed to
64 bytes (`eip >>> 6`) in a `Map` capped at 16 384 distinct buckets; a bucket beyond the cap is
counted as overflow rather than grown into, so a long run's own memory here is bounded no matter
how much guest code it touches. The register read (`eip`, already needed for other bookkeeping
in `runSlice`) and the table update are the whole cost: nothing per instruction, nothing per
basic block, and no clock — a slice's wall time is not read, because two `performance.now()`
reads per slice (tens of thousands of times in a heavy window) were measured at ~23 % of a
frame on `ceiling3.demo`'s light window (`report-sampler.md`) before they were removed. A reader
wanting milliseconds per bucket takes the bucket's share of instructions against the `guest`
phase's own ms over the same interval. Always on (`sampling: false` turns it off, for a caller
measuring the emulator's own compiler rather than the guest's code).

What a bucket's address belongs to — which image, which function — is not this layer's
knowledge: `diagnostics().samples.top` reports raw addresses, and resolving one against the
loader's module layout (`image` + `base` → an RVA) is left to whoever reads it, the same way the
kernel's own page counts are resolved into modules by a reader rather than by the kernel
(`docs/core/loader.md`, `docs/core/log.md`'s `guestByModule`). Naming the *function* a resolved
address falls in needs a symbol table, which is per-title bundle content this layer never reads
(`docs/core/host.md`'s `sidecarHooks`, "Sidecar hooks" in `loader.md`).

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
create a fresh typed array per property access, or through the buffer accessor on every read. The host also reads and writes the SSE and x87 state as records
(`readXmm`/`writeXmm`, `readMxcsr`/`writeMxcsr`, `x87State`/`restoreX87State` -- the eight x87
registers by physical index, decoded from whichever of the emulator's two forms each is in,
with the raw bytes beside them, and the status word with the top of stack folded into bits
11..13 as `fnstsw` would report it, since the emulator keeps the two apart) and whether the
processor stands in a `hlt` (`halted`/`wake`), for the translator package's differential harness, which
snapshots this machine, runs the same code on both engines and compares; cold paths, nothing a
slice pays for. Two emulator methods are wrapped for counting:
`codegen_finalize` (published modules, and the first refusal) and `jit_clear_func` (discarded
ones). For the translator, three exports of the fork's own: `bottlify_handoff_page(page, on)`
sets the per-page bit at which `run_slice` returns (absent in an older build, the host counts
the request in `handoffUnavailable()` and the slice runs to its own boundary),
`bottlify_page_has_code_ptr()` names the emulator's own code-page table for the translator's
stores to test, `bottlify_handoff_hash(physical)` names the translator's entry hash so the
slice returns at its entries rather than at its pages, and `jit_dirty_cache(address, length)`
takes a translated store into such a page.

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
| `internal/samples.test.js` | A slice at a known EIP credits that bucket; two addresses inside one 64-byte span fold together, two spans apart stay separate; `topSamples` ranks by instructions and reports each bucket's own address; ten thousand distinct addresses leave the table's own size bounded at the cap, with the rest counted as overflow. |

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
