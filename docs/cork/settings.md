# cork settings

cork has no settings for a person to tune. Every number it works by is a constant beside its use,
chosen by measurement. What it takes as `config` (to `createMachine`, `--config '<json>'` to
`cork run`, or `createApp({ cork: { config } })` in `@bottlify/core`) is of three kinds: what a
host passes to wire cork into itself, switches that turn a path off or add an instrument while a
defect or a cost is hunted, and levers tests need to reach a state quickly. None of them is for a
shipped program to change.

The tables below are written from the one table of them,
[`SETTINGS`](../../modules/cork/src/runtime/settings.js), by
`node tools/checks/check-cork-settings.mjs --write`; `npm run check:boundaries` fails where this
page or the core's `EngineConfig` parts from it.

**What a host passes**

<!-- settings: host -->
| Setting | Default | What it is |
| --- | --- | --- |
| `atomic` | `false` | `lock`-prefixed instructions and `xchg` with memory as wasm atomics: set by the core for a process whose threads run on several executors over one memory. |
| `trapPort` | none | The I/O port whose `out` is the host's call. |
| `worker` | on where `Worker` exists, unless `feed` is `'slice'` | Emit and compile in translation workers; `false` translates on the calling thread. |
| `workerUrl` | beside the runtime | Where `translator.worker.js` is, when a bundler moves it. |
| `translators` | 1 | Workers the runtime opens itself; 0 when a host's pool lends them. |
| `kept` | none | The run's cache the functions emitted are kept in (`KeptStore`), read in place by every thread of the run; absent, none is kept and a relink emits each again. |
| `sharedCode` | none | Where the process's record of code shared between its executors lies and which executor this runtime is, when other executors share its page flags. |
| `doorbell` | none | The words a translation worker rings after it answers: the count of answers posted and the bell the engine thread sleeps on, its count followed by the count of the waits asleep on it. |
| `tablesZeroed` | `false` | The host made the tables zero itself (a memory just made, or zeroed where they lie): the entry hash is not cleared at the start, which made all of it resident. |
| `awaited` | none | Whether another executor waits for this one's answer: forming and lookups stop at the next region while it does. |
| `store` | none | Where translations are kept between runs (the core gives one per bundle in OPFS). |
| `bundleId` | `'unknown'` | The namespace of the store's records. |
| `cacheVersion` | the translator's | A version above the translator's own: every record of another version misses. |
| `feed` | `'frame'` | When candidates are formed: once a frame, and at a slice's end once the program has run a frame's worth with none presented, or after every slice (`'slice'`; `createMachine`'s). |
| `cacheBytes` | 256 MiB | The wasm bytes of the modules running regions are in, past which those gone longest without running are let go (0: no ceiling); the core sets a ceiling only on the iOS path below. |
| `coldMs` | 60000 | Milliseconds without the engine touching a module before it is let go to the store, brought back from it if asked for again (0: never). |
| `charge` | none | Where a host bounds what its runtimes hold together: `{ take(bytes), overdraw(bytes), give(bytes) }`. Each module held is taken by its wasm bytes and given back as it is let go; one it has no room for lets those gone longest without running go until there is, and where none is left it is taken past the bound (`overdraw`, which the host counts and says; `overdrawnBytes` in the diagnostics). |
| `sharedCharge` | none | What the modules kept for the runtimes sharing a store (`sharedModuleBytes`) are taken from, by the first runtime of the thread to keep one: `{ take(bytes), give(bytes) }`, as `charge`. A kept module is paid for there and by no runtime running it; one it has no room for is not kept. |
| `letGo` | none | Told the wasm bytes of each module the runtime lets go (no running region in it any more: replaced, evicted or written over), so a host can ask its engine to collect the compiled code it no longer reaches. |
| `sharedModuleBytes` | 256 MiB | The wasm bytes of compiled batch modules kept for every runtime handed the same `store` (`shared-modules.js`): a process the run starts again instantiates what an earlier one compiled, its lazily compiled and tiered-up code with it (0: none kept). The store's own `hold`, where it has one, keeps each such module alive for runtimes in other threads too. A store made for one runtime (`alone: true`, as a process or an executor in a worker of its own is handed) is kept beside only from the second runtime handed it on; `hold` is called all the same. |
| `crossTailCalls` | `true` | HACK until iOS ships [WebKit PR #76671](https://github.com/WebKit/WebKit/pull/76671): `false` keeps every tail call inside its own instance, as iOS 27, which kills the page on a tail call into another instance ([WebKit bug 325447](https://bugs.webkit.org/show_bug.cgi?id=325447)), is given it. |
| `dispatch` | `false` | Each module placed in a range of the table, a transfer inside it a direct tail call: the core gives it an iPhone, with `crossTailCalls: false`. |
| `callDepth` | 256 | With `callReturn`, the calls made as wasm calls that may wait at once (HACK until iOS ships the same PR): iOS overflows a 512 KB worker stack, so the core gives an iPhone 64. |
<!-- /settings -->

The core also takes `cork.pool`, `cork.poolPerProcess`, `cork.poolCapacity`, `cork.poolWindowMs` and `cork.poolDriver`
beside `config`, and `quantum` and `executors` on `createApp`: see
[`docs/core/configuration.md`](../../docs/core/configuration.md#cpu).

**Debugging**

Each turns a path off to rule it out, or adds an instrument; each is slower or larger, and a run
with `blockProfile` or with classes left out (`leaveOut`) keeps no translation store. Several are
the reference arm of a differential gate.

<!-- settings: debug -->
| Setting | Default | What it does |
| --- | --- | --- |
| `translate` | `true` | `false` interprets everything: the reference a translated run is compared with. |
| `leaveOut` | `[]` | Instruction classes (`'x87'`, `'mmx'`, `'sse'`) left to the interpreter. |
| `interpretRange` | none | `[from, to)`: addresses left to the interpreter. |
| `wasmInterpreter` | `true` | `false` runs the JavaScript interpreter alone (the core's host). |
| `precise` | `false` | x87 exception flags, signalling NaNs, underflow, C1 and the flags an instruction leaves undefined kept as the processor keeps them; the conformance tests and the hardware corpus turn it on. |
| `exactNaN` | `false` | Every NaN a float operation makes carries x86's sign, not the host's. |
| `checkReads` | unset | `true` tests every read's pages from the start, `false` never closes a page; unset, reads are wrapped into RAM until the program first faults on a closed page, and tested from then on. |
| `looseStacks` | `true` | `false` tests the pages of every store through `esp`. |
| `callReturn` | `true` | `false` makes every call and return out of a region a transfer through the entry hash. |
| `leafCalls` | `true` | `false` forms no leaf callee into its caller. |
| `helpers` | `true` | `false` makes every call to a compiler's or C runtime's function the dictionary knows as it is, rather than as what it does (`memcpy` as one `memory.copy`). |
| `helpersAlso` | none | Routines told by their whole code, each a name, an operation and its bytes, and formed as that operation beside the dictionary: Bottlify's own C runtime routines, which the app hands it. |
| `formDepth` | 1 | Levels of callees formed in that may keep direct calls of their own (0: leaves alone); 2 and 3 measured slower. |
| `emptyCalls` | `true` | `false` enters a function that does nothing rather than returning from it in the transfer. |
| `linkedCalls` | `true` | `false` sends every direct call through the transfer rather than calling the function its first hash slot holds. |
| `callTargets` | `true` | `false` samples no indirect call and forms no predicted callee in. |
| `wideFirst` | `true` | `false` tests the precision control at every x87 rounding operation. |
| `floatSingles` | `true` | `false` rounds every single-precision x87 result from a double. |
| `x87Shapes` | `true` | `false` checks every x87 register access rather than the stack's shape once at an entry. |
| `blockProfile` | `false` | Execution counts per block, with `mechanisms` (how calls, returns and jumps went) and `forms` (each instruction form's executions and wasm bytes); a run with it keeps no translation store. |
| `blockProfileFrom` | 0 | With `blockProfile`: seconds after the runtime is made at which the counts start over. |
| `timings` | `false` | The translator's phases timed: forming, lookups, emitting, encoding, storing, instantiating and publishing, and the record of long holds. |
| `traceStore` | `false` | Translation store keys put, missed and hit, as `entry:hash:top`. |
| `checkStale` | `false` | Regions still published whose bytes no longer form as they did (`staleRegions`). |
| `countTransfers` | `false` | Transfers between regions through the hash; `transfers` in the diagnostics only with it. |
<!-- /settings -->

**For tests**

Levers a test sets to reach a state in a few instructions or to make a run repeatable. The
default is the product's.

<!-- settings: test -->
| Setting | Default | What it moves |
| --- | --- | --- |
| `hotThreshold` | 2 (`createMachine`: 50) | Jumps to a target before it is a candidate. |
| `missThreshold` | 64 | Untranslated exits to one address before it is a candidate. |
| `maxQueued` | 8192 | Candidates waiting; past it the coldest is dropped. |
| `batchRegions` | 32 | Regions per wasm module. |
| `maxBatchRegions` | 256 | The most regions a deep queue's batch takes. |
| `holdMs` | 4 | The engine thread's time the translator's work may take at a stretch where a worker is wanted (0: a batch formed and published whole in one call). |
| `inFlightMs` | 10000 | How long a batch may be with a worker before it is given up. |
| `volatileAfter` | 8 | Writes dropping a page's code within `volatileWindowMs` of each other before the page is left to the interpreter. |
| `volatileWindowMs` | 100 | The window those writes are counted in. |
| `volatileHoldMs` | 2000 | How long a page is left to the interpreter, twice as long each time it is left again. |
| `maxRegionBlocks` | 128 | Blocks of the largest region. |
| `leafBytes` | 512 | Bytes of a leaf callee formed in. |
| `coldReach` | 4096 | Bytes a callee's conditional branch may reach and still be followed; a farther one is a way out to cold code, not part of the callee (0: every branch followed). |
| `predictAfter` | 48 | Samples of an indirect call before its callees are looked at. |
| `callWindow` | 1024 | The readings an indirect call's samples are kept for. |
| `relinkAfter` | 16 | Batch modules published before the running regions are gathered into large ones (0: never). |
| `relinkQuiet` | 2^30 | Instructions of translated code since the last batch module before the running regions are gathered. |
| `relinkRegions` | 512 | Regions in each gathered module. |
| `relinkCold` | 128 | Regions in each module a relink builds of those no entry reached lately. |
| `summaries` | `true` | A stored region is taken by its record's summary, without forming it (`summary.js`); false: formed as its record says, then compared. |
| `mergeAfter` | 2^16 | Transfers between two modules before they are merged on the translation worker (0: never). |
| `checkedAfter` | 4 | Failed x87 shape tests before a region is formed again without one. |
| `hashSlots` | 2^20 | Slots of the entry hash (12 bytes each). |
| `yieldChunk` | 2^24 | `createMachine` alone (cork's machine for its tests): the instructions translated code runs at a time. |
| `lowBlock` | `true` | The core's host: over a wide window whose code block is past 4 GiB, the block below it translated by a runtime of its own (`twoBlockRuntime`); false leaves its code to the interpreter tier. |
| `sliceMs` | 8 | How long an interpreting slice may take. |
| `wasmInterpreterAfter` | 8192 | Work the JavaScript interpreter does before the wasm tier takes over. |
| `clock` | `host` | The clock the cork host and the translator decide by. `virtual`: the instructions the guest retired, a million a millisecond, for a slice's length, the time-stamp counter and a page's rewrites, the translation done on the engine thread. The same program then translates and runs the same code on any machine however busy it is; the time it took is the machine's alone. For stands, not the product. |
<!-- /settings -->

A few sizes stay fixed because translated code or the prebuilt wasm interpreter are built around
them: the state block's offsets, the page-flag table (one byte per 4 KiB page), the code-granule
table, and the wasm interpreter's hot-count table.
