/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAtomFunctions } from './atoms.js';

const NAME = 0x10000;
const NAME2 = 0x10100;
const OUT = 0x200;

function setup(){
    const bytes = new Uint8Array(0x10400);
    const fns = createAtomFunctions({
        writeMemory: (address, data)=>bytes.set(data, address),
        readCString(address, maxLength){
            let text = '';
            for (let i = 0; i < maxLength && bytes[address + i] !== 0; i++)
            {
                text += String.fromCharCode(bytes[address + i]);
            }
            return text;
        },
        setLastError(){},
    });
    /** @param {number} at @param {string} text */
    const put = (at, text)=>{
        for (let i = 0; i < text.length; i++)
        {
            bytes[at + i] = text.charCodeAt(i) & 0xff;
        }
        bytes[at + text.length] = 0;
    };
    /** @param {number} at @param {number} n */
    const read = (at, n)=>bytes.subarray(at, at + n);
    return { fns, put, read };
}

test('a name added and found returns the same atom, folded, and reference counted', ()=>{
    const { fns, put, read } = setup();
    put(NAME, 'ether-rot-mutex');
    put(NAME2, 'ETHER-ROT-MUTEX');

    const atom = fns.AddAtomA.handler([NAME]);
    assert.ok(atom >= 0xc000, 'a string atom is in the caller range');
    assert.equal(fns.FindAtomA.handler([NAME2]), atom, 'found case-insensitively');
    assert.equal(fns.AddAtomA.handler([NAME2]), atom, 'and a second add is the same atom');

    assert.equal(fns.GetAtomNameA.handler([atom, OUT, 64]), 15);
    assert.equal(String.fromCharCode(...read(OUT, 15)), 'ether-rot-mutex');

    // Two adds, so it takes two deletes before the name is gone.
    assert.equal(fns.DeleteAtom.handler([atom]), 0);
    assert.equal(fns.FindAtomA.handler([NAME]), atom, 'still there after one delete');
    assert.equal(fns.DeleteAtom.handler([atom]), 0);
    assert.equal(fns.FindAtomA.handler([NAME]), 0, 'and gone after the second');
});

test('an integer atom passed by value is that integer, not a pointer', ()=>{
    const { fns } = setup();
    // MAKEINTATOM(1): below 64 KiB, so it is the number itself.
    assert.equal(fns.AddAtomA.handler([1]), 1);
    assert.equal(fns.FindAtomA.handler([1]), 1);
    assert.equal(fns.DeleteAtom.handler([1]), 0,
        'an integer atom cannot be deleted, and that is success');
});

test('a buffer too small truncates, and the global spelling shares the table', ()=>{
    const { fns, put, read } = setup();
    put(NAME, 'LongAtomName');
    const atom = fns.GlobalAddAtomA.handler([NAME]);
    assert.equal(fns.FindAtomA.handler([NAME]), atom, 'global and local are one table here');

    assert.equal(fns.GetAtomNameA.handler([atom, OUT, 4]), 3);
    assert.equal(String.fromCharCode(...read(OUT, 4)), 'Lon\0');

    assert.equal(fns.DeleteAtom.handler([0xd999]), 0xd999, 'an atom nobody added is returned back');
});
