/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, Version 2.0
 * See LICENSE for details
 */

/**
 * The cork host: the cpu layer's host over cork's own memory, with no emulator.
 *
 * `engine: 'cork'` runs a program with nothing of the emulator loaded -- not
 * its machine, not its wasm. This host is what stands in for it: a
 * `WebAssembly.Memory` of its own, cork's own layout (a 512-byte state block,
 * the guest's RAM after it, cork's tables after that), and the translator's
 * runtime over the two. The slice loop is the translator's entry, or -- where
 * none exists yet -- the interpreter tier of 5.2, which runs cork's own decoder
 * and evaluator over the state block one instruction at a time. An instruction
 * the evaluator has no model for is the engine's no-tier answer, and a fault
 * becomes the host's fault record.
 *
 * There is no ROM. The boot ROM exists to switch the emulator from real mode
 * and set up its descriptor caches; cork's layout has no segment registers and
 * no control registers, flat 32-bit protected mode being all it translates, so
 * the host sets the registers the ROM would have left: esp at the initial
 * stack, eflags reserved-bit set, the x87 control word and the MXCSR at their
 * defaults, every x87 register empty, and eip read from the entry vector at the
 * first slice (the loader writes the entry point there after boot, the way the
 * ROM's indirect jump read it).
 *
 * Nothing here imports the cork package statically -- the layer never imports an
 * engine package, so the engine module (`createEngine`, `ownLayout`, the table
 * and page arithmetic) is handed in by `module.js`, which loaded it by URL the
 * way it does for `hybrid`.
 */

import { exceptionName, hostFault } from './faults.js';
import { captureBlockContext, restoreBlockContext } from './context.js';

/** Register names in the state block's reg32 view, in index order. */
const REGISTERS = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];

/**
 * How far the counter runs ahead of the guest's clock inside a slice: the
 * clock's own ceiling on one credit, so the two never drift further apart.
 */
const TSC_DRIFT_MS = 16;

/** The default x87 control word: double-extended precision, round to nearest. */
const DEFAULT_CONTROL_WORD = 0x037f;
/** The default MXCSR: every SIMD exception masked. */
const DEFAULT_MXCSR = 0x1f80;
/**
 * eflags after boot: bit 1 is reserved and always set. IF stays clear although
 * a Windows thread reads it set from pushfd: the boot ROM clears it so that no
 * device interrupt ever reaches the emulator's guest (threads are switched on
 * retired instructions, not a timer), and the two engines must show a guest the
 * same flags.
 */
const DEFAULT_EFLAGS = 0x2;
/** The flat 32-bit code selector the segments are implicit at. */
const FLAT_CS = 0x08;
/**
 * How far the JavaScript interpreter carries a process's hosts before the wasm
 * tier takes over, in their instructions (`wasmInterpreterAfter`'s default),
 * and what a jump target new to a host counts as. The tier's start -- its
 * module compiled, and the optimising compile the wasm engine gives its `run`
 * a few hundred instructions in, once a process -- costs more on one core than
 * the two to four thousand instructions a small program interprets before its
 * loops are translated; new code is what the JavaScript interpreter is slow at
 * (a decode and closures an instruction), so a loader or a table of many small
 * functions hands over within a few dozen new targets, a loop only once it has
 * run the whole stretch.
 */
const WASM_AFTER = 8192;
const NEW_TARGET_WORK = 128;
/** The names an engine module must export for this host. */
const ENGINE_EXPORTS = Object.freeze([
    'createEngine', 'ownLayout', 'pagesFor', 'Tables', 'STATE_BLOCK_SIZE',
    'interpret', 'blockState', 'eflagsOf', 'setEflags',
]);

/**
 * @param {number} value
 * @param {number} [width]
 */
const hex = (value, width = 8)=>(value >>> 0).toString(16).padStart(width, '0');

/**
 * @typedef {Object} CorkHostConfig
 * @property {any} engine  The cork engine module: `{ createEngine, ownLayout,
 *     pagesFor, Tables, STATE_BLOCK_SIZE }`.
 * @property {number} memorySize   Guest RAM in bytes.
 * @property {number} trapPort
 * @property {number} entryVector  Linear address of the dword holding the entry point.
 * @property {number} [thunkBase]  Where the thunk table and its park loop begin.
 * @property {number} initialStack Initial guest ESP.
 * @property {import('../engine.js').EngineConfig} [cork]  The translator's config.
 */

/**
 * The rate cork's time-stamp counter advances at, in MHz, which is the speed
 * the machine reports everywhere else too -- the registry's `~MHz` and CPUID
 * leaves 0x15 and 0x16 -- because a program turns rdtsc deltas into seconds with it. A
 * machine's era is read off this figure: a program that finds 1 GHz picks the
 * settings it ships for the slowest machine it supports.
 */
export const CORK_TSC_MHZ = 3000;

/**
 * Builds the cork host over a memory of its own.
 *
 * @param {CorkHostConfig} config
 */
export function createCorkHost(config){
    const { engine, memorySize, trapPort, entryVector, initialStack, cork: corkConfig } = config;
    for (const name of ENGINE_EXPORTS)
    {
        if (engine?.[name] === undefined)
        {
            throw new Error(`cpu: the cork engine module does not export ${name}`);
        }
    }
    const { createEngine, ownLayout, pagesFor, Tables, STATE_BLOCK_SIZE, interpret, blockState,
        eflagsOf, setEflags, WasmExit } = engine;

    // The guest RAM is the whole memorySize; the tables and the state block are
    // memory of cork's own beside it, not carved out of the guest's the way the
    // hybrid carves the tables from the top of the emulator's RAM.
    const layout = ownLayout({ ramSize: memorySize });
    // A profiling run (`blockProfile`) has the block profile past the tables,
    // and the interpreter tier in wasm its hot counts past that.
    const profileSize = import.meta.BOTTLIFY_DIAGNOSTICS !== false && corkConfig?.blockProfile
        ? Tables.BLOCK_PROFILE_SIZE : 0;
    const wasmWanted = typeof engine.createWasmInterpreter === 'function'
        && corkConfig?.wasmInterpreter !== false;
    const wasmArea = layout.tables + Tables.SIZE + profileSize;
    const pages = pagesFor(layout, Tables.SIZE + profileSize
        + (wasmWanted ? engine.WASM_INTERPRETER_AREA : 0));
    const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });

    // The memory is fixed (initial === maximum), so the buffer never detaches
    // and the views are taken once.
    const block = new Uint8Array(memory.buffer, 0, STATE_BLOCK_SIZE);
    const blockView = new DataView(memory.buffer, 0, STATE_BLOCK_SIZE);
    const reg32 = new Int32Array(memory.buffer, layout.regs, 8);
    const xmm = new Uint32Array(memory.buffer, layout.xmm, 32);
    const ram = new Uint8Array(memory.buffer, layout.ramBase, layout.ramSize);
    const whole = new DataView(memory.buffer);

    /** The flags word, whole: the record a region left is folded into it first. */
    const eflagsWord = ()=>eflagsOf(blockView, layout) >>> 0;
    /** @param {number} address  A guest address. */
    const ramOffset = address=>layout.ramBase + address;

    // The boot state: the registers the ROM would have left, and nothing run.
    block.fill(0);
    reg32[4] = initialStack | 0; // ESP
    blockView.setUint32(layout.eflags, DEFAULT_EFLAGS, true);
    blockView.setUint16(layout.x87Control, DEFAULT_CONTROL_WORD, true);
    block[layout.x87Empty] = 0xff; // every register empty
    blockView.setUint32(layout.mxcsr, DEFAULT_MXCSR, true);

    /** @type {((value: number) => void) | null} */
    let trapHandler = null;
    let trapCrossings = 0;
    /** The last slices, newest last: where each began and ended, what it
     * retired, the traps it crossed and whether it halted -- what a run that
     * makes no progress is read by.
     * @type {{ at: number, end: number, retired: number, traps: number, halted: boolean }[]} */
    const recent = [];
    const RECENT = 16;
    // The park loop (hlt; jmp at the thunk base) is where a thread waits, not
    // a path: its starts are left out so the ring keeps how the thread got there.
    const parkBase = (config.thunkBase ?? 0x100000) >>> 0;
    /**
     * The interpreter tier in wasm (`interp-wasm.js`): the integer instruction
     * set run straight from guest memory, the JavaScript interpreter taking
     * what it leaves, once the JavaScript interpreter has carried the
     * process's first stretch (`interpretRange`). It counts hotness in the
     * same table and keeps the same ring of starts, in its area past the
     * tables, from the first instruction; `wasmInterpreter: false` runs the
     * JavaScript interpreter alone.
     *
     * @type {import('../engine.js').WasmInterpreter | null}
     */
    const wasmTier = wasmWanted
        ? engine.createWasmInterpreter({ memory, layout, area: wasmArea,
            hotThreshold: corkConfig?.hotThreshold ?? 2, trapPort, parkBase,
            precise: corkConfig?.precise === true })
        : null;
    /** The last run starts the interpreter ran, a ring: the path a run took
     * into wherever it sits. The wasm tier's, when there is one. */
    const starts = wasmTier?.starts ?? new Uint32Array(256);
    let ownStartAt = 0;
    const startIndex = wasmTier ? wasmTier.startIndex : ()=>ownStartAt;
    /** @param {number} at */
    const noteStart = at=>{
        const index = startIndex();
        starts[index & 255] = at;
        if (wasmTier)
        {
            wasmTier.setStartIndex(index + 1);
        }
        else
        {
            ownStartAt = index + 1;
        }
    };
    // Instructions the wasm tier retired: with the JavaScript interpreter's own
    // count, what the feed's spacing is measured in.
    let wasmRetired = 0;
    let halted = false;
    let stopped = false;
    // Set when the interpreter notes a hot start: the slice ends there so the
    // layer's feed forms the candidate before the next slice, instead of the
    // whole first pass running interpreted ahead of the translator.
    let feedDue = false;
    // A hot note under the frame feed: the interpreter yields so the translator
    // can run, but the slice does NOT end -- the loop below feeds and carries on
    // with what is left of the budget. A loading phase is one long frame, so a
    // frame-boundary feed alone would run the whole load interpreted.
    let translateDue = false;
    // The interpreter's count at the last in-slice feed: a feed waits for
    // FEED_MIN_STEPS interpreted instructions after it, so a loader that meets
    // a new start every few instructions does not translate on every one.
    let retiredAtFeed = 0;
    const FEED_MIN_STEPS = 2048;
    // A candidate was noted since that feed.
    let notedSinceFeed = false;
    // Read through these in a loop condition: `stopped` is set by `stop()` and
    // `halted` by a nested slice, which the static check cannot see.
    const isHalted = ()=>halted;
    const isStopped = ()=>stopped;
    // Read through a function like the two above: `countHot` sets it.
    const isFeedDue = ()=>feedDue;
    // eip is read from the entry vector at the first slice, the way the ROM's
    // indirect jump read it: the loader writes the entry point after boot.
    let entered = false;
    /** @type {import('./faults.js').GuestFault | null} */
    let lastFault = null;
    /**
     * Who is offered a fault before it stops the machine: the layer, which
     * hands it to the program's own exception handlers.
     *
     * @type {((fault: import('./faults.js').GuestFault) => boolean) | null}
     */
    let faultHandler = null;
    let hostWrites = 0;
    let hostWrittenBytes = 0;
    // The counter word folded the way the layer folds it: exact as long as reads
    // come less than 2^32 instructions apart.
    let counted = 0;
    let lastWord = 0;

    const eip = ()=>blockView.getUint32(layout.eip, true) >>> 0;
    /** @param {number} value */
    const setEip = value=>{
        blockView.setUint32(layout.eip, value >>> 0, true);
        entered = true;
    };
    const x87Top = ()=>block[layout.x87Top] & 7;
    /** @param {number} index */
    const x87At = index=>layout.x87 + (index & 7) * 16;

    /** The trap the call channel reaches: run the handler, answer whether to leave.
     * @param {number} value
     */
    const raiseTrap = value=>{
        trapCrossings++;
        const at = eip();
        if (trapHandler)
        {
            trapHandler(value >>> 0);
        }
        return eip() !== at || halted || stopped ? 1 : 0;
    };

    /**
     * The interpreter tier (5.2): cork's own decoder and evaluator over the
     * state block, one instruction at a time. A `Fault` becomes the fault
     * record; an `Unsupported` instruction is this engine's no-tier answer.
     *
     * @type {any}
     */
    let interpreter = null;

    // Cork's own time-stamp counter, at CORK_TSC_MHZ, the rate CPUID's leaves
    // 0x15 and 0x16 state: ticks of the guest's clock once one is given (`useGuestClock`,
    // the clock QueryPerformanceCounter and GetTickCount read), so a program
    // that calibrates the counter against them measures that rate whatever the
    // host did meanwhile; the page's clock since the host was made until then. The
    // guest's clock moves between slices, so within one the counter goes on at
    // the page's rate from its last move, at most a credit's worth, and never
    // backward.
    const tscBase = performance.now();
    const TICKS_PER_MS = CORK_TSC_MHZ * 1000;
    /** @type {(() => number) | null} milliseconds of guest time */
    let guestClock = null;
    let guestMs = 0;
    let guestMovedAt = 0;
    let lastTsc = 0;
    const readTsc = ()=>{
        const now = performance.now();
        let ticks = (now - tscBase) * TICKS_PER_MS;
        if (guestClock !== null)
        {
            const ms = guestClock();
            if (ms !== guestMs)
            {
                guestMs = ms;
                guestMovedAt = now;
            }
            ticks = (guestMs + Math.min(now - guestMovedAt, TSC_DRIFT_MS)) * TICKS_PER_MS;
        }
        lastTsc = Math.max(lastTsc + 1, Math.floor(ticks));
        return BigInt(lastTsc);
    };
    // A slow slice's account of itself reads the clock around every range the
    // interpreter runs -- a tenth of a crossing's cost -- so only a run that
    // asked for the translator's timings keeps one, and a production bundle
    // has none.
    const timings = import.meta.BOTTLIFY_DIAGNOSTICS !== false && corkConfig?.timings === true;
    const clock = import.meta.BOTTLIFY_DIAGNOSTICS !== false && timings
        ? ()=>performance.now() : ()=>0;

    const runtime = createEngine({
        memory,
        layout,
        config: { ...(trapPort === undefined ? {} : { trapPort }), ...corkConfig },
        read: (/** @type {number} */ address)=>ram[address],
        imports: {
            trap: raiseTrap,
            getEflags: eflagsWord,
            x87Read: (/** @type {number} */ index)=>
                blockView.getFloat64(x87At(index), true),
            rdtsc: readTsc,
        },
    });

    /**
     * Every page a host write touches is invalidated, as the hybrid host does:
     * a write into a page holding translated code drops its regions.
     *
     * @param {number} address
     * @param {number} length
     */
    const invalidate = (address, length)=>{
        if (length <= 0)
        {
            return;
        }
        const last = (address + length - 1) >>> 12;
        for (let page = address >>> 12; page <= last; page++)
        {
            runtime.invalidatePage(page);
        }
    };

    // Hotness in cork mode, counted by the interpreter itself: a start run
    // `hotThreshold` times becomes a candidate, and the layer's feed forms it.
    // A translated start is never interpreted again, so the count stops there.
    // Two under cork, not the sampler's two thousand: there is no compiled
    // second executor to carry the code in the meantime, so a start costs a
    // translation on its second visit. A title's loader runs millions of
    // instructions each met once or twice, and every one met twice is a
    // candidate -- which is why the runtime drains its queue hottest first:
    // the count keeps growing while a candidate waits and is handed over at
    // every power of two, so the loop met forty thousand times is formed
    // before the code met twice, and the queue's length costs nothing but
    // memory.
    const hotThreshold = corkConfig?.hotThreshold ?? 2;
    // The counts live in a flat array rather than a map: one byte per four
    // bytes of the first sixteen megabytes of address space, wrapping there.
    // A map grew an entry for every instruction a straight-line loader ran
    // once and never again, which a real route's loading code is millions of;
    // a slot two addresses share only makes the count reach the threshold a
    // visit early, and a candidate noted for an address that is not hot is a
    // translation the runtime declines for nothing.
    const HOT_SLOTS = 1 << 22;
    const HOT_MASK = HOT_SLOTS - 1;
    const hotCounts = wasmTier?.hotCounts.length === HOT_SLOTS
        ? wasmTier.hotCounts : new Uint8Array(HOT_SLOTS);
    // Whether translated code runs the wasm tier at a miss of the entry hash
    // (`interpretWith`): from the tier's first run on this host.
    let tierInstalled = false;
    /** Instructions either interpreter has retired, the wasm tier's runs from translated code
     * among them. */
    const interpretedSoFar = ()=>(interpreter?.retired ?? 0) + wasmRetired
        + (tierInstalled && wasmTier !== null ? wasmTier.entered() : 0);
    // The JavaScript interpreter's stretch before the wasm tier (WASM_AFTER).
    // It is the process's, not the host's: the tier's start is paid once a
    // process, so every host adds what it runs to the tier's one account, and
    // a host made once the tier has started runs it from the first
    // instruction. Once the stretch is spent the tier runs every range, and
    // `wasmSwitch` ends the range it ran out in.
    const wasmAfter = corkConfig?.wasmInterpreterAfter ?? WASM_AFTER;
    let wasmDue = wasmTier !== null && (wasmAfter <= 0 || wasmTier.started());
    let wasmSwitch = false;
    /** Counts one interpreted start and notes the address once it is hot.
     * @param {number} address
     */
    const countHot = address=>{
        const slot = (address >>> 2) & HOT_MASK;
        if (hotCounts[slot] === 0 && !wasmDue && wasmTier !== null)
        {
            wasmTier.stretch.work += NEW_TARGET_WORK;
            if (wasmTier.stretch.work >= wasmAfter)
            {
                wasmDue = true;
                wasmSwitch = true;
            }
        }
        // Saturating: past 255 a start is as hot as it gets.
        if (hotCounts[slot] < 255)
        {
            hotCounts[slot]++;
        }
        const count = hotCounts[slot];
        // Handed over at the threshold and again at every power of two after
        // it, each time with the count as its heat, so a candidate that keeps
        // running moves up the runtime's queue while it waits.
        if (count >= hotThreshold && (count & (count - 1)) === 0)
        {
            runtime.noteHot(address, x87Top(), count);
            // Under the slice feed the candidate is formed at the slice's end,
            // so leave the interpreter there rather than run the whole hot
            // body interpreted before the translator ever sees it. Under the
            // frame feed the slice does not end; the loop feeds in place.
            if (corkConfig?.feed === 'slice')
            {
                feedDue = true;
            }
            else
            {
                notedSinceFeed = true;
            }
        }
        // A candidate noted too soon after the last feed is fed once the
        // spacing allows, here at a later start: a tight loop is noted for the
        // last time on its 128th turn, and with no frame to feed it -- a
        // loader's long stretch -- it ran interpreted to its end.
        if (notedSinceFeed && interpretedSoFar() - retiredAtFeed >= FEED_MIN_STEPS)
        {
            translateDue = true;
        }
    };

    /** Fold the block's 32-bit counter word into the exact count. */
    const fold = ()=>{
        const word = blockView.getUint32(layout.counter, true) >>> 0;
        counted += (word - lastWord) >>> 0;
        lastWord = word;
    };

    /**
     * The fault record built from a `fault` exit. Cork-alone has no IDT, so
     * there is no frame the processor pushed to read: the record is the vector
     * the exit carries and the state the faulting instruction left.
     *
     * @param {number} vector
     * @returns {import('./faults.js').GuestFault}
     */
    const buildFault = vector=>{
        const at = eip();
        const name = exceptionName(vector);
        return {
            ...hostFault({
                vector,
                name,
                detail: `${name} at 0x${hex(at)}`,
                eip: at,
            }),
            cs: FLAT_CS,
            eflags: eflagsWord(),
        };
    };

    /**
     * A fault either tier raised. Offered first to the handler, with what a
     * handler needs that the emulator's ROM stub would have read off the
     * frame -- the faulting code's own stack and the two registers the stub
     * saves -- and, when the handler takes it, the machine goes on wherever
     * the handler has put eip. Either way the slice ends here, as the
     * emulator's fault stub ends it with a halt.
     *
     * @param {number} vector
     */
    const takeFault = vector=>{
        const fault = {
            ...buildFault(vector),
            stack: reg32[4] >>> 0,
            eax: reg32[0] >>> 0,
            edx: reg32[2] >>> 0,
        };
        if (faultHandler?.(fault) !== true)
        {
            lastFault = fault;
        }
        halted = true;
    };

    // Where the last run the interpreter stepped began, so a no-tier answer
    // names the instruction it actually met rather than the address the range
    // started at.
    let lastStart = 0;
    // The interpreter's hooks, one object for every range: where translated
    // code calls into a page left to the interpreter, a range is one run long,
    // and new closures and options for each were a tenth of the crossing.
    const hooks = {
        // Answered before each run of instructions: the runs the host owns the
        // far side of. A recorded trap has to leave so the handler can move
        // eip or stop the machine; an address with an entry is translated code
        // and a different register file.
        shouldStop: ()=>interpreter.trapped.length > 0 || feedDue || translateDue || hooks.once
            || wasmSwitch || runtime.entryOf(interpreter.eip, x87Top()) >= 0,
        onStep: (/** @type {number} */ at, /** @type {boolean} */ jumped)=>{
            lastStart = at;
            // Neither the park loop nor a slide through zero-filled memory
            // (add [eax], al, twice a step) is a path: the ring keeps the code
            // that led there.
            if (((at - parkBase) >>> 0) > 2 && (ram[at] !== 0 || ram[at + 1] !== 0))
            {
                noteStart(at);
            }
            if (jumped)
            {
                countHot(at);
            }
        },
        force: false,
        entered: false,
        asked: false,
        /** @type {boolean | undefined} set by the interpreter on return */
        jumped: false,
        // One run and no more: an instruction the wasm tier left, and the rest
        // of its run, before the wasm tier goes on.
        once: false,
    };
    /**
     * The interpreter tier over a whole budget: the decoder and evaluator run
     * over the block from `address` until it halts, faults, records a trap the
     * host must answer, or reaches an address the translator has an entry for
     * -- a boundary the interpreter must not cross, because translated code
     * carries its own register file. One `syncIn` and one `syncOut` bracket the
     * run rather than one per instruction, and each interpreted start is
     * counted for hotness, so a run of cold code costs a translation on its
     * second visit instead of a thousand syncs.
     *
     * A `Fault` from the evaluator builds the fault record and stops the
     * machine; an instruction the evaluator has no model for is this engine's
     * no-tier answer.
     *
     * With `force`, the first instruction runs whatever `shouldStop` answers:
     * the host forces one step when a turn would otherwise retire nothing.
     * `jumpedIn` says `address` is where a region's untranslated exit went: a
     * jump's target, counted for hotness like one the interpreter took itself.
     * Any other range starts where an earlier one stopped -- mid-block, at the
     * slice's end or at a feed -- and a start counted there became a region
     * entered in the middle of another's block, a different set each run.
     *
     * The JavaScript interpreter runs the process's first stretch
     * (`WASM_AFTER`) even where the wasm tier exists, a range cut where the
     * stretch ends.
     *
     * @param {number} address @param {number} budget @param {boolean} [force]
     * @param {boolean} [jumpedIn]
     * @returns {number}
     */
    const interpretRange = (address, budget, force = false, jumpedIn = false)=>{
        if (wasmTier === null || force)
        {
            return interpretJs(address, budget, force, jumpedIn, false);
        }
        if (!wasmDue)
        {
            const account = wasmTier.stretch;
            const left = wasmAfter - account.work;
            if (left > 0 && !wasmTier.started())
            {
                const retired = interpretJs(address, Math.min(budget, left), false, jumpedIn,
                    false);
                account.work += retired;
                return retired;
            }
            wasmDue = true;
        }
        wasmSwitch = false;
        return interpretWasm(wasmTier, address, budget, jumpedIn);
    };

    /**
     * The interpreter tier in wasm over a range, as `interpretRange` runs one:
     * it stops where the JavaScript interpreter would -- a hot start noted, a
     * start with an entry, a trap, a halt, a fault -- and hands each
     * instruction it leaves to the JavaScript interpreter for one run of it.
     *
     * @param {NonNullable<typeof wasmTier>} tier
     * @param {number} address @param {number} budget @param {boolean} jumpedIn
     * @returns {number}
     */
    const interpretWasm = (tier, address, budget, jumpedIn)=>{
        if (!tierInstalled)
        {
            // Started: an untranslated exit whose target has no region runs
            // the tier in place from now on, and goes on at the entry it stops
            // at without coming back here.
            tierInstalled = true;
            runtime.interpretWith?.(tier.entry(), tier.entered);
        }
        blockView.setUint32(layout.eip, address >>> 0, true);
        lastStart = address;
        if (jumpedIn)
        {
            countHot(address);
        }
        let retired = 0;
        let own = 0;
        // The first instruction runs whatever is due, as the JavaScript
        // interpreter's first run does: the jump that brought the range here
        // may have made its start hot and the feed due, and a range that
        // retired nothing would be a forced step.
        let first = true;
        try
        {
            while (retired < budget && (first || (!feedDue && !translateDue)))
            {
                const left = budget - retired;
                // A candidate is waiting: back after the feed's spacing, to feed it.
                const code = tier.run(first && (feedDue || translateDue) ? 1
                    : notedSinceFeed ? Math.min(left, FEED_MIN_STEPS) : left);
                first = false;
                const ran = tier.retired();
                retired += ran;
                own += ran;
                wasmRetired += ran;
                const at = eip();
                if (notedSinceFeed && interpretedSoFar() - retiredAtFeed >= FEED_MIN_STEPS)
                {
                    translateDue = true;
                }
                if (code === WasmExit.BUDGET || code === WasmExit.CODE_WRITE)
                {
                    if (code === WasmExit.CODE_WRITE)
                    {
                        invalidate(tier.exitValue(), tier.exitSize());
                    }
                    continue;
                }
                if (code === WasmExit.HOT || code === WasmExit.ENTRY)
                {
                    if (code === WasmExit.HOT)
                    {
                        runtime.noteHot(at, x87Top(), tier.exitValue());
                        if (corkConfig?.feed === 'slice')
                        {
                            feedDue = true;
                        }
                        else
                        {
                            notedSinceFeed = true;
                        }
                    }
                    if (runtime.entryOf(at, x87Top()) >= 0)
                    {
                        break;
                    }
                    continue;
                }
                if (code === WasmExit.TRAP)
                {
                    // After the port write, as the JavaScript interpreter raises it.
                    raiseTrap(tier.exitValue());
                    break;
                }
                if (code === WasmExit.HALT)
                {
                    halted = true;
                    break;
                }
                if (code === WasmExit.FAULT)
                {
                    takeFault(tier.exitValue());
                    break;
                }
                retired += interpretJs(at, left, false, false, true);
                if (halted || stopped || runtime.entryOf(eip(), x87Top()) >= 0)
                {
                    break;
                }
                // The run ended at a jump's target, which the JavaScript interpreter
                // counts when it goes on there: counted here, where the wasm tier does.
                if (hooks.jumped === true)
                {
                    noteStart(eip());
                    countHot(eip());
                }
            }
        }
        finally
        {
            // The wasm tier's instructions count in the block's word as the
            // JavaScript interpreter's do, a range that dies on a no-tier
            // instruction included.
            if (own > 0)
            {
                const word = blockView.getUint32(layout.counter, true);
                blockView.setUint32(layout.counter, (word + own) >>> 0, true);
            }
        }
        return retired;
    };

    /**
     * The JavaScript interpreter over a range; with `once`, one run of it.
     *
     * @param {number} address @param {number} budget @param {boolean} force
     * @param {boolean} jumpedIn @param {boolean} once
     * @returns {number}
     */
    const interpretJs = (address, budget, force, jumpedIn, once)=>{
        interpreter ??= blockState({
            memory,
            layout,
            rdtsc: readTsc,
            // An interpreted store into a page a region was translated on
            // invalidates it, as a translated store's `stale` exit does.
            onCodeWrite: (/** @type {number} */ at, /** @type {number} */ size)=>{
                invalidate(at, size);
            },
        });
        const state = interpreter;
        state.syncIn();
        state.eip = address;
        // A `hlt` on an earlier run left the block's halted flag set; a slice
        // the machine is awake for clears it, as the host's own flag is.
        state.halted = false;
        const before = state.retired;
        lastStart = address;
        /** @type {unknown} */
        let thrown = null;
        try
        {
            hooks.force = force;
            hooks.entered = jumpedIn;
            hooks.once = false;
            // The slice loop calls with no entry at the address and no feed
            // due, so only a trap still recorded -- one a fault cut the last
            // range short of raising -- leaves the first start's question open.
            hooks.asked = state.trapped.length === 0;
            if (once)
            {
                hooks.asked = true;
                hooks.once = true;
            }
            interpret(state, budget, hooks);
        }
        catch (e){
            const fault = /** @type {{ vector?: number, eip?: number }} */ (e);
            if (typeof fault.vector === 'number')
            {
                state.eip = fault.eip ?? address;
            }
            thrown = e;
        }
        const retired = state.retired - before;
        state.syncOut();
        // The interpreter's instructions count in the block's own word, so the
        // layer's instruction count and the translated share are over the whole
        // run rather than only over what the translator ran.
        if (retired > 0)
        {
            const word = blockView.getUint32(layout.counter, true);
            blockView.setUint32(layout.counter, (word + retired) >>> 0, true);
        }
        if (thrown !== null)
        {
            const fault = /** @type {{ vector?: number, eip?: number, op?: string }} */ (thrown);
            if (typeof fault.vector === 'number')
            {
                takeFault(fault.vector);
                return retired;
            }
            if (typeof fault.op === 'string')
            {
                const at = typeof fault.eip === 'number' ? fault.eip : lastStart;
                throw new Error(`cpu: cork has no tier for 0x${hex(ram[at] ?? 0, 2)}`
                    + ` (${fault.op}) (eip 0x${hex(at)})`, { cause: thrown });
            }
            throw thrown;
        }
        if (state.trapped.length > 0)
        {
            for (const value of state.trapped.splice(0))
            {
                raiseTrap(value);
            }
        }
        if (state.halted)
        {
            halted = true;
        }
        return retired;
    };

    /**
     * Runs at most `maxInstructions` and answers how many were retired.
     *
     * While the guest stands at an address the translator has an entry for, the
     * translator runs it with what remains of the budget; otherwise the
     * interpreter runs the budget's worth of cold code in one call (5.2) until
     * it meets translated code, a trap or a stop. A `fault` exit builds the
     * fault record and stops the machine; a `halt` puts the processor where a
     * `hlt` would; a `trap` exit re-looks-up wherever the handler left eip.
     *
     * @param {number} maxInstructions
     * @returns {number}
     */
    const runSlice = maxInstructions=>{
        const sliceAt = clock();
        stopped = false;
        feedDue = false;
        // A slice is the clock's tick. On the emulator a `hlt` holds the
        // processor until its timer interrupt, whose handler in the ROM only
        // returns, so the guest goes on at the instruction after the `hlt`
        // when the layer next runs it; this host has no timer, so being asked
        // to run is the tick, and a halt ends a slice, never the machine. A
        // fault's halt ends the same way: the layer has read the record and
        // decided where to run.
        halted = false;
        if (!entered)
        {
            setEip(whole.getUint32(ramOffset(entryVector), true));
        }
        let remaining = maxInstructions;
        let ran = 0;
        const startedAt = eip();
        const trapsBefore = trapCrossings;
        // What the slice spent on the interpreter, for a slow slice's account of
        // itself: the instructions it took and the time they cost.
        let interpreted = 0;
        let interpretMs = 0;
        // And on forming regions, which the call below does before it hands
        // the batch to the worker.
        let formMs = 0;
        // The last region left through an untranslated exit: `eip` is a jump's target.
        let jumpedIn = false;
        while (remaining > 0 && !isHalted() && !isStopped() && !isFeedDue())
        {
            if (translateDue)
            {
                // Form what the interpreter noted and carry on with the rest
                // of the budget: the slice's count is unchanged, so a loader
                // that never presents a frame still translates.
                translateDue = false;
                notedSinceFeed = false;
                retiredAtFeed = interpretedSoFar();
                const formAt = clock();
                runtime.translatePending().catch(()=>{});
                formMs += clock() - formAt;
            }
            const at = eip();
            const entry = runtime.entryOf(at, x87Top());
            if (entry >= 0)
            {
                const exit = runtime.run(entry, remaining);
                jumpedIn = exit.kind === 'untranslated';
                remaining -= exit.retired;
                ran += exit.retired;
                if (exit.kind === 'interpreted' && wasmTier !== null)
                {
                    // A miss ran the wasm tier in place, which stopped short of
                    // an entry: what it stopped for, answered as for a run of it
                    // here (`interpretWasm`); an instruction it leaves, the budget
                    // or an entry at another top go round the loop.
                    const code = exit.vector;
                    if (code === WasmExit.HALT)
                    {
                        halted = true;
                        break;
                    }
                    if (code === WasmExit.FAULT)
                    {
                        takeFault(wasmTier.exitValue());
                        break;
                    }
                    if (code === WasmExit.HOT)
                    {
                        runtime.noteHot(eip(), x87Top(), wasmTier.exitValue());
                        if (corkConfig?.feed === 'slice')
                        {
                            feedDue = true;
                        }
                        else
                        {
                            notedSinceFeed = true;
                        }
                    }
                    else if (code === WasmExit.CODE_WRITE)
                    {
                        invalidate(wasmTier.exitValue(), wasmTier.exitSize());
                    }
                    else if (code === WasmExit.TRAP)
                    {
                        raiseTrap(wasmTier.exitValue());
                    }
                    if (notedSinceFeed && interpretedSoFar() - retiredAtFeed >= FEED_MIN_STEPS)
                    {
                        translateDue = true;
                    }
                }
                if (exit.kind === 'halt')
                {
                    halted = true;
                    break;
                }
                if (exit.kind === 'fault')
                {
                    takeFault(exit.vector);
                    break;
                }
                if (exit.kind === 'trap')
                {
                    // A port write the region could not answer itself (x87
                    // held in its locals, or no trap import): it left past the
                    // write, and the handler runs here with the value it wrote.
                    raiseTrap(reg32[0]);
                    continue;
                }
                if (exit.kind === 'budget')
                {
                    break;
                }
                if (exit.retired === 0 && eip() === at)
                {
                    // The region at this (address, top) ran nothing -- it is
                    // compiled for another top, or leaves at its own entry.
                    // Force one interpreted instruction so the turn moves
                    // rather than spinning on the same entry.
                    const forced = interpretRange(at, remaining, true);
                    runtime.forcedStep();
                    remaining -= forced;
                    ran += forced;
                    if (forced === 0 && eip() === at)
                    {
                        break;
                    }
                }
                continue;
            }
            const interpretAt = clock();
            const stepped = interpretRange(at, remaining, false, jumpedIn);
            interpretMs += clock() - interpretAt;
            interpreted += stepped;
            jumpedIn = false;
            remaining -= stepped;
            ran += stepped;
            if (stepped === 0 && eip() === at)
            {
                // A budget of zero, or a first instruction that retired
                // nothing: force one instruction rather than spinning on it.
                const forced = interpretRange(at, remaining, true);
                runtime.forcedStep();
                remaining -= forced;
                ran += forced;
                if (forced === 0 && eip() === at)
                {
                    break;
                }
            }
        }
        fold();
        recent.push({ at: startedAt, end: eip(), retired: ran, traps: trapCrossings - trapsBefore,
            halted });
        // A slice is a few milliseconds; one of twenty holds a timer's thread,
        // and says what it spent them on.
        if (import.meta.BOTTLIFY_DIAGNOSTICS !== false && timings)
        {
            runtime.noteStall?.(`slice i${interpreted}/${Math.round(interpretMs)}ms`
                + ` f${Math.round(formMs)}ms t${ran - interpreted} h${trapCrossings - trapsBefore}`,
            sliceAt, 20);
        }
        if (recent.length > RECENT)
        {
            recent.shift();
        }
        return ran;
    };

    const fpu = {
        /** @param {number} value */
        setResult(value){
            const top = (block[layout.x87Top] - 1) & 7;
            const empty = block[layout.x87Empty];
            const held = (empty >>> top & 1) === 0;
            block[layout.x87Top] = top;
            block[layout.x87Empty] = empty & ~(1 << top);
            if (held)
            {
                const status = blockView.getUint16(layout.x87Status, true);
                blockView.setUint16(layout.x87Status, status | 0x201, true);
            }
            blockView.setFloat64(x87At(top), held ? -Infinity : value, true);
        },
        /** @param {number} index */
        get(index){
            return blockView.getFloat64(x87At(block[layout.x87Top] + index), true);
        },
        pop(){
            const top = block[layout.x87Top];
            block[layout.x87Empty] |= 1 << top;
            block[layout.x87Top] = (top + 1) & 7;
        },
        depth(){
            const empty = block[layout.x87Empty];
            let held = 0;
            for (let index = 0; index < 8; index++)
            {
                held += (empty >>> index & 1) === 0 ? 1 : 0;
            }
            return held;
        },
        controlWord: ()=>blockView.getUint16(layout.x87Control, true),
    };

    /** @type {Record<string, any>} */
    const host = {
        engine: ()=>'cork',
        /** The translator's runtime, for the layer's sampler and diagnostics. */
        cork: ()=>runtime,
        corkDiagnostics: ()=>(wasmTier === null ? runtime.diagnostics()
            : { ...runtime.diagnostics(), interpretedRelaxedReads: wasmTier.relaxedReads() }),

        /** Lets the machine run: slices until it halts or is stopped. */
        run(){
            stopped = false;
            while (!isHalted() && !isStopped())
            {
                const before = eip();
                const stepped = runSlice(1 << 20);
                if (feedDue)
                {
                    // A hot start was noted: form it before the next slice so
                    // the hot body is not interpreted whole ahead of it.
                    runtime.translatePending().catch(()=>{});
                }
                if (stepped === 0 && eip() === before && !feedDue)
                {
                    break;
                }
            }
        },
        stop(){
            stopped = true;
        },
        runSlice,

        /** One byte of guest memory, for the runtime's decoder. @param {number} address */
        readByte: address=>ram[address],
        /** Cork's own memory. */
        wasmMemory: ()=>memory,
        /** The eager flags word. */
        getEflags: eflagsWord,
        /** The x87 stack's top, for the runtime's entry lookup. */
        x87Top,
        /** Cork's own layout; the reserve is not carved from the guest's RAM. */
        stateLayout: ()=>layout,
        romBase: -1,
        romSize: 0,

        halt(){
            halted = true;
        },
        halted: ()=>halted,
        haltedFlag: ()=>(halted ? 1 : 0),
        /** @param {number} value */
        setHaltedFlag(value){
            halted = value !== 0;
        },
        wake(){
            halted = false;
        },
        /** Cork is always flat 32-bit protected mode: CR0 reads PE set.
         * @param {number} index
         */
        controlRegister: index=>(index === 0 ? 1 : 0),

        /** @param {(value: number) => void} handler */
        onTrap(handler){
            trapHandler = handler;
        },
        raiseTrap,

        /** @param {number} address @param {number} length @returns {Uint8Array} */
        readPhysical: (address, length)=>ram.subarray(address, address + length),
        /** @param {number} address */
        readU32: address=>whole.getUint32(ramOffset(address), true),
        /**
         * Dwords, signed, into an array: a host call's stack words in one call.
         *
         * @param {number} address @param {number} count @param {number[]} into @param {number} at
         */
        readU32sInto: (address, count, into, at)=>{
            const from = ramOffset(address);
            for (let word = 0; word < count; word++)
            {
                into[at + word] = whole.getInt32(from + word * 4, true);
            }
        },
        /** @param {number} address */
        readF32: address=>whole.getFloat32(ramOffset(address), true),

        /** @param {number} address @param {Uint8Array} bytes */
        writePhysical: (address, bytes)=>{
            hostWrites++;
            hostWrittenBytes += bytes.length;
            ram.set(bytes, address);
            invalidate(address, bytes.length);
        },
        /** @param {number} address @param {Uint8Array} bytes */
        writeData: (address, bytes)=>{
            hostWrites++;
            hostWrittenBytes += bytes.length;
            ram.set(bytes, address);
            invalidate(address, bytes.length);
        },
        /** @param {number} address @param {number} value @param {number} length */
        fillData: (address, value, length)=>{
            hostWrites++;
            hostWrittenBytes += length;
            ram.fill(value, address, address + length);
            invalidate(address, length);
        },

        /** @param {string} name @returns {number} */
        readReg32(name){
            if (name === 'eip')
            {
                return eip();
            }
            if (name === 'eflags')
            {
                return eflagsWord();
            }
            const index = REGISTERS.indexOf(name);
            if (index === -1)
            {
                throw new Error(`Unknown register "${name}"`);
            }
            return reg32[index] >>> 0;
        },
        /** @param {string} name @param {number} value */
        writeReg32(name, value){
            if (name === 'eip')
            {
                setEip(value);
                return;
            }
            if (name === 'eflags')
            {
                setEflags(blockView, layout, value);
                return;
            }
            const index = REGISTERS.indexOf(name);
            if (index === -1)
            {
                throw new Error(`Unknown register "${name}"`);
            }
            reg32[index] = value | 0;
        },

        /** The general registers in place, for the bridge's crossing. @returns {Int32Array} */
        registerFile: ()=>reg32,
        /** The state block, for the block-based context capture and the tests. */
        block: ()=>block,
        blockLayout: ()=>layout,
        /** The host-built fault record, or null. */
        fault: ()=>lastFault,
        /**
         * Offers each fault to `handler` before recording it: one it answers
         * true for is the handler's, and eip is wherever the handler left it.
         *
         * @param {(fault: import('./faults.js').GuestFault) => boolean} handler
         */
        onFault(handler){
            faultHandler = handler;
        },
        clearFault(){
            lastFault = null;
        },
        fpu: ()=>fpu,
        cpu(){
            throw new Error('cpu: cork has no emulator CPU object');
        },

        /** One XMM register's four lanes as u32 bit patterns. @param {number} index */
        readXmm: index=>Uint32Array.from(xmm.subarray(index * 4, index * 4 + 4)),
        /** @param {number} index @param {Uint32Array} words */
        writeXmm(index, words){
            xmm.set(Uint32Array.from(words, word=>word >>> 0), index * 4);
        },
        readMxcsr: ()=>blockView.getUint32(layout.mxcsr, true) >>> 0,
        /** @param {number} value */
        writeMxcsr(value){
            blockView.setUint32(layout.mxcsr, value >>> 0, true);
        },
        x87State(){
            const registers = new Float64Array(8);
            const raw = new Uint8Array(128);
            for (let index = 0; index < 8; index++)
            {
                const at = x87At(index);
                registers[index] = blockView.getFloat64(at, true);
                raw.set(block.subarray(at, at + 16), index * 16);
            }
            const top = x87Top();
            return {
                top,
                empty: block[layout.x87Empty],
                control: blockView.getUint16(layout.x87Control, true),
                status: (blockView.getUint16(layout.x87Status, true) & ~0x3800
                    | top << 11) & 0xffff,
                registers,
                raw,
            };
        },
        /**
         * @param {{ top: number, empty: number, control: number, status: number,
         *     raw: Uint8Array }} state
         */
        restoreX87State(state){
            block.set(state.raw, layout.x87);
            block[layout.x87Top] = state.top & 7;
            block[layout.x87Empty] = state.empty & 0xff;
            blockView.setUint16(layout.x87Control, state.control, true);
            blockView.setUint16(layout.x87Status, state.status & ~0x3800, true);
        },

        /** @returns {number} instructions retired since boot */
        instructionCount(){
            fold();
            return counted;
        },
        inProtectedMode: ()=>true,
        eip,
        trapCrossings: ()=>trapCrossings,
        /** The last thirty-two interpreted run starts (a jump's target, or where
         * straight-line code resumed) with their first bytes, oldest first, two
         * per string. */
        recentStarts: ()=>{
            const out = [];
            for (let i = 224; i < 256; i += 2)
            {
                const parts = [];
                for (let k = 0; k < 2; k++)
                {
                    const at = starts[(startIndex() + i + k) & 255] >>> 0;
                    let bytes = '';
                    for (let n = 0; n < 8; n++)
                    {
                        bytes += hex(ram[at + n] ?? 0, 2);
                    }
                    parts.push(`${hex(at)}:${bytes}`);
                }
                out.push(parts.join(' '));
            }
            return out;
        },
        /** The last slices as short strings, newest last. */
        recentSlices: ()=>recent.map(r=>`${hex(r.at)}->${hex(r.end)} r${r.retired} t${r.traps}`
            + (r.halted ? ' H' : '')),
        hostWrites: ()=>hostWrites,
        hostWrittenBytes: ()=>hostWrittenBytes,
        // Cork has no emulator JIT; the translator's own figures are in
        // corkDiagnostics(). -1 tells the layer's frame counter to skip the
        // emulator's JIT columns rather than read fields off a number.
        jitState: ()=>-1,
        jitCacheSize: ()=>0,
        compiledModules: ()=>runtime.counters().modules,
        interpretedSteps: ()=>0,
        instructionStats: ()=>null,
        profile: {
            available: ()=>false,
            start: ()=>false,
            stop(){},
            read: ()=>null,
        },
    };

    /**
     * Runs the time-stamp counter on the guest's clock from here on.
     *
     * @param {() => number} readMs  milliseconds of guest time
     */
    host.useGuestClock = readMs=>{
        guestClock = readMs;
    };
    host.captureContext = ()=>captureBlockContext(host);
    host.restoreContext = (/** @type {any} */ context)=>{
        restoreBlockContext(host, context);
        entered = true;
    };
    return host;
}
