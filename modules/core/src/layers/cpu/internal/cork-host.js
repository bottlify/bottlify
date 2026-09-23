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

/** The default x87 control word: double-extended precision, round to nearest. */
const DEFAULT_CONTROL_WORD = 0x037f;
/** The default MXCSR: every SIMD exception masked. */
const DEFAULT_MXCSR = 0x1f80;
/** eflags after boot: bit 1 is reserved and always set. */
const DEFAULT_EFLAGS = 0x2;
/** The flat 32-bit code selector the segments are implicit at. */
const FLAT_CS = 0x08;
/** The names an engine module must export for this host. */
const ENGINE_EXPORTS = Object.freeze([
    'createEngine', 'ownLayout', 'pagesFor', 'Tables', 'STATE_BLOCK_SIZE',
    'interpret', 'blockState',
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
    const { createEngine, ownLayout, pagesFor, Tables, STATE_BLOCK_SIZE, interpret, blockState }
        = engine;

    // The guest RAM is the whole memorySize; the tables and the state block are
    // memory of cork's own beside it, not carved out of the guest's the way the
    // hybrid carves the tables from the top of the emulator's RAM.
    const layout = ownLayout({ ramSize: memorySize });
    const pages = pagesFor(layout, Tables.SIZE);
    const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });

    // The memory is fixed (initial === maximum), so the buffer never detaches
    // and the views are taken once.
    const block = new Uint8Array(memory.buffer, 0, STATE_BLOCK_SIZE);
    const blockView = new DataView(memory.buffer, 0, STATE_BLOCK_SIZE);
    const reg32 = new Int32Array(memory.buffer, layout.regs, 8);
    const xmm = new Uint32Array(memory.buffer, layout.xmm, 32);
    const ram = new Uint8Array(memory.buffer, layout.ramBase, layout.ramSize);
    const whole = new DataView(memory.buffer);

    /** The eager flags word; cork's layout keeps no lazy part. */
    const eflagsWord = ()=>blockView.getUint32(layout.eflags, true) >>> 0;
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
    /** The last instruction starts the interpreter ran, a ring: the path a run
     * took into wherever it sits. */
    const starts = new Uint32Array(256);
    let startAt = 0;
    // The park loop (hlt; jmp at the thunk base) is where a thread waits, not
    // a path: its starts are left out so the ring keeps how the thread got there.
    const parkBase = (config.thunkBase ?? 0x100000) >>> 0;
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
    // Interpreted steps since the last in-slice feed, so a loader that meets a
    // new start every few instructions does not translate on every one.
    let stepsSinceFeed = 0;
    const FEED_MIN_STEPS = 2048;
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

    // Cork's own time-stamp counter: nanoseconds of the page's clock since the
    // host was made, monotonic, at the scale the emulator's counter has.
    const tscBase = performance.now();
    const readTsc = ()=>BigInt(Math.floor((performance.now() - tscBase) * 1e6));

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
    const hotCounts = new Uint8Array(HOT_SLOTS);
    /** Counts one interpreted start and notes the address once it is hot.
     * @param {number} address
     */
    const countHot = address=>{
        const slot = (address >>> 2) & HOT_MASK;
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
            else if (stepsSinceFeed >= FEED_MIN_STEPS)
            {
                translateDue = true;
            }
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
     *
     * @param {number} address @param {number} budget @param {boolean} [force]
     * @returns {number}
     */
    const interpretRange = (address, budget, force = false)=>{
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
        // Where the last instruction the interpreter stepped began, so a
        // no-tier answer names the instruction it actually met rather than the
        // address the range started at.
        let lastStart = address;
        /** @type {unknown} */
        let thrown = null;
        try
        {
            interpret(state, budget, {
                // Answered before each instruction: the runs the host owns the
                // far side of. A recorded trap has to leave so the handler can
                // move eip or stop the machine; an address with an entry is
                // translated code and a different register file.
                shouldStop: ()=>state.trapped.length > 0 || feedDue || translateDue
                    || runtime.entryOf(state.eip, x87Top()) >= 0,
                onStep: (/** @type {number} */ at)=>{
                    lastStart = at;
                    // Neither the park loop nor a slide through zero-filled
                    // memory (add [eax], al, twice a step) is a path: the ring
                    // keeps the code that led there.
                    if (((at - parkBase) >>> 0) > 2 && (ram[at] !== 0 || ram[at + 1] !== 0))
                    {
                        starts[startAt++ & 255] = at;
                    }
                    stepsSinceFeed++;
                    countHot(at);
                },
                force,
            });
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
                lastFault = buildFault(fault.vector);
                halted = true;
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
        for (const value of state.trapped.splice(0))
        {
            raiseTrap(value);
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
        while (remaining > 0 && !isHalted() && !isStopped() && !isFeedDue())
        {
            if (translateDue)
            {
                // Form what the interpreter noted and carry on with the rest
                // of the budget: the slice's count is unchanged, so a loader
                // that never presents a frame still translates.
                translateDue = false;
                stepsSinceFeed = 0;
                runtime.translatePending().catch(()=>{});
            }
            const at = eip();
            const entry = runtime.entryOf(at, x87Top());
            if (entry >= 0)
            {
                const exit = runtime.run(entry, remaining);
                remaining -= exit.retired;
                ran += exit.retired;
                if (exit.kind === 'halt')
                {
                    halted = true;
                    break;
                }
                if (exit.kind === 'fault')
                {
                    lastFault = buildFault(exit.vector);
                    halted = true;
                    break;
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
            const stepped = interpretRange(at, remaining);
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
        corkDiagnostics: ()=>runtime.diagnostics(),

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
                blockView.setUint32(layout.eflags, value >>> 0, true);
                return;
            }
            const index = REGISTERS.indexOf(name);
            if (index === -1)
            {
                throw new Error(`Unknown register "${name}"`);
            }
            reg32[index] = value | 0;
        },

        /** The state block, for the block-based context capture and the tests. */
        block: ()=>block,
        blockLayout: ()=>layout,
        /** The host-built fault record, or null. */
        fault: ()=>lastFault,
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
        /** The last thirty-two interpreted instruction starts with their first bytes,
         * oldest first, two per string. */
        recentStarts: ()=>{
            const out = [];
            for (let i = 224; i < 256; i += 2)
            {
                const parts = [];
                for (let k = 0; k < 2; k++)
                {
                    const at = starts[(startAt + i + k) & 255] >>> 0;
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
        compiledModules: ()=>runtime.diagnostics().modules,
        interpretedSteps: ()=>0,
        instructionStats: ()=>null,
        profile: {
            available: ()=>false,
            start: ()=>false,
            stop(){},
            read: ()=>null,
        },
    };

    host.captureContext = ()=>captureBlockContext(host);
    host.restoreContext = (/** @type {any} */ context)=>{
        restoreBlockContext(host, context);
        entered = true;
    };
    return host;
}
