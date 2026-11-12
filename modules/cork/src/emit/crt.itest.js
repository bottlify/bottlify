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
import { CRT_BODIES, CRT_DICTIONARY } from '../crt-dictionary.js';

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
    memcmp: [
        0x56, 0x57,                         // push esi; push edi
        0x8b, 0x74, 0x24, 0x0c,             // mov esi, [esp+12]
        0x8b, 0x7c, 0x24, 0x10,             // mov edi, [esp+16]
        0x8b, 0x4c, 0x24, 0x14,             // mov ecx, [esp+20]
        0x31, 0xc0,                         // xor eax, eax
        0x85, 0xc9, 0x74, 0x09,             // test ecx, ecx; jz done
        0xf3, 0xa6, 0x74, 0x05,             // repe cmpsb; je done
        0x19, 0xc0, 0x83, 0xc8, 0x01,       // sbb eax, eax; or eax, 1
        0x5f, 0x5e, 0xc3,                   // done: pop edi; pop esi; ret
    ],
    strcmp: [
        0x8b, 0x4c, 0x24, 0x04,             // mov ecx, [esp+4]
        0x8b, 0x54, 0x24, 0x08,             // mov edx, [esp+8]
        0x8a, 0x01, 0x3a, 0x02,             // again: mov al, [ecx]; cmp al, [edx]
        0x75, 0x08,                         // jne apart
        0x84, 0xc0, 0x74, 0x0a,             // test al, al; jz same
        0x41, 0x42, 0xeb, 0xf2,             // inc ecx; inc edx; jmp again
        0x19, 0xc0, 0x83, 0xc8, 0x01, 0xc3, // apart: sbb eax, eax; or eax, 1; ret
        0x31, 0xc0, 0xc3,                   // same: xor eax, eax; ret
    ],
    memchr: [
        0x8b, 0x44, 0x24, 0x04,             // mov eax, [esp+4]
        0x8b, 0x54, 0x24, 0x08,             // mov edx, [esp+8]
        0x8b, 0x4c, 0x24, 0x0c,             // mov ecx, [esp+12]
        0x85, 0xc9, 0x74, 0x08,             // again: test ecx, ecx; jz none
        0x38, 0x10, 0x74, 0x06,             // cmp [eax], dl; je found
        0x40, 0x49, 0xeb, 0xf4,             // inc eax; dec ecx; jmp again
        0x31, 0xc0, 0xc3,                   // none: xor eax, eax; found: ret
    ],
    strchr: [
        0x8b, 0x44, 0x24, 0x04,             // mov eax, [esp+4]
        0x8b, 0x54, 0x24, 0x08,             // mov edx, [esp+8]
        0x8a, 0x08, 0x38, 0xd1,             // again: mov cl, [eax]; cmp cl, dl
        0x74, 0x09,                         // je found
        0x84, 0xc9, 0x74, 0x03,             // test cl, cl; jz none
        0x40, 0xeb, 0xf3,                   // inc eax; jmp again
        0x31, 0xc0, 0xc3,                   // none: xor eax, eax; found: ret
    ],
};


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
    const body = name === 'sqrt' ? { body: CRT_BODIES.sqrt } : {};
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
        // Code is marked as translation marks it: the page and its granules.
        if (flag === PageFlag.HAS_CODE)
        {
            m.pages.markCode(at, length);
        }
        else
        {
            m.pages.markRange(at, length, flag);
        }
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
    else if (flagged === 3 && shape !== 3)
    {
        // Code on a page of the destination but in a granule it does not
        // reach: the store is made in place.
        flags.push([dst + length + 32 + int(64), 1, PageFlag.HAS_CODE]);
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
    if (name === 'memcmp' || name === 'strcmp' || name === 'memchr' || name === 'strchr')
    {
        return { name, args: scanArgs(name, data, int, Math.min(length, DATA_BYTES / 2 - 1),
            dst, Math.max(DATA, Math.min(src, DATA + DATA_BYTES - length - 1))), data, flags,
        regs };
    }
    return { name, args: [dst, src, length], data, flags, regs };
}

/**
 * A comparison's or search's arguments, the data made for it: two spans equal
 * up to a seeded first difference (or wholly), a string's zero after `length`
 * bytes, the byte sought in the span, its zero, or neither.
 *
 * @param {string} name @param {Uint8Array} data @param {(n: number) => number} int
 * @param {number} length @param {number} dst @param {number} src
 */
function scanArgs(name, data, int, length, dst, src){
    if (name === 'strcmp' || name === 'strchr')
    {
        data.forEach((v, i)=>{
            data[i] = v === 0 ? 1 : v;
        });
    }
    if (name === 'memchr' || name === 'strchr')
    {
        const sought = [data[src - DATA + int(length + 1)], 0, int(256), data[src - DATA]][int(4)];
        if (name === 'strchr')
        {
            data[src - DATA + length] = 0;
            return [src, sought | int(2) * 0x3400];
        }
        return [src, sought | int(2) * 0x1200, length];
    }
    const apart = Math.abs(dst - src) >= length;
    const k = int(length + 1);
    if (apart)
    {
        data.copyWithin(dst - DATA, src - DATA, src - DATA + k);
        if (k < length && int(2) === 0)
        {
            data[dst - DATA + k] = data[src - DATA + k] ^ 1 << int(8);
        }
    }
    if (name === 'strcmp')
    {
        data[src - DATA + length] = 0;
        if (apart && k === length)
        {
            data[dst - DATA + length] = int(2) === 0 ? 0 : 1 + int(255);
        }
        return [dst, src];
    }
    return [dst, src, length];
}

for (const name of /** @type {(keyof typeof FUNCTIONS)[]} */ (
    ['memmove', 'memcpy', 'memset', 'strlen', 'sqrt', 'memcmp', 'strcmp', 'memchr', 'strchr']))
{
    test(`${name}: seeded calls answer the same made as the operation as through the body`, ()=>{
        const helpers = [entryOf(name)];
        let formed = 0;
        let made = 0;
        let watched = 0;
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
                // A store into a watched page, or a page of code away from it,
                // made in place.
                const [dst, , length] = c.args;
                watched += c.flags.some(([at, , flag])=>flag !== PageFlag.INACCESSIBLE
                    && length > 0 && at >>> 12 >= dst >>> 12
                    && at >>> 12 <= (dst + length - 1) >>> 12) ? 1 : 0;
            }
        }
        assert.ok(formed > 60, `${formed} calls formed as the operation`);
        assert.ok(made > 0, `${made} calls made as they were`);
        assert.ok(watched > 0 || !['memmove', 'memcpy', 'memset'].includes(name),
            `${watched} stores beside code or a watch formed`);
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

/**
 * The compiler's quadword helpers and `__chkstk`, judged by what they compute
 * (their own bytes are judged against the operations by
 * `tools/crt-dictionary.mjs --verify`): a call to a function the dictionary
 * names one of them -- its bytes this test's own, never run -- answers as the
 * helper does, and where the helper would fault (a divide by zero, the least
 * quadword by -1, a stack closed below) leaves before the call, nothing
 * written.
 */
const HELPER_AT = 0x9800;
const FILLER = [0x90, 0x90, 0x90, 0x90, 0xc3];

/** @param {string} does @returns {import('../helpers.js').RuntimeHelper} */
const helperOf = does=>({ name: does, does: /** @type {any} */ (does), length: FILLER.length,
    hash: fingerprint(at=>FILLER[at - HELPER_AT] ?? 0, HELPER_AT, FILLER.length) });

const MASK = (1n << 64n) - 1n;
/** @param {bigint} v */
const signed = v=>BigInt.asIntN(64, v);

/**
 * What each helper answers: edx:eax, and for the dvrm ones ebx:ecx; null where
 * it faults.
 *
 * @param {string} does @param {bigint} a @param {bigint} b @param {number} count
 * @returns {{ result: bigint, rest?: bigint } | null}
 */
function expected(does, a, b, count){
    const least = -(1n << 63n);
    switch (does)
    {
        case 'allmul': return { result: (a * b) & MASK };
        case 'aulldiv': return b === 0n ? null : { result: a / b };
        case 'aullrem': return b === 0n ? null : { result: a % b };
        case 'aulldvrm': return b === 0n ? null : { result: a / b, rest: a % b };
        case 'alldiv': case 'allrem': case 'alldvrm':
        {
            const [x, y] = [signed(a), signed(b)];
            if (y === 0n || (does !== 'allrem' && x === least && y === -1n))
            {
                return null;
            }
            const quotient = (x / y) & MASK;
            const rest = (y === -1n ? 0n : x % y) & MASK;
            return does === 'alldiv' ? { result: quotient } : does === 'allrem'
                ? { result: rest } : { result: quotient, rest };
        }
        case 'allshl': return { result: count >= 64 ? 0n : (a << BigInt(count)) & MASK };
        case 'aullshr': return { result: count >= 64 ? 0n : a >> BigInt(count) };
        case 'allshr':
            return { result: (signed(a) >> BigInt(Math.min(count, 63))) & MASK };
        default: throw new Error(does);
    }
}

for (const does of ['allmul', 'alldiv', 'aulldiv', 'allrem', 'aullrem', 'alldvrm', 'aulldvrm',
    'allshl', 'allshr', 'aullshr'])
{
    test(`${does}: seeded operands answer as the helper does, a fault left to it`, ()=>{
        const helpers = [helperOf(does)];
        const shift = does.endsWith('shl') || does.endsWith('shr');
        let left = 0;
        for (let seed = 1; seed <= 200; seed++)
        {
            const next = random(seed * 31 + does.length);
            const word = ()=>Math.floor(next() * 2 ** 32) >>> 0;
            const pick = ()=>{
                const kind = Math.floor(next() * 6);
                return kind === 0 ? 0n : kind === 1 ? MASK : kind === 2 ? 1n << 63n
                    : kind === 3 ? BigInt(word()) : (BigInt(word()) << 32n) | BigInt(word());
            };
            const a = pick();
            const b = next() < 0.1 ? MASK : pick();
            const count = Math.floor(next() * 256);
            const m = createTestMachine({ ramSize: RAM });
            m.write(HELPER_AT, FILLER);
            const code = shift
                ? [0xe8, ...rel(PROGRAM, HELPER_AT)]
                : [0x68, ...u32(Number(b >> 32n)), 0x68, ...u32(Number(b & 0xffffffffn)),
                    0x68, ...u32(Number(a >> 32n)), 0x68, ...u32(Number(a & 0xffffffffn))];
            if (!shift)
            {
                code.push(0xe8, ...rel(PROGRAM + code.length, HELPER_AT));
            }
            code.push(0xa3, ...u32(OUT), 0x89, 0x15, ...u32(OUT + 4));   // mov [OUT], eax/edx
            code.push(0x50, 0x58);                                       // push eax; pop eax
            code.push(0xf4);
            m.write(PROGRAM, code);
            ['ebx', 'ebp', 'esi', 'edi'].forEach((r, i)=>m.setReg(r, 0x1000 * (i + 1)));
            m.setReg('eax', Number(a & 0xffffffffn));
            m.setReg('edx', Number(a >> 32n));
            m.setReg('ecx', count | 0x5a00);
            m.setReg('esp', STACK);
            const exit = m.runProgram(PROGRAM, { helpers });
            const want = expected(does, a, b, count);
            if (want === null)
            {
                assert.equal(exit.kind, -2, `seed ${seed}: left before the call`);
                assert.equal(m.eip(), PROGRAM + 20, 'at the call');
                assert.equal(m.reg('esp'), STACK - 16, 'its operands pushed, none popped');
                assert.equal(m.reg('ebx'), 0x1000);
                left++;
                continue;
            }
            assert.equal(exit.kind, 3, `seed ${seed}: ran to its end`);
            const out = new DataView(m.read(OUT, 8).buffer);
            assert.equal(out.getBigUint64(0, true), want.result,
                `seed ${seed}: ${does}(${a}, ${shift ? count : b})`);
            assert.equal(m.reg('esp'), STACK, 'the operands popped');
            if (want.rest !== undefined)
            {
                assert.equal((BigInt(m.reg('ebx') >>> 0) << 32n) | BigInt(m.reg('ecx') >>> 0),
                    want.rest, `seed ${seed}: the remainder in ebx:ecx`);
            }
            else
            {
                assert.equal(m.reg('ebx'), 0x1000);
            }
            assert.deepEqual(['ebp', 'esi', 'edi'].map(r=>m.reg(r)), [0x2000, 0x3000, 0x4000]);
            if (shift)
            {
                // cl as the helper leaves it: a count from 32 to 63 masked to 31.
                assert.equal(m.reg('ecx'), count >= 32 && count < 64
                    ? (count | 0x5a00) & ~0xe0 : count | 0x5a00, `seed ${seed}: cl`);
            }
        }
        if (does.includes('div') || does.includes('rem') || does.includes('dvrm'))
        {
            assert.ok(left > 0, 'some divides by zero');
        }
    });
}

test('chkstk moves esp down by eax past the call, its return address in eax; a stack closed'
    + ' below leaves before the call', ()=>{
    const helpers = [helperOf('chkstk')];
    for (const [size, closed] of /** @type {[number, boolean][]} */ ([[0x10, false], [0x3000, false],
        [0x3000, true], [0, false]]))
    {
        const m = createTestMachine({ ramSize: RAM });
        m.write(HELPER_AT, FILLER);
        const code = [0xb8, ...u32(size), 0xe8, ...rel(PROGRAM + 5, HELPER_AT),
            0x89, 0x25, ...u32(OUT), 0xa3, ...u32(OUT + 4), 0xf4];   // mov [OUT], esp; [OUT+4], eax
        m.write(PROGRAM, code);
        m.setReg('esp', STACK);
        m.setReg('ecx', 0x77);
        if (closed)
        {
            m.pages.markRange(STACK - 0x2800, 1, PageFlag.INACCESSIBLE);
        }
        const exit = m.runProgram(PROGRAM, { helpers });
        if (closed)
        {
            assert.equal(exit.kind, -2);
            assert.equal(m.reg('esp'), STACK);
            continue;
        }
        assert.equal(exit.kind, 3);
        const out = new DataView(m.read(OUT, 8).buffer);
        assert.equal(out.getUint32(0, true), STACK - size);
        assert.equal(out.getUint32(4, true), PROGRAM + 10);
        assert.equal(m.reg('ecx'), 0x77);
    }
});

/**
 * A double's significand rounded to 24 bits, to nearest even, its exponent
 * whatever it is: what the x87 at single precision keeps.
 *
 * @param {number} x
 */
function single(x){
    const scale = 2 ** Math.floor(Math.log2(Math.abs(x)));
    return Math.fround(x / scale) * scale;
}

test('floor, ceil and sqrt answer as the x87 would at the control word\'s precision, a NaN,'
    + ' an infinity or a negative root left to the function', ()=>{
    for (const does of ['floor', 'ceil', 'sqrt'])
    {
        const helpers = [{ ...helperOf(does), body: CRT_BODIES[/** @type {'sqrt'} */ (does)] }];
        const values = [0, -0, 0.5, -0.5, 2.5, -2.5, 1e300, -1e300, 16777217.5, 2 ** 52 + 0.5,
            -(2 ** 31) - 0.25, Math.PI, Infinity, -Infinity, NaN, -1, 2, 1e-300];
        for (const control of [0x37f, 0x27f, 0x7f])
        {
            for (const value of values)
            {
                const m = createTestMachine({ ramSize: RAM });
                m.write(HELPER_AT, FILLER);
                const bits = new DataView(new ArrayBuffer(8));
                bits.setFloat64(0, value, true);
                const code = [0x68, ...u32(bits.getUint32(4, true)),
                    0x68, ...u32(bits.getUint32(0, true))];
                code.push(0xe8, ...rel(PROGRAM + code.length, HELPER_AT));
                code.push(0x83, 0xc4, 8, 0xdd, 0x1d, ...u32(OUT), 0xf4);
                m.write(PROGRAM, code);
                m.setReg('esp', STACK);
                const view = new DataView(m.memory.buffer);
                view.setUint16(m.layout.x87Control, control, true);
                const exit = m.runProgram(PROGRAM, { helpers });
                const left = does === 'sqrt' ? !(value >= 0) : !Number.isFinite(value);
                if (left)
                {
                    assert.equal(exit.kind, -2, `${does}(${value}): left before the call`);
                    continue;
                }
                assert.equal(exit.kind, 3, `${does}(${value})`);
                const got = new DataView(m.read(OUT, 8).buffer).getFloat64(0, true);
                const exact = does === 'floor' ? Math.floor(value) : does === 'ceil'
                    ? Math.ceil(value) : Math.sqrt(value);
                // Single precision rounds a root (a normal one) to 24 bits; a whole
                // number from floor and ceil is exact at any precision.
                const want = does === 'sqrt' && control === 0x7f && exact !== 0
                    && Number.isFinite(exact) ? single(exact) : exact;
                assert.ok(Object.is(got, want), `${does}(${value}) at ${control.toString(16)}:`
                    + ` ${got}, not ${want}`);
            }
        }
    }
});

/** Where the test's `_ftol2_sse` finds the runtime's SSE2 flag. */
const SSE2_FLAG = 0xa800;
/** A double for `_ftol2_sse`'s ST0. */
const VALUE = 0xa900;

/**
 * The test's own `_ftol2_sse`, as the compiler's does it: with the runtime's
 * SSE2 flag set, ST0 stored as a double and truncated to eax by `cvttsd2si`;
 * else its own `_ftol2`, the quadword in edx:eax by `fisttp`.
 */
const FTOL2_SSE = [
    0x83, 0x3d, ...u32(SSE2_FLAG), 0x00,    // cmp dword [flag], 0
    0x74, 0x13,                             // je slow
    0x55, 0x8b, 0xec,                       // push ebp; mov ebp, esp
    0x83, 0xec, 0x08, 0x83, 0xe4, 0xf8,     // sub esp, 8; and esp, -8
    0xdd, 0x1c, 0x24,                       // fstp qword [esp]
    0xf2, 0x0f, 0x2c, 0x04, 0x24,           // cvttsd2si eax, qword [esp]
    0xc9, 0xc3,                             // leave; ret
    0x83, 0xec, 0x08,                       // slow: sub esp, 8
    0xdd, 0x0c, 0x24,                       // fisttp qword [esp]
    0x58, 0x5a, 0xc3,                       // pop eax; pop edx; ret
];

test('_ftol2_sse made as cvttsd2si where the runtime\'s flag is set answers as its body,'
    + ' and with the flag clear leaves the call to it', ()=>{
    const helpers = [{ name: '_ftol2_sse', does: /** @type {'ftol2sse'} */ ('ftol2sse'),
        word: 2, length: FTOL2_SSE.length, body: CRT_BODIES.ftol2sse,
        hash: fingerprint(at=>FTOL2_SSE[at - HELPER_AT] ?? 0, HELPER_AT, FTOL2_SSE.length) }];
    const values = [0, -0, 0.5, -0.5, 1.5, -2.5, 2147483647.75, 2147483648, -2147483648.5,
        -2147483649, 1e300, -1e300, Infinity, -Infinity, NaN, 1e-310, 123456.789];
    let formed = 0;
    for (const flag of [1, 0])
    {
        for (const value of values)
        {
            /** @param {false | import('../helpers.js').RuntimeHelper[]} given */
            const once = given=>{
                const m = createTestMachine({ ramSize: RAM });
                m.write(HELPER_AT, FTOL2_SSE);
                m.write(SSE2_FLAG, u32(flag));
                const bits = new DataView(new ArrayBuffer(8));
                bits.setFloat64(0, value, true);
                m.write(VALUE, [...new Uint8Array(bits.buffer)]);
                const code = [0xdd, 0x05, ...u32(VALUE)];          // fld qword [value]
                code.push(0xe8, ...rel(PROGRAM + code.length, HELPER_AT));
                code.push(0xa3, ...u32(OUT), 0x89, 0x15, ...u32(OUT + 4),  // eax, edx
                    0xdf, 0xe0, 0xa3, ...u32(OUT + 8),             // fnstsw ax; to OUT+8
                    0x0f, 0xae, 0x1d, ...u32(OUT + 12), 0xf4);     // stmxcsr [OUT+12]; hlt
                m.write(PROGRAM, code);
                m.setReg('esp', STACK);
                m.setReg('edx', 0x5eed);
                let exit = m.runProgram(PROGRAM, { helpers: given });
                const left = exit.kind === -2;
                if (left)
                {
                    exit = m.runProgram(exit.eip, { helpers: false });
                }
                return { left, seen: { kind: exit.kind, out: [...m.read(OUT, 16)],
                    esp: m.reg('esp'), ebp: m.reg('ebp') } };
            };
            const body = once(false);
            const made = once(helpers);
            assert.deepEqual(made.seen, body.seen, `flag ${flag}, ${value}`);
            assert.equal(made.left, flag === 0, `flag ${flag}, ${value}: made as the call`);
            formed += made.left ? 0 : 1;
        }
    }
    assert.equal(formed, values.length);
});

/** Where the cookie checks find the runtime's cookie, and their report. */
const COOKIE = 0xa880;
const REPORT = 0x9f00;

test('__security_check_cookie of every shape the dictionary knows returns where ecx is the'
    + ' cookie and leaves the call to its report where it is not, or its page is closed', ()=>{
    const entries = CRT_DICTIONARY.filter(entry=>entry.does === 'gscookie');
    assert.equal(entries.length, 2);
    for (const entry of entries)
    {
        const at = HELPER_AT;
        // The shape's own bytes: cmp ecx, [cookie]; jne +n; (rep) ret; jmp report.
        const ret = entry.length === 15 ? [0xf3, 0xc3] : [0xc3];
        const head = [0x3b, 0x0d, ...u32(COOKIE), 0x75, ret.length, ...ret];
        const stub = [...head, 0xe9, ...rel(at + head.length, REPORT)];
        assert.equal(stub.length, entry.length);
        for (const [cookieValue, argument, closed] of /** @type {[number, number, boolean][]} */ (
            [[0xbb40e64e, 0xbb40e64e, false], [0xbb40e64e, 0xbb40e64f, false],
                [0x12345678, 0x12345678, true], [0, 0, false]]))
        {
            /** @param {false | import('../helpers.js').RuntimeHelper[]} given */
            const once = given=>{
                const m = createTestMachine({ ramSize: RAM });
                m.write(at, stub);
                // The report: a mark, then a halt.
                m.write(REPORT, [0xc7, 0x05, ...u32(OUT + 4), ...u32(0xdead), 0xf4]);
                m.write(COOKIE, u32(cookieValue));
                const code = [0xb9, ...u32(argument)];
                code.push(0xe8, ...rel(PROGRAM + code.length, at));
                code.push(0x89, 0x0d, ...u32(OUT), 0xf4);           // mov [OUT], ecx; hlt
                m.write(PROGRAM, code);
                m.setReg('esp', STACK);
                if (closed)
                {
                    m.pages.markRange(COOKIE, 4, PageFlag.INACCESSIBLE);
                }
                let exit = m.runProgram(PROGRAM, { helpers: given });
                const left = exit.kind === -2;
                if (left)
                {
                    exit = m.runProgram(exit.eip, { helpers: false });
                }
                return { left, seen: { kind: exit.kind, eip: m.eip(), out: [...m.read(OUT, 8)],
                    esp: m.reg('esp') } };
            };
            const body = once(false);
            const made = once([entry]);
            const label = `${entry.length} bytes, cookie ${cookieValue}, ecx ${argument}`;
            assert.deepEqual(made.seen, body.seen, label);
            assert.equal(made.left, closed || cookieValue !== argument, label);
        }
    }
});

/** Where the transcendentals' test finds its arguments. */
const ARGUMENTS = 0xa940;
/** 2^ST0 of ST0 a whole power and its rest (`f2xm1`), as the x87 makes an exponential. */
const EXP2 = [
    0xd9, 0xc0, 0xd9, 0xfc,                 // fld st0; frndint
    0xdc, 0xe9, 0xd9, 0xc9,                 // fsub st1, st0; fxch
    0xd9, 0xf0, 0xd9, 0xe8, 0xde, 0xc1,     // f2xm1; fld1; faddp
    0xd9, 0xfd, 0xdd, 0xd9,                 // fscale; fstp st1
];
/** The test's own transcendentals, the x87's way (the dictionary's take the host's result). */
const X87_WAY = {
    cisin: [0xd9, 0xfe],                                        // fsin
    cicos: [0xd9, 0xff],                                        // fcos
    citan: [0xd9, 0xf2, 0xdd, 0xd8],                            // fptan; fstp st0
    ciatan: [0xd9, 0xe8, 0xd9, 0xf3],                           // fld1; fpatan
    // atan2(x, sqrt(1 - x^2)) and atan2(sqrt(1 - x^2), x)
    ciasin: [0xd9, 0xc0, 0xd8, 0xc8, 0xd9, 0xe8, 0xde, 0xe1, 0xd9, 0xfa, 0xd9, 0xf3],
    ciacos: [0xd9, 0xc0, 0xd8, 0xc8, 0xd9, 0xe8, 0xde, 0xe1, 0xd9, 0xfa, 0xd9, 0xc9, 0xd9, 0xf3],
    cilog: [0xd9, 0xed, 0xd9, 0xc9, 0xd9, 0xf1],                // fldln2; fxch; fyl2x
    cilog10: [0xd9, 0xec, 0xd9, 0xc9, 0xd9, 0xf1],              // fldlg2; fxch; fyl2x
    ciexp: [0xd9, 0xea, 0xde, 0xc9, ...EXP2],                   // fldl2e; fmulp; 2^
    cipow: [0xd9, 0xc9, 0xd9, 0xf1, ...EXP2],                   // fxch; fyl2x; 2^
};
/** What each answers: the host's own. @type {Record<string, (x: number, y: number) => number>} */
const HOST_WAY = {
    cisin: Math.sin, cicos: Math.cos, citan: Math.tan, ciatan: Math.atan, ciasin: Math.asin,
    ciacos: Math.acos, cilog: Math.log, cilog10: Math.log10, ciexp: Math.exp,
    cipow: (x, y)=>y ** x,
};

test('the x87 transcendentals (_CI*) answer as the host\'s functions where the argument is in'
    + ' their domain, and leave the call, its lead uncounted, where it is not', ()=>{
    /** @type {Record<string, (x: number, y: number) => boolean>} */
    const domains = {
        cisin: x=>Math.abs(x) < 2 ** 63, cicos: x=>Math.abs(x) < 2 ** 63,
        citan: x=>Math.abs(x) < 2 ** 63,
        ciatan: x=>Math.abs(x) < 2 ** 50 && (Math.abs(x) > 2 ** -20 || x === 0),
        ciasin: x=>Math.abs(x) <= 1, ciacos: x=>Math.abs(x) <= 1,
        cilog: x=>x > 0 && x < Infinity, cilog10: x=>x > 0 && x < Infinity,
        ciexp: x=>x > -708 && x < 709,
        // pow: x the power (ST0), y the base (ST1).
        cipow: (x, y)=>y > 0 && y < Infinity && Math.abs(x) < Infinity
            && Math.abs(x * Math.log2(y)) < 1000,
    };
    const singles = [0, -0, 0.5, -0.5, 1, -1, 1.0000001, 2, 100, -100, 707.5, 708.5, 710,
        -707.5, -709, 1e10, 2 ** 63, -(2 ** 63), 1e300, Infinity, -Infinity, NaN, 1e-300, 1e-7,
        -1e-7, 2 ** 51];
    const pairs = [[2, 10], [2, 0.5], [0.5, -3], [-8, 3], [0, 2], [10, 300], [10, 400],
        [Infinity, 1], [3, NaN], [1e-300, 1.5], [7, -2.5], [1, 1e300]];
    let formed = 0;
    let left = 0;
    for (const [does, inDomain] of Object.entries(domains))
    {
        const crt = /** @type {import('../helpers.js').Crt} */ (does);
        const entry = CRT_DICTIONARY.find(one=>one.does === crt);
        assert.ok(entry?.lead !== undefined, `${does}: the dictionary's entry has a lead`);
        const fn = [...X87_WAY[/** @type {keyof X87_WAY} */ (does)], 0xc3];
        const helpers = [{ name: does, does: crt, lead: entry.lead, body: CRT_BODIES[crt],
            length: fn.length,
            hash: fingerprint(at=>fn[at - HELPER_AT] ?? 0, HELPER_AT, fn.length) }];
        for (const [base, power] of does === 'cipow' ? pairs : singles.map(x=>[0, x]))
        {
            /** @param {false | import('../helpers.js').RuntimeHelper[]} given */
            const once = given=>{
                const m = createTestMachine({ ramSize: RAM });
                m.write(HELPER_AT, fn);
                const bits = new DataView(new ArrayBuffer(16));
                bits.setFloat64(0, base, true);
                bits.setFloat64(8, power, true);
                m.write(ARGUMENTS, [...new Uint8Array(bits.buffer)]);
                const code = does === 'cipow' ? [0xdd, 0x05, ...u32(ARGUMENTS)] : [];
                code.push(0xdd, 0x05, ...u32(ARGUMENTS + 8));
                code.push(0xe8, ...rel(PROGRAM + code.length, HELPER_AT));
                code.push(0xdd, 0x1d, ...u32(OUT),                 // fstp qword [OUT]
                    0xdf, 0xe0, 0xa3, ...u32(OUT + 8), 0xf4);     // fnstsw ax; to OUT+8; hlt
                m.write(PROGRAM, code);
                m.setReg('esp', STACK);
                let exit = m.runProgram(PROGRAM, { helpers: given });
                let retired = exit.retired;
                const gone = exit.kind === -2;
                if (gone)
                {
                    exit = m.runProgram(exit.eip, { helpers: false });
                    retired += exit.retired;
                }
                return { gone, retired, seen: { kind: exit.kind, out: [...m.read(OUT, 12)],
                    esp: m.reg('esp') } };
            };
            const what = `${does}(${base}, ${power})`;
            const body = once(false);
            const made = once(helpers);
            assert.equal(made.gone, !inDomain(power, base), `${what}: left to the call`);
            if (!made.gone)
            {
                // The host's result exactly, where the x87's way may be a unit or a few
                // off it; the rest as the x87's way leaves it.
                const got = new DataView(Uint8Array.from(made.seen.out).buffer).getFloat64(0, true);
                const want = HOST_WAY[does](power, base);
                assert.ok(Object.is(got, want), `${what}: ${got}, not ${want}`);
                assert.deepEqual({ ...made.seen, out: made.seen.out.slice(8) },
                    { ...body.seen, out: body.seen.out.slice(8) }, what);
            }
            else
            {
                assert.deepEqual(made.seen, body.seen, what);
            }
            if (made.gone)
            {
                assert.equal(made.retired, body.retired, `${what}: retired as the call`);
                left++;
            }
            else
            {
                formed++;
            }
        }
    }
    assert.ok(formed > 50 && left > 50, `${formed} formed, ${left} left`);
});

test('a transcendental formed only at double precision (`precise`) is left to the function'
    + ' under single precision, and formed under double and extended', ()=>{
    const fn = [...X87_WAY.ciasin, 0xc3];
    const entry = CRT_DICTIONARY.find(one=>one.does === 'ciasin' && one.precise === true);
    assert.ok(entry !== undefined, 'the dictionary has an asin formed only at double precision');
    const helpers = [{ name: 'asin', does: /** @type {'ciasin'} */ ('ciasin'), lead: entry.lead,
        precise: true, body: CRT_BODIES.ciasin, length: fn.length,
        hash: fingerprint(at=>fn[at - HELPER_AT] ?? 0, HELPER_AT, fn.length) }];
    for (const control of [0x7f, 0x27f, 0x37f])
    {
        const m = createTestMachine({ ramSize: RAM });
        m.write(HELPER_AT, fn);
        const bits = new DataView(new ArrayBuffer(8));
        bits.setFloat64(0, 0.25, true);
        m.write(ARGUMENTS, [...new Uint8Array(bits.buffer)]);
        const code = [0xdd, 0x05, ...u32(ARGUMENTS)];
        code.push(0xe8, ...rel(PROGRAM + code.length, HELPER_AT));
        code.push(0xdd, 0x1d, ...u32(OUT), 0xf4);
        m.write(PROGRAM, code);
        m.setReg('esp', STACK);
        new DataView(m.memory.buffer).setUint16(m.layout.x87Control, control, true);
        const exit = m.runProgram(PROGRAM, { helpers });
        assert.equal(exit.kind === -2, control === 0x7f, `control ${control.toString(16)}`);
    }
});

/** An import slot, and a function written into it later. */
const SLOT = 0xa9c0;
const OTHER = 0x9a00;

test('a call through an import slot to a function the dictionary knows is formed as its'
    + ' operation, and calls whatever function the slot holds once it is written', ()=>{
    // Twice: memset(DATA, ebx, 64) through the slot, then another function into the slot.
    // The test's memset does nothing itself: the bytes are filled only where it is formed.
    const code = [0xbb, ...u32(2)];                                  // mov ebx, 2
    const loop = PROGRAM + code.length;
    code.push(0x6a, 64, 0x53, 0x68, ...u32(DATA));                  // push 64; push ebx; push DATA
    code.push(0xff, 0x15, ...u32(SLOT));                             // call [SLOT]
    code.push(0x83, 0xc4, 12);                                       // add esp, 12
    code.push(0xc7, 0x05, ...u32(SLOT), ...u32(OTHER));              // mov dword [SLOT], OTHER
    code.push(0x4b, 0x75, (loop - (PROGRAM + code.length + 3)) & 0xff, 0xf4);  // dec; jnz; hlt
    /** @param {boolean} formed */
    const once = formed=>{
        const m = createTestMachine({ ramSize: RAM });
        m.write(HELPER_AT, FILLER);
        m.write(OTHER, [0xc3]);
        m.write(SLOT, u32(HELPER_AT));
        m.write(PROGRAM, code);
        m.setReg('esp', STACK);
        const exit = m.runProgram(PROGRAM, { helpers: formed ? [helperOf('memset')] : false });
        assert.equal(exit.kind, 3);
        return [...m.read(DATA, 65)];
    };
    assert.deepEqual(once(false), new Array(65).fill(0), 'the test\'s memset fills nothing');
    // The first call formed (2), the second the function written into the slot (nothing).
    assert.deepEqual(once(true), [...new Array(64).fill(2), 0]);
});
