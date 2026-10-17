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
import { nameHash } from './effect.js';

const { same } = equivalence(COMPILED, sources);
/**
 * Where Resolve's code is, the block's RESOLVE pointing there: a page of its
 * own, since it is longer than the machine's callback room and code on the
 * page each case's layout is written over is cut where it was translated.
 */
const RESOLVE = DATA + 0x8000;
/**
 * The host's setter, as a stand-in: an answer of its own, nothing written; and
 * Resolve's JavaScript the stand-in for a call to its code.
 */
/** @param {Uint8Array} memory @param {number} fn @param {number[]} args */
const resolveCall = (memory, fn, args)=>{
    const view = new DataView(memory.buffer, memory.byteOffset);
    const guest = { u8: (/** @type {number} */ at)=>memory[at],
        u32: (/** @type {number} */ at)=>view.getUint32(at, true) };
    return fn === RESOLVE ? /** @type {any} */ (sources).Resolve(guest, args[0], args[1]) : 0;
};
const HANDED = { host: ()=>0x8876086c, call: resolveCall };

const SELF = DATA;
const BLOCK = DATA + 0x10;
const CLOCK = DATA + 0x40;
const VERSIONS = DATA + 0x80;
const ARENA = DATA + 0x100;
const RECORDS = 16;
const STORES = DATA + 0x2000;
const INPUT = DATA + 0x4000;
/** The table of names, and the names: those it holds, a hash shared, and one it does not. */
const NAMES = DATA + 0x4200;
const TEXTS = DATA + 0x4300;
const KNOWN = ['World', 'ViewProjection', 'Fog', 'a', 'Light.color'];
const UNKNOWN = ['Missing', 'Worl', 'World2', ''];
/** Pointers into the input, a null among them now and then, for the pointer-array setters. */
const POINTERS = DATA + 0x4100;

/**
 * The effect's block, its arena of records and their stores, and an input, at
 * random.
 *
 * @param {() => number} next
 * @returns {Uint8Array}
 */
function layout(next){
    const bytes = new Uint8Array(0x4400);
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
    for (let k = 0; k < 8; k++)
    {
        put(POINTERS + 4 * k, next() % 8 === 0 ? 0 : INPUT + 16 * (next() % 8));
    }
    // The table, as effect.js's nameTable lays it out, or none; and where Resolve is.
    const names = [...KNOWN, ...UNKNOWN];
    names.forEach((name, i)=>{
        [...name, '\0'].forEach((c, k)=>{
            bytes[TEXTS + 32 * i + k - DATA] = c.charCodeAt(0);
        });
    });
    put(BLOCK + 48, next() % 6 === 0 ? 0 : NAMES);
    put(BLOCK + 52, RESOLVE);
    put(NAMES, 7);
    KNOWN.forEach((name, i)=>{
        let slot = nameHash(name) & 7;
        while (view.getUint32(NAMES + 4 + 12 * slot + 8 - DATA, true) !== 0)
        {
            slot = (slot + 1) & 7;
        }
        [nameHash(name), TEXTS + 32 * i, ARENA + 32 * (next() % RECORDS)]
            .forEach((value, k)=>put(NAMES + 4 + 12 * slot + 4 * k, value));
    });
    return bytes;
}

/** A handle: a record, mostly, else one off a record, outside the arena, or null. @param {() => number} next */
const handleOf = next=>{
    const pick = next() % 12;
    return pick < 6 ? ARENA + (next() % RECORDS) * 32 : pick === 6 ? ARENA + 4
        : pick === 7 ? ARENA + RECORDS * 32 : pick === 8 ? 0
            : TEXTS + 32 * (next() % (KNOWN.length + UNKNOWN.length));
};

test('the setters in the guest answer, write and date as their JavaScript', ()=>{
    const next = random(11);
    for (let round = 0; round < 400; round++)
    {
        const memory = /** @type {[number, Uint8Array][]} */ ([[DATA, layout(next)],
            [RESOLVE, COMPILED.Resolve.code]]);
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
        for (const name of ['SetIntArray', 'SetFloatArray', 'SetBoolArray'])
        {
            same(name, { stack: [SELF, h, pointer, next() % 48], memory }, HANDED);
        }
        for (const name of ['SetMatrixArray', 'SetMatrixTransposeArray'])
        {
            same(name, { stack: [SELF, h, pointer, next() % 4], memory }, HANDED);
        }
        const pointers = next() % 8 === 0 ? 0 : POINTERS;
        for (const name of ['SetMatrixPointerArray', 'SetMatrixTransposePointerArray'])
        {
            same(name, { stack: [SELF, h, pointers, next() % 9], memory }, HANDED);
        }
    }
});
