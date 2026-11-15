/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNtdllCrt } from './crt.js';

const machine = ()=>{
    const memory = new Uint8Array(0x1000);
    const crt = createNtdllCrt({
        readMemory: (at, length)=>memory.slice(at, at + length),
        writeMemory: (at, bytes)=>memory.set(bytes, at),
    });
    /** @param {number} at */
    const text = at=>String.fromCharCode(...memory.slice(at, memory.indexOf(0, at)));
    /** @param {number} at */
    const wide = at=>{
        let out = '';
        for (let offset = at; memory[offset] | memory[offset + 1]; offset += 2)
        {
            out += String.fromCharCode(memory[offset] | memory[offset + 1] << 8);
        }
        return out;
    };
    return { memory, crt, text, wide };
};

test('a base past 36 writes the characters after z, as ntdll does and msvcrt refuses', ()=>{
    const { crt, text, wide } = machine();
    assert.equal(crt._ltoa.handler([71270178, 0x100, 37]), 0x100);
    assert.equal(text(0x100), '111111');
    // 0x23c9e468c in base 99: six ones.
    assert.equal(crt._ui64toa.handler([0x3c9e468c, 0x2, 0x200, 99]), 0x200);
    assert.equal(text(0x200), '111111');
    assert.equal(crt._ultow.handler([71270178, 0x300, 37]), 0x300);
    assert.equal(wide(0x300), '111111');
    assert.equal(crt._itoa.handler([5, 0x400, 1]), 0, 'a base below 2 answers NULL');
});

test('base ten writes a minus, any other base the two\'s complement', ()=>{
    const { crt, text } = machine();
    crt._itoa.handler([-5, 0x100, 10]);
    assert.equal(text(0x100), '-5');
    crt._ltoa.handler([-1, 0x100, 8]);
    assert.equal(text(0x100), '37777777777');
    crt._i64toa.handler([0xffffffff, 0xffffffff, 0x100, 10]);
    assert.equal(text(0x100), '-1');
});

test('towlower knows Latin-1 alone, _wcslwr and _wcsupr ASCII alone', ()=>{
    const { memory, crt, wide } = machine();
    assert.equal(crt.towlower.handler([0x41]), 0x61);
    assert.equal(crt.towlower.handler([0xc0]), 0xe0);
    assert.equal(crt.towlower.handler([0xd7]), 0xd7, 'the multiplication sign');
    assert.equal(crt.towlower.handler([0x391]), 0x391, 'Greek is not lowered');
    assert.equal(crt.towupper.handler([0x3b1]), 0x391, 'but raised, as RtlUpcaseUnicodeChar');
    memory.set([0x41, 0, 0xc0, 0, 0x61, 0, 0, 0], 0x100);
    crt._wcslwr.handler([0x100]);
    assert.equal(wide(0x100), 'aÀa');
    crt._wcsupr.handler([0x100]);
    assert.equal(wide(0x100), 'AÀA');
});

test('_wcsicmp folds ASCII alone and answers the difference', ()=>{
    const { memory, crt } = machine();
    memory.set([0x41, 0, 0, 0], 0x100);
    memory.set([0x63, 0, 0, 0], 0x200);
    assert.equal(crt._wcsicmp.handler([0x100, 0x200]), 0x61 - 0x63);
    memory.set([0xc0, 0, 0, 0], 0x100);
    memory.set([0xe0, 0, 0, 0], 0x200);
    assert.equal(crt._wcsicmp.handler([0x100, 0x200]), 0xc0 - 0xe0, 'Latin-1 is not folded');
    assert.equal(crt._wcsnicmp.handler([0x100, 0x200, 0]), 0);
});

test('the classes answer their bits; toupper is the ANSI page\'s of the low byte', ()=>{
    const { crt } = machine();
    assert.equal(crt.isxdigit.handler([0x30]), 0x80, 'the class bit itself, not 1');
    assert.equal(crt.isprint.handler([0x09]), 0, 'a tab is no blank to the narrow ones');
    assert.equal(crt.iswctype.handler([0x09, 0xffff]), 0x68, 'but is to the wide');
    assert.equal(crt.isalpha.handler([0xe0]), 0, 'the narrow ones stop at 0x80');
    assert.equal(crt.iswalpha.handler([0xe0]), 0x102);
    assert.equal(crt.iswalpha.handler([0x100]), 0, 'and the wide at 0x100');
    assert.equal(crt.toupper.handler([0xe0]), 0xc0);
    assert.equal(crt.toupper.handler([0xff]), 0x9f, 'y diaeresis to its capital, 0x9f in 1252');
    assert.equal(crt.toupper.handler([-512]), 0, 'only the low byte');
    assert.equal(crt.tolower.handler([0x141]), 0x161);
});
