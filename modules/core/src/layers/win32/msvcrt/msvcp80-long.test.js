/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * MSVCP80's string members a 64-bit process imports beside the ones
 * `inguest-string.test.js` holds: operator+=(char) and reserve, which carry
 * the x86-64 of their source (`inguest-string.js`, held to it there at 64
 * bits), and append, a handler. Each answers here over the forty-byte layout.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMsvcp80Functions } from './msvcp80.js';

const STRING = '?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@';

/** The library over a memory of its own, as a 64-bit process has it. */
function library(){
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
        readMemory: (address, length)=>memory.slice(address, address + length),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        pointerSize: 8,
    });
    /** @param {number} at @param {string} value */
    const put = (at, value)=>memory.set([...value].map(c=>c.charCodeAt(0)).concat(0), at);
    /** @param {number} self */
    const text = self=>{
        const at = table[`?c_str@${STRING}QEBAPEBDXZ`].handler([self]);
        let out = '';
        for (let i = at; memory[i] !== 0; i++)
        {
            out += String.fromCharCode(memory[i]);
        }
        return out;
    };
    return { memory, view: new DataView(memory.buffer), table, put, text };
}

test('operator+=(char) and reserve carry x86-64 code, and their handlers take what it hands'
    + ' over: a string grown past its capacity', ()=>{
    const { view, table, put, text } = library();
    const append = table[`??Y${STRING}QEAAAEAV01@D@Z`];
    const reserve = table[`?reserve@${STRING}QEAAX_K@Z`];
    assert.equal(typeof append.long, 'function', 'operator+=(char): guest code at 64 bits');
    assert.equal(typeof reserve.long, 'function', 'reserve: guest code at 64 bits');
    const self = 0x100;
    put(0x400, 'fifteen chars!!');
    table[`??0${STRING}QEAA@PEBD@Z`].handler([self, 0x400]);
    assert.equal(view.getUint32(self + 32, true), 15, 'inline, full');
    assert.equal(append.handler([self, 0x21]), self);
    assert.equal(text(self), 'fifteen chars!!!');
    assert.equal(view.getUint32(self + 24, true), 16);
    assert.ok(view.getUint32(self + 32, true) >= 16, 'on the heap now');
    assert.equal(view.getUint32(self + 12, true), 0, 'its pointer\'s high half clear');
    const held = view.getUint32(self + 32, true);
    reserve.handler([self, 100]);
    assert.ok(view.getUint32(self + 32, true) >= 100 && view.getUint32(self + 32, true) > held);
    assert.equal(text(self), 'fifteen chars!!!', 'the text kept across the growth');
    assert.equal(view.getUint32(self + 24, true), 16);
});

test('append takes a string and a C string, as operator+= does', ()=>{
    const { table, put, text } = library();
    put(0x400, 'one');
    put(0x440, ' and a longer second part');
    table[`??0${STRING}QEAA@PEBD@Z`].handler([0x100, 0x400]);
    table[`??0${STRING}QEAA@PEBD@Z`].handler([0x200, 0x440]);
    assert.equal(table[`?append@${STRING}QEAAAEAV12@AEBV12@@Z`].handler([0x100, 0x200]), 0x100);
    assert.equal(text(0x100), 'one and a longer second part');
    assert.equal(table[`?append@${STRING}QEAAAEAV12@PEBD@Z`].handler([0x100, 0x400]), 0x100);
    assert.equal(text(0x100), 'one and a longer second partone');
});
