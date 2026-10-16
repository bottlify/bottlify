/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * ID3DXEffect's setters in the guest answer as their JavaScript, input by
 * input, on cork's test machine (`scripts/guest-code/equivalence.mjs`): random
 * handle records of every type, class and shape, handles inside, outside and
 * off the arena's records, a parameter block being recorded, null pointers,
 * counts and sizes past what a parameter holds. What the JavaScript answers
 * against the host's setters is `effect.test.js`'s gate.
 */

import { test } from 'node:test';
import { COMPILED } from './effect-setters.x86.js';
import * as sources from './effect-setters.js';
import { DATA, equivalence, random } from '../../../../scripts/guest-code/equivalence.mjs';

const { same } = equivalence(COMPILED, sources);
/** The host's setter, as a stand-in: an answer of its own, nothing written. */
const HANDED = { host: ()=>0x8876086c };

const SELF = DATA;
const BLOCK = DATA + 0x10;
const CLOCK = DATA + 0x40;
const VERSIONS = DATA + 0x80;
const ARENA = DATA + 0x100;
const RECORDS = 16;
const STORES = DATA + 0x2000;
const INPUT = DATA + 0x4000;

/**
 * The effect's block, its arena of records and their stores, and an input, at
 * random.
 *
 * @param {() => number} next
 * @returns {Uint8Array}
 */
function layout(next){
    const bytes = new Uint8Array(0x4100);
    const view = new DataView(bytes.buffer);
    const put = (/** @type {number} */ at, /** @type {number} */ value)=>
        view.setUint32(at - DATA, value >>> 0, true);
    put(SELF + 4, BLOCK);
    put(BLOCK, next() % 6 === 0 ? 1 : 0);
    put(BLOCK + 4, ARENA);
    put(BLOCK + 8, RECORDS * 32);
    put(BLOCK + 12, CLOCK);
    put(CLOCK, next());
    for (let i = 0; i < RECORDS; i++)
    {
        const record = ARENA + i * 32;
        const type = [1, 2, 3, 3, 3, 4, 5, 7, 9, 10, 0xffffffff][next() % 11];
        const cls = [0, 1, 1, 2, 3, 4, 5][next() % 7];
        const rows = next() % 6;
        const columns = next() % 6;
        const elements = next() % 3 === 0 ? next() % 6 : 0;
        const size = 4 * (next() % 40);
        [type, cls, rows, columns, elements, size, STORES + i * 0x100, VERSIONS + i * 4]
            .forEach((value, k)=>put(record + k * 4, value));
    }
    for (let at = INPUT; at < INPUT + 0x100; at += 4)
    {
        put(at, next());
    }
    return bytes;
}

/** A handle: a record, mostly, else one off a record, outside the arena, or null. @param {() => number} next */
const handleOf = next=>{
    const pick = next() % 10;
    return pick < 7 ? ARENA + (next() % RECORDS) * 32 : pick === 7 ? ARENA + 4
        : pick === 8 ? ARENA + RECORDS * 32 : 0;
};

test('the setters in the guest answer, write and date as their JavaScript', ()=>{
    const next = random(11);
    for (let round = 0; round < 400; round++)
    {
        const memory = /** @type {[number, Uint8Array][]} */ ([[DATA, layout(next)]]);
        const h = handleOf(next);
        const pointer = next() % 8 === 0 ? 0 : INPUT;
        const count = next() % 8;
        const word = next();
        same('SetMatrix', { stack: [SELF, h, pointer], memory }, HANDED);
        same('SetMatrixTranspose', { stack: [SELF, h, pointer], memory }, HANDED);
        same('SetVector', { stack: [SELF, h, pointer], memory }, HANDED);
        same('SetVectorArray', { stack: [SELF, h, pointer, count], memory }, HANDED);
        same('SetFloat', { stack: [SELF, h, word], memory }, HANDED);
        same('SetInt', { stack: [SELF, h, word], memory }, HANDED);
        same('SetBool', { stack: [SELF, h, word], memory }, HANDED);
        same('SetTexture', { stack: [SELF, h, word], memory }, HANDED);
        same('SetValue', { stack: [SELF, h, pointer, 4 * (next() % 48)], memory }, HANDED);
    }
});
