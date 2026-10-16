/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * `std::string`'s guest members answer the same as their x86, case by case,
 * on cork's test machine (`scripts/guest-code/equivalence.mjs`): strings
 * inline and on the heap, at and past their capacity, so each member is seen
 * both to answer in the guest and to hand the host what it should. Then the
 * host's side (`msvcp80.js`) over a memory of its own: growth as the library
 * grows, and a heap string trimmed back inline.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPILED } from './inguest-string.x86.js';
import * as sources from './inguest-string.js';
import { DATA, equivalence, random } from '../../../../scripts/guest-code/equivalence.mjs';
import { createMsvcp80Functions } from './msvcp80.js';

const { same } = equivalence(COMPILED, sources);

const SELF = DATA;
const OTHER = DATA + 0x40;
const TEXT = DATA + 0x80;
const HEAP = DATA + 0x200;

/** What the handler would answer: a mark both ways must reach alike. */
const HANDED = { host: ()=>0x5157 };

/**
 * A string's 28 bytes: inline when its capacity is 15, else its text at HEAP.
 *
 * @param {number} self @param {string} text @param {number} reserved
 * @returns {[number, number[]][]}
 */
const stringAt = (/** @type {number} */ self, text, reserved = 15)=>{
    const bytes = new Uint8Array(28);
    const view = new DataView(bytes.buffer);
    const heap = reserved > 15;
    if (heap)
    {
        view.setUint32(4, HEAP, true);
    }
    else
    {
        bytes.set([...text].map(c=>c.charCodeAt(0)).concat(0), 4);
    }
    view.setUint32(20, text.length, true);
    view.setUint32(24, reserved, true);
    /** @type {[number, number[]][]} */
    const memory = [[self, [...bytes]]];
    if (heap)
    {
        memory.push([HEAP, [...text].map(c=>c.charCodeAt(0)).concat(0)]);
    }
    return memory;
};

/** @param {() => number} next @param {number} length */
const randomText = (next, length)=>String.fromCharCode(
    ...Array.from({ length }, ()=>0x21 + Math.floor(next() * 94)));

test('each guest member answers as its source, inline, on the heap and at the capacity', ()=>{
    const words = random(80);
    const next = ()=>words() / 2 ** 32;
    for (let round = 0; round < 40; round++)
    {
        const length = Math.floor(next() * 24);
        const reserved = length > 15 || next() < 0.3
            ? Math.max(length, 15) + Math.floor(next() * 4) + 1 : 15;
        const text = randomText(next, length);
        const string = stringAt(SELF, text, reserved);
        same('stringConstruct', { stack: [SELF] });
        same('stringFromText', { stack: [SELF, TEXT],
            memory: [[TEXT, [...text].map(c=>c.charCodeAt(0)).concat(0)]] }, HANDED);
        same('stringCopy', { stack: [SELF, OTHER], memory: stringAt(OTHER, text, reserved) },
            HANDED);
        same('stringDestroy', { stack: [SELF], memory: string }, HANDED);
        same('stringText', { stack: [SELF], memory: string });
        same('stringAt', { stack: [SELF, Math.floor(next() * 16)], memory: string });
        same('stringSize', { stack: [SELF], memory: string });
        same('stringAppendChar', { stack: [SELF, 0x41 + round], memory: string }, HANDED);
        same('stringResize', { stack: [SELF, Math.floor(next() * 32)], memory: string },
            HANDED);
        same('stringReserve', { stack: [SELF, Math.floor(next() * 32)], memory: string },
            HANDED);
    }
});

test('the host grows a string as the library does, and trims it back inline', ()=>{
    const memory = new Uint8Array(0x10000);
    const view = new DataView(memory.buffer);
    let next = 0x8000;
    /** @type {number[]} */
    const freed = [];
    const crt = {
        '??2@YAPAXI@Z': { handler: (/** @type {number[]} */ [bytes])=>{
            const block = next;
            next += (bytes + 15) & ~15;
            return block;
        } },
        '??3@YAXPAX@Z': { handler: (/** @type {number[]} */ [block])=>freed.push(block) },
    };
    const table = createMsvcp80Functions(crt, {
        readMemory: (address, length)=>memory.subarray(address, address + length),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
    });
    const STRING = '?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@';
    const self = 0x100;
    const text = ()=>{
        const at = table[`?c_str@${STRING}QBEPBDXZ`].handler([self]);
        let out = '';
        for (let i = at; memory[i] !== 0; i++)
        {
            out += String.fromCharCode(memory[i]);
        }
        return out;
    };
    const reserved = ()=>view.getUint32(self + 24, true);

    memory.set([...'0123456789abcdefXYZ'].map(c=>c.charCodeAt(0)).concat(0), 0x400);
    table[`??0${STRING}QAE@PBD@Z`].handler([self, 0x400]);
    assert.equal(text(), '0123456789abcdefXYZ');
    assert.equal(reserved(), 31,
        'nineteen characters rounded up to a multiple of sixteen less one');

    for (let i = 0; i < 13; i++)
    {
        table[`??Y${STRING}QAEAAV01@D@Z`].handler([self, 0x61]);
    }
    assert.equal(view.getUint32(self + 20, true), 32);
    assert.equal(reserved(), 47, 'past 31: 32 | 15, and not yet half again as much');

    table[`?resize@${STRING}QAEXI@Z`].handler([self, 5]);
    assert.equal(text(), '01234');
    table[`?reserve@${STRING}QAEXI@Z`].handler([self, 5]);
    assert.equal(reserved(), 15, 'a heap string asked to fit in sixteen is moved back inline');
    assert.equal(text(), '01234');
    assert.equal(freed.length, 2, 'both heap blocks given back');

    table[`??1${STRING}QAE@XZ`].handler([self]);
    assert.equal(view.getUint32(self + 20, true), 0);
});

test('assignment, appending and comparison read their text before they grow', ()=>{
    const memory = new Uint8Array(0x10000);
    let next = 0x8000;
    const crt = {
        '??2@YAPAXI@Z': { handler: (/** @type {number[]} */ [bytes])=>{
            const block = next;
            next += (bytes + 15) & ~15;
            return block;
        } },
        '??3@YAXPAX@Z': { handler: ()=>0 },
    };
    const table = createMsvcp80Functions(crt, {
        readMemory: (address, length)=>memory.subarray(address, address + length),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
    });
    const STRING = '?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@';
    const put = (/** @type {number} */ at, /** @type {string} */ text)=>
        memory.set([...text].map(c=>c.charCodeAt(0)).concat(0), at);
    const read = (/** @type {number} */ self)=>{
        const at = table[`?c_str@${STRING}QBEPBDXZ`].handler([self]);
        let out = '';
        for (let i = at; memory[i] !== 0; i++)
        {
            out += String.fromCharCode(memory[i]);
        }
        return out;
    };
    put(0x400, 'twelve chars');
    table[`??0${STRING}QAE@PBD@Z`].handler([0x100, 0x400]);
    table[`??0${STRING}QAE@XZ`].handler([0x200]);
    table[`??Y${STRING}QAEAAV01@ABV01@@Z`].handler([0x100, 0x100]);
    assert.equal(read(0x100), 'twelve charstwelve chars', 'a string appended to itself');
    table[`??4${STRING}QAEAAV01@ABV01@@Z`].handler([0x200, 0x100]);
    assert.equal(read(0x200), 'twelve charstwelve chars');
    put(0x480, '!');
    table[`?append@${STRING}QAEAAV12@PBD@Z`].handler([0x200, 0x480]);
    assert.equal(read(0x200), 'twelve charstwelve chars!');
    /** @param {string} prefix */
    const named = prefix=>/** @type {{ handler: (args: number[]) => number }} */ (
        Object.entries(table).find(([name])=>name.startsWith(prefix))?.[1]);
    const differ = named('??$?9');
    const equals = named('??$?8');
    assert.equal(differ.handler([0x100, 0x200]), 1);
    put(0x500, 'twelve charstwelve chars');
    assert.equal(equals.handler([0x100, 0x500]), 1);
});
