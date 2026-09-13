/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocaleFunctions } from './locale.js';

const CP_ACP = 0;
const CP_UTF8 = 65001;
const CP_WINDOWS_1252 = 1252;
const CP_OEM_437 = 437;

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

test('a destination too small fails and says why, rather than truncating', ()=>{
    const host = fakeHost();
    const fns = createLocaleFunctions(host);
    host.plantAnsi(0x100, 'hello');

    assert.equal(fns.MultiByteToWideChar.handler([CP_ACP, 0, 0x100, -1, 0x200, 3]), 0);
    assert.deepEqual(host.errors, [ERROR_INSUFFICIENT_BUFFER]);
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
});
