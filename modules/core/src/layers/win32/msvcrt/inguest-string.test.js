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
import { COMPILED as LONG } from './inguest-string.x64.js';
import * as sources from './inguest-string.js';
import { DATA, equivalence, random } from '../../../../scripts/guest-code/equivalence.mjs';
import { createMsvcp80Functions } from './msvcp80.js';
import { guestWindow } from './guest-window.fixture.js';

const { same, sameAt64 } = equivalence(COMPILED, sources, undefined, LONG);

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

/**
 * The same string in a 64-bit program's forty bytes: eight the library
 * zeroes, the inline buffer or the text's pointer at 8, the length at 24 and
 * the capacity at 32, each a quadword.
 *
 * @param {number} self @param {string} text @param {number} reserved
 * @returns {[number, number[]][]}
 */
const longStringAt = (/** @type {number} */ self, text, reserved = 15)=>{
    const bytes = new Uint8Array(40).fill(0xee);
    const view = new DataView(bytes.buffer);
    const heap = reserved > 15;
    if (heap)
    {
        view.setBigUint64(8, BigInt(HEAP), true);
    }
    else
    {
        bytes.set([...text].map(c=>c.charCodeAt(0)).concat(0), 8);
    }
    view.setBigUint64(24, BigInt(text.length), true);
    view.setBigUint64(32, BigInt(reserved), true);
    /** @type {[number, number[]][]} */
    const memory = [[self, [...bytes]]];
    if (heap)
    {
        memory.push([HEAP, [...text].map(c=>c.charCodeAt(0)).concat(0)]);
    }
    return memory;
};

test('at 64 bits each member answers as its source in the forty-byte layout, both ways', ()=>{
    const words = random(81);
    const next = ()=>words() / 2 ** 32;
    /** @type {Map<string, Set<boolean>>} How each member went: answered, handed over. */
    const ways = new Map();
    /** @param {string} name @param {any} input @param {any} [double] */
    const run = (name, input, double)=>{
        const js = sameAt64(name, input, double);
        ways.set(name, (ways.get(name) ?? new Set()).add(js.handedOver));
    };
    for (let round = 0; round < 60; round++)
    {
        const length = Math.floor(next() * 24);
        const reserved = length > 15 || next() < 0.3
            ? Math.max(length, 15) + Math.floor(next() * 4) + 1 : 15;
        const text = randomText(next, length);
        const string = longStringAt(SELF, text, reserved);
        run('stringConstruct', { stack: [SELF], memory: [[SELF, new Array(40).fill(0xee)]] });
        run('stringFromText', { stack: [SELF, TEXT],
            memory: [[SELF, new Array(40).fill(0xee)],
                [TEXT, [...text].map(c=>c.charCodeAt(0)).concat(0)]] }, HANDED);
        run('stringCopy', { stack: [SELF, OTHER], memory: [[SELF, new Array(40).fill(0xee)],
            ...longStringAt(OTHER, text, reserved)] }, HANDED);
        run('stringDestroy', { stack: [SELF], memory: string }, HANDED);
        run('stringText', { stack: [SELF], memory: string });
        run('stringAt', { stack: [SELF, Math.floor(next() * 16)], memory: string });
        run('stringSize', { stack: [SELF], memory: string });
        run('stringAppendChar', { stack: [SELF, 0x41 + round], memory: string }, HANDED);
        run('stringResize', { stack: [SELF, Math.floor(next() * 32)], memory: string },
            HANDED);
        run('stringReserve', { stack: [SELF, Math.floor(next() * 32)], memory: string },
            HANDED);
    }
    for (const [name, fn] of Object.entries(LONG))
    {
        assert.deepEqual([...ways.get(name) ?? []].sort(),
            /** @type {readonly string[]} */ (fn.uses).includes('host') ? [false, true] : [false],
            `${name}: the ways taken`);
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
        guest: guestWindow(memory),
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
        guest: guestWindow(memory),
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

test('a 64-bit process\'s string: forty bytes, the text after the iterator list, the length'
    + ' and the capacity quadwords', ()=>{
    // _Container_base's _Myfirstiter at 0, _Bx at 8, _Mysize at 24, _Myres at 32.
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
    /** @type {number[]} */
    const singles = [];
    const table = createMsvcp80Functions(crt, {
        guest: guestWindow(memory, { pointerSize: 8 }),
        fpu: /** @type {any} */ ({ setResult: ()=>{},
            setSingleResult: (/** @type {number} */ value)=>singles.push(value) }),
    });
    const STRING = '?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@';
    assert.equal(table[`??0${STRING}QAE@XZ`], undefined, 'the 32-bit names are not there');
    for (const name of [`??0${STRING}QEAA@XZ`, `??0${STRING}QEAA@PEBD@Z`,
        `??0${STRING}QEAA@AEBV01@@Z`, `??1${STRING}QEAA@XZ`, `?c_str@${STRING}QEBAPEBDXZ`,
        `?size@${STRING}QEBA_KXZ`, `?resize@${STRING}QEAAX_K@Z`,
        `??A${STRING}QEAAAEADU_Size_type_nosscl@01@@Z`])
    {
        // Its x86-64 code from the same source, which a 64-bit process places;
        // the handler below runs that source over this process's layout.
        assert.equal(typeof table[name].long, 'function', `${name}: guest code at 64 bits`);
    }
    const self = 0x100;
    memory.fill(0xcc, self, self + 48);
    const text = (/** @type {number} */ of = self)=>{
        const at = table[`?c_str@${STRING}QEBAPEBDXZ`].handler([of]);
        let out = '';
        for (let i = at; memory[i] !== 0; i++)
        {
            out += String.fromCharCode(memory[i]);
        }
        return out;
    };
    /** @param {number} at */
    const quad = at=>[view.getUint32(at, true), view.getUint32(at + 4, true)];

    memory.set([...'short'].map(c=>c.charCodeAt(0)).concat(0), 0x400);
    assert.equal(table[`??0${STRING}QEAA@PEBD@Z`].handler([self, 0x400]), self);
    assert.equal(text(), 'short');
    assert.deepEqual([quad(self), quad(self + 24), quad(self + 32)], [[0, 0], [5, 0], [15, 0]]);
    assert.equal(String.fromCharCode(...memory.subarray(self + 8, self + 13)), 'short',
        'inline, after the iterator list');
    assert.equal(view.getUint32(self + 40, true), 0xcccccccc, 'and no byte past forty');
    assert.equal(table[`?size@${STRING}QEBA_KXZ`].handler([self]), 5);

    memory.set([...' and then nineteen more'].map(c=>c.charCodeAt(0)).concat(0), 0x440);
    table[`??Y${STRING}QEAAAEAV01@PEBD@Z`].handler([self, 0x440]);
    assert.equal(text(), 'short and then nineteen more');
    assert.deepEqual([quad(self + 8), quad(self + 24), quad(self + 32)],
        [[0x8000, 0], [28, 0], [31, 0]], 'on the heap, its pointer whole');

    const other = 0x200;
    table[`??0${STRING}QEAA@AEBV01@@Z`].handler([other, self]);
    assert.equal(text(other), 'short and then nineteen more');
    table[`?resize@${STRING}QEAAX_K@Z`].handler([other, 3]);
    assert.equal(text(other), 'sho');
    table[`??1${STRING}QEAA@XZ`].handler([self]);
    assert.deepEqual([freed, quad(self + 24), quad(self + 32)], [[0x8000], [0, 0], [15, 0]]);

    // complex<float> through the caller's result, and a float where a 64-bit caller reads it.
    new Float32Array(memory.buffer, 0x500, 4).set([1, 2, 3, 4]);
    const multiply = '??$?DM@std@@YA?AV?$complex@M@0@AEBV10@0@Z';
    assert.equal(table[multiply].handler([0x520, 0x500, 0x508]), 0x520);
    assert.deepEqual([...new Float32Array(memory.buffer, 0x520, 2)], [-5, 10]);
    table['?max@?$numeric_limits@M@std@@SAMXZ'].handler([]);
    assert.deepEqual(singles, [3.4028234663852886e38]);
    const before = next;
    assert.equal(table['?allocate@?$allocator@D@std@@QEAAPEAD_K@Z'].handler([0, 40]), before,
        'operator new\'s block');
});
