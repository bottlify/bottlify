# cork settings

[По-русски](SETTINGS.ru.md) · [README](README.md)

Every number cork works with is a setting. Pass them as `config` to `createMachine`,
`--config '<json>'` to `cork run`, or `createApp({ cork: { config } })` in `@bottlify/core`. What is
left out keeps its default. The defaults are what games were measured with: change one to try
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
| `loadingBatch`, `loadingShare` | 16, 0.25 | While the translation worker loads, the largest batch emitted on the main thread and the share of time it may take; where `holdMs` bounds the work there, none: a batch waits for the worker. | Lower for smoother starts, higher to translate earlier. |
| `holdMs`, `holdShare` | 4, 0.5 | Where a translation worker is wanted, the engine thread's time the translator's work may take at a stretch and the share of its time over a while: a batch is formed over several calls, the store's hits are compiled off the thread, started a few at a call, and they and a translation worker's answers are published a few at a call. 0 forms and publishes a batch whole in one call. | Lower for smoother frames when a program reaches new code, higher to translate it sooner. |
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
| `maxRegionBlocks`, `maxRegionBytes` | 128, 8192 | The largest region; the entry's own function may take as much again past them, the callees formed into it stop at them. | Larger regions keep more in one wasm function: faster loops, longer compiles. |
| `structure` | `true` | A region's loops as wasm loops. | `false` sends every back edge through the region's dispatch: much slower; for comparison only. |
| `leafCalls` | `true` | A small leaf callee formed into its caller. | Off to rule it out. |
| `leafBlocks`, `leafBytes` | 16, 512 | How large such a callee may be. | Larger inlines more and grows regions. |
| `formDepth` | 1 | How many levels of callees formed in may keep direct calls of their own, their small callees formed in as well (0: leaves alone). | Deeper forms more of a call chain into one region and grows it; the region's limits bound it. |
| `switchEntries` | 1024 | Entries of a switch's jump table followed when forming. | Larger for giant switches (interpreters); regions grow. |
| `runtimeHelpers` | `true` | Compiler helpers such as MSVC's `_ftol2` formed as what they do. | Off to rule it out. |
| `callReturn` | `true` | A call out of a region is a wasm call, and the region goes on after the `ret`. | Off makes every return go through the entry hash. |
| `emptyCalls` | `true` | A call to a function that does nothing (a `ret` or `ret imm16`, after at most three direct jumps, such as an incremental linker's thunk to an empty virtual method) returns at the transfer, without entering a region. | Off to rule it out. |
| `emptySites` | `false` | With `emptyCalls`, a call out of a region (outside x87 code) reads its target's slot in the entry hash first and returns from such a function in place, without calling the transfer. | A call to an empty method costs about a third of what the transfer leaves it; every other call out of a region reads one more slot, about a nanosecond. |
| `callTargets` | `true` | Indirect calls sampled and their few small callees formed in; a call found to have none worth forming in is sampled no more. | Off to rule it out. Far Cry ran 4-6% faster with it in Chromium; regions formed again for it are formed under `holdMs`. |
| `predictAfter`, `predictShare`, `predictCallees`, `reforms`, `callWindow` | 48, 8, 4, 3, 64 | With `callTargets`: samples before callees are looked at, the share a callee must take (one in this many), callees compared, times a region is formed again, the sampling window. | Tuning `callTargets`. |
| `dispatch` | `false` | A module placed in a range of the table, a transfer inside it a direct tail call. | Measured slower in games with `callTargets`; try alone. |
| `relinkAfter`, `relinkRegions` | 16, 512 | Batch modules published before running regions are gathered into large ones, and how many go into each (0: never). | Fewer, larger modules make transfers cheaper; gathering 4096 regions held a thread 160 ms. |
| `mergeAfter` | 2^16 | Transfers between two modules before they are gathered into one (0: never). | Lower merges more eagerly: more rebuilding. |
| `mergeSample`, `mergeEvery`, `mergePerRegion`, `mergesARegion` | 2^20, 2^23, 2^19, 2 | How often crossings are read, the fewest instructions between merges, per region merged, and merges one region may join. | Bounds on merging's own cost. |
| `looseStacks` | `true` | A store through `esp` alone tests no page while no translated code lies on a stack. | Off is slower on every push; only for checking. |

**x87**

| Setting | Default | What it does | When to change it, and the risk |
| --- | --- | --- | --- |
| `wideFirst` | `true` | Each region compiled for the precision control it runs under, tested once a block; one seen under both tests at every rounding operation. | Off tests precision on every operation. |
| `floatSingles` | `true` | A region compiled for single precision computes its arithmetic, square roots and loads in f32 where the operands are floats, each result the processor's 24-bit one; a result past a float's range, or a product under its smallest normal, leaves for the host to compute, and an entry that keeps leaving is compiled again rounding doubles. | Off rounds every result from a double, as before; no other effect. |
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

**Diagnostics**

| Setting | What it records |
| --- | --- |
| `blockProfile`, `blockProfileFrom` | Execution counts per block, from a given second on. Beside them `mechanisms` (how calls and returns went: formed into a region, wasm calls or ways out, why a callee was not formed in, calls to empty functions; transfers through the entry hash; `rdtsc`s) and `forms` (each instruction form's executions and the wasm bytes the hot regions emit for it). |
| `timings` | The translator's phases timed. |
| `traceStore` | Translation store keys. |
| `checkStale` | Regions whose bytes changed. |
| `countTransfers` | Transfers between regions. |
| `undoLog` | The store's undo log, for replay. |

They cost speed; leave them off outside an investigation.

**Store**

| Setting | What it does |
| --- | --- |
| `store` | Where translations are kept between runs (the core gives a store per bundle in OPFS). |
| `bundleId` | The store's namespace. |
| `cacheVersion` | A version above the translator's own empties every store of a lower one. |

A few sizes stay fixed because translated code or the prebuilt wasm interpreter are built around
them: the state block's offsets, the page-flag table (one byte per 4 KiB page), the code-granule
table, and the wasm interpreter's hot-count table.
