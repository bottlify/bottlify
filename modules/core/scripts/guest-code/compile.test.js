/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The compiler, on sources of its own: every form of the subset compiled and
 * run against the same JavaScript on cork's test machine, input by input, and
 * every form outside it refused with its place in the source.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestCodeError, compileModule } from './compile.mjs';
import { CALLBACK, DATA, doubleWords, equivalence, random } from './equivalence.mjs';

/** @param {string} text */
async function load(text){
    const url = `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`;
    const values = await import(url);
    /** @type {Record<string, any>} */
    const compiled = {};
    for (const fn of compileModule(text, { file: 'sample.js', values }))
    {
        compiled[fn.name] = fn;
    }
    return { values, compiled, ...equivalence(compiled, values) };
}

const SAMPLE = `
export const T8 = Uint8Array.from({ length: 16 }, (_, i)=>i * 7 + 1);
export const T16 = Int16Array.from({ length: 8 }, (_, i)=>(i - 4) * 1000);
export const T32 = Uint32Array.of(0, 0xffffffff, 0x80000000, 12345);
const K = 0x1234;
const half = x=>x >> 1;

/**
 * @guestCode cdecl
 * @param {i32} a @param {i32} b
 * @returns {i32}
 */
export function arith(a, b){
    const s = (a + b) | 0;
    const d = (a - b) | 0;
    const m = Math.imul(a, b);
    const x = (s ^ d) & (m | K);
    const shifted = (a << (b & 7)) ^ (a >> 3) ^ (a >>> (b & 31));
    return (x + shifted + half(a) + ~b + a * 3 - b * -5 - (-a)) | 0;
}

/**
 * @guestCode cdecl
 * @param {i32} a @param {i32} b @param {u32} c @param {u32} d
 * @returns {i32}
 */
export function compares(a, b, c, d){
    let r = 0;
    if (a < b) r |= 1;
    if (a <= b) r |= 2;
    if (a > b) r |= 4;
    if (a >= b) r |= 8;
    if (c < d) r |= 16;
    if (c <= d) r |= 32;
    if (c > d) r |= 64;
    if (c >= d) r |= 128;
    if (a === b) r |= 256;
    if (c !== d) r |= 512;
    if (a < 0 && c > 0x80000000 || !(b > -5)) r |= 1024;
    if (a) r |= 2048;
    return r;
}

/**
 * @guestCode stdcall
 * @param {any} guest @param {u32} p @param {u32} n
 * @returns {u32}
 */
export function loops({ u8, i8, u16, i16, u32, i32, setU8, setU16, setU32 }, p, n){
    /** @type {u32} */
    let sum = 0;
    for (/** @type {u32} */ let i = 0; i < n; i++)
    {
        const b = u8(p + i);
        if (b === 0x20)
        {
            continue;
        }
        if (b === 0xff)
        {
            break;
        }
        sum = (sum + T8[b & 15] + T16[(b >> 5) & 7] + i8(p + i) + (b > 127 ? 1 : 2)) >>> 0;
        setU8(p + 0x100 + i, b ^ 0x5a);
    }
    let j = 0;
    while (j < 4)
    {
        sum = (sum ^ T32[j]) >>> 0;
        j++;
    }
    do
    {
        j -= 1;
    } while (j > 0);
    setU16(p + 0x200, sum);
    setU32(p + 0x204, (sum + u16(p) + i16(p + 2) + u32(p + 4) + i32(p + 8)) | 0);
    return sum;
}

/**
 * @guestCode cdecl
 * @param {any} guest @param {f64} x @param {i32} k @param {u32} p
 * @returns {f64}
 */
export function doubles({ f64, f32, setF64 }, x, k, p){
    const y = f64(p);
    const z = f32(p + 8);
    setF64(p + 16, Math.trunc(x));
    setF64(p + 24, +k);
    setF64(p + 32, Math.ceil(y));
    setF64(p + 40, Math.floor(z));
    let best = x;
    if (y > best)
    {
        best = y;
    }
    if (z >= best)
    {
        best = z;
    }
    if (x !== x)
    {
        best = -1;
    }
    return x < 0 ? Math.abs(best) : -best;
}

/**
 * @guestCode cdecl
 * @param {x87} v
 * @returns {i64}
 */
export function ftol(v){
    return v;
}

/**
 * @guestCode stdcall
 * @param {x87} left @param {x87} right
 * @returns {i32}
 */
export function order(left, right){
    return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * @guestCode cdecl
 * @param {i32} a
 * @returns {i64}
 */
export function widen(a){
    return a;
}

/**
 * @guestCode cdecl
 * @param {u32} b
 * @returns {i64}
 */
export function widenUnsigned(b){
    return b;
}

/**
 * @guestCode cdecl
 * @param {any} guest @param {u32} d @param {u32} s @param {u32} n @param {u32} fn
 * @returns {i32}
 */
export function bulk({ copyUp, copyDown, fill, call, u8 }, d, s, n, fn){
    copyUp(d, s, n);
    copyDown(d + 3, d, n);
    fill(d + n + 8, 0x1ff, 5);
    call(fn, s, 1);
    return (call(fn, d, n) + call(fn, s, 3) + u8(d)) | 0;
}
`;

/** fn(p, k): the byte at p, times three, plus k -- and it writes k at p + 0x800. */
const CALLBACK_X86 = [
    0x8b, 0x4c, 0x24, 0x04,             // mov ecx, [esp+4]
    0x8b, 0x54, 0x24, 0x08,             // mov edx, [esp+8]
    0x88, 0x91, 0x00, 0x08, 0x00, 0x00, // mov [ecx+0x800], dl
    0x0f, 0xb6, 0x01,                   // movzx eax, byte [ecx]
    0x8d, 0x04, 0x40,                   // lea eax, [eax+eax*2]
    0x01, 0xd0,                         // add eax, edx
    0xc3,
];

/** @type {(memory: Uint8Array, fn: number, args: number[]) => number} */
const callbackJs = (memory, fn, [p, k])=>{
    assert.equal(fn, CALLBACK);
    memory[p + 0x800] = k & 0xff;
    return memory[p] * 3 + k | 0;
};

test('integer arithmetic, shifts and constants, as JavaScript computes them', async()=>{
    const { same } = await load(SAMPLE);
    const next = random(11);
    const edges = [0, 1, -1, 2, 7, 31, 32, 0x7fffffff, -0x80000000, 0x12345678, -12345];
    for (const a of edges)
    {
        for (const b of edges)
        {
            same('arith', { stack: [a >>> 0, b >>> 0] });
        }
    }
    for (let i = 0; i < 200; i++)
    {
        same('arith', { stack: [next(), next()] });
    }
});

test('comparisons, signed and unsigned, and conditions of && || !', async()=>{
    const { same } = await load(SAMPLE);
    const next = random(12);
    const edges = [0, 1, 0xffffffff, 0x80000000, 0x7fffffff, 0x80000001, 5, 0xfffffffb];
    for (const a of edges)
    {
        for (const b of edges)
        {
            same('compares', { stack: [a, b, b, a] });
            same('compares', { stack: [a, b, a, b] });
        }
    }
    for (let i = 0; i < 200; i++)
    {
        same('compares', { stack: [next(), next(), next(), next()] });
    }
});

test('loops, tables, the loads and the stores, stdcall', async()=>{
    const { same } = await load(SAMPLE);
    const next = random(13);
    for (let i = 0; i < 80; i++)
    {
        const bytes = Array.from({ length: 64 }, ()=>(next() % 7 === 0 ? 0x20 : next() & 0xff));
        if (i % 5 === 0)
        {
            bytes[next() % 64] = 0xff;
        }
        same('loops', { stack: [DATA, next() % 70], memory: [[DATA, bytes]] });
    }
});

test('doubles: loads, stores, comparisons, the roundings, and NaN', async()=>{
    const { same } = await load(SAMPLE);
    const next = random(14);
    const values = [0, -0, 1.5, -1.5, 2.5, -2.5, 1e300, -1e300, Infinity, -Infinity, NaN,
        5e-324, 0.1, -7.75];
    for (const x of values)
    {
        for (const y of values)
        {
            const memory = new Uint8Array(16);
            new DataView(memory.buffer).setFloat64(0, y, true);
            new DataView(memory.buffer).setFloat32(8, x / 3, true);
            for (const control of [0x37f, 0x07f, 0xc7f])
            {
                same('doubles', {
                    stack: [...doubleWords(x), next(), DATA], memory: [[DATA, memory]], control,
                });
            }
        }
    }
});

test('x87 arguments popped, and an i64 from a double and from each integer', async()=>{
    const { same } = await load(SAMPLE);
    const values = [0, -0.5, 3.75, -3.75, 2 ** 40 + 0.5, -(2 ** 62), 2 ** 63, -(2 ** 63), 1e20,
        NaN, Infinity, -Infinity];
    for (const v of values)
    {
        for (const control of [0x37f, 0x07f, 0xf7f])
        {
            same('ftol', { x87: [v], control });
            for (const w of values)
            {
                same('order', { x87: [v, w], control });
            }
        }
    }
    for (const a of [0, 1, 0xffffffff, 0x80000000, 0x7fffffff])
    {
        same('widen', { stack: [a] });
        same('widenUnsigned', { stack: [a] });
    }
});

test('copies up and down, over themselves, a fill, and calls through a pointer', async()=>{
    const { same } = await load(SAMPLE);
    const next = random(15);
    for (let i = 0; i < 60; i++)
    {
        const bytes = Array.from({ length: 96 }, ()=>next() & 0xff);
        const s = DATA + next() % 32;
        const d = DATA + next() % 64;
        same('bulk', { stack: [d, s, next() % 40, CALLBACK], memory: [[DATA, bytes]] },
            { callback: CALLBACK_X86, call: callbackJs });
    }
});

const TAGS = '@param {i32} a @param {u32} c @param {f64} x\n * @returns {i32}';

/**
 * @param {string} params  The parameter list.
 * @param {string} body
 * @param {string} [tags]  The JSDoc lines after the tag.
 */
const one = (params, body, tags = TAGS)=>
    `export const TABLE = Uint8Array.of(1);\nconst local = Uint8Array.of(1);\n/**\n`
    + ` * @guestCode cdecl\n * ${tags}\n */\nexport function f(${params}){\n    ${body}\n}\n`;

/** @param {string} text @param {RegExp} message */
function refused(text, message){
    const values = { TABLE: Uint8Array.of(1) };
    assert.throws(()=>compileModule(text, { file: 'sample.js', values }),
        (/** @type {any} */ e)=>{
            assert.ok(e instanceof GuestCodeError, `a GuestCodeError, not ${e}`);
            assert.match(e.message, /^sample\.js:\d+:\d+: /, 'names its place');
            assert.match(e.message, message);
            return true;
        });
}

test('everything outside the subset is refused where it is written', ()=>{
    const p = 'a, c, x';
    refused(one(p, 'return ({ a }).a;'), /member is read only from a table/);
    refused(one(p, 'const list = [a];\n    return 0;'), /an array is not in the subset/);
    refused(one(p, 'return \'a\';'), /is not a number/);
    refused(one(p, 'const g = ()=>a;\n    return 0;'), /a closure is not in the subset/);
    refused(one(p, 'return await a;'), /await|reserved|Unexpected/);
    refused(one(p, 'return a / 2 | 0;'), /no division/);
    refused(one(p, 'return a + 1;'), /brought back to 32 bits/);
    refused(one(p, 'return a < c ? 1 : 0;'), /signed value compared with an unsigned/);
    refused(one(p, 'return Math.imul(a, c) * a;'), /Math\.imul/);
    refused(one(p, 'return other(a);'), /not a helper/);
    refused(one(p, 'return a == 1 ? 1 : 0;'), /is written ===/);
    refused(one(p, 'return (x + 1) < 2 ? 1 : 0;'), /no double arithmetic/);
    refused(one(p, 'return u8(a);'), /taken from the guest in the first parameter/);
    refused(one(p, 'return local[a];'), /not an exported module-level typed array/);
    refused(one(p, 'if (a) return 1;'), /can reach its end without a return/);
    refused(one(p, 'return TABLE[a] === 1;'), /condition, not a value/);
    refused(one(p, 'for (const k of [a]) { return k; }\n    return 0;'), /for\.\.\.of/);
    refused(one(p, 'let s = a;\n    s = c;\n    return s;'), /s is i32, and this is u32/);
    refused(one('{ u9 }, a, c, x', 'return 0;'), /the guest's helpers are/);
    refused(one('a, c, x, y', 'return 0;'), /@param \{i32 \| u32 \| f64 \| x87\} y is wanted/);
    refused(one(p, 'return 0;').replace('@guestCode cdecl', '@guestCode'),
        /names its convention/);
    refused(one(p, 'return a;', '@param {i32} a @param {u32} c @param {f64} x\n * @returns {f32}'),
        /is not i32, u32, f64, i64 or void/);
});
