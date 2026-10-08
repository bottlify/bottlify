/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shlwapiMachine } from './memory.fixture.js';
import { createLocaleFunctions } from '../kernel32/locale.js';

const S_OK = 0;
const E_FAIL = 0x80004005;

const WIDTHS = /** @type {const} */ ([['A', false], ['W', true]]);

/** shlwapi over kernel32's own CompareString, as the win32 module wires them. */
function compared(){
    /** @type {any} */
    let kernel32 = null;
    const m = shlwapiMachine({ library: name=>(name === 'KERNEL32.dll' ? kernel32 : undefined) });
    kernel32 = createLocaleFunctions({
        readMemory: m.base.readMemory,
        writeMemory: m.base.writeMemory,
        setLastError: ()=>{},
        stringLength: (address, unit)=>{
            let length = 0;
            while ((unit === 1 ? m.memory[address + length]
                : m.view.getUint16(address + length * 2, true)) !== 0)
            {
                length++;
            }
            return length;
        },
    });
    return m;
}

test('StrChr finds the first place a character is, StrRChr the last', ()=>{
    // Wine's test_StrChrA, test_StrChrW, test_StrRChrA and test_StrRChrW.
    for (const [suffix, wide] of WIDTHS)
    {
        const m = shlwapiMachine();
        const text = Array.from({ length: 96 }, (_, i)=>String.fromCharCode(32 + i)).join('');
        const at = m.put(text, wide);
        const unit = wide ? 2 : 1;
        for (let code = 33; code < 128; code++)
        {
            assert.equal(m.fns[`StrChr${suffix}`].handler([at, code]), at + (code - 32) * unit);
            assert.equal(m.fns[`StrChr${suffix}`].handler([at + (code - 31) * unit, code]), 0,
                'not in what follows it');
            assert.equal(m.fns[`StrRChr${suffix}`].handler([at, 0, code]),
                at + (code - 32) * unit);
            assert.equal(m.fns[`StrRChr${suffix}`].handler([at + (code - 31) * unit,
                at + 95 * unit, code]), 0);
        }
        const repeated = m.put('a.b.c', wide);
        assert.equal(m.fns[`StrChr${suffix}`].handler([repeated, 0x2e]), repeated + unit);
        assert.equal(m.fns[`StrRChr${suffix}`].handler([repeated, 0, 0x2e]), repeated + 3 * unit);
        assert.equal(m.fns[`StrRChr${suffix}`].handler([repeated, repeated + 3 * unit, 0x2e]),
            repeated + unit, 'the end is not searched');
        assert.equal(m.fns[`StrChr${suffix}`].handler([repeated, 0]), 0, 'never the terminator');
        assert.equal(m.fns[`StrChr${suffix}`].handler([0, 0x2e]), 0);
    }
    const m = shlwapiMachine();
    const wide = m.put('x\u4e2dy', true);
    assert.equal(m.fns.StrChrW.handler([wide, 0x4e2d]), wide + 2, 'a wide character beyond a byte');
    const narrow = m.put('x\u20acy');
    assert.equal(m.fns.StrChrA.handler([narrow, 0x80]), narrow + 1,
        'an ANSI byte is the page\'s character');
});

test('StrCmp, StrCmpI and the counted forms are CompareString less two', ()=>{
    // Wine's test_StrCmpA and test_StrCmpW.
    const m = compared();
    const abc = (/** @type {boolean} */ wide)=>m.put('abcdef', wide);
    const aBc = (/** @type {boolean} */ wide)=>m.put('aBcdef', wide);
    assert.notEqual(m.fns.StrCmpNA.handler([abc(false), aBc(false), 6]), 0);
    assert.equal(m.fns.StrCmpNIA.handler([abc(false), aBc(false), 6]), 0);
    assert.notEqual(m.fns.StrCmpNW.handler([abc(true), aBc(true), 5]), 0);
    assert.equal(m.fns.StrCmpNIW.handler([abc(true), aBc(true), 5]), 0);
    assert.equal(m.fns.StrCmpW.handler([m.put('abc', true), m.put('abc', true)]), 0);
    assert.equal(m.fns.StrCmpW.handler([m.put('abc', true), m.put('abd', true)]), -1);
    assert.equal(m.fns.StrCmpW.handler([m.put('abd', true), m.put('abc', true)]), 1);
    assert.equal(m.fns.StrCmpW.handler([m.put('ab', true), m.put('abc', true)]), -1);
    assert.equal(m.fns.StrCmpIW.handler([m.put('HeLLo', true), m.put('hello', true)]), 0);
    assert.equal(m.fns.StrCmpIW.handler([m.put('hellp', true), m.put('HELLO', true)]), 1);
    assert.equal(m.fns.StrCmpNW.handler([m.put('abcX', true), m.put('abcY', true), 3]), 0,
        'only the first three');
    assert.equal(m.fns.StrCmpNA.handler([m.put('ab'), m.put('abc'), 5]), -1,
        'a count past the end stops at the terminator');
    assert.equal(m.fns.StrCmpNIA.handler([m.put('x'), m.put('y'), 0]), 0, 'nothing compared');
    assert.equal(shlwapiMachine().fns.StrCmpIW.handler([0x10000, 0x10000]), 0,
        'without kernel32 the code units are compared');
});

test('StrCpyW, StrCpyNW and StrCatW copy and append', ()=>{
    // Wine's test_StrCpyW and test_StrXXX_overflows.
    const m = shlwapiMachine();
    const source = m.put('0123456789'.repeat(52), true, 0x800);
    let out = m.put('', true, 0x800);
    assert.equal(m.fns.StrCpyW.handler([out, source]), out);
    assert.equal(m.read(out, true), '0123456789'.repeat(52));

    out = m.put('', true, 0x800);
    m.memory.fill(0xbf, out, out + 0x800);
    assert.equal(m.fns.StrCpyNW.handler([out, source, 10]), out);
    assert.equal(m.view.getUint16(out + 18, true), 0);
    assert.equal(m.view.getUint16(out + 20, true), 0xbfbf);
    assert.equal(m.read(out, true), '012345678');

    m.memory.fill(0xbf, out, out + 0x800);
    assert.equal(m.fns.StrCpyNW.handler([out, 1, 1]), out, 'the source is not read');
    assert.deepEqual([m.view.getUint16(out, true), m.view.getUint16(out + 2, true)], [0, 0xbfbf]);
    m.memory.fill(0xbf, out, out + 0x800);
    assert.equal(m.fns.StrCpyNW.handler([out, 0, 10]), out, 'a null source is empty');
    assert.deepEqual([m.view.getUint16(out, true), m.view.getUint16(out + 2, true)], [0, 0xbfbf]);
    m.memory.fill(0xbf, out, out + 0x800);
    m.fns.StrCpyNW.handler([out, source, 0]);
    assert.equal(m.view.getUint16(out, true), 0xbfbf, 'no room, nothing written');

    out = m.put('abc', true);
    assert.equal(m.fns.StrCatW.handler([out, m.put('def', true)]), out);
    assert.equal(m.read(out, true), 'abcdef');
});

test('StrCatBuff cuts what it appends to the buffer, in both spellings', ()=>{
    // Wine's test_StrXXX_overflows.
    for (const [suffix, wide] of WIDTHS)
    {
        const m = shlwapiMachine();
        const source = m.put('0123456789'.repeat(52), wide, 0x800);
        const out = m.put('', wide, 0x800);
        m.memory.fill(0xbf, out, out + 0x800);
        [...'012345678\0'].forEach((c, index)=>(wide
            ? m.view.setUint16(out + index * 2, c.charCodeAt(0), true)
            : m.memory.set([c.charCodeAt(0)], out + index)));
        assert.equal(m.fns[`StrCatBuff${suffix}`].handler([out, source, 100]), out);
        const at = (/** @type {number} */ index)=>(wide ? m.view.getUint16(out + index * 2, true)
            : m.memory[out + index]);
        assert.equal(at(99), 0);
        assert.equal(at(100), wide ? 0xbfbf : 0xbf);
        assert.equal(m.read(out, wide), `012345678${'0123456789'.repeat(9)}`);
        assert.equal(m.fns[`StrCatBuff${suffix}`].handler([out, source, 50]), out,
            'a buffer already full is left alone');
        assert.equal(m.read(out, wide).length, 99);
    }
});

test('StrDup copies into the heap, and an absent string is an empty one', ()=>{
    // Wine's test_StrDupA.
    for (const [suffix, wide] of WIDTHS)
    {
        const m = shlwapiMachine();
        const copy = m.fns[`StrDup${suffix}`].handler([m.put('1.04 KB', wide)]);
        assert.notEqual(copy, 0);
        assert.equal(m.read(copy, wide), '1.04 KB');
        const empty = m.fns[`StrDup${suffix}`].handler([0]);
        assert.notEqual(empty, 0);
        assert.equal(m.read(empty, wide), '');
    }
});

test('StrStr finds a string, case and all, and never an empty one', ()=>{
    // Wine's test_StrStrA and test_StrStrW.
    for (const [suffix, wide] of WIDTHS)
    {
        const m = shlwapiMachine();
        const unit = wide ? 2 : 1;
        const hay = m.put('DeAdBeEf', wide);
        const cases = /** @type {[string, number | null][]} */ ([['', null], ['DeAd', 0],
            ['dead', null], ['AdBe', 2], ['adbe', null], ['BeEf', 4], ['beef', null]]);
        for (const [needle, index] of cases)
        {
            assert.equal(m.fns[`StrStr${suffix}`].handler([hay, m.put(needle, wide)]),
                index === null ? 0 : hay + index * unit, needle);
        }
        assert.equal(m.fns[`StrStr${suffix}`].handler([m.put('', wide), m.put('', wide)]), 0);
    }
});

test('StrRetToBuf reads each kind of STRRET, frees a wide one, and cuts to the buffer', ()=>{
    // Wine's test_StrXXX_overflows: XP's answer to a string cut short is S_OK.
    const m = shlwapiMachine();
    const strret = m.put('', false, 0x200);
    const long = '0123456789'.repeat(52);
    const out = m.put('', true, 0x800);

    m.memory.fill(0xbf, out, out + 0x800);
    const owned = m.put(long, true, 0x800);
    m.view.setUint32(strret, 0, true);
    m.view.setUint32(strret + 4, owned, true);
    assert.equal(m.fns.StrRetToBufW.handler([strret, 0, out, 10]), S_OK);
    assert.equal(m.read(out, true), '012345678');
    assert.equal(m.view.getUint16(out + 20, true), 0xbfbf);
    assert.deepEqual(m.freed, [owned], 'the string is the call\'s to free');

    m.view.setUint32(strret, 2, true);
    m.memory.set(new TextEncoder().encode(`${long.slice(0, 259)}\0`), strret + 4);
    assert.equal(m.fns.StrRetToBufW.handler([strret, 0, out, 10]), S_OK);
    assert.equal(m.read(out, true), '012345678', 'STRRET_CSTR');

    m.view.setUint32(strret, 0, true);
    m.view.setUint32(strret + 4, 0, true);
    m.memory.fill(0xbf, out, out + 0x800);
    assert.equal(m.fns.StrRetToBufW.handler([strret, 0, out, 10]) >>> 0, E_FAIL, 'no string');
    assert.equal(m.read(out, true), '');
    m.view.setUint32(strret, 3, true);
    assert.equal(m.fns.StrRetToBufW.handler([strret, 0, out, 10]) >>> 0, E_FAIL, 'no such kind');

    const item = m.put('\0\0name.txt', false);
    m.view.setUint32(strret, 1, true);
    m.view.setUint32(strret + 4, 2, true);
    const narrow = m.put('', false);
    assert.equal(m.fns.StrRetToBufA.handler([strret, item, narrow, 260]), S_OK, 'STRRET_OFFSET');
    assert.equal(m.read(narrow), 'name.txt');
    assert.equal(m.fns.StrRetToBufA.handler([strret, 0, narrow, 260]) >>> 0, E_FAIL,
        'an offset into no item');
    assert.equal(m.fns.StrRetToBufA.handler([strret, item, 0, 260]) >>> 0, E_FAIL);
});

test('each string function declares the arguments it pops', ()=>{
    const { fns } = shlwapiMachine();
    const expected = /** @type {Record<string, number>} */ ({
        StrChrA: 8, StrChrW: 8, StrRChrA: 12, StrRChrW: 12, StrCmpW: 8, StrCmpIW: 8,
        StrCmpNA: 12, StrCmpNW: 12, StrCmpNIA: 12, StrCmpNIW: 12, StrCpyW: 8, StrCpyNW: 12,
        StrCatW: 8, StrCatBuffA: 12, StrCatBuffW: 12, StrDupA: 4, StrDupW: 4, StrStrA: 8,
        StrStrW: 8, StrRetToBufA: 16, StrRetToBufW: 16,
    });
    for (const [name, bytes] of Object.entries(expected))
    {
        assert.equal(fns[name].argBytes, bytes, name);
    }
});
