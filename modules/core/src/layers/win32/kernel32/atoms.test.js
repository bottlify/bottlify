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

/**
 * As the memory layer reads: a string with no terminator within the limit
 * (bytes) is refused with the code that says so, and errors are recorded.
 */
function strictSetup(){
    const bytes = new Uint8Array(0x10800);
    /** @type {number[]} */
    const errors = [];
    /** @param {number} address @param {number} limit @param {number} unit */
    const units = (address, limit, unit)=>{
        for (let at = 0; at + unit <= limit; at += unit)
        {
            if (bytes[address + at] === 0 && (unit === 1 || bytes[address + at + 1] === 0))
            {
                return at / unit;
            }
        }
        throw Object.assign(new Error('unterminated'), { code: 'UNTERMINATED' });
    };
    const fns = createAtomFunctions({
        writeMemory: (address, data)=>bytes.set(data, address),
        readCString: (address, limit)=>decodeAnsi(bytes.subarray(address,
            address + units(address, limit, 1))),
        readWideString: (address, limit)=>String.fromCharCode(...new Uint16Array(
            bytes.slice(address, address + units(address, limit, 2) * 2).buffer)),
        setLastError: code=>errors.push(code),
    });
    /** @param {number} at @param {string} text @param {boolean} [wide] */
    const put = (at, text, wide = false)=>{
        const unit = wide ? 2 : 1;
        [...`${text}\0`].forEach((c, i)=>{
            bytes[at + i * unit] = c.charCodeAt(0);
            if (wide)
            {
                bytes[at + i * unit + 1] = 0;
            }
        });
    };
    /** @param {number} at @param {number} n */
    const ansi = (at, n)=>String.fromCharCode(...bytes.subarray(at, at + n));
    /** @param {number} at @param {number} n */
    const wide = (at, n)=>String.fromCharCode(
        ...new Uint16Array(bytes.slice(at, at + n * 2).buffer));
    return { fns, put, ansi, wide, errors, bytes };
}

test('a name of 255 characters is an atom; one of 256 fails with ERROR_INVALID_PARAMETER', ()=>{
    const { fns, put, errors } = strictSetup();
    put(NAME, 'a'.repeat(255));
    assert.ok(fns.GlobalAddAtomA.handler([NAME]) >= 0xc000);
    assert.deepEqual(errors, [], 'a successful add leaves the last error alone');
    put(NAME, 'b'.repeat(256));
    assert.equal(fns.GlobalAddAtomA.handler([NAME]), 0);
    assert.equal(fns.FindAtomA.handler([NAME]), 0);
    assert.deepEqual(errors, [87, 87]);
    put(NAME, 'c'.repeat(256), true);
    assert.equal(fns.AddAtomW.handler([NAME]), 0);
    put(NAME, 'c'.repeat(255), true);
    assert.ok(fns.AddAtomW.handler([NAME]) >= 0xc000);
});

test('integer atoms run from 1 to 0xbfff; above that, by value or as #n, there are none', ()=>{
    const { fns, put, errors } = strictSetup();
    assert.equal(fns.GlobalAddAtomA.handler([0]), 0);
    assert.deepEqual(errors, [], 'the zero atom fails without an error');
    assert.equal(fns.GlobalAddAtomA.handler([0xbfff]), 0xbfff);
    assert.equal(fns.GlobalAddAtomW.handler([0xc000]), 0);
    assert.equal(fns.AddAtomA.handler([0xffff]), 0);
    put(NAME, '#1234');
    assert.equal(fns.AddAtomA.handler([NAME]), 1234);
    put(NAME, '#49152');
    assert.equal(fns.AddAtomA.handler([NAME]), 0);
});

test('a short buffer: the local table cuts and answers the length, the global its own way', ()=>{
    const { fns, put, ansi, wide, errors, bytes } = strictSetup();
    put(NAME, 'foobar');
    const atom = fns.GlobalAddAtomA.handler([NAME]);

    bytes.fill(0x2e, OUT, OUT + 20);
    assert.equal(fns.GetAtomNameA.handler([atom, OUT, 6]), 5);
    assert.equal(ansi(OUT, 7), 'fooba\0.');
    bytes.fill(0x2e, OUT, OUT + 20);
    assert.equal(fns.GetAtomNameW.handler([atom, OUT, 6]), 5);
    assert.equal(wide(OUT, 6), 'fooba\0');

    bytes.fill(0x2e, OUT, OUT + 20);
    assert.equal(fns.GlobalGetAtomNameA.handler([atom, OUT, 6]), 0);
    assert.equal(ansi(OUT, 7), 'fooba\0.');
    assert.equal(errors.at(-1), 234, 'ERROR_MORE_DATA');
    bytes.fill(0x2e, OUT, OUT + 20);
    assert.equal(fns.GlobalGetAtomNameW.handler([atom, OUT, 6]), 6);
    assert.equal(String.fromCharCode(...bytes.subarray(OUT, OUT + 14)),
        'f\0o\0o\0b\0a\0r\0..', 'every character, and no room for the terminator');

    bytes.fill(0x2e, OUT, OUT + 20);
    errors.length = 0;
    assert.equal(fns.GlobalGetAtomNameA.handler([atom, OUT, 0]), 0);
    assert.equal(fns.GetAtomNameW.handler([atom, OUT, 0]), 0);
    assert.equal(ansi(OUT, 4), '....', 'a size of zero writes nothing');

    assert.equal(fns.GetAtomNameA.handler([42, OUT, 1]), 0);
    assert.equal(errors.at(-1), 122, 'ERROR_INSUFFICIENT_BUFFER');
    assert.equal(fns.GlobalGetAtomNameW.handler([42, OUT, 1]), 1, '"#" and no terminator');
    assert.equal(fns.GlobalGetAtomNameA.handler([0, OUT, 10]), 0);
    assert.equal(errors.at(-1), 87, 'the zero atom has no name');
});
