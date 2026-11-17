/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shlwapiMachine } from './memory.fixture.js';
import { createLocaleFunctions } from '../kernel32/locale.js';

/** shlwapi over kernel32's own character tables and code pages. */
function machine(){
    /** @type {any} */
    let kernel32 = null;
    const m = shlwapiMachine({ library: (/** @type {string} */ name)=>
        (name === 'KERNEL32.dll' ? kernel32 : undefined) });
    kernel32 = createLocaleFunctions(/** @type {any} */ ({
        ...m.base,
        /** @param {number} address @param {number} unit */
        stringLength: (address, unit)=>{
            let count = 0;
            while ((unit === 1 ? m.memory[address + count]
                : m.memory[address + count * 2] | m.memory[address + count * 2 + 1]) !== 0)
            {
                count++;
            }
            return count;
        },
    }));
    return m;
}

test('the IsChar class functions answer kernel32\'s CT_CTYPE1 classes', ()=>{
    // Wine's string test (test_IsChar*): a tab is space and blank, '!'
    // punctuation, 0x7f a control, 'F' a hex digit, '9' a digit.
    const m = machine();
    const is = (/** @type {string} */ name, /** @type {number} */ code)=>
        m.fns[name].handler([code]);
    assert.deepEqual([is('IsCharSpaceW', 9), is('IsCharSpaceW', 0x41)], [1, 0]);
    assert.deepEqual([is('IsCharBlankW', 9), is('IsCharBlankW', 0x0a)], [1, 0]);
    assert.deepEqual([is('IsCharPunctW', 0x21), is('IsCharPunctW', 0x61)], [1, 0]);
    assert.deepEqual([is('IsCharCntrlW', 0x7f), is('IsCharCntrlW', 0x20)], [1, 0]);
    assert.deepEqual([is('IsCharDigitW', 0x39), is('IsCharDigitW', 0x46)], [1, 0]);
    assert.deepEqual([is('IsCharXDigitW', 0x46), is('IsCharXDigitW', 0x47)], [1, 0]);
    assert.deepEqual([is('IsCharSpaceA', 0x20), is('IsCharSpaceA', 0x5f)], [1, 0]);
    assert.equal(shlwapiMachine().fns.IsCharSpaceW.handler([9]), 0, 'no kernel32: no class');
});

test('SHAnsiToUnicodeCP and SHUnicodeToAnsiCP convert through a code page, cut to fit', ()=>{
    const m = machine();
    const out = m.put('', true, 64);
    assert.equal(m.fns.SHAnsiToUnicodeCP.handler([1252, m.put('caf\xe9'), out, 16]), 5,
        'with its terminator');
    assert.equal(m.read(out, true), 'caf\xe9');
    assert.equal(m.fns.SHAnsiToUnicodeCP.handler([1252, m.put('abcdef'), out, 3]), 3,
        'cut short: the room');
    assert.equal(m.read(out, true), 'ab');
    const narrow = m.put('', false, 64);
    assert.equal(m.fns.SHUnicodeToAnsiCP.handler([1252, m.put('text', true), narrow, 16]), 5);
    assert.equal(m.read(narrow), 'text');
});

test('DoesStringRoundTrip: ANSI always does, UTF-16 when the page holds every character', ()=>{
    const m = machine();
    const out = m.put('', false, 64);
    assert.equal(m.fns.DoesStringRoundTripA.handler([m.put('plain'), out, 64]), 1);
    assert.equal(m.read(out), 'plain');
    assert.equal(m.fns.DoesStringRoundTripW.handler([m.put('plain', true), out, 64]), 1);
    assert.equal(m.fns.DoesStringRoundTripW.handler([m.put('中', true), out, 64]), 0,
        'not in the Western page');
});

test('SHStripMneumonic takes the first single ampersand out and answers the letter', ()=>{
    // Wine's ordinal test: "&File" gives F; "Go (&G)" loses the bracket.
    const m = machine();
    const label = m.put('&File');
    assert.equal(m.fns.SHStripMneumonicA.handler([label]), 0x46);
    assert.equal(m.read(label), 'File');
    const doubled = m.put('A&&B&C', true);
    assert.equal(m.fns.SHStripMneumonicW.handler([doubled]), 0x43);
    assert.equal(m.read(doubled, true), 'A&&BC');
    const bracket = m.put('Go(&G)', true);
    assert.equal(m.fns.SHStripMneumonicW.handler([bracket]), 0x47);
    assert.equal(m.read(bracket, true), 'Go');
    assert.equal(m.fns.SHStripMneumonicA.handler([m.put('none')]), 0);
    assert.equal(m.fns.SHTruncateString.handler([m.put('abc'), 3]), 2);
    assert.equal(m.fns.SHTruncateString.handler([0, 3]), 0);
});

test('GUIDFromStringW reads a braced GUID, refuses anything else', ()=>{
    const m = machine();
    const out = m.put('', false, 32);
    assert.equal(m.fns.GUIDFromStringW.handler([m.put('{00000001-0002-0003-0405-060708090a0b}',
        true), out]), 1);
    assert.deepEqual([...m.memory.subarray(out, out + 4)], [1, 0, 0, 0]);
    assert.equal(m.fns.GUIDFromStringW.handler([m.put('00000001-0002-0003-0405-060708090a0b',
        true), out]), 0, 'no braces');
});
