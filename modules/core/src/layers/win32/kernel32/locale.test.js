/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocaleFunctions } from './locale.js';
import { UI_LANGUAGE } from '../../loader/internal/resources.js';

const CP_ACP = 0;
const CP_UTF8 = 65001;
const CP_WINDOWS_1252 = 1252;
const CP_OEM_437 = 437;

const ERROR_INVALID_PARAMETER = 87;
const ERROR_INSUFFICIENT_BUFFER = 122;

const CT_CTYPE1 = 1;
const C1_UPPER = 0x0001;
const C1_LOWER = 0x0002;
const C1_DIGIT = 0x0004;
const C1_SPACE = 0x0008;
const C1_ALPHA = 0x0100;
const C1_XDIGIT = 0x0080;

const LCMAP_LOWERCASE = 0x00000100;
const LCMAP_UPPERCASE = 0x00000200;

function fakeHost(){
    const bytes = new Uint8Array(0x1000);
    /** @type {number[]} */
    const errors = [];

    return {
        bytes,
        errors,
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.slice(address, address + length),
        /** @param {number} address @param {number} unit */
        stringLength(address, unit){
            let count = 0;
            while ((unit === 1 ? bytes[address + count] : bytes[address + count * 2]
                | bytes[address + count * 2 + 1]) !== 0)
            {
                count++;
            }
            return count;
        },
        /** @param {number} address @param {Uint8Array} data */
        writeMemory(address, data){
            bytes.set(data, address);
        },
        /** @param {number} code */
        setLastError: code=>errors.push(code),
        /** @param {number} address @param {string} text */
        plantAnsi(address, text){
            for (let at = 0; at < text.length; at++)
            {
                bytes[address + at] = text.charCodeAt(at) & 0xff;
            }
            bytes[address + text.length] = 0;
        },
        /** @param {number} address @param {string} text */
        plantWide(address, text){
            for (let at = 0; at < text.length; at++)
            {
                const code = text.charCodeAt(at);
                bytes[address + at * 2] = code & 0xff;
                bytes[address + at * 2 + 1] = code >> 8;
            }
            bytes[address + text.length * 2] = 0;
            bytes[address + text.length * 2 + 1] = 0;
        },
        /** @param {number} address @param {number} count */
        readWide(address, count){
            let text = '';
            for (let at = 0; at < count; at++)
            {
                const low = bytes[address + at * 2];
                text += String.fromCharCode(low | bytes[address + at * 2 + 1] << 8);
            }
            return text;
        },
    };
}

test('the code pages reported are the ones a Western build was linked against', ()=>{
    const fns = createLocaleFunctions(fakeHost());
    assert.equal(fns.GetACP.handler(), CP_WINDOWS_1252);
    assert.equal(fns.GetOEMCP.handler(), CP_OEM_437);
});

test('EnumTimeFormatsA hands each format to the callback until it stops', async()=>{
    const host = fakeHost();
    /** @type {string[]} */
    const seen = [];
    let next = 0x800;
    const fns = createLocaleFunctions({
        ...host,
        callerThread: ()=>({ id: 1 }),
        /** @param {number} bytes */
        allocate: bytes=>{
            const at = next;
            next += bytes + 8;
            return at;
        },
        free: ()=>{},
        /** @param {number} entry @param {number[]} args */
        call: async(entry, [buffer])=>{
            void entry;
            let text = '';
            for (let at = 0; host.bytes[buffer + at] !== 0; at++)
            {
                text += String.fromCharCode(host.bytes[buffer + at]);
            }
            seen.push(text);
            return seen.length === 3 ? 0 : 1;
        },
    });

    assert.equal(await fns.EnumTimeFormatsA.handler([0x1234, 0x0409, 0]), 0,
        'the callback stopped the run');
    assert.deepEqual(seen, ['h:mm:ss tt', 'hh:mm:ss tt', 'H:mm:ss'],
        'the locale formats, first three then stopped');
    // Three arguments, as winnls.h declares it: a fourth popped moved the
    // caller's stack, and a program that enumerated twice returned to nowhere.
    assert.equal(fns.EnumTimeFormatsA.argBytes, 12);
    assert.equal(fns.EnumTimeFormatsW.argBytes, 12);
});

test("EnumDateFormatsA hands out each kind of date, the locale's own picture first", async()=>{
    // locale.c test_EnumDateFormatsA: the first format is GetLocaleInfo's.
    const host = fakeHost();
    /** @type {string[]} */
    let seen = [];
    let next = 0x800;
    const fns = createLocaleFunctions({
        ...host,
        callerThread: ()=>({ id: 1 }),
        /** @param {number} bytes */
        allocate: bytes=>{
            const at = next;
            next += bytes + 8;
            return at;
        },
        free: ()=>{},
        /** @param {number} entry @param {number[]} args */
        call: async(entry, [buffer])=>{
            void entry;
            let text = '';
            for (let at = 0; host.bytes[buffer + at] !== 0; at++)
            {
                text += String.fromCharCode(host.bytes[buffer + at]);
            }
            seen.push(text);
            return 1;
        },
    });
    /** @param {number} flags */
    const first = async flags=>{
        seen = [];
        assert.equal(await fns.EnumDateFormatsA.handler([0x1234, 0x0409, flags]), 1);
        return seen[0];
    };
    assert.equal(await first(0), 'M/d/yyyy', 'no kind is the short dates');
    assert.equal(await first(0x40000000), 'M/d/yyyy', 'LOCALE_USE_CP_ACP changes nothing');
    assert.equal(await first(1), 'M/d/yyyy');
    assert.equal(await first(2), 'dddd, MMMM dd, yyyy');
    assert.equal(await first(8), 'MMMM, yyyy');
    assert.equal(fns.EnumDateFormatsA.handler([0x1234, 0x0409, 0x10]), 0, 'an unknown kind');
    assert.equal(fns.EnumDateFormatsA.argBytes, 12);
});

test('EnumTimeFormatsA fails without a callback or a bridge to call through', ()=>{
    const fns = createLocaleFunctions(fakeHost());
    assert.equal(fns.EnumTimeFormatsA.handler([0, 0x0409, 0]), 0);
});


test('a single-byte page reports one byte per character and no lead-byte ranges', ()=>{
    // A lead-byte range that is not empty tells a caller to look for two-byte
    // sequences, and it will then read one character where there are two.
    const host = fakeHost();
    const fns = createLocaleFunctions(host);

    assert.equal(fns.GetCPInfo.handler([CP_ACP, 0x100]), 1);
    assert.equal(new DataView(host.bytes.buffer).getUint32(0x100, true), 1);
    assert.equal(host.bytes[0x104], 0x3f, 'the default character is a question mark');
    assert.deepEqual([...host.bytes.slice(0x106, 0x112)], new Array(12).fill(0));
});

test('UTF-8 reports the four bytes its longest sequence takes', ()=>{
    const host = fakeHost();
    const fns = createLocaleFunctions(host);

    fns.GetCPInfo.handler([CP_UTF8, 0x100]);
    assert.equal(new DataView(host.bytes.buffer).getUint32(0x100, true), 4);
});

test('a source length of -1 carries the terminator into the result', ()=>{
    // This is the whole convention: a runtime measures with -1, allocates what
    // it was told, and converts with -1 again. A count that leaves the NUL out
    // produces a buffer exactly one character short.
    const host = fakeHost();
    const fns = createLocaleFunctions(host);
    host.plantAnsi(0x100, 'abc');

    const needed = fns.MultiByteToWideChar.handler([CP_ACP, 0, 0x100, -1, 0, 0]);
    assert.equal(needed, 4, 'three characters and the terminator');

    assert.equal(fns.MultiByteToWideChar.handler([CP_ACP, 0, 0x100, -1, 0x200, needed]), 4);
    assert.equal(host.readWide(0x200, 4), 'abc\0');
});

test('an exact source length carries no terminator of its own', ()=>{
    const host = fakeHost();
    const fns = createLocaleFunctions(host);
    host.plantAnsi(0x100, 'abc');

    assert.equal(fns.MultiByteToWideChar.handler([CP_ACP, 0, 0x100, 3, 0, 0]), 3);
    assert.equal(fns.MultiByteToWideChar.handler([CP_ACP, 0, 0x100, 3, 0x200, 3]), 3);
    assert.equal(host.readWide(0x200, 3), 'abc');
});

test('a zero destination measures and writes nothing at all', ()=>{
    const host = fakeHost();
    const fns = createLocaleFunctions(host);
    host.plantAnsi(0x100, 'hello');
    host.bytes.fill(0xee, 0x200, 0x220);

    assert.equal(fns.MultiByteToWideChar.handler([CP_ACP, 0, 0x100, -1, 0x200, 0]), 6);
    assert.equal(host.bytes[0x200], 0xee, 'the destination was not touched');
});

test('a negative destination size is an invalid parameter, and nothing is written', ()=>{
    // -1 and -1000 alike: the destination length is a count, not the "up to
    // the terminator" a negative source length means.
    const host = fakeHost();
    const fns = createLocaleFunctions(host);
    host.plantAnsi(0x100, 'foobar');
    host.plantWide(0x300, 'foobar');

    for (const size of [-1, -1000])
    {
        host.bytes.fill(0xee, 0x200, 0x220);
        host.errors.length = 0;
        assert.equal(fns.MultiByteToWideChar.handler([CP_ACP, 0, 0x100, -1, 0x200, size]), 0);
        assert.deepEqual(host.errors, [ERROR_INVALID_PARAMETER]);
        assert.equal(host.bytes[0x200], 0xee, 'the destination was not touched');

        host.errors.length = 0;
        assert.equal(fns.WideCharToMultiByte.handler([CP_ACP, 0, 0x300, -1, 0x200, size, 0, 0]), 0);
        assert.deepEqual(host.errors, [ERROR_INVALID_PARAMETER]);
        assert.equal(host.bytes[0x200], 0xee);
    }
});

test('MB_ERR_INVALID_CHARS refuses a malformed UTF-8 sequence instead of replacing it', ()=>{
    const MB_ERR_INVALID_CHARS = 0x8;
    const ERROR_NO_UNICODE_TRANSLATION = 1113;
    const host = fakeHost();
    const fns = createLocaleFunctions(host);
    host.bytes.set([0x41, 0xff, 0x42, 0], 0x100);

    assert.equal(fns.MultiByteToWideChar.handler(
        [CP_UTF8, MB_ERR_INVALID_CHARS, 0x100, -1, 0x200, 16]), 0);
    assert.deepEqual(host.errors, [ERROR_NO_UNICODE_TRANSLATION]);
    assert.equal(fns.MultiByteToWideChar.handler(
        [CP_UTF8, MB_ERR_INVALID_CHARS, 0x100, -1, 0, 0]), 0, 'measuring refuses it too');

    assert.equal(fns.MultiByteToWideChar.handler([CP_UTF8, 0, 0x100, -1, 0x200, 16]), 4,
        'without the flag the byte is replaced and the call succeeds');
    host.bytes.set([0xc3, 0xa9, 0], 0x100);
    assert.equal(fns.MultiByteToWideChar.handler(
        [CP_UTF8, MB_ERR_INVALID_CHARS, 0x100, -1, 0x200, 16]), 2, 'a well-formed one converts');
});

test('a NULL source is an invalid parameter, not a read of address zero', ()=>{
    const host = fakeHost();
    const fns = createLocaleFunctions(host);

    assert.equal(fns.MultiByteToWideChar.handler([CP_ACP, 0, 0, -1, 0, 0]), 0);
    assert.equal(fns.WideCharToMultiByte.handler([CP_ACP, 0, 0, -1, 0, 0, 0, 0]), 0);
    assert.deepEqual(host.errors, [ERROR_INVALID_PARAMETER, ERROR_INVALID_PARAMETER]);
});

test('a destination too small is filled as far as it goes, and the call still fails', ()=>{
    // Windows converts what fits before reporting the buffer too small. A
    // program that sized a BSTR from the measuring call less the terminator
    // reads the text back after the failure, and gets an empty string if
    // nothing was written.
    const host = fakeHost();
    const fns = createLocaleFunctions(host);
    host.plantAnsi(0x100, 'hello');
    host.bytes.fill(0xee, 0x200, 0x210);

    assert.equal(fns.MultiByteToWideChar.handler([CP_ACP, 0, 0x100, -1, 0x200, 3]), 0);
    assert.deepEqual(host.errors, [ERROR_INSUFFICIENT_BUFFER]);
    assert.equal(host.readWide(0x200, 3), 'hel');
    assert.equal(host.bytes[0x206], 0xee, 'and not one character past the buffer');

    host.plantWide(0x300, 'world');
    host.bytes.fill(0xee, 0x400, 0x410);
    assert.equal(fns.WideCharToMultiByte.handler([CP_ACP, 0, 0x300, -1, 0x400, 2, 0, 0]), 0);
    assert.deepEqual(host.errors, [ERROR_INSUFFICIENT_BUFFER, ERROR_INSUFFICIENT_BUFFER]);
    assert.deepEqual([...host.bytes.subarray(0x400, 0x403)], [0x77, 0x6f, 0xee]);
});

test('the upper half of Windows-1252 past the punctuation block encodes as Latin-1', ()=>{
    // Decoding already read 0xa0..0xff as Latin-1; encoding turned every one
    // of them into the default character, so an accented name came back as
    // question marks after a round trip through a wide string.
    const host = fakeHost();
    const fns = createLocaleFunctions(host);
    host.plantWide(0x100, 'caf\xe9 \xc9');

    assert.equal(fns.WideCharToMultiByte.handler([CP_ACP, 0, 0x100, -1, 0x200, 16, 0, 0x300]), 7);
    assert.deepEqual([...host.bytes.subarray(0x200, 0x207)],
        [0x63, 0x61, 0x66, 0xe9, 0x20, 0xc9, 0]);
    assert.equal(host.bytes[0x300], 0, 'and no default character was used');
});

test('Windows-1252 is not Latin-1 in the sixteen places it matters', ()=>{
    // 0x80..0x9f are control characters in Latin-1 and punctuation in 1252, and
    // text of this era is full of them; decoding them as controls loses them.
    const host = fakeHost();
    const fns = createLocaleFunctions(host);
    host.bytes[0x100] = 0x80;   // euro sign
    host.bytes[0x101] = 0x92;   // right single quote
    host.bytes[0x102] = 0xe9;   // e acute, where 1252 and Latin-1 agree
    host.bytes[0x103] = 0;

    fns.MultiByteToWideChar.handler([CP_WINDOWS_1252, 0, 0x100, 3, 0x200, 3]);
    assert.equal(host.readWide(0x200, 3), '€’é');
});

test('the OEM page is a different page, not a spelling of the ANSI one', ()=>{
    const host = fakeHost();
    const fns = createLocaleFunctions(host);
    host.bytes[0x100] = 0xdb;   // full block in 437, u-circumflex in 1252

    fns.MultiByteToWideChar.handler([CP_OEM_437, 0, 0x100, 1, 0x200, 1]);
    assert.equal(host.readWide(0x200, 1), '█');
});

test('UTF-8 round-trips a character no single-byte page holds', ()=>{
    const host = fakeHost();
    const fns = createLocaleFunctions(host);
    host.plantWide(0x100, '你好');

    const needed = fns.WideCharToMultiByte.handler(
        [CP_UTF8, 0, 0x100, 2, 0, 0, 0, 0]);
    assert.equal(needed, 6, 'two characters, three bytes each');

    fns.WideCharToMultiByte.handler([CP_UTF8, 0, 0x100, 2, 0x200, needed, 0, 0]);
    fns.MultiByteToWideChar.handler([CP_UTF8, 0, 0x200, needed, 0x300, 2]);
    assert.equal(host.readWide(0x300, 2), '你好');
});

test('a character the page cannot hold is reported, not silently replaced', ()=>{
    const host = fakeHost();
    const fns = createLocaleFunctions(host);
    host.plantWide(0x100, 'a你');

    const used = 0x400;
    fns.WideCharToMultiByte.handler([CP_ACP, 0, 0x100, 2, 0x200, 8, 0, used]);
    assert.equal(host.bytes[0x201], 0x3f, 'it became the default character');
    assert.equal(new DataView(host.bytes.buffer).getUint32(used, true), 1,
        'and the caller was told that happened');
});

test('the Latin-1 half of the ANSI page survives a round trip', ()=>{
    // Windows-1252 differs from Latin-1 only in 0x80..0x9f; above that the
    // byte is the code point, and the encoder answered the default character
    // for every one of them.
    const host = fakeHost();
    const fns = createLocaleFunctions(host);
    host.plantWide(0x100, 'é€');

    const used = 0x400;
    fns.WideCharToMultiByte.handler([CP_ACP, 0, 0x100, 2, 0x200, 8, 0, used]);
    assert.deepEqual([...host.bytes.subarray(0x200, 0x202)], [0xe9, 0x80]);
    assert.equal(new DataView(host.bytes.buffer).getUint32(used, true), 0);
});

test('the five positions Windows-1252 leaves undefined round-trip as their own code points', ()=>{
    // Microsoft's table for the page (bestfit1252.txt) maps 0x81, 0x8D, 0x8F,
    // 0x90 and 0x9D to U+0081, U+008D, U+008F, U+0090 and U+009D and back, so
    // text read from those bytes is written back as the same bytes rather than
    // as the default character.
    const host = fakeHost();
    const fns = createLocaleFunctions(host);
    const undefinedBytes = [0x81, 0x8d, 0x8f, 0x90, 0x9d];
    host.bytes.set(undefinedBytes, 0x100);

    fns.MultiByteToWideChar.handler([CP_ACP, 0, 0x100, 5, 0x200, 5]);
    assert.equal(host.readWide(0x200, 5), '\u0081\u008d\u008f\u0090\u009d');
    const used = 0x400;
    fns.WideCharToMultiByte.handler([CP_ACP, 0, 0x200, 5, 0x300, 8, 0, used]);
    assert.deepEqual([...host.bytes.subarray(0x300, 0x305)], undefinedBytes);
    assert.equal(new DataView(host.bytes.buffer).getUint32(used, true), 0);
});

test('a conversion that loses nothing says so', ()=>{
    const host = fakeHost();
    const fns = createLocaleFunctions(host);
    host.plantWide(0x100, 'plain');

    const used = 0x400;
    new DataView(host.bytes.buffer).setUint32(used, 0xffffffff, true);
    fns.WideCharToMultiByte.handler([CP_ACP, 0, 0x100, 5, 0x200, 8, 0, used]);
    assert.equal(new DataView(host.bytes.buffer).getUint32(used, true), 0);
});

test('character types name what a runtime classifies on', ()=>{
    const host = fakeHost();
    const fns = createLocaleFunctions(host);
    host.plantAnsi(0x100, 'Ab1 f');

    assert.equal(fns.GetStringTypeA.handler([0, CT_CTYPE1, 0x100, 5, 0x200]), 1);
    const view = new DataView(host.bytes.buffer);
    assert.equal(view.getUint16(0x200, true) & C1_UPPER, C1_UPPER);
    assert.equal(view.getUint16(0x200, true) & C1_ALPHA, C1_ALPHA);
    assert.equal(view.getUint16(0x202, true) & C1_LOWER, C1_LOWER);
    assert.equal(view.getUint16(0x204, true) & C1_DIGIT, C1_DIGIT);
    assert.equal(view.getUint16(0x204, true) & C1_XDIGIT, C1_XDIGIT, 'a digit is also hex');
    assert.equal(view.getUint16(0x206, true) & C1_SPACE, C1_SPACE);
    assert.equal(view.getUint16(0x208, true) & C1_XDIGIT, C1_XDIGIT, 'and so is f');
});

test('the wide form of GetStringType has no locale argument', ()=>{
    // The A and W forms disagree about their own shape, which is the one thing
    // a caller cannot recover from: every argument after it lands one slot out.
    const host = fakeHost();
    const fns = createLocaleFunctions(host);

    assert.equal(fns.GetStringTypeA.argBytes, 20);
    assert.equal(fns.GetStringTypeExA, fns.GetStringTypeA, 'the Ex form is the A form');
    assert.equal(fns.GetStringTypeW.argBytes, 16);

    host.plantWide(0x100, 'Q');
    assert.equal(fns.GetStringTypeW.handler([CT_CTYPE1, 0x100, 1, 0x200]), 1);
    assert.equal(new DataView(host.bytes.buffer).getUint16(0x200, true) & C1_UPPER, C1_UPPER);
});

test('the wide Ex form of GetStringType keeps the locale argument', ()=>{
    const host = fakeHost();
    const fns = createLocaleFunctions(host);
    assert.equal(fns.GetStringTypeExW.argBytes, 20);

    host.plantWide(0x100, 'q7');
    assert.equal(fns.GetStringTypeExW.handler([0x0409, CT_CTYPE1, 0x100, 2, 0x200]), 1);
    const view = new DataView(host.bytes.buffer);
    assert.equal(view.getUint16(0x200, true) & C1_LOWER, C1_LOWER);
    assert.equal(view.getUint16(0x202, true) & C1_DIGIT, C1_DIGIT);
    assert.equal(fns.GetStringTypeExW.handler([0x0409, CT_CTYPE1, 0, 2, 0x200]), 0);
    assert.deepEqual(host.errors, [ERROR_INVALID_PARAMETER]);
});

test('LCMapString changes case and measures like everything else here', ()=>{
    const host = fakeHost();
    const fns = createLocaleFunctions(host);
    host.plantAnsi(0x100, 'MiXeD');

    assert.equal(fns.LCMapStringA.handler([0, LCMAP_LOWERCASE, 0x100, 5, 0, 0]), 5);
    fns.LCMapStringA.handler([0, LCMAP_LOWERCASE, 0x100, 5, 0x200, 5]);
    assert.equal(String.fromCharCode(...host.bytes.slice(0x200, 0x205)), 'mixed');

    fns.LCMapStringA.handler([0, LCMAP_UPPERCASE, 0x100, 5, 0x200, 5]);
    assert.equal(String.fromCharCode(...host.bytes.slice(0x200, 0x205)), 'MIXED');
});

test('LCMapStringW maps the wide form in place of the narrow one', ()=>{
    const host = fakeHost();
    const fns = createLocaleFunctions(host);
    host.plantWide(0x100, 'AbC');

    fns.LCMapStringW.handler([0, LCMAP_LOWERCASE, 0x100, 3, 0x200, 3]);
    assert.equal(host.readWide(0x200, 3), 'abc');
});

test('the UI language is the language everything else here is in', ()=>{
    const fns = createLocaleFunctions(fakeHost());
    assert.equal(fns.GetSystemDefaultUILanguage.handler(),
        fns.GetSystemDefaultLangID.handler());
    assert.equal(fns.GetSystemDefaultUILanguage.argBytes, 0);
    assert.equal(fns.GetUserDefaultUILanguage.handler(), fns.GetUserDefaultLangID.handler(),
        'the user\'s UI language too');
    assert.equal(fns.GetUserDefaultUILanguage.argBytes, 0);
    assert.equal(fns.GetUserDefaultUILanguage.handler(), UI_LANGUAGE,
        'the language a resource lookup naming none prefers');
});

test('a number is grouped and given the locale decimals when no picture is passed', ()=>{
    const host = fakeHost();
    const fns = createLocaleFunctions(host);
    host.plantAnsi(0x100, '1234567.5');

    assert.equal(fns.GetNumberFormatA.handler([0x400, 0, 0x100, 0, 0x200, 32]), 13);
    assert.equal(String.fromCharCode(...host.bytes.slice(0x200, 0x20c)), '1,234,567.50');
});

test('a caller\'s own NUMBERFMT decides the decimals, the grouping and the separators', ()=>{
    const host = fakeHost();
    const fns = createLocaleFunctions(host);
    host.plantAnsi(0x100, '-0001234');
    host.plantAnsi(0x300, ',');
    host.plantAnsi(0x310, ' ');
    // NumDigits 0, LeadingZero 1, Grouping 3, lpDecimalSep, lpThousandSep, NegativeOrder 0.
    const view = new DataView(host.bytes.buffer);
    [0, 1, 3, 0x300, 0x310, 0].forEach((field, at)=>view.setUint32(0x320 + at * 4, field, true));

    assert.equal(fns.GetNumberFormatA.handler([0x400, 0, 0x100, 0x320, 0x200, 32]), 8);
    assert.equal(String.fromCharCode(...host.bytes.slice(0x200, 0x207)), '(1 234)');
    // A count of zero measures; a value that is not a number fails.
    assert.equal(fns.GetNumberFormatA.handler([0x400, 0, 0x100, 0x320, 0, 0]), 8);
    host.plantAnsi(0x100, '12abc');
    assert.equal(fns.GetNumberFormatA.handler([0x400, 0, 0x100, 0, 0x200, 32]), 0);
    assert.deepEqual(host.errors, [ERROR_INVALID_PARAMETER]);
});

test('no byte leads a double-byte character on the pages this build carries', ()=>{
    const fns = createLocaleFunctions(fakeHost());
    assert.equal(fns.IsDBCSLeadByte.handler(), 0);
    assert.equal(fns.IsDBCSLeadByte.argBytes, 4);
});

test('the thread locale is the one locale, and the default placeholders resolve to it', ()=>{
    const fns = createLocaleFunctions(fakeHost());
    assert.equal(fns.GetThreadLocale.handler(), 0x0409);
    assert.equal(fns.SetThreadLocale.handler([0x0407]), 1);
    assert.equal(fns.GetThreadLocale.handler(), 0x0407, 'the thread keeps what it set');
    assert.equal(fns.SetThreadLocale.handler([0x0400]), 1);
    assert.equal(fns.GetThreadLocale.handler(), 0x0409, 'a placeholder is the one locale');
    assert.equal(fns.SetThreadLocale.argBytes, 4);
    assert.equal(fns.GetSystemDefaultLCID.handler(), 0x0409, 'the system has the same one');
    assert.equal(fns.GetSystemDefaultLCID.argBytes, 0);
    assert.equal(fns.ConvertDefaultLocale.handler([0x0400]), 0x0409, 'LOCALE_USER_DEFAULT');
    assert.equal(fns.ConvertDefaultLocale.handler([0x0800]), 0x0409, 'LOCALE_SYSTEM_DEFAULT');
    assert.equal(fns.ConvertDefaultLocale.handler([0x0407]), 0x0407, 'a real locale is itself');
    assert.equal(fns.ConvertDefaultLocale.argBytes, 4);
});

const LOCALE_RETURN_NUMBER = 0x20000000;
const LOCALE_RETURN_GENITIVE_NAMES = 0x10000000;
const ERROR_INVALID_FLAGS = 1004;

test('LOCALE_RETURN_NUMBER answers the value itself, counted in the form\'s characters', ()=>{
    const host = fakeHost();
    const fns = createLocaleFunctions(host);
    const view = new DataView(host.bytes.buffer);
    const ILANGUAGE = 0x0001;
    const IDEFAULTANSICODEPAGE = 0x1004;

    assert.equal(fns.GetLocaleInfoA.handler([0x409, ILANGUAGE | LOCALE_RETURN_NUMBER, 0x100, 4]),
        4, 'four bytes in the narrow form');
    assert.equal(view.getUint32(0x100, true), 0x0409, 'the language, not the text "0409"');
    assert.equal(fns.GetLocaleInfoW.handler([0x409, ILANGUAGE | LOCALE_RETURN_NUMBER, 0x200, 2]),
        2, 'two characters in the wide form');
    assert.equal(view.getUint32(0x200, true), 0x0409);
    assert.equal(fns.GetLocaleInfoA.handler(
        [0x400, IDEFAULTANSICODEPAGE | LOCALE_RETURN_NUMBER, 0x300, 4]), 4);
    assert.equal(view.getUint32(0x300, true), 1252, 'a decimal value is decimal');

    assert.equal(fns.GetLocaleInfoA.handler([0x409, ILANGUAGE | LOCALE_RETURN_NUMBER, 0, 0]), 4,
        'a count of zero measures');
    assert.equal(
        fns.GetLocaleInfoA.handler([0x409, ILANGUAGE | LOCALE_RETURN_NUMBER, 0x100, 2]), 0);
    assert.equal(host.errors.at(-1), ERROR_INSUFFICIENT_BUFFER);
});

test('a type the locale lacks, or a flag the call cannot take, is ERROR_INVALID_FLAGS', ()=>{
    const host = fakeHost();
    const fns = createLocaleFunctions(host);
    const SDECIMAL = 0x000E;
    const SMONTHNAME1 = 0x0038;

    assert.equal(fns.GetLocaleInfoA.handler([0x409, SDECIMAL | LOCALE_RETURN_NUMBER, 0x100, 4]), 0,
        'a string has no number to return');
    assert.equal(host.errors.at(-1), ERROR_INVALID_FLAGS);
    assert.equal(fns.GetLocaleInfoA.handler([0x409, 0x7ffe, 0x100, 64]), 0);
    assert.equal(host.errors.at(-1), ERROR_INVALID_FLAGS);

    host.bytes[0x100] = 0x61;
    assert.equal(fns.GetLocaleInfoA.handler(
        [0x409, SMONTHNAME1 | LOCALE_RETURN_GENITIVE_NAMES, 0x100, 64]), 0,
    'the narrow form has no genitive names');
    assert.equal(host.errors.at(-1), ERROR_INVALID_FLAGS);
    assert.equal(host.bytes[0x100], 0x61, 'and writes nothing');
    assert.equal(fns.GetLocaleInfoW.handler([0x409, LOCALE_RETURN_GENITIVE_NAMES, 0x100, 64]), 0,
        'the flag alone names no type');
    assert.equal(host.errors.at(-1), ERROR_INVALID_FLAGS);

    assert.equal(fns.GetLocaleInfoW.handler(
        [0x409, SMONTHNAME1 | LOCALE_RETURN_GENITIVE_NAMES, 0x100, 64]), 8,
    'an English month is its own genitive');
    assert.equal(host.readWide(0x100, 7), 'January');

    host.errors.length = 0;
    assert.equal(fns.GetLocaleInfoA.handler([0x419, SDECIMAL, 0x100, 64]), 0);
    assert.deepEqual(host.errors, [ERROR_INVALID_PARAMETER],
        'a locale we do not carry is still that');
});

test('the abbreviated names, the digit grouping and the currency are answered', ()=>{
    const host = fakeHost();
    const fns = createLocaleFunctions(host);
    /** @param {number} type */
    const ask = type=>{
        const length = fns.GetLocaleInfoA.handler([0x409, type, 0x100, 64]);
        assert.ok(length > 0, `LCTYPE 0x${type.toString(16)} is answered`);
        return String.fromCharCode(...host.bytes.slice(0x100, 0x100 + length - 1));
    };

    assert.equal(ask(0x0031), 'Mon', 'SABBREVDAYNAME1');
    assert.equal(ask(0x0037), 'Sun', 'SABBREVDAYNAME7');
    assert.equal(ask(0x0044), 'Jan', 'SABBREVMONTHNAME1');
    assert.equal(ask(0x004F), 'Dec', 'SABBREVMONTHNAME12');
    assert.equal(ask(0x0010), '3;0', 'SGROUPING');
    assert.equal(ask(0x0011), '2', 'IDIGITS');
    assert.equal(ask(0x0012), '1', 'ILZERO');
    assert.equal(ask(0x0005), '1', 'ICOUNTRY');
    assert.equal(ask(0x0014), '$', 'SCURRENCY');
    assert.equal(ask(0x0001), '0409', 'ILANGUAGE stays four hex digits as text');
    assert.equal(ask(0x000B), '437', 'IDEFAULTCODEPAGE');
});

test('SetLocaleInfo replaces a string for this user, and LOCALE_NOUSEROVERRIDE reads past it',
    ()=>{
        const host = fakeHost();
        const fns = createLocaleFunctions(host);
        const SDECIMAL = 0x0e;
        const LOCALE_NOUSEROVERRIDE = 0x80000000;
        host.bytes.set([0x2c, 0], 0x100);
        assert.equal(fns.SetLocaleInfoA.handler([0x409, SDECIMAL, 0x100]), 1);
        assert.equal(fns.GetLocaleInfoA.handler([0x409, SDECIMAL, 0x200, 8]), 2);
        assert.equal(host.bytes[0x200], 0x2c, 'the user\'s comma');
        assert.equal(fns.GetLocaleInfoA.handler(
            [0x409, SDECIMAL | LOCALE_NOUSEROVERRIDE, 0x200, 8]), 2);
        assert.equal(host.bytes[0x200], 0x2e, 'the locale\'s own point');

        host.bytes.set([0x2e, 0, 0, 0], 0x100);
        assert.equal(fns.SetLocaleInfoW.handler([0x409, SDECIMAL, 0x100]), 1);
        assert.equal(fns.GetLocaleInfoA.handler([0x409, SDECIMAL, 0x200, 8]), 2);
        assert.equal(host.bytes[0x200], 0x2e);

        assert.equal(fns.SetLocaleInfoA.handler([0x409, SDECIMAL, 0]), 0, 'no value');
    });

test('the preferred UI languages are listed as Windows lists them, sized and refused alike', ()=>{
    // locale.c test_GetSystemPreferredUILanguages / test_GetUserPreferredUILanguages.
    const host = fakeHost();
    const fns = createLocaleFunctions({ ...host, callerThread: ()=>({ id: 1 }) });
    const MUI_LANGUAGE_ID = 0x4;
    const MUI_LANGUAGE_NAME = 0x8;
    const MUI_MACHINE_LANGUAGE_SETTINGS = 0x400;
    const COUNT = 0x100;
    const SIZE = 0x104;
    const BUFFER = 0x200;
    const view = new DataView(host.bytes.buffer);
    /** @param {Record<string, any>} fn @param {number} flags @param {number} buffer @param {number} size */
    const ask = (fn, flags, buffer, size)=>{
        view.setUint32(COUNT, 0, true);
        view.setUint32(SIZE, size, true);
        return fn.handler([flags, COUNT, buffer, SIZE]);
    };
    const size = ()=>view.getUint32(SIZE, true);

    for (const fn of [fns.GetSystemPreferredUILanguages, fns.GetUserPreferredUILanguages])
    {
        assert.equal(fn.argBytes, 16);
        assert.equal(ask(fn, 0, 0, 0), 1);
        assert.equal(size(), 7, 'a name and two terminators');
        assert.equal(view.getUint32(COUNT, true), 1);
        assert.equal(ask(fn, MUI_LANGUAGE_ID, 0, 0), 1);
        assert.equal(size(), 6, 'four hex digits and two terminators');
        assert.equal(ask(fn, MUI_LANGUAGE_ID, BUFFER, 6), 1);
        assert.equal(host.readWide(BUFFER, 6), '0409\0\0');
        assert.equal(ask(fn, MUI_LANGUAGE_NAME, BUFFER, 7), 1);
        assert.equal(host.readWide(BUFFER, 7), 'en-US\0\0');

        host.errors.length = 0;
        assert.equal(ask(fn, MUI_LANGUAGE_ID | MUI_LANGUAGE_NAME, 0, 0), 0, 'both namings');
        assert.equal(ask(fn, 0x01, 0, 0), 0, 'MUI_FULL_LANGUAGE');
        assert.equal(ask(fn, MUI_LANGUAGE_ID, 0, 1), 0, 'a size with no buffer');
        assert.deepEqual(host.errors, [ERROR_INVALID_PARAMETER, ERROR_INVALID_PARAMETER,
            ERROR_INVALID_PARAMETER]);
        host.errors.length = 0;
        assert.equal(ask(fn, MUI_LANGUAGE_ID, BUFFER, 5), 0);
        assert.deepEqual(host.errors, [ERROR_INSUFFICIENT_BUFFER]);
        assert.equal(size(), 6, 'told the size it needs');
    }
    assert.equal(ask(fns.GetSystemPreferredUILanguages, MUI_MACHINE_LANGUAGE_SETTINGS, 0, 0), 1);
    assert.equal(ask(fns.GetUserPreferredUILanguages, MUI_MACHINE_LANGUAGE_SETTINGS, 0, 0), 0,
        'the user has no machine settings');

    // ntdll's: the same answer as a status, past a second argument.
    const natives = fns.GetSystemPreferredUILanguages.natives;
    view.setUint32(SIZE, 0, true);
    assert.equal(natives.RtlGetSystemPreferredUILanguages.handler(
        [MUI_LANGUAGE_ID, 0, COUNT, 0, SIZE]), 0);
    assert.equal(size(), 6);
    view.setUint32(SIZE, 1, true);
    assert.equal(natives.RtlGetSystemPreferredUILanguages.handler(
        [MUI_LANGUAGE_ID, 0, COUNT, BUFFER, SIZE]), 0xc0000023, 'STATUS_BUFFER_TOO_SMALL');
});

test("a thread's preferred UI languages are its own: the ones known kept, the rest refused", ()=>{
    // locale.c test_GetThreadPreferredUILanguages and test_SetThreadUILanguage,
    // and START_TEST, which sets "en-US" through the call before anything else.
    const host = fakeHost();
    const first = { id: 1 };
    let thread = first;
    const fns = createLocaleFunctions({ ...host, callerThread: ()=>thread });
    const MUI_LANGUAGE_NAME = 0x8;
    const MUI_THREAD_LANGUAGES = 0x40;
    const MUI_UI_FALLBACK = 0x30;
    const ERROR_GEN_FAILURE = 31;
    const LIST = 0x300;
    const COUNT = 0x100;
    const SIZE = 0x104;
    const BUFFER = 0x200;
    const view = new DataView(host.bytes.buffer);
    /** @param {string} text */
    const plantList = text=>{
        for (let at = 0; at < text.length; at++)
        {
            view.setUint16(LIST + at * 2, text.charCodeAt(at), true);
        }
        view.setUint32(LIST + text.length * 2, 0, true);
    };
    const threadList = ()=>{
        view.setUint32(SIZE, 64, true);
        assert.equal(fns.GetThreadPreferredUILanguages.handler(
            [MUI_LANGUAGE_NAME | MUI_THREAD_LANGUAGES, COUNT, BUFFER, SIZE]), 1);
        return host.readWide(BUFFER, view.getUint32(SIZE, true));
    };

    assert.equal(fns.SetThreadPreferredUILanguages.argBytes, 12);
    assert.equal(fns.SetThreadPreferredUILanguages.handler([MUI_LANGUAGE_NAME, 0, 0]), 1,
        'no list clears, and no count is fine');
    assert.equal(threadList(), '\0\0', 'a thread names nothing of its own');
    view.setUint32(SIZE, 0, true);
    assert.equal(fns.GetThreadPreferredUILanguages.handler(
        [MUI_LANGUAGE_NAME | MUI_UI_FALLBACK, COUNT, 0, SIZE]), 1);
    assert.equal(view.getUint32(COUNT, true), 1, "and is then given the user's");

    plantList('xx-YY\0en-US\0en-US\0');
    view.setUint32(COUNT, 0xdeadbeef, true);
    assert.equal(fns.SetThreadPreferredUILanguages.handler([MUI_LANGUAGE_NAME, LIST, COUNT]), 1);
    assert.equal(view.getUint32(COUNT, true), 1, 'the known ones, each once');
    assert.equal(threadList(), 'en-US\0\0');

    thread = { id: 2 };
    assert.equal(threadList(), '\0\0', "another thread's are its own");
    thread = first;

    plantList('aa-BB\0cc-DD\0');
    view.setUint32(COUNT, 0xdeadbeef, true);
    host.errors.length = 0;
    assert.equal(fns.SetThreadPreferredUILanguages.handler([MUI_LANGUAGE_NAME, LIST, COUNT]), 0);
    assert.deepEqual(host.errors, [ERROR_GEN_FAILURE]);
    assert.equal(view.getUint32(COUNT, true), 0xdeadbeef, 'the count left alone');
    assert.equal(threadList(), 'en-US\0\0', 'and the list too');

    // SetThreadUILanguage: zero answers the language as it stands.
    assert.equal(fns.SetThreadUILanguage.handler([0]), fns.GetThreadUILanguage.handler());
    assert.equal(fns.SetThreadUILanguage.handler([0x0813]), 0x0813);
    assert.equal(fns.SetThreadUILanguage.handler([0]), 0x0813);
    assert.equal(fns.GetThreadUILanguage.handler(), 0x0813);
    plantList('\0');
    assert.equal(fns.SetThreadPreferredUILanguages.handler([MUI_LANGUAGE_NAME, LIST, 0]), 1);
    assert.equal(fns.GetThreadUILanguage.handler(), UI_LANGUAGE, 'an empty list clears it all');
});

test('numbers and money are rounded half up, grouped as Grouping says, refused as Windows', ()=>{
    // locale.c test_GetNumberFormatA / test_GetCurrencyFormatA.
    const host = fakeHost();
    const fns = createLocaleFunctions(host);
    const NUO = 0x80000000;
    const OUT = 0x200;
    /**
     * @param {Record<string, any>} fn @param {string} value
     * @param {number} [format] @param {number} [flags]
     */
    const ask = (fn, value, format = 0, flags = 0)=>{
        host.plantAnsi(0x100, value);
        const length = fn.handler([0x0409, flags, 0x100, format, OUT, 64]);
        return length === 0 ? null
            : new TextDecoder().decode(host.bytes.slice(OUT, OUT + length - 1));
    };
    assert.equal(ask(fns.GetNumberFormatA, '2353.119', 0, NUO), '2,353.12', 'rounded');
    assert.equal(ask(fns.GetNumberFormatA, '2353.111'), '2,353.11', 'truncated');
    assert.equal(ask(fns.GetNumberFormatA, '999.995'), '1,000.00', 'carried a digit longer');
    assert.equal(ask(fns.GetCurrencyFormatA, '2353'), '$2,353.00');
    assert.equal(ask(fns.GetCurrencyFormatA, '-2353'), '($2,353.00)');

    // A CURRENCYFMTA: digits, leading zero, grouping, two separators, the
    // negative and positive orders, the symbol.
    const view = new DataView(host.bytes.buffer);
    host.plantAnsi(0x300, '.');
    host.plantAnsi(0x304, ',');
    host.plantAnsi(0x308, '$');
    /** @param {number} grouping @param {number} [negative] */
    const picture = (grouping, negative = 0)=>{
        [1, 0, grouping, 0x300, 0x304, negative, 0, 0x308]
            .forEach((value, at)=>view.setUint32(0x340 + at * 4, value, true));
        return 0x340;
    };
    for (const [grouping, expected] of /** @type {[number, string][]} */ ([
        [31, '$1,2,3,4,5,6,7,890.0'], [312, '$12,34,56,7,890.0'],
        [310, '$123456,7,890.0'], [0, '$1234567890.0']]))
    {
        assert.equal(ask(fns.GetCurrencyFormatA, '1234567890', picture(grouping)), expected);
    }
    assert.equal(ask(fns.GetNumberFormatA, '123456789', picture(23)), '1,234,567,89.0');
    assert.equal(ask(fns.GetCurrencyFormatA, '-1', picture(3, 14)), '($ 1.0)');

    host.errors.length = 0;
    assert.equal(ask(fns.GetNumberFormatA, '2353', picture(3), NUO), null, 'a picture and flags');
    assert.equal(ask(fns.GetCurrencyFormatA, '23,53'), null, 'not a number');
    assert.equal(ask(fns.GetCurrencyFormatA, '0-'), null, 'a trailing minus');
    view.setUint32(0x340 + 12, 0, true);
    assert.equal(ask(fns.GetNumberFormatA, '2353', 0x340), null, 'no decimal separator');
    assert.deepEqual(host.errors, [ERROR_INVALID_FLAGS, ERROR_INVALID_PARAMETER,
        ERROR_INVALID_PARAMETER, ERROR_INVALID_PARAMETER]);
    host.plantAnsi(0x100, '23');
    assert.equal(fns.GetCurrencyFormatA.handler([0x0409, 0, 0x100, 0, 0, 64]), 0,
        'no buffer but room claimed');
    assert.equal(fns.GetCurrencyFormatW.argBytes, 24);
});

test("GetDateFormatW takes the date's own weekday and refuses a date before 1601", ()=>{
    // locale.c test_GetDateFormatW.
    const host = fakeHost();
    const fns = createLocaleFunctions(host);
    const view = new DataView(host.bytes.buffer);
    /** @param {number[]} fields year, month, weekday, day, hour, minute, second */
    const plantTime = fields=>
        fields.forEach((value, at)=>view.setUint16(0x80 + at * 2, value, true));
    host.plantWide(0x100, 'dddd d MMMM yyyy');
    plantTime([2002, 10, 45612, 23, 65432, 34512, 65535]);
    let length = fns.GetDateFormatW.handler([0x0409, 0, 0x80, 0x100, 0x200, 64]);
    assert.equal(host.readWide(0x200, length - 1), 'Wednesday 23 October 2002',
        'the weekday and time of day as given are not read');
    plantTime([1601, 1, 0, 1, 0, 0, 0]);
    length = fns.GetDateFormatW.handler([0x0409, 0, 0x80, 0x100, 0x200, 64]);
    assert.equal(host.readWide(0x200, length - 1), 'Monday 1 January 1601');
    host.plantWide(0x100, "h 'o''clock' tt");
    view.setUint16(0x80 + 8, 8, true);
    length = fns.GetTimeFormatW.handler([0x0409, 0, 0x80, 0x100, 0x200, 64]);
    assert.equal(host.readWide(0x200, length - 1), "8 o'clock AM", 'quoted text as it stands');

    host.errors.length = 0;
    plantTime([1600, 12, 0, 31, 23, 59, 59]);
    assert.equal(fns.GetDateFormatW.handler([0x0409, 0, 0x80, 0x100, 0x200, 64]), 0);
    assert.equal(fns.GetDateFormatW.handler([0x0800, 2, 0, 0x100, 0x200, 64]), 0,
        "flags with a picture of the caller's");
    assert.equal(fns.GetDateFormatW.handler([0x0409, 0, 0, 0x100, 0, 64]), 0, 'no buffer');
    assert.deepEqual(host.errors, [ERROR_INVALID_PARAMETER, ERROR_INVALID_FLAGS,
        ERROR_INVALID_PARAMETER]);
});

test('FoldStringW folds digits, the compatibility zone and ligatures, and refuses misuse', ()=>{
    // locale.c test_FoldStringW.
    const host = fakeHost();
    const fns = createLocaleFunctions(host);
    /** @param {number} flags @param {string} text */
    const fold = (flags, text)=>{
        host.plantWide(0x100, text);
        const length = fns.FoldStringW.handler([flags, 0x100, -1, 0x300, 128]);
        return host.readWide(0x300, length - 1);
    };
    assert.equal(fold(0x80, '٣²①９\u{1d7ce}x'), '32190x', 'MAP_FOLDDIGITS');
    assert.equal(fold(0x10, 'Ｗineϋǰ ª'), 'Wineϋǰ a',
        'MAP_FOLDCZONE');
    assert.equal(fold(0x2000, 'ÆßﬃǄ'), 'AEssffiDŽ',
        'MAP_EXPAND_LIGATURES');
    assert.equal(fold(0x40, 'é'), 'é', 'MAP_COMPOSITE');

    host.errors.length = 0;
    host.plantWide(0x100, 'A');
    for (const flags of [0, 0x20 | 0x40, 0x20 | 0x2000, 0x40 | 0x2000])
    {
        assert.equal(fns.FoldStringW.handler([flags, 0x100, 256, 0x300, 256]), 0);
    }
    assert.equal(fns.FoldStringW.handler([0x10, 0x100, -1, 0x100, 256]), 0, 'one buffer');
    assert.equal(fns.FoldStringW.handler([0x10, 0, -1, 0x300, 256]), 0, 'no source');
    assert.equal(fns.FoldStringW.handler([0x10, 0x100, 0, 0x300, 256]), 0, 'an empty one');
    assert.equal(fns.FoldStringW.handler([0x10, 0x100, -1, 0x300, -1]), 0, 'negative room');
    assert.deepEqual(host.errors, [...Array(4).fill(ERROR_INVALID_FLAGS),
        ...Array(4).fill(ERROR_INVALID_PARAMETER)]);
    assert.equal(fns.FoldStringW.handler([0x10, 0x100, 1, 0x300, 256]), 1,
        'a counted source has no terminator to add');
});

test('GetCPInfoEx names the page, and a page this build cannot convert is refused', ()=>{
    // locale.c test_GetCPInfo.
    const host = fakeHost();
    const fns = createLocaleFunctions(host);
    const view = new DataView(host.bytes.buffer);
    assert.equal(fns.GetCPInfoExW.handler([CP_UTF8, 0, 0x100]), 1);
    assert.equal(view.getUint32(0x100, true), 4, 'MaxCharSize');
    assert.equal(view.getUint16(0x100 + 18, true), 0xfffd, 'UnicodeDefaultChar');
    assert.equal(view.getUint32(0x100 + 20, true), CP_UTF8, 'CodePage');
    assert.equal(host.readWide(0x100 + 24, 13), '65001 (UTF-8)');
    assert.equal(fns.GetCPInfoExA.handler([CP_ACP, 0, 0x400]), 1);
    assert.equal(view.getUint32(0x400 + 20, true), CP_WINDOWS_1252);

    host.errors.length = 0;
    assert.equal(fns.GetCPInfoExW.handler([0xbeef, 0, 0x100]), 0);
    assert.equal(fns.GetCPInfo.handler([42, 0x100]), 0, 'CP_SYMBOL');
    assert.deepEqual(host.errors, [ERROR_INVALID_PARAMETER, ERROR_INVALID_PARAMETER]);
});

test('the calendar and by-name date enumerations hand the Gregorian calendar over', async()=>{
    // locale.c test_EnumCalendarInfo* and test_EnumDateFormatsExEx.
    const host = fakeHost();
    /** @type {{ text: string, rest: number[] }[]} */
    const seen = [];
    let next = 0x800;
    const fns = createLocaleFunctions({
        ...host,
        callerThread: ()=>({ id: 1 }),
        /** @param {number} bytes */
        allocate: bytes=>{
            const at = next;
            next += bytes + 8;
            return at;
        },
        free: ()=>{},
        /** @param {number} entry @param {number[]} args */
        call: async(entry, [text, ...rest])=>{
            void entry;
            seen.push({ text: host.readWide(text, host.stringLength(text, 2)), rest });
            return 1;
        },
    });
    const ENUM_ALL_CALENDARS = 0xffffffff;
    const CAL_RETURN_NUMBER = 0x20000000;
    assert.equal(await fns.EnumCalendarInfoExW.handler(
        [0x1234, 0x0400, ENUM_ALL_CALENDARS, CAL_RETURN_NUMBER | 1]), 1);
    assert.equal(await fns.EnumCalendarInfoW.handler([0x1234, 0x0409, 1, 7]), 1);
    assert.deepEqual(seen, [{ text: '1', rest: [1] }, { text: 'Monday', rest: [] }],
        'CAL_ICALINTVALUE with the calendar after it, then CAL_SDAYNAME1');
    assert.equal(fns.EnumCalendarInfoA.handler([0x1234, 0x0409, 1, 0x7777]), 0, 'no such CALTYPE');

    seen.length = 0;
    host.plantWide(0x100, 'en-US');
    assert.equal(await fns.EnumDateFormatsExEx.handler([0x1234, 0x100, 2, 0xabcd]), 1);
    assert.deepEqual(seen[0], { text: 'dddd, MMMM dd, yyyy', rest: [1, 0xabcd] });
    host.errors.length = 0;
    host.plantWide(0x100, 'deadbeef');
    assert.equal(fns.EnumDateFormatsExEx.handler([0x1234, 0x100, 1, 0]), 0);
    assert.deepEqual(host.errors, [ERROR_INVALID_PARAMETER]);
});

test('GetStringType refuses a missing string or type buffer', ()=>{
    // locale.c test_GetStringTypeW: "NULL src".
    const host = fakeHost();
    const fns = createLocaleFunctions(host);
    assert.equal(fns.GetStringTypeW.handler([CT_CTYPE1, 0, 0, 0]), 0);
    assert.equal(fns.GetStringTypeW.handler([CT_CTYPE1, 0, 5, 0x200]), 0);
    assert.equal(fns.GetStringTypeA.handler([0x0409, CT_CTYPE1, 0, 5, 0x200]), 0);
    assert.deepEqual(host.errors, Array(3).fill(ERROR_INVALID_PARAMETER));
});

test('VerLanguageName names a version resource\'s language, cut to the buffer', ()=>{
    // The Version tab's "Language" line: the length answered is the whole
    // name's, so a short buffer is told how much more it needed.
    const host = fakeHost();
    const fns = createLocaleFunctions(host);
    const readAnsi = (/** @type {number} */ at)=>{
        let text = '';
        for (let i = at; host.bytes[i] !== 0; i++)
        {
            text += String.fromCharCode(host.bytes[i]);
        }
        return text;
    };
    assert.equal(fns.VerLanguageNameA.argBytes, 12);
    assert.equal(fns.VerLanguageNameA.handler([0x0409, 0x100, 64]), 23);
    assert.equal(readAnsi(0x100), 'English (United States)');
    assert.equal(fns.VerLanguageNameA.handler([0x0407, 0x100, 64]), 16);
    assert.equal(readAnsi(0x100), 'German (Germany)');
    assert.equal(fns.VerLanguageNameA.handler([0, 0x100, 64]), 16);
    assert.equal(readAnsi(0x100), 'Language Neutral');
    assert.equal(fns.VerLanguageNameA.handler([0x0409, 0x100, 8]), 23, 'the whole length');
    assert.equal(readAnsi(0x100), 'English', 'and as much as fits, terminated');
    assert.equal(fns.VerLanguageNameA.handler([0x0409, 0, 0]), 23, 'no buffer asks the length');

    assert.equal(fns.VerLanguageNameW.handler([0x040c, 0x200, 64]), 15);
    assert.equal(host.readWide(0x200, 16), 'French (France)\0');
    assert.deepEqual(host.errors, []);
});

test('EnumUILanguages hands the UI language to the callback, and succeeds when it stops',
    async()=>{
        // locale.c test_EnumUILanguageA: TRUE even when the callback answers
        // FALSE; a NULL callback is ERROR_INVALID_PARAMETER before a bad flag.
        const host = fakeHost();
        /** @type {{ text: string, rest: number[] }[]} */
        const seen = [];
        const fns = createLocaleFunctions({
            ...host,
            callerThread: ()=>({ id: 1 }),
            allocate: ()=>0x800,
            free: ()=>{},
            /** @param {number} entry @param {number[]} args */
            call: async(entry, [text, ...rest])=>{
                void entry;
                seen.push({ text: host.readWide(text, host.stringLength(text, 2)), rest });
                return 0;
            },
        });
        const MUI_LANGUAGE_ID = 4;
        const MUI_LANGUAGE_NAME = 8;
        assert.equal(fns.EnumUILanguagesW.argBytes, 12);
        assert.equal(await fns.EnumUILanguagesW.handler([0x1234, 0, 0x77]), 1);
        assert.equal(await fns.EnumUILanguagesW.handler([0x1234, MUI_LANGUAGE_ID, 0]), 1);
        assert.equal(await fns.EnumUILanguagesW.handler([0x1234, MUI_LANGUAGE_NAME, 0]), 1);
        const id = UI_LANGUAGE.toString(16).toUpperCase().padStart(4, '0');
        assert.deepEqual(seen, [{ text: id, rest: [0x77] }, { text: id, rest: [0] },
            { text: 'en-US', rest: [0] }]);

        assert.equal(fns.EnumUILanguagesW.handler([0, 0x5a5a5a5a, 0]), 0);
        assert.equal(fns.EnumUILanguagesA.handler([0x1234, 0x5a5a5a5a, 0]), 0);
        assert.deepEqual(host.errors, [ERROR_INVALID_PARAMETER, 1004]);

        const unbridged = createLocaleFunctions(fakeHost());
        assert.equal(unbridged.EnumUILanguagesA.handler([0x1234, 0, 0]), 0,
            'with no way to call back, not a success that never called');
    });

test('GetCalendarInfo answers the Gregorian calendar, a number in lpValue when asked', ()=>{
    // time.c test_GetCalendarInfo.
    const host = fakeHost();
    const fns = createLocaleFunctions(host);
    const CAL_GREGORIAN = 1;
    const CAL_ITWODIGITYEARMAX = 0x30;
    const CAL_RETURN_NUMBER = 0x20000000;
    const CAL_SDAYNAME1 = 7;
    const view = new DataView(host.bytes.buffer);
    assert.equal(fns.GetCalendarInfoA.argBytes, 24);

    assert.equal(fns.GetCalendarInfoA.handler([0x0409, CAL_GREGORIAN,
        CAL_ITWODIGITYEARMAX | CAL_RETURN_NUMBER, 0, 0, 0x300]), 4);
    const year = view.getUint32(0x300, true);
    assert.ok(year >= 2000 && year < 2100);
    assert.equal(fns.GetCalendarInfoW.handler([0x0409, CAL_GREGORIAN,
        CAL_ITWODIGITYEARMAX | CAL_RETURN_NUMBER, 0, 0, 0x304]), 2);
    assert.equal(view.getUint32(0x304, true), year);

    assert.equal(fns.GetCalendarInfoA.handler([0x0409, CAL_GREGORIAN, CAL_ITWODIGITYEARMAX,
        0x100, 20, 0]), 5);
    assert.equal(String.fromCharCode(...host.bytes.subarray(0x100, 0x104)), String(year));
    assert.equal(fns.GetCalendarInfoW.handler([0x0409, CAL_GREGORIAN, CAL_ITWODIGITYEARMAX,
        0, 0, 0]), 5, 'the size asked with no room');
    assert.equal(fns.GetCalendarInfoA.handler([0x0800, CAL_GREGORIAN, CAL_SDAYNAME1,
        0x100, 20, 0]), 7);
    assert.equal(fns.GetCalendarInfoW.handler([0x0800, CAL_GREGORIAN, CAL_SDAYNAME1,
        0x200, 20, 0]), 7);
    assert.equal(host.readWide(0x200, 6), 'Monday');

    host.errors.length = 0;
    assert.equal(fns.GetCalendarInfoA.handler([0x0409, CAL_GREGORIAN,
        CAL_ITWODIGITYEARMAX | CAL_RETURN_NUMBER, 0, 0, 0]), 0);
    assert.equal(fns.GetCalendarInfoA.handler([0x0409, CAL_GREGORIAN,
        CAL_SDAYNAME1 | CAL_RETURN_NUMBER, 0, 0, 0x300]), 0);
    assert.equal(fns.GetCalendarInfoA.handler([0x0409, 3, CAL_SDAYNAME1, 0x100, 20, 0]), 0);
    assert.equal(fns.GetCalendarInfoA.handler([0x0409, CAL_GREGORIAN, 0x7777, 0x100, 20, 0]), 0);
    assert.equal(fns.GetCalendarInfoA.handler([0x0409, CAL_GREGORIAN, CAL_SDAYNAME1,
        0x100, 3, 0]), 0);
    assert.deepEqual(host.errors, [ERROR_INVALID_PARAMETER, 1004, ERROR_INVALID_PARAMETER, 1004,
        ERROR_INSUFFICIENT_BUFFER]);
});

test('GetGeoInfo answers for the machine\'s own location, by the types Windows XP has', ()=>{
    // locale.c test_GetGeoInfo's protocol, on the United States (244).
    /** @type {string[]} */
    const said = [];
    const host = fakeHost();
    const fns = createLocaleFunctions({ ...host, divergence: api=>said.push(api) });
    const US = 244;
    const ansi = (/** @type {number} */ at, /** @type {number} */ count)=>
        String.fromCharCode(...host.bytes.subarray(at, at + count));
    assert.equal(fns.GetGeoInfoA.argBytes, 20);
    assert.equal(fns.GetGeoInfoA.handler([US, 4, 0, 0, 0]), 3, 'GEO_ISO2\'s size');
    assert.equal(fns.GetGeoInfoA.handler([US, 5, 0x100, 4, 0]), 4);
    assert.equal(ansi(0x100, 4), 'USA\0');
    assert.equal(fns.GetGeoInfoA.handler([US, 1, 0x100, 20, 0]), 4);
    assert.equal(ansi(0x100, 4), '244\0');
    assert.equal(fns.GetGeoInfoA.handler([US, 6, 0x100, 20, 0]), 6);
    assert.equal(ansi(0x100, 6), 'en-us\0');
    assert.equal(fns.GetGeoInfoA.handler([US, 7, 0x100, 20, 0]), 9);
    assert.equal(ansi(0x100, 9), '00000409\0');
    assert.equal(fns.GetGeoInfoA.handler([US, 8, 0x100, 20, 0]), 14);
    assert.equal(fns.GetGeoInfoW.handler([US, 9, 0x200, 40, 0]), 25);
    assert.equal(host.readWide(0x200, 25), 'United States of America\0');
    assert.equal(fns.GetGeoInfoA.handler([US, 10, 0x100, 20, 0]), 0, 'no time zones');
    assert.deepEqual(host.errors, []);

    host.bytes.fill(0x61, 0x100, 0x108);
    assert.equal(fns.GetGeoInfoA.handler([US, 5, 0x100, 2, 0]), 0);
    assert.equal(ansi(0x100, 3), 'USa', 'what fits, unterminated');
    assert.equal(fns.GetGeoInfoA.handler([203, 4, 0x100, 20, 0]), 0, 'not this machine\'s');
    assert.equal(fns.GetGeoInfoA.handler([US, 99, 0x100, 20, 0]), 0);
    assert.equal(fns.GetGeoInfoA.handler([US, 2, 0x100, 20, 0]), 0);
    assert.equal(fns.GetGeoInfoA.handler([US, 3, 0x100, 20, 0]), 0);
    assert.deepEqual(host.errors, [ERROR_INSUFFICIENT_BUFFER, ERROR_INVALID_PARAMETER, 1004,
        ERROR_INVALID_PARAMETER, ERROR_INVALID_PARAMETER]);
    assert.deepEqual(said, ['GetGeoInfo'], 'the coordinates\' refusal said once');
});
