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
 * faults.
 */

import { MODE_64, decode } from './decode/decoder.js';
import { BlockMemory } from './interp.js';
import { Fault, Unsupported } from './ir.js';
import { evaluate64, freshX87 } from './ir64.js';

const WINDOW = 1n << 32n;

/**
 * Long mode's view of the 32-bit tier's memory: BigInt addresses and values,
 * quadword and wider accesses as dwords, every part of one tested before any
 * is written, so a store that faults on its second page writes nothing.
 */
class WindowMemory {
    /** @param {BlockMemory} memory @param {{ faultEip: number }} owner */
    constructor(memory, owner){
        this.memory = memory;
        this.owner = owner;
    }

    /** @param {bigint} address @param {number} size */
    place(address, size){
        if (address + BigInt(size) > WINDOW)
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
 * A `State64` over cork's 64-bit state block.
 */
class BlockState64 {
    /**
     * @param {WebAssembly.Memory} memory
     * @param {import('../../core/src/layers/cpu/engine.js').StateLayout} layout
     * @param {((address: number, size: number) => void) | null} onCodeWrite
     * @param {(() => bigint) | undefined} rdtsc
     * @param {import('./ir64.js').State64['ports']} ports
     */
    constructor(memory, layout, onCodeWrite, rdtsc, ports){
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
        this.blockMemory = new BlockMemory(memory, layout, onCodeWrite, this);
        this.memory = new WindowMemory(this.blockMemory, this);
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
        for (let i = 0; i < 8; i++)
        {
            unit.f80[i] = view.getFloat64(layout.x87 + i * 16, true);
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
            view.setFloat64(layout.x87 + i * 16, unit.f80[i], true);
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
 * @param {{ memory: WebAssembly.Memory,
 *     layout: import('../../core/src/layers/cpu/engine.js').StateLayout,
 *     onCodeWrite?: (address: number, size: number) => void,
 *     rdtsc?: () => bigint, ports?: import('./ir64.js').State64['ports'] }} what
 */
export function blockState64({ memory, layout, onCodeWrite, rdtsc, ports }){
    return new BlockState64(memory, layout, onCodeWrite ?? null, rdtsc, ports);
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
    /** @param {number} address */
    const fetch = address=>{
        if (address >= 2 ** 32)
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
            evaluate64(instruction, state);
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
