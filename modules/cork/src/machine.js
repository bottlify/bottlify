/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A machine of the translator's alone: flat 32-bit memory, the registers, and
 * the loop that hands the program between the interpreter and translated
 * regions -- for a caller that wants x86 code run in wasm with no operating
 * system under it.
 *
 * It is the smallest host the runtime has: the interpreter runs cold code and
 * counts the starts jumps reach, a start reached often enough is handed to the
 * translator, and once its region is in, the region runs it. What a program
 * asks of the world -- `int n`, the trap port, a fault -- stops the run and is
 * the caller's to answer, so a host of its own (a system call table, a
 * debugger) is a loop around `run`. The core's cpu layer is the other host,
 * with Win32 behind it; this one carries none of that.
 */

import { blockState, interpret } from './interp.js';
import { Fault, Unsupported } from './ir.js';
import { Tables, ownLayout, pagesFor, tablesSize } from './runtime/layout.js';
import { createCorkRuntime } from './runtime/runtime.js';
import { eflagsOf, setEflags } from './emit/flags.js';

/** The registers by name, in the state block's order. */
const REGS = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];

/** Jumps to one start before it is handed to the translator. */
const HOT_JUMPS = 50;
/** Instructions the interpreter runs at a time between looks at the translator. */
const INTERPRET_CHUNK = 1 << 16;
/** Instructions a region runs at a time, so a loop that never leaves still yields. */
const REGION_CHUNK = 1 << 24;

/**
 * Why a run ended: the program's `hlt`; an `int n` (eip past it, `vector` n); a
 * processor exception (eip at the instruction, `vector` its number); a write
 * to the trap port (`value` what it wrote); an instruction neither tier has a
 * model for; or the instructions the caller allowed.
 *
 * @typedef {Object} MachineStop
 * @property {'halt' | 'interrupt' | 'fault' | 'trap' | 'unsupported' | 'limit'} reason
 * @property {number} retired     instructions this run retired
 * @property {number} translated  of them, by translated code
 * @property {number} [vector]
 * @property {number} [value]
 * @property {string} [op]        the instruction the model has no case for
 */

/**
 * @param {{ ramSize?: number, config?: import('../../core/src/layers/cpu/engine.js').EngineConfig,
 *     trapPort?: number }} [options]
 *     `ramSize`: guest memory in bytes, a multiple of 64 KiB (default 16 MiB); `config`: the
 *     translator's (`EngineConfig`); `trapPort`: an I/O port whose `out` stops the run as a
 *     `trap` (default none: every `out` is one)
 */
export function createMachine({ ramSize = 16 << 20, config = {}, trapPort } = {}){
    const layout = ownLayout({ ramSize,
        ...(config.hashSlots === undefined ? {} : { hashSlots: config.hashSlots }) });
    const memory = new WebAssembly.Memory({ initial: pagesFor(layout,
        tablesSize(layout) + (config.blockProfile === true ? Tables.BLOCK_PROFILE_SIZE : 0)) });
    const view = ()=>new DataView(memory.buffer);
    const bytes = ()=>new Uint8Array(memory.buffer);
    // A processor as it comes out of reset: every x87 register empty, the
    // default control words.
    view().setUint8(layout.x87Empty, 0xff);
    view().setUint16(layout.x87Control, 0x37f, true);
    view().setUint32(layout.mxcsr, 0x1f80, true);
    setEflags(view(), layout, 0x2);
    const started = performance.now();
    const rdtsc = ()=>BigInt(Math.round((performance.now() - started) * 1e6));
    /** @type {number[]} */
    const trapped = [];
    const runtime = createCorkRuntime({
        memory, layout,
        // Formed after every run of the interpreter: there are no frames to pace it.
        config: { feed: 'slice', ...config, ...(trapPort === undefined ? {} : { trapPort }) },
        read: address=>bytes()[layout.ramBase + address],
        imports: {
            // A port write a region could not answer itself: the run stops past it.
            trap: value=>{
                trapped.push(value);
                return 1;
            },
            getEflags: ()=>view().getUint32(layout.eflags, true),
            x87Read: index=>view().getFloat64(layout.x87 + index * 16, true),
            rdtsc,
        },
    });
    const state = blockState({
        memory, layout, rdtsc,
        // An interpreted store into translated code drops the regions there,
        // as a translated store's `stale` exit does.
        onCodeWrite: (address, size)=>runtime.codeWritten(address, size),
        ...(trapPort === undefined ? {} : { ports: {
            trapPort, read: ()=>0xffffffff, write: ()=>{},
        } }),
    });
    /** Jumps seen to each start not yet translated. @type {Map<number, number>} */
    const heat = new Map();
    let noted = false;
    const eip = ()=>view().getUint32(layout.eip, true);
    const top = ()=>view().getUint8(layout.x87Top) & 7;

    /**
     * The interpreter from eip until it reaches translated code or spends `budget`.
     * @param {number} budget @param {boolean} force
     * @returns {{ retired: number, stop: Omit<MachineStop, 'retired' | 'translated'> | null }}
     */
    const interpretFrom = (budget, force)=>{
        state.syncIn();
        state.eip = eip();
        state.halted = false;
        const before = state.retired;
        /** @type {Omit<MachineStop, 'retired' | 'translated'> | null} */
        let stop = null;
        try
        {
            interpret(state, budget, {
                force, asked: true,
                // A start just noted hot ends the chunk too, so the translator
                // has it while the loop that made it hot still runs.
                shouldStop: ()=>noted || state.trapped.length > 0
                    || runtime.entryOf(state.eip, top()) >= 0,
                onStep: (start, jumped)=>{
                    if (!jumped)
                    {
                        return;
                    }
                    const seen = (heat.get(start) ?? 0) + 1;
                    heat.set(start, seen);
                    if (seen === HOT_JUMPS)
                    {
                        heat.delete(start);
                        runtime.noteHot(start, top(), seen);
                        noted = true;
                    }
                },
            });
        }
        catch (e){
            if (e instanceof Fault)
            {
                // `int n`, `int3` and `into` raise with eip past them, as the
                // processor pushes, and have retired; an exception leaves eip at
                // the instruction, which the model counted before it raised.
                state.eip = e.eip;
                const opcode = state.memory.read(state.faultEip, 1);
                const interrupt = e.eip === state.faultEip + (opcode === 0xcd ? 2 : 1)
                    && (opcode === 0xcd || opcode === 0xcc || opcode === 0xce);
                if (!interrupt && e.eip === state.faultEip)
                {
                    state.retired--;
                }
                stop = { reason: interrupt ? 'interrupt' : 'fault', vector: e.vector };
            }
            else if (e instanceof Unsupported)
            {
                state.eip = e.eip ?? state.faultEip;
                stop = { reason: 'unsupported', op: e.op };
            }
            else
            {
                throw e;
            }
        }
        const retired = state.retired - before;
        state.syncOut();
        if (stop === null && state.trapped.length > 0)
        {
            stop = { reason: 'trap', value: /** @type {number} */ (state.trapped.shift()) };
        }
        if (stop === null && state.halted)
        {
            stop = { reason: 'halt' };
        }
        return { retired, stop };
    };

    /**
     * Runs from eip until the program stops or `maxInstructions` are retired.
     * Awaits the translator between chunks, so a long run is translated as it goes.
     *
     * @param {{ maxInstructions?: number }} [options]
     * @returns {Promise<MachineStop>}
     */
    const run = async({ maxInstructions = Number.MAX_SAFE_INTEGER } = {})=>{
        let retired = 0;
        let translated = 0;
        /** @param {Omit<MachineStop, 'retired' | 'translated'>} stop @returns {MachineStop} */
        const ended = stop=>({ ...stop, retired, translated });
        while (retired < maxInstructions)
        {
            if (trapped.length > 0)
            {
                return ended({ reason: 'trap', value: /** @type {number} */ (trapped.shift()) });
            }
            if (noted)
            {
                noted = false;
                await runtime.translatePending();
            }
            const at = eip();
            const remaining = maxInstructions - retired;
            const entry = runtime.entryOf(at, top());
            if (entry >= 0)
            {
                const exit = runtime.run(entry, Math.min(remaining, REGION_CHUNK));
                retired += exit.retired;
                translated += exit.retired;
                if (exit.kind === 'halt')
                {
                    return ended({ reason: 'halt' });
                }
                if (exit.kind === 'fault')
                {
                    return ended({ reason: 'fault', vector: exit.vector });
                }
                if (exit.kind === 'trap')
                {
                    // Left past the port write with the value in eax.
                    return ended({ reason: 'trap', value: view().getUint32(layout.regs, true) });
                }
                if (exit.retired > 0 || eip() !== at)
                {
                    continue;
                }
                // The region ran nothing here (cut for another x87 top, or
                // leaving at its own entry): one instruction interpreted moves on.
            }
            const { retired: stepped, stop } = interpretFrom(Math.min(remaining, INTERPRET_CHUNK),
                entry >= 0);
            retired += stepped;
            if (stop !== null)
            {
                return ended(stop);
            }
        }
        return ended({ reason: 'limit' });
    };

    return {
        memory, layout, runtime, run,
        /** Copies bytes into guest memory. @param {number} address @param {ArrayLike<number>} data */
        load(address, data){
            bytes().set(data, layout.ramBase + address);
            runtime.codeWritten(address, data.length);
        },
        /** @param {number} address @param {number} length */
        read: (address, length)=>bytes().slice(layout.ramBase + address,
            layout.ramBase + address + length),
        /**
         * A register by name: the eight general ones, `eip`, `eflags`.
         * @param {string} name
         */
        reg(name){
            if (name === 'eip')
            {
                return eip();
            }
            if (name === 'eflags')
            {
                return eflagsOf(view(), layout) >>> 0;
            }
            const index = REGS.indexOf(name);
            if (index < 0)
            {
                throw new Error(`cork: no register ${name}`);
            }
            return view().getUint32(layout.regs + index * 4, true);
        },
        /** @param {string} name @param {number} value */
        setReg(name, value){
            if (name === 'eip')
            {
                view().setUint32(layout.eip, value >>> 0, true);
                return;
            }
            if (name === 'eflags')
            {
                setEflags(view(), layout, value >>> 0);
                return;
            }
            const index = REGS.indexOf(name);
            if (index < 0)
            {
                throw new Error(`cork: no register ${name}`);
            }
            view().setUint32(layout.regs + index * 4, value >>> 0, true);
        },
        diagnostics: ()=>runtime.diagnostics(),
        /** Ends the translation workers the runtime opened. */
        dispose: ()=>runtime.flush(),
    };
}
