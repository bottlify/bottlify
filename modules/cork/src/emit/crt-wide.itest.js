/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of the C runtime's operations in long mode (`emit/crt.js`): calls
 * to a memmove, memcpy, memset, strlen, memcmp, memchr and strchr of the
 * test's own, made as the operation and through the function's body, answer
 * the same -- the result, the registers a callee keeps, the bytes, the page
 * marks, a fault. In 4 GiB, and in a wide window (`wideLayout`) the copies,
 * fills and lengths with the data in the 4 GiB block past the first, where
 * every pointer's high half counts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CORPUS, load, machine, run } from '../testing/long-machine.js';
import { fingerprint } from '../helpers.js';
import { codeRangesAt, pageFlagsAt } from '../runtime/layout.js';
import { CRT_DICTIONARY } from '../crt-dictionary.js';
import { PageFlag } from '../runtime/pages.js';

/** The functions, each the plain loop a compiler might make of it (x64, Microsoft's convention). */
const FUNCTIONS = {
    memmove: [0x48, 0x89, 0xc8, 0x4d, 0x85, 0xc0, 0x74, 0x26, 0x48, 0x39, 0xd1, 0x76, 0x0e,
        0x49, 0xff, 0xc8, 0x46, 0x8a, 0x0c, 0x02, 0x46, 0x88, 0x0c, 0x01, 0x75, 0xf3, 0xc3,
        0x45, 0x31, 0xd2, 0x46, 0x8a, 0x0c, 0x12, 0x46, 0x88, 0x0c, 0x11, 0x49, 0xff, 0xc2,
        0x4d, 0x39, 0xc2, 0x75, 0xf0, 0xc3],
    memset: [0x48, 0x89, 0xc8, 0x4d, 0x85, 0xc0, 0x74, 0x0f, 0x45, 0x31, 0xd2, 0x42, 0x88,
        0x14, 0x11, 0x49, 0xff, 0xc2, 0x4d, 0x39, 0xc2, 0x75, 0xf4, 0xc3],
    strlen: [0x48, 0xc7, 0xc0, 0xff, 0xff, 0xff, 0xff, 0x48, 0xff, 0xc0, 0x80, 0x3c, 0x01,
        0x00, 0x75, 0xf7, 0xc3],
    // -1, 0 or 1 by the first pair of bytes apart, unsigned (`sbb; or`).
    memcmp: [0x31, 0xc0, 0x4d, 0x85, 0xc0, 0x74, 0x19, 0x44, 0x8a, 0x09, 0x44, 0x3a, 0x0a, 0x75,
        0x0c, 0x48, 0xff, 0xc1, 0x48, 0xff, 0xc2, 0x49, 0xff, 0xc8, 0x75, 0xed, 0xc3, 0x19, 0xc0,
        0x83, 0xc8, 0x01, 0xc3],
    memchr: [0x48, 0x89, 0xc8, 0x4d, 0x85, 0xc0, 0x74, 0x0c, 0x38, 0x10, 0x74, 0x0a, 0x48, 0xff,
        0xc0, 0x49, 0xff, 0xc8, 0xeb, 0xef, 0x31, 0xc0, 0xc3],
    strchr: [0x48, 0x89, 0xc8, 0x44, 0x8a, 0x08, 0x41, 0x38, 0xd1, 0x74, 0x0c, 0x45, 0x84, 0xc9,
        0x74, 0x05, 0x48, 0xff, 0xc0, 0xeb, 0xee, 0x31, 0xc0, 0xc3],
};

/** Where the operations are formed: in 4 GiB, and in a wide window past it. */
const WHERE = [
    { title: 'a wide window\'s', window: 2 ** 33, high: 2 ** 32,
        names: ['memmove', 'memcpy', 'memset', 'strlen', 'memcmp', 'memchr', 'strchr'] },
    { title: 'long mode\'s', window: undefined, high: 0,
        names: ['memmove', 'memcpy', 'memset', 'strlen', 'memcmp', 'memchr', 'strchr'] },
];

/** The pages the cases use, past the corpus's data area, and the closed page after them. */
const AREA = CORPUS.dataAt + 0x10000;
const AREA_BYTES = 0x10000;
/** The stack, at the area's start; the spans lie past it. */
const STACK = AREA + 0x800;
const SPANS = AREA + 0x1000;
/** Where the program puts the function, past its own bytes. */
const FUNCTION_OFFSET = 0x80;

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
 * The dictionary entry of a function, at its place in the code.
 * @param {keyof typeof FUNCTIONS} name @param {string} [does]  what it is formed as
 */
function entryOf(name, does = name){
    const bytes = FUNCTIONS[name];
    return { name, does, bits: 64, length: bytes.length,
        hash: fingerprint(at=>bytes[at] ?? 0, 0, bytes.length) };
}

/** A quadword's bytes. @param {number} value */
const quad = value=>[...new Uint8Array(new BigUint64Array([BigInt(value)]).buffer)];

/**
 * A case's program: the arguments in rcx, rdx and r8, the call, then on past
 * the function to the exit the machine puts after the code.
 *
 * @param {keyof typeof FUNCTIONS} name @param {number[]} args
 */
function codeOf(name, args){
    const program = [0x48, 0xb9, ...quad(args[0]), 0x48, 0xba, ...quad(args[1] ?? 0),
        0x49, 0xb8, ...quad(args[2] ?? 0)];
    const call = FUNCTION_OFFSET - (program.length + 5);
    program.push(0xe8, ...quad(call).slice(0, 4));
    const over = FUNCTION_OFFSET + FUNCTIONS[name].length - (program.length + 5);
    program.push(0xe9, ...quad(over).slice(0, 4));
    while (program.length < FUNCTION_OFFSET)
    {
        program.push(0x90);
    }
    return Buffer.from([...program, ...FUNCTIONS[name]]).toString('hex');
}

/**
 * @typedef {{ name: keyof typeof FUNCTIONS, args: number[], data: Uint8Array,
 *     watch: number[], code: number[], closed: number[] }} Case
 */

/**
 * Seeded cases: spans in the area, some overlapping, some reaching the closed
 * page past it, some over a watched page or a page of code.
 *
 * @param {keyof typeof FUNCTIONS} name @param {number} seed @param {number} high
 * @returns {Case}
 */
function caseOf(name, seed, high){
    const next = random(seed * 7919 + name.length);
    const int = (/** @type {number} */ n)=>Math.floor(next() * n);
    // Strings of a few dozen bytes, a zero here and there.
    const data = new Uint8Array(AREA_BYTES).map(()=>(next() < 0.02 ? 0 : 1 + int(255)));
    const end = AREA + AREA_BYTES;
    const shape = int(10);
    const length = shape === 0 ? 0 : shape === 1 ? 0x1000 + int(0x2000) : int(600);
    const place = ()=>SPANS + int(end - SPANS - length);
    let dst = place();
    let src = place();
    if (shape === 2)
    {
        src = dst + int(16) - 8;
    }
    if (shape === 3)
    {
        dst = end - length + 1 + int(8);    // into the closed page past the area
    }
    /** @type {Case} */
    const c = { name, args: [], data, watch: [], code: [], closed: [] };
    const flagged = int(6);
    if (flagged === 0)
    {
        c.watch.push(dst + int(length + 1));
    }
    else if (flagged === 1)
    {
        c.code.push(dst + int(length + 1));
    }
    else if (flagged === 2)
    {
        c.code.push(dst + length + 32 + int(64));
    }
    else if (flagged === 3 && name !== 'memset')
    {
        c.closed.push(src + int(length + 1));
    }
    if (name === 'strlen')
    {
        c.args = [src + high];
        return c;
    }
    if (name === 'memcmp' || name === 'memchr' || name === 'strchr')
    {
        // The pointers moved by the data's high half; memcmp's are both.
        c.args = scanArgs(name, data, int, length, dst, src)
            .map((arg, i)=>(i === 0 || i === 1 && name === 'memcmp' ? arg + high : arg));
        return c;
    }
    c.args = [dst + high, name === 'memset' ? int(2 ** 32) * 2 ** 20 + int(256) : src + high,
        length];
    return c;
}

/**
 * A comparison's or search's arguments, the area's data made for it: two
 * spans equal up to a seeded first difference (or wholly), the byte sought
 * in the span, its string's zero, or neither.
 *
 * @param {string} name @param {Uint8Array} data @param {(n: number) => number} int
 * @param {number} length @param {number} dst @param {number} src
 * @returns {number[]}
 */
function scanArgs(name, data, int, length, dst, src){
    if (name === 'memchr' || name === 'strchr')
    {
        const sought = [data[src - AREA + int(length)] ?? 0, 0, int(256), data[src - AREA]][int(4)];
        if (name === 'strchr')
        {
            data.forEach((v, i)=>{
                data[i] = v === 0 ? 1 : v;
            });
            data[Math.min(src - AREA + length, AREA_BYTES - 1)] = 0;
        }
        return name === 'memchr' ? [src, sought | int(2) * 0x1200, length]
            : [src, sought | int(2) * 0x3400];
    }
    if (Math.abs(dst - src) >= length)
    {
        const k = int(length + 1);
        data.copyWithin(dst - AREA, src - AREA, src - AREA + k);
        if (k < length && int(2) === 0)
        {
            data[dst - AREA + k] = data[src - AREA + k] ^ 1 << int(8);
        }
    }
    return [dst, src, length];
}

/**
 * One case run translated, with the entries given formed as their operations
 * or (`false`) through the bodies.
 *
 * @param {Case} c @param {false | object[]} helpers
 * @param {{ window?: number, high: number }} where
 */
function runCase(c, helpers, { window, high }){
    const m = machine({ window, high, config: { helpers } });
    const pages = (window ?? 2 ** 32) / 4096;
    const flags = new Uint8Array(m.memory.buffer, pageFlagsAt(m.layout), pages);
    const ranges = new Uint8Array(m.memory.buffer, codeRangesAt(m.layout), pages * 2);
    const ram = new Uint8Array((m.ram ?? m.memory).buffer);
    const from = AREA + high;
    flags.fill(0, from / 4096, (from + AREA_BYTES) / 4096);
    ram.set(c.data, from);
    for (const at of c.watch)
    {
        flags[(at + high) / 4096 >>> 0] |= PageFlag.WATCH;
    }
    for (const at of c.code)
    {
        const page = (at + high) / 4096 >>> 0;
        const granule = (at & 0xfff) >>> 5;
        flags[page] |= PageFlag.HAS_CODE;
        ranges[page * 2] = granule;
        ranges[page * 2 + 1] = granule + 1;
    }
    for (const at of c.closed)
    {
        flags[(at + high) / 4096 >>> 0] = PageFlag.INACCESSIBLE;
    }
    const regs = Array.from({ length: 16 },
        (unused, i)=>(BigInt(i) * 0x1111111111111n).toString(16));
    regs[4] = (BigInt(STACK + high)).toString(16);
    load(m, { code: codeOf(c.name, c.args), regs, flags: 0, seed: 1, fresh: true });
    const seen = run(m, true, 100000);
    // rax, and the registers a callee keeps: rbx, rsp, rbp, rsi, rdi, r12 to r15.
    const kept = [0, 3, 4, 5, 6, 7, 12, 13, 14, 15].map(i=>seen.regs[i]);
    return {
        fault: seen.fault, kept,
        // Not the stack below rsp, where the call left its return address.
        bytes: [...ram.subarray(SPANS + high, from + AREA_BYTES)],
        marks: [...flags.subarray(from / 4096, (from + AREA_BYTES) / 4096 + 1)],
        retired: Number(seen.retired),
    };
}

for (const where of WHERE)
{
    for (const does of where.names)
    {
        const name = /** @type {keyof typeof FUNCTIONS} */ (does === 'memcpy' ? 'memmove' : does);
        test(`${where.title} ${does}: seeded calls answer the same made as the operation as`
            + ' through the body', ()=>calls(where, name, does));
    }
}

/**
 * Seeded calls of `name`'s function, formed as `does` and through its body.
 * @param {{ window?: number, high: number }} where
 * @param {keyof typeof FUNCTIONS} name @param {string} does
 */
function calls(where, name, does){
    const { high } = where;
    {
        const helpers = [entryOf(name, does)];
        let formed = 0;
        let made = 0;
        for (let seed = 1; seed <= 60; seed++)
        {
            const c = caseOf(name, seed, high);
            const { retired: bodyRetired, ...body } = runCase(c, false, where);
            const { retired, ...seen } = runCase(c, helpers, where);
            const { bytes: seenBytes, ...seenRest } = seen;
            const { bytes: bodyBytes, ...bodyRest } = body;
            assert.deepEqual(seenRest, bodyRest, `seed ${seed}: ${JSON.stringify(c)}`);
            const apart = seenBytes.findIndex((byte, i)=>byte !== bodyBytes[i]);
            assert.equal(apart, -1, `seed ${seed}: ${JSON.stringify(c)}, bytes apart from`
                + ` ${(SPANS + apart).toString(16)}`);
            // A store reaching translated code is the body's to make, which the
            // translation it overwrites is then left for.
            const [dst, , length = 0] = c.args;
            const hitsCode = (name === 'memmove' || name === 'memset') && c.code.some(at=>length > 0
                && (at & ~31) < dst - high + length && (at & ~31) + 32 > dst - high);
            assert.ok(!hitsCode || retired >= bodyRetired,
                `seed ${seed}: a store over code formed`);
            if (retired < bodyRetired)
            {
                formed++;
            }
            else
            {
                made++;
            }
        }
        assert.ok(formed > 30, `${formed} calls formed as the operation`);
        assert.ok(made > 0, `${made} calls made as they were`);
    }
}

/**
 * The test's own long-mode `__chkstk`, as Microsoft's does it: r10 and r11
 * kept, the bytes rax below the caller's rsp (0 past the bottom) compared with
 * the thread block's StackLimit (gs:[0x10]), and below it each page from the
 * limit down probed with a zero byte.
 */
const CHKSTK = [0x41, 0x52, 0x41, 0x53, 0x4c, 0x8d, 0x54, 0x24, 0x18, 0x49, 0x29, 0xc2, 0x73,
    0x03, 0x45, 0x31, 0xd2, 0x65, 0x4c, 0x8b, 0x1c, 0x25, 0x10, 0x00, 0x00, 0x00, 0x4d, 0x39,
    0xda, 0x73, 0x17, 0x49, 0x81, 0xe2, 0x00, 0xf0, 0xff, 0xff, 0x49, 0x81, 0xeb, 0x00, 0x10,
    0x00, 0x00, 0x41, 0xc6, 0x03, 0x00, 0x4d, 0x39, 0xd3, 0x75, 0xf0, 0x41, 0x5b, 0x41, 0x5a,
    0xc3];

/**
 * One `__chkstk` call, translated, with `helpers` or through the body: rax the
 * size, the stack's top `AREA + 0x6000` in the area, the thread block at the
 * area's start, its limit `limit` past the area's.
 *
 * @param {{ window?: number, high: number }} where @param {number} size
 * @param {number} limit @param {false | object[]} helpers
 */
function runChkstk(where, size, limit, helpers){
    const m = machine({ ...where, config: { helpers } });
    const { high } = where;
    const flags = new Uint8Array(m.memory.buffer, pageFlagsAt(m.layout),
        (where.window ?? 2 ** 32) / 4096);
    const ram = new Uint8Array((m.ram ?? m.memory).buffer);
    const view = new DataView(m.memory.buffer);
    const from = AREA + high;
    flags.fill(0, from / 4096, (from + AREA_BYTES) / 4096);
    ram.fill(0x5a, from, from + AREA_BYTES);
    new DataView(ram.buffer).setBigUint64(from + 0x10, BigInt(from + limit), true);
    const program = [0x48, 0xb8, ...quad(size), 0xe8, ...quad(FUNCTION_OFFSET - 15).slice(0, 4),
        0xe9, ...quad(CHKSTK.length + FUNCTION_OFFSET - 20).slice(0, 4)];
    while (program.length < FUNCTION_OFFSET)
    {
        program.push(0x90);
    }
    const regs = Array.from({ length: 16 },
        (unused, i)=>(BigInt(i) * 0x1111111111111n).toString(16));
    regs[4] = BigInt(from + 0x6000).toString(16);
    load(m, { code: Buffer.from([...program, ...CHKSTK]).toString('hex'), regs, flags: 0,
        seed: 1, fresh: true });
    view.setBigUint64(/** @type {number} */ (m.layout.gsBase), BigInt(from), true);
    m.state.syncIn();
    const seen = run(m, true, 100000);
    return {
        fault: seen.fault, regs: seen.regs.filter((unused, i)=>i !== 0),
        rax: BigInt(`0x${seen.regs[0]}`) === BigInt(size) ? 'kept' : seen.regs[0],
        bytes: Buffer.from(ram.subarray(from, from + 0x5f00)).toString('base64'),
        retired: Number(seen.retired),
    };
}

for (const where of [{ high: 0 }, { window: 2 ** 33, high: 2 ** 32 }])
{
    test(`long mode's __chkstk${where.window === undefined ? '' : ' in a wide window'}: made as`
        + ' the operation as through the body', ()=>{
        const helpers = [{ name: '__chkstk', does: 'chkstk64', bits: 64, length: CHKSTK.length,
            hash: fingerprint(at=>CHKSTK[at] ?? 0, 0, CHKSTK.length) }];
        let formed = 0;
        let made = 0;
        for (const size of [0, 8, 0x1000, 0x2fff, 0x5800, 0x6000, 0x7000, 2 ** 40, 2 ** 63])
        {
            for (const limit of [0, 0x3000, 0x5800, 0x6000])
            {
                const { retired: bodyRetired, ...body } = runChkstk(where, size, limit, false);
                const { retired, ...seen } = runChkstk(where, size, limit, helpers);
                assert.deepEqual(seen, body, `rax ${size.toString(16)}, limit ${limit}`);
                assert.equal(body.rax, 'kept',
                    `rax ${size.toString(16)}, limit ${limit}: ${body.fault}`);
                if (retired < bodyRetired)
                {
                    formed++;
                }
                else
                {
                    made++;
                }
            }
        }
        assert.ok(formed > 8 && made > 8, `${formed} formed, ${made} made as they were`);
    });
}

/**
 * One call to long mode's `__security_check_cookie` of the dictionary's shape,
 * translated, with `helpers` or through the body: rcx `argument`, the cookie
 * `cookieValue` in the area, its report a `ud2`.
 *
 * @param {{ window?: number, high: number, codeHigh?: number }} where
 * @param {bigint} cookieValue @param {bigint} argument @param {false | object[]} helpers
 */
function runCookie(where, cookieValue, argument, helpers){
    const m = machine({ ...where, config: { helpers } });
    const { high } = where;
    const flags = new Uint8Array(m.memory.buffer, pageFlagsAt(m.layout),
        (where.window ?? 2 ** 32) / 4096);
    const ram = new Uint8Array((m.ram ?? m.memory).buffer);
    const from = AREA + high;
    flags.fill(0, from / 4096, (from + AREA_BYTES) / 4096);
    const cookieAt = from + 0x100;
    new DataView(ram.buffer).setBigUint64(cookieAt, cookieValue, true);
    const codeAt = CORPUS.codeAt + (where.codeHigh ?? 0);
    const fn = codeAt + FUNCTION_OFFSET;
    const report = fn + 0x40;
    const stub = [0x48, 0x3b, 0x0d, ...quad(cookieAt - (fn + 7)).slice(0, 4), 0x75, 0x10,
        0x48, 0xc1, 0xc1, 0x10, 0x66, 0xf7, 0xc1, 0xff, 0xff, 0x75, 0x01, 0xc3,
        0x48, 0xc1, 0xc9, 0x10, 0xe9, ...quad(report - (fn + 30)).slice(0, 4)];
    /** @type {number[]} */
    const program = [0x48, 0xb9, ...new Uint8Array(new BigUint64Array([argument]).buffer)];
    program.push(0xe8, ...quad(FUNCTION_OFFSET - (program.length + 5)).slice(0, 4));
    program.push(0xe9, ...quad(0x50 + FUNCTION_OFFSET - (program.length + 5)).slice(0, 4));
    while (program.length < FUNCTION_OFFSET)
    {
        program.push(0x90);
    }
    const code = [...program, ...stub];
    while (code.length < FUNCTION_OFFSET + 0x40)
    {
        code.push(0xcc);
    }
    code.push(0x0f, 0x0b);                                  // the report: ud2
    while (code.length < FUNCTION_OFFSET + 0x50)
    {
        code.push(0xcc);
    }
    const regs = Array.from({ length: 16 },
        (unused, i)=>(BigInt(i) * 0x1111111111111n).toString(16));
    regs[4] = BigInt(from + 0x6000).toString(16);
    load(m, { code: Buffer.from(code).toString('hex'), regs, flags: 0, seed: 1, fresh: true });
    const seen = run(m, true, 100000);
    return { fault: seen.fault, regs: seen.regs, rip: seen.rip, retired: Number(seen.retired) };
}

for (const where of [{ high: 0 }, { window: 2 ** 33, high: 2 ** 32, codeHigh: 2 ** 32 }])
{
    test(`long mode's __security_check_cookie${where.window === undefined ? ''
        : ' in a wide window'}: made as the test as through the body`, ()=>{
        const [entry] = CRT_DICTIONARY.filter(one=>one.does === 'gscookie64');
        let formed = 0;
        for (const [cookieValue, argument] of /** @type {[bigint, bigint][]} */ ([
            [0x00002b992ddfa232n, 0x00002b992ddfa232n], [0x00002b992ddfa232n, 0x00002b992ddfa233n],
            [0x12342b992ddfa232n, 0x12342b992ddfa232n], [0n, 0n], [0n, 1n << 63n]]))
        {
            const { retired: bodyRetired, ...body } = runCookie(where, cookieValue, argument,
                false);
            const { retired, ...seen } = runCookie(where, cookieValue, argument, [entry]);
            assert.deepEqual(seen, body, `cookie ${cookieValue}, rcx ${argument}`);
            formed += retired < bodyRetired ? 1 : 0;
        }
        assert.equal(formed, 2, 'the two calls whose rcx is the cookie, its high 16 bits clear');
    });
}

test('long mode\'s call through an import slot to a memset the dictionary knows is made as the'
    + ' operation, and calls whatever function the slot holds once it is written', ()=>{
    const codeAt = CORPUS.codeAt;
    const slot = AREA + 0x900;
    const target = AREA + 0x1000;
    const other = codeAt + FUNCTION_OFFSET - 1;       // a `ret` in the padding
    // Twice: memset(target, r12, 64) through the slot, then another function into the slot.
    const program = [0x41, 0xbc, ...quad(2).slice(0, 4)];               // mov r12d, 2
    const loop = program.length;
    program.push(0x48, 0xb9, ...quad(target), 0x4c, 0x89, 0xe2,         // rcx; rdx = r12
        0x49, 0xc7, 0xc0, 64, 0, 0, 0);                                 // mov r8, 64
    program.push(0xff, 0x15, ...quad(slot - (codeAt + program.length + 6)).slice(0, 4));
    program.push(0x48, 0xc7, 0x05, ...quad(slot - (codeAt + program.length + 11)).slice(0, 4),
        ...quad(other).slice(0, 4));                                    // mov qword [slot], other
    program.push(0x49, 0xff, 0xcc, 0x75, (loop - (program.length + 5)) & 0xff);  // dec; jnz
    const over = FUNCTION_OFFSET + FUNCTIONS.memset.length - (program.length + 5);
    program.push(0xe9, ...quad(over).slice(0, 4));
    while (program.length < FUNCTION_OFFSET - 1)
    {
        program.push(0x90);
    }
    program.push(0xc3);
    const code = Buffer.from([...program, ...FUNCTIONS.memset]).toString('hex');
    /** @param {false | object[]} helpers */
    const once = helpers=>{
        const m = machine({ config: { helpers } });
        const ram = new Uint8Array((m.ram ?? m.memory).buffer);
        const flags = new Uint8Array(m.memory.buffer, pageFlagsAt(m.layout), 2 ** 32 / 4096);
        flags.fill(0, AREA / 4096, (AREA + AREA_BYTES) / 4096);
        ram.fill(0, AREA, AREA + AREA_BYTES);
        new DataView(ram.buffer).setBigUint64(slot, BigInt(codeAt + FUNCTION_OFFSET), true);
        const regs = Array.from({ length: 16 }, ()=>'0');
        regs[4] = STACK.toString(16);
        load(m, { code, regs, flags: 0, seed: 1, fresh: true });
        const seen = run(m, true, 100000);
        return { fault: seen.fault, bytes: [...ram.subarray(target, target + 65)],
            retired: Number(seen.retired) };
    };
    const body = once(false);
    const made = once([entryOf('memset')]);
    assert.deepEqual(body.bytes, [...new Array(64).fill(2), 0], 'the first call fills, then none');
    assert.deepEqual({ ...made, retired: 0 }, { ...body, retired: 0 });
    assert.ok(made.retired < body.retired, `formed: ${made.retired} of ${body.retired} retired`);
});
