/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The 64-bit model judged by the processor: every case of the hardware corpus
 * (`x64-corpus.json.gz`, made by `tools/x64-corpus.mjs`) decoded in long mode
 * and run on `evaluate64` from the same registers, flags and memory, then
 * compared with what the processor did -- the sixteen registers, the status
 * flags and DF, the sixteen XMM registers, every byte of memory that changed,
 * and a fault's kind and instruction with the registers as they stood before
 * it. MXCSR's exception flags are not modelled and not compared.
 *
 * A flag the architecture leaves undefined is not compared, and a case whose
 * later instruction reads one (a jump on OF after a multi-bit shift) is
 * skipped and counted: the model keeps such a flag where the processor
 * writes something of its own.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { AF, CF, DF, OF, PF, SF, ZF } from './decode/table.js';
import { MODE_64, decode } from './decode/decoder.js';
import { Fault } from './ir.js';
import { createState64, evaluate64 } from './ir64.js';

const CORPUS = JSON.parse(gunzipSync(readFileSync(new URL('./x64-corpus.json.gz', import.meta.url)))
    .toString('utf8'));
const COMPARED = CF | PF | AF | ZF | SF | OF | DF;
/** The signal each fault vector raises on Linux. */
const SIGNAL = /** @type {Record<number, number>} */ ({ 0: 8, 6: 4, 13: 11, 14: 11, 3: 5 });
const STEPS = 10000;

/**
 * The case's buffer, as the runner fills it: xorshift32 from the seed, the low
 * byte of each step.
 *
 * @param {number} seed
 */
function fill(seed, size = CORPUS.dataSize){
    const data = new Uint8Array(size);
    let x = seed >>> 0 || 1;
    for (let i = 0; i < data.length; i++)
    {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        x >>>= 0;
        data[i] = x & 0xff;
    }
    return data;
}

/**
 * The case's code area: its bytes, the runner's `jmp [rip + d]` to the exit's
 * address in the area's last eight bytes, zeros between. Those eight hold a
 * host address no case may read.
 *
 * @param {Uint8Array} code
 */
function codeArea(code){
    const area = new Uint8Array(CORPUS.codeSize - 8);
    area.set(code);
    const disp = CORPUS.codeSize - 8 - (code.length + 6);
    area.set([0xff, 0x25, disp & 0xff, disp >>> 8 & 0xff, disp >>> 16 & 0xff, disp >>> 24],
        code.length);
    return area;
}

/**
 * The memory a case sees: the data buffer read and written, the code area
 * read; anything else faults. An access is checked whole before any byte of it
 * is touched.
 *
 * @param {Uint8Array} data @param {Uint8Array} code
 * @returns {import('./ir64.js').Memory64}
 */
function caseMemory(data, code){
    const dataAt = BigInt(CORPUS.dataAt);
    const codeAt = BigInt(CORPUS.codeAt);
    /** @param {bigint} address @param {number} size @param {boolean} writing */
    const place = (address, size, writing)=>{
        const inData = address - dataAt;
        if (inData >= 0n && inData + BigInt(size) <= BigInt(data.length))
        {
            return { bytes: data, at: Number(inData) };
        }
        const inCode = address - codeAt;
        if (inCode >= 0n && inCode + BigInt(size) <= BigInt(code.length))
        {
            if (writing)
            {
                throw new Error(`a store into the code area at 0x${address.toString(16)}`);
            }
            return { bytes: code, at: Number(inCode) };
        }
        if (inCode >= 0n && inCode < BigInt(CORPUS.codeSize))
        {
            throw new Error(`a read of the runner's exit address at 0x${address.toString(16)}`);
        }
        throw new Fault(14, 0);
    };
    return {
        read(address, size){
            const { bytes, at } = place(address, size, false);
            let value = 0n;
            for (let i = size - 1; i >= 0; i--)
            {
                value = value << 8n | BigInt(bytes[at + i]);
            }
            return value;
        },
        write(address, size, value){
            const { bytes, at } = place(address, size, true);
            for (let i = 0; i < size; i++)
            {
                bytes[at + i] = Number(value >> BigInt(i * 8) & 0xffn);
            }
        },
    };
}

/** The string instructions, which a repeat with a zero count does not run. */
const STRINGS = new Set(['movs', 'stos', 'lods', 'cmps', 'scas']);
/** The shifts and rotates, which write no flag at a count of zero. */
const SHIFTS = new Set(['shl', 'sal', 'shr', 'sar', 'rol', 'ror', 'rcl', 'rcr', 'shld', 'shrd']);

/**
 * A shift's count as the processor masks it.
 *
 * @param {import('./decode/decoder.js').Instruction} instruction
 * @param {import('./ir64.js').State64} state
 */
function shiftCount(instruction, state){
    const operand = instruction.operands[instruction.operands.length - 1];
    const count = operand.kind === 'imm' ? /** @type {number} */ (operand.value) : Number(state.r[1] & 0xffn);
    return count & (instruction.size === 8 ? 63 : 31);
}

/**
 * Whether a repeated string instruction runs no element (and so compares
 * nothing and writes no flag): its count register is zero.
 *
 * @param {import('./decode/decoder.js').Instruction} instruction
 * @param {import('./ir64.js').State64} state
 */
function repeatsNone(instruction, state){
    const { prefixes, operands } = instruction;
    if (!STRINGS.has(instruction.op) || !prefixes.rep && !prefixes.repne)
    {
        return false;
    }
    const narrow = operands.some(operand=>operand.kind === 'mem' && operand.addressSize === 32);
    return (state.r[1] & (narrow ? 0xffffffffn : -1n)) === 0n;
}

/**
 * Runs one case on the model.
 *
 * @param {any} one
 * @returns {{ regs: string[], flags: number, xmm: Record<number, string>, signal: number,
 *     at?: number, writes: number[][], undefinedFlags: number } | { skipped: string }}
 */
function runCase(one){
    const code = Uint8Array.from(Buffer.from(one.code, 'hex'));
    const area = codeArea(code);
    const data = fill(one.seed);
    const before = data.slice();
    const state = createState64(caseMemory(data, area), { rip: BigInt(CORPUS.codeAt) });
    one.regs.forEach((/** @type {string} */ value, /** @type {number} */ i)=>{
        state.r[i] = BigInt(`0x${value}`);
    });
    state.rflags = one.flags | 0x200;
    state.xmm.set(new Uint32Array(fill(one.seed ^ CORPUS.xmmSeed, 256).buffer));
    const end = BigInt(CORPUS.codeAt + code.length);
    let undefinedFlags = 0;
    let signal = 0;
    /** @type {number | undefined} */
    let at;
    for (let step = 0; state.rip !== end; step++)
    {
        if (step === STEPS)
        {
            throw new Error('the case ran past its step limit');
        }
        const offset = Number(state.rip) - CORPUS.codeAt;
        const instruction = decode(address=>area[address - CORPUS.codeAt] ?? 0, Number(state.rip),
            MODE_64);
        if ('refused' in instruction)
        {
            const refusal = /** @type {{ invalid?: boolean, reason?: string }} */ (instruction);
            if (refusal.invalid)
            {
                signal = SIGNAL[6];
                at = offset;
                break;
            }
            throw new Error(`refused at +${offset}: ${refusal.reason}`);
        }
        if ((instruction.flagsRead & undefinedFlags) !== 0)
        {
            return { skipped: instruction.op };
        }
        const writesFlags = SHIFTS.has(instruction.op) ? shiftCount(instruction, state) !== 0
            : !repeatsNone(instruction, state);
        try
        {
            evaluate64(instruction, state);
        }
        catch (e){
            if (!(e instanceof Fault))
            {
                throw e;
            }
            signal = SIGNAL[e.vector];
            at = offset;
            break;
        }
        if (writesFlags)
        {
            const defined = instruction.flagsWritten & ~instruction.flagsUndefined;
            undefinedFlags = (undefinedFlags & ~defined | instruction.flagsUndefined) & COMPARED;
        }
    }
    /** @type {number[][]} */
    const writes = [];
    data.forEach((value, i)=>{
        if (value !== before[i])
        {
            writes.push([i, value]);
        }
    });
    /** @type {Record<number, string>} */
    const xmm = {};
    const start = fill(one.seed ^ CORPUS.xmmSeed, 256);
    const after = new Uint8Array(state.xmm.buffer);
    for (let i = 0; i < 16; i++)
    {
        const bytes = after.subarray(i * 16, i * 16 + 16);
        if (bytes.some((value, j)=>value !== start[i * 16 + j]))
        {
            xmm[i] = Buffer.from(bytes).toString('hex');
        }
    }
    return { regs: [...state.r].map(value=>value.toString(16)), flags: state.rflags, xmm, signal,
        ...at === undefined ? {} : { at }, writes, undefinedFlags };
}

test('the 64-bit model does what the processor did on every corpus case', ()=>{
    /** @type {string[]} */
    const failures = [];
    /** @type {Record<string, number>} */
    const skipped = {};
    let compared = 0;
    for (const one of CORPUS.cases)
    {
        /** @type {ReturnType<typeof runCase>} */
        let model;
        try
        {
            model = runCase(one);
        }
        catch (e){
            failures.push(`${one.text}: ${/** @type {Error} */ (e).message}`);
            continue;
        }
        if ('skipped' in model)
        {
            skipped[model.skipped] = (skipped[model.skipped] ?? 0) + 1;
            continue;
        }
        compared++;
        const out = one.out;
        /** @type {string[]} */
        const differences = [];
        if (model.signal !== out.signal || model.at !== out.at)
        {
            differences.push(`fault ${model.signal}@${model.at} vs ${out.signal}@${out.at}`);
        }
        model.regs.forEach((value, i)=>{
            if (value !== out.regs[i])
            {
                differences.push(`r${i} ${value} vs ${out.regs[i]}`);
            }
        });
        const mask = COMPARED & ~model.undefinedFlags;
        if ((model.flags & mask) !== (out.flags & mask))
        {
            differences.push(`flags 0x${(model.flags & mask).toString(16)}`
                + ` vs 0x${(out.flags & mask).toString(16)}`);
        }
        if (JSON.stringify(model.xmm) !== JSON.stringify(out.xmm))
        {
            differences.push(`xmm ${JSON.stringify(model.xmm)} vs ${JSON.stringify(out.xmm)}`);
        }
        if (JSON.stringify(model.writes) !== JSON.stringify(out.writes))
        {
            differences.push(`memory ${JSON.stringify(model.writes)}`
                + ` vs ${JSON.stringify(out.writes)}`);
        }
        if (differences.length > 0)
        {
            failures.push(`${one.text}: ${differences.join(', ')}`);
        }
    }
    const skips = Object.values(skipped).reduce((sum, count)=>sum + count, 0);
    assert.deepEqual(failures.slice(0, 20), [],
        `${failures.length} of ${CORPUS.cases.length} cases differ`);
    // A corpus mostly skipped would judge little.
    assert.ok(compared >= CORPUS.cases.length * 0.9,
        `only ${compared} cases compared`
        + ` (${skips} read undefined flags: ${JSON.stringify(skipped)})`);
});
