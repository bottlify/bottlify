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
