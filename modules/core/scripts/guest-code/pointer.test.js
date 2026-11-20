/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The pointer type: `ptr` parameters and the variables made of them, held to
 * the same JavaScript three ways. Below 4 GiB through `equivalence`, the i386
 * and the x86-64 alike; past 4 GiB on cork's long-mode machine over a wide
 * window, where the x86-64 has to carry every pointer whole and a `u32` in
 * its place reads another byte; and the sources the language refuses,
 * because their 32-bit code would take half of what the handler takes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestCodeError, compileModule } from './compile.mjs';
import { DATA, equivalence, random } from './equivalence.mjs';
import { CODE_64, HIGH_64, callLong, longMachine } from './long.mjs';
import { loadModel } from './model.mjs';

const X87_MODULE = new URL('../../src/layers/win32/msvcrt/x87.js', import.meta.url).href;

const SAMPLE = `
/**
 * A string's length: the pointer and a signed index.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {ptr} text
 * @returns {u32}
 */
export function length({ u8 }, text){
    let n = 0;
    while (u8(text + n) !== 0)
    {
        n = (n + 1) | 0;
    }
    return n >>> 0;
}

/**
 * Where a byte is: a pointer walked to an end made of a pointer and a count.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {ptr} from @param {u32} count @param {i32} byte
 * @returns {ptr}
 */
export function find({ u8 }, from, count, byte){
    const end = from + count;
    let at = from;
    while (at < end)
    {
        if (u8(at) === (byte & 0xff))
        {
            return at;
        }
        at++;
    }
    return 0;
}

/**
 * Bytes written backwards: pointers stepped by -= and +=, a pointer less an
 * index answered.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {ptr} to @param {ptr} from @param {i32} count
 * @returns {ptr}
 */
export function reverse({ u8, setU8 }, to, from, count){
    let source = from + count;
    let target = to;
    while (source !== from)
    {
        source -= 1;
        setU8(target, u8(source));
        target += 1;
    }
    return target - count;
}

/**
 * The dwords either side of a pointer, by an index that goes below zero, and
 * one stored past it by an unsigned index.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {ptr} middle @param {i32} span @param {u32} past
 * @returns {i32}
 */
export function around({ i32, setU32 }, middle, span, past){
    let sum = 0;
    for (let i = -span | 0; i <= span; i = (i + 1) | 0)
    {
        sum = (sum + i32(middle + (i << 2))) | 0;
    }
    // Several integers are one index: summed in 32 bits, then the pointer's.
    sum = (sum + i32(middle + span * 4 - (span << 3) + past - past)) | 0;
    setU32(middle + past + 4, sum >>> 0);
    setU32(middle - span - span + 8, sum >>> 0);
    return sum;
}

/**
 * A copy either way and a fill, by pointers and a pointer moved.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {ptr} to @param {ptr} from @param {u32} count
 * @returns {ptr}
 */
export function move({ copyUp, copyDown, fill }, to, from, count){
    if (to < from)
    {
        copyUp(to, from, count);
    }
    else
    {
        copyDown(to, from, count);
    }
    fill(to + count, 0x2a, 3);
    return to;
}

/**
 * What a pointer is as 32 bits: its low bits, and two pointers' difference.
 *
 * @guestCode cdecl
 * @param {ptr} a @param {ptr} b
 * @returns {i32}
 */
export function apart(a, b){
    return (((b - a) | 0) + (a & 3) + ((b >>> 3) & 7)) | 0;
}

/**
 * A pointer handed to another function of the module, moved first.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {ptr} text @param {u32} skip
 * @returns {u32}
 */
export function tail({ u8 }, text, skip){
    return length({ u8 }, text + skip);
}

/**
 * A pointer parameter assigned, then the call handed over as it came.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {ptr} text @param {u32} limit
 * @returns {u32}
 */
export function firstOr({ u8, host }, text, limit){
    const start = text;
    while (u8(text) !== 0)
    {
        if (u8(text) === 0xff)
        {
            return host();
        }
        text += 1;
        if (text === start + limit)
        {
            text = start;
            break;
        }
    }
    return u8(text) >>> 0;
}

/**
 * More pointers than registers, each compared with the others.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {ptr} a @param {ptr} b @param {ptr} c @param {ptr} d
 * @param {ptr} e @param {ptr} f
 * @returns {i32}
 */
export function many({ u8 }, a, b, c, d, e, f){
    let lowest = a;
    if (b < lowest)
    {
        lowest = b;
    }
    if (c + 1 <= lowest + 1)
    {
        lowest = c;
    }
    if (lowest > d)
    {
        lowest = d;
    }
    if (e - 2 < lowest - 2)
    {
        lowest = e;
    }
    if (!(f >= lowest))
    {
        lowest = f;
    }
    return (u8(lowest) + u8(a) + u8(b) + u8(c) + u8(d) + u8(e) + u8(f)
        + (lowest === a ? 1000 : 0)) | 0;
}
`;

/** @param {string} text */
async function load(text){
    const url = `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`;
    const values = await import(url);
    /** @type {Record<string, any>} */
    const compiled = {};
    for (const fn of compileModule(text, { file: 'pointers.js', values }))
    {
        compiled[fn.name] = fn;
    }
    /** @type {Record<string, any>} */
    const long = {};
    for (const fn of compileModule(text, { file: 'pointers.js', values, bits: 64 }))
    {
        long[fn.name] = fn;
    }
    const model = await loadModel(text, { file: 'pointers.js', url: X87_MODULE, values });
    return { values, compiled, long, ...equivalence(compiled, values, model, long) };
}

test('pointers below 4 GiB: the i386 and the x86-64 against the JavaScript', async()=>{
    const { same, long, compiled } = await load(SAMPLE);
    assert.deepEqual(Object.keys(long).sort(), Object.keys(compiled).sort(),
        'every function has its x86-64');
    const next = random(41);
    /** @type {(memory: Uint8Array, args: number[]) => number} */
    const host = (memory, [text, limit])=>(memory[text] ^ limit) >>> 0;
    let handed = 0;
    for (let i = 0; i < 120; i++)
    {
        const bytes = Array.from({ length: 160 }, ()=>(next() % 11 === 0 ? 0 : next() & 0xff));
        bytes[159] = 0;
        const memory = /** @type {[number, number[]][]} */ ([[DATA, bytes]]);
        const at = DATA + next() % 64;
        same('length', { stack: [at], memory });
        same('find', { stack: [at, next() % 80, next() & 0xff], memory });
        same('reverse', { stack: [DATA + 100 + next() % 16, at, next() % 30], memory });
        same('around', { stack: [DATA + 64 + (next() % 8) * 4, next() % 9, next() % 40],
            memory });
        const from = DATA + 8 + next() % 32;
        same('move', { stack: [i % 2 === 0 ? from + next() % 9 - 4 : DATA + next() % 64, from,
            next() % 40], memory });
        same('apart', { stack: [at, DATA + next() % 160] });
        same('tail', { stack: [at, next() % 20], memory });
        const text = bytes.map(byte=>(byte !== 0 && next() % 40 === 0 ? 0xff : byte));
        handed += same('firstOr', { stack: [at, 1 + next() % 30], memory: [[DATA, text]] },
            { host }).handedOver ? 1 : 0;
        same('many', { stack: Array.from({ length: 6 }, ()=>DATA + next() % 160), memory });
    }
    assert.ok(handed > 5 && handed < 115, `${handed} of 120 handed over: both ways taken`);
});

test('a pointer costs the i386 nothing: the code of the same source with u32', ()=>{
    const source = `
/**
 * @guestCode cdecl
 * @param {Guest} guest @param {TYPE} text @param {i32} n
 * @returns {u32}
 */
export function at({ u8, setU8 }, text, n){
    setU8(text + n + 1, u8(text + n) + 1);
    return (text + 4) >>> 0;
}
`;
    const [pointer] = compileModule(source.replace('TYPE', 'ptr'), { file: 'a.js' });
    const [dword] = compileModule(source.replace('TYPE', 'u32'), { file: 'a.js' });
    assert.deepEqual(pointer.code, dword.code);
    assert.deepEqual(pointer.params, ['ptr', 'i32'], 'the record keeps the declared pointer');
});

/**
 * The helpers over a long-mode machine's memory, for the JavaScript's run:
 * an address is the number it is, past 2^32 as well.
 *
 * @param {import('./long.mjs').LongMachine} m
 */
function guestOver(m){
    /** @param {number} address @param {number} size */
    const view = (address, size)=>new DataView(Uint8Array.from(m.read(address, size)).buffer);
    /** @param {number} to @param {number} from @param {number} count */
    const copy = (to, from, count)=>m.write(to, Array.from(m.read(from, count)));
    return {
        u8: (/** @type {number} */ a)=>view(a, 1).getUint8(0),
        i32: (/** @type {number} */ a)=>view(a, 4).getInt32(0, true),
        setU8: (/** @type {number} */ a, /** @type {number} */ value)=>m.write(a, [value & 0xff]),
        setU32: (/** @type {number} */ a, /** @type {number} */ value)=>m.write(a,
            [0, 8, 16, 24].map(shift=>value >>> shift & 0xff)),
        copyUp: copy,
        copyDown: copy,
        fill: (/** @type {number} */ to, /** @type {number} */ byte,
            /** @type {number} */ count)=>m.write(to, new Array(count).fill(byte & 0xff)),
    };
}

/** Where the cases past 4 GiB keep their bytes, and its low twin, which no case may touch. */
const HIGH = HIGH_64 + 0x200000;
const TWIN = 0x200000;
const HALT = 0x0f00;
const SPAN = 0x200;

test('pointers past 4 GiB: the x86-64 carries each whole, where a u32 reads the low twin',
    async()=>{
        const { values, long } = await load(SAMPLE);
        const next = random(43);
        /** @type {Map<string, import('./long.mjs').LongMachine>} One a function, its translations kept. */
        const machines = new Map();
        /**
         * Runs a function on its window, its bytes at HIGH and others at
         * the address 4 GiB below, and answers RAX and what HIGH holds.
         *
         * @param {any} fn @param {number[]} bytes @param {bigint[]} args
         * @param {((...args: any[]) => number) | null} js
         */
        const run = (fn, bytes, args, js)=>{
            let m = machines.get(fn.name);
            if (!m)
            {
                m = longMachine({ window: 2 ** 33 });
                m.write(CODE_64, fn.code);
                m.write(HALT, [0xf4]);
                machines.set(fn.name, m);
            }
            const twin = bytes.map(byte=>byte ^ 0x5a);
            m.write(HIGH, bytes);
            m.write(TWIN, twin);
            let expected;
            let after;
            if (js !== null)
            {
                expected = js(...fn.uses.length > 0 ? [guestOver(m)] : [], ...args.map(Number));
                after = m.read(HIGH, SPAN);
                m.write(HIGH, bytes);
            }
            const { halted } = callLong(m, CODE_64, { args, returnTo: HALT });
            assert.ok(halted && m.rip() === HALT + 1, `${fn.name} returns`);
            assert.deepEqual(Array.from(m.read(TWIN, SPAN)), twin,
                `${fn.name} leaves the bytes 4 GiB below alone`);
            return { rax: m.reg('rax'), data: m.read(HIGH, SPAN), expected, after };
        };
        /** @param {string} name @param {number[]} bytes @param {number[]} args */
        const same = (name, bytes, args)=>{
            const fn = long[name];
            const { rax, data, expected, after } = run(fn, bytes, args.map(BigInt), values[name]);
            const what = `${name}(${args.map(arg=>`0x${arg.toString(16)}`).join(', ')})`;
            const whole = fn.returns === 'i32' ? BigInt.asUintN(64, BigInt(expected | 0))
                : BigInt(expected);
            assert.equal(rax, whole, `${what}: RAX`);
            assert.deepEqual(Array.from(data), Array.from(/** @type {number[]} */ (after)),
                `${what}: memory`);
        };
        for (let i = 0; i < 40; i++)
        {
            const bytes = Array.from({ length: SPAN }, ()=>(next() % 11 === 0 ? 0 : next() & 0xff));
            bytes[SPAN - 1] = 0;
            const at = HIGH + next() % 64;
            same('length', bytes, [at]);
            same('find', bytes, [at, next() % 80, next() & 0xff]);
            same('reverse', bytes, [HIGH + 256 + next() % 16, at, next() % 30]);
            same('around', bytes, [HIGH + 64 + (next() % 8) * 4, next() % 9, next() % 40]);
            const from = HIGH + 8 + next() % 32;
            same('move', bytes, [i % 2 === 0 ? from + next() % 9 - 4 : HIGH + next() % 64, from,
                next() % 40]);
            same('apart', bytes, [at, HIGH + next() % 160]);
            // One pointer below 4 GiB and one past it: a comparison of halves
            // would order them the other way.
            same('apart', bytes, [TWIN + 0x1000 + next() % 64, at]);
            same('tail', bytes, [at, next() % 20]);
            same('many', bytes, Array.from({ length: 6 }, ()=>HIGH + next() % 160));
        }
        // The same source with a u32 for the pointer reads the twin: what the
        // type is for.
        const [narrow] = compileModule(`
/**
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} text
 * @returns {u32}
 */
export function length({ u8 }, text){
    let n = 0;
    while (u8(text + n) !== 0)
    {
        n = (n + 1) | 0;
    }
    return n >>> 0;
}
`, { file: 'narrow.js', bits: 64 });
        assert.equal(narrow.name, 'length');
        const text = [...Buffer.from('four\0')];
        const m = longMachine({ window: 2 ** 33 });
        m.write(CODE_64, narrow.code);
        m.write(HALT, [0xf4]);
        m.write(HIGH, text);
        m.write(TWIN, [...Buffer.from('sixsix\0')]);
        callLong(m, CODE_64, { args: [BigInt(HIGH)], returnTo: HALT });
        assert.equal(m.reg('rax'), 6n, 'a u32 parameter is the low half of the pointer');
        const whole = longMachine({ window: 2 ** 33 });
        whole.write(CODE_64, long.length.code);
        whole.write(HALT, [0xf4]);
        whole.write(HIGH, text);
        whole.write(TWIN, [...Buffer.from('sixsix\0')]);
        callLong(whole, CODE_64, { args: [BigInt(HIGH)], returnTo: HALT });
        assert.equal(whole.reg('rax'), 4n, 'a ptr parameter is the pointer');
    });

test('a hand-over gives the trap a pointer past 4 GiB as it came, though the body moved it',
    async()=>{
        const { long } = await load(SAMPLE);
        const HOST = 0x0e00;
        const m = longMachine({ window: 2 ** 33 });
        const code = long.firstOr.code.slice();
        new DataView(code.buffer).setUint32(long.firstOr.host,
            (HOST - (CODE_64 + long.firstOr.host + 4)) >>> 0, true);
        m.write(CODE_64, code);
        m.write(HALT, [0xf4]);
        m.write(HOST, [0xf4]);
        m.write(HIGH, [0x41, 0x42, 0xff, 0]);
        callLong(m, CODE_64, { args: [BigInt(HIGH), 9n], returnTo: HALT });
        assert.equal(m.rip(), HOST + 1, 'handed over at the third byte');
        assert.equal(m.reg('rcx'), BigInt(HIGH), 'RCX whole, as the call came');
        assert.equal(m.reg('rdx'), 9n);
    });

test('a pointer where 32 bits would be taken for it is refused, at both widths', ()=>{
    /** @param {string} body @param {string} [returns] */
    const source = (body, returns = 'i32')=>`
/**
 * @guestCode cdecl
 * @param {Guest} guest @param {ptr} p @param {ptr} q @param {i32} n
 * @returns {${returns}}
 */
export function refused({ u8, setU32, u32 }, p, q, n){
${body}
}
`;
    const cases = /** @type {[string, RegExp, string?][]} */ ([
        ['    return p;', /p is a pointer/],
        ['    const x = p * 2;\n    return x | 0;', /p is a pointer/],
        ['    setU32(q, p);\n    return 0;', /p is a pointer/],
        ['    if (p)\n    {\n        return 1;\n    }\n    return 0;', /p is a pointer/],
        ['    let x = n;\n    x = (x + 1) | 0;\n    x += p;\n    return x;', /p is a pointer/],
        ['    return u8(n + (q - p)) | 0;', /is a pointer/],
        ['    p >>>= 1;\n    return 0;', />>>= on a pointer/],
        ['    return (p === n ? 1 : 0) | 0;', /compared with a pointer or a constant/],
        ['    return (Math.imul(p, 3)) | 0;', /p is a pointer/],
    ]);
    for (const [body, message, returns] of cases)
    {
        for (const bits of /** @type {const} */ ([32, 64]))
        {
            // The comparison is held to its rule by the 64-bit code that
            // has to make it; the i386 compares 32 bits.
            if (bits === 32 && (/compared/).test(message.source))
            {
                continue;
            }
            assert.throws(()=>compileModule(source(body, returns), { file: 'r.js', bits }),
                error=>error instanceof GuestCodeError && message.test(error.message),
                `${body.trim()} at ${bits} bits`);
        }
    }
    // What the same expressions are with their 32 bits said.
    for (const body of ['    return (p | 0) + (q & 3) | 0;', '    return (q - p + n) | 0;',
        '    return ((p >>> 4) ^ n) | 0;', '    setU32(q, p >>> 0);\n    return 0;'])
    {
        for (const bits of /** @type {const} */ ([32, 64]))
        {
            assert.equal(compileModule(source(body), { file: 'r.js', bits }).length, 1);
        }
    }
});
