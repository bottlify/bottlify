/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The executor contract: what an execution engine gives the cpu layer.
 *
 * The layer runs a program on one of two engines -- a translator package such
 * as `@bottlify/cork`, loaded at `boot()` by the module URL in the layer's
 * configuration, or the v86 emulator a caller brings, adapted by
 * `internal/v86-host.js`. This file is the whole of what the layer and a
 * translator package agree on: the package implements these names, and the
 * layer's host (`internal/cork-host.js`) composes a runtime with the layer's
 * own contexts, traps and faults. Typedefs only; nothing here runs, and the
 * layer never imports an engine package.
 *
 * Every field is sized for 32-bit code today and named so that a 64-bit engine
 * implements the same contract with `bits: 64` rather than a second one.
 */

/**
 * Where each register lives in the memory a runtime executes over, as byte
 * offsets. Translated code addresses registers by these constants, so the
 * layout is part of every translation's identity (`id`).
 *
 * In hybrid mode the offsets are the emulator's own register file inside its
 * exported memory, read off its typed views at boot; the state block *is* the
 * emulator's, and a switch between the two executors copies nothing. In an
 * engine-alone mode the layout is the engine's own.
 *
 * @typedef {Object} StateLayout
 * @property {32 | 64} bits        The register width; 32 in every mode built so far.
 * @property {number} ramBase      Wasm address of guest address 0.
 * @property {number} ramSize
 * @property {number} [hashShift]  The entry hash's slot is `(eip * 0x9e3779b1) >>> hashShift`
 *     (16 when absent, the emulator's handoff lookup).
 * @property {number} regs         8 × i32 (eax ecx edx ebx esp ebp esi edi); 16 × i64 at 64.
 * @property {number} eip
 * @property {number} previousIp
 * @property {number} eflags       The eager word (hybrid: the emulator's `flags`).
 * @property {number} [flagRecord] Cork's own: five i32 (kind, result, op1, op2, carry in) of
 *     the arithmetic record a region leaves instead of folding it into `eflags`; the word
 *     is whole only once `eflagsOf` has folded it. Absent (hybrid): the word is folded at exit.
 * @property {number} flagsChanged Hybrid only, written 0 at every exit; -1 when absent.
 * @property {number} x87          8 × 16 bytes.
 * @property {'f64' | 'tagged80'} x87Format  The engine's own f64, or the emulator's tagged form.
 * @property {number} x87Top       u8.
 * @property {number} x87Empty     u8 bitmask, bit i set = register i empty.
 * @property {number} x87Control   u16.
 * @property {number} x87Status    u16.
 * @property {number} xmm          8 × 16 bytes.
 * @property {number} mxcsr
 * @property {number} fsBase       The thread block's linear address (32-bit Windows).
 * @property {number} gsBase       The same for 64-bit Windows; -1 when absent.
 * @property {number} counter      u32 retired-instruction word (hybrid: the emulator's).
 * @property {number} [callProfile] Cork's own: where translated code notes its indirect calls
 *     while the runtime asks -- a flag, a count, and sixteen pairs of the call's address and
 *     its target, the last calls (`callTargets`); absent, no profile.
 * @property {number} [origin]     Cork's own: i32, the budget the current run started with,
 *     which the retired count is taken from when it leaves for the host.
 * @property {number} [nanFirst]   Cork's own, outside the state block: under `precise`, a NaN
 *     hunt's record (`NanRecord` in cork's emit/x87.js).
 * @property {number} tables       Wasm address of the engine's own tables.
 * @property {number} codePages    Wasm address of the other executor's byte-per-page
 *                                 "has compiled code" table (hybrid), or -1: a store into
 *                                 such a page leaves `stale` so its cache can be dirtied.
 * @property {string} id           A hash of every field above.
 */

/**
 * What the layer hands an engine factory.
 *
 * @typedef {Object} EngineEnv
 * @property {WebAssembly.Memory} memory  The layer's memory (the emulator's in hybrid).
 * @property {StateLayout} layout
 * @property {EngineConfig} config
 * @property {(address: number) => number} read   One byte of guest memory.
 * @property {EngineImports} imports
 */

/**
 * The host functions translated code may call.
 *
 * @typedef {Object} EngineImports
 * @property {(id: number) => 0 | 1} trap
 *     The trap port write. Answers 1 when the handler moved EIP or asked the
 *     machine to stop, in which case the region must exit rather than continue.
 * @property {() => number} getEflags   The eager flags word, for a region that reads
 *     flags before writing them.
 * @property {(index: number) => number} x87Read  A physical x87 register the state
 *     block holds in a form the engine cannot read inline, as an f64.
 * @property {() => bigint} rdtsc      The time-stamp counter `rdtsc` reads: the
 *     emulator's own under hybrid, the engine's clock under cork.
 * @property {(page: number, on: boolean) => void} [handoffPage]
 *     Hybrid: flags a page the engine holds code for, so the other executor's slice
 *     returns when the guest arrives there (`handoffPage` on the emulator's host).
 * @property {(address: number, length: number) => void} [dirtyCode]
 *     Hybrid: a store translated code made into a page the other executor compiled;
 *     the host dirties that cache.
 * @property {(physical: number) => void} [handoffHash]
 *     Hybrid: where the engine's entry hash lies in guest memory, so the other executor
 *     returns only at an address the hash holds rather than anywhere in a flagged page.
 */

/**
 * The engine's own configuration, the `cork` object of the cpu layer's.
 *
 * @typedef {Object} EngineConfig
 * @property {number} [hotThreshold]     Instructions a 64-byte bucket must have been
 *     credited before its address is a region candidate. Default 2000.
 * @property {number} [maxRegionBlocks]  Default 128.
 * @property {number} [maxRegionBytes]   Default 8192.
 * @property {boolean} [precise]         Nothing relaxed for speed: the x87 exception flags,
 *     signalling NaNs, underflow and C1 kept as the processor keeps them, and the flags an
 *     instruction leaves undefined left as the instruction model leaves them rather than as the
 *     cheapest code does. Default false, as games run; the
 *     corpora run with it.
 * @property {boolean} [blockProfile]    A diagnostic: every block counts its executions.
 * @property {number} [blockProfileFrom]  With `blockProfile`: seconds after start at which the
 *           counts start over.
 * @property {boolean} [timings]         A diagnostic: the host clock read around the translator's
 *     phases and the host's slices, for the milliseconds of `EngineDiagnostics` and the record of
 *     long holds. Default false -- a shipped build reads no clock for its own account, and those
 *     figures stay 0.
 * @property {boolean} [traceStore]      A diagnostic: every store key put and missed, in the
 *     diagnostics' `storeTrace`.
 * @property {number} [batchRegions]     Regions per wasm module. Default 32.
 * @property {number} [maxBatchRegions]  The most regions one batch takes when the queue is deep
 *     (a quarter of the queue past `batchRegions`), and with its regions' direct callees.
 *     Default 256.
 * @property {number} [maxQueued]        Candidates kept waiting at most; past it the coldest,
 *     oldest is evicted (the interpreter notes it again should it get hot). Default 8192.
 * @property {number} [missThreshold]    Untranslated exits to one address before the engine
 *     queues it as a candidate of its own. Default 64.
 * @property {('x87' | 'mmx' | 'sse')[]} [leaveOut]  Instruction classes the translator leaves
 *     to the other executor (a region exits before one), so a defect can be localised by
 *     class from a run; a run with any class left out keeps no translation store. Default none.
 * @property {number} [trapPort]         The I/O port that is the host's call channel: a
 *     write of eax to it by translated code leaves with a `trap` exit past the instruction,
 *     and the hybrid host runs the handler the port write would have reached. Without it,
 *     the instruction is the other executor's.
 * @property {'frame' | 'slice'} [feed]  When the sampler's hot buckets become candidates:
 *     once a frame (the default, paced by presentation) or after every slice, for a run
 *     that has no frames -- a test in a process without a presenter.
 * @property {boolean} [worker]  Emit and encode off the engine thread, in a translation
 *     worker. Default: on wherever a `Worker` exists (a page); a process without one uses
 *     `worker_threads` only when `workerUrl` is named. `false` emits inline.
 * @property {string} [workerUrl]  The `translator.worker.js` URL. Default: the file beside
 *     the runtime. Named explicitly by a test process, or a bundler that moves it.
 * @property {number} [inFlightMs]  How long a batch may be with the worker before it is given
 *     up, on time the engine thread was free to hear its answer -- past it by the clock and the
 *     event loop come round twice since. Default 10000; tests shorten it.
 * @property {TranslationStore} [store]  The per-bundle cache; none = translate every run.
 * @property {string} [bundleId]         The cache's namespace.
 * @property {boolean} [translate]       Test-only: false keeps the translator off, so a run
 *     is the interpreter tier's alone. Default true.
 * @property {boolean} [sharedMemory]  Under cork, guest memory a `SharedArrayBuffer` where
 *     the host can share one (node, a cross-origin isolated page) -- what lets another
 *     worker read and write it in place. `false` keeps it the engine's alone.
 * @property {boolean} [wasmInterpreter]  Under cork alone, the interpreter tier's integer, x87
 *     and SSE instructions run in wasm (`interp-wasm.js`), the JavaScript interpreter taking
 *     the rest; false runs the JavaScript interpreter alone. Default true.
 * @property {number} [wasmInterpreterAfter]  How far the JavaScript interpreter carries a
 *     process's cork hosts, between them, before the wasm tier takes over: their instructions,
 *     a jump target new to a host counting as 128. Default 8192; 0 runs the wasm tier from the
 *     first instruction.
 */

/**
 * The engine's interpreter tier in wasm, as the host drives it: the integer, x87 and SSE
 * instructions run straight from guest memory over the state block, the host's own
 * interpreter taking what it leaves. It is the engine's `createWasmInterpreter` that makes one.
 *
 * @typedef {Object} WasmInterpreter
 * @property {(budget: number) => number} run  runs from the state block's eip, at most
 *     `budget` instructions; answers a `WasmExit`, with eip and the eager flags word back
 *     in the block
 * @property {() => number} retired     instructions the last run retired
 * @property {() => number} relaxedReads  x87 status words stored (`fnstsw`) while not
 *     `precise`: reads that may see what only `precise` keeps
 * @property {() => number} exitValue
 * @property {() => number} exitSize
 * @property {() => (budget: number) => number} entry  the tier's own `enter`, a wasm function
 *     translated code calls at an untranslated exit with no region (`Runtime.interpretWith`):
 *     it counts the target as a jump's, runs from the state block's eip and answers the
 *     `WasmExit` with what it retired above the low byte, added to the counter word already;
 *     the module is instantiated if it was not
 * @property {() => number} entered     instructions those calls have retired, all told
 * @property {Uint8Array} hotCounts     the counts, a slot per `(address >>> 2) & (HOT_SLOTS - 1)`
 * @property {Uint32Array} starts       the ring of recent jump targets
 * @property {() => number} startIndex  the ring's next slot, not yet wrapped
 * @property {(value: number) => void} setStartIndex
 * @property {() => boolean} started    whether the process has started the tier already (its
 *     module compiled at a first run), so a run costs no start
 * @property {{ work: number }} stretch  what the process's hosts have run on the JavaScript
 *     interpreter before the tier started, one record for every tier of the process, as the
 *     tier's start is paid once a process (`wasmInterpreterAfter`)
 */

/**
 * Where translations are kept between runs.
 *
 * @typedef {Object} TranslationStore
 * @property {(key: string) => Promise<Uint8Array | null>} get
 * @property {(key: string, bytes: Uint8Array) => Promise<void>} put
 * @property {(key: string) => Uint8Array | null | undefined} [getNow]  The record at once,
 *     without a turn of the event loop, where the store can answer so; undefined where it
 *     cannot yet, and the translator asks `get`. Optional.
 * @property {() => Promise<void>} [prepare]  Opens the store ahead of its first lookup (a
 *     directory store reads its index). Optional.
 * @property {() => Promise<void>} [flush]  Writes any pending bookkeeping
 *     (a directory store's index) before the run ends. Optional.
 * @property {() => void} [close]  Lets go of what the store holds open (a directory
 *     store's access handle on its records file). Optional; after `flush`.
 */

/**
 * Why a run of translated code came back, with the state block complete:
 * every register, EIP, an eager EFLAGS, the x87 block with top and empty
 * mask, XMM. Nothing is held outside the block between runs, which is what
 * makes a thread switch, a context capture and a fall back to the other
 * executor the same operation -- nothing.
 *
 * @typedef {'untranslated' | 'budget' | 'trap' | 'halt' | 'fault' | 'stale'
 *     | 'interpreted'} ExitKind
 *   untranslated  EIP in the state block has no translated entry.
 *   budget        A back-edge found the slice's budget spent; EIP is the loop header.
 *   trap          A trap handler moved EIP or asked to stop; EIP is what it set.
 *   halt          The region executed `hlt`.
 *   fault         A precise exception; EIP is the faulting instruction, registers as
 *                 before it.
 *   stale         The region was invalidated while running; EIP is the next instruction.
 *   interpreted   An untranslated exit ran the interpreter tier in wasm in place
 *                 (`interpretWith`), which stopped short of an entry: `vector` is the
 *                 tier's `WasmExit`, its `exitValue` and `exitSize` what goes with it.
 */

/**
 * @typedef {Object} ExitRecord  Valid until the next `run`: the engine may hand out one
 *     record and rewrite it, so a caller that keeps an exit copies its fields.
 * @property {number} retired  Instructions retired in this run, already added to `counter`.
 * @property {ExitKind} kind
 * @property {number} vector   For `fault`: 0 (#DE), 6 (#UD), 3 (int 3), 13 (page flag);
 *                             `int n` reports n.
 */

/**
 * What an engine reports about itself, beside the layer's own figures.
 *
 * @typedef {Object} EngineDiagnostics
 * @property {number} regions          Translated and live.
 * @property {number} entries          Entry points in the hash (in the map alone, without
 *     tail calls).
 * @property {number} modules          Wasm modules instantiated.
 * @property {number} [relinks]        Relinks begun: the running regions gathered into big modules.
 * @property {number} [relinked]       Regions switched to a relinked module's function.
 * @property {number} [merges]         Two modules gathered into one because one kept
 *     transferring into the other (`mergeAfter`).
 * @property {number} [merged]         The regions those merges built again (of `relinked`).
 * @property {'none' | 'loading' | 'ready'} [worker]  The translation worker: none (batches
 *     are emitted on the engine thread), made and still loading its modules (small batches
 *     emitted here meanwhile), or taking the batches.
 * @property {number} [reforms]        Regions formed again with the callees their indirect
 *     calls were sampled going to (`callTargets`).
 * @property {number} [copied]         Regions formed again with copies of the blocks inside
 *     their loops, which the machine kept coming back into there (`structure`).
 * @property {number} [crossings]      Transfers out of a running module into another,
 *     through the function table: the rest are direct tail calls.
 * @property {number} [tableSize]      The function table's length, which the regions' indices
 *     span: a placed module's range goes back to the rest once its regions have all gone.
 * @property {number} [transfers]      Transfers between regions, when counted (`countTransfers`).
 * @property {number} translatedShare  Instructions retired in the engine / retired, 0..1.
 * @property {number} retired          Instructions retired in the engine, for a frame's share.
 * @property {number} cacheHits        Regions taken from the store.
 * @property {number} cacheMisses
 * @property {number} [lookedUpNow]    Batches the store answered in the call that formed them.
 * @property {number} [lookedUpLater]  Batches it answered a turn of the event loop later.
 * @property {number} [precisionSwitches]  Times x87 regions went to another precision control:
 *     from the wide ones to single, and from single to a test at every rounding operation.
 * @property {number} [interpretedRelaxedReads]  x87 status words the interpreter tier in wasm
 *     stored (`fnstsw`) while not `precise`: reads that may see a bit only `precise` keeps.
 * @property {boolean} [looseStacks]  Whether stores through esp alone go untested: until code
 *     is translated on a thread's stack (`noteStack`).
 * @property {number} [stackCode]  Times code on a stack switched that off (once at most).
 * @property {boolean} [wide]  Whether x87 regions are still compiled for wide precision.
 * @property {'wide' | 'narrow' | 'mixed'} [precision]  The precision control new x87 regions are
 *     compiled for: the wide ones, single, or either (a test at every rounding operation).
 * @property {number} [shapeMisses]  Entries that found the x87 stack in another shape than
 *     their block was compiled for, and left for the host.
 * @property {number} [shapeChecked]  x87 regions translated again checked for it.
 * @property {number} [x87RelaxedReads]  Translated x87 status-word reads (`fnstsw` into memory or
 *     into AX not read as C0 C2 C3 alone, `fnstenv`, `fnsave`) that may see the exception flags
 *     or C1, which only a `precise` run keeps: a strange result there is worth one.
 * @property {{ eip: string, count: number, order: number, a: number, c: number }} [nanFirst]
 *     Under `precise`: the first x87 NaN translated code made from numbers, its operands, how
 *     many were made; `order` is its place among the first events of a NaN hunt, from 1.
 * @property {{ eip: string, count: number, order: number, region: string, entryTop: number,
 *     empty: string, top: number }} [stackFaultFirst]  Under `precise`: the first x87 stack fault
 *     (an empty register read, a held one pushed onto), the region and the top it was entered at,
 *     the empty mask and the top it found, and how many.
 * @property {{ eip: string, count: number, order: number }} [nanResultFirst]  Under `precise`:
 *     the first x87 arithmetic with a NaN result, made or carried from an operand, and how many.
 * @property {{ eip: string, count: number, order: number, from: string }} [nanLoadFirst]  Under
 *     `precise`: the first x87 float load that read a NaN, the guest address it read, how many.
 * @property {{ eip: string, count: number, order: number, to: string }} [nanStoreFirst]  Under
 *     `precise`: the first x87 float store of a NaN, the guest address it wrote, how many.
 * @property {[number, number, number, number][]} [blockCounts]  With `blockProfile`: every
 *     counted block as [address, executions, shared slot, the entry of a region it is in
 *     or -1], most executed first.
 * @property {{ address: number, count: number, shared: boolean, entry: number,
 *     bytes: number }[]} [topBlocks]  The forty most executed, with the region each is in.
 * @property {number} invalidations    Regions discarded by a write.
 * @property {number} volatilePages    Pages written so often they are no longer translated.
 * @property {number} [dropped]        Regions dropped at publication because a page moved.
 * @property {number} [queued]         Candidates noted and not yet formed.
 * @property {number} [barren]         Candidate keys a region formed nothing at.
 * @property {number} [queueDrops]     Candidates a page write cleared.
 * @property {number} [queueEvictions] Candidates evicted cold when the queue was full.
 * @property {Record<ExitKind, number>} exits
 * @property {{ address: number, count: number, reason: string }[]} exitsByTarget
 *     The top untranslated-exit targets and why each has no entry.
 * @property {Record<string, number>} refused  Opcode ("0f 2e", "f3 0f 10") → times met.
 * @property {Record<string, number>} [relaxedFlagReads]  Opcode → translated instructions that
 *     read a flag an instruction before them in their block left undefined, which without
 *     `precise` holds whatever the cheapest code left there.
 * @property {number} forcedSteps      Turns that retired nothing and were forced to interpret one
 *     instruction, so no slice of translated-plus-interpreted code stops moving.
 * @property {number} translateMs      Milliseconds spent translating: the sum of the seven
 *     parts below, so a whole figure and its split always agree. It and every other
 *     millisecond figure here are 0 unless the engine was configured with `timings`.
 * @property {number} formingMs        Of it: forming the batch's regions, a decode each.
 * @property {number} lookupMs         Of it: the store's lookups, awaited.
 * @property {number} emitMs           Of it: emitting the regions the store did not hold.
 * @property {number} encodeMs         Of it: encoding their modules.
 * @property {number} storeMs          Of it: packing the records and handing them to the store.
 * @property {number} instantiateMs    Of it: compiling and instantiating the modules.
 * @property {number} publishMs        Of it: the entry hash, the page flags and the records.
 * @property {number} workerMs         Emitting and encoding the translation worker did,
 *     reported apart from `translateMs`, which is the engine thread's own.
 * @property {number} moduleBytes      Wasm bytes built this run.
 * @property {number} handoffMisses    Hybrid: slices the emulator ran through translated code.
 */

/**
 * What a runtime answers to the host that composes it.
 *
 * @typedef {Object} Runtime
 * @property {(eip: number, x87Top?: number) => number} entryOf  Function index, or -1.
 * @property {(entry: number, budget: number) => ExitRecord} run
 * @property {(eip: number, x87Top?: number, hotness?: number) => void} noteHot
 *     A candidate from the layer's
 *     sampler, with the x87 top a region there is compiled for.
 * @property {(address: number, x87Top?: number, held?: boolean) => void} missAt  One
 *     untranslated exit to an address at an x87 top; it becomes a candidate once enough land
 *     there at that top -- unless the region left it to the host on purpose (`held`).
 * @property {() => void} forcedStep  Records one turn the host forced an interpreted instruction
 *     through, for the progress guarantee's `forcedSteps`.
 * @property {() => Promise<number>} translatePending
 *     Regions published; resolves when the batch is instantiated.
 * @property {() => Promise<void>} flush  Writes the store's own bookkeeping (a directory
 *     store's index) before a run ends.
 * @property {(records: [string, Uint8Array][], nameOf: (key: string) => string)
 *     => [string, Uint8Array][]} [seedRecords]  Of a store's records (name, bytes), the ones
 *     a seed for this translator needs: its region records and the modules they name.
 * @property {(page: number) => void} invalidatePage  A host or guest write into code.
 * @property {(entry: (budget: number) => number, entered: () => number) => boolean}
 *     [interpretWith]  Cork alone: the interpreter tier in wasm's `entry`, which translated
 *     code then runs at an untranslated exit whose target has no region, going on at the
 *     entry it stops at, rather than leave, and its `entered`, which the translator's own
 *     share leaves out; false when the runtime has no function table to reach it through.
 * @property {(what: string, since: number, floorMs?: number) => void} [noteStall]
 *     A hold of the engine thread since that `performance.now`, kept when over the floor.
 * @property {(page: number) => boolean} holdsPage  Whether a published region spans the page
 *     (the pages the emulator's handoff bit is set for).
 * @property {(base: number, size: number) => void} noteStack  A thread's stack: a store
 *     through esp may go untested while no translated code lies on one.
 * @property {() => EngineDiagnostics} diagnostics  The whole snapshot, for a report: it
 *     sorts and explains the exit targets, so it is not for a slice.
 * @property {() => Pick<EngineDiagnostics, 'regions' | 'modules' | 'invalidations'
 *     | 'translatedShare' | 'retired' | 'translateMs' | 'exits'>} counters
 *     The slice-cheap subset, read by the frame counters every slice.
 */

/**
 * The one export of an engine package's entry module.
 *
 * @typedef {(env: EngineEnv) => Runtime} EngineFactory
 */
