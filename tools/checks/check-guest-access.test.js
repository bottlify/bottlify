/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * check-guest-access.mjs's reading of one file: what it counts as a local
 * accessor, a string helper or a read copied again, and what it leaves; and
 * how the counts are held to the baseline. The sweep over win32 is the check
 * itself (`npm run check:boundaries`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blank, compare, occurrences } from './check-guest-access.mjs';

test('a local accessor or string helper is counted however it is defined', ()=>{
    const code = [
        'const readU32 = address=>peek(address, 4).getUint32(0, true);',
        'const writeDword = (address, value)=>host.writeMemory(address, bytes(value));',
        'function u16(address){ return host.readMemory(address, 2)[0]; }',
        'let readPointer = async (/** @type {number} */ at)=>at;',
        'const wide = function(text){ return text; };',
        'const stringAt = (at, limit = f(1))=>host.readCString(at, limit);',
    ].join('\n');
    assert.deepEqual(occurrences(code), {
        'accessor readU32': 1, 'accessor writeDword': 1, 'accessor u16': 1,
        'accessor readPointer': 1, 'string wide': 1, 'string stringAt': 1,
    });
});

test('a value, a call, a property or a comment of the same name is not a definition', ()=>{
    const code = [
        'const dword = view.getUint32(0, true);',
        'const wide = readWide(at);',
        'guest.u32(at); memory.readU32(at);',
        'const api = { readU32: address=>memory.readU32(address) };',
        '// const readU32 = address=>0;',
        '/* function wide(text){} */',
        "const said = 'const u32 = a=>a';",
        'const readMemoryAt = address=>0;',
    ].join('\n');
    assert.deepEqual(occurrences(code), {});
});

test('a read copied again is counted across lines; one read alone is not', ()=>{
    const code = [
        'const a = host.readMemory(at, 4).slice();',
        'const b = host.readMemory(source,',
        '    byteLengthOf(source)).slice();',
        'const c = memory.readBytes(f(at), g(4))',
        '    .slice();',
        'const d = host.readMemory(at, 4);',
        'const e = host.readMemory(at, 8).slice(2);',
        'const f = guest.bytes(at, 4).slice();',
    ].join('\n');
    assert.deepEqual(occurrences(code), { 'copy readMemory().slice()': 3 });
});

test('comments and strings are blanked in place, every line where it was', ()=>{
    const code = "a // b\n/* c\nd */ e 'f' \"g\"";
    const blanked = blank(code);
    assert.equal(blanked.length, code.length);
    assert.equal(blanked.split('\n').length, 3);
    assert.match(blanked, /^a {5}\n {4}\n {5}e {8}$/);
});

test('a count above the baseline is new, one below it a baseline to shrink', ()=>{
    const baseline = { 'a.js': { 'accessor u32': 2, 'copy readMemory().slice()': 1 },
        'gone.js': { 'string wide': 1 } };
    assert.deepEqual(compare(baseline, baseline), { added: [], stale: [] });
    const now = { 'a.js': { 'accessor u32': 3 }, 'new.js': { 'string ansi': 1 } };
    assert.deepEqual(compare(now, baseline), {
        added: ['a.js: accessor u32 (3, the baseline 2)',
            'new.js: string ansi (1, the baseline 0)'],
        stale: ['a.js: copy readMemory().slice() (0, the baseline 1)',
            'gone.js: string wide (0, the baseline 1)'],
    });
});
