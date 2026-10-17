/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The device's and the queries' methods in the guest answer as their
 * JavaScript, input by input, on cork's test machine: blocks of every query
 * type and flag, none at all, the device's cooperative word either way, null
 * and short buffers, every issue and get flag. What the JavaScript answers
 * against the host's methods is `d3d9.test.js`'s gate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { COMPILED } from './inguest.x86.js';
import * as sources from './inguest.js';
import { DATA, equivalence, random } from '../../../../scripts/guest-code/equivalence.mjs';
import { FLAG_SLOW_PATH, QUERY, SHADOW } from './shadow.js';

const { same } = equivalence(COMPILED, sources);
const HANDED = { host: ()=>0x8876086c };

const SELF = DATA;
const BLOCK = DATA + 0x10;
const OUT = DATA + 0x40;

test('the offsets the guest code reads are the blocks\'', async()=>{
    // Literals in the source, which the compiler takes, held to the blocks' names.
    const text = await readFile(new URL('./inguest.js', import.meta.url), 'utf8');
    /** @param {string} name */
    const literal = name=>Number(new RegExp(`^const ${name} = (\\d+);`, 'm').exec(text)?.[1]);
    assert.equal(literal('COOPERATIVE'), SHADOW.COOPERATIVE);
    assert.equal(literal('QUERY_TYPE'), QUERY.TYPE);
    assert.equal(literal('QUERY_STATE'), QUERY.STATE);
    assert.equal(literal('QUERY_COUNT'), QUERY.COUNT);
    assert.equal(literal('QUERY_BUDGET'), QUERY.BUDGET);
    assert.equal(literal('FLAG_SLOW_PATH'), FLAG_SLOW_PATH);
});

test('TestCooperativeLevel in the guest answers as its JavaScript', ()=>{
    const next = random(3);
    for (let round = 0; round < 200; round++)
    {
        const bytes = new Uint8Array(SHADOW.SIZE + 0x20);
        const view = new DataView(bytes.buffer);
        view.setUint32(4, next() % 8 === 0 ? 0 : BLOCK, true);
        view.setUint32(0x10, next() % 5 === 0 ? 1 + next() % 4 : 0, true);
        view.setUint32(0x10 + SHADOW.COOPERATIVE, next() % 3 === 0 ? next() : 0, true);
        same('TestCooperativeLevel', { stack: [SELF], memory: [[DATA, bytes]] }, HANDED);
    }
});

test('a query\'s methods in the guest answer and write as their JavaScript', ()=>{
    const next = random(5);
    for (let round = 0; round < 600; round++)
    {
        const bytes = new Uint8Array(0x80);
        const view = new DataView(bytes.buffer);
        view.setUint32(4, next() % 8 === 0 ? 0 : BLOCK, true);
        view.setUint32(0x10 + QUERY.TYPE, [8, 8, 8, 9, 9, 2, 0][next() % 7], true);
        // An occlusion count the host's, asked for, back, or a state there is not.
        view.setUint32(0x10 + QUERY.STATE, [0, 1, 2, 2, 3][next() % 5], true);
        view.setUint32(0x10 + QUERY.COUNT, next(), true);
        view.setUint32(0x10 + QUERY.BUDGET, [0, 1, 2, 128][next() % 4], true);
        view.setUint32(0x40, next(), true);
        const data = next() % 6 === 0 ? 0 : OUT;
        const size = [0, 1, 3, 4, 4, 8, 0xffffffff][next() % 7];
        const flags = [0, 0, 1, 2, 3, next()][next() % 6];
        const memory = /** @type {[number, Uint8Array][]} */ ([[DATA, bytes]]);
        same('QueryGetType', { stack: [SELF], memory }, HANDED);
        same('QueryGetDataSize', { stack: [SELF], memory }, HANDED);
        same('QueryIssue', { stack: [SELF, flags], memory }, HANDED);
        same('QueryGetData', { stack: [SELF, data, size, flags], memory }, HANDED);
    }
});
