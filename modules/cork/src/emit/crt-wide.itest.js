/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of the C runtime's operations in a wide window (`emit/crt.js`,
 * `wideLayout`): long-mode calls to a memmove, memcpy, memset and strlen of
 * the test's own, made as the operation and through the function's body,
 * answer the same -- the result, the registers a callee keeps, the bytes,
 * the page marks, a fault -- with the data in the 4 GiB block past the first,
 * where every pointer's high half counts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CORPUS, load, machine, run } from '../testing/long-machine.js';
import { fingerprint } from '../helpers.js';
import { codeRangesAt, pageFlagsAt } from '../runtime/layout.js';
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
};

const WINDOW = 2 ** 33;
const HIGH = 2 ** 32;
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
 * @typedef {{ name: keyof typeof FUNCTIONS, args: number[], seed: number,
 *     watch: number[], code: number[], closed: number[] }} Case
 */

/**
 * Seeded cases: spans in the area, some overlapping, some reaching the closed
 * page past it, some over a watched page or a page of code.
 *
 * @param {keyof typeof FUNCTIONS} name @param {number} seed
 * @returns {Case}
 */
function caseOf(name, seed){
    const next = random(seed * 7919 + name.length);
    const int = (/** @type {number} */ n)=>Math.floor(next() * n);
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
    const c = { name, args: [], seed, watch: [], code: [], closed: [] };
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
        c.args = [src + HIGH];
        return c;
    }
    c.args = [dst + HIGH, name === 'memset' ? int(2 ** 32) * 2 ** 20 + int(256) : src + HIGH,
        length];
    return c;
}

/**
 * One case run translated, with the entries given formed as their operations
 * or (`false`) through the bodies.
 *
 * @param {Case} c @param {false | object[]} helpers
 */
function runCase(c, helpers){
    const m = machine({ window: WINDOW, high: HIGH, config: { helpers } });
    const flags = new Uint8Array(m.memory.buffer, pageFlagsAt(m.layout), WINDOW / 4096);
    const ranges = new Uint8Array(m.memory.buffer, codeRangesAt(m.layout), WINDOW / 4096 * 2);
    const ram = new Uint8Array(/** @type {WebAssembly.Memory} */ (m.ram).buffer);
    const from = AREA + HIGH;
    flags.fill(0, from / 4096, (from + AREA_BYTES) / 4096);
    const next = random(c.seed);
    for (let at = from; at < from + AREA_BYTES; at++)
    {
        // Strings of a few dozen bytes, a zero here and there.
        ram[at] = next() < 0.02 ? 0 : 1 + Math.floor(next() * 255);
    }
    for (const at of c.watch)
    {
        flags[(at + HIGH) / 4096 >>> 0] |= PageFlag.WATCH;
    }
    for (const at of c.code)
    {
        const page = (at + HIGH) / 4096 >>> 0;
        const granule = (at & 0xfff) >>> 5;
        flags[page] |= PageFlag.HAS_CODE;
        ranges[page * 2] = granule;
        ranges[page * 2 + 1] = granule + 1;
    }
    for (const at of c.closed)
    {
        flags[(at + HIGH) / 4096 >>> 0] = PageFlag.INACCESSIBLE;
    }
    const regs = Array.from({ length: 16 },
        (unused, i)=>(BigInt(i) * 0x1111111111111n).toString(16));
    regs[4] = (BigInt(STACK + HIGH)).toString(16);
    load(m, { code: codeOf(c.name, c.args), regs, flags: 0, seed: c.seed, fresh: true });
    const seen = run(m, true, 100000);
    // rax, and the registers a callee keeps: rbx, rsp, rbp, rsi, rdi, r12 to r15.
    const kept = [0, 3, 4, 5, 6, 7, 12, 13, 14, 15].map(i=>seen.regs[i]);
    return {
        fault: seen.fault, kept,
        // Not the stack below rsp, where the call left its return address.
        bytes: [...ram.subarray(SPANS + HIGH, from + AREA_BYTES)],
        marks: [...flags.subarray(from / 4096, (from + AREA_BYTES) / 4096 + 1)],
        retired: Number(seen.retired),
    };
}

for (const [name, does] of /** @type {const} */ ([['memmove', 'memmove'], ['memmove', 'memcpy'],
    ['memset', 'memset'], ['strlen', 'strlen']]))
{
    test(`a wide window's ${does}: seeded calls answer the same made as the operation as`
        + ' through the body', ()=>{
        const helpers = [entryOf(name, does)];
        let formed = 0;
        let made = 0;
        for (let seed = 1; seed <= 60; seed++)
        {
            const c = caseOf(name, seed);
            const { retired: bodyRetired, ...body } = runCase(c, false);
            const { retired, ...seen } = runCase(c, helpers);
            const { bytes: seenBytes, ...seenRest } = seen;
            const { bytes: bodyBytes, ...bodyRest } = body;
            assert.deepEqual(seenRest, bodyRest, `seed ${seed}: ${JSON.stringify(c)}`);
            const apart = seenBytes.findIndex((byte, i)=>byte !== bodyBytes[i]);
            assert.equal(apart, -1, `seed ${seed}: ${JSON.stringify(c)}, bytes apart from`
                + ` ${(SPANS + apart).toString(16)}`);
            // A store reaching translated code is the body's to make, which the
            // translation it overwrites is then left for.
            const [dst, , length = 0] = c.args;
            const hitsCode = name !== 'strlen' && c.code.some(at=>length > 0
                && (at & ~31) < dst - HIGH + length && (at & ~31) + 32 > dst - HIGH);
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
    });
}
