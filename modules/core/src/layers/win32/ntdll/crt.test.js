/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNtdllCrt } from './crt.js';
import { createConversionFunctions } from '../msvcrt/convert.js';
import { createScanFunctions } from '../msvcrt/scan.js';
import { createSortFunctions } from '../msvcrt/sort.js';
import { guestWindow } from '../msvcrt/guest-window.fixture.js';

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

/** A memory of 4 KiB and its reader and writer, as the runtime's tables take them. */
const memoryIo = ()=>{
    const memory = new Uint8Array(0x1000);
    return {
        memory,
        view: new DataView(memory.buffer),
        io: {
            readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
                memory.slice(at, at + length),
            writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ bytes)=>
                memory.set(bytes, at),
        },
    };
};

test('the wide readings skip the Latin-1 blanks alone, msvcrt\'s reading otherwise', ()=>{
    const { memory, view, io } = memoryIo();
    const msvcrt = /** @type {Record<string, any>} */ (createConversionFunctions(
        /** @type {any} */ ({ ...io, pointerSize: 4,
            readCString: ()=>'' })));
    const ntdll = /** @type {Record<string, any>} */ (createNtdllCrt({ ...io, crt: msvcrt }));
    /** @param {string} text */
    const put = text=>{
        memory.fill(0, 0x100, 0x200);
        [...text].forEach((unit, at)=>view.setUint16(0x100 + at * 2, unit.charCodeAt(0), true));
        return 0x100;
    };
    // Wine's ntdll:string: a no-break space is skipped, U+2002 and U+3000 end the reading.
    assert.equal(ntdll._wtol.handler([put('\t\xa0\n 12')]), 12);
    assert.equal(ntdll._wtol.handler([put('　 12')]), 0);
    assert.equal(ntdll._wtoi64.handler([put('   12')]), 0);
    assert.equal(ntdll.wcstol.handler([put('\xa0 +44'), 0x300, 0]), 44);
    assert.equal(ntdll.wcstol.handler([put('   +55'), 0x300, 0]), 0);
    assert.equal(view.getUint32(0x300, true), 0x100, 'nothing read: the end is the start');
    assert.equal(ntdll.wcstoul.handler([put('　 +66'), 0, 0]), 0);
    // msvcrt's own reading skips Unicode's separators; both read every script's digits.
    assert.equal(msvcrt.wcstol.handler([put('   +55'), 0, 0]), 55);
    assert.equal(ntdll.wcstol.handler([put('๙'), 0, 0]), 9, 'THAI DIGIT NINE');
    assert.equal(ntdll._wtoi.handler([put('4294967297')]), 1, 'atoi\'s wrap, in 32 bits');
});

test('sscanf reads no floating-point field, and stops at one', ()=>{
    const { view, io } = memoryIo();
    const strings = new Map([[0x10, '10'], [0x20, '%d'], [0x30, '%f'], [0x40, '%d %f %d'],
        [0x50, '1 2.5 3']]);
    const msvcrt = createScanFunctions(/** @type {any} */ ({ ...io, pointerSize: 4,
        readCString: (/** @type {number} */ at)=>strings.get(at) ?? '' }));
    const ntdll = /** @type {Record<string, any>} */ (createNtdllCrt({ ...io, crt: msvcrt }));
    assert.equal(ntdll.sscanf.handler([0x10, 0x20, 0x200]), 1);
    assert.equal(view.getInt32(0x200, true), 10);
    assert.equal(ntdll.sscanf.handler([0x10, 0x30, 0x204]), 0);
    assert.equal(view.getUint32(0x204, true), 0, 'nothing stored');
    assert.equal(ntdll.sscanf.handler([0x50, 0x40, 0x208, 0x20c, 0x210]), 1,
        'the integer before the float, none after');
    assert.equal(view.getUint32(0x210, true), 0);
    assert.equal(msvcrt.sscanf.handler([0x10, 0x30, 0x204]), 1, 'msvcrt reads it');
});

test('qsort puts equal elements where msvcrt.dll\'s own sort puts them', async()=>{
    const { memory, view, io } = memoryIo();
    const words = ['Hello', 'Wine', 'World', '!', 'wine', 'Sorted', 'WINE'];
    const COMPARE = 0x9000;
    const msvcrt = createSortFunctions({
        guest: guestWindow(memory),
        // The comparator: the words the two elements index, folded to lower case.
        callGuest: async(entry, [left, right])=>{
            assert.equal(entry, COMPARE);
            const a = words[view.getUint32(left, true)].toLowerCase();
            const b = words[view.getUint32(right, true)].toLowerCase();
            return a < b ? -1 : a > b ? 1 : 0;
        },
    });
    const ntdll = /** @type {Record<string, any>} */ (createNtdllCrt({ ...io, crt: msvcrt }));
    words.forEach((_, at)=>view.setUint32(0x100 + at * 4, at, true));
    assert.equal(await ntdll.qsort.handler([0x100, words.length, 4, COMPARE]), 0);
    // Wine's ntdll:string: the three spellings of wine end as wine, WINE, Wine.
    assert.deepEqual(words.map((_, at)=>words[view.getUint32(0x100 + at * 4, true)]),
        ['!', 'Hello', 'Sorted', 'wine', 'WINE', 'Wine', 'World']);
});
