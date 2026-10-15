# Roadmap v2 — a multi-worker platform

Русская версия: [README.ru.md](README.ru.md).

**Status:** proposed 2026-10-03, revised against `main` 6554baf0; the workers of stage 2 and the
translation cache arena decided 2026-10-07 on `cork2`, where the translation pool, its driver and
the arena landed the same day; zstd stays on the coordinator, measured not worth moving yet
(`negative-results.md`, 2026-10-08). Stage 3's atomic variant, the executors' layouts (a state
page, tables and interpreter statics of each executor's own over one guest RAM), executors in
workers of their own and the kernel running a process's threads on them at once landed on
`cork2` on 2026-10-08 (`createApp`'s `executors`); choosing the mode per process, and the host's
unbroken routines (below), are open. How the engine works today is in
[`docs/architecture.md`](../../docs/architecture.md); this document is where it goes next.

v2 turns the engine from one thread that does everything into a platform of workers whose number
follows the load: one worker while one copes, four when two are choking, never four held idle. On
that platform come, in order, x86-64 programs and ARM and ARM64 programs; Direct3D 11 depends on
none of it and can be built alongside.

1. [Why](#why)
2. [Where we are](#where-we-are)
3. [Where v2 goes](#where-v2-goes)
4. [Principles](#principles)
5. [Before stage 1 — two measurements](#before-stage-1--two-measurements)
6. [Stage 1 — Layering, one executor](#stage-1--layering-one-executor)
7. [Stage 2 — Processes and services in workers of their own](#stage-2--processes-and-services-in-workers-of-their-own)
8. [Stage 3 — More executors per process](#stage-3--more-executors-per-process)
9. [Stage 4 — x86-64](#stage-4--x86-64)
10. [Stage 5 — Direct3D 11](#stage-5--direct3d-11)
11. [Stage 6 — ARM and ARM64](#stage-6--arm-and-arm64)
12. [Open questions](#open-questions)

## Why

What limits speed today is how work is distributed across threads, not how fast translated
instructions run.

- **The graphics worker proved it.** cork 1.3 moved Direct3D 8 and 9 off the engine thread into a
  worker of their own. In `tools/graphics-bench --remote` the engine thread's time per frame fell
  from 2.95 ms to 0.69 ms (`docs/core/graphics.md`), and a measured run of World of Warcraft went
  from 40–50 to 70–80 frames a second. Nothing about the instructions changed.
- **The browser's event loop sits on the hot path.** The engine loop's own comment in
  `core/src/app.js` records that a trip round the event loop on every turn was the largest host
  phase of a run. The thread that runs the program has to yield to the browser because the same
  thread also receives the page's messages, timers, fetches and OPFS answers.
- **Everything else is still on that thread:** cork runs every guest thread in turn (a quantum of
  100,000 instructions), all of Win32, file reads, zstd, the video decoder, MP3, the sound pump,
  Direct3D 10, Vulkan and the presenter.
- **Only one process runs at a time.** `CreateProcess` replaces the parent with the child, or runs
  the child on a second machine while the parent is paused, and copies back what the child wrote.

## Where we are

![Program code runs on the engine thread alone](now.svg)

Six threads, of which one runs the program and answers it, and the guest's memory is an ordinary
`WebAssembly.Memory` only that thread can touch.

## Where v2 goes

![The engine thread runs the system, processes run code, services help](target.svg)

Three levels, each with one job:

| Level | In Windows terms | Holds | Runs where |
| --- | --- | --- | --- |
| **The system** | The part of Windows every process shares | Process table, registry, file system, window manager and focus, named objects (mutexes, events, file mappings, pipes), clipboard; the browser's event loop; the scaling driver | The engine thread, as the coordinator. It runs no program code |
| **Processes** | A process | Its own guest memory, its engine (cork or cork-x64), the per-process half of Win32: handles, heaps, modules, TLS, message queue, the recording of Direct3D and OpenGL calls | One worker per process, 1..N executors inside it for the process's threads |
| **Services** | Drivers and system services | Translation, host work (decoders, block fetch), graphics with the canvas, log keeper, AudioWorklet | Worker pools sized by the driver |

The program's code and the Win32 calls it makes synchronously live in the same worker, so a call
answered at once never crosses a thread. What crosses is either slow anyway (a file block, a
decoded frame, a translation) or rare (a call into another process's window, a named object, the
registry).

## Principles

These hold through every stage.

1. **One engine, two modes.** Single-thread mode is today's behaviour: one executor, plain
   translations, no atomics. Multi-thread mode is the same code with more executors and the atomic
   variant of every translation. The mode is chosen at run time; it is never a different build.
2. **Capacity follows the load.** No worker is kept that has nothing to do; one is added when the
   ones there are falling behind. The minimums reproduce today: one executor, one translation
   worker, no host-work worker, one graphics worker.
3. **The executor never waits for the browser.** Everything a process receives — input, I/O
   completions, answers from the renderer, published translations — arrives through rings in shared
   memory. An executor with nothing to run sleeps on `Atomics.wait` and is woken by
   `Atomics.notify`. The page's signal word, incremented on every message it posts, is the first
   such ring already.
4. **Shared memory from the start, so the page is cross-origin isolated.** `shared` is fixed when a
   `WebAssembly.Memory` is created and cannot change later, and an unshared memory cannot be handed
   to another worker. Plain loads and stores on shared memory cost the same, so single-thread mode
   loses nothing by it. What it costs is the page: a `SharedArrayBuffer` exists only under
   `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy`, which constrain how the player
   is embedded (an iframe, third-party resources, sign-in pop-ups). Today shared memory is optional
   — the audio ring and the log journal fall back without it; from stage 1 the engine requires it,
   and the product has to say so.
5. **Each stage lands in single-thread mode first** and is accepted there before multi-thread mode
   is switched on for it.
6. **A run can be made reproducible.** Today a run is a function of its inputs: one executor, a
   quantum counted in guest instructions, a journal of what the host answered. That is what lets a
   bug from a browser run be replayed in node and bisected there. Every stage keeps a pinned mode —
   one executor, no scaling decisions, the same journal as `main` — and the journal records every
   decision the driver takes, so a run that went wrong under scaling can be replayed pinned.

Acceptance is measured as the translator's work is today: frame times in a browser vary by a tenth
to a quarter from one run to the next, so "within noise of `main`" hides a regression of that size.
A stage is accepted on the thresholds in the product plan, on node benchmarks run alternated against
`main`, and on instruction counts (callgrind) where a change claims to cost nothing.

## Before stage 1 — two measurements

The plan's largest cost and its largest gain both rest on numbers nobody has yet.

- **The atomic tax.** Wasm has only sequentially consistent atomics, and x86 programs rely on x86's
  store order: neither stores nor loads are reordered among themselves. On an ARM host plain loads
  may be reordered, so the atomic variant needs ordered loads as well as ordered stores, and on an
  x86 host an ordered wasm store is an `xchg`. Measure the variant — every guest load and store
  atomic, `lock` as read-modify-write — on the instruction corpus's workloads and the cork
  benchmarks, on x86-64 and arm64 hosts.
- **How parallel the programs are.** The kernel's scheduler already knows, every turn, how many of
  a process's threads are ready. Record the share of time two or more are ready, per title, over
  the titles the project runs. Several executors pay only where that share is large (stage 3).

Neither needs any of the stages: both are a script and a counter.

## Stage 1 — Layering, one executor

**Goal.** The layers the platform needs, with today's engine running on them exactly as it does
now: one executor, plain translations.

**Work.**

- **Shared guest memory.** `cork-host.js` creates the guest memory with `shared: true`; the page
  is cross-origin isolated (principle 4).
- **An executor's state is not in the code.** Translated code reaches the state block, the call
  stack of wasm calls, the entry hash and the other tables by absolute offsets compiled into every
  module (`load offset: layout.eflags`). Two executors over one memory need a state block each, so
  either each executor has translations of its own — no sharing, and `emitBatch` per executor — or
  the emitter addresses that state from a base the instance is given. The second keeps one cache
  for all executors at the cost of an add per access, to be measured on the benchmarks before it
  is chosen. The function table's indices must then be the same in every executor, or the entry
  hash becomes per executor too.
- **Executors.** In the `cpu` layer an executor becomes a thing of its own: a thread with its own
  module instances, function table and state block over the shared memory. Publishing a
  translation and dropping one when code is written are addressed to every executor: page flags in
  shared memory plus an epoch each executor checks.
- **Win32 split in two.** The system-wide half (process table, registry, file system, window
  manager, named objects, clipboard) and the per-process half (handles, heaps, modules, TLS,
  message queue, Direct3D and OpenGL recording), with one interface between them. In single-thread
  mode it is a direct call; across threads, a ring and a wait. A wait for a reply to `SendMessage`
  is not a plain wait: a thread blocked in it must still take the messages other threads send to
  its own windows, or two threads sending to each other deadlock; the interface carries that from
  the start.
- **Inbound rings** for input, I/O completions, renderer answers and published translations, in
  place of `postMessage` into the thread that runs program code.

**Accepted when** every existing suite passes unchanged, the journal of a pinned run is the same
bytes as `main`'s on the integration programs, and the benchmarks are within the product plan's
thresholds of `main`.

## Stage 2 — Processes and services in workers of their own

**Goal.** The engine thread becomes the system, processes run in workers of their own, and the
services scale with the load. Every process still has one executor.

This is where the evidence in [Why](#why) points: the graphics worker's gain came from taking work
off the thread that runs the program, not from running the program's threads at once.

**Work.**

- **Split the engine worker** into the coordinator (event loop, I/O, network, system-wide Win32,
  pools, driver) and process workers (cork, per-process Win32).
- **A window manager for the run** ([windows.md](windows.md)): every process's windows, as its
  user32 tells it, with their order across processes, foreground and capture, and views -- the
  GDI compositor, input, later a JS view -- that subscribe to it, in place of the rules that ignore
  other processes' windows. It comes before the translation pools.
- **Processes side by side.** Each process runs in its own worker with its own memory, sized per
  process (`memorySize`). This replaces process replacement (`roadmap/decisions.md`, C) and the
  copy-back after a child exits: the registry and files are the system's, so what one process
  writes another sees at once. Separate memories also remove the reason replacement was chosen,
  two images wanting `0x400000`.
- **What two processes share in memory.** A named file mapping two processes both map, a DLL's
  shared section, `ReadProcessMemory` and `WriteProcessMemory` all expect one set of bytes visible
  from two address spaces, and a region of one `WebAssembly.Memory` cannot be shown inside
  another. Each needs a mechanism of its own — a copy kept coherent at the points the program can
  observe (a wait, a message, a call that maps or unmaps), or a second shared memory both process
  workers import — chosen per case by measurement; launchers and installers are where they occur.
- **Threads that are always there.** Two: the coordinator (the host) and the graphics worker.
  Graphics stays one thread: everything a WebGPU device makes lives in the thread that made it, and
  the calls of a frame run in order. What in graphics is pure — shader bytecode to WGSL, DXT
  decoding, format conversion — goes to the pool as jobs. The AudioWorklet is the browser's own
  audio thread.
- **Process workers.** One per running process, apart from the pool, for as long as the process
  runs. Running code stays there; nothing of it moves to the pool.
- **The worker pool.** Workers that take any job without state: a batch of translation (formed,
  emitted and compiled), zstd blocks, `ijl15`, the pure part of graphics. Two priorities: urgent,
  which code is waiting for (the batch of a region the interpreter keeps meeting, a block a thread
  reads), and background (relinks of hot code, reading ahead). A pool worker works for one process
  at a time. One that works for none sleeps on `Atomics.wait` and holds nothing — no core, nothing
  of any process — so it costs memory only: an operating system schedules only threads that have
  something to run.
- **What a worker holds.** Nothing between jobs. Translation does keep something worth keeping:
  the functions already emitted, which a relink or a merge takes again instead of emitting them
  anew — today a cache of up to 48 MB inside the translation worker. That is the process's, not
  the worker's: it is keyed by the process's code, and a second worker with a cache of its own
  would miss what the first one kept. A worker's heap cannot be shared or handed to another
  worker — each has its own; what workers share is bytes (`SharedArrayBuffer`, a shared
  `WebAssembly.Memory`) and compiled modules, which a message passes without copying their code.
- **The translation cache arena** (decided 2026-10-07). So the cache becomes bytes in an arena of
  the process's own, in shared memory, made with the process and gone when it exits. Every pool
  worker working for the process looks functions up there and adds the ones it emits; a worker that
  joins finds what the others emitted, and one that leaves takes nothing with it. An entry is bytes
  only — the function's body, locals and hints, its type, the region's shape and what the emitter
  answered for it, encoded — behind an index in the same memory keyed by the key the cache has
  today. A worker adds an entry by taking space with an atomic add and publishes it by one atomic
  store into the index, so a reader sees an entry whole or not at all, and two workers that emit the
  same function at once both stay correct (the second copy is wasted, not wrong). The arena is
  filled lazily, by the translation that happens anyway, grows up to its limit (48 MB, as now) and
  frees space a segment at a time, the oldest first; that this keeps the hits the cache's
  least-recently-used order keeps is checked before it lands, by replaying the recorded lookups of
  Doom 3 and Tron through both. The arena lives as long as the process, quiet or not: its memory is
  the process's, bounded by its limit, and a later load of the same process starts from what the
  earlier ones left in it. Its gate: seeded batches emitted through several workers sharing an arena
  and through one worker with no cache give the same module bytes, and the cache's counters say how
  many functions came from the arena.
- **The rule** (decided 2026-10-07). With n processes running:
  - **Always there:** the two threads above, n process workers, and n pool workers — each process
    has one from its start to its exit, since translation never quite stops.
  - **Joining.** Pool workers join a process lazily, one at a time, when the median load of the
    pool workers already working for it — the share of a window each was busy — comes to 80 %.
    The median, not the sum or the busiest: it says the work is spread over them and each is near
    full, so one more would take a share. Two workers at 90 % and 10 % have a median of 50 %: the
    work does not split (one chain of batches, each waiting for the last), and a third would sit
    as idle as the second. With one worker the median is its own load — Doom 3's 70–95 % while
    loading joins a second. The 80 % mark and the window are where the driver starts, not
    measured: both are checked on the recorded series below before the driver runs.
  - **Ceilings.** At most `hardwareConcurrency` (hc) pool workers work for one process; the pool
    holds at most hc × n. These count workers, not cores: a process that waits keeps none of its
    joined workers busy, so the ceiling of the whole is not what limits the machine — the median
    rule is, as each process asks only for what it can use.
  - **The trial** (added 2026-10-07, measured). A busy worker is not yet a worker that helps: on
    four cores one translator already leaves no core free while a game loads -- the engine's thread,
    the translator and the browser's own threads take 2.5-3.6 of them -- and two or three
    translators for one process loaded Doom 3 and Tron slower than one (`negative-results.md`,
    2026-10-07). So each join is weighed: unless the regions the process's workers emit a second,
    over the next two windows in which its work lasts, rise by half of what one more worker adds at
    best, the worker leaves and the process keeps that many as its ceiling for the run. No other
    worker joins it while a join is being weighed.
  - **Leaving.** Joined workers leave a process lazily, after seconds of its median well below the
    mark, and at once when the process stops translating to wait; they go back to the pool and
    sleep. Joining is quick (a window of a few hundred milliseconds), leaving slow, so the pool
    does not swing. A process that waits keeps its arena, so when it resumes the workers that join
    it find what was emitted before. When a process exits, its workers and its arena go, and the
    pool's ceiling falls by hc.
- **The driver.** In the coordinator, one for the whole engine. Workers write their own state into
  shared memory — busy or idle, queue length, time at work — the way the engine already publishes
  its journal and counters for the log keeper, so the driver only reads. Each decision is a
  comparison of a few numbers between scheduler turns, and each is written to the journal
  (principle 6); a pinned run keeps the pool's size fixed. Its thresholds are chosen on recorded
  series of real loads, replayed through the driver as a test, before it runs in the engine.
- **Measured** (2026-10-07, node 22, 4-core x86-64 VM, `cork2` f39364f2, one translation worker;
  `tools/launch-probe.mjs --series`). While loading, the one translation worker is the bottleneck:
  Doom 3 busy 70–95 % of the time with work queued behind the batch out 90–98 % of it and up to
  2,807 regions queued; Tron's game up to 90 % busy, 1,183 queued. Run warm from a filled
  translation store, Doom 3 reached the end of loading in 13–15 s instead of 20 s (three runs):
  about a third of its loading is translation, the most a faster translator can take. After
  loading the worker is busy under 1 % of the time. Two threads were ready at once 0–4 % of the
  time (`negative-results.md`, 2026-10-07).
- **Measured: what a worker holds** (2026-10-07, same machine; one cold run each, Doom 3 60 s and
  Tron's game 40 s; Chromium 141 headless). Idle, a worker is small: in Chromium the JS heap of
  four idle workers was 1.1 MB without the emitter and 7.6 MB with it loaded, about 2 MB each
  (`performance.measureUserAgentSpecificMemory`, which counts the JS heap and not the thread
  itself); in node an idle worker with the emitter loaded added 15 MB of resident memory (eight at
  once). Loading, the translation worker's cache reached its 48 MB limit within 18 s; at the end
  the worker held 31–37 MB of heap besides the cache, and its heap had peaked at 225 MB on the way
  (garbage of emitting). The cache pays: without it the worker was busy 23.3 s instead of 14.6 s
  for Doom 3 and 15.2 s instead of 9.9 s for Tron. Replayed under other limits, its hits are 10 %
  of lookups at 16 MB, 29 % at 24 MB, 33 % at 48 MB and 33 % unbounded (83 MB at most) for Doom 3;
  21 %, 21 %, 29 % and 29 % (76 MB) for Tron — a few megabytes keep almost nothing. Doom 3 took
  no hits after its 39th second.

| Thread | How many | Joins when | Leaves when |
| --- | --- | --- | --- |
| Coordinator (host), graphics | 1 each | — | — |
| Process worker | one per running process | the process starts | the process exits |
| Pool, a process's first | one per running process | the process starts | the process exits |
| Pool, joined to a process | up to hc − 1 more per process; the pool at most hc × n | the median load of the process's pool workers comes to 80 % | the process waits, or seconds well below the mark; with the process |

| Setting | Today | Larger |
| --- | --- | --- |
| Processes, P | 1: a child and its parent take turns | P process workers, each with its own memory |
| Executors per process, N | 1: on the engine thread | 1 here; N with the atomic variant in stage 3 |
| Translation | 1 worker per process, one batch out | 1 to hc pool workers per process, several batches out, one arena |
| Host work | on the engine thread or in the process | pool jobs; the program thread waits as it waits for a file |
| Graphics (`graphicsWorker`) | 1: Direct3D 7, 8, 9, OpenGL | 1: all graphics and the canvas |
| Guest memory | ordinary `WebAssembly.Memory` | shared (`shared: true`) from stage 1 |

**Accepted when** with the minimums the benchmarks are within the thresholds of `main`, a parent
and a child process run at the same time and see each other's registry and file writes, and under
a synthetic load the driver grows and shrinks each pool without oscillating, and workers joining
a loading process take functions from its arena — its hits no fewer than one worker's own cache
gets today.

## Stage 3 — More executors per process

**Goal.** A process whose threads are ready at the same time runs them at the same time — where the
measurement before stage 1 says that pays.

**Work.**

- **The atomic variant.**
  - *plain* — today's code.
  - *atomic* (landed, `emit/locked.js`) — `lock`-prefixed instructions and `xchg` with memory
    become wasm atomics: the threads proposal's read-modify-write where it has one, a
    compare-and-swap loop where it has none (adc, sbb, neg). A misaligned wasm atomic traps where
    x86 does not, so an access off its alignment inside one aligned qword is a compare-and-swap of
    the qword, and one across two qwords (a split lock, which hardware too makes the slow
    exception) a plain read-modify-write, not indivisible against another executor. Plain loads
    and stores stay plain: on an x86 host they keep the processor's order; elsewhere what they
    promise another thread is the atomic tax's question.

  The store's key already carries a variant (`runtime/cache.js`); the two are kept side by side.
  The interpreters, JavaScript and wasm, get the same variant: the host runs them where no region
  can be made.
- **What the translator assumes of one executor.** Some of cork's optimisations hold only while
  nothing else writes memory between two instructions: stores to the stack without a page check
  (no translated code on a stack page), page checks hoisted out of loops for a window of accesses,
  leaving at once after a store into code. Each is re-examined for the atomic variant, and kept,
  narrowed or turned off there.
- **Choosing the mode.** Switching a running process means every thread stops at a quantum
  boundary, its translations are dropped and the atomic ones loaded — seconds of stall for a
  program with thousands of regions. So the mode is chosen when a process starts, from what the
  translation store recorded of the program's earlier runs, and switched while it runs only after
  a long spell that contradicts it.

| Pool | Min | Max | Grows when | Shrinks |
| --- | --- | --- | --- | --- |
| Executors of a process | 1 | `hardwareConcurrency`, at most the process's thread count | two or more of its threads are ready most of the time | rarely, after a long quiet spell: it is a mode switch |

**Measured** (2026-10-08, `tools/executor-sweep.mjs`, node 22.22.0, a 4-core VM, no browser;
three runs a point, medians): a synthetic program of T threads, each on its own data, with a
`lock add` every 256 iterations or none and a host call every 4 096 or 65 536 or none, ran
x1.53 to x1.91 faster with two threads on three or four executors than on one, and x1.88 to
x2.58 with three threads on four; the more locks and host calls, the larger the gain. It ran
slower -- x0.64 to x0.86 -- with more threads than executors past the process's own, and never
faster with two executors in all (`negative-results.md`). One thread lost nothing on any count
(x0.94 to x1.10). Doom 3, one executor, against `728d9672` before this stage: loading to the same
mark in 17 s against 18 s (medians of six runs), the rate after it 14.56 against 14.78 M/s
(three 70 s runs each, spread about 7 %): not distinguishable.

**Measured** (2026-10-15, 7-Zip 26.04 x86 `7zr.exe b -md22`, sha256 `256feca8e274e5da…`, through
`createApp` with `cpu: { cores }`; node 22.22.0, a 4-core x86-64 KVM VM, Intel Xeon @ 2.80 GHz, no
browser, power plan not recorded; three runs a point, base and new alternated, total rating in
MIPS, medians with the raw values): base `a6925e9b` -- 1 core 1119 (1053 1177 1119), 2 cores 1218
(1167 1222 1218), 4 cores 1563 (1563 1535 1635); new `89ab808d` -- 1 core 1154 (1154 1162 1084),
2 cores 1678 (1678 1740 1636), 4 cores 3164 (3317 2901 3164). Against one core: x1.09 and x1.40
before, x1.45 and x2.74 after; decompressing, whose threads are independent, x3.28 on four
(4547 against 1385). The same benchmark built for the host (`7zz` 23.01 x64) on the same machine:
x2.19 and x4.25. What the executors' time went to, before: the second of two ran its thread one
quantum at a time and waited on the process for the next, idle 57% of its life (153 731 slices
in 45 s; the scheduler let it go on only when no thread it had given the process's own executor
was still ready, which that one always was). Left after: phases where the program has fewer ready
threads than executors (gaps past 5 ms were 7 of an executor's 33 s on two), its calls answered
only at the process's crossings and between its turns (0.5 ms each on average), the process's
own turns kept a quantum long while others run (a single-threaded run on two executors 10-15%
below one), and the atomic variant (4% of the total on one executor, 8% of decompressing).

**What it costs, and when it pays.** The atomic variant makes every executor slower by the tax *t*
measured before stage 1. Two executors win when their speedup *S* satisfies *S* × (1 − *t*) > 1.
At *t* = 20 % that is *S* > 1.25, which by Amdahl's law needs more than 40 % of the work to run in
parallel. A program with one busy thread never pays the tax.

**Accepted when** in multi-thread mode with a single executor every suite passes on the atomic
variant, a test set of programs that synchronise through `lock` instructions and plain stores
(message passing, spin locks, interlocked counters) gives the same results as on one executor, and
the titles the measurement picked run faster than on one executor by the product plan's margin.

## Stage 4 — x86-64

**Goal.** 64-bit programs, on the platform built above.

**Work.**

- **`cork-x64`**, a package of its own on the same executor contract, reusing cork's `./wasm` and
  `./runtime`. The contract's fields are already named for `bits: 64` (`cpu/engine.js`), with
  `gsBase` beside `fsBase`. The seams cork was built with for this carry over: the decoder takes a
  mode, the IR and the lazy-flag algebra are written for sizes up to 8, the state layout has a
  width, the entry hash keys on a full address, guest addresses are numbers below 2^53 on the
  JavaScript side, and the emitter takes the address type from the layout.
- **Bitness is a property of the process.** The loader reads the PE machine field (`0x014c` x86,
  `0x8664` x64) and starts the process worker on cork or cork-x64. 32- and 64-bit processes run
  side by side, as under WOW64. The system adds the WOW64 redirections: `System32` and `SysWOW64`,
  and `Wow6432Node` in the registry.
- **Win32 with 64-bit structure layouts.** Pointers and handles are 8 bytes and alignment differs,
  so every handler that reads or writes a program's structure needs its 64-bit layout. This is the
  largest part of the stage.
- **The x64 calling convention** in the bridge: RCX, RDX, R8, R9 and the shadow space, one
  convention instead of stdcall, cdecl and thiscall. COM method tables with 8-byte slots.
- **Exceptions.** x64 SEH is table-based (`.pdata` and `.xdata` unwind information) rather than a
  chain of frames on the stack, so the dispatcher is new.
- **PE32+** in the loader (`loader/internal/pe.js` accepts i386 only today), synthesised PE32+
  system DLLs and 64-bit trap stubs. `out dx, eax` works the same in 64-bit mode.
- **The address space.** A 64-bit program expects addresses above 4 GiB; its image defaults to
  `0x140000000`. Either wasm `memory64`, with a 64-bit index, or a 32-bit memory with everything
  placed inside a 4 GiB window, relocating images below it. The emitter's address type is one
  setting, so the choice touches one file; see the open questions.

**Accepted when** a set of 64-bit test programs and the x86-64 instruction corpus pass on
cork-x64, alone and beside a 32-bit process.

## Stage 5 — Direct3D 11

**Goal.** Direct3D 11, which most 64-bit games draw with — and many 32-bit ones from the years
before them. It needs nothing of stages 1 to 4 and can be built alongside any of them. The
`graphics` layer has DirectDraw, Direct3D 7 to 10, OpenGL and Vulkan today.

**Work.** Direct3D 11 and its DXGI on the WebGPU backend, recorded where the program runs and
played in the graphics worker as Direct3D 7 to 9 are; shader bytecode (shader models 4 and 5)
translated to WGSL; what Direct3D 10 already has (DXGI formats, its pipeline objects) shared rather
than copied.

**Accepted when** the layer's unit and contract tests and reference-frame comparisons cover it as
they cover Direct3D 9, and a Direct3D 11 program draws in the browser harness.

## Stage 6 — ARM and ARM64

**Goal.** Windows programs built for ARM (PE machine `0x01C4`) and ARM64 (`0xAA64`), as further
engine packages on the same executor contract, chosen per process the way cork and cork-x64 are.
ARM64EC and ARM64X binaries mix x64 and ARM64 code in one process and would need two engines in
one executor.

## Open questions

- **The atomic tax** (measured before stage 1): how much the atomic variant costs per executor on
  x86 and on ARM hosts, and whether ordering can be limited to fewer than every load and store
  without breaking programs that rely on x86's order. Wasm offers no acquire and release
  orderings yet; the proposal that adds them would change the answer.
- **Executor state: a base or translations per executor** — decided 2026-10-08: translations per
  executor. Each executor's layout moves its state block, its tables and the wasm interpreter's
  statics into a state page of its own (`executorLayout`), so its translations carry its
  addresses as constants and cost nothing at run time; the price is a translation per executor.
  The base was measured at +23 to +37 % per turn on a worst-case loop of state accesses (node,
  three runs; not measured on the benchmarks). The wasm interpreter is built position-independent
  for it: measured 0 to 7 % slower on interpreted-only runs of the cork bench (node, x87,
  `translate: false`, three alternations; noise about ±6 %).
- **The host's unbroken routines under several executors** (stage 3). Guest code the host writes
  -- the seams that record Direct3D and OpenGL calls -- is marked so that no slice ends inside it,
  because another thread's call into the host reads what it writes. With threads running at once
  that holds no more: one thread can be inside such a routine while another's call is answered.
  Until the routines are made safe against that (a host call around them, or records each
  thread owns), a process that runs them is one to keep on one executor.
- **Memory shared between processes** (stage 2): which mechanism for named mappings, shared
  sections and cross-process reads and writes, and which programs need them coherent rather than
  copied at a wait.
- **Cross-origin isolation:** which ways of embedding the player it rules out, and whether any of
  them matter to the product.
- **The x64 address space:** `memory64` or a 4 GiB window. `memory64` ships in Chrome and Firefox;
  whether Safari has it decides whether it can be the only path.
- **Memory per process on phones:** how many process memories a phone's browser allows at once,
  and the default `memorySize` for a helper process. A shared memory reserves its maximum when it
  is created.
- **Stage 6's scope:** whether it is Windows-on-ARM programs alone, as written here.
