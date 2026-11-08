/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { watchedArgument } from './watch-arguments.js';

/**
 * A call at stack 0x100 whose arguments are a string pointer, a double 2.5
 * by value (two words) and an object pointer whose field 4 points at bytes.
 */
function call(){
    const memory = new Uint8Array(0x1000);
    const view = new DataView(memory.buffer);
    const put = (/** @type {number} */ at, /** @type {string} */ text)=>memory.set(
        [...text].map(c=>c.charCodeAt(0)).concat(0), at);
    put(0x400, 'GT1 fps');
    view.setUint32(0x104, 0x400, true);
    view.setFloat64(0x108, 2.5, true);
    view.setUint32(0x110, 0x500, true);
    view.setUint32(0x504, 0x600, true);
    memory.set([1, 2, 3], 0x600);
    put(0x700, 'in ecx');
    return {
        esp: 0x100, ecx: 0x700, edx: 0xfff00,
        readU32: (/** @type {number} */ at)=>view.getUint32(at, true),
        readBytes: (/** @type {number} */ at, /** @type {number} */ length)=>{
            if (at + length > memory.length)
            {
                throw new RangeError('unmapped');
            }
            return memory.slice(at, at + length);
        },
        readCString: (/** @type {number} */ at, /** @type {number} */ max)=>{
            if (at >= memory.length)
            {
                throw new RangeError('unmapped');
            }
            const end = memory.indexOf(0, at);
            return String.fromCharCode(...memory.subarray(at, Math.min(end, at + max)));
        },
    };
}

test('an argument as a string, a register, bytes where it points and through a field', ()=>{
    const watched = call();
    assert.equal(watchedArgument(0, watched), 'GT1 fps');
    assert.equal(watchedArgument('0', watched), 'GT1 fps');
    assert.equal(watchedArgument('ecx', watched), 'in ecx');
    assert.equal(watchedArgument('@700', watched), 'in ecx');
    assert.equal(watchedArgument('0*3', watched), '0x400:475431');
    assert.equal(watchedArgument('[3.4]*3', watched), '0x600:010203');
    assert.equal(watchedArgument('edx', watched), '0xfff00', 'not readable: its pointer');
    assert.equal(watchedArgument('edx*4', watched), '0xfff00:unmapped');
});

test('$N*len: the stack from argument N on, a double passed by value', ()=>{
    const watched = call();
    const [, hex] = watchedArgument('$1*8', watched).split(':');
    assert.equal(watchedArgument('$1*8', watched).split(':')[0], '0x108');
    const bytes = Uint8Array.from(hex.match(/../g) ?? [], b=>parseInt(b, 16));
    assert.equal(new DataView(bytes.buffer).getFloat64(0, true), 2.5);
});
