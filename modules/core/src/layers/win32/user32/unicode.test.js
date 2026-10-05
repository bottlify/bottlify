/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeAnsi } from '../kernel32/locale.js';
import { convertCharacter, readWideString, textBytes, translated, writeText } from './unicode.js';

const WM_CREATE = 0x0001;
const WM_SETTEXT = 0x000c;
const WM_GETTEXT = 0x000d;
const WM_CHAR = 0x0102;
const WM_USER = 0x0400;

/** Guest memory with a bump heap that remembers what is still lent. */
function memory(){
    const bytes = new Uint8Array(0x10000);
    let next = 0x8000;
    /** @type {Set<number>} */
    const lent = new Set();
    return {
        bytes,
        lent,
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.slice(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writeMemory: (address, data)=>bytes.set(data, address),
        /** @param {number} address @param {number} limit */
        readCString(address, limit){
            let end = address;
            while (bytes[end] !== 0 && end - address < limit)
            {
                end++;
            }
            return decodeAnsi(bytes.subarray(address, end));
        },
        /** @param {number} size */
        allocate(size){
            const address = next;
            next += (size + 15) & ~15;
            lent.add(address);
            return address;
        },
        /** @param {number} address */
        release: address=>{
            lent.delete(address);
        },
    };
}

test('a wide string and an ANSI one are stored as the guest stores them', ()=>{
    assert.deepEqual([...textBytes('A€', true)], [0x41, 0, 0xac, 0x20, 0, 0]);
    // The euro sign is 0x80 in the ANSI page.
    assert.deepEqual([...textBytes('A€', false)], [0x41, 0x80, 0]);
    const m = memory();
    m.writeMemory(0x100, textBytes('wide text', true));
    assert.equal(readWideString(m, 0x100), 'wide text');
    assert.equal(readWideString(m, 0x100, 4), 'wide');
});

test('text written into a buffer is cut to its room, terminator counted', ()=>{
    const m = memory();
    assert.equal(writeText(m, 0x200, 'abcdef', 4, true), 3);
    assert.equal(readWideString(m, 0x200), 'abc');
    assert.equal(writeText(m, 0x300, 'abcdef', 0, false), 0);
    assert.equal(m.bytes[0x300], 0);
});

test('a character code crosses as the page maps it', ()=>{
    assert.equal(convertCharacter(0x80, true), 0x20ac);
    assert.equal(convertCharacter(0x20ac, false), 0x80);
    assert.equal(convertCharacter(0x41, true), 0x41);
    // A character the page has no byte for.
    assert.equal(convertCharacter(0x4e2d, false), 0x3f);
});

test('a message to a procedure of its own encoding crosses as it came', ()=>{
    const m = memory();
    const message = { hwnd: 1, message: WM_SETTEXT, wParam: 0, lParam: 0x100, unicode: true };
    /** @type {any[]} */
    const seen = [];
    translated(m, message, true, got=>{
        seen.push(got);
        return 7;
    });
    assert.equal(seen[0], message);
});

test('WM_SETTEXT from a wide caller reaches an ANSI procedure as ANSI text, lent', ()=>{
    const m = memory();
    m.writeMemory(0x100, textBytes('Café', true));
    let read = '';
    const answer = translated(m, { hwnd: 1, message: WM_SETTEXT, wParam: 0, lParam: 0x100,
        unicode: true }, false, got=>{
        assert.equal(got.unicode, false);
        read = m.readCString(got.lParam, 100);
        return 1;
    });
    assert.equal(answer, 1);
    assert.equal(read, 'Café');
    assert.equal(m.lent.size, 0);
});

test('WM_GETTEXT answers the wide caller in its own buffer, in characters', ()=>{
    const m = memory();
    const answer = translated(m, { hwnd: 1, message: WM_GETTEXT, wParam: 5, lParam: 0x400,
        unicode: true }, false, got=>{
        // The ANSI procedure fills the lent buffer as it would the caller's.
        return writeText(m, got.lParam, 'Title bar', got.wParam, false);
    });
    assert.equal(answer, 4);
    assert.equal(readWideString(m, 0x400), 'Titl');
    assert.equal(m.lent.size, 0);
});

test('WM_GETTEXT from an ANSI caller of a wide procedure, answered after a wait', async()=>{
    const m = memory();
    const answer = translated(m, { hwnd: 1, message: WM_GETTEXT, wParam: 16, lParam: 0x400 },
        true, async got=>writeText(m, got.lParam, '€5', got.wParam, true));
    assert.equal(await answer, 2);
    assert.deepEqual([...m.bytes.subarray(0x400, 0x403)], [0x80, 0x35, 0]);
    assert.equal(m.lent.size, 0);
});

test('WM_CREATE carries a copy of the structure with its strings converted, an atom kept', ()=>{
    const m = memory();
    const view = new DataView(m.bytes.buffer);
    view.setUint32(0x500 + 0, 0x1234, true);
    view.setUint32(0x500 + 36, 0x600, true);
    view.setUint32(0x500 + 40, 0xc123, true);
    view.setUint32(0x500 + 44, 0x200, true);
    m.writeMemory(0x600, textBytes('Window', true));
    translated(m, { hwnd: 1, message: WM_CREATE, wParam: 0, lParam: 0x500, unicode: true }, false,
        got=>{
            assert.notEqual(got.lParam, 0x500);
            assert.equal(view.getUint32(got.lParam, true), 0x1234);
            assert.equal(m.readCString(view.getUint32(got.lParam + 36, true), 100), 'Window');
            assert.equal(view.getUint32(got.lParam + 40, true), 0xc123);
            assert.equal(view.getUint32(got.lParam + 44, true), 0x200);
            return 0;
        });
    assert.equal(m.lent.size, 0);
});

test('an MDI child\'s WM_CREATE carries its MDICREATESTRUCT converted too', ()=>{
    const m = memory();
    const view = new DataView(m.bytes.buffer);
    // The CREATESTRUCT: lpCreateParams at 0x700, the name, an atom class, WS_EX_MDICHILD.
    view.setUint32(0x500 + 0, 0x700, true);
    view.setUint32(0x500 + 36, 0x600, true);
    view.setUint32(0x500 + 40, 0xc123, true);
    view.setUint32(0x500 + 44, 0x40, true);
    m.writeMemory(0x600, textBytes('Child', true));
    // The MDICREATESTRUCT: an atom class, a wide title, the rest as asked.
    [0xc123, 0x7c0, 0x400000, 0x80000000, 0x80000000, 0x80000000, 0x80000000, 0, 0x1234]
        .forEach((value, at)=>view.setUint32(0x700 + at * 4, value >>> 0, true));
    m.writeMemory(0x7c0, textBytes('Child', true));
    translated(m, { hwnd: 1, message: WM_CREATE, wParam: 0, lParam: 0x500, unicode: true }, false,
        got=>{
            const mdi = view.getUint32(got.lParam, true);
            assert.notEqual(mdi, 0x700, 'a copy');
            assert.equal(view.getUint32(mdi, true), 0xc123, 'an atom kept');
            assert.notEqual(view.getUint32(mdi + 4, true), 0x7c0);
            assert.equal(m.readCString(view.getUint32(mdi + 4, true), 100), 'Child');
            assert.equal(view.getUint32(mdi + 12, true), 0x80000000);
            assert.equal(view.getUint32(mdi + 32, true), 0x1234);
            return 0;
        });
    assert.equal(m.lent.size, 0);
});

test('a character message is converted, any other message is not', ()=>{
    const m = memory();
    /** @type {any[]} */
    const seen = [];
    translated(m, { hwnd: 1, message: WM_CHAR, wParam: 0x20ac, lParam: 3, unicode: true }, false,
        got=>seen.push(got));
    translated(m, { hwnd: 1, message: WM_USER, wParam: 0x20ac, lParam: 0x100 }, true,
        got=>seen.push(got));
    assert.deepEqual(seen.map(got=>[got.wParam, got.lParam, got.unicode]),
        [[0x80, 3, false], [0x20ac, 0x100, true]]);
});

test('without a heap a text to set fails, and a creation is still told', ()=>{
    const m = memory();
    const bare = { ...m, allocate: undefined };
    let called = 0;
    assert.equal(translated(bare, { hwnd: 1, message: WM_SETTEXT, wParam: 0, lParam: 0x100,
        unicode: true }, false, ()=>++called), 0);
    assert.equal(called, 0);
    translated(bare, { hwnd: 1, message: WM_CREATE, wParam: 0, lParam: 0x500, unicode: true },
        false, got=>{
            called++;
            assert.equal(got.lParam, 0x500);
            return 0;
        });
    assert.equal(called, 1);
});

test('a list or combo box\'s item string crosses converted where the box keeps strings', ()=>{
    const CB_ADDSTRING = 0x0143;
    const LB_FINDSTRING = 0x018f;
    const CB_GETLBTEXT = 0x0148;
    const CB_GETLBTEXTLEN = 0x0149;
    const LBS_OWNERDRAWFIXED = 0x0010;
    const CBS_DROPDOWNLIST = 0x0003;
    const m = memory();
    m.writeMemory(0x100, textBytes('English', true));
    /** @type {string[]} */
    const read = [];
    const add = translated(m, { hwnd: 1, message: CB_ADDSTRING, wParam: 0, lParam: 0x100,
        unicode: true }, false, ansi=>{
        read.push(m.readCString(ansi.lParam, 64));
        return 0;
    }, CBS_DROPDOWNLIST);
    assert.equal(add, 0);
    assert.deepEqual(read, ['English'], 'the ANSI procedure reads the item, not its first letter');
    assert.equal(m.lent.size, 0, 'and the copy is given back');

    /** @type {number[]} */
    const data = [];
    translated(m, { hwnd: 1, message: LB_FINDSTRING, wParam: 0, lParam: 0x1234, unicode: true },
        false, ansi=>data.push(ansi.lParam), LBS_OWNERDRAWFIXED);
    assert.deepEqual(data, [0x1234], 'an owner-drawn box keeps data, which crosses as it came');

    // CB_GETLBTEXT from a wide caller: the length asked first, the item fetched
    // in ANSI into a buffer that long and written back wide.
    /** @type {number[]} */
    const asked = [];
    const got = translated(m, { hwnd: 1, message: CB_GETLBTEXT, wParam: 0, lParam: 0x400,
        unicode: true }, false, ansi=>{
        asked.push(ansi.message);
        if (ansi.message === CB_GETLBTEXTLEN)
        {
            return 7;
        }
        m.writeMemory(ansi.lParam, textBytes('English', false));
        return 7;
    }, CBS_DROPDOWNLIST);
    assert.equal(got, 7);
    assert.deepEqual(asked, [CB_GETLBTEXTLEN, CB_GETLBTEXT]);
    assert.equal(readWideString(m, 0x400), 'English');
});
