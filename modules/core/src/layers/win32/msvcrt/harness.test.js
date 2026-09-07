/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * The guest memory the msvcrt tests run against.
 *
 * `readMemory` hands back a view rather than a copy, deliberately: that is what
 * the real memory layer does, and a function that reads a block and then writes
 * over it -- a swap, an overlapping move -- only fails when the read is a view.
 * A test double that copied would pass either way.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

/** @param {number} [base] */
export function fakeMemory(base = 0x10000){
    const bytes = new Uint8Array(1 << 20);
    let next = base;

    const memory = {
        bytes,

        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.subarray(address, address + length),

        /** @param {number} address @param {Uint8Array} source */
        writeMemory: (address, source)=>bytes.set(source, address),

        /** @param {number} address @param {number} max */
        readCString: (address, max)=>{
            let text = '';
            for (let at = 0; at < max && bytes[address + at] !== 0; at++)
            {
                text += String.fromCharCode(bytes[address + at]);
            }
            return text;
        },

        /** @param {number} size */
        allocate: size=>{
            const at = next;
            next += (size + 7) & ~7;
            return at;
        },

        /** Places a C string and answers where it went. @param {string} text */
        put(text){
            const at = memory.allocate(text.length + 1);
            memory.writeMemory(at, new Uint8Array(
                [...text].map(character=>character.charCodeAt(0)).concat(0)));
            return at;
        },

        /** @param {number} address */
        text: address=>memory.readCString(address, 1 << 16),

        /** @param {number} address */
        u32: address=>new DataView(bytes.buffer).getUint32(address, true),

        /** @param {number} address */
        i32: address=>new DataView(bytes.buffer).getInt32(address, true),

        /** @param {number} address @param {number} value */
        setU32(address, value){
            new DataView(bytes.buffer).setUint32(address, value >>> 0, true);
        },

        /** @param {number} address @param {number} count */
        wide(address, count = 1 << 12){
            let text = '';
            const view = new DataView(bytes.buffer);
            for (let at = 0; at < count; at++)
            {
                const unit = view.getUint16(address + at * 2, true);
                if (unit === 0)
                {
                    break;
                }
                text += String.fromCharCode(unit);
            }
            return text;
        },

        /** @param {string} text */
        putWide(text){
            const at = memory.allocate((text.length + 1) * 2);
            const view = new DataView(bytes.buffer);
            for (let unit = 0; unit < text.length; unit++)
            {
                view.setUint16(at + unit * 2, text.charCodeAt(unit), true);
            }
            view.setUint16(at + text.length * 2, 0, true);
            return at;
        },
    };
    return memory;
}

/**
 * The double a cdecl caller pushed, as the two slots a handler receives.
 *
 * @param {number} value
 * @returns {number[]}
 */
export function doubleSlots(value){
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value, true);
    return [view.getInt32(0, true), view.getInt32(4, true)];
}

/** An FPU seam that records what was left in ST(0). */
export function fakeFpu(){
    /** @type {number[]} */
    const stack = [];
    return {
        stack,
        result: NaN,
        /** @param {number} value */
        setResult(value){
            this.result = value;
            stack.unshift(value);
        },
        /** @param {number} index */
        get: index=>stack[index],
        pop: ()=>{
            stack.shift();
        },
        /** @param {number[]} values ST(0) first. */
        load(values){
            stack.length = 0;
            stack.push(...values);
        },
    };
}

test('the double reads back as a view, so a swap must copy to be correct', ()=>{
    const memory = fakeMemory();
    const at = memory.put('ab');
    const view = memory.readMemory(at, 2);
    memory.writeMemory(at, new Uint8Array([0x7a]));
    assert.equal(view[0], 0x7a, 'a view follows the write');
    assert.equal(memory.readMemory(at, 2).slice()[0], 0x7a);
});

test('strings placed by the harness read back through readCString', ()=>{
    const memory = fakeMemory();
    assert.equal(memory.text(memory.put('hello')), 'hello');
    assert.equal(memory.wide(memory.putWide('wide')), 'wide');
});
