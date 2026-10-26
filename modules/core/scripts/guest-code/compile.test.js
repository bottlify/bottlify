/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The compiler, on sources of its own: every form of the subset compiled and
 * run against the same JavaScript on cork's test machine, input by input, and
 * every form outside it refused with its place in the source. Each function
 * the x86-64 back end takes runs as x86-64 too, on cork's long-mode machine,
 * against the same JavaScript (`equivalence`'s 64-bit run).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestCodeError, compileModule } from './compile.mjs';
import { CALLBACK, DATA, doubleWords, equivalence, random } from './equivalence.mjs';
import { loadModel } from './model.mjs';

/** Where a source imports `X87` from, absolute: the samples are modules of no directory. */
const X87_MODULE = new URL('../../src/layers/win32/msvcrt/x87.js', import.meta.url).href;

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
    /** @type {Record<string, any>} */
    const long = {};
    /** @type {Record<string, string>} */
    const refusedAt64 = {};
    for (const fn of compileModule(text, { file: 'sample.js', values, bits: 64,
        onRefused: (name, reason)=>{
            refusedAt64[name] = reason;
        } }))
    {
        long[fn.name] = fn;
    }
    const model = await loadModel(text, { file: 'sample.js', url: X87_MODULE, values });
    return { values, compiled, long, refusedAt64, model,
        ...equivalence(compiled, values, model, long) };
}

/** The control words a double is computed under: double, extended, single, and two roundings. */
const CONTROLS = [0x27f, 0x37f, 0x07f, 0x77f, 0xf7f];

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
 * @guestCode stdcall
 * @param {any} guest @param {u32} p @param {i32} k
 * @returns {i32}
 */
export function handOver({ u8, setU8, host }, p, k){
    if (k < 0)
    {
        return host();
    }
    let sum = 0;
    for (let i = 0; i < k; i++)
    {
        const b = u8(p + i);
        if (b === 0xff)
        {
            return host();
        }
        sum = (sum + T8[b & 15]) | 0;
    }
    if (sum > 400)
    {
        return host();
    }
    setU8(p + 0x100, sum);
    return sum;
}

/**
 * Parameters assigned before the call is handed over, one left in the frame
 * by the variables that take the registers and a double: the handler is
 * handed the arguments the call came with.
 *
 * @guestCode cdecl
 * @param {any} guest @param {u32} p @param {i32} a @param {f64} x @param {i32} b
 * @returns {i32}
 */
export function assignedThenHost({ u8, host }, p, a, x, b){
    let s0 = 0;
    let s1 = 0;
    let s2 = 0;
    let s3 = 0;
    let s4 = 0;
    for (let i = 0; i < 8; i++)
    {
        s0 = (s0 + u8(p + i)) | 0;
        s1 = (s1 ^ u8(p + i + 1)) | 0;
        s2 = (s2 + s0) | 0;
        s3 = (s3 + s1) | 0;
        s4 = (s4 ^ s2 ^ s3) | 0;
    }
    a = (a + 1) | 0;
    x = -x;
    if (b === 0 || x > 0)
    {
        return host();
    }
    return (a + s0 + s1 + s2 + s3 + s4) | 0;
}

/**
 * More variables live at once than there are registers to give, in loops
 * nested three deep, each changed every turn and all of them answered.
 *
 * @guestCode cdecl
 * @param {any} guest @param {u32} p @param {u32} n @param {i32} seed
 * @returns {i32}
 */
export function crowd({ u8, setU32 }, p, n, seed){
    let a = seed;
    let b = (seed ^ 0x5555) | 0;
    let c = 7;
    let d = -3;
    let e = 0;
    /** @type {u32} */
    let f = n;
    let g = (seed >> 3) | 0;
    let h = 1;
    for (/** @type {u32} */ let i = 0; i < n; i++)
    {
        const x = u8(p + i);
        for (let j = 0; j < 3; j++)
        {
            a = (a + x + j) | 0;
            b = (b ^ a) | 0;
            for (let k = j; k < 4; k++)
            {
                c = (c + Math.imul(b, k) + d) | 0;
                if ((c & 3) === 0)
                {
                    continue;
                }
                d = (d - c + e) | 0;
            }
            e = (e + (a >> 2)) | 0;
        }
        f = (f + i) >>> 0;
        g = (g - i) | 0;
        g = (g ^ (x << (i & 7))) | 0;
        h = (Math.imul(h, 31) + g) | 0;
        if (x === 0xff)
        {
            break;
        }
    }
    setU32(p + 0x100, a);
    setU32(p + 0x104, b);
    setU32(p + 0x108, c);
    setU32(p + 0x10c, d);
    setU32(p + 0x110, e);
    setU32(p + 0x114, f);
    setU32(p + 0x118, g);
    return (h + a - b + c - d + e) | 0;
}

/**
 * Variables that must outlive a call through a pointer, which may change
 * EAX, ECX and EDX -- the callee's -- and not EBX, ESI or EDI; with a table,
 * which takes EBX.
 *
 * @guestCode stdcall
 * @param {any} guest @param {u32} p @param {u32} n @param {u32} fn
 * @returns {i32}
 */
export function across({ u8, call }, p, n, fn){
    let sum = 0;
    let last = 0;
    /** @type {u32} */
    let at = p;
    for (/** @type {u32} */ let i = 0; i < n; i++)
    {
        const before = (sum ^ T8[i & 15]) | 0;
        const got = call(fn, at, i);
        sum = (sum + got + before) | 0;
        last = (got - last + u8(at + 1)) | 0;
        at = (at + 3) >>> 0;
    }
    return (sum ^ last) | 0;
}

/**
 * More variables live across a call than the callee keeps registers for.
 *
 * @guestCode cdecl
 * @param {any} guest @param {u32} p @param {u32} n @param {u32} fn
 * @returns {i32}
 */
export function acrossMany({ call }, p, n, fn){
    let a = 1;
    let b = 2;
    let c = 3;
    let d = 4;
    let e = 5;
    for (/** @type {u32} */ let i = 0; i < n; i++)
    {
        a = (a + call(fn, p, i)) | 0;
        b = (b ^ a) | 0;
        c = (c + b + i) | 0;
        d = (d - c) | 0;
        e = (e + d + a) | 0;
    }
    return (a + b + c + d + e) | 0;
}

/**
 * Ordered comparisons of variables in registers with variables in the
 * frame, either way round: more of them than there are registers.
 *
 * @guestCode cdecl
 * @param {i32} a @param {i32} b @param {i32} c @param {u32} d @param {u32} e @param {u32} f
 * @param {i32} g
 * @returns {i32}
 */
export function ranks(a, b, c, d, e, f, g){
    let r = 0;
    for (let i = 0; i < 3; i++)
    {
        if (a < b) r = (r + 1) | 0;
        if (b <= c) r = (r + 2) | 0;
        if (c > a) r = (r + 4) | 0;
        if (g >= a) r = (r + 8) | 0;
        if (d < e) r = (r + 16) | 0;
        if (e > f) r = (r + 32) | 0;
        if (f <= d) r = (r + 64) | 0;
        if (g < c) r = (r + 128) | 0;
        if (b > g) r = (r + 256) | 0;
        if (e <= d) r = (r + 512) | 0;
        a = (a + g) | 0;
        d = (d + f) >>> 0;
    }
    return r;
}

/**
 * Bytes stored from more variables than there are registers with a low byte
 * of their own: one of them in ESI or EDI, which have none.
 *
 * @guestCode cdecl
 * @param {any} guest @param {u32} p @param {u32} n
 */
export function rotate({ u8, setU8 }, p, n){
    /** @type {u32} */
    let at = p;
    const end = (p + Math.imul(n, 3)) >>> 0;
    while (at < end)
    {
        const a = u8(at);
        const b = u8(at + 1);
        const c = u8(at + 2);
        setU8(at, c);
        setU8(at + 1, a);
        setU8(at + 2, b);
        setU8(at + 0x100, a);
        setU8(at + 0x101, b);
        setU8(at + 0x102, c);
        at = (at + 3) >>> 0;
    }
}

/**
 * An x87 parameter read once, after the integers: where the caller left it.
 *
 * @guestCode cdecl
 * @param {any} guest @param {x87} v @param {u32} p
 * @returns {i64}
 */
export function lateRead({ u8, setU8 }, v, p){
    const b = u8(p);
    setU8(p + 1, b + 1);
    return v;
}

/**
 * The same read behind a branch, and after another double: popped at entry.
 *
 * @guestCode cdecl
 * @param {any} guest @param {x87} v @param {u32} p
 * @returns {i64}
 */
export function branchRead({ u8, f64 }, v, p){
    if (u8(p) === 0)
    {
        return 0;
    }
    if (f64(p + 8) < 0)
    {
        return 1;
    }
    return v;
}

/**
 * @guestCode cdecl
 * @param {any} guest @param {u32} d @param {u32} s @param {u32} n @param {u32} fn
 * @returns {i32}
 */
export function bulk({ copyUp, copyDown, fill, call, u8 }, d, s, n, fn){
    copyUp(d, s, n);
    copyDown(d + 3, d, n);
    copyDown(s, (s + (n & 3)) >>> 0, n);
    fill(d + n + 8, 0x1ff, 5);
    call(fn, s, 1);
    return (call(fn, d, n) + call(fn, s, 3) + u8(d)) | 0;
}

/**
 * Calls of a stdcall function, which pops its own arguments: in a loop, with
 * arguments to evaluate and with plain ones, the frame where it was after each.
 *
 * @guestCode stdcall
 * @param {any} guest @param {u32} p @param {u32} n @param {u32} fn
 * @returns {i32}
 */
export function stdcalls({ callStd, u8 }, p, n, fn){
    let sum = 0;
    for (let i = 0; i < (n | 0); i++)
    {
        sum = (sum + callStd(fn, (p + i) >>> 0, i)) | 0;
    }
    const k = (u8(p) + n) | 0;
    return (sum + callStd(fn, p, k) + u8(p + 1)) | 0;
}

`;

/** Doubles and floats, with X87 from where the samples cannot name it relatively. */
const FLOATS = `import { X87 } from '${X87_MODULE}';

/** A module-level function of a double, inlined with its argument read where it is. */
const twice = v=>v + v * 1;

/**
 * A double's arithmetic in each of its forms: the memory operand on the
 * right and, reversed, on the left; both on the stack; integers in the
 * frame and in registers; constants special, a float's and not.
 *
 * @guestCode cdecl
 * @param {f64} x @param {f64} y @param {i32} k @param {u32} u
 * @returns {f64}
 */
export function arithmetic(x, y, k, u){
    const a = x - y;
    const b = 2.5 - x * y;
    const c = (x + 1) / (y - 3);
    const d = k / y - y / k;
    const e = 0.1 * (a - b) / (c * c + 1e-3);
    const f = -(x * 0.5) + (y - -0) * 3 - k + u / 7;
    const g = ((k + 1) | 0) * x - x / (k | 1) - (u - x) / 1.25 + twice(y);
    return (a * b - c) / (d + 2) + e * f + g * (1 - a) - (-1 - b) / (0.75 + c);
}

/**
 * Remainders, which are exact under any control word, and division of
 * integers, which is a double's.
 *
 * @guestCode stdcall
 * @param {f64} x @param {f64} y @param {i32} a @param {i32} b
 * @returns {f64}
 */
export function remainders(x, y, a, b){
    return x % y + (x * 3) % (y + 1) - -x % 2.5 + a / b + ((a & 7) === 0 ? a / 3 : b / a) + b % y;
}

/**
 * The transcendentals: an argument kept below 2^63 for the three that need it.
 *
 * @guestCode cdecl
 * @param {f64} x @param {f64} y
 * @returns {f64}
 */
export function transcendentals(x, y){
    const s = Math.abs(x) < 2 ** 63 ? Math.sin(x) : 0;
    const c = Math.abs(x) < 2 ** 63 ? Math.cos(x) : 0;
    const t = Math.abs(x) < 2 ** 63 ? Math.tan(x) : 0;
    return Math.sqrt(Math.abs(y)) + s * 3 - c + t / 2 + Math.atan(x) - Math.atan2(y, x)
        + Math.atan2(x * y, -1) + Math.log2(Math.abs(y) + 1) + Math.sqrt(x * x + y * y);
}

/**
 * The x87's own operations, through X87.
 *
 * @guestCode cdecl
 * @param {f64} x @param {f64} y
 * @returns {f64}
 */
export function intrinsics(x, y){
    const t = x * X87.L2E;
    const n = X87.rint(t);
    const p = X87.scale(X87.f2xm1(t - n) + 1, n);
    const l = X87.yl2x(X87.LN2, Math.abs(y) + 0.5) + X87.yl2x(y, X87.PI) * X87.LG2 - X87.L2T;
    const e = Math.abs(y) <= 1e308 ? X87.exponent(y) - X87.significand(y) : 0;
    return p + l + e - X87.significand(x) * X87.rint(y * 0.5) + X87.scale(y, x);
}

/**
 * A double brought to an integer, in range and past it.
 *
 * @guestCode cdecl
 * @param {f64} x @param {i32} k
 * @returns {i32}
 */
export function conversions(x, k){
    const whole = x | 0;
    const wrapped = (x * 1e10) >>> 0;
    const third = (x / 3 + k) | 0;
    return (whole ^ wrapped ^ third ^ (k / 7 | 0) ^ (Math.floor(x) >>> 0)) | 0;
}

/**
 * Floats: an f32 argument, loads, stores, variables, negated, and a float result.
 *
 * @guestCode stdcall
 * @param {any} guest @param {u32} p @param {f32} s
 * @returns {f32}
 */
export function floats({ f32, setF32, setF64 }, p, s){
    const a = f32(p);
    /** @type {f32} */
    let b = Math.fround(a * s);
    setF32(p + 4, a + s * f32(p + 8));
    setF32(p + 12, b);
    b = Math.fround(b - 1);
    setF64(p + 16, a / 3 + -b * f32(p + 8) - -f32(p + 4));
    setF32(p + 24, f32(p + 8) * f32(p) - f32(p + 4) / s);
    return a > b ? Math.fround(a + b) : b;
}

/**
 * Deep: more doubles live at once than a left-deep sum keeps.
 *
 * @guestCode cdecl
 * @param {f64} x @param {f64} y
 * @returns {f64}
 */
export function deep(x, y){
    return (x - (y - (x * (y + (x / (y - (x + (y * 0.5)))))))) / (1 + (x - (y + 2)));
}

/**
 * Integers each read once, left in the frame: the x87's integer operands.
 *
 * @guestCode cdecl
 * @param {f64} x @param {i32} a @param {i32} b @param {i32} c @param {u32} d
 * @returns {f64}
 */
export function mixed(x, a, b, c, d){
    return x * a + b / x - c + (d - x);
}

/**
 * A negative zero's constant, where its sign decides the sum.
 *
 * @guestCode cdecl
 * @param {f64} x
 * @returns {f64}
 */
export function negativeZero(x){
    return x === 0 ? -0 : twice(x - -0);
}

/**
 * Number.isNaN, a condition: in an if, a conditional and a negation.
 *
 * @guestCode cdecl
 * @param {f64} x @param {f64} y
 * @returns {i32}
 */
export function nans(x, y){
    if (Number.isNaN(x))
    {
        return 1;
    }
    return Number.isNaN(x * y) ? 2 : !Number.isNaN(y) && x < y ? 3 : 4;
}

/**
 * x87 arguments handed to the host as they came, one of them assigned first.
 *
 * @guestCode cdecl
 * @param {any} guest @param {x87} v @param {x87} w
 * @returns {f64}
 */
export function x87HandOver({ host }, v, w){
    const product = v * w;
    v = v + 1;
    if (w === 0 || !(product < 1e300))
    {
        return host();
    }
    return product - v;
}

/**
 * One x87 argument handed over from ST0's read: popped at entry after all.
 *
 * @guestCode cdecl
 * @param {any} guest @param {x87} v
 * @returns {f64}
 */
export function x87Root({ host }, v){
    if (v < 0)
    {
        return host();
    }
    return Math.sqrt(v);
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

/** The same callback, stdcall: it pops its two arguments. */
const CALLBACK_STD_X86 = [...CALLBACK_X86.slice(0, -1), 0xc2, 0x08, 0x00];

/**
 * The same callback in x86-64, p in RCX and k in RDX, doing what the x64
 * convention lets a callee do: it writes its home space, changes every
 * register the caller may not count on and leaves a pattern above EAX in
 * RAX, and faults (`ud2`) where RSP was not a multiple of 16 at the call.
 */
const CALLBACK_X64 = [
    0x49, 0x89, 0xe2,                                   // mov r10, rsp
    0x41, 0x83, 0xe2, 0x0f,                             // and r10d, 15
    0x41, 0x83, 0xfa, 0x08,                             // cmp r10d, 8
    0x74, 0x02,                                         // je past the ud2
    0x0f, 0x0b,                                         // ud2
    0x48, 0x89, 0x4c, 0x24, 0x08,                       // mov [rsp+8], rcx
    0x48, 0x89, 0x54, 0x24, 0x10,                       // mov [rsp+16], rdx
    0x4c, 0x89, 0x44, 0x24, 0x18,                       // mov [rsp+24], r8
    0x4c, 0x89, 0x4c, 0x24, 0x20,                       // mov [rsp+32], r9
    0x88, 0x91, 0x00, 0x08, 0x00, 0x00,                 // mov [rcx+0x800], dl
    0x0f, 0xb6, 0x01,                                   // movzx eax, byte [rcx]
    0x8d, 0x04, 0x40,                                   // lea eax, [rax+rax*2]
    0x01, 0xd0,                                         // add eax, edx
    0x49, 0xbb, 0, 0, 0, 0, 0xad, 0xde, 0, 0,           // mov r11, 0xdead00000000
    0x4c, 0x09, 0xd8,                                   // or rax, r11
    0x48, 0xc7, 0xc1, 0xff, 0xff, 0xff, 0xff,           // mov rcx, -1
    0x48, 0xc7, 0xc2, 0xff, 0xff, 0xff, 0xff,           // mov rdx, -1
    0x49, 0xc7, 0xc0, 0xff, 0xff, 0xff, 0xff,           // mov r8, -1
    0x49, 0xc7, 0xc1, 0xff, 0xff, 0xff, 0xff,           // mov r9, -1
    0x49, 0xc7, 0xc2, 0xff, 0xff, 0xff, 0xff,           // mov r10, -1
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
    for (let i = 0; i < 400; i++)
    {
        const bytes = Array.from({ length: 96 }, ()=>next() & 0xff);
        const s = DATA + 8 + next() % 32;
        // Half the copies with their ends within four bytes of each other,
        // where a dword read differs from a byte read.
        const d = i % 2 === 0 ? s + next() % 9 - 4 : DATA + next() % 64;
        same('bulk', { stack: [d, s, next() % 40, CALLBACK], memory: [[DATA, bytes]] },
            { callback: CALLBACK_X86, callback64: CALLBACK_X64, call: callbackJs });
    }
});

test('calls of a stdcall function leave the frame where the callee popped it', async()=>{
    const { same } = await load(SAMPLE);
    const next = random(16);
    for (let i = 0; i < 200; i++)
    {
        const bytes = Array.from({ length: 96 }, ()=>next() & 0xff);
        same('stdcalls', { stack: [DATA + next() % 32, next() % 9, CALLBACK],
            memory: [[DATA, bytes]] },
        { callback: CALLBACK_STD_X86, callback64: CALLBACK_X64, call: callbackJs });
    }
});

test('more variables live than registers, across three loops, and all of them answered',
    async()=>{
        const { same } = await load(SAMPLE);
        const next = random(17);
        for (let i = 0; i < 120; i++)
        {
            const bytes = Array.from({ length: 64 },
                ()=>(next() % 50 === 0 ? 0xff : next() & 0xff));
            const n = [0, 1, 2, 5, 40, 64, next() % 65][i % 7];
            same('crowd', { stack: [DATA, n, next()], memory: [[DATA, bytes]] });
        }
    });

test('ordered comparisons of registers and the frame, either way round', async()=>{
    const { same } = await load(SAMPLE);
    const next = random(20);
    const edges = [0, 1, 0xffffffff, 0x80000000, 0x7fffffff, 5];
    for (let i = 0; i < 300; i++)
    {
        const pick = ()=>(next() % 3 === 0 ? edges[next() % edges.length] : next());
        same('ranks', { stack: Array.from({ length: 7 }, pick) });
    }
});

test('more variables across calls than the callee keeps registers for', async()=>{
    const { same } = await load(SAMPLE);
    const next = random(21);
    for (let i = 0; i < 40; i++)
    {
        same('acrossMany', { stack: [DATA + next() % 16, next() % 20, CALLBACK],
            memory: [[DATA, Array.from({ length: 64 }, ()=>next() & 0xff)]] },
        { callback: CALLBACK_X86, callback64: CALLBACK_X64, call: callbackJs });
    }
});

test('bytes stored from registers with a low byte of their own and from those without',
    async()=>{
        const { same } = await load(SAMPLE);
        const next = random(19);
        for (let i = 0; i < 40; i++)
        {
            const bytes = Array.from({ length: 96 }, ()=>next() & 0xff);
            same('rotate', { stack: [DATA + next() % 8, next() % 30], memory: [[DATA, bytes]] });
        }
    });

test('variables kept across calls through a pointer, which may change EAX, ECX and EDX',
    async()=>{
        const { same } = await load(SAMPLE);
        const next = random(18);
        for (let i = 0; i < 80; i++)
        {
            const bytes = Array.from({ length: 128 }, ()=>next() & 0xff);
            same('across', { stack: [DATA + next() % 16, next() % 30, CALLBACK],
                memory: [[DATA, bytes]] },
            { callback: CALLBACK_X86, callback64: CALLBACK_X64, call: callbackJs });
        }
    });

test('an x87 parameter read once where the caller left it, and one popped at entry',
    async()=>{
        const { same, compiled } = await load(SAMPLE);
        // Nothing before the read: truncated from ST0 as it stands, no frame.
        assert.deepEqual([...compiled.ftol.code],
            [0x83, 0xec, 0x08, 0xdd, 0x0c, 0x24, 0x58, 0x5a, 0xc3]);
        const values = [0, -0.5, 3.75, -3.75, 2 ** 40 + 0.5, 2 ** 63, NaN, -Infinity];
        for (const v of values)
        {
            for (const control of [0x37f, 0x07f, 0xf7f])
            {
                for (const [first, double] of [[0, 1.5], [7, -2], [0xff, NaN], [1, 0]])
                {
                    const memory = new Uint8Array(16);
                    memory[0] = first;
                    new DataView(memory.buffer).setFloat64(8, double, true);
                    same('lateRead', { stack: [DATA], x87: [v], control,
                        memory: [[DATA, memory]] });
                    same('branchRead', { stack: [DATA], x87: [v], control,
                        memory: [[DATA, memory]] });
                }
            }
        }
    });

test('a call handed to the host: the frame down, the stack and the kept registers as they came',
    async()=>{
        const { same } = await load(SAMPLE);
        const next = random(16);
        /** @type {(memory: Uint8Array, args: number[]) => number} */
        const host = (memory, [p, k])=>{
            memory[p + 0x200] = 0x77;
            return (k ^ 0x5eed) | 0;
        };
        let handed = 0;
        for (let i = 0; i < 200; i++)
        {
            const bytes = Array.from({ length: 64 },
                ()=>(next() % 40 === 0 ? 0xff : next() & 0xff));
            const k = [-1, 0, 1, 64, next() % 65, (next() | 0x80000000) | 0][i % 6];
            const js = same('handOver', { stack: [DATA, k >>> 0], memory: [[DATA, bytes]] },
                { host });
            handed += js.handedOver ? 1 : 0;
        }
        assert.ok(handed > 20 && handed < 180, `${handed} of 200 handed over: both ways taken`);
    });

test('a parameter assigned before the call is handed over: the handler gets the call\'s own',
    async()=>{
        const { same } = await load(SAMPLE);
        const next = random(22);
        /** @type {(memory: Uint8Array, args: number[]) => number} */
        const host = (memory, [p, a, low, high, b])=>(p ^ a ^ low ^ high ^ b) | 0;
        let handed = 0;
        for (let i = 0; i < 40; i++)
        {
            const bytes = Array.from({ length: 16 }, ()=>next() & 0xff);
            const x = [1.5, -2, -0, 1e300][i % 4];
            const js = same('assignedThenHost', { stack: [DATA, next(), ...doubleWords(x),
                i % 3 === 0 ? 0 : next()], memory: [[DATA, bytes]] }, { host });
            handed += js.handedOver ? 1 : 0;
        }
        assert.ok(handed > 10 && handed < 40, `${handed} of 40 handed over: both ways taken`);
    });

/**
 * Doubles to compute with: the edges -- zeros, infinities, NaN, the largest,
 * a denormal, 2^63 -- and random ones, of every exponent and of small ones.
 *
 * @param {number} seed @param {number} count
 */
function doubleInputs(seed, count){
    const next = random(seed);
    const values = [0, -0, 1, -1, 0.5, -2.5, 3, 1e-300, -1e300, 1e300, 2 ** 63, -(2 ** 64),
        5e-324, Infinity, -Infinity, NaN, 0.1, 1 / 3, 123456.789, -7.75];
    for (let i = 0; i < count; i++)
    {
        const view = new DataView(new ArrayBuffer(8));
        view.setUint32(0, next(), true);
        view.setUint32(4, next(), true);
        values.push(i % 3 === 0 ? view.getFloat64(0, true)
            : (next() - 2 ** 31) / 2 ** (next() % 48));
    }
    return values;
}

test('a double\'s arithmetic as JavaScript computes it, and as the x87 rounds it under single '
    + 'precision', async()=>{
    const { same } = await load(FLOATS);
    const next = random(23);
    const values = doubleInputs(24, 16);
    for (const control of CONTROLS)
    {
        for (let i = 0; i < 120; i++)
        {
            const x = values[next() % values.length];
            const y = values[next() % values.length];
            const k = [0, 1, -1, 7, next() | 0][i % 5];
            same('arithmetic', { stack: [...doubleWords(x), ...doubleWords(y), k >>> 0,
                i % 4 === 0 ? 0x80000001 : next()], control });
            same('remainders', { stack: [...doubleWords(x), ...doubleWords(y), k >>> 0,
                i % 3 === 0 ? 0 : next() % 1000 - 500 >>> 0], control });
            same('deep', { stack: [...doubleWords(x), ...doubleWords(y)], control });
        }
    }
});

test('integers in the frame as the x87\'s operands, and a negative zero\'s constant', async()=>{
    const { same } = await load(FLOATS);
    const next = random(31);
    const values = doubleInputs(32, 10);
    for (const control of CONTROLS)
    {
        for (const x of values)
        {
            same('mixed', { stack: [...doubleWords(x), next(), next() % 100, next(),
                next() | 0x80000000], control });
            same('negativeZero', { stack: doubleWords(x), control });
            for (const y of [NaN, 0, Infinity, 1.5])
            {
                same('nans', { stack: [...doubleWords(x), ...doubleWords(y)], control });
            }
        }
        for (const x of [-0, 0])
        {
            same('negativeZero', { stack: doubleWords(x), control });
        }
    }
});

test('the transcendentals and X87\'s own operations, under each control word', async()=>{
    const { same } = await load(FLOATS);
    const next = random(25);
    const values = doubleInputs(26, 16);
    for (const control of CONTROLS)
    {
        for (let i = 0; i < 100; i++)
        {
            const x = values[next() % values.length];
            const y = values[next() % values.length];
            same('transcendentals', { stack: [...doubleWords(x), ...doubleWords(y)], control });
            // f2xm1 takes [-1, 1]: t - rint(t) is within it for t below 2^52.
            const small = (next() - 2 ** 31) / 2 ** (next() % 30 + 20);
            same('intrinsics', { stack: [...doubleWords(small), ...doubleWords(y)], control });
        }
    }
});

test('a double to an integer as | 0 and >>> 0 bring one, past fisttp\'s range too', async()=>{
    const { same } = await load(FLOATS);
    const next = random(27);
    const values = [...doubleInputs(28, 40), 2 ** 31, -(2 ** 31) - 0.5, 2 ** 32 + 5, 2 ** 63,
        -(2 ** 63), 2 ** 63 + 2 ** 11, 2 ** 70 + 2 ** 40 * 3, 2 ** 84 + 2 ** 33,
        -(2 ** 80) - 2 ** 30,
        1.7976931348623157e308];
    for (const control of CONTROLS)
    {
        for (const x of values)
        {
            same('conversions', { stack: [...doubleWords(x), next() % 200 - 100 >>> 0], control });
        }
    }
});

test('floats: an f32 argument, float loads and stores, float variables and result', async()=>{
    const { same } = await load(FLOATS);
    const next = random(29);
    const view = new DataView(new ArrayBuffer(4));
    /** A float's bits: edges, then random ones of every exponent but NaN's. */
    const float = (/** @type {number} */ i)=>{
        const edges = [0, 1, -2.5, 3.4028234663852886e38, 1.401298464324817e-45, -0.1, 16777217];
        if (i < edges.length)
        {
            view.setFloat32(0, edges[i], true);
            return view.getUint32(0, true);
        }
        const bits = next();
        return (bits & 0x7f800000) === 0x7f800000 ? bits & 0xbfffffff : bits;
    };
    for (const control of CONTROLS)
    {
        for (let i = 0; i < 60; i++)
        {
            const memory = new Uint8Array(32);
            const data = new DataView(memory.buffer);
            data.setUint32(0, float(i % 7 === 0 ? i / 7 : 100), true);
            data.setUint32(8, float(100), true);
            same('floats', { stack: [DATA, float(i % 5 === 0 ? i / 5 : 100)],
                memory: [[DATA, memory]], control });
        }
    }
});

test('x87 arguments handed to the host where the call left them, one assigned first',
    async()=>{
        const { same } = await load(FLOATS);
        const values = doubleInputs(30, 12);
        /** @type {(memory: Uint8Array, args: number[], x87: number[]) => { st0: number }} */
        const host = (memory, args, x87)=>({ st0: x87.reduce((sum, v, i)=>sum + v * (i + 2), 0) });
        let handed = 0;
        for (const control of CONTROLS)
        {
            for (const v of values)
            {
                for (const w of [0, -1.5, 1e300, v])
                {
                    handed += same('x87HandOver', { x87: [v, w], control }, { host }).handedOver
                        ? 1 : 0;
                }
                handed += same('x87Root', { x87: [v], control }, { host }).handedOver ? 1 : 0;
            }
        }
        assert.ok(handed > 50 && handed < 400, `${handed} handed over: both ways taken`);
    });

const WORDS = `
/**
 * The control word loaded with the mask's bits from the argument; the old
 * one and the status word read before and after the flags are cleared.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} bits @param {u32} mask @param {u32} out
 * @returns {i32}
 */
export function words({ controlWord, setControlWord, statusWord, clearExceptions, setU32 },
    bits, mask, out){
    const old = controlWord();
    setControlWord(old & ~mask | bits & mask);
    setU32(out, statusWord());
    clearExceptions();
    setU32(out + 4, statusWord());
    setU32(out + 8, controlWord());
    return old;
}

/**
 * A sum under the precision the argument names, the program's put back.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {f64} x @param {f64} y @param {u32} precision
 * @returns {f64}
 */
export function underPrecision({ controlWord, setControlWord }, x, y, precision){
    const saved = controlWord();
    setControlWord(saved & 0xfcff | precision << 8);
    const sum = x / y + x;
    setControlWord(saved);
    return sum;
}
`;

test('the control and status words read, loaded and cleared, and arithmetic under a word loaded',
    async()=>{
        const { same } = await load(WORDS);
        const next = random(27);
        const values = doubleInputs(28, 16);
        for (const control of CONTROLS)
        {
            for (let i = 0; i < 40; i++)
            {
                const status = next() & 0x47ff;
                same('words', { stack: [next() & 0xffff, next() & 0x1f3f, DATA], control, status });
                const x = values[next() % values.length];
                const y = values[next() % values.length];
                same('underPrecision', { stack: [...doubleWords(x), ...doubleWords(y), next() % 4],
                    control });
            }
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

const CALLS = `
/**
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} at @param {u32} most
 * @returns {u32}
 */
export function measure({ u8 }, at, most){
    let n = 0;
    while (n < (most | 0) && u8(at + n) !== 0)
    {
        n++;
    }
    return n >>> 0;
}

/**
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} at @param {u32} count @param {u32} byte
 * @returns {void}
 */
export function paint({ setU8 }, at, count, byte){
    for (let i = 0; i < (count | 0); i++)
    {
        setU8(at + i, byte);
    }
}

/**
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} at @param {u32} to
 * @returns {i32}
 */
export function both({ u8, setU8 }, at, to){
    const left = measure({ u8 }, at, 40);
    paint({ setU8 }, to, left, 0x2a);
    const right = measure({ u8, setU8 }, (at + left + 1) >>> 0, 40);
    return (Math.imul(left, 100) + right) | 0;
}`;

test('a call to another @guestCode function: its code after the caller\'s, cdecl and stdcall,'
    + ' the registers it may change saved round it', async()=>{
    const { same, compiled } = await load(CALLS);
    const next = random(31);
    for (let i = 0; i < 60; i++)
    {
        const bytes = Array.from({ length: 96 }, ()=>(next() % 9 === 0 ? 0 : 0x41 + next() % 20));
        same('both', { stack: [DATA, DATA + 0x80], memory: [[DATA, bytes]] });
    }
    // Each callee's code whole after the caller's, once each.
    assert.ok(compiled.both.code.length > compiled.measure.code.length
        + compiled.paint.code.length, 'both carries measure and paint');
    refused(`${CALLS}
/**
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} at
 * @returns {u32}
 */
export function handing({ u8, host }, at){
    if (u8(at) === 0)
    {
        return host();
    }
    return 1;
}
/**
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} at
 * @returns {u32}
 */
export function caller({ u8 }, at){
    return handing({ u8 }, at);
}`, /handing hands calls to the host/);
    refused(`${CALLS}
/**
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} at
 * @returns {u32}
 */
export function narrow({ setU8 }, at){
    return measure({ setU8 }, at, 4);
}`, /measure is given the helpers it takes/);
    refused(`
/**
 * @guestCode cdecl
 * @param {u32} n
 * @returns {u32}
 */
export function ping(n){
    return pong(n);
}
/**
 * @guestCode cdecl
 * @param {u32} n
 * @returns {u32}
 */
export function pong(n){
    return ping(n);
}`, /calls itself/);
});

test('a hand-over jumps to its trap directly from integer code, through EAX from x87 code',
    async()=>{
        const { compiled } = await load(SAMPLE);
        const floats = (await load(FLOATS)).compiled;
        /** @param {any} fn */
        const jump = fn=>[...fn.code.subarray(fn.host - 1, fn.host + 6)];
        assert.deepEqual(jump(compiled.handOver).slice(0, 5), [0xe9, 0, 0, 0, 0]);
        // A double negated: an x87 instruction in the function.
        assert.deepEqual(jump(compiled.assignedThenHost), [0xb8, 0, 0, 0, 0, 0xff, 0xe0]);
        assert.deepEqual(jump(floats.x87HandOver), [0xb8, 0, 0, 0, 0, 0xff, 0xe0]);
    });

test('everything outside the subset is refused where it is written', ()=>{
    const p = 'a, c, x';
    refused(one(p, 'return ({ a }).a;'), /member is read only from a table/);
    refused(one(p, 'const list = [a];\n    return 0;'), /an array is not in the subset/);
    refused(one(p, 'return \'a\';'), /is not a number/);
    refused(one(p, 'const g = ()=>a;\n    return 0;'), /a closure is not in the subset/);
    refused(one(p, 'return await a;'), /await|reserved|Unexpected/);
    refused(one(p, 'return a % 2;'), /no integer division/);
    refused(one(p, 'return a + 1;'), /brought back to 32 bits/);
    refused(one(p, 'return a < c ? 1 : 0;'), /signed value compared with an unsigned/);
    refused(one(p, 'return Math.imul(a, c) * a;'), /Math\.imul/);
    refused(one(p, 'return other(a);'), /not a helper/);
    refused(one(p, 'return a == 1 ? 1 : 0;'), /is written ===/);
    refused(one(p, 'return Math.exp(x) < 2 ? 1 : 0;'), /Math\.exp is no one x87 instruction/);
    refused(one(p, 'return Math.pow(x, 2) < 2 ? 1 : 0;'), /Math\.pow is no one x87 instruction/);
    refused(one(p, 'let y = x;\n    y += 1;\n    return 0;'), /on a double is written y = y \+/);
    refused(one(p, '/** @type {f32} */\n    const y = x * 2;\n    return 0;'),
        /y is f32, and this is f64: a float is Math\.fround's/);
    refused(one(p, 'return x + a;'), /the function returns an i32, not an f64/);
    refused(one(p, 'return u8(a);'), /taken from the guest in the first parameter/);
    refused(one(p, 'return local[a];'), /not an exported module-level typed array/);
    refused(one(p, 'if (a) return 1;'), /can reach its end without a return/);
    refused(one(p, 'return TABLE[a] === 1;'), /condition, not a value/);
    refused(one(p, 'for (const k of [a]) { return k; }\n    return 0;'), /for\.\.\.of/);
    refused(one(p, 'let s = a;\n    s = c;\n    return s;'), /s is i32, and this is u32/);
    refused(one('{ u9 }, a, c, x', 'return 0;'), /the guest's helpers are/);
    refused(one('a, c, x, y', 'return 0;'),
        /@param \{i32 \| u32 \| f64 \| f32 \| x87\} y is wanted/);
    refused(one(p, 'return 0;').replace('@guestCode cdecl', '@guestCode'),
        /names its convention/);
    refused(one(p, 'return a;', '@param {i32} a @param {u32} c @param {f64} x\n * @returns {f16}'),
        /is not i32, u32, f64, f32, i64 or void/);
    const q = '{ host }, a, c, x';
    refused(one(q, 'return host(a);'), /host\(\) takes no arguments/);
    refused(one(q, 'const v = host();\n    return v;'), /only returned: return host\(\)/);
    refused(one(q, 'host();\n    return 0;'), /only returned: return host\(\)/);
});
