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
import { COMPILED } from './constants-setters.x86.js';
import * as sources from './constants-setters.js';
import { CALLBACK, DATA, equivalence, random } from '../../../../scripts/guest-code/equivalence.mjs';

const { same } = equivalence(COMPILED, sources);

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

/** @param {() => number} next @returns {Uint8Array} */
function layout(next){
    const bytes = new Uint8Array(0x3a00);
    const view = new DataView(bytes.buffer);
    const put = (/** @type {number} */ at, /** @type {number} */ value)=>
        view.setUint32(at - DATA, value >>> 0, true);
    put(SELF + 4, next() % 10 === 0 ? 0 : BLOCK);
    put(BLOCK, next() % 2);
    put(DEVICE, VTABLE);
    for (let slot = 0; slot < 120; slot++)
    {
        put(VTABLE + slot * 4, slot === 94 ? CALLBACK : slot === 109 ? CALLBACK + 16 : 0);
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
        }
    });
