/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The x86-64 code the build makes for a 64-bit process, held to its
 * JavaScript on cork's long-mode machine (`equivalence`'s 64-bit run): every
 * function of every module the build compiles at 64 bits (`LONG`), on seeded
 * inputs of the shapes its arguments take -- pointers into an area of short
 * strings that end and runs that repeat, two pointers a few bytes apart,
 * counts, bytes and characters, the edges of 32 bits, doubles where rounding
 * turns -- and those that call through a pointer with an x86-64 comparator
 * that does what the x64 convention lets a callee do. Each call gives every
 * register a value of its own, XMM ones included, and the arguments' upper
 * halves a pattern; each run is held to the result in RAX or XMM0, the memory,
 * RSP, the direction flag and the registers the caller keeps, XMM6 to XMM15
 * among them, and a hand-over to the arguments as the call left them. And
 * every function the source marks is accounted for: x86-64 code, or a reason
 * it has none.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LONG } from '../build-guest-code.mjs';
import { CALLBACK, DATA, doubleWords, equivalence, random } from './equivalence.mjs';
import { SHAPED_INPUTS } from './shaped-inputs.mjs';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

/**
 * The modules with x86-64 code, each with its source, its i386 and its x86-64.
 *
 * and the inputs of each function whose arguments only agree in a shape of
 * their own (`shaped-inputs.mjs`).
 *
 * @returns {Promise<{ path: string, sources: Record<string, unknown>,
 *     i386: Record<string, any>, long: Record<string, any>, refused: Record<string, string>,
 *     shaped: Record<string, import('./shaped-inputs.mjs').ShapedInput> }[]>}
 */
async function modules(){
    return Promise.all([...LONG.keys()].map(async path=>{
        const at = (/** @type {string} */ suffix)=>pathToFileURL(join(SRC,
            path.replace(/\.js$/, suffix))).href;
        const { COMPILED: long, REFUSED: refused } = await import(at('.x64.js'));
        const { COMPILED: i386 } = await import(at('.x86.js'));
        const shaped = SHAPED_INPUTS[path] ?? {};
        return { path, sources: await import(at('.js')), i386, long, refused, shaped };
    }));
}

/**
 * compare(a, b) in x86-64: the signed dwords at RCX and RDX as -1, 0 or 1 --
 * having written its home space, faulted (`ud2`) unless RSP was a multiple of
 * 16 at the call, and leaving a pattern above EAX and in every register the
 * caller may not count on.
 */
const COMPARE_64 = [
    0x49, 0x89, 0xe2,                                   // mov r10, rsp
    0x41, 0x83, 0xe2, 0x0f,                             // and r10d, 15
    0x41, 0x83, 0xfa, 0x08,                             // cmp r10d, 8
    0x74, 0x02,                                         // je past the ud2
    0x0f, 0x0b,                                         // ud2
    0x48, 0x89, 0x4c, 0x24, 0x08,                       // mov [rsp+8], rcx
    0x48, 0x89, 0x54, 0x24, 0x10,                       // mov [rsp+16], rdx
    0x4c, 0x89, 0x44, 0x24, 0x18,                       // mov [rsp+24], r8
    0x4c, 0x89, 0x4c, 0x24, 0x20,                       // mov [rsp+32], r9
    0x8b, 0x01,                                         // mov eax, [rcx]
    0x8b, 0x0a,                                         // mov ecx, [rdx]
    0x31, 0xd2,                                         // xor edx, edx
    0x39, 0xc8,                                         // cmp eax, ecx
    0x0f, 0x9f, 0xc2,                                   // setg dl
    0x0f, 0x9c, 0xc0,                                   // setl al
    0x0f, 0xb6, 0xc0,                                   // movzx eax, al
    0x29, 0xc2,                                         // sub edx, eax
    0x89, 0xd0,                                         // mov eax, edx
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
const compareJs = (memory, fn, [a, b])=>{
    assert.equal(fn, CALLBACK);
    const view = new DataView(memory.buffer);
    const left = view.getInt32(a, true);
    const right = view.getInt32(b, true);
    return left < right ? -1 : left > right ? 1 : 0;
};

/** Where the inputs' bytes lie, past DATA. */
const AREA = 0x3000;

/**
 * An area of the bytes strings are made of: letters of both cases, digits,
 * white space, signs, the upper half, and a terminator often enough that
 * strings end; runs copied from one place to another (`twins`, each the
 * run's two places), so two pointers can find the same bytes for a while;
 * and runs of wide ASCII text.
 *
 * @param {() => number} next
 * @returns {{ bytes: Uint8Array, twins: [number, number][] }}
 */
function area(next){
    const alphabet = [0x41, 0x42, 0x61, 0x62, 0x7a, 0x5a, 0x30, 0x31, 0x39, 0x20, 0x09, 0x2b,
        0x2d, 0x78, 0x58, 0x80, 0x81, 0xa0, 0xe9, 0xff, 0x00, 0x00, 0x00];
    const bytes = Uint8Array.from({ length: AREA }, ()=>alphabet[next() % alphabet.length]);
    /** @type {[number, number][]} */
    const twins = [];
    for (let i = 0; i < 24; i++)
    {
        const from = next() % (AREA - 0x100);
        const to = next() % (AREA - 0x100);
        // Half the runs with their terminators, two strings equal to their
        // ends; half without, equal up to where the copy ends.
        const whole = next() % 2 === 0;
        const run = bytes.slice(from, from + 8 + next() % 120).map(byte=>(whole ? byte
            : byte || 0x41));
        bytes.set(run, to);
        bytes.set(run, from);
        twins.push([from, to]);
    }
    // Runs of wide ASCII text, a unit a character and its high byte 0, some
    // ending in a wide terminator: what a wide function reads to its end.
    const ascii = [0x30, 0x31, 0x37, 0x39, 0x41, 0x61, 0x66, 0x7a, 0x20, 0x2d, 0x2b, 0x78];
    for (let i = 0; i < 24; i++)
    {
        const at = (next() % (AREA - 0x100)) & ~1;
        const units = 2 + next() % 30;
        for (let u = 0; u < units; u++)
        {
            bytes[at + 2 * u] = ascii[next() % ascii.length];
            bytes[at + 2 * u + 1] = 0;
        }
        if (next() % 2 === 0)
        {
            bytes[at + 2 * units] = 0;
            bytes[at + 2 * units + 1] = 0;
        }
    }
    return { bytes, twins };
}

/** The bytes of the structures past the area (`structures`). */
const STRUCTURES = 0x400;

/**
 * Structures past the area: eight-byte slots, each a small count or a
 * pointer into the area or to another structure, its upper half zero -- what
 * an object's members read their counts and their text's address from, which
 * the area's text never holds: a count made of text bytes is never small.
 * From a generator of their own, so the area's inputs stay what they were.
 *
 * @param {() => number} aside
 * @returns {Uint8Array}  sixteen structures of 64 bytes, at DATA + AREA
 */
function structures(aside){
    const bytes = new Uint8Array(STRUCTURES);
    const view = new DataView(bytes.buffer);
    for (let slot = 0; slot < STRUCTURES / 8; slot++)
    {
        const pick = aside() % 4;
        view.setUint32(slot * 8, pick === 0 ? DATA + aside() % (AREA - 0x100)
            : pick === 1 ? DATA + AREA + (aside() % (STRUCTURES / 64)) * 64 : aside() % 24, true);
    }
    return bytes;
}

/** Values past which 32-bit code wraps, signs flip or counts end. */
const EDGES = [0, 1, 2, 3, 4, 5, 7, 8, 0x7f, 0x80, 0xff, 0x100, 0xffff, 0x7fffffff, 0x80000000,
    0xfffffffc, 0xffffffff];

/**
 * The arguments of an integer function, each of a shape an argument takes:
 * a pointer into the area -- the two places of a copied run, a pointer and
 * one a few bytes from it -- a count, a byte or a character, an edge.
 *
 * @param {() => number} next @param {number} count
 * @param {[number, number][]} twins  The area's copied runs.
 */
function argumentsOf(next, count, twins){
    /** @type {number[]} */
    const given = [];
    /** The second place of a run the last pointer is in, for the next. @type {number | null} */
    let twin = null;
    while (given.length < count)
    {
        const pick = next() % 20;
        const last = given.findLast(value=>value >= DATA && value < DATA + AREA);
        if (pick < 9 && twin !== null)
        {
            given.push(twin);
            twin = null;
        }
        else if (pick < 4)
        {
            const [from, to] = twins[next() % twins.length];
            const into = next() % 8;
            given.push(DATA + from + into);
            twin = DATA + to + into;
        }
        else if (pick < 9)
        {
            given.push(DATA + next() % (AREA - 0x100));
        }
        else if (pick < 12 && last !== undefined)
        {
            given.push((last + next() % 13 - 6) >>> 0);
        }
        else if (pick < 16)
        {
            given.push(next() % 80);
        }
        else
        {
            given.push(pick < 18 ? next() % 0x180 : EDGES[next() % EDGES.length]);
        }
    }
    return given;
}

/**
 * Doubles where rounding to an integer turns: zeros of both signs, halves,
 * either side of 2^52 (past which every double is whole) and of 2^63 (past
 * which a quadword holds none), the infinities, NaN, the smallest.
 */
const DOUBLE_EDGES = [0, -0, 0.5, -0.5, 1, -1, 1.5, -2.5, 0.49999999999999994, -0.49999999999999994,
    2 ** 52 - 0.5, -(2 ** 52) + 0.5, 2 ** 52, 2 ** 52 + 1, -(2 ** 53), 2 ** 63, -(2 ** 63),
    2 ** 64 + 2 ** 12, -(2 ** 63) - 2 ** 11, -(2 ** 80) - 2 ** 30, Infinity, -Infinity, NaN,
    Number.MIN_VALUE, -Number.MIN_VALUE, Number.MAX_VALUE, 2 ** 31 - 0.25, -(2 ** 31) - 0.75,
    4294967295.5];

/**
 * A double of a shape a function of doubles meets: a NaN, one call in
 * sixteen (what a float function hands its handler alone, so 200 calls find
 * some whatever the seed), an edge, a fraction of either sign and any size,
 * a whole number one unit off, bits at random.
 *
 * @param {() => number} next
 */
function doubleOf(next){
    const pick = next() % 16;
    if (pick === 0)
    {
        return NaN;
    }
    if (pick < 4)
    {
        return DOUBLE_EDGES[next() % DOUBLE_EDGES.length];
    }
    const sign = next() % 2 === 0 ? 1 : -1;
    if (pick < 10)
    {
        return sign * (next() / 2 ** 32) * 2 ** (next() % 70 - 4);
    }
    if (pick < 14)
    {
        const whole = sign * Math.floor(next() * 2 ** 21 / 2 ** (next() % 54));
        return whole + [0, 2 ** -40, -(2 ** -40)][next() % 3] * Math.max(1, Math.abs(whole));
    }
    const view = new DataView(new ArrayBuffer(8));
    view.setUint32(0, next(), true);
    view.setUint32(4, next(), true);
    return view.getFloat64(0, true);
}

/**
 * The stack's words of a function's arguments: two of a double's, one of a
 * float's, the integers' from `integers`.
 *
 * @param {() => number} next @param {string[]} params @param {number[]} integers
 */
function wordsOf(next, params, integers){
    return params.flatMap((type, i)=>(type === 'f64' ? doubleWords(doubleOf(next))
        : type === 'f32' ? [floatBits(doubleOf(next))] : [integers[i]]));
}

/** A float's bits, the double rounded to it. @param {number} value */
function floatBits(value){
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value, true);
    return view.getUint32(0, true);
}

/**
 * The modules whose functions take an interface: `self` points at an object
 * whose word after the method table's (`self + pointerBytes`) is its block,
 * and they read the block's words. Random bytes hold no pointer, so every
 * input ran out of bounds; these get an area of objects and blocks instead.
 */
const OBJECT_MODULES = new Set(['layers/graphics/seam/inguest.js']);

/** A method's flags and sizes: none, each of a few bits, a size of four and of eight. */
const FLAGS = [0, 1, 2, 3, 4, 8];
/** The small words a block holds: nulls, states, query types, counts. */
const SMALL = [0, 1, 2, 3, 4, 8, 8, 8, 9, 9, 9];
/** Room past a block's start for the farthest word a function reads in it. */
const BLOCK_REACH = 0x1600;

/**
 * An area of objects and blocks: each aligned dword a pointer into the area,
 * low enough that a block read from it lies within, a small word (`SMALL`),
 * or the bytes `area` made.
 *
 * @param {() => number} next
 * @returns {{ bytes: Uint8Array, twins: [number, number][] }}
 */
function objectArea(next){
    const made = area(next);
    const view = new DataView(made.bytes.buffer);
    for (let at = 0; at < AREA; at += 4)
    {
        const pick = next() % 8;
        if (pick < 3)
        {
            view.setUint32(at, DATA + (next() % (AREA - BLOCK_REACH) & ~3), true);
        }
        else if (pick < 7)
        {
            view.setUint32(at, SMALL[next() % SMALL.length], true);
        }
    }
    return made;
}

/**
 * An interface's arguments: `self` an aligned pointer into the area most of
 * the time, the rest as `argumentsOf` makes them or flags
 * and sizes as a method takes them (`FLAGS`), three times in four.
 *
 * @param {() => number} next @param {number} count @param {[number, number][]} twins
 */
function objectArgumentsOf(next, count, twins){
    const given = argumentsOf(next, count, twins).map((value, i)=>(i > 0 && next() % 4 !== 0
        ? FLAGS[next() % FLAGS.length] : value));
    if (next() % 8 !== 0)
    {
        given[0] = DATA + (next() % (AREA - BLOCK_REACH) & ~3);
    }
    return given;
}

/**
 * Whether a run of the JavaScript failed for the input's sake: an address
 * past the test's memory, which the x86-64 would reach as well.
 *
 * @param {unknown} e
 */
const outOfBounds = e=>e instanceof RangeError;

test('every function of the 64-bit modules is x86-64 code or refused with a reason', async()=>{
    for (const { path, i386, long, refused } of await modules())
    {
        assert.ok(Object.keys(long).length > 0, `${path}: some x86-64 code`);
        for (const name of Object.keys(i386))
        {
            assert.ok((name in long) !== (name in refused),
                `${path}: ${name} is x86-64 code or refused, one of the two`);
        }
        for (const [name, reason] of Object.entries(refused))
        {
            assert.ok(name in i386, `${path}: ${name} refused is a function of the source`);
            assert.match(reason, /\S/, `${path}: ${name} is refused with a reason`);
        }
    }
});

/**
 * The modules whose inputs the areas cannot make - a structure with a length
 * and a capacity at their offsets, floats that are not NaNs - so that random
 * inputs run out of bounds, never take one way, or meet what the source is no
 * judge of: each with the test that holds every function to its JavaScript at
 * 64 bits on inputs it lays out.
 *
 * @type {Readonly<Record<string, string>>}
 */
const HELD_ELSEWHERE = Object.freeze({
    'layers/win32/msvcrt/inguest-string.js': 'a std::string of forty bytes: '
        + 'msvcrt/inguest-string.test.js',
    // Floats a program's matrices hold: random bytes are NaNs, whose payload
    // SSE2 keeps and JavaScript does not, so the source is no judge of them.
    'layers/win32/d3dx9/inguest.js': 'matrices without NaN: d3dx9/inguest.test.js',
    // A table's block and handle records the binding lays out.
    'layers/win32/d3dx9/constants-setters.js': 'a constant table laid out: '
        + 'd3dx9/constants-setters.test.js',
    // A device's ring and its blocks laid out at both widths.
    'layers/graphics/seam/d3d10-inguest.js': 'a ring and its blocks: '
        + 'graphics/seam/d3d10-inguest.test.js',
    // A handle's word read through a table its binding places (HANDLE_WORDS).
    'layers/win32/kernel32/semaphore-guest.js': 'the handle table laid out: '
        + 'kernel32/semaphore-guest.test.js',
    'layers/win32/d3dx9/inguest-matrix.js': 'matrices without NaN: d3dx9/inguest-matrix.test.js',
    'layers/win32/d3dx9/inguest-vector.js': 'vectors without NaN: d3dx9/inguest-vector.test.js',
    'layers/win32/d3dx9/inguest-quaternion.js': 'quaternions without NaN: '
        + 'd3dx9/inguest-quaternion.test.js',
});

test('each function\'s x86-64 answers as its JavaScript, on inputs of every shape', async()=>{
    for (const { path, sources, i386, long, shaped } of await modules())
    {
        if (Object.hasOwn(HELD_ELSEWHERE, path))
        {
            continue;
        }
        const { sameAt64 } = equivalence(i386, sources, undefined, long);
        Object.keys(long).forEach((name, index)=>{
            const fn = long[name];
            if (fn.uses.includes('call') || fn.uses.includes('callStd'))
            {
                return;
            }
            const next = random(0x64 + index);
            // A few areas, each input in one of them.
            const objectModule = OBJECT_MODULES.has(path);
            const areas = Array.from({ length: 8 }, ()=>(objectModule ? objectArea : area)(next));
            const argumentsFor = objectModule ? objectArgumentsOf : argumentsOf;
            // One call in six has a pointer into the area replaced by a
            // structure's: its own generator, so every other call is the
            // input it was.
            const aside = random(0x5eed + index);
            const objects = structures(aside);
            let ran = 0;
            let handed = 0;
            let tried = 0;
            // Inputs until 200 have run: a function of three pointers and
            // counts finds fewer of them in bounds than one of a character.
            for (; tried < 4000 && ran < 200; tried++)
            {
                const host = (/** @type {Uint8Array} */ _, /** @type {number[]} */ args)=>
                    (args[0] ^ 0x5eed) | 0;
                if (shaped[name])
                {
                    const input = shaped[name](next);
                    handed += sameAt64(name, { stack: input.stack, memory: input.memory },
                        { host }, input.bounds).handedOver ? 1 : 0;
                    ran++;
                    continue;
                }
                const { bytes, twins } = areas[next() % areas.length];
                const given = argumentsFor(next, fn.params.length, twins);
                const pointers = given.flatMap((value, i)=>(value >= DATA && value < DATA + AREA
                    ? [i] : []));
                // A module of objects lays its own out in the area (`objectArea`): no swap there.
                const object = !objectModule && pointers.length > 0 && aside() % 6 === 0;
                if (object)
                {
                    given[pointers[aside() % pointers.length]] = DATA + AREA
                        + (aside() % (STRUCTURES / 64)) * 64;
                }
                const stack = wordsOf(next, fn.params, given);
                // A function that names no memory is run with none.
                const memory = /** @type {[number, Uint8Array][]} */ (fn.uses.some((
                    /** @type {string} */ use)=>use !== 'host')
                    ? [[DATA, bytes], ...object ? [[DATA + AREA, objects]] : []] : []);
                try
                {
                    // Within the area: what lies past it is the machine's, not the input's.
                    handed += sameAt64(name, { stack, memory }, { host },
                        [DATA, DATA + AREA + (object ? STRUCTURES : 0)]).handedOver ? 1 : 0;
                    ran++;
                }
                catch (e){
                    if (!outOfBounds(e))
                    {
                        throw e;
                    }
                }
            }
            assert.equal(ran, 200, `${path}: ${name} ran ${ran} of ${tried} inputs: too few in `
                + 'bounds');
            if (fn.uses.includes('host'))
            {
                assert.ok(handed > 0 && handed < ran, `${path}: ${name} handed ${handed} of `
                    + `${ran} calls to the host: both ways taken`);
            }
        });
    }
});

test('qsort and bsearch at 64 bits: the comparator called as the convention calls', async()=>{
    const runtime = (await modules()).find(({ path })=>path === 'layers/win32/msvcrt/inguest.js');
    assert.ok(runtime, 'the runtime\'s module has x86-64 code');
    const { sameAt64 } = equivalence(runtime.i386, runtime.sources, undefined, runtime.long);
    const double = { callback64: COMPARE_64, call: compareJs };
    const next = random(0x6464);
    for (const [count, width] of [[0, 4], [1, 4], [2, 4], [5, 0], [7, 1], [40, 4], [33, 12],
        [64, 8], [200, 4], [17, 6]])
    {
        const bytes = new Uint8Array(count * width + 16);
        const view = new DataView(bytes.buffer);
        for (let i = 0; i + 4 <= bytes.length; i += 4)
        {
            view.setInt32(i, (next() % 50) - 25, true);
        }
        sameAt64('qsort', { stack: [DATA, count, width, CALLBACK], memory: [[DATA, bytes]] },
            double);
    }
    for (const [count, width] of [[0, 4], [1, 4], [2, 4], [3, 8], [16, 4], [100, 4], [37, 12]])
    {
        const keys = Array.from({ length: count }, ()=>(next() % 60) - 30).sort((a, b)=>a - b);
        const bytes = new Uint8Array(count * width + 4);
        const view = new DataView(bytes.buffer);
        keys.forEach((key, i)=>view.setInt32(i * width, key, true));
        for (const wanted of [-31, -30, 0, 7, 29, 30, ...keys.slice(0, 5), next() % 60 - 30])
        {
            const key = new Uint8Array(4);
            new DataView(key.buffer).setInt32(0, wanted, true);
            sameAt64('bsearch', { stack: [DATA + 0x2000, DATA, count, width, CALLBACK],
                memory: [[DATA, bytes], [DATA + 0x2000, key]] }, double);
        }
    }
});
