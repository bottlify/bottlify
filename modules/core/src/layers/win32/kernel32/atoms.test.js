/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAtomFunctions } from './atoms.js';
import { decodeAnsi } from './locale.js';

const NAME = 0x10000;
const NAME2 = 0x10100;
const OUT = 0x200;

function setup(){
    const bytes = new Uint8Array(0x10400);
    const fns = createAtomFunctions({
        writeMemory: (address, data)=>bytes.set(data, address),
        // As the memory layer reads an ANSI string: in Windows-1252, which is
        // what the Encoding standard calls latin1.
        readCString(address, maxLength){
            let end = address;
            while (end - address < maxLength && bytes[end] !== 0)
            {
                end++;
            }
            return decodeAnsi(bytes.subarray(address, end));
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

test('a name in the upper half of the ANSI page reads back as the bytes it was added as', ()=>{
    // The name is kept as the memory layer read it, where 0x80 is the euro
    // sign, 0x99 the trade mark and 0x97 an em dash, and goes back in that page.
    const { fns, read } = setup();
    const bytes = read(NAME, 5);
    bytes.set([0x80, 0x99, 0x97, 0xe9, 0]);
    const atom = fns.AddAtomA.handler([NAME]);
    assert.equal(fns.GetAtomNameA.handler([atom, OUT, 64]), 4);
    assert.deepEqual([...read(OUT, 5)], [0x80, 0x99, 0x97, 0xe9, 0]);
});

test('the wide spellings add and find in the same table', ()=>{
    const bytes = new Uint8Array(0x10400);
    const fns = createAtomFunctions({
        writeMemory: (address, data)=>bytes.set(data, address),
        readCString: ()=>'',
        readWideString(address, maxLength){
            let text = '';
            for (let at = address; text.length < maxLength && (bytes[at] | bytes[at + 1]) !== 0;
                at += 2)
            {
                text += String.fromCharCode(bytes[at] | bytes[at + 1] << 8);
            }
            return text;
        },
    });
    const WIDE_NAME = 0x10100;
    [...'Futuremark'].forEach((unit, index)=>{
        bytes[WIDE_NAME + index * 2] = unit.charCodeAt(0);
    });
    const atom = fns.GlobalAddAtomW.handler([WIDE_NAME]);
    assert.ok(atom >= 0xc000);
    assert.equal(fns.GlobalFindAtomW.handler([WIDE_NAME]), atom);
    assert.equal(fns.AddAtomW.handler([WIDE_NAME]), atom, 'one table for both spellings');
    assert.equal(fns.FindAtomW.handler([0x1234]), 0x1234, 'an integer atom is itself');
});

test('the wide name reads back in UTF-16, cut to the characters asked for', ()=>{
    const bytes = new Uint8Array(0x10400);
    const fns = createAtomFunctions({
        writeMemory: (address, data)=>bytes.set(data, address),
        readCString(address){
            let end = address;
            while (bytes[end] !== 0)
            {
                end++;
            }
            return decodeAnsi(bytes.subarray(address, end));
        },
    });
    bytes.set([...'Caf\u00e9'].map(c=>c.charCodeAt(0)), NAME);
    const atom = fns.GlobalAddAtomA.handler([NAME]);
    /** @param {number} at @param {number} units */
    const wide = (at, units)=>String.fromCharCode(
        ...new Uint16Array(bytes.slice(at, at + units * 2).buffer));

    assert.equal(fns.GlobalGetAtomNameW.handler([atom, OUT, 64]), 4);
    assert.equal(wide(OUT, 5), 'Caf\u00e9\0');
    assert.equal(fns.GetAtomNameW.handler([atom, OUT, 3]), 2);
    assert.equal(wide(OUT, 3), 'Ca\0');
    assert.equal(fns.GlobalGetAtomNameW.handler([0x2a, OUT, 64]), 3);
    assert.equal(wide(OUT, 4), '#42\0');
});
