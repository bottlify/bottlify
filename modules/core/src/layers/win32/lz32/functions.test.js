/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLzFunctions } from './functions.js';

const OF_READ = 0x0000;
const OF_CREATE = 0x1000;
const OF_EXIST = 0x4000;
const LZERROR_BADINHANDLE = -1;

/**
 * "abcabcabc" the way COMPRESS.EXE writes it: a header naming the expanded
 * length and the character taken off the name, three literals, then one
 * reference back to them.
 */
const PACKED = new Uint8Array([
    0x53, 0x5a, 0x44, 0x44, 0x88, 0xf0, 0x27, 0x33, 0x41, 0x4c, 9, 0, 0, 0,
    0b00000111, 0x61, 0x62, 0x63, 0xf0, 0xf3,
]);

/** @param {Record<string, Uint8Array>} initial */
function setup(initial){
    /** @type {Map<string, Uint8Array>} */
    const store = new Map(
        Object.entries(initial).map(([path, bytes])=>[path.toLowerCase(), bytes]));
    const memory = new Uint8Array(0x2000);
    const fns = createLzFunctions({
        // As the memory layer reads an ANSI string: in Windows-1252, which is
        // what the Encoding standard calls latin1.
        readCString: (address, maxLength)=>{
            let end = address;
            while (end - address < maxLength && memory[end] !== 0)
            {
                end++;
            }
            return new TextDecoder('latin1').decode(memory.subarray(address, end));
        },
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        files: {
            /** @param {string} path */
            stat(path){
                const bytes = store.get(path.toLowerCase());
                return bytes ? { exists: true, isDirectory: false, size: bytes.length } : null;
            },
            /** @param {string} path @param {{ create?: boolean, truncate?: boolean }} mode */
            open(path, mode){
                const key = path.toLowerCase();
                if (!store.has(key) && !mode.create)
                {
                    return null;
                }
                if (mode.truncate || !store.has(key))
                {
                    store.set(key, new Uint8Array(0));
                }
                return { key };
            },
            /** @param {{ key: string }} node @param {number} offset @param {number} length */
            read: (node, offset, length)=>
                /** @type {Uint8Array} */ (store.get(node.key)).slice(offset, offset + length),
            /** @param {{ key: string }} node @param {number} offset @param {Uint8Array} bytes */
            write(node, offset, bytes){
                store.set(node.key, bytes.slice());
                return bytes.length;
            },
            close(){},
            /** @param {string} path */
            remove: path=>store.delete(path.toLowerCase()),
        },
    });
    let next = 0x100;
    /** @param {string} text */
    const plant = text=>{
        const at = next;
        for (let i = 0; i < text.length; i++)
        {
            memory[at + i] = text.charCodeAt(i);
        }
        memory[at + text.length] = 0;
        next = at + text.length + 1;
        return at;
    };
    return { fns, memory, store, plant };
}

test('a compressed source is copied expanded into a created destination', ()=>{
    const { fns, memory, store, plant } = setup({ 'C:\\TEMP\\SETUP.DL_': PACKED });
    const OFSTRUCT = 0x1000;
    const source = fns.LZOpenFileA.handler([plant('C:\\TEMP\\SETUP.DL_'), OFSTRUCT, OF_READ]);
    assert.ok(source > 0);
    assert.equal(memory[OFSTRUCT], 136, 'the OFSTRUCT is filled: its own size first');
    const destination = fns.LZOpenFileA.handler(
        [plant('C:\\TEMP\\SETUP.DLL'), OFSTRUCT, OF_CREATE]);
    assert.ok(destination > 0);
    assert.equal(fns.LZCopy.handler([source, destination]), 9);
    assert.equal(new TextDecoder().decode(store.get('c:\\temp\\setup.dll')), 'abcabcabc');
    fns.LZClose.handler([source]);
    fns.LZClose.handler([destination]);
    assert.equal(fns.LZCopy.handler([source, destination]), LZERROR_BADINHANDLE >>> 0,
        'a closed handle is no handle');
});

test('a name that is not there is tried with an underscore; an existence check says which', ()=>{
    const { fns, memory, plant } = setup({ 'C:\\TEMP\\SETUP.DL_': PACKED });
    const OFSTRUCT = 0x1000;
    assert.equal(fns.LZOpenFileA.handler([plant('C:\\TEMP\\SETUP.DLL'), OFSTRUCT, OF_EXIST]), 1);
    const found = new TextDecoder().decode(memory.subarray(OFSTRUCT + 8, OFSTRUCT + 8 + 17));
    assert.equal(found, 'C:\\TEMP\\SETUP.DL_');
    assert.equal(fns.LZOpenFileA.handler([plant('C:\\TEMP\\OTHER.DLL'), OFSTRUCT, OF_READ]),
        LZERROR_BADINHANDLE);
    const OUT = 0x1800;
    assert.equal(fns.GetExpandedNameA.handler([plant('C:\\TEMP\\SETUP.DL_'), OUT]), 1);
    assert.equal(new TextDecoder().decode(memory.subarray(OUT, OUT + 17)), 'C:\\TEMP\\SETUP.DLL');
});

test('names in the upper half of the ANSI page keep their bytes, the header\'s letter too', ()=>{
    // 0x80 is the euro sign in Windows-1252 and 0x99 the trade mark: a path
    // read in that page goes back into the OFSTRUCT and GetExpandedNameA's
    // answer in it, and the letter the header kept is a byte of the same page.
    const packed = PACKED.slice();
    packed[9] = 0x99;
    const { fns, memory } = setup({ 'C:\\\u20ac\\SETUP.DL_': packed });
    const name = 0x100;
    memory.set([0x43, 0x3a, 0x5c, 0x80, 0x5c, ...[...'SETUP.DL_'].map(c=>c.charCodeAt(0)), 0],
        name);
    const OFSTRUCT = 0x1000;
    assert.ok(fns.LZOpenFileA.handler([name, OFSTRUCT, OF_READ]) > 0);
    assert.deepEqual([...memory.subarray(OFSTRUCT + 8, OFSTRUCT + 13)],
        [0x43, 0x3a, 0x5c, 0x80, 0x5c]);
    const OUT = 0x1800;
    assert.equal(fns.GetExpandedNameA.handler([name, OUT]), 1);
    assert.deepEqual([...memory.subarray(OUT, OUT + 15)],
        [0x43, 0x3a, 0x5c, 0x80, 0x5c, ...[...'SETUP.DL'].map(c=>c.charCodeAt(0)), 0x99, 0]);
});

test('every function declares the stack its arguments occupy', ()=>{
    const { fns } = setup({});
    assert.deepEqual(
        Object.fromEntries(Object.entries(fns).map(([name, entry])=>[name, entry.argBytes])),
        { LZOpenFileA: 12, LZCopy: 8, LZClose: 4, GetExpandedNameA: 8 });
});
