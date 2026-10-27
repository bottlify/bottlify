# cork settings

[По-русски](SETTINGS.ru.md) · [README](README.md)

Nearly every number cork works with is a setting. Pass them as `config` to `createMachine`,
`--config '<json>'` to `cork run`, or `createApp({ cork: { config } })` in `@bottlify/core`. What is
left out keeps its default. The defaults are what games were measured with, so change one only
with a measurement beside it.

**Correctness and variants**

| Setting | Default | What it does | When to change it, and the risk |
| --- | --- | --- | --- |
| `precise` | `false` | x87 exception flags, signalling NaNs, underflow, C1 and the flags an instruction leaves undefined kept exactly as the processor keeps them. | On for conformance tests and for a program that reads those bits. Slower x87 code. |
| `checkReads` | unset | An instruction that only reads tests its pages as a store does, so a page the program cannot reach faults with its address; the core closes a reservation's uncommitted pages and the pages protected `PAGE_NOACCESS`, unless this is `false`. | Unset, reads are wrapped into RAM until the program first faults on such a page in a tier that tests it, and tested from then on; a page first touched by code already translated reads zeros. `true` tests from the start; `false` never closes a page. |
| `atomic` | `false` | `lock`-prefixed instructions and `xchg` with memory as wasm atomics. | On when several threads run on several executors over one memory (the core sets it). Off there, two threads can lose updates. |
| `ordered` | `false` | With `atomic`: an integer operand's load and store not through esp as wasm atomics too, where its address is a multiple of its width. | Off unless a page sets it; the core passes it on only for several executors. Off on a host that reorders plain memory accesses (arm64), a thread can see another's flag before the data written ahead of it; on, every such access is an atomic one, about an eighth more machine code there. |
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
| `worker` | on where `Worker` exists, unless `feed` is `'slice'` | Emit and compile in translation workers; a `workerUrl` given turns it on. | `false` translates on the calling thread: simpler, but every batch stalls it. A run with no frames (`feed: 'slice'`) has none to hide a worker's round trip behind, so it translates inline unless asked. |
| `workerUrl` | beside the runtime | Where `translator.worker.js` is. | When a bundler moves it. |
| `translators` | 1 | Workers the runtime opens itself; 0 when a host's pool lends them. | More when cores are spare and loading translates a lot. |
| `arenaBytes` | 48 MiB | The shared memory every translator of a process keeps emitted code in (0: each translator keeps a cache of its own). | Larger for programs with many hundreds of thousands of blocks. |
| `arena` | none | The arena itself, made by the host (`createArena`) and given to every executor of a process, whose translations share one layout (`sharedLayout`): what one emitted, the others take. Absent, the runtime makes its own of `arenaBytes`. | Set by the cpu layer for several executors; not a knob. |
| `sharedCode`, `doorbell` | none | Where the process's record of code shared between its executors lies and which executor this runtime is; the words a translation worker rings after it answers, so an engine thread sleeping on them wakes. | Set by the cpu layer and the process worker; not knobs. |

**What a region is and how regions meet**

| Setting | Default | What it does | When to change it, and the risk |
| --- | --- | --- | --- |
| `maxRegionBlocks`, `maxRegionBytes` | 128, 8192 | The largest region; the entry's own function may take as much again past them, the callees formed into it stop at them. | Larger regions keep more in one wasm function: faster loops, longer compiles. |
| `structure` | `true` | A region's loops as wasm loops. | `false` sends every back edge through the region's dispatch: much slower; for comparison only. |
| `leafCalls` | `true` | A small leaf callee formed into its caller. | Off to rule it out. |
| `leafBlocks`, `leafBytes` | 16, 512 | How large such a callee may be. | Larger inlines more and grows regions. |
| `formDepth` | 1 | How many levels of callees formed in may keep direct calls of their own, their small callees formed in as well (0: leaves alone). | Deeper forms more of a call chain into one region and grows it; the region's limits bound it. |
| `switchEntries` | 1024 | Entries of a switch's jump table followed when forming. | Larger for giant switches (interpreters); regions grow. |
| `regionStops` | `false` | A region stops at a block another region has an entry for, or one on its way to being published, and leaves to that region there: a function's code translated once. | A third less stored in one game, and the hot code it cuts crosses between regions: 74% more transfers in xz, 36% in Stockfish ([`roadmap/negative-results.md`](../../roadmap/negative-results.md), 2026-10-17). |
| `runtimeHelpers` | `true` | Compiler helpers such as MSVC's `_ftol2` formed as what they do. | Off to rule it out. |
| `callReturn` | `true` | A call out of a region is a wasm call, and the region goes on after the `ret`. | Off makes every return go through the entry hash. |
| `emptyCalls` | `true` | A call to a function that does nothing (a `ret` or `ret imm16`, after at most three direct jumps, such as an incremental linker's thunk to an empty virtual method) returns at the transfer, without entering a region. | Off to rule it out. |
| `emptySites` | `false` | With `emptyCalls`, a call out of a region (outside x87 code) reads its target's slot in the entry hash first and returns from such a function in place, without calling the transfer. | A call to an empty method costs about a third of what the transfer leaves it; every other call out of a region reads one more slot, about a nanosecond. |
| `linkedCalls` | `true` | A direct call out of a region reads its target's first slot in the entry hash and, where the entry there is the one the transfer would take at its first look, calls its function itself, without the transfer's hashing and probe. | Off to rule it out; every call then goes through the transfer. |
| `callTargets` | `true` | Indirect calls sampled and their few small callees formed in; a call found to have none worth forming in is sampled no more. | Off to rule it out. A game ran 2–6% faster with it in Chromium; regions formed again for it are formed under `holdMs`. |
| `predictAfter`, `predictShare`, `predictCallees`, `reforms`, `callWindow` | 48, 8, 4, 3, 1024 | With `callTargets`: samples before callees are looked at, the share a callee must take (one in this many), callees compared, times a region is formed again, the readings of the profile a call's samples are kept for. | Tuning `callTargets`. |
| `dispatch` | `false` | A module placed in a range of the table, a transfer inside it a direct tail call. | The benchmark gains a few per cent at most; games ran slower with it, alone and beside `callTargets`. |
| `crossTailCalls` | `true` | A transfer to a region of another module is a tail call into that instance. | `false` has it leave for the runtime's loop, which enters the region; with `dispatch` a module's own regions stay direct tail calls. HACK, to go when iOS ships [WebKit PR #76671](https://github.com/WebKit/WebKit/pull/76671): on by default; core turns it off with `dispatch` on an iPhone, whose WebKit (iOS 27) kills the page on a tail call into another instance ([WebKit bug 325447](https://bugs.webkit.org/show_bug.cgi?id=325447)). |
| `callDepth` | `CallStack.LIMIT` (256) | With `callReturn`, how many calls made as wasm calls may wait at once; a deeper call leaves for the runtime's loop, and its callers return through the entry hash. | Fewer bounds the worker's stack (each waiting call is a region's frames on it). HACK, to go when iOS ships [WebKit PR #76671](https://github.com/WebKit/WebKit/pull/76671): core gives an iPhone 64, under which Doom 3 ran past the point where a 512 KB worker stack overflowed on iOS 27. |
| `relinkAfter`, `relinkRegions` | 16, 512 | Batch modules published before running regions are gathered into large ones, and how many go into each (0: never). | Fewer, larger modules make transfers cheaper; gathering 4096 regions held a thread 160 ms. |
| `mergeAfter` | 2^16 | Transfers between two modules before they are gathered into one (0: never). | Lower merges more eagerly: more rebuilding. |
| `mergeSample`, `mergeEvery`, `mergePerRegion`, `mergesARegion` | 2^20, 2^23, 2^19, 2 | How often crossings are read, the fewest instructions between merges, per region merged, and merges one region may join. | Bounds on merging's own cost. |
| `relinkCold` | 128 | A relink puts the regions entered or crossed into lately first, in modules of `relinkRegions`, and the rest in modules of this many. | A module is held or let go whole (`cacheBytes`): one hot region in a module of cold ones holds them all. More modules make a transfer between them dearer. |
| `gatherAfter`, `gatherRegions` | 2^18, 2048 | With `crossTailCalls` off and `dispatch`, the crossings out of modules past which the hottest regions, wherever they are, are built into one module: those that took all but a hundredth of the heat, at most this many (0: never). | Each crossing leaves for the host's loop there, and a merge cannot join two full modules. A gathering builds its regions again, and the engine thread instantiates the module whole (512 regions about 23 ms, 4096 about 160 ms); the wait between two doubles while the hottest stay the same. |
| `cacheBytes`, `evictHold` | 256 MiB, 2^28 | The wasm bytes of the modules some running region is in, past which those gone longest without running (an entry from the host, a crossing out or in) are let go (0: no ceiling); their regions come back from the store when asked for, and a module brought back is kept this many translated instructions, twice as many each time again. | Lower holds less memory and brings more back. Without `dispatch` a module's only mark is the host's entries: a region reached only by tail calls from another module looks cold until it is brought back. |
| `looseStacks` | `true` | A store through `esp` alone tests no page while no translated code lies on a stack. | Off is slower on every push; only for checking. |

**x87**

| Setting | Default | What it does | When to change it, and the risk |
| --- | --- | --- | --- |
| `wideFirst` | `true` | Each region compiled for the precision control it runs under, tested once a block; one seen under both tests at every rounding operation. | Off tests precision on every operation. |
| `floatSingles` | `true` | A region compiled for single precision computes its arithmetic, square roots and loads in f32 where the operands are floats, each result the processor's 24-bit one; a result past a float's range, or a product under its smallest normal, leaves for the host to compute, and an entry that keeps leaving is compiled again rounding doubles. | Off rounds every result from a double; no other effect. |
| `x87Shapes` | `true` | Regions compiled for the stack's shape at their entries. | Off checks every register access. |
| `checkedAfter` | 4 | Failed shape tests before a region is formed again without one. | Lower for code entered with varying stacks. |

**Memory layout and records**

| Setting | Default | What it does | When to change it, and the risk |
| --- | --- | --- | --- |
| `hashSlots` | 2^20 | Slots of the entry hash translated code looks targets up in (12 bytes each, a power of two). | A program past ~780k block starts needs more; a full hash sends its overflow through the host on every transfer. |
| `hashLoad` | 0.75 | Share of slots live past which new entries stay out of the hash. | Higher packs more in with longer probes. |
| `exitTargets`, `missesKept`, `callSitesKept` | 4096, 4096, 16384 | Bounded records of exit targets, miss counts and tried call sites. | Larger for diagnostics on big programs. |

**The core's host (in `@bottlify/core`)**

| Setting | Default | What it does | When to change it, and the risk |
| --- | --- | --- | --- |
| `sharedMemory` | `true` where possible | Guest memory a `SharedArrayBuffer`, where the host has one and the page is cross-origin isolated (`createMachine`'s memory is never shared). | `false` keeps it private: no other executor can run on it, and the program runs on one. |
| `wasmInterpreter` | `true` | The interpreter's integer, x87 and SSE instructions in wasm. | Off runs the JavaScript interpreter alone: slower. |
| `long` | `'long'` | A 64-bit process's translator: the long runner (`'long'`), or the runtime and emitter 32-bit code runs on (`'shared'`). | `'shared'` until it is the default: its regions are judged by the same corpus and programs as the long runner's. |
| `wasmInterpreterAfter`, `newTargetWork` | 8192, 128 | Work the JavaScript interpreter does before the wasm tier takes over, a new target counting as 128. | 0 starts the wasm tier at once. |
| `feed` | `'frame'` | When candidates are formed: once a frame, or after every slice (`'slice'`). | `'slice'` for programs that never present. |
| `yieldChunk` | 10000 | Instructions translated code runs at a time while a slice may end early (`createMachine`: 2^24). | Smaller reacts faster to other threads, at more crossings. |
| `interpretChunk`, `sliceMs` | 8192, 8 | Instructions interpreted at a time (`createMachine`: 65536), and how long an interpreting slice may take. | Larger interprets in longer stretches: fewer checks, longer holds. |
| `tscDriftMs` | 16 | How far `rdtsc` may run ahead of the guest's clock. | Programs timing with `rdtsc`. |
| `spinMs`, `executorIdleMs`, `executorYieldMs` | 0.05, 2, 4 | With several executors: how long a side looks at their channel before sleeping, how long an executor waits in place, the longest it goes without a turn of its event loop. | Longer spins lower latency and burn a core. |
| `executorHoldMs` | 1 | With several executors and more ready threads than they run: how long an executor keeps its thread (its turn) before it gives it up for one that waits. | Shorter is fairer and costs a round trip through the process each turn: four threads on two executors 817-976 ms at 0.25, 747-845 at 1, 752-837 at 2, 1242-1338 giving the thread up every slice. |

The core also takes `cork.pool`, `cork.poolPerProcess`, `cork.poolWindowMs` and `cork.poolDriver`
(the translation pool's thresholds) beside `config`, and `quantum` and `executors` on `createApp`:
see [`docs/core/configuration.md`](../../docs/core/configuration.md#cpu).

**Diagnostics**

| Setting | What it records |
| --- | --- |
| `blockProfile`, `blockProfileFrom` | Execution counts per block, from a given second on. Beside them `mechanisms` (how calls and returns went: formed into a region, wasm calls or ways out, why a callee was not formed in, calls to empty functions; jumps back inside a region, to a loop's head, through its dispatch or out of it; transfers through the entry hash; `rdtsc`s) and `forms` (each instruction form's executions and the wasm bytes the hot regions emit for it). |
| `timings` | The translator's phases timed. |
| `traceStore` | Translation store keys. |
| `checkStale` | Regions whose bytes changed. |
| `countTransfers` | Transfers between regions. |
| `undoLog` | The store's undo log, for replay. |

They all cost speed, so they belong in an investigation and nowhere else. A run with
`blockProfile` or `undoLog`, or with classes left out (`leaveOut`), keeps no translation store.

**Store**

| Setting | What it does |
| --- | --- |
| `store` | Where translations are kept between runs (the core gives a store per bundle in OPFS). |
| `bundleId` | The store's namespace. |
| `cacheVersion` | A version above the translator's own: every record stored under another version misses, as in an empty store. |

A few sizes stay fixed because translated code or the prebuilt wasm interpreter are built around
them: the state block's offsets, the page-flag table (one byte per 4 KiB page), the code-granule
table, and the wasm interpreter's hot-count table.
