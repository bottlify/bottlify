/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The machine, as something a program can observe, in one record: taken from
 * any host through the cpu layer's accessors, restorable, and diffable.
 *
 * Test support for the differential harness: translated code is accepted
 * when it leaves the same record behind as the instruction model from the
 * same one. Nothing here runs in the product.
 *
 * What is compared, and what deliberately is not:
 *
 * - The eight general registers, EIP, and EFLAGS under a mask -- by default
 *   the six arithmetic flags, because the rest (IF, DF, the reserved bits)
 *   are either constant here or set by the caller.
 * - The x87 registers by *physical* index with the top and the empty mask,
 *   never by ST(n): two engines that agree on every value but disagree on
 *   where the top is have a bug, and ST(n) would hide it. Values are
 *   compared as f64 bit patterns, exactly, unless a caller names a tolerance
 *   in ulps.
 * - The control and status words, the latter under a mask a caller may
 *   narrow (the hardware fixtures do not record every bit).
 * - XMM by lane as u32 bit patterns (so a NaN payload counts), and MXCSR.
 * - The memory spans the record was taken with, dword by dword.
 */

/** CF, PF, AF, ZF, SF, OF: the flags an arithmetic instruction leaves. */
export const ARITH_MASK = 1 | 1 << 2 | 1 << 4 | 1 << 6 | 1 << 7 | 1 << 11;

const REGISTERS = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];

/**
 * @typedef {Object} X87State
 * @property {number} top
 * @property {number} empty        bit i set = physical register i is empty
 * @property {number} control
 * @property {number} status
 * @property {Float64Array} registers  physical order, as the host decodes them
 * @property {Uint8Array} raw          the host's own bytes for the eight registers
 */

/**
 * The host surface a snapshot needs. The cpu layer's cork host has every
 * one of these; a fake in a unit test needs only these.
 *
 * @typedef {Object} SnapshotHost
 * @property {(name: string) => number} readReg32
 * @property {(name: string, value: number) => void} writeReg32
 * @property {(address: number, length: number) => Uint8Array} readPhysical
 * @property {(address: number, bytes: Uint8Array) => void} writePhysical
 * @property {(index: number) => Uint32Array} readXmm
 * @property {(index: number, words: Uint32Array) => void} writeXmm
 * @property {() => number} readMxcsr
 * @property {(value: number) => void} writeMxcsr
 * @property {() => X87State} x87State
 * @property {(state: X87State) => void} restoreX87State
 */

/**
 * @typedef {Object} MachineState
 * @property {Uint32Array} reg32
 * @property {number} eip
 * @property {number} eflags
 * @property {X87State} x87
 * @property {Uint32Array} xmm     32 words, xmm0's low lane first
 * @property {number} mxcsr
 * @property {{ address: number, bytes: Uint8Array }[]} memory
 */

/**
 * @typedef {Object} Divergence
 * @property {string} name
 * @property {number | string} expected
 * @property {number | string} actual
 */

/**
 * Everything observable, copied out of the host.
 *
 * @param {SnapshotHost} host
 * @param {{ address: number, length: number }[]} spans
 * @returns {MachineState}
 */
export function snapshot(host, spans){
    const reg32 = new Uint32Array(8);
    REGISTERS.forEach((name, index)=>{
        reg32[index] = host.readReg32(name) >>> 0;
    });
    const xmm = new Uint32Array(32);
    for (let index = 0; index < 8; index++)
    {
        xmm.set(host.readXmm(index), index * 4);
    }
    const x87 = host.x87State();
    return {
        reg32,
        eip: host.readReg32('eip') >>> 0,
        eflags: host.readReg32('eflags') >>> 0,
        x87: {
            top: x87.top, empty: x87.empty, control: x87.control, status: x87.status,
            registers: Float64Array.from(x87.registers),
            raw: Uint8Array.from(x87.raw),
        },
        xmm,
        mxcsr: host.readMxcsr() >>> 0,
        // Copies: a host's window is its own memory and moves when the guest runs.
        memory: spans.map(({ address, length })=>({
            address, bytes: Uint8Array.from(host.readPhysical(address, length)),
        })),
    };
}

/**
 * Puts a record back, memory spans included.
 *
 * @param {SnapshotHost} host
 * @param {MachineState} state
 */
export function restore(host, state){
    REGISTERS.forEach((name, index)=>host.writeReg32(name, state.reg32[index] | 0));
    host.writeReg32('eip', state.eip | 0);
    host.writeReg32('eflags', state.eflags | 0);
    for (let index = 0; index < 8; index++)
    {
        host.writeXmm(index, state.xmm.subarray(index * 4, index * 4 + 4));
    }
    host.writeMxcsr(state.mxcsr);
    host.restoreX87State(state.x87);
    for (const { address, bytes } of state.memory)
    {
        host.writePhysical(address, bytes);
    }
}

const f64Bits = new DataView(new ArrayBuffer(8));

/** @param {number} value @returns {bigint} the value's bit pattern */
function bitsOf(value){
    f64Bits.setFloat64(0, value, true);
    return f64Bits.getBigUint64(0, true);
}

/**
 * How many representable doubles apart two values are, for a tolerance in
 * ulps. Infinite when they differ in sign or either is NaN, so a tolerance
 * never quietly accepts either.
 *
 * @param {number} a @param {number} b
 */
function ulpsApart(a, b){
    if (Number.isNaN(a) || Number.isNaN(b))
    {
        return Number.isNaN(a) && Number.isNaN(b) ? 0 : Infinity;
    }
    if (a === b)
    {
        return 0;
    }
    if (Math.sign(a) !== Math.sign(b))
    {
        return Infinity;
    }
    const distance = bitsOf(Math.abs(a)) - bitsOf(Math.abs(b));
    return Number(distance < 0n ? -distance : distance);
}

/**
 * What differs between two records: empty means the two agree.
 *
 * `a` is the expected side (the oracle), `b` the actual (the subject).
 *
 * @param {MachineState} a
 * @param {MachineState} b
 * @param {{ flagsMask?: number, statusMask?: number, x87Ulps?: number }} [options]
 * @returns {Divergence[]}
 */
export function compare(a, b, { flagsMask = ARITH_MASK, statusMask = 0xffff, x87Ulps = 0 } = {}){
    /** @type {Divergence[]} */
    const out = [];
    /** @param {string} name @param {number | string} expected @param {number | string} actual */
    const differ = (name, expected, actual)=>{
        if (expected !== actual)
        {
            out.push({ name, expected, actual });
        }
    };

    REGISTERS.forEach((name, index)=>differ(name, a.reg32[index], b.reg32[index]));
    differ('eip', a.eip, b.eip);
    differ('eflags', (a.eflags & flagsMask) >>> 0, (b.eflags & flagsMask) >>> 0);

    differ('x87.top', a.x87.top, b.x87.top);
    differ('x87.control', a.x87.control, b.x87.control);
    differ('x87.status', (a.x87.status & statusMask) >>> 0, (b.x87.status & statusMask) >>> 0);
    for (let index = 0; index < 8; index++)
    {
        const emptyA = (a.x87.empty >>> index & 1) === 1;
        const emptyB = (b.x87.empty >>> index & 1) === 1;
        if (emptyA !== emptyB)
        {
            out.push({
                name: `st${index}.empty`,
                expected: emptyA ? 'empty' : a.x87.registers[index],
                actual: emptyB ? 'empty' : b.x87.registers[index],
            });
            continue;
        }
        if (emptyA)
        {
            continue;
        }
        const left = a.x87.registers[index];
        const right = b.x87.registers[index];
        const same = x87Ulps === 0
            ? bitsOf(left) === bitsOf(right)
            : ulpsApart(left, right) <= x87Ulps;
        if (!same)
        {
            out.push({ name: `st${index}`, expected: left, actual: right });
        }
    }

    for (let word = 0; word < 32; word++)
    {
        differ(`xmm${word >> 2}[${word & 3}]`, a.xmm[word], b.xmm[word]);
    }
    differ('mxcsr', a.mxcsr, b.mxcsr);

    a.memory.forEach((span, which)=>{
        const other = b.memory[which];
        if (!other || other.address !== span.address || other.bytes.length !== span.bytes.length)
        {
            out.push({
                name: `memory[${which}]`,
                expected: `${span.bytes.length} bytes at 0x${span.address.toString(16)}`,
                actual: other
                    ? `${other.bytes.length} bytes at 0x${other.address.toString(16)}`
                    : 'absent',
            });
            return;
        }
        for (let at = 0; at < span.bytes.length; at++)
        {
            if (span.bytes[at] !== other.bytes[at])
            {
                // Named by the dword the byte falls in, once per dword: a
                // differing word reads as one finding, not four.
                const dword = at & ~3;
                const address = span.address + dword;
                differ(`mem[0x${address.toString(16)}]`,
                    readDword(span.bytes, dword), readDword(other.bytes, dword));
                at = dword + 3;
            }
        }
    });
    return out;
}

/** @param {Uint8Array} bytes @param {number} at */
function readDword(bytes, at){
    let value = 0;
    for (let byte = 3; byte >= 0; byte--)
    {
        value = value * 256 + (bytes[at + byte] ?? 0);
    }
    return value;
}
