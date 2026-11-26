/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The runtime's settings, one table: every key cork takes as `config`, its default and a
 * line saying what it is, with why the default is what it is where that was measured.
 * docs/cork/settings.md is written from it and the core's `EngineConfig` names the same
 * keys (`tools/checks/check-cork-settings.mjs` fails where they part). Apart from the
 * runtime's state so the defaults read as one table; the host's keys win.
 *
 * Each entry: `kind`, the docs' section (`host`: what a host passes to wire cork into
 * itself; `debug`: a switch that turns a path off or adds an instrument; `test`: a lever a
 * test or a stand moves); `value`, the default the runtime applies, undefined where it
 * applies none and the key's reader decides (`shown` then says what it does); `doc`, the
 * line the docs give it.
 */

import { CallStack } from '../emit/region.js';
import { COLD_REACH, FORM_DEPTH, LEAF_BYTES, REGION_BLOCKS } from '../region.js';

/**
 * @typedef {Object} Setting
 * @property {'host' | 'debug' | 'test'} kind
 * @property {unknown} value
 * @property {string} doc
 * @property {string} [shown]  the default as the docs give it, where the value alone
 *     does not say it
 */

export const SETTINGS = {
    // --- What a host passes ---
    // Locked instructions as wasm atomics, each one indivisible on the shared
    // memory: for a process whose threads run on more than one executor.
    // Off, a process on one executor pays nothing.
    atomic: { kind: 'host', value: false,
        doc: '`lock`-prefixed instructions and `xchg` with memory as wasm atomics: set by the'
            + ' core for a process whose threads run on several executors over one memory.' },
    trapPort: { kind: 'host', value: undefined, shown: 'none',
        doc: 'The I/O port whose `out` is the host\'s call.' },
    worker: { kind: 'host', value: undefined,
        shown: 'on where `Worker` exists, unless `feed` is `\'slice\'`',
        doc: 'Emit and compile in translation workers; `false` translates on the calling'
            + ' thread.' },
    workerUrl: { kind: 'host', value: undefined, shown: 'beside the runtime',
        doc: 'Where `translator.worker.js` is, when a bundler moves it.' },
    // Translation workers the runtime opens itself, each with a batch of its
    // own out: a loading phase keeps one busy most of the time with work
    // queued behind its batch. 0 with a worker: none opened here, a host's
    // pool lends them (`attachTranslator`).
    translators: { kind: 'host', value: 1,
        doc: 'Workers the runtime opens itself; 0 when a host\'s pool lends them.' },
    // The run's cache the functions emitted are kept in (`kept.js`): every
    // thread of the run reads them in place; absent, each thread keeps its own.
    kept: { kind: 'host',
        value: /** @type {import('./kept.js').KeptStore | undefined} */ (undefined), shown: 'none',
        doc: 'The run\'s cache the functions emitted are kept in (`KeptStore`), read in place by'
            + ' every thread of the run; absent, each thread keeps its own.' },
    // Null for a process on one executor (`shared-code.js`).
    sharedCode: { kind: 'host',
        value: /** @type {{ at: number, index: number } | null} */ (null), shown: 'none',
        doc: 'Where the process\'s record of code shared between its executors lies and which'
            + ' executor this runtime is, when other executors share its page flags.' },
    doorbell: { kind: 'host', value: undefined, shown: 'none',
        doc: 'The words a translation worker rings after it answers: the count of answers'
            + ' posted and the bell the engine thread sleeps on, its count followed by the'
            + ' count of the waits asleep on it.' },
    // Whether the host made the tables zero itself -- a memory just made, or one
    // it zeroed where they lie: the entry hash is then left as it is at the start,
    // where clearing it made its 12 MiB resident in a memory nothing had touched.
    tablesZeroed: { kind: 'host', value: false,
        doc: 'The host made the tables zero itself (a memory just made, or zeroed where they'
            + ' lie): the entry hash is not cleared at the start, which made all of it'
            + ' resident.' },
    awaited: { kind: 'host', value: undefined, shown: 'none',
        doc: 'Whether another executor waits for this one\'s answer: forming and lookups stop'
            + ' at the next region while it does.' },
    store: { kind: 'host', value: undefined, shown: 'none',
        doc: 'Where translations are kept between runs (the core gives one per bundle in'
            + ' OPFS).' },
    bundleId: { kind: 'host', value: undefined, shown: '`\'unknown\'`',
        doc: 'The namespace of the store\'s records.' },
    cacheVersion: { kind: 'host', value: undefined, shown: 'the translator\'s',
        doc: 'A version above the translator\'s own: every record of another version'
            + ' misses.' },
    feed: { kind: 'host', value: undefined, shown: '`\'frame\'`',
        doc: 'When candidates are formed: once a frame, and at a slice\'s end once the program'
            + ' has run a frame\'s worth with none presented, or after every slice (`\'slice\'`;'
            + ' `createMachine`\'s).' },
    // Their regions leave the table and the entry hash, stay in the store, and
    // are brought back from it as any miss is (`EVICT_HOLD`).
    cacheBytes: { kind: 'host', value: 256 << 20,
        doc: 'The wasm bytes of the modules running regions are in, past which those gone'
            + ' longest without running are let go (0: no ceiling); the core sets a ceiling'
            + ' only on the iOS path below.' },
    // A menu and a level's load reach code the level's frames never run again,
    // and outside the iOS ceiling nothing let it go: a module untouched this
    // long is let go to the store (`evictCold`).
    coldMs: { kind: 'host', value: 60_000,
        doc: 'Milliseconds without the engine touching a module before it is let go to the'
            + ' store, brought back from it if asked for again (0: never).' },
    // A module the bound has no room for lets those gone longest without running
    // go until there is (`take` answers false where there is none).
    charge: { kind: 'host',
        value: /** @type {{ take(bytes: number): boolean, give(bytes: number): void } | null} */
            (null),
        shown: 'none',
        doc: 'Where a host bounds what its runtimes hold together: `{ take(bytes), give(bytes)'
            + ' }`. Each module held is taken by its wasm bytes and given back as it is let go;'
            + ' one it has no room for lets those gone longest without running go until there'
            + ' is, and where none is left one module is held past it (`unchargedBytes` in the'
            + ' diagnostics).' },
    // The keeping's code is one whatever runtimes run it: paid once, by it.
    sharedCharge: { kind: 'host',
        value: /** @type {{ take(bytes: number): boolean, give(bytes: number): void } | null} */
            (null),
        shown: 'none',
        doc: 'What the modules kept for the runtimes sharing a store (`sharedModuleBytes`) are'
            + ' taken from, by the first runtime of the thread to keep one: `{ take(bytes),'
            + ' give(bytes) }`, as `charge`. A kept module is paid for there and by no runtime'
            + ' running it; one it has no room for is not kept.' },
    // The engine keeps a module's compiled code until a full collection finds
    // it unreachable, which a thread with a small heap may not run for minutes.
    letGo: { kind: 'host', value: /** @type {((bytes: number) => void) | null} */ (null),
        shown: 'none',
        doc: 'Told the wasm bytes of each module the runtime lets go (no running region in'
            + ' it any more: replaced, evicted or written over), so a host can ask its engine'
            + ' to collect the compiled code it no longer reaches.' },
    sharedModuleBytes: { kind: 'host', value: 256 << 20,
        doc: 'The wasm bytes of compiled batch modules kept for every runtime handed the same'
            + ' `store` (`shared-modules.js`): a process the run starts again instantiates what'
            + ' an earlier one compiled, its lazily compiled and tiered-up code with it (0: none'
            + ' kept). The store\'s own `hold`, where it has one, keeps each such module alive'
            + ' for runtimes in other threads too. A store made for one runtime (`alone: true`,'
            + ' as a process or an executor in a worker of its own is handed) is kept beside'
            + ' only from the second runtime handed it on; `hold` is called all the same.' },
    // HACK until iOS ships https://github.com/WebKit/WebKit/pull/76671:
    // false keeps every tail call inside its own instance, a transfer to a
    // region of another module leaving for this loop, which enters it. iOS
    // 27's JavaScriptCore faults on a tail call into another instance
    // (WebKit bug 325447) and runs those inside one; with `dispatch` a
    // module's own regions stay direct tail calls (the host decides,
    // `withoutFaultingTailCalls` in core's app.js).
    crossTailCalls: { kind: 'host', value: true,
        doc: 'HACK until iOS ships [WebKit PR #76671](https://github.com/WebKit/WebKit/pull/76671):'
            + ' `false` keeps every tail call inside its own instance, as iOS 27, which kills the'
            + ' page on a tail call into another instance ([WebKit bug'
            + ' 325447](https://bugs.webkit.org/show_bug.cgi?id=325447)), is given it.' },
    // Each module is placed in a range of the table, and a transfer to a
    // function of the same module is a direct tail call, the table's
    // indirect one only another module's (false: every transfer through
    // the table). Off unless asked: the benchmarks gain at most a few per
    // cent from it, and in the games `callTargets` names one still ran at
    // 57 % of the frame rate it had with neither when this one alone was on.
    dispatch: { kind: 'host', value: false,
        doc: 'Each module placed in a range of the table, a transfer inside it a direct tail'
            + ' call: the core gives it an iPhone, with `crossTailCalls: false`.' },
    // With `callReturn`, how many wasm calls may wait at once, each the
    // frames of a region function on the host's stack; a deeper call
    // leaves for this loop (`callAndReturn` in emit/integer.js). A host
    // whose worker stack holds fewer of them is given fewer (HACK until iOS
    // ships https://github.com/WebKit/WebKit/pull/76671, with
    // `crossTailCalls`: `withoutFaultingTailCalls` in core's app.js).
    callDepth: { kind: 'host', value: CallStack.LIMIT,
        doc: 'With `callReturn`, the calls made as wasm calls that may wait at once (HACK until'
            + ' iOS ships the same PR): iOS overflows a 512 KB worker stack, so the core gives'
            + ' an iPhone 64.' },

    // --- Debugging ---
    // Test-only: a run with the translator off, so the whole program is
    // the interpreter tier's and the corpus can judge it alone.
    translate: { kind: 'debug', value: true,
        doc: '`false` interprets everything: the reference a translated run is compared'
            + ' with.' },
    leaveOut: { kind: 'debug', value: undefined, shown: '`[]`',
        doc: 'Instruction classes (`\'x87\'`, `\'mmx\'`, `\'sse\'`) left to the'
            + ' interpreter.' },
    interpretRange: { kind: 'debug', value: /** @type {[number, number] | null} */ (null),
        shown: 'none', doc: '`[from, to)`: addresses left to the interpreter.' },
    wasmInterpreter: { kind: 'debug', value: undefined, shown: '`true`',
        doc: '`false` runs the JavaScript interpreter alone (the core\'s host).' },
    // Everything the translator relaxes for speed kept exact instead: off, what
    // the cheapest code leaves there; on, what the instruction model leaves.
    // Off, as games run: the tests and the hardware corpus turn it on.
    precise: { kind: 'debug', value: false,
        doc: 'x87 exception flags, signalling NaNs, underflow, C1 and the flags an instruction'
            + ' leaves undefined kept as the processor keeps them; the conformance tests and the'
            + ' hardware corpus turn it on.' },
    // On an arm64 host x86's sign took a compare and a branch after every
    // operation, and programs do not read a NaN's sign.
    exactNaN: { kind: 'debug', value: false,
        doc: 'Every NaN a float operation makes carries x86\'s sign, not the host\'s.' },
    // Left unset, reads are wrapped into RAM (one `and` for a shift, a load and
    // a branch) until the program first touches a closed page where it is
    // tested -- the interpreter, a store -- and tested from then on
    // (`readsFaulted`): a program that never goes near one pays nothing.
    checkReads: { kind: 'debug', value: /** @type {boolean | undefined} */ (undefined),
        shown: 'unset',
        doc: '`true` tests every read\'s pages from the start, `false` never closes a page;'
            + ' unset, reads are wrapped into RAM until the program first faults on a closed'
            + ' page, and tested from then on.' },
    // A stack holds no code unless a program runs code there; the runtime
    // switches it off for good once translated code lies on one (`noteStack`).
    looseStacks: { kind: 'debug', value: true,
        doc: '`false` tests the pages of every store through `esp`.' },
    // A call out of a region a wasm call, and the region going on after the
    // `ret` that comes back to it, rather than a transfer through the entry
    // hash each way (`callAndReturn` in emit/integer.js).
    callReturn: { kind: 'debug', value: true,
        doc: '`false` makes every call and return out of a region a transfer through the'
            + ' entry hash.' },
    leafCalls: { kind: 'debug', value: true,
        doc: '`false` forms no leaf callee into its caller.' },
    // `helpers.js`, `emit/crt.js`; a list of entries: those alone (a test's).
    helpers: { kind: 'debug', value: true,
        doc: '`false` makes every call to a compiler\'s or C runtime\'s function the dictionary'
            + ' knows as it is, rather than as what it does (`memcpy` as one'
            + ' `memory.copy`).' },
    // An engine's own in place of a runtime's (`routineHelper`).
    helpersAlso: { kind: 'debug',
        value: /** @type {readonly import('../helpers.js').KnownRoutine[] | undefined} */ (
            undefined),
        shown: 'none',
        doc: 'Routines told by their whole code, each a name, an operation and its bytes, and'
            + ' formed as that operation beside the dictionary: Bottlify\'s own C runtime'
            + ' routines, which the app hands it.' },
    formDepth: { kind: 'debug', value: FORM_DEPTH,
        doc: 'Levels of callees formed in that may keep direct calls of their own (0: leaves'
            + ' alone); 2 and 3 measured slower.' },
    // An entry that is a function doing nothing -- a `ret`, after a thunk's
    // jumps (`emptyCode` in region.js) -- marked in the entry hash
    // (`finishModule` in emit/region.js).
    emptyCalls: { kind: 'debug', value: true,
        doc: '`false` enters a function that does nothing rather than returning from it in'
            + ' the transfer.' },
    // Where the entry in the target's first slot is the one the transfer would
    // take at its first look, the transfer's hashing, probe and checks are not
    // run (`linkedCall` in emit/integer.js).
    linkedCalls: { kind: 'debug', value: true,
        doc: '`false` sends every direct call through the transfer rather than calling the'
            + ' function its first hash slot holds.' },
    // Far Cry in Chromium ran 4-6% more instructions a second with it, cold
    // and warm, once the regions it forms again were formed under the credit
    // (`holdMs`); formed in one call they had frozen frames, and with
    // `dispatch` beside it a game had lost half its frame rate
    // (roadmap/negative-results.md).
    callTargets: { kind: 'debug', value: true,
        doc: '`false` samples no indirect call and forms no predicted callee in.' },
    // A block testing precision control once rather than every operation
    // rounding by it; a region seen under both tests at every such operation.
    wideFirst: { kind: 'debug', value: true,
        doc: '`false` tests the precision control at every x87 rounding operation.' },
    // `Singles` in emit/x87.js: the 24-bit result in one operation, where
    // rounding a double's took four after it. A region whose results keep
    // leaving the float's range is translated again rounding them.
    floatSingles: { kind: 'debug', value: true,
        doc: '`false` rounds every single-precision x87 result from a double.' },
    // A region whose test fails `checkedAfter` times is translated again with
    // no test and the checks inside.
    x87Shapes: { kind: 'debug', value: true,
        doc: '`false` checks every x87 register access rather than the stack\'s shape once at'
            + ' an entry.' },
    // Only in a memory the host sized for it (cork's own layout); such a run
    // keeps no store.
    blockProfile: { kind: 'debug', value: false,
        doc: 'Execution counts per block, with `mechanisms` (how calls, returns and jumps'
            + ' went) and `forms` (each instruction form\'s executions and wasm bytes); a run'
            + ' with it keeps no translation store.' },
    // So a profile holds a steady state and not the load.
    blockProfileFrom: { kind: 'debug', value: 0,
        doc: 'With `blockProfile`: seconds after the runtime is made at which the counts start'
            + ' over.' },
    // Off, as a shipped build runs, the clock is read only where the translator
    // needs it (a batch that never comes back is freed after a time).
    timings: { kind: 'debug', value: false,
        doc: 'The translator\'s phases timed: forming, lookups, emitting, encoding, storing,'
            + ' instantiating and publishing, and the record of long holds.' },
    // What tells two runs' keys apart.
    traceStore: { kind: 'debug', value: false,
        doc: 'Translation store keys put, missed and hit, as `entry:hash:top`.' },
    // Translated code a write left standing, formed again when it is asked for.
    checkStale: { kind: 'debug', value: false,
        doc: 'Regions still published whose bytes no longer form as they did'
            + ' (`staleRegions`).' },
    countTransfers: { kind: 'debug', value: false,
        doc: 'Transfers between regions through the hash; `transfers` in the diagnostics only'
            + ' with it.' },

    // --- For tests ---
    hotThreshold: { kind: 'test', value: undefined, shown: '2 (`createMachine`: 50)',
        doc: 'Jumps to a target before it is a candidate.' },
    // The slice sampler sees only where budgets run out, and a stub reached
    // through such exits alone never appears there.
    missThreshold: { kind: 'test', value: 64,
        doc: 'Untranslated exits to one address before it is a candidate.' },
    maxQueued: { kind: 'test', value: 8192,
        doc: 'Candidates waiting; past it the coldest is dropped.' },
    batchRegions: { kind: 'test', value: 32, doc: 'Regions per wasm module.' },
    maxBatchRegions: { kind: 'test', value: 256,
        doc: 'The most regions a deep queue\'s batch takes.' },
    // The engine thread's time the translator's work may take at a stretch
    // (and `HOLD_SHARE` of its time over a while, `forming.js`), where a worker
    // is wanted: a batch goes on forming in the calls after, the store's hits
    // are compiled off the thread, their compiles started and they and a
    // worker's answers published a share's worth a call, and a call that finds
    // the share spent does nothing until it has come back. A program reaching
    // code it had not run held the thread for batches formed whole, a tenth of
    // a second at a time in the runs measured -- frames the guest did not run,
    // its sound late -- where the translation is the one to wait.
    holdMs: { kind: 'test', value: 4,
        doc: 'The engine thread\'s time the translator\'s work may take at a stretch where a'
            + ' worker is wanted (0: a batch formed and published whole in one call).' },
    // On time the engine thread was free to hear its answer.
    inFlightMs: { kind: 'test', value: 10_000,
        doc: 'How long a batch may be with a worker before it is given up.' },
    // A mixer patching a voice in as a sound starts writes its code a few times
    // a second for as long as the program runs, and a page left for good after
    // its eighth sound ran interpreted from then on. The interpreter runs MMX
    // code hundreds of times slower than its translation, so a page is left
    // only when it is rewritten about as fast as it can be translated again:
    // eighty times a second.
    volatileAfter: { kind: 'test', value: 8,
        doc: 'Writes dropping a page\'s code within `volatileWindowMs` of each other before'
            + ' the page is left to the interpreter.' },
    volatileWindowMs: { kind: 'test', value: 100,
        doc: 'The window those writes are counted in.' },
    volatileHoldMs: { kind: 'test', value: 2000,
        doc: 'How long a page is left to the interpreter, twice as long each time it is left'
            + ' again.' },
    maxRegionBlocks: { kind: 'test', value: REGION_BLOCKS, doc: 'Blocks of the largest region.' },
    // Its blocks are `formRegion`'s own bound.
    leafBytes: { kind: 'test', value: LEAF_BYTES, doc: 'Bytes of a leaf callee formed in.' },
    // `coldBranch` in region.js: a small function with a far error path is
    // formed in as a leaf.
    coldReach: { kind: 'test', value: COLD_REACH,
        doc: 'Bytes a callee\'s conditional branch may reach and still be followed; a farther'
            + ' one is a way out to cold code, not part of the callee (0: every branch'
            + ' followed).' },
    // `PREDICT_AFTER` in relink.js.
    predictAfter: { kind: 'test', value: 48,
        doc: 'Samples of an indirect call before its callees are looked at.' },
    // At a few hundred readings a second, 64 was a fifth of a second: a site
    // taking one call in a hundred gathered ten samples in it and never came due.
    callWindow: { kind: 'test', value: 1024,
        doc: 'The readings an indirect call\'s samples are kept for.' },
    // A tail call into another module costs more the more modules there are,
    // but the engine thread instantiates each one whole -- 4096 regions of a
    // real title held it for 160 ms, 512 for 23 -- and a stall that long is a
    // frame lost and a sound mixer late.
    relinkAfter: { kind: 'test', value: 16,
        doc: 'Batch modules published before the running regions are gathered into large'
            + ' ones (0: never).' },
    // Gathering emits and compiles every region again: 71 % more work over the first
    // 215 million instructions of a program of 453 regions, for the same cost of an
    // instruction once settled. So only once the program has stopped reaching new code.
    relinkQuiet: { kind: 'test', value: 2 ** 30, shown: '2^30',
        doc: 'Instructions of translated code since the last batch module before the running'
            + ' regions are gathered.' },
    relinkRegions: { kind: 'test', value: 512, doc: 'Regions in each gathered module.' },
    // A module is held or let go whole (`cacheBytes`), and one hot region in a
    // module of cold ones held them all.
    relinkCold: { kind: 'test', value: 128,
        doc: 'Regions in each module a relink builds of those no entry reached lately.' },
    summaries: { kind: 'test', value: true,
        doc: 'A stored region is taken by its record\'s summary, without forming it'
            + ' (`summary.js`); false: formed as its record says, then compared.' },
    // A relink's cost against the direct tail calls it buys; never without a
    // worker.
    mergeAfter: { kind: 'test', value: 1 << 16,
        doc: 'Transfers between two modules before they are merged on the translation worker'
            + ' (0: never).' },
    checkedAfter: { kind: 'test', value: 4,
        doc: 'Failed x87 shape tests before a region is formed again without one.' },
    hashSlots: { kind: 'test', value: undefined, shown: '2^20',
        doc: 'Slots of the entry hash (12 bytes each).' },
    yieldChunk: { kind: 'test', value: undefined, shown: '2^24',
        doc: '`createMachine` alone (cork\'s machine for its tests): the instructions translated'
            + ' code runs at a time.' },
    lowBlock: { kind: 'test', value: undefined, shown: '`true`',
        doc: 'The core\'s host: over a wide window whose code block is past 4 GiB, the block'
            + ' below it translated by a runtime of its own (`twoBlockRuntime`); false leaves'
            + ' its code to the interpreter tier.' },
    sliceMs: { kind: 'test', value: undefined, shown: '8',
        doc: 'How long an interpreting slice may take.' },
    wasmInterpreterAfter: { kind: 'test', value: undefined, shown: '8192',
        doc: 'Work the JavaScript interpreter does before the wasm tier takes over.' },
    clock: { kind: 'test', value: /** @type {'host' | 'virtual' | undefined} */ (undefined),
        shown: '`host`',
        doc: 'The clock the cork host and the translator decide by. `virtual`: the'
            + ' instructions the guest retired, a million a millisecond, for a slice\'s length,'
            + ' the time-stamp counter and a page\'s rewrites, the translation done on the'
            + ' engine thread. The same program then translates and runs the same code on any'
            + ' machine however busy it is; the time it took is the machine\'s alone. For'
            + ' stands, not the product.' },
};

/**
 * Each key's value, typed as its entry has it.
 * @template {Record<string, { value: unknown }>} T
 * @param {T} table
 * @returns {{ [K in keyof T]: T[K]['value'] }}
 */
function valuesOf(table){
    return /** @type {any} */ (Object.fromEntries(Object.entries(table)
        .map(([name, { value }])=>[name, value])));
}

/** The defaults, made once: a runtime takes a copy of them under its host's keys. */
const DEFAULTS = valuesOf(SETTINGS);

/** @param {import('../../../core/src/layers/cpu/engine.js').EngineConfig} config */
export function runtimeSettings(config){
    return { ...DEFAULTS, ...config };
}
