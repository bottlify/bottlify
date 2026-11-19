/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * ID3DXConstantTable's methods in the guest answer as their JavaScript, input
 * by input, on cork's test machine (`scripts/guest-code/equivalence.mjs`):
 * random handle records of every register set, class and shape, records with
 * a wrong mark, handles off a record, names and nulls, a vertex and a pixel
 * shader's table. What the JavaScript answers against the host's methods is
 * `constants.test.js`'s gate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPILED } from './constants-setters.x86.js';
import { COMPILED as LONG } from './constants-setters.x64.js';
import * as sources from './constants-setters.js';
import { CALLBACK, DATA, equivalence, random } from '../../../../scripts/guest-code/equivalence.mjs';

const { same } = equivalence(COMPILED, sources);
const { sameAt64 } = equivalence(COMPILED, sources, undefined, /** @type {any} */ (LONG));

const SELF = DATA;
const BLOCK = DATA + 0x10;
const DEVICE = DATA + 0x100;
const VTABLE = DATA + 0x200;
const RECORDS = DATA + 0x1000;
const COUNT = 16;
const LISTS = DATA + 0x2000;
const INPUT = DATA + 0x3000;
const NAME = DATA + 0x3800;
const OUT = DATA + 0x3900;
const DEFAULTS = DATA + 0x3a00;

/**
 * The device's two setters: an answer made of the register and the count it
 * was given, the pixel shader's the complement of the vertex shader's, as
 * code at CALLBACK and its stand-in.
 */
const VS = [0x8b, 0x44, 0x24, 0x08, 0x33, 0x44, 0x24, 0x10, 0xc2, 0x10, 0x00];
const PS = [0x8b, 0x44, 0x24, 0x08, 0x33, 0x44, 0x24, 0x10, 0xf7, 0xd0, 0xc2, 0x10, 0x00];
const HANDED = { host: ()=>0x8876086c,
    callback: [...VS, ...new Array(16 - VS.length).fill(0xcc), ...PS],
    call: (/** @type {Uint8Array} */ _, /** @type {number} */ fn, /** @type {number[]} */ args)=>
        (fn === CALLBACK ? args[1] ^ args[3] : ~(args[1] ^ args[3])) >>> 0 };

/**
 * The same two setters in x86-64, called as the x64 convention calls: the
 * stack aligned at the entry (else ud2), the register in RDX and the count in
 * R9, the answer theirs as above.
 */
const ALIGNED = [0x49, 0x89, 0xe2, 0x41, 0x83, 0xe2, 0x0f, 0x41, 0x83, 0xfa, 0x08, 0x74, 0x02,
    0x0f, 0x0b];
const VS_64 = [...ALIGNED, 0x89, 0xd0, 0x44, 0x31, 0xc8, 0xc3];
const PS_64 = [...ALIGNED, 0x89, 0xd0, 0x44, 0x31, 0xc8, 0xf7, 0xd0, 0xc3];
const HANDED_64 = { ...HANDED,
    callback64: [...VS_64, ...new Array(32 - VS_64.length).fill(0xcc), ...PS_64] };

/**
 * @param {() => number} next @param {4 | 8} [pointer]  the process's pointer: the block
 *     the word that far past the interface, the device's methods that far apart
 * @returns {Uint8Array}
 */
function layout(next, pointer = 4){
    const bytes = new Uint8Array(0x3b00);
    const view = new DataView(bytes.buffer);
    const put = (/** @type {number} */ at, /** @type {number} */ value)=>
        view.setUint32(at - DATA, value >>> 0, true);
    put(SELF + pointer, next() % 10 === 0 ? 0 : BLOCK);
    put(BLOCK, next() % 2);
    put(DEVICE, VTABLE);
    // SetDefaults' list: the two setters, twins among them, entries with no values.
    const entries = next() % 8;
    put(BLOCK + 68, DEFAULTS);
    put(BLOCK + 72, entries);
    for (let i = 0; i < entries; i++)
    {
        const data = next() % 5 === 0 ? 0 : INPUT;
        [(next() % 2 ? 94 : 109) | (i > 0 && next() % 2 ? 0x10000 : 0), next() % 3, data,
            next() % 3].forEach((value, k)=>put(DEFAULTS + i * 16 + k * 4, value));
    }
    for (let slot = 0; slot < 120; slot++)
    {
        put(VTABLE + slot * pointer, slot === 94 ? CALLBACK
            : slot === 109 ? CALLBACK + 4 * pointer : 0);
    }
    for (let i = 0; i < COUNT; i++)
    {
        const record = RECORDS + i * 64;
        const marked = next() % 8 !== 0;
        put(record, marked ? BLOCK : BLOCK + 4);
        put(record + 4, marked || next() % 2 ? ~BLOCK : BLOCK);
        const desc = [NAME, [0, 1, 2, 2, 2, 2, 3][next() % 7], next() % 200, next() % 7,
            [0, 1, 1, 2, 3, 3, 4, 5][next() % 8], 3, next() % 6, next() % 6, next() % 6,
            0, next(), 0];
        desc.forEach((value, k)=>put(record + 8 + k * 4, value));
        put(record + 56, next() % 6 === 0 ? 1 : 0);
        put(record + 60, next() % 3 === 0 ? 0 : LISTS + i * 32);
        for (let k = 0; k < 8; k++)
        {
            put(LISTS + i * 32 + k * 4, next() % 3 === 0 ? 0 : RECORDS + 64 * (next() % COUNT));
        }
    }
    for (let at = INPUT; at < INPUT + 0x100; at += 4)
    {
        put(at, next());
    }
    [...'World', '\0'].forEach((c, k)=>{
        bytes[NAME + k - DATA] = c.charCodeAt(0);
    });
    return bytes;
}

/** A handle: a record mostly, else one off a record, a name or null. @param {() => number} next */
const handleOf = next=>{
    const pick = next() % 10;
    return pick < 7 ? RECORDS + (next() % COUNT) * 64 : pick === 7 ? RECORDS + 4
        : pick === 8 ? NAME : 0;
};

test('the table\'s methods in the guest answer, write and call the device as their JavaScript',
    ()=>{
        const next = random(29);
        for (let round = 0; round < 500; round++)
        {
            const memory = /** @type {[number, Uint8Array][]} */ ([[DATA, layout(next)]]);
            const h = handleOf(next);
            const device = next() % 10 === 0 ? 0 : DEVICE;
            const pointer = next() % 10 === 0 ? 0 : INPUT;
            same('SetMatrix', { stack: [SELF, device, h, pointer], memory }, HANDED);
            same('SetMatrixTranspose', { stack: [SELF, device, h, pointer], memory }, HANDED);
            same('SetVector', { stack: [SELF, device, h, pointer], memory }, HANDED);
            same('SetFloat', { stack: [SELF, device, h, next()], memory }, HANDED);
            same('GetConstantDesc', { stack: [SELF, h, next() % 5 === 0 ? 0 : OUT,
                next() % 3 === 0 ? 0 : OUT + 0x40], memory }, HANDED);
            same('GetConstantElement', { stack: [SELF, h, next() % 8], memory }, HANDED);
            same('SetDefaults', { stack: [SELF, device], memory }, HANDED);
        }
    });

test('the table\'s methods in a 64-bit process answer, write and call the device as their'
    + ' JavaScript', ()=>{
    const next = random(64);
    /** The calls the x86-64 answered itself. */
    const taken = { SetFloat: 0, GetConstantDesc: 0 };
    for (let round = 0; round < 500; round++)
    {
        const memory = /** @type {[number, Uint8Array][]} */ ([[DATA, layout(next, 8)]]);
        const h = handleOf(next);
        const device = next() % 10 === 0 ? 0 : DEVICE;
        const pointer = next() % 10 === 0 ? 0 : INPUT;
        sameAt64('SetMatrix', { stack: [SELF, device, h, pointer], memory }, HANDED_64);
        sameAt64('SetMatrixTranspose', { stack: [SELF, device, h, pointer], memory }, HANDED_64);
        sameAt64('SetVector', { stack: [SELF, device, h, pointer], memory }, HANDED_64);
        const set = sameAt64('SetFloat', { stack: [SELF, device, h, next()], memory },
            HANDED_64);
        const described = sameAt64('GetConstantDesc', { stack: [SELF, h,
            next() % 5 === 0 ? 0 : OUT, next() % 3 === 0 ? 0 : OUT + 0x40], memory }, HANDED_64);
        taken.SetFloat += set.handedOver ? 0 : 1;
        taken.GetConstantDesc += described.handedOver ? 0 : 1;
        sameAt64('GetConstantElement', { stack: [SELF, h, next() % 8], memory }, HANDED_64);
        sameAt64('SetDefaults', { stack: [SELF, device], memory }, HANDED_64);
    }
    assert.ok(taken.SetFloat > 20 && taken.SetFloat < 500, `SetFloat took ${taken.SetFloat}`);
    assert.ok(taken.GetConstantDesc > 100 && taken.GetConstantDesc < 500,
        `GetConstantDesc took ${taken.GetConstantDesc}`);
});
