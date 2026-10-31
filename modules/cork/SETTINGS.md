# cork settings

[По-русски](SETTINGS.ru.md) · [README](README.md)

cork has no settings for a person to tune. Every number it works by is a constant beside its use,
chosen by measurement. What it takes as `config` (to `createMachine`, `--config '<json>'` to
`cork run`, or `createApp({ cork: { config } })` in `@bottlify/core`) is of three kinds: what a
host passes to wire cork into itself, switches that turn a path off or add an instrument while a
defect or a cost is hunted, and levers tests need to reach a state quickly. None of them is for a
shipped program to change.

**What a host passes**

| Setting | Default | What it is |
| --- | --- | --- |
| `atomic` | `false` | `lock`-prefixed instructions and `xchg` with memory as wasm atomics: set by the core for a process whose threads run on several executors over one memory. |
| `ordered` | `false` | With `atomic`, an integer operand's load and store not through esp as wasm atomics too, where aligned: the order of plain stores on a host that reorders them (arm64). Off unless the page asks. |
| `trapPort` | none | The I/O port whose `out` is the host's call. |
| `worker` | on where `Worker` exists, unless `feed` is `'slice'` | Emit and compile in translation workers; `false` translates on the calling thread. |
| `workerUrl` | beside the runtime | Where `translator.worker.js` is, when a bundler moves it. |
| `translators` | 1 | Workers the runtime opens itself; 0 when a host's pool lends them. |
| `arena` | none | The translation cache arena (`createArena`) every executor of a process shares; absent, the runtime makes its own. |
| `sharedCode`, `doorbell` | none | Where the process's record of code shared between its executors lies and which executor this runtime is; the words a translation worker rings after it answers. |
| `awaited` | none | Whether another executor waits for this one's answer: forming and lookups stop at the next region while it does. |
| `store`, `bundleId` | none, `'unknown'` | Where translations are kept between runs (the core gives one per bundle in OPFS), and their namespace. |
| `cacheVersion` | the translator's | A version above the translator's own: every record of another version misses. |
| `feed` | `'frame'` | When candidates are formed: once a frame, or after every slice (`'slice'`, a program that never presents; `createMachine`'s). |
| `sharedMemory` | `true` where possible | Guest memory a `SharedArrayBuffer` where the page is cross-origin isolated; `false` keeps it private and the program on one executor. |
| `cacheBytes` | 256 MiB | The wasm bytes of the modules running regions are in, past which those gone longest without running are let go (0: no ceiling); the core sets a ceiling only on the iOS path below. |
| `crossTailCalls`, `dispatch`, `callDepth` | `true`, `false`, `CallStack.LIMIT` (256) | HACK until iOS ships [WebKit PR #76671](https://github.com/WebKit/WebKit/pull/76671): iOS 27 kills the page on a tail call into another instance ([WebKit bug 325447](https://bugs.webkit.org/show_bug.cgi?id=325447)) and overflows a 512 KB worker stack, so the core gives an iPhone `crossTailCalls: false`, `dispatch: true` and `callDepth: 64`. |

The core also takes `cork.pool`, `cork.poolPerProcess`, `cork.poolWindowMs` and `cork.poolDriver`
beside `config`, and `quantum` and `executors` on `createApp`: see
[`docs/core/configuration.md`](../../docs/core/configuration.md#cpu).

**Debugging**

Each turns a path off to rule it out, or adds an instrument; each is slower or larger, and a run
with `blockProfile` or with classes left out (`leaveOut`) keeps no translation store. Several are
the reference arm of a differential gate.

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
| `structure` | `true` | `false` sends every back edge of a region through its dispatch. |
| `callReturn` | `true` | `false` makes every call and return out of a region a transfer through the entry hash. |
| `leafCalls` | `true` | `false` forms no leaf callee into its caller. |
| `formDepth` | 1 | Levels of callees formed in that may keep direct calls of their own (0: leaves alone); 2 and 3 measured slower. |
| `emptyCalls` | `true` | `false` enters a function that does nothing rather than returning from it in the transfer. |
| `linkedCalls` | `true` | `false` sends every direct call through the transfer rather than calling the function its first hash slot holds. |
| `callTargets` | `true` | `false` samples no indirect call and forms no predicted callee in. |
| `wideFirst` | `true` | `false` tests the precision control at every x87 rounding operation. |
| `floatSingles` | `true` | `false` rounds every single-precision x87 result from a double. |
| `x87Shapes` | `true` | `false` checks every x87 register access rather than the stack's shape once at an entry. |
| `blockProfile`, `blockProfileFrom` | `false`, 0 | Execution counts per block, from a given second on, with `mechanisms` (how calls, returns and jumps went) and `forms` (each instruction form's executions and wasm bytes). |
| `timings` | `false` | The translator's phases timed. |
| `traceStore` | `false` | Translation store keys put and missed. |
| `checkStale` | `false` | Regions still published whose bytes no longer form as they did. |
| `countTransfers` | `false` | Transfers between regions through the hash; `transfers` in the diagnostics only with it. |

**For tests**

Levers a test sets to reach a state in a few instructions or to make a run repeatable. The
default is the product's.

| Setting | Default | What it moves |
| --- | --- | --- |
| `hotThreshold` | 2 | Jumps to a target before it is a candidate (`createMachine`: 50). |
| `missThreshold` | 64 | Exits to one address before it is a candidate. |
| `maxQueued` | 8192 | Candidates waiting; past it the coldest is dropped. |
| `batchRegions`, `maxBatchRegions` | 32, 256 | Regions per wasm module, and the most a deep queue's batch takes. |
| `holdMs` | 4 | The engine thread's time the translator's work may take at a stretch where a worker is wanted (0: a batch formed and published whole in one call). |
| `inFlightMs` | 10000 | How long a batch may be with a worker before it is given up. |
| `volatileAfter`, `volatileWindowMs`, `volatileHoldMs` | 8, 100, 2000 | Writes dropping a page's code within the window before the page is interpreted, and for how long. |
| `maxRegionBlocks` | 128 | Blocks of the largest region. |
| `leafBytes` | 512 | Bytes of a leaf callee formed in. |
| `predictAfter`, `callWindow` | 48, 1024 | Samples of an indirect call before its callees are looked at, and the readings they are kept for. |
| `relinkAfter`, `relinkRegions`, `relinkCold` | 16, 512, 128 | Batch modules before running regions are gathered into large ones (0: never), regions in each, and in each module of the cold. |
| `mergeAfter` | 2^16 | Transfers between two modules before they are merged (0: never). |
| `checkedAfter` | 4 | Failed x87 shape tests before a region is formed again without one. |
| `hashSlots` | 2^20 | Slots of the entry hash (12 bytes each). |
| `yieldChunk` | 10000 | Instructions translated code runs at a time while a slice may end early (`createMachine`: 2^24). |
| `sliceMs` | 8 | How long an interpreting slice may take. |
| `wasmInterpreterAfter` | 8192 | Work the JavaScript interpreter does before the wasm tier takes over. |

A few sizes stay fixed because translated code or the prebuilt wasm interpreter are built around
them: the state block's offsets, the page-flag table (one byte per 4 KiB page), the code-granule
table, and the wasm interpreter's hot-count table.
