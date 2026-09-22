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
 * runtime over the two. The slice loop is the translator's entry, or the
 * interpreter tier of 5.2 for what is not translated; in 5.1 the interpreter
 * is a stub that refuses, so a program with nothing translated yet fails loudly
 * rather than running silently.
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
    const { createEngine, ownLayout, pagesFor, Tables, STATE_BLOCK_SIZE } = engine;

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
    let halted = false;
    let stopped = false;
    // Read through these in a loop condition: `stopped` is set by `stop()` and
    // `halted` by a nested slice, which the static check cannot see.
    const isHalted = ()=>halted;
    const isStopped = ()=>stopped;
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
     * The interpreter tier (5.2). In 5.1 it refuses everything, so a program
     * with no translated entry fails loudly rather than running silently.
     *
     * @param {number} address  The guest address of the instruction to run.
     */
    const interpret = address=>{
        const opcode = ram[address] ?? 0;
        throw new Error(
            `cpu: cork has no tier for 0x${hex(opcode, 2)} (eip 0x${hex(address)})`);
    };

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
            rdtsc: ()=>0n,
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
     * One instruction on the interpreter tier. In 5.1 the tier refuses, so this
     * throws; 5.2 replaces it with the decoder and evaluator over the block.
     *
     * @param {number} address
     * @returns {number}
     */
    const interpretOne = address=>{
        interpret(address);
        return 0;
    };

    /**
     * Runs at most `maxInstructions` and answers how many were retired.
     *
     * While the guest stands at an address the translator has an entry for, the
     * translator runs it with what remains of the budget; otherwise the
     * interpreter runs one instruction (5.2) -- in 5.1 it refuses. A `fault`
     * exit builds the fault record and stops the machine; a `halt` puts the
     * processor where a `hlt` would; a `trap` exit re-looks-up wherever the
     * handler left eip.
     *
     * @param {number} maxInstructions
     * @returns {number}
     */
    const runSlice = maxInstructions=>{
        stopped = false;
        if (!entered)
        {
            setEip(whole.getUint32(ramOffset(entryVector), true));
        }
        let remaining = maxInstructions;
        let ran = 0;
        while (remaining > 0 && !isHalted() && !isStopped())
        {
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
                    break;
                }
                continue;
            }
            const stepped = interpretOne(at);
            remaining -= stepped;
            ran += stepped;
        }
        fold();
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
                if (stepped === 0 && eip() === before)
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
        // The zstd decoder of step 5.0 replaces the emulator's; it is not on
        // this step's path (a guest bundle read), so it is named until wired.
        decompressZstd(){
            throw new Error('cpu: cork-alone zstd decode waits on the step 5.0 decoder');
        },
    };

    host.captureContext = ()=>captureBlockContext(host);
    host.restoreContext = (/** @type {any} */ context)=>{
        restoreBlockContext(host, context);
        entered = true;
    };
    return host;
}
