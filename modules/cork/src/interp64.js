/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The interpreter tier for long mode: the 64-bit decoder and model
 * (`ir64.js`) run instruction by instruction over cork's 64-bit state block
 * (`ownLayout({ bits: 64 })`), as `interp.js` runs 32-bit code over the
 * 32-bit one. Slow -- every value a BigInt -- and the only tier long mode has
 * until the translator takes 64-bit code; what it leaves in the block is what
 * the translator will have to.
 *
 * The registers and the XMM registers are views of the block itself; RIP and
 * the flags word are the state's own between `syncIn` and `syncOut`. Memory
 * is the 32-bit tier's (`BlockMemory`): the same page flags, the same faults
 * with the address an access could not reach, the same notes of a store into
 * translated code. An address at or past 4 GiB lies outside the window and
 * faults; past 8 or 16 GiB in a wide layout, whose RAM is a memory of its own
 * (`WideMemory`).
 */

import { MODE_64, decode } from './decode/decoder.js';
import { BlockMemory } from './interp.js';
import { Fault, Unsupported } from './ir.js';
import { evaluate64, freshX87 } from './ir64.js';
import { WINDOW } from './runtime/layout.js';
import { WideMemory } from './wide-memory.js';

/**
 * Long mode's view of the 32-bit tier's memory: BigInt addresses and values,
 * quadword and wider accesses as dwords, every part of one tested before any
 * is written, so a store that faults on its second page writes nothing.
 */
class WindowMemory {
    /**
     * @param {BlockMemory | WideMemory} memory @param {{ faultEip: number }} owner
     * @param {number} window
     */
    constructor(memory, owner, window){
        this.memory = memory;
        this.owner = owner;
        this.window = BigInt(window);
    }

    /** @param {bigint} address @param {number} size */
    place(address, size){
        if (address + BigInt(size) > this.window)
        {
            throw new Fault(13, this.owner.faultEip);
        }
        return Number(address);
    }

    /** @param {bigint} address @param {number} size @returns {bigint} */
    read(address, size){
        const at = this.place(address, size);
        if (size <= 4)
        {
            return BigInt(this.memory.read(at, size) >>> 0);
        }
        // The last dword first: a read across into a closed page faults before
        // the value is put together.
        let value = 0n;
        for (let offset = size - 4; offset >= 0; offset -= 4)
        {
            value = value << 32n | BigInt(this.memory.read(at + offset, 4) >>> 0);
        }
        return value;
    }

    /** @param {bigint} address @param {number} size @param {bigint} value */
    write(address, size, value){
        const at = this.place(address, size);
        if (size <= 4)
        {
            this.memory.write(at, size, Number(value & 0xffffffffn));
            return;
        }
        // Every page the store reaches is tested before a byte of it lands.
        if (this.memory.inaccessible(at, size))
        {
            throw this.memory.fault(at, size, true);
        }
        for (let offset = 0; offset < size; offset += 4)
        {
            this.memory.write(at + offset, 4, Number(value >> BigInt(offset * 8) & 0xffffffffn));
        }
    }
}

/**
 * Whether the instruction is one the atomic variant makes indivisible: a
 * `lock` prefix on a memory form, or `xchg` with a memory operand. Not
 * `cmpxchg16b`: no host access swaps sixteen bytes at once, and it runs plain
 * holding the process's lock word (`BlockMemory.held`).
 *
 * @param {import('./decode/decoder.js').Instruction} instruction
 */
const isLocked = instruction=>instruction.memory === true && instruction.op !== 'cmpxchg16b'
    && (instruction.prefixes.lock === true || instruction.op === 'xchg');

/**
 * The memory a locked instruction's one attempt sees (`evaluateLocked`): its
 * operand read as one load, the value it would store kept for the swap.
 */
class LockedAccess64 {
    /** @param {WindowMemory} memory */
    constructor(memory){
        this.memory = memory;
        this.address = -1n;
        this.size = 0;
        this.old = 0n;
        this.value = 0n;
        this.wrote = false;
    }

    /** @param {bigint} address @param {number} size @returns {bigint} */
    read(address, size){
        if (this.address < 0n && size <= 8)
        {
            const at = this.memory.place(address, size);
            const block = /** @type {BlockMemory} */ (this.memory.memory);
            this.address = address;
            this.size = size;
            this.old = size === 8 ? block.loadQword(at) : BigInt(block.loadLocked(at, size) >>> 0);
            return this.old;
        }
        return address === this.address && size === this.size ? this.old
            : this.memory.read(address, size);
    }

    /** @param {bigint} address @param {number} size @param {bigint} value */
    write(address, size, value){
        if (address === this.address && size === this.size)
        {
            this.value = value;
            this.wrote = true;
            return;
        }
        this.memory.write(address, size, value);
    }

    /** Whether memory still held what the attempt read, the value it made now there. */
    swap(){
        if (this.address < 0n)
        {
            return true;
        }
        const at = Number(this.address);
        const block = /** @type {BlockMemory} */ (this.memory.memory);
        const next = this.wrote ? this.value : this.old;
        return this.size === 8
            ? block.exchangeQword(at, this.old, BigInt.asUintN(64, next)) === this.old
            : block.exchangeLocked(at, this.size, Number(this.old), Number(next & 0xffffffffn));
    }
}

/**
 * A locked instruction in the atomic variant, as the 32-bit tier's
 * (`lockedStep`): the model run over the value memory holds, its result
 * swapped in only if memory still holds that, and the instruction again -
 * registers and flags as they were - if another executor's store came between.
 *
 * @param {import('./decode/decoder.js').Instruction} instruction
 * @param {BlockState64} state
 */
function evaluateLocked(instruction, state){
    const memory = state.memory;
    const registers = state.r.slice();
    const { rip, rflags, retired } = state;
    for (;;)
    {
        const access = new LockedAccess64(memory);
        state.memory = /** @type {any} */ (access);
        try
        {
            evaluate64(instruction, state);
        }
        finally
        {
            state.memory = memory;
        }
        if (access.swap())
        {
            return;
        }
        state.r.set(registers);
        state.rip = rip;
        state.rflags = rflags;
        state.retired = retired;
    }
}

/**
 * A `State64` over cork's 64-bit state block.
 */
class BlockState64 {
    /**
     * @param {WebAssembly.Memory} memory
     * @param {import('../../core/src/layers/cpu/engine.js').StateLayout} layout
     * @param {((address: number, size: number) => void) | null} onCodeWrite
     * @param {(() => bigint) | undefined} rdtsc
     * @param {import('./ir64.js').State64['ports']} ports
     * @param {WebAssembly.Memory} [ram]  a wide layout's RAM (`ramMemory`)
     */
    constructor(memory, layout, onCodeWrite, rdtsc, ports, ram){
        if (layout.bits !== 64)
        {
            throw new Error('cork: the long-mode interpreter runs over a 64-bit layout');
        }
        this.view = new DataView(memory.buffer);
        this.layout = layout;
        this.r = new BigUint64Array(memory.buffer, layout.regs, 16);
        this.xmm = new Uint32Array(memory.buffer, layout.xmm, 64);
        this.rip = this.view.getBigUint64(layout.eip, true);
        this.rflags = this.view.getUint32(layout.eflags, true);
        this.faultEip = 0;
        if (layout.ramMemory !== undefined && ram === undefined)
        {
            throw new Error('cork: a wide layout\'s state is given its RAM\'s memory');
        }
        this.blockMemory = ram === undefined ? new BlockMemory(memory, layout, onCodeWrite, this)
            : new WideMemory(memory, ram, layout, onCodeWrite, this);
        this.window = layout.window ?? WINDOW;
        this.memory = new WindowMemory(this.blockMemory, this, this.window);
        this.halted = false;
        this.retired = 0;
        /** @type {number[]} */
        this.trapped = [];
        this.rdtsc = rdtsc;
        this.ports = ports;
        /** @type {number | undefined} the processor `cpuid` names */
        this.processor = undefined;
    }

    get mxcsr(){
        return this.view.getUint32(this.layout.mxcsr, true);
    }

    set mxcsr(value){
        this.view.setUint32(this.layout.mxcsr, value >>> 0, true);
    }

    get fsBase(){
        return this.view.getBigUint64(this.layout.fsBase, true);
    }

    /**
     * The x87 unit as the block holds it, as the 32-bit block does: a double
     * every sixteen bytes, the quadword a `fild` left exact beside it, and the
     * words past the registers.
     *
     * @returns {import('./ir64.js').X87State}
     */
    loadX87(){
        const { view, layout } = this;
        const unit = freshX87();
        // As bits: a register MMX wrote holds a quadword, not a double, and the
        // language leaves the bits of a NaN read as a float to the engine.
        for (let i = 0; i < 8; i++)
        {
            unit.f80bits[i] = view.getBigInt64(layout.x87 + i * 16, true);
        }
        unit.top = view.getUint8(layout.x87Top) & 7;
        unit.empty = view.getUint8(layout.x87Empty);
        unit.control = view.getUint16(layout.x87Control, true);
        unit.status = view.getUint16(layout.x87Status, true);
        // The 64-bit layout always has the place (`longLayout`).
        unit.x87Exact = view.getUint8(/** @type {number} */ (layout.x87Exact));
        for (let i = 0; i < 8; i++)
        {
            if ((unit.x87Exact >>> i & 1) !== 0)
            {
                unit.x87Shadow[i] = view.getBigInt64(layout.x87 + i * 16 + 8, true);
            }
        }
        return unit;
    }

    /** @param {import('./ir64.js').X87State} unit */
    storeX87(unit){
        const { view, layout } = this;
        for (let i = 0; i < 8; i++)
        {
            view.setBigInt64(layout.x87 + i * 16, unit.f80bits[i], true);
            if ((unit.x87Exact >>> i & 1) !== 0)
            {
                view.setBigInt64(layout.x87 + i * 16 + 8, unit.x87Shadow[i], true);
            }
        }
        view.setUint8(layout.x87Top, unit.top & 7);
        view.setUint8(layout.x87Empty, unit.empty & 0xff);
        view.setUint16(layout.x87Control, unit.control & 0xffff, true);
        view.setUint16(layout.x87Status, unit.status & 0xffff, true);
        view.setUint8(/** @type {number} */ (layout.x87Exact), unit.x87Exact & 0xff);
    }

    get gsBase(){
        return this.view.getBigUint64(this.layout.gsBase, true);
    }

    /** RIP as a number, for a host that keeps addresses as numbers (the window's). */
    get eip(){
        return Number(this.rip);
    }

    set eip(value){
        this.rip = BigInt(value);
    }

    /** Takes RIP and the flags word from the block. */
    syncIn(){
        this.rip = this.view.getBigUint64(this.layout.eip, true);
        this.rflags = this.view.getUint32(this.layout.eflags, true);
    }

    /** Writes them back. */
    syncOut(){
        this.view.setBigUint64(this.layout.eip, BigInt.asUintN(64, this.rip), true);
        this.view.setUint32(this.layout.eflags, this.rflags >>> 0, true);
    }
}

/**
 * A long-mode state over cork's 64-bit state block (`blockState` for 64 bits).
 *
 * @param {{ memory: WebAssembly.Memory, ram?: WebAssembly.Memory,
 *     layout: import('../../core/src/layers/cpu/engine.js').StateLayout,
 *     onCodeWrite?: (address: number, size: number) => void,
 *     rdtsc?: () => bigint, ports?: import('./ir64.js').State64['ports'],
 *     readThrough?: [number, number][], atomic?: boolean }} what
 *     `readThrough` and `atomic` as `blockState`'s
 */
export function blockState64(what){
    const { memory, ram, layout, onCodeWrite, rdtsc, ports,
        readThrough = [], atomic = false } = what;
    const state = new BlockState64(memory, layout, onCodeWrite ?? null, rdtsc, ports, ram);
    if (state.blockMemory instanceof BlockMemory)
    {
        state.blockMemory.atomic = atomic;
    }
    state.blockMemory.readThrough = readThrough;
    return state;
}

/**
 * Runs up to `budget` instructions of long-mode code from the state's RIP and
 * answers how many it retired. It stops early after an instruction that
 * wrote the trap port (the host answers it), at a `hlt`, or where
 * `options.shouldStop` says so before a run of instructions -- the first, and
 * each one a jump began; `options.onStep` hears each run's start and whether a
 * jump led there. A fault or an instruction the model has no case for is
 * thrown, RIP left at the instruction.
 *
 * @param {BlockState64} state
 * @param {number} budget
 * @param {{ shouldStop?: () => boolean, onStep?: (at: number, jumped: boolean) => void,
 *     force?: boolean, jumped?: boolean }} [options]
 */
export function interpret64(state, budget, options = {}){
    const before = state.retired;
    const memory = state.blockMemory;
    // A growing memory may have grown since the last run (`fit`): a page the
    // host opened past where the memory ended is read through the views of now.
    /** @type {any} */ (memory).fit?.();
    /** @param {number} address */
    const fetch = address=>{
        if (address >= state.window)
        {
            throw new Fault(14, Number(state.rip));
        }
        return memory.read(address, 1);
    };
    let jumped = false;
    let first = true;
    let runStart = true;
    try
    {
        while (state.retired - before < budget && !state.halted)
        {
            const at = Number(state.rip);
            if (runStart)
            {
                if (!(first && options.force) && options.shouldStop?.())
                {
                    break;
                }
                options.onStep?.(at, jumped);
            }
            first = false;
            state.faultEip = at;
            const instruction = decode(fetch, at, MODE_64);
            if ('refused' in instruction)
            {
                if (instruction.invalid)
                {
                    throw new Fault(6, at);
                }
                throw new Unsupported(instruction.reason, at);
            }
            const fallthrough = at + instruction.length;
            if (/** @type {{ atomic?: boolean }} */ (memory).atomic === true
                && isLocked(instruction))
            {
                evaluateLocked(instruction, state);
            }
            else if (instruction.op === 'cmpxchg16b' && instruction.prefixes.lock === true
                && state.blockMemory instanceof BlockMemory)
            {
                state.blockMemory.held(()=>evaluate64(instruction, state));
            }
            else
            {
                evaluate64(instruction, state);
            }
            jumped = Number(state.rip) !== fallthrough;
            runStart = jumped;
            if (state.trapped.length > 0)
            {
                break;
            }
        }
    }
    finally
    {
        options.jumped = jumped;
    }
    return state.retired - before;
}
