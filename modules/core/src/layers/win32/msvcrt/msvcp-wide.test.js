/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The C++ libraries in a 64-bit process whose memory lies past 2 GiB, where a
 * dword read signed names another place, and past 4 GiB, where only a whole
 * pointer names it (check-wide-addresses.mjs calls every handler so): a
 * string's text pointer is written whole, both its dwords, and read back
 * whole; a member answering an address answers it whole and says so
 * (`returns`), so RAX takes it zero-extended rather than sign-extended.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMsvcp60Functions } from './msvcp60.js';
import { createMsvcp80Functions } from './msvcp80.js';
import { guestWindow } from './guest-window.fixture.js';

const STRING = '?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@';
const SIZE = 0x10000;

/**
 * A 64-bit process's MSVCP80 over a window of memory at `base`, its operator
 * new handing out blocks there.
 *
 * @param {number} base
 */
function library(base){
    const memory = new Uint8Array(SIZE);
    const view = new DataView(memory.buffer);
    let next = base + 0x8000;
    const crt = {
        '??2@YAPAXI@Z': { handler: (/** @type {number[]} */ [bytes])=>{
            const block = next;
            next += (bytes + 15) & ~15;
            return block;
        } },
        '??3@YAXPAX@Z': { handler: ()=>0 },
    };
    const table = createMsvcp80Functions(crt, {
        guest: guestWindow(memory, { base, pointerSize: 8 }),
    });
    /** @param {number} at @param {string} text */
    const put = (at, text)=>memory.set([...text].map(c=>c.charCodeAt(0)).concat(0), at - base);
    /** A quadword of the window, whole. @param {number} at */
    const quad = at=>view.getUint32(at - base, true)
        + view.getUint32(at - base + 4, true) * 2 ** 32;
    /**
     * The arguments as the bridge hands a 64-bit call: an address the
     * function declares whole where its high half names one past 4 GiB, any
     * other its low dword, signed.
     *
     * @param {{ addresses?: number[] }} spec @param {number[]} values
     */
    const bridged = (spec, values)=>values.map((value, at)=>(spec.addresses?.includes(at)
        && value >= 2 ** 32 ? value : value | 0));
    return { table, put, quad, bridged };
}

for (const base of [0x90100000, 0x140100000])
{
    const where = `at 0x${base.toString(16)}`;

    test(`MSVCP80 at 64 bits ${where}: a string's text on the heap is a whole pointer`, ()=>{
        const { table, put, quad, bridged } = library(base);
        const make = table[`??0${STRING}QEAA@PEBD@Z`];
        const text = table[`?c_str@${STRING}QEBAPEBDXZ`];
        const self = base + 0x100;
        put(base + 0x400, 'a text longer than sixteen characters');
        make.handler(bridged(make, [self, base + 0x400]));
        const pointer = quad(self + 8);
        assert.ok(pointer >= base + 0x8000 && pointer < base + SIZE,
            `the text's pointer 0x${pointer.toString(16)} is the block, both dwords`);
        assert.equal(Number(text.handler(bridged(text, [self]))), pointer,
            'c_str() reads it back whole');
    });

    test(`MSVCP80 at 64 bits ${where}: a member answering \`this\` answers it whole`, ()=>{
        const { table, put, bridged } = library(base);
        const make = table[`??0${STRING}QEAA@PEBD@Z`];
        const append = table[`?append@${STRING}QEAAAEAV12@PEBD@Z`];
        const self = base + 0x100;
        put(base + 0x400, 'one');
        put(base + 0x440, ' and two');
        make.handler(bridged(make, [self, base + 0x400]));
        assert.equal(append.returns, 'pointer', 'RAX takes the answer zero-extended');
        assert.equal(Number(append.handler(bridged(append, [self, base + 0x440]))), self);
    });
}

test('MSVCP60 offers a 64-bit process none of its 32-bit members', ()=>{
    const memory = new Uint8Array(SIZE);
    const table = createMsvcp60Functions({}, {
        guest: guestWindow(memory, { pointerSize: 8 }),
        addressOf: ()=>0,
    });
    assert.deepEqual(Object.keys(table), []);
});
