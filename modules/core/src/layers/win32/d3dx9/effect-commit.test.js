/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * CommitChanges, BeginPass, EndPass and their Walk in the guest answer as
 * their JavaScript, input by input, on cork's test machine
 * (`scripts/guest-code/equivalence.mjs`): random commit tables of every kind
 * of entry, with triggers and versions on both sides of the pass's date,
 * stale pairs of an expression's input and its cell's date either way round,
 * constants of every conversion and setters of every arity, the device's
 * setters stand-ins that fold what they are given into a checksum in memory.
 * What the JavaScript does against the host's is `effect.test.js`'s gate. It
 * caught the compiler retargeting a load noted for another expression, whose
 * count and length matched by chance (`retarget`), when the trigger loop's
 * counter was in the frame.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPILED } from './effect-commit.x86.js';
import * as sources from './effect-commit.js';
import { CALLBACK, DATA, equivalence, random } from '../../../../scripts/guest-code/equivalence.mjs';

const { same } = equivalence(COMPILED, sources);

const SELF = DATA;
const BLOCK = DATA + 0x10;
const CLOCK = DATA + 0x40;
const CHECKSUM = DATA + 0x44;
const APPLIED = DATA + 0x48;
const DEVICE = DATA + 0x50;
const VTABLE = DATA + 0x60;
const VERSIONS = DATA + 0x100;
const TABLE = DATA + 0x400;
const WORDS = DATA + 0x800;
const LAYOUTS = DATA + 0xa00;
const SCRATCH = DATA + 0x1000;
const PASSES = DATA + 0x180;
const STATE_BLOCK = DATA + 0x90;
const TECHNIQUE = DATA + 0x1c0;
const TECHNIQUES = DATA + 0x1e0;
const BLOCK_VTABLE = DATA + 0x200;
const OUT = DATA + 0x220;

/** @param {number} value */
const le = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/** Folds a word into the checksum: rotated left by seven, then added. */
const fold = [0xc1, 0x05, ...le(CHECKSUM), 0x07, 0x01, 0x05, ...le(CHECKSUM)];
/** EAX = 1 when the second argument's low three bits are all set, else 0: an answer to keep. */
const answerOf = [0x8b, 0x44, 0x24, 0x08, 0x83, 0xe0, 0x07, 0x83, 0xf8, 0x07, 0x0f, 0x94, 0xc0,
    0x0f, 0xb6, 0xc0];
/**
 * The device's setters: at CALLBACK one of three arguments (`this`, a value
 * and one more), at +0x30 one of four, at +0x60 a constant setter of four
 * whose second points at the registers, at +0x90 one of two; each folds what
 * it is given.
 */
/** A routine, padded with int3 to the 0x30 bytes each of SETTERS takes. @param {number[]} code */
const slot = code=>[...code, ...new Array(0x30 - code.length).fill(0xcc)];
const SETTERS = [
    ...slot([0x8b, 0x44, 0x24, 0x08, 0x33, 0x44, 0x24, 0x0c, ...fold, ...answerOf, 0xc2, 0x0c,
        0x00]),
    ...slot([0x8b, 0x44, 0x24, 0x08, 0x33, 0x44, 0x24, 0x0c, 0x33, 0x44, 0x24, 0x10, ...fold,
        ...answerOf, 0xc2, 0x10, 0x00]),
    ...slot([0x8b, 0x54, 0x24, 0x0c, 0x8b, 0x02, 0x03, 0x42, 0x04, 0x33, 0x44, 0x24, 0x08, 0x33,
        0x44, 0x24, 0x10, ...fold, 0x31, 0xc0, 0xc2, 0x10, 0x00]),
    ...slot([0x8b, 0x44, 0x24, 0x08, ...fold, ...answerOf, 0xc2, 0x08, 0x00]),
    // A state block's Capture and Apply: one argument, no answer to keep.
    ...slot([0x8b, 0x44, 0x24, 0x04, ...fold, 0x31, 0xc0, 0xc2, 0x04, 0x00]),
];

/**
 * The setters' JavaScript stand-in, over the case's memory.
 *
 * @param {Uint8Array} memory @param {number} fn @param {number[]} args
 */
const setter = (memory, fn, args)=>{
    const view = new DataView(memory.buffer, memory.byteOffset);
    const at = (/** @type {number} */ address)=>address;
    const registers = args[2];
    const eax = fn === CALLBACK + 0x60
        ? (((view.getUint32(at(registers), true) + view.getUint32(at(registers) + 4, true)) | 0)
            ^ args[1] ^ args[3]) >>> 0
        : fn === CALLBACK + 0xc0 ? args[0] >>> 0
            : fn === CALLBACK + 0x90 ? args[1] >>> 0
                : (args[1] ^ args[2] ^ (fn === CALLBACK + 0x30 ? args[3] : 0)) >>> 0;
    const sum = view.getUint32(at(CHECKSUM), true);
    view.setUint32(at(CHECKSUM), (((sum << 7) | (sum >>> 25)) + eax) >>> 0, true);
    return fn === CALLBACK + 0x60 || fn === CALLBACK + 0xc0 ? 0 : ((args[1] & 7) === 7 ? 1 : 0);
};

/** The host's CommitChanges, as a stand-in: an answer of its own, nothing written. */
const HANDED = { host: ()=>0x8876086c };

/**
 * A commit table at random, with everything it names.
 *
 * @param {() => number} next
 */
function layout(next){
    const bytes = new Uint8Array(0x1100);
    const view = new DataView(bytes.buffer);
    const put = (/** @type {number} */ at, /** @type {number} */ value)=>
        view.setUint32(at - DATA, value >>> 0, true);
    const putF = (/** @type {number} */ at, /** @type {number} */ value)=>
        view.setFloat32(at - DATA, value, true);
    put(SELF + 4, next() % 20 === 0 ? 0 : BLOCK);
    put(BLOCK + 12, CLOCK);
    put(BLOCK + 16, next() % 15 === 0 ? 0 : TABLE);
    // The pass begun, the passes (each a table, standing for one, and a number), Walk.
    put(BLOCK + 20, next() % 3 === 0 ? 1 + next() % 3 : 0);
    put(BLOCK + 24, next() % 5 === 0 ? 0 : PASSES);
    put(BLOCK + 28, CALLBACK);
    // Begun or not and with what flags, the technique current, the techniques
    // (each a handle and its record), the state blocks Begin keeps.
    put(BLOCK + 32, next() % 3 === 0 ? 0 : 1);
    put(BLOCK + 36, next() % 8);
    put(BLOCK + 40, next() % 6 === 0 ? 0 : TECHNIQUE);
    put(BLOCK + 44, next() % 6 === 0 ? 0 : TECHNIQUES);
    put(TECHNIQUE, next() % 4 === 0 ? 0 : PASSES);
    for (let k = 0; k < 4; k++)
    {
        put(TECHNIQUE + 4 + 4 * k, next() % 3 === 0 ? 0 : STATE_BLOCK);
    }
    put(STATE_BLOCK, BLOCK_VTABLE);
    put(BLOCK_VTABLE + 16, CALLBACK + 0xc0);
    put(BLOCK_VTABLE + 20, CALLBACK + 0xc0);
    const techniques = next() % 4;
    put(TECHNIQUES, techniques);
    for (let i = 0; i < techniques; i++)
    {
        put(TECHNIQUES + 4 + 8 * i, 0x5000 + 16 * i);
        put(TECHNIQUES + 8 + 8 * i, next() % 5 === 0 ? 0 : TECHNIQUE);
    }
    const passes = next() % 4;
    put(PASSES, passes);
    for (let i = 0; i < passes; i++)
    {
        // BeginPass reads a table's stale pairs: the one table, or none.
        put(PASSES + 4 + 8 * i, next() % 4 === 0 ? 0 : TABLE);
        put(PASSES + 8 + 8 * i, 1 + next() % 5);
    }
    put(CLOCK, 1000 + next() % 100);
    const applied = 500 + next() % 100;
    put(APPLIED, applied);
    put(DEVICE, VTABLE);
    // Slot 2 the setter of three, 3 of four, 4 the constants', 5 the setter of two.
    put(VTABLE + 8, CALLBACK);
    put(VTABLE + 12, CALLBACK + 0x30);
    put(VTABLE + 16, CALLBACK + 0x60);
    put(VTABLE + 20, CALLBACK + 0x90);
    for (let i = 0; i < 16; i++)
    {
        // Versions before and after the pass's date.
        put(VERSIONS + 4 * i, applied - 50 + next() % 100);
    }
    for (let i = 0; i < 64; i++)
    {
        const pick = next() % 4;
        if (pick === 0)
        {
            putF(WORDS + 4 * i, (next() % 4000 - 2000) / 7);
        }
        else
        {
            put(WORDS + 4 * i, pick === 1 ? next() % 3 : pick === 2 ? next() % 300 - 150 : next());
        }
    }
    const triggers = next() % 3;
    // Stale pairs: an input's version and a cell's date, either side of each other.
    const stale = next() % 4;
    const entries = next() % 8;
    put(TABLE, DEVICE);
    put(TABLE + 4, APPLIED);
    put(TABLE + 8, entries);
    put(TABLE + 12, SCRATCH);
    put(TABLE + 16, triggers);
    put(TABLE + 20, stale);
    for (let t = 0; t < triggers; t++)
    {
        put(TABLE + 24 + 4 * t, VERSIONS + 4 * (next() % 16));
    }
    for (let k = 0; k < stale; k++)
    {
        put(TABLE + 24 + 4 * triggers + 8 * k, VERSIONS + 4 * (next() % 16));
        put(TABLE + 28 + 4 * triggers + 8 * k, VERSIONS + 4 * (next() % 16));
    }
    for (let e = 0; e < entries; e++)
    {
        const at = TABLE + 24 + 4 * triggers + 8 * stale + 32 * e;
        const kind = 1 + next() % 9;
        const constants = kind <= 6;
        const arity = constants ? 0 : 1 + next() % 3;
        let data = WORDS + 4 * (next() % 64);
        if (constants)
        {
            data = LAYOUTS + 0x40 * e;
            const units = next() % 9;
            put(data, units);
            put(data + 4, WORDS + 4 * (next() % 32));
            for (let i = 0; i < units; i++)
            {
                put(data + 8 + 4 * i, next() % 5 === 0 ? -1 : next() % 16);
            }
        }
        [kind, VERSIONS + 4 * (next() % 16), constants ? 4 : [0, 5, 2, 3][arity], next() % 300,
            next() % 300, data, next() % 4, arity].forEach((value, k)=>put(at + 4 * k, value));
    }
    return bytes;
}

test('Walk in the guest calls and dates as its JavaScript, every entry or the changed ones', ()=>{
    const next = random(23);
    for (let round = 0; round < 800; round++)
    {
        const memory = /** @type {[number, Uint8Array][]} */ ([[DATA, layout(next)]]);
        same('Walk', { stack: [BLOCK, TABLE, next() % 2], memory,
            control: [0x27f, 0x07f][round % 2] }, { ...HANDED, callback: SETTERS, call: setter });
    }
    assert.ok(true);
});

test('CommitChanges, BeginPass, EndPass, Begin, End, SetTechnique and GetTechnique in the guest'
    + ' hand over, walk and answer as their'
    + ' JavaScript', ()=>{
    // Walk stands in as the setter of three: what it is given folded, an answer
    // of the table's low bits.
    const next = random(29);
    for (let round = 0; round < 3500; round++)
    {
        const memory = /** @type {[number, Uint8Array][]} */ ([[DATA, layout(next)]]);
        const index = next() % 6 === 0 ? next() : next() % 4;
        const handle = next() % 5 === 0 ? next() : 0x5000 + 16 * (next() % 4);
        const [name, stack] = /** @type {[string, number[]]} */ ([['CommitChanges', [SELF]],
            ['BeginPass', [SELF, index]], ['EndPass', [SELF]],
            ['Begin', [SELF, next() % 4 === 0 ? 0 : OUT, next() % 8]], ['End', [SELF]],
            ['SetTechnique', [SELF, next() % 9 === 0 ? 0 : handle]],
            ['GetTechnique', [SELF, index]]][round % 7]);
        same(name, { stack, memory }, { ...HANDED, callback: SETTERS, call: setter });
    }
    assert.ok(true);
});
