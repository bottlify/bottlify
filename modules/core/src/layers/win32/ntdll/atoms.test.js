/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAtomTableFunctions, parseAtomName } from './atoms.js';
import { STATUS } from './status.js';

// Above 64 KiB: an address below it is an integer atom.
const OUT = 0x10100;
const NAME = 0x10200;
const LENGTH = 0x10300;
const COUNTS = 0x10310;
const TEXT = 0x10400;

/** Guest memory and a bump heap. */
function machine(){
    const bytes = new Uint8Array(0x14000);
    let next = 0x12000;
    const view = new DataView(bytes.buffer);
    /** @param {number} address @param {number} limit */
    const readWideString = (address, limit)=>{
        let text = '';
        for (let at = 0; at + 1 < limit; at += 2)
        {
            const code = view.getUint16(address + at, true);
            if (code === 0)
            {
                break;
            }
            text += String.fromCharCode(code);
        }
        return text;
    };
    const functions = createAtomTableFunctions({
        readMemory: (address, length)=>bytes.slice(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        readWideString,
        allocate: size=>{
            const at = next;
            next += size;
            return at;
        },
        free: ()=>true,
    });
    /** @param {number} address @param {string} text */
    const putWide = (address, text)=>{
        for (let at = 0; at <= text.length; at++)
        {
            view.setUint16(address + at * 2, at < text.length ? text.charCodeAt(at) : 0, true);
        }
    };
    /** @param {string} name @param {...number} args */
    const call = (name, ...args)=>/** @type {any} */ (functions)[name].handler(args) >>> 0;
    /** @param {string} text */
    const named = text=>{
        putWide(TEXT, text);
        return TEXT;
    };
    const table = ()=>{
        assert.equal(call('RtlCreateAtomTable', 37, OUT), STATUS.SUCCESS);
        return view.getUint32(OUT, true);
    };
    return { view, call, named, table, readWideString };
}

test('a table begins with its signature, and a name is found again whatever its case', ()=>{
    const { view, call, named, table } = machine();
    const at = table();
    assert.equal(view.getUint32(at, true), 0x6d6f7441, '"Atom"');
    assert.equal(call('RtlAddAtomToAtomTable', at, named('Hello World'), OUT), STATUS.SUCCESS);
    const atom = view.getUint16(OUT, true);
    assert.equal(atom, 0xc000, 'names are numbered from 0xc000');
    assert.equal(call('RtlLookupAtomInAtomTable', at, named('HELLO WORLD'), OUT), STATUS.SUCCESS);
    assert.equal(view.getUint16(OUT, true), atom);
    assert.equal(call('RtlAddAtomToAtomTable', at, named(''), OUT), STATUS.OBJECT_NAME_INVALID);
    assert.equal(call('RtlDestroyAtomTable', at), STATUS.SUCCESS);
});

test('an atom counts its adds, a pinned one stays, emptying keeps the pinned unless asked', ()=>{
    const { view, call, named, table } = machine();
    const at = table();
    call('RtlAddAtomToAtomTable', at, named('one'), OUT);
    call('RtlAddAtomToAtomTable', at, named('one'), OUT);
    const one = view.getUint16(OUT, true);
    const counts = ()=>{
        call('RtlQueryAtomInAtomTable', at, one, COUNTS, COUNTS + 4, 0, 0);
        return [view.getUint32(COUNTS, true), view.getUint32(COUNTS + 4, true)];
    };
    assert.deepEqual(counts(), [2, 0]);
    call('RtlPinAtomInAtomTable', at, one);
    call('RtlPinAtomInAtomTable', at, one);
    assert.equal(call('RtlDeleteAtomFromAtomTable', at, one), 0x40000019, 'STATUS_WAS_LOCKED');
    assert.deepEqual(counts(), [2, 1]);
    call('RtlAddAtomToAtomTable', at, named('two'), OUT);
    assert.equal(call('RtlEmptyAtomTable', at, 0), STATUS.SUCCESS);
    assert.equal(call('RtlLookupAtomInAtomTable', at, named('two'), OUT),
        STATUS.OBJECT_NAME_NOT_FOUND);
    assert.equal(call('RtlLookupAtomInAtomTable', at, named('one'), OUT), STATUS.SUCCESS);
    call('RtlEmptyAtomTable', at, 1);
    assert.equal(call('RtlLookupAtomInAtomTable', at, named('one'), OUT),
        STATUS.OBJECT_NAME_NOT_FOUND);
});

test('a deleted name gives its number back to the next one', ()=>{
    const { view, call, named, table } = machine();
    const at = table();
    call('RtlAddAtomToAtomTable', at, named('first'), OUT);
    const first = view.getUint16(OUT, true);
    assert.equal(call('RtlDeleteAtomFromAtomTable', at, first), STATUS.SUCCESS);
    call('RtlAddAtomToAtomTable', at, named('second'), OUT);
    assert.equal(view.getUint16(OUT, true), 0xc000);
    assert.equal(call('RtlDeleteAtomFromAtomTable', at, 0xc123), STATUS.INVALID_HANDLE);
});

test('a name is cut to the buffer with its terminator, and no room at all says how much', ()=>{
    const { view, call, named, table, readWideString } = machine();
    const at = table();
    call('RtlAddAtomToAtomTable', at, named('Hello World2'), OUT);
    const atom = view.getUint16(OUT, true);
    view.setUint32(LENGTH, 0, true);
    assert.equal(call('RtlQueryAtomInAtomTable', at, atom, 0, 0, NAME, LENGTH),
        STATUS.BUFFER_TOO_SMALL);
    assert.equal(view.getUint32(LENGTH, true), 24);
    view.setUint32(LENGTH, 8, true);
    view.setUint16(NAME + 8, 0x1337, true);
    assert.equal(call('RtlQueryAtomInAtomTable', at, atom, 0, 0, NAME, LENGTH), STATUS.SUCCESS);
    assert.equal(view.getUint32(LENGTH, true), 6);
    assert.equal(readWideString(NAME, 64), 'Hel');
    assert.equal(view.getUint16(NAME + 8, true), 0x1337, 'nothing past the buffer');
});

test('an integer atom is # and decimal digits, always there, counted once and pinned', ()=>{
    assert.deepEqual(parseAtomName('#00123'), { integer: 123 });
    assert.deepEqual(parseAtomName('#7b'), { name: '#7b' });
    assert.deepEqual(parseAtomName('# 1'), { name: '# 1' });
    assert.deepEqual(parseAtomName('#'), { name: '#' });
    assert.deepEqual(parseAtomName(`#${'0'.repeat(300)}1`), { integer: 1 });
    assert.deepEqual(parseAtomName('#49152'), { status: STATUS.INVALID_PARAMETER, atom: 0 });
    assert.deepEqual(parseAtomName('#0'), { status: STATUS.INVALID_PARAMETER, atom: 0 });
    assert.deepEqual(parseAtomName(0), { status: STATUS.INVALID_PARAMETER, atom: 0 });
    assert.deepEqual(parseAtomName(0xc000), { status: STATUS.ACCESS_VIOLATION });
    assert.deepEqual(parseAtomName('x'.repeat(256)), { status: STATUS.INVALID_PARAMETER });

    const { view, call, named, table, readWideString } = machine();
    const at = table();
    assert.equal(call('RtlLookupAtomInAtomTable', at, 123, OUT), STATUS.SUCCESS);
    assert.equal(view.getUint16(OUT, true), 123);
    view.setUint32(LENGTH, 64, true);
    assert.equal(call('RtlQueryAtomInAtomTable', at, 123, COUNTS, COUNTS + 4, NAME, LENGTH),
        STATUS.SUCCESS);
    assert.deepEqual([view.getUint32(COUNTS, true), view.getUint32(COUNTS + 4, true)], [1, 1]);
    assert.equal(readWideString(NAME, 64), '#123');
    assert.equal(call('RtlQueryAtomInAtomTable', at, 0, COUNTS, COUNTS + 4, 0, 0),
        STATUS.INVALID_PARAMETER);
    view.setUint16(OUT, 0xdead, true);
    assert.equal(call('RtlAddAtomToAtomTable', at, named('#0'), OUT), STATUS.INVALID_PARAMETER);
    assert.equal(view.getUint16(OUT, true), 0, 'a refused number answers atom 0');
});

test('the global table: a counted name, and its basic information cut to the buffer', ()=>{
    const { view, call, readWideString } = machine();
    const text = 'Hello World';
    for (let at = 0; at < text.length; at++)
    {
        view.setUint16(TEXT + at * 2, text.charCodeAt(at), true);
    }
    view.setUint16(TEXT + text.length * 2, 0x41, true);
    assert.equal(call('NtAddAtom', TEXT, text.length * 2, OUT), STATUS.SUCCESS);
    const atom = view.getUint16(OUT, true);
    assert.equal(call('NtFindAtom', TEXT, text.length * 2, OUT), STATUS.SUCCESS);
    assert.equal(view.getUint16(OUT, true), atom, 'only the counted characters are the name');

    assert.equal(call('NtQueryInformationAtom', atom, 0, NAME, 8, 0), STATUS.BUFFER_TOO_SMALL);
    assert.equal(view.getUint16(NAME + 4, true), 22, 'the whole length all the same');
    assert.equal(call('NtQueryInformationAtom', atom, 0, NAME, 16, 0), STATUS.SUCCESS);
    assert.equal(view.getUint16(NAME + 4, true), 8);
    assert.equal(readWideString(NAME + 6, 64), 'Hell');
    assert.equal(call('NtQueryInformationAtom', atom, 0, NAME, 64, 0), STATUS.SUCCESS);
    assert.equal(readWideString(NAME + 6, 64), text);
    assert.equal(call('NtDeleteAtom', atom), STATUS.SUCCESS);
    assert.equal(call('NtFindAtom', TEXT, text.length * 2, OUT), STATUS.OBJECT_NAME_NOT_FOUND);
});
