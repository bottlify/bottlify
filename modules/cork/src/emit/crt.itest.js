/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of the C runtime operations (`crt.js`): seeded calls of each
 * operation run twice, the call made to the function's body and the call
 * formed as the operation (`helpers.js`), from the same state, and everything
 * a program can see compared -- the result, the memory around the arguments,
 * the callee-saved registers and esp, how the run ended. The functions are
 * this test's own, written to do what a runtime's do; their dictionary entries
 * are fingerprints of their bytes. Pages that are not plain (watched, holding
 * code, inaccessible), overlaps, empty spans and spans to RAM's end are among
 * the cases, where the operation makes the call as it was: the run that gets
 * -2 from `runProgram` (the block left before the call, nothing retired) goes
 * on with the call made, as the runtime's interpreter makes it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestMachine } from '../testing/machine.js';
import { fingerprint, maskedFingerprint, QUICK_BYTES } from '../helpers.js';
import { PageFlag } from '../runtime/pages.js';
import { formRegion } from '../region.js';

const PROGRAM = 0x8000;
const FUNCTION = 0x9000;
const OUT = 0xa000;
const DATA = 0x20000;
const DATA_BYTES = 0x6000;
const STACK = 0x80000;
const RAM = 1 << 20;

/** @param {number} value */
const u32 = value=>[value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255];
/** @param {number} at @param {number} target */
const rel = (at, target)=>u32((target - (at + 5)) >>> 0);

/** memmove as a runtime's: down where the destination is above an overlapping source. */
const MEMMOVE = [
    0x56, 0x57,                         // push esi; push edi
    0x8b, 0x7c, 0x24, 0x0c,             // mov edi, [esp+12]
    0x8b, 0x74, 0x24, 0x10,             // mov esi, [esp+16]
    0x8b, 0x4c, 0x24, 0x14,             // mov ecx, [esp+20]
    0x89, 0xf8,                         // mov eax, edi
    0x39, 0xf7,                         // cmp edi, esi
    0x76, 0x15,                         // jbe forward
    0x8d, 0x14, 0x0e,                   // lea edx, [esi+ecx]
    0x39, 0xd7,                         // cmp edi, edx
    0x73, 0x0e,                         // jae forward
    0x8d, 0x74, 0x0e, 0xff,             // lea esi, [esi+ecx-1]
    0x8d, 0x7c, 0x0f, 0xff,             // lea edi, [edi+ecx-1]
    0xfd, 0xf3, 0xa4, 0xfc,             // std; rep movsb; cld
    0xeb, 0x02,                         // jmp done
    0xf3, 0xa4,                         // forward: rep movsb
    0x5f, 0x5e, 0xc3,                   // done: pop edi; pop esi; ret
];

/** Functions doing what the runtime's do, cdecl. */
const FUNCTIONS = {
    memmove: MEMMOVE,
    memcpy: MEMMOVE,
    memset: [
        0x57,                               // push edi
        0x8b, 0x7c, 0x24, 0x08,             // mov edi, [esp+8]
        0x8b, 0x44, 0x24, 0x0c,             // mov eax, [esp+12]
        0x8b, 0x4c, 0x24, 0x10,             // mov ecx, [esp+16]
        0xf3, 0xaa,                         // rep stosb
        0x8b, 0x44, 0x24, 0x08,             // mov eax, [esp+8]
        0x5f, 0xc3,                         // pop edi; ret
    ],
    strlen: [
        0x8b, 0x44, 0x24, 0x04,             // mov eax, [esp+4]
        0x89, 0xc1,                         // mov ecx, eax
        0x80, 0x38, 0x00,                   // again: cmp byte [eax], 0
        0x74, 0x03,                         // je done
        0x40,                               // inc eax
        0xeb, 0xf8,                         // jmp again
        0x29, 0xc8,                         // done: sub eax, ecx
        0xc3,                               // ret
    ],
    sqrt: [
        0xdd, 0x44, 0x24, 0x04,             // fld qword [esp+4]
        0xd9, 0xfa,                         // fsqrt
        0xc3,                               // ret
    ],
};

/** The square root's body, as the dictionary's entries of a runtime's sqrt carry it. */
const SQRT_BODY = [
    0xf2, 0x0f, 0x10, 0x04, 0x24,           // movsd xmm0, [esp]
    0xf2, 0x0f, 0x51, 0xc0,                 // sqrtsd xmm0, xmm0
    0xf2, 0x0f, 0x11, 0x44, 0x24, 0xf8,     // movsd [esp-8], xmm0
    0xdd, 0x44, 0x24, 0xf8,                 // fld qword [esp-8]
];

/**
 * The dictionary's entry of one of `FUNCTIONS`: memset's by spans and masks
 * (its `ret` masked, a byte copies differ in), the others by their bytes.
 *
 * @param {keyof typeof FUNCTIONS} name
 * @returns {import('../helpers.js').RuntimeHelper}
 */
function entryOf(name){
    const bytes = FUNCTIONS[name];
    const read = (/** @type {number} */ at)=>bytes[at - FUNCTION] ?? 0;
    const body = name === 'sqrt' ? { body: SQRT_BODY } : {};
    if (name === 'memset')
    {
        const spans = [[0, bytes.length]];
        const masks = [bytes.length - 1];
        return { name, does: name, length: bytes.length, spans, masks,
            quick: maskedFingerprint(read, FUNCTION, [[0, QUICK_BYTES]], masks),
            hash: maskedFingerprint(read, FUNCTION, spans, masks) };
    }
    return { name, does: name, length: bytes.length,
        hash: fingerprint(read, FUNCTION, bytes.length), ...body };
}

/** A seeded generator (mulberry32). @param {number} seed */
function random(seed){
    let state = seed >>> 0;
    return ()=>{
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

/**
 * The program calling `name` with `args` (dwords pushed last first), its
 * result into OUT.
 *
 * @param {keyof typeof FUNCTIONS} name @param {number[]} args
 */
function programOf(name, args){
    const code = [];
    for (const arg of [...args].reverse())
    {
        code.push(0x68, ...u32(arg));        // push arg
    }
    code.push(0xe8, ...rel(PROGRAM + code.length, FUNCTION));
    code.push(0x83, 0xc4, 4 * args.length);  // add esp, 4n
    code.push(...name === 'sqrt'
        ? [0xdd, 0x1d, ...u32(OUT)]          // fstp qword [OUT]
        : [0xa3, ...u32(OUT)]);              // mov [OUT], eax
    code.push(0xf4);                         // hlt
    return code;
}

/**
 * A case: the arguments and the state around them.
 *
 * @typedef {{ name: keyof typeof FUNCTIONS, args: number[], data: Uint8Array,
 *     flags: [number, number, number][], regs: number[] }} Case
 */

/**
 * One case run with the operation (`helpers` its entry) or the body
 * (`helpers` false); a -2 where the operation made the call as it was goes
 * on with the call made.
 *
 * @param {Case} c @param {false | import('../helpers.js').RuntimeHelper[]} helpers
 */
function run(c, helpers){
    const m = createTestMachine({ ramSize: RAM });
    m.write(FUNCTION, FUNCTIONS[c.name]);
    m.write(PROGRAM, programOf(c.name, c.args));
    m.write(DATA, c.data);
    m.write(RAM - 0x1000, c.data.subarray(0, 0x1000));
    for (const [at, length, flag] of c.flags)
    {
        m.pages.markRange(at, length, flag);
    }
    ['ebx', 'ebp', 'esi', 'edi'].forEach((name, i)=>m.setReg(name, c.regs[i]));
    m.setReg('esp', STACK);
    let exit = m.runProgram(PROGRAM, { helpers });
    const leftBefore = exit.kind === -2;
    if (leftBefore)
    {
        exit = m.runProgram(exit.eip, { helpers: false });
    }
    return {
        kind: exit.kind, eip: m.eip(), leftBefore,
        out: [...m.read(OUT, 8)],
        data: [...m.read(DATA, DATA_BYTES)],
        end: [...m.read(RAM - 0x1000, 0x1000)],
        regs: ['ebx', 'ebp', 'esi', 'edi', 'esp'].map(name=>m.reg(name)),
        // A watched page's mark, which the host reads.
        pages: [...Array.from({ length: DATA_BYTES >>> 12 }, (unused, i)=>(DATA >>> 12) + i),
            (RAM >>> 12) - 1].map(page=>m.pages.get(page)),
    };
}

/**
 * Seeded cases of `name`.
 *
 * @param {keyof typeof FUNCTIONS} name @param {number} seed
 * @returns {Case}
 */
function caseOf(name, seed){
    const next = random(seed * 7919 + name.length);
    const int = (/** @type {number} */ n)=>Math.floor(next() * n);
    const data = new Uint8Array(DATA_BYTES).map(()=>int(256));
    const regs = [0, 1, 2, 3].map(()=>int(2 ** 32) >>> 0);
    /** @type {[number, number, number][]} */
    const flags = [];
    const shape = int(10);
    // Most spans within the data; some up to RAM's end, some empty, some long.
    const length = shape === 0 ? 0 : shape === 1 ? 0x1000 + int(0x1000) : int(600);
    const place = ()=>DATA + int(DATA_BYTES - length);
    let dst = place();
    let src = place();
    if (shape === 2)
    {
        src = dst + int(16) - 8;              // overlapping, either way
    }
    if (shape === 3)
    {
        dst = RAM - length;                   // up to RAM's end
    }
    const flagged = int(8);
    if (flagged === 0)
    {
        flags.push([dst + int(length + 1), 1, PageFlag.WATCH]);
    }
    else if (flagged === 1)
    {
        flags.push([dst + int(length + 1), 1, PageFlag.HAS_CODE]);
    }
    else if (flagged === 2 && name !== 'memset')
    {
        flags.push([src + int(length + 1), 1, PageFlag.INACCESSIBLE]);
    }
    if (name === 'strlen')
    {
        // A string of `length` bytes, its zero after them -- or none in the
        // data at all, the scan running on.
        data.forEach((byte, i)=>{
            data[i] = byte === 0 ? 1 : byte;
        });
        if (shape !== 4)
        {
            data[src - DATA + length] = 0;
        }
        return { name, args: [src], data, flags, regs };
    }
    if (name === 'sqrt')
    {
        const values = [0, -0, 1, 2, 0.25, 1e300, 1e-310, Infinity, -1, -Infinity, NaN,
            next() * 1e6, -next(), 2 ** 52 + int(1000)];
        const value = values[int(values.length)];
        const view = new DataView(new ArrayBuffer(8));
        view.setFloat64(0, value, true);
        return { name, args: [view.getUint32(0, true), view.getUint32(4, true)], data, flags,
            regs };
    }
    if (name === 'memset')
    {
        return { name, args: [dst, int(2 ** 32) >>> 0, length], data, flags, regs };
    }
    return { name, args: [dst, src, length], data, flags, regs };
}

for (const name of /** @type {(keyof typeof FUNCTIONS)[]} */ (
    ['memmove', 'memcpy', 'memset', 'strlen', 'sqrt']))
{
    test(`${name}: seeded calls answer the same made as the operation as through the body`, ()=>{
        const helpers = [entryOf(name)];
        let formed = 0;
        let made = 0;
        for (let seed = 1; seed <= 120; seed++)
        {
            const c = caseOf(name, seed);
            // An overlapping memcpy is made as the call it was; the body here is
            // memmove's, so either answers the same.
            const { leftBefore: bodyLeft, ...body } = run(c, false);
            assert.equal(bodyLeft, false);
            const { leftBefore, ...seen } = run(c, helpers);
            assert.deepEqual(seen, body,
                `seed ${seed}: ${JSON.stringify({ args: c.args, flags: c.flags })}`);
            if (leftBefore)
            {
                made++;
            }
            else
            {
                formed++;
            }
        }
        assert.ok(formed > 60, `${formed} calls formed as the operation`);
        assert.ok(made > 0, `${made} calls made as they were`);
    });
}

test('a call to a function that is not the dictionary\'s, by a byte, is made as it is', ()=>{
    const helpers = [entryOf('memmove')];
    for (const [bytes, formed] of /** @type {[number[], boolean][]} */ ([[MEMMOVE, true],
        [[...MEMMOVE.slice(0, -3), 0x90, 0x5e, 0xc3], false]]))
    {
        const m = createTestMachine({ ramSize: RAM });
        m.write(FUNCTION, bytes);
        m.write(PROGRAM, programOf('memmove', [DATA, DATA + 64, 16]));
        const read = (/** @type {number} */ at)=>m.read(at, 1)[0];
        const region = formRegion(read, PROGRAM, { helpers });
        assert.equal(region.blocks[0].exit.kind === 'call', !formed);
        assert.equal(region.blocks[0].instructions.some(one=>one.op === 'crt'), formed);
    }
});
