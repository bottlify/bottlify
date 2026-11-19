/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The runtime's floating-point environment, classifications and number
 * reading answer the same as their x86, input by input, on cork's test
 * machine (`scripts/guest-code/equivalence.mjs`) -- the control word left
 * and the exception flags cleared among what is compared -- and what they
 * answer is msvcrt's: the portable control bits of `float.h` for each x87
 * word, `_fpclass`'s classes, the next double by its bits, and strtod's
 * values, ends and errno for Wine's conformance cases.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { COMPILED } from './inguest-float.x86.js';
import * as sources from './inguest-float.js';
import { doubleWords, equivalence, random } from
    '../../../../scripts/guest-code/equivalence.mjs';
import { loadModel } from '../../../../scripts/guest-code/model.mjs';
import { CODE_64, KEPT_64, callLong, longMachine } from
    '../../../../scripts/guest-code/long.mjs';
import { guestEntry, halvesEntry } from './guest-code.js';

const SOURCE = new URL('./inguest-float.js', import.meta.url);
const model = await loadModel(await readFile(SOURCE, 'utf8'), {
    file: 'inguest-float.js', url: SOURCE.href, values: sources,
});
const { same, sameAt64 } = equivalence(COMPILED, sources, model);

/** Double, single, extended, and each with another rounding. */
const CONTROLS = [0x27f, 0x07f, 0x37f, 0xe7f, 0x47f, 0x87f];

/** A double's two dwords. @param {number} value */
const words = value=>doubleWords(value);

/** A double from its two dwords. @param {number} low @param {number} high */
const fromWords = (low, high)=>{
    const view = new DataView(new ArrayBuffer(8));
    view.setUint32(0, low, true);
    view.setUint32(4, high, true);
    return view.getFloat64(0, true);
};

/**
 * Doubles of every kind, as their dwords: zeros, denormals, normals,
 * infinities, quiet and signalling NaNs, of both signs.
 *
 * @param {() => number} next
 * @returns {[number, number]}
 */
function doubleBits(next){
    const pick = next() % 8;
    const sign = next() % 2 === 0 ? 0 : 0x80000000;
    const fraction = next() & 0xfffff;
    const low = next();
    switch (pick)
    {
        case 0: return [0, sign];
        case 1: return [low, (sign | fraction) >>> 0];
        case 2: return [0, (sign | 0x7ff00000) >>> 0];
        case 3: return [low | 1, (sign | 0x7ff80000 | fraction) >>> 0];
        case 4: return [low | 1, (sign | 0x7ff00000 | fraction & 0x7ffff) >>> 0];
        default: return [low, (sign | (1 + next() % 0x7fe) << 20 | fraction) >>> 0];
    }
}

/** The x87's exception bits and the runtime's for each. */
const EXCEPTION_BITS = [[0x1, 0x10], [0x2, 0x80000], [0x4, 0x8], [0x8, 0x4], [0x10, 0x2],
    [0x20, 0x1]];

/** The runtime's reading of an x87 control word, bit by bit. @param {number} word */
function abstract(word){
    let bits = 0;
    for (const [x87, runtime] of EXCEPTION_BITS)
    {
        bits |= (word & x87) !== 0 ? runtime : 0;
    }
    bits |= [0, 0x100, 0x200, 0x300][word >> 10 & 3];
    bits |= [0x20000, 0, 0x10000, 0][word >> 8 & 3];
    bits |= (word & 0x1000) !== 0 ? 0x40000 : 0;
    return bits >>> 0;
}

test('_control87 and _controlfp: the bits the mask names, loaded and read back', ()=>{
    const next = random(41);
    /** @type {[number, number][]} newControl, mask */
    const asked = [[0, 0], [0x20000, 0x30000], [0x10000, 0x30000], [0, 0x30000],
        [0x30000, 0x30000], [0x300, 0x300], [0x100, 0x300], [0x200, 0x300], [0, 0x8001f],
        [0x8001f, 0x8001f], [0x40000, 0x40000], [0xffffffff, 0], [0xffffffff, 0xffffffff],
        [0x03000000, 0x03000000], [0x80000, 0x80000]];
    for (let i = 0; i < 40; i++)
    {
        asked.push([next(), next()]);
    }
    for (const control of [...CONTROLS, 0x17f, 0x137f, 0x27e, 0x2c0])
    {
        for (const [wanted, mask] of asked)
        {
            same('_control87', { stack: [wanted, mask], control });
            same('_controlfp', { stack: [wanted, mask], control });
        }
    }
    // The answers themselves: the MSVC default, and each change as the word shows it.
    const answer = (/** @type {string} */ name, /** @type {number} */ control,
        /** @type {number[]} */ stack)=>same(name, { stack, control }).eax >>> 0;
    assert.equal(answer('_controlfp', 0x27f, [0, 0]), 0x9001f);
    assert.equal(answer('_controlfp', 0x27f, [0x20000, 0x30000]), 0xa001f, 'single precision');
    assert.equal(answer('_controlfp', 0x27f, [0x300, 0x300]), 0x9031f, 'chop');
    assert.equal(answer('_control87', 0x27f, [0, 0x80000]), 0x1001f,
        '_control87 unmasks the denormal exception');
    assert.equal(answer('_controlfp', 0x27f, [0, 0x80000]), 0x9001f, '_controlfp does not');
    for (const control of CONTROLS)
    {
        assert.equal(answer('_controlfp', control, [0, 0]), abstract(control),
            `0x${control.toString(16)} read`);
    }
});

/** The runtime's bits as an x87 control word, bit by bit. @param {number} bits */
function hardware(bits){
    let word = 0;
    for (const [x87, runtime] of EXCEPTION_BITS)
    {
        word |= (bits & runtime) !== 0 ? x87 : 0;
    }
    word |= (bits & 0x300) << 2;
    word |= [0x300, 0x200, 0, 0][bits >>> 16 & 3];
    word |= (bits & 0x40000) !== 0 ? 0x1000 : 0;
    return word;
}

test('_control87 and _controlfp read every control word and load every setting bit by bit', ()=>{
    // The JavaScript the x86 is held to above, over every word the x87 can
    // hold and every setting of the bits the runtime changes: its tables
    // against the bits one at a time.
    const next = random(46);
    for (let word = 0; word < 0x10000; word++)
    {
        const [newControl, mask] = word < 0x2000 ? [0, 0] : [next(), next()];
        for (const name of /** @type {const} */ (['_control87', '_controlfp']))
        {
            let loaded = -1;
            const answer = sources[name](/** @type {any} */ ({
                controlWord: ()=>word,
                setControlWord: (/** @type {number} */ value)=>{
                    loaded = value;
                },
            }), newControl, mask);
            const changed = mask & 0xf031f & (name === '_controlfp' ? ~0x80000 : ~0);
            const wanted = abstract(word) & ~changed | newControl & changed;
            const expected = word & 0xe0c0 | hardware(wanted);
            assert.equal(loaded, expected, `${name} under 0x${word.toString(16)} loads`);
            assert.equal(answer, abstract(expected), `${name} under 0x${word.toString(16)}`);
        }
    }
    for (let bits = 0; bits < 1 << 13; bits++)
    {
        // Every setting of _MCW_EM, _MCW_RC, _MCW_PC and _MCW_IC, spread to
        // the runtime's places: back where the runtime reads it.
        const setting = bits & 0x1f | (bits & 0x20) << 14 | (bits & 0xc0) << 2
            | (bits & 0x300) << 8 | (bits & 0x400) << 8;
        assert.equal(abstract(hardware(setting)) & ~0x30000, setting & ~0x30000);
    }
});

test('_statusfp and _clearfp: the flags raised, and the flags cleared', ()=>{
    for (let flags = 0; flags < 0x40; flags++)
    {
        for (const status of [flags, flags | 0x80, flags | 0x4700])
        {
            const expected = abstract(flags) & 0x8001f;
            assert.equal(same('_statusfp', { status, control: 0x27f }).eax >>> 0, expected);
            assert.equal(same('_clearfp', { status, control: 0x27f }).eax >>> 0, expected);
        }
    }
});

test('_statusfp and _clearfp fold in MXCSR\'s flags, and _clearfp clears both units', ()=>{
    // Wine's kernel32 test_thread_fpu_cw: the invalid flag raised in MXCSR
    // alone is _SW_INVALID. MXCSR's six flags are laid out as the x87's.
    for (let sse = 0; sse < 0x40; sse++)
    {
        for (const x87 of [0, 0x1, 0x20])
        {
            const expected = abstract(sse | x87) & 0x8001f;
            const mxcsr = 0x1f80 | sse;
            assert.equal(same('_statusfp', { status: x87, mxcsr, control: 0x27f }).eax >>> 0,
                expected);
            assert.equal(same('_clearfp', { status: x87, mxcsr, control: 0x27f }).eax >>> 0,
                expected, 'the MXCSR it leaves is checked against the reference');
        }
    }
    assert.equal(same('_statusfp', { mxcsr: 0x1f81 }).eax >>> 0, 0x10, '_SW_INVALID');
});

/** MXCSR's bits and the runtime's for each, bit by bit. @param {number} word */
function abstractSse(word){
    let bits = 0;
    for (const [x87, runtime] of EXCEPTION_BITS)
    {
        bits |= (word & x87 << 7) !== 0 ? runtime : 0;
    }
    bits |= [0, 0x100, 0x200, 0x300][word >>> 13 & 3];
    bits |= (word & 0x8000) !== 0 ? (word & 0x40) !== 0 ? 0x01000000 : 0x03000000
        : (word & 0x40) !== 0 ? 0x02000000 : 0;
    return bits >>> 0;
}

test('a 64-bit process\'s control and status calls are MXCSR\'s: masks, rounding and the '
    + 'denormal bits, the flags kept, no precision', ()=>{
    const next = random(53);
    const words = [0x1f80, 0x0000, 0x7f80, 0x3f80, 0x5f80, 0x9fc0, 0x1fc0, 0x9f80, 0x1fbf,
        0xffff, 0x0a15];
    /** @type {[number, number][]} newControl, mask */
    const asked = [[0, 0], [0x300, 0x300], [0x100, 0x300], [0, 0x8001f], [0x8001f, 0x8001f],
        [0x01000000, 0x03000000], [0x02000000, 0x03000000], [0x03000000, 0x03000000],
        [0, 0x03000000], [0x20000, 0x30000], [0x40000, 0x40000], [0xffffffff, 0xffffffff],
        [0, 0x80000]];
    for (let i = 0; i < 40; i++)
    {
        asked.push([next(), next()]);
    }
    const OUT = 0x20100;
    for (const mxcsr of words)
    {
        for (const [wanted, mask] of asked)
        {
            for (const name of /** @type {const} */ (['_control87', '_controlfp']))
            {
                const ran = sameAt64(name, { stack: [wanted, mask], mxcsr });
                const changed = mask & 0x0308031f & (name === '_controlfp' ? ~0x80000 : ~0);
                const expected = (abstractSse(mxcsr) & ~changed | wanted & changed) >>> 0;
                const what = `${name}(0x${wanted.toString(16)}, 0x${mask.toString(16)}) under `
                    + `MXCSR 0x${mxcsr.toString(16)}`;
                assert.equal(ran.eax >>> 0, expected, what);
                assert.equal(abstractSse(/** @type {number} */ (ran.mxcsr)), expected,
                    `${what}: loaded`);
                assert.equal(/** @type {number} */ (ran.mxcsr) & 0x3f, mxcsr & 0x3f,
                    `${what}: the flags kept`);
            }
            const written = sameAt64('_controlfp_s', { stack: [OUT, wanted, mask], mxcsr });
            assert.equal(written.eax, 0);
            assert.equal(new DataView(written.data.buffer, written.data.byteOffset)
                .getUint32(OUT - 0x10000, true), abstractSse(/** @type {number} */ (written.mxcsr)),
            '_controlfp_s writes what it loaded');
            sameAt64('_controlfp_s', { stack: [0, wanted, mask], mxcsr });
        }
        const flags = abstractFlags(mxcsr);
        assert.equal(sameAt64('_statusfp', { mxcsr, status: 0x3f }).eax >>> 0, flags,
            '_statusfp reads MXCSR alone');
        const cleared = sameAt64('_clearfp', { mxcsr, status: 0x3f });
        assert.equal(cleared.eax >>> 0, flags);
        assert.equal(cleared.mxcsr, mxcsr & ~0x3f, '_clearfp clears the flags and nothing else');
    }
    assert.equal(sameAt64('_controlfp', { stack: [0, 0] }).eax >>> 0, 0x8001f,
        'the reset word: every exception masked, to nearest');
});

/** MXCSR's flags as the runtime numbers them. @param {number} word */
function abstractFlags(word){
    let bits = 0;
    for (const [x87, runtime] of EXCEPTION_BITS)
    {
        bits |= (word & x87) !== 0 ? runtime : 0;
    }
    return bits >>> 0;
}

test('_isnan, _finite and _fpclass read the bits of every kind of double', ()=>{
    const next = random(42);
    /** @type {Record<number, (low: number, high: number) => boolean>} */
    const classes = {
        0x1: (low, high)=>(high & 0x7ff80000) === 0x7ff00000 && ((high & 0x7ffff) | low) !== 0,
        0x2: (low, high)=>(high & 0x7ff80000) === 0x7ff80000,
        0x4: (low, high)=>high === 0xfff00000 && low === 0,
        0x200: (low, high)=>high === 0x7ff00000 && low === 0,
    };
    for (let i = 0; i < 600; i++)
    {
        const [low, high] = doubleBits(next);
        const value = fromWords(low, high);
        const nan = same('_isnan', { stack: [low, high] }).eax;
        const finite = same('_finite', { stack: [low, high] }).eax;
        const kind = same('_fpclass', { stack: [low, high] }).eax;
        assert.equal(nan, Number.isNaN(value) ? 1 : 0);
        assert.equal(finite, Number.isFinite(value) ? 1 : 0);
        const special = Object.entries(classes).find(([, is])=>is(low, high));
        const negative = high >>> 31 === 1;
        const expected = special ? Number(special[0])
            : value === 0 ? (negative ? 0x20 : 0x40)
                : Math.abs(value) < 2 ** -1022 ? (negative ? 0x10 : 0x80)
                    : negative ? 0x8 : 0x100;
        assert.equal(kind, expected, `_fpclass of 0x${high.toString(16)}:${low.toString(16)}`);
    }
});

test('_fpclass for a 64-bit caller reads the double out of XMM0: every kind, a signalling NaN'
    + ' as its bits say', ()=>{
    const RETURN = 0x0f00;
    const m = longMachine();
    m.write(RETURN, [0xf4]);
    const entry = halvesEntry(guestEntry(sources._fpclass, COMPILED._fpclass, {}));
    m.write(CODE_64, /** @type {NonNullable<typeof entry.long>} */ (entry.long)());
    const next = random(47);
    const seen = new Set();
    for (let i = 0; i < 600; i++)
    {
        const [low, high] = doubleBits(next);
        const bits = BigInt(high >>> 0) << 32n | BigInt(low >>> 0);
        // The integer registers hold a pattern: the double is in XMM0 alone.
        const call = callLong(m, CODE_64, { args: [bits], floats: [true], returnTo: RETURN });
        const what = `_fpclass of 0x${bits.toString(16)}`;
        assert.equal(m.rip(), RETURN + 1, `${what} returns`);
        assert.equal(m.reg('rsp'), call.entry.rsp + 8n, `${what}: RSP past the return address`);
        for (const name of KEPT_64)
        {
            assert.equal(m.reg(name), call.entry[name], `${what}: ${name} kept`);
        }
        const expected = sources._fpclass(low, high | 0);
        assert.equal(m.reg('rax'), BigInt(expected), what);
        seen.add(expected);
    }
    assert.equal(seen.size, 10, 'every class met');
});

test('_copysign, _chgsign, _logb and _nextafter', ()=>{
    const next = random(43);
    /** @type {(x: number) => number | { st0: number }} */
    const zeroLog = ()=>({ st0: -Infinity });
    for (const control of CONTROLS.slice(0, 4))
    {
        for (let i = 0; i < 150; i++)
        {
            const x = fromWords(...doubleBits(next));
            const y = fromWords(...doubleBits(next));
            same('_copysign', { stack: [...words(x), ...words(y)], control });
            same('_chgsign', { stack: words(x), control });
            same('_logb', { stack: words(x), control }, { host: ()=>zeroLog(x) });
            const toward = i % 5 === 0 ? x : i % 5 === 1 ? -y : y;
            same('_nextafter', { stack: [...words(x), ...words(toward)], control }, {
                host: (_, args)=>({ st0: fromWords(args[0], args[1]) > 0 ? Infinity
                    : -Infinity }),
            });
        }
        for (const [x, y] of [[1, 2], [1, 0], [2, 0], [-2, 0], [-1, -2], [2 ** -1022, 0],
            [5e-324, 0], [-5e-324, 1], [0, -1], [-0, 1], [1.7976931348623157e308, Infinity],
            [Infinity, 0], [-Infinity, 0], [3, 3], [0, -0]])
        {
            const answer = same('_nextafter', { stack: [...words(x), ...words(y)], control }, {
                host: ()=>({ st0: Infinity }),
            }).st[0];
            const view = new DataView(new ArrayBuffer(8));
            view.setFloat64(0, x);
            const bits = view.getBigUint64(0);
            view.setBigUint64(0, y > x === x > 0 ? bits + 1n : bits - 1n);
            // The double next to x by its bits.
            const expected = x === y ? y : x === 0 ? (y > 0 ? 5e-324 : -5e-324)
                : Number.isFinite(x) ? view.getFloat64(0) : Math.sign(x) * 1.7976931348623157e308;
            assert.ok(Object.is(answer, expected), `_nextafter(${x}, ${y}) is ${answer}`);
        }
    }
});
