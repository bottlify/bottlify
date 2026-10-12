# @bottlify/cork

An x86 (32-bit, user mode) to WebAssembly translator with its runtime. It runs machine code in
JavaScript hosts — a browser or Node — by translating the hot parts of a program into wasm
functions the host compiles to native code, and interpreting the rest. Nothing else is needed: no
emulator, no operating system, no runtime dependencies.

It is the engine [`@bottlify/core`](../core/README.md) runs Windows programs on, but it does not
know about Windows. What a program asks of the outside world — a system call, an I/O port, a
fault — stops the run and is handed to you.

- Integer code, x87, MMX, SSE, SSE2 and SSE3 (what its `cpuid` reports), self-modifying code,
  `lock`-prefixed instructions (as wasm atomics when several threads share memory).
- Flat 32-bit memory up to what wasm allows; no segmentation beyond `fs`/`gs` bases, no
  privileged instructions.

## Try it from a terminal

Node 22 or later. From this repository (`npm ci` once at the root):

```sh
node modules/cork/bin/cork.mjs run program.elf --linux
```

In a project that has the package installed (`npm install <checkout>/modules/cork`), the same
command is `npx cork`.

`cork run <file>` loads a 32-bit little-endian ELF at its own addresses, or flat code at `--at`
(default `0x1000`), and runs it from its entry until it stops. It prints why it stopped, the
registers, and how many instructions ran and how many of them in translated code:

```
fib ok
stopped: exit 0 at 0x00401134
eax 0x00000001  ecx 0x00000000  edx 0x00000000  ebx 0x00000000  esp 0x00ffffe4  ...
6627675 instructions, 6626800 of them translated, 0.051 s
```

| Option | What it does |
| --- | --- |
| `--linux` | Answers `int 0x80` as Linux i386 does for `exit` (1), `exit_group` (252) and `write` (4) to stdout and stderr; every other call gets `-ENOSYS`. Without it, the first `int 0x80` stops the run. |
| `--at addr`, `--entry addr` | Where flat code is loaded; where to start (default: the ELF's entry, or `--at`). |
| `--ram MiB` | Guest memory (default 16, more if the image needs it). The stack starts at its top. |
| `--max n` | Stop after about `n` instructions. |
| `--set eax=1,ecx=2` | Registers before the start. |
| `--config '<json>'` | The translator's settings (below). |
| `--json` | The report as one JSON line on stdout. |

The exit status is the program's under `--linux`, 0 for a `hlt`, 1 for any other stop.

That is the program below, which needs no C library:

```c
// fib.c -- clang --target=i386-linux-gnu -O2 -nostdlib -static -ffreestanding -fno-pic
//          -fuse-ld=lld fib.c -o fib.elf
static int sys(int n, int a, int b, int c){
    int r;
    __asm__ volatile("int $0x80" : "=a"(r) : "a"(n), "b"(a), "c"(b), "d"(c) : "memory");
    return r;
}
static unsigned fib(unsigned n){ return n < 2 ? n : fib(n - 1) + fib(n - 2); }
void _start(void){
    char text[] = "fib ok\n";
    if (fib(27) == 196418) sys(4, 1, (int)text, 7);
    sys(1, 0, 0, 0);
}
```

`cork translate <file> --entry addr -o out.wasm` writes what the translator makes of the code at
an address: one region as a wasm module, to read with `wasm2wat` or `wasm-objdump`. It imports the
memory with cork's register block in it and the runtime's helpers, so it is for reading, not for
running alone.

## Use it from JavaScript

```js
import { createMachine } from '@bottlify/cork';

const machine = createMachine({ ramSize: 16 << 20 });
// mov ecx, 1000; L: mov eax, ecx; int 0x80; add edi, eax; dec ecx; jnz L; hlt
machine.load(0x1000, [0xb9, 0xe8, 3, 0, 0, 0x89, 0xc8, 0xcd, 0x80, 0x01, 0xc7, 0x49, 0x75, 0xf7,
    0xf4]);
machine.setReg('eip', 0x1000);
machine.setReg('esp', (16 << 20) - 16);

for (;;)
{
    const stop = await machine.run();
    if (stop.reason === 'interrupt' && stop.vector === 0x80)
    {
        // Your system call: eip is already past the int.
        machine.setReg('eax', machine.reg('eax') * 2);
        continue;
    }
    console.log(stop.reason, machine.reg('edi'));   // halt 1001000
    break;
}
await machine.dispose();
```

`createMachine({ ramSize, config, trapPort })` gives you guest memory and registers and a `run`
that interprets cold code, translates what gets hot (in a worker in a browser, inline in Node) and
runs it, until the program needs you:

| `stop.reason` | What happened | Where `eip` is |
| --- | --- | --- |
| `halt` | `hlt` | after it |
| `interrupt` | `int n`, `int3`, `into`; `stop.vector` is `n` | after it, as the processor pushes it |
| `fault` | an exception: `#DE` 0, `#UD` 6, `#GP` 13, …; `stop.vector` | at the instruction |
| `trap` | an `out` to the trap port (every `out` when no `trapPort` is given); `stop.value` | after it |
| `unsupported` | an instruction neither tier has a model for; `stop.op` | at it |
| `limit` | `run({ maxInstructions })` ran out (translated code may run a few past it) | wherever it was |

`stop.retired` and `stop.translated` count the instructions the run retired and how many of them
ran as translated code. The machine also has `load`, `read`, `reg`/`setReg` (the eight general
registers, `eip`, `eflags`), `memory` (the `WebAssembly.Memory`), `layout` (where each register
lives in it), `diagnostics()` and `dispose()`.

`regionModule({ code, at, entry })` is `cork translate` as a function: the wasm bytes of one region
and the blocks it formed.

### Settings

Every number the translator works with is a setting. Pass them as `config` to `createMachine`,
`--config '<json>'` to `cork run`, or `createApp({ cork: { config } })` in `@bottlify/core`; what
is left out keeps its default. The defaults are what games were measured with: change one to try
something, and measure it.

**Correctness and variants**

| Setting | Default | What it does | When to change it, and the risk |
| --- | --- | --- | --- |
| `precise` | `false` | x87 exception flags, signalling NaNs, underflow, C1 and the flags an instruction leaves undefined kept exactly as the processor keeps them. | On for conformance tests and for a program that reads those bits. Slower x87 code. |
| `checkReads` | unset | An instruction that only reads tests its pages as a store does, so a page the program cannot reach faults with its address; the core closes a reservation's pages not committed and those protected `PAGE_NOACCESS` unless this is `false`. | Unset, reads are wrapped into RAM until the program first faults on such a page in a tier that tests it, and tested from then on; a page first touched by code already translated reads zeros. `true` tests from the start; `false` never closes a page. |
| `atomic` | `false` | `lock`-prefixed instructions and `xchg` with memory as wasm atomics. | On when several threads run on several executors over one memory (the core sets it). Off there, two threads can lose updates. |
| `translate` | `true` | `false` interprets everything. | A reference run to compare against when translated code is suspected. Many times slower. |
| `leaveOut` | `[]` | Instruction classes (`'x87'`, `'mmx'`, `'sse'`) left to the interpreter. | Finding which class a defect is in. Slower, and no translation store is kept. |
| `interpretRange` | none | `[from, to)`: addresses left to the interpreter. | Narrowing a defect down to code. |
| `trapPort` | none | The I/O port whose `out` is the host's call. | Set by the host that owns the call channel. |

**When code is translated**

| Setting | Default | What it does | When to change it, and the risk |
| --- | --- | --- | --- |
| `hotThreshold` | 2 | Times the interpreter reaches a jump target before it is a candidate (the core's host; `createMachine` counts 50 unless given). | Higher translates less cold loader code; lower starts sooner and translates more that runs once. |
| `missThreshold` | 64 | Exits from translated code to one address before it is a candidate itself. | Lower links code sooner; a target only reached rarely is then translated for nothing. |
| `maxQueued` | 8192 | Candidates waiting at most; past it the coldest is dropped. | Larger for a program with a very large hot set. Memory. |
| `batchRegions` | 32 | Regions per wasm module. | Larger modules: fewer of them, longer compiles and longer stalls instantiating one. |
| `maxBatchRegions` | 256 | The most one batch takes when the queue is deep. | As above. |
| `loadingBatch`, `loadingShare` | 16, 0.25 | While the translation worker loads, the largest batch emitted on the main thread and the share of time it may take. | Lower for smoother starts, higher to translate earlier. |
| `inFlightMs` | 10000 | How long a batch may be with a worker before it is given up. | Lower only in tests. |
| `volatileAfter` | 8 | Writes that drop one page's code, within `volatileWindowMs`, before the page is left to the interpreter. A write that leaves the bytes as they were drops nothing. | Higher for a program that rewrites code often but runs it long; lower if it keeps rewriting. |
| `volatileWindowMs` | 100 | The window `volatileAfter` counts in. | Longer to give up on a page rewritten less often. |
| `volatileHoldMs` | 2000 | How long a volatile page is interpreted before it is translated again; doubles each time it is left again. | Longer for code that keeps changing for good. |
| `worker` | on where `Worker` exists | Emit and compile in translation workers. | `false` translates on the calling thread: simpler, but every batch stalls it. |
| `workerUrl` | beside the runtime | Where `translator.worker.js` is. | When a bundler moves it. |
| `translators` | 1 | Workers the runtime opens itself; 0 when a host's pool lends them. | More when cores are spare and loading translates a lot. |
| `arenaBytes` | 48 MiB | The shared memory every translator of a process keeps emitted code in (0: none). | Larger for programs with many hundreds of thousands of blocks. |

**What a region is and how regions meet**

| Setting | Default | What it does | When to change it, and the risk |
| --- | --- | --- | --- |
| `maxRegionBlocks`, `maxRegionBytes` | 128, 8192 | The largest region. | Larger regions keep more in one wasm function: faster loops, longer compiles. |
| `structure` | `true` | A region's loops as wasm loops. | `false` sends every back edge through the region's dispatch: much slower; for comparison only. |
| `leafCalls` | `true` | A small leaf callee formed into its caller. | Off to rule it out. |
| `leafBlocks`, `leafBytes` | 16, 512 | How large such a callee may be. | Larger inlines more and grows regions. |
| `switchEntries` | 1024 | Entries of a switch's jump table followed when forming. | Larger for giant switches (interpreters); regions grow. |
| `runtimeHelpers` | `true` | Compiler helpers such as MSVC's `_ftol2` formed as what they do. | Off to rule it out. |
| `callReturn` | `true` | A call out of a region is a wasm call, and the region goes on after the `ret`. | Off makes every return go through the entry hash. |
| `callTargets` | `false` | Indirect calls sampled and their few small callees formed in. | Benchmarks of virtual calls gain 4-5x; games measured slower with it. |
| `predictAfter`, `predictShare`, `predictCallees`, `reforms`, `callWindow` | 48, 8, 4, 3, 64 | With `callTargets`: samples before callees are looked at, the share a callee must take (one in this many), callees compared, times a region is formed again, the sampling window. | Tuning `callTargets`. |
| `dispatch` | `false` | A module placed in a range of the table, a transfer inside it a direct tail call. | Measured slower in games with `callTargets`; try alone. |
| `relinkAfter`, `relinkRegions` | 16, 512 | Batch modules published before running regions are gathered into large ones, and how many go into each (0: never). | Fewer, larger modules make transfers cheaper; gathering 4096 regions held a thread 160 ms. |
| `mergeAfter` | 2^16 | Transfers between two modules before they are gathered into one (0: never). | Lower merges more eagerly: more rebuilding. |
| `mergeSample`, `mergeEvery`, `mergePerRegion`, `mergesARegion` | 2^20, 2^23, 2^19, 2 | How often crossings are read, the fewest instructions between merges, per region merged, and merges one region may join. | Bounds on merging's own cost. |
| `looseStacks` | `true` | A store through `esp` alone tests no page while no translated code lies on a stack. | Off is slower on every push; only for checking. |

**x87**

| Setting | Default | What it does | When to change it, and the risk |
| --- | --- | --- | --- |
| `wideFirst` | `true` | Regions compiled for the precision control in force, tested once a block. | Off tests precision on every operation. |
| `x87Shapes` | `true` | Regions compiled for the stack's shape at their entries. | Off checks every register access. |
| `checkedAfter` | 4 | Failed shape tests before a region is formed again without one. | Lower for code entered with varying stacks. |

**Memory layout and records**

| Setting | Default | What it does | When to change it, and the risk |
| --- | --- | --- | --- |
| `hashSlots` | 2^20 | Slots of the entry hash translated code looks targets up in (12 bytes each, a power of two). | A program past ~780k block starts needs more; a full hash sends its overflow through the host on every transfer. |
| `hashLoad` | 0.75 | Share of slots live past which new entries stay out of the hash. | Higher packs more in with longer probes. |
| `exitTargets`, `missesKept`, `callSitesKept` | 4096 each | Bounded records of exit targets, miss counts and tried call sites. | Larger for diagnostics on big programs. |
| `sharedMemory` | `true` where possible | Guest memory a `SharedArrayBuffer`. | `false` keeps it private (no other executor can run on it). |

**The core's host (in `@bottlify/core`)**

| Setting | Default | What it does | When to change it, and the risk |
| --- | --- | --- | --- |
| `wasmInterpreter` | `true` | The interpreter's integer, x87 and SSE instructions in wasm. | Off runs the JavaScript interpreter alone: slower. |
| `wasmInterpreterAfter`, `newTargetWork` | 8192, 128 | Work the JavaScript interpreter does before the wasm tier takes over, a new target counting as 128. | 0 starts the wasm tier at once. |
| `feed` | `'frame'` | When candidates are formed: once a frame, or after every slice (`'slice'`). | `'slice'` for programs that never present. |
| `yieldChunk` | 10000 | Instructions translated code runs at a time while a slice may end early (`createMachine`: 2^24). | Smaller reacts faster to other threads, at more crossings. |
| `interpretChunk`, `sliceMs` | 8192, 8 | Instructions interpreted at a time (`createMachine`: 65536), and how long an interpreting slice may take. | Larger interprets in longer stretches: fewer checks, longer holds. |
| `tscDriftMs` | 16 | How far `rdtsc` may run ahead of the guest's clock. | Programs timing with `rdtsc`. |
| `spinMs`, `executorIdleMs`, `executorYieldMs` | 0.05, 2, 4 | With several executors: how long a side looks at their channel before sleeping, how long an executor waits in place, the longest it goes without a turn of its event loop. | Longer spins lower latency and burn a core. |

The core also takes `cork.pool`, `cork.poolPerProcess`, `cork.poolWindowMs` and `cork.poolDriver`
(the translation pool's thresholds) beside `config`, and `quantum` and `executors` on `createApp`.

**Diagnostics**: `blockProfile` and `blockProfileFrom` (execution counts per block, from a second
on, and beside them `mechanisms`: how calls and returns went -- formed into a region, wasm calls or
ways out, a call out by why its callee was not formed in -- transfers through the entry hash and
`rdtsc`s), `timings` (the translator's phases timed), `traceStore` (translation store keys), `checkStale`
(regions whose bytes changed), `countTransfers`, `undoLog` (store undo log for replay). They cost
speed; leave them off outside an investigation.

**Store**: `store` (the per-bundle translation cache), `bundleId` (its namespace) and
`cacheVersion` (a version above the translator's own empties every store of a lower one).

A few sizes stay fixed because translated code or the prebuilt wasm interpreter are built around
them: the state block's offsets, the page-flag table (one byte per 4 KiB page), the code-granule
table, and the wasm interpreter's hot-count table.

## As an engine of `@bottlify/core`

The core loads this package by URL and never imports it: `createEngine` implements the executor
contract in [`engine.js`](../core/src/layers/cpu/engine.js), and the core's own host adds Win32,
threads and the scheduler on top. `@bottlify/core` ships a built copy of it; you only need this
package directly to use the translator on its own, or to load a build of your own with
`createApp({ cork: { moduleUrl } })`.

## Development

```sh
npm test -w @bottlify/cork                  # unit tests and gates, a minute or two
npm run fetch:corpus                        # once: the instruction corpus
npm run test:integration -w @bottlify/cork  # the corpus suites
node modules/cork/bench/run.mjs             # the benchmark (bench/README.md)
```

How the translator is judged:

- **The instruction corpus** (`npm run fetch:corpus`, pinned by `corpus-lock.json`) runs every
  case through the decoder, both interpreters and translated code, against the state real hardware
  recorded.
- **The sequence corpus** (`testing/sequences-judge.js`) runs generated sequences of instructions on
  cork's own instruction model and on translated code, and compares the two bit for bit.
- **Gates** compare every fast path with the slow one beside it on seeded programs: the machine's
  translated runs against interpreted ones (`machine.test.js`), translation workers against inline
  translation (`runtime/translators.test.js`), the shared translation arena
  (`runtime/arena.test.js`), the atomic variant's locked forms against the model
  (`emit/locked.test.js`).

Translation runs in workers (`runtime/translator.worker.js`); what they emit is kept in an arena of
shared memory every translator of a process reads and adds to. How it all fits together:
[`docs/architecture.md`](../../docs/architecture.md); where it goes next: `roadmap/v2/`.

Vanilla ES modules with JSDoc, no runtime dependencies, tests on `node:test`. MPL-2.0.
