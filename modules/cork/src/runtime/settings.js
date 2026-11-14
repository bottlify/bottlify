/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The runtime's settings: every default, with why it is what it is, under what
 * the host's config names. Apart from the runtime's state so the defaults read
 * as one table; the host's keys win.
 */

import { CallStack } from '../emit/region.js';

/** @param {import('../../../core/src/layers/cpu/engine.js').EngineConfig} config */
export function runtimeSettings(config){
    return {
        maxRegionBlocks: 128, batchRegions: 32,
        maxQueued: 8192, maxBatchRegions: 256,
        // Writes that drop a page's regions, inside `volatileWindowMs` of each
        // other, before the page is left to the other executor -- for
        // `volatileHoldMs`, twice as long each time it is left again: a mixer
        // patching a voice in as a sound starts writes its code a few times a
        // second for as long as the program runs, and a page left for good
        // after its eighth sound ran interpreted from then on. The interpreter
        // runs MMX code hundreds of times slower than its translation, so a
        // page is left only when it is rewritten about as fast as it can be
        // translated again: eighty times a second.
        volatileAfter: 8,
        volatileWindowMs: 100,
        volatileHoldMs: 2000,
        // Untranslated exits to one address before it is a candidate of the
        // translator's own: the slice sampler sees only where budgets run
        // out, and a stub reached through such exits alone never appears there.
        missThreshold: 64,
        // Test-only: a run with the translator off, so the whole program is
        // the interpreter tier's and the corpus can judge it alone.
        translate: true,
        countTransfers: false,
        // Diagnostic: every block counts its executions in the block profile past
        // the tables -- only in a memory the host sized for it (cork's own layout)
        // -- and the diagnostics name the counts. Such a run keeps no store.
        blockProfile: false,
        // With `blockProfile`: seconds after the runtime is made at which the
        // counts start over, so a profile holds a steady state and not the load.
        blockProfileFrom: 0,
        // Diagnostic: every store key put and every one missed, as
        // `entry:hash:top`, in the diagnostics -- what tells two runs' keys apart.
        traceStore: false,
        // Diagnostic: the regions still published whose bytes no longer form
        // as they did -- translated code a write left standing -- in the
        // diagnostics (`staleRegions`), formed again when they are asked for.
        checkStale: false,
        // Diagnostic: addresses in [from, to) are left to the interpreter.
        interpretRange: /** @type {[number, number] | null} */ (null),
        // Batch modules published before the running regions are gathered into
        // big ones (0: never), and how many regions go into each of those:
        // a tail call into another module costs more the more modules there are,
        // but the engine thread instantiates each one whole -- 4096 regions of
        // a real title held it for 160 ms, 512 for 23 -- and a stall that long is
        // a frame lost and a sound mixer late.
        relinkAfter: 16,
        relinkRegions: 512,
        // The regions a relink found no entry of in the last while go into
        // modules of this many: a module is held or let go whole (`cacheBytes`),
        // and one hot region in a module of cold ones held them all.
        relinkCold: 128,
        // The wasm bytes of the modules some running region's function is in,
        // past which those gone longest without running are let go (0: no
        // ceiling): their regions leave the table and the entry hash, stay in
        // the store, and are brought back from it as any miss is
        // (`EVICT_HOLD`).
        cacheBytes: 256 << 20,
        // Where a host bounds what its runtimes hold together: each module held
        // is taken from it by its wasm bytes and given back as it is let go, and
        // a module it has no room for lets those gone longest without running go
        // until there is (`take` answers false where there is none).
        charge: /** @type {{ take(bytes: number): boolean, give(bytes: number): void } | null} */
            (null),
        // The wasm bytes of compiled batch modules kept for every runtime
        // sharing this one's store (`shared-modules.js`): a process started again
        // instantiates what an earlier one compiled (0: none kept).
        sharedModuleBytes: 256 << 20,
        // The formed regions kept for every runtime sharing this one's store
        // and forming as it does (`shared-forms.js`): a store hit whose bytes
        // and pages answer as they did is not decoded again (0: none kept).
        // Each is many small objects; 32 768 of them held 1.8 GB of the
        // engine thread's heap, whose collections cost more than they saved.
        sharedFormed: 8192,
        // A small leaf callee formed into its caller, the call and its return
        // jumps inside the region (false: every call crosses regions).
        leafCalls: true,
        // A call to a function of a compiler's or C runtime's the dictionary
        // knows by its bytes formed as what it does (`helpers.js`, `emit/crt.js`;
        // false: every such call made as it is; a list of entries: those alone).
        helpers: true,
        // Routines known by their whole code ({ name, does, code }) beside the
        // dictionary: an engine's own in place of a runtime's (`routineHelper`).
        helpersAlso: /** @type {readonly import('../helpers.js').KnownRoutine[] | undefined} */ (
            undefined),
        // Indirect calls sampled while the translator runs, and a region whose
        // indirect call keeps going to a few small leaf callees formed again
        // with them in it: the call compares its target with each and jumps
        // (false: every indirect call leaves its region). Far Cry in Chromium
        // ran 4-6% more instructions a second with it, cold and warm, once the
        // regions it forms again were formed under the credit (`holdMs`); formed
        // in one call they had frozen frames, and with `dispatch` beside it a
        // game had lost half its frame rate (roadmap/negative-results.md).
        callTargets: true,
        // Transfers from one module's regions into another's before the two
        // are gathered into one module on the translation worker (0: never;
        // never without a worker): a relink's cost against the direct tail
        // calls it buys.
        mergeAfter: 1 << 16,
        // Each module is placed in a range of the table, and a transfer to a
        // function of the same module is a direct tail call, the table's
        // indirect one only another module's (false: every transfer through
        // the table). Off unless asked: the benchmarks gain at most a few per
        // cent from it, and in the games `callTargets` names one still ran at
        // 57 % of the frame rate it had with neither when this one alone was on.
        dispatch: false,
        // A call out of a region a wasm call, and the region going on after the
        // `ret` that comes back to it, rather than a transfer through the entry
        // hash each way (`callAndReturn` in emit/integer.js).
        callReturn: true,
        // An entry that is a function doing nothing -- a `ret`, after a thunk's
        // jumps (`emptyCode` in region.js) -- marked in the entry hash, so a call
        // to it returns from the transfer without entering its region
        // (`finishModule` in emit/region.js; false: entered as any other).
        emptyCalls: true,
        // A direct call out of a region reads its target's first slot in the
        // entry hash and, where the entry there is the one the transfer would
        // take at its first look, calls its function itself: the transfer's
        // hashing, probe and checks not run (`linkedCall` in emit/integer.js;
        // false: every call through the transfer).
        linkedCalls: true,
        // Each x87 region compiled for the precision control it runs under --
        // the wide ones (double, extended) or single -- a block testing
        // precision control once rather than every operation rounding by it;
        // a region seen under both tests at every such operation (false: every
        // region tests from the start).
        wideFirst: true,
        // A NaN a float operation makes carries the sign the host gives it, not
        // x86's: on an arm64 host x86's sign took a compare and a branch after
        // every operation, and programs do not read a NaN's sign (true: every
        // NaN made as x86 makes it).
        exactNaN: false,
        // A region compiled for single precision computes its x87 arithmetic
        // on floats in f32 where the operands are floats (`Singles` in
        // emit/x87.js): the 24-bit result in one operation, where rounding a
        // double's took four after it. A region whose results keep leaving the
        // float's range is translated again rounding them (false: always).
        floatSingles: true,
        // x87 regions compiled for the stack's shape at their entries -- which
        // registers are held and which empty -- tested once at an entry rather
        // than at every instruction; a region whose test fails `checkedAfter`
        // times is translated again with no test and the checks inside
        // (false: every region so from the start).
        x87Shapes: true,
        checkedAfter: 4,
        // A region's loops as wasm loops, the loops of its control flow
        // (`planStructure`), a block inside one entered through a copy of its
        // own (false: every backward jump through the region's dispatch).
        structure: true,
        // Everything the translator relaxes for speed kept exact instead: the x87
        // exception flags and their tests, signalling NaNs, underflow and C1, and
        // the flags an instruction leaves undefined -- off, what the cheapest code
        // leaves there; on, what the instruction model leaves. Off, as games run: the
        // tests and the hardware corpus turn it on.
        precise: false,
        // Whether an instruction that only reads tests its pages as a store
        // does, so a page the program cannot read -- a reservation not
        // committed, one protected PAGE_NOACCESS -- faults as on Windows. Left
        // unset, reads are wrapped into RAM (one `and` for a shift, a load and
        // a branch) until the program first touches such a page where it is
        // tested -- the interpreter, a store -- and tested from then on
        // (`readsFaulted`): a program that never goes near one pays nothing.
        // True tests from the start, false never.
        checkReads: undefined,
        // Whether the guest's first page is the RAM's zeros, which nothing writes and
        // a store there faults (the host's `zeroReadsBelow` over it): a tested window
        // of reads inside it reads them in place rather than leaving to the host.
        zeroPage: false,
        // Locked instructions as wasm atomics, each one indivisible on the shared
        // memory: for a process whose threads run on more than one executor.
        // Off, a process on one executor pays nothing.
        atomic: false,
        // With atomic: the integer loads and stores not through esp as wasm atomics
        // too, so a program's plain stores reach another thread in their order --
        // what x86 keeps and a host that reorders plain accesses (arm64) does not.
        ordered: false,
        // Where the process's record of shared code lies and which executor this
        // runtime is (`shared-code.js`), when other executors share its page flags;
        // null for a process on one.
        sharedCode: /** @type {{ at: number, index: number } | null} */ (null),
        // Whether the host made the tables zero itself -- a memory just made, or one
        // it zeroed where they lie: the entry hash is then left as it is at the start,
        // where clearing it made its 12 MiB resident in a memory nothing had touched.
        tablesZeroed: false,
        // A store through esp alone tests no page while no translated code lies
        // on a thread's stack (`noteStack`), which the runtime then switches off
        // for good: a stack holds no code unless a program runs code there.
        looseStacks: true,
        // How long a batch may be with the worker, on time the engine thread was
        // free to hear its answer, before it is given up (tests shorten it).
        inFlightMs: 10_000,
        // Translation workers the runtime opens itself, each with a batch of its
        // own out: a loading phase keeps one busy most of the time with work
        // queued behind its batch. 0 with a worker: none opened here, a host's
        // pool lends them (`attachTranslator`).
        translators: 1,
        // The translation cache arena, made by the host for every executor of a
        // process (`createArena`), so what one executor's translators emitted the
        // others take; absent, the runtime makes its own.
        arena: /** @type {SharedArrayBuffer | undefined} */ (undefined),
        // Diagnostic: the host clock read around the translator's phases -- the
        // milliseconds of forming, lookups, emitting, encoding, storing,
        // instantiating and publishing, and the record of long holds. Off, as a
        // shipped build runs, the clock is read only where the translator needs
        // it (a batch that never comes back is freed after a time).
        timings: false,
        // The engine thread's time the translator's work may take at a
        // stretch (and `HOLD_SHARE` of its time over a while), where a worker is
        // wanted: a batch goes on forming in the calls after, the store's
        // hits are compiled off the thread, their compiles started and they
        // and a worker's answers published a share's worth a call, and a call
        // that finds the share spent does nothing until it has come back (0: a
        // batch formed and published whole in the call that takes it or
        // answers it). A program
        // reaching code it had not run held the thread for batches formed
        // whole, a tenth of a second at a time in the runs measured -- frames
        // the guest did not run, its sound late -- where the translation is
        // the one to wait.
        holdMs: 4,
        // The share of the engine thread's time over a while the translator's work
        // may take (`holdMs` refills at it): what a frame gives up to new code.
        holdShare: 0.5,
        // Indirect-call prediction (`callTargets`): samples of a call before its
        // callees are looked at, and the window a call's samples are counted in
        // (`PREDICT_AFTER`, `CALL_WINDOW`).
        predictAfter: 48,
        // At a few hundred readings a second, 64 was a fifth of a second: a
        // site taking one call in a hundred gathered ten samples in it and
        // never came due.
        callWindow: 1024,
        // The bytes a callee formed into its caller (`leafCalls`) may have at
        // most; its blocks are `formRegion`'s own bound.
        leafBytes: 512,
        // Levels of callees formed in that may keep direct calls of their own,
        // their small callees formed in as well (`formRegion`).
        formDepth: 1,
        // How far a conditional branch of a callee formed in may reach and still be
        // followed: a farther one goes to cold code, a way out of the region, so a small
        // function with a far error path is formed in as a leaf (`coldBranch` in
        // region.js; 0: every branch followed).
        coldReach: 4096,
        // HACK until iOS ships https://github.com/WebKit/WebKit/pull/76671:
        // false keeps every tail call inside its own instance, a transfer to a
        // region of another module leaving for this loop, which enters it. iOS
        // 27's JavaScriptCore faults on a tail call into another instance
        // (WebKit bug 325447) and runs those inside one; with `dispatch` a
        // module's own regions stay direct tail calls (the host decides,
        // `withoutFaultingTailCalls` in core's app.js).
        crossTailCalls: true,
        // With `callReturn`, how many wasm calls may wait at once, each the
        // frames of a region function on the host's stack; a deeper call
        // leaves for this loop (`callAndReturn` in emit/integer.js). A host
        // whose worker stack holds fewer of them is given fewer (HACK until iOS
        // ships https://github.com/WebKit/WebKit/pull/76671, with
        // `crossTailCalls`: `withoutFaultingTailCalls` in core's app.js).
        callDepth: CallStack.LIMIT,
        ...config,
    };
}
