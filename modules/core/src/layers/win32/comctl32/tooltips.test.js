/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeAnsi } from '../kernel32/locale.js';
import { createTooltipProcedure } from './tooltips.js';

const WM_USER = 0x0400;
const TTM_ADDTOOLA = WM_USER + 4;
const TTM_DELTOOLA = WM_USER + 5;
const TTM_GETTOOLINFOA = WM_USER + 8;
const TTM_GETTEXTA = WM_USER + 11;
const TTM_UPDATETIPTEXTA = WM_USER + 12;
const TTM_GETTOOLCOUNT = WM_USER + 13;
const TTM_ENUMTOOLSA = WM_USER + 14;
const TTM_GETDELAYTIME = WM_USER + 21;
const TTM_SETMAXTIPWIDTH = WM_USER + 24;
const TTM_GETMAXTIPWIDTH = WM_USER + 25;
const TTM_ADDTOOLW = WM_USER + 50;
const TTM_SETMARGIN = WM_USER + 26;
const TTM_SETTITLEA = WM_USER + 32;
const TTM_ADJUSTRECT = WM_USER + 31;
const WM_CREATE = 0x0001;
const TTM_GETTEXTW = WM_USER + 56;
const TTS_NOPREFIX = 0x02;
// Above the first 64 KiB: a text pointer below it is a resource id.
const INFO = 0x10100;
const TEXT = 0x10200;
const BUFFER = 0x10400;

/** A control over plain memory, a window that answers TTN_GETDISPINFO, and string resources. */
function tooltip(){
    const bytes = new Uint8Array(0x12000);
    const view = new DataView(bytes.buffer);
    let heap = 0x11000;
    /** @type {number[]} */
    const asked = [];
    const procedure = createTooltipProcedure(/** @type {any} */ ({
        readMemory: (/** @type {number} */ at, /** @type {number} */ n)=>bytes.slice(at, at + n),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ data)=>
            bytes.set(data, at),
        readCString: (/** @type {number} */ at)=>
            decodeAnsi(bytes.subarray(at, bytes.indexOf(0, at))),
        allocate: (/** @type {number} */ n)=>{
            const at = heap;
            heap += n;
            return at;
        },
        release: ()=>{},
        sysColor: (/** @type {number} */ index)=>index,
        contextOn: ()=>({ hdc: 0x77 }),
        endPaint: ()=>{},
        draw: { measure: ()=>({ width: 8, height: 13, ascent: 10 }) },
        // The tool's window answers by copying into the buffer it is handed.
        send: (/** @type {number} */ hwnd, /** @type {number} */ message,
            /** @type {number} */ wParam, /** @type {number} */ lParam)=>
        {
            asked.push(view.getInt32(lParam + 8, true));
            const buffer = view.getUint32(lParam + 12, true);
            bytes.set(new TextEncoder().encode('from the window\0'), buffer);
            return 0;
        },
    }), { stateOf: (/** @type {any} */ record)=>(record.held ??= {}), common: ()=>0 },
    { loadString: (instance, id)=>(id === 7 ? `resource ${instance}` : null) });
    const record = { hwnd: 0x50, style: 0 };
    const send = (/** @type {number} */ message, /** @type {number} */ wParam,
        /** @type {number} */ lParam)=>procedure(record, { hwnd: 0x50, message, wParam, lParam });
    /** A TOOLINFO of this size, for the window and id, its text at `text`. */
    const info = (/** @type {number} */ size, /** @type {number} */ id,
        /** @type {number} */ text)=>
    {
        bytes.fill(0, INFO, INFO + 48);
        view.setUint32(INFO, size, true);
        view.setUint32(INFO + 12, id, true);
        view.setUint32(INFO + 32, 0x400000, true);
        view.setUint32(INFO + 36, text, true);
        view.setUint32(INFO + 40, 0xdeadbeef, true);
        return INFO;
    };
    const ansi = (/** @type {number} */ at, /** @type {string} */ text)=>
        bytes.set(new TextEncoder().encode(`${text}\0`), at);
    const string = (/** @type {number} */ at)=>decodeAnsi(bytes.subarray(at, bytes.indexOf(0, at)));
    return { send, info, ansi, string, bytes, view, record, asked };
}

test('a tool is added in either spelling, the wide one checked against the sizes it knows', ()=>{
    const t = tooltip();
    t.ansi(TEXT, 'Test');
    assert.equal(t.send(TTM_ADDTOOLA, 0, t.info(0, 1, TEXT)), 1, 'any size of the ANSI one');
    assert.equal(t.send(TTM_ADDTOOLW, 0, t.info(44, 2, 0)), 1);
    assert.equal(t.send(TTM_ADDTOOLW, 0, t.info(45, 3, 0)), 0, 'past version 2');
    assert.equal(t.send(TTM_GETTOOLCOUNT, 0, 0), 2);
    t.send(TTM_DELTOOLA, 0, t.info(40, 1, 0));
    assert.equal(t.send(TTM_GETTOOLCOUNT, 0, 0), 1);
});

test('a string is kept whole and shown to its first tab, unless TTS_NOPREFIX', ()=>{
    const t = tooltip();
    t.ansi(TEXT, 'tip\tmore');
    t.send(TTM_ADDTOOLA, 0, t.info(44, 1, TEXT));
    t.send(TTM_GETTEXTA, 0, t.info(44, 1, BUFFER));
    assert.equal(t.string(BUFFER), 'tip');
    t.record.style = TTS_NOPREFIX;
    t.send(TTM_GETTEXTA, 0, t.info(44, 1, BUFFER));
    assert.equal(t.string(BUFFER), 'tip\tmore');
});

test('an ANSI copy is eighty characters at most and then unterminated; a wide one is whole', ()=>{
    const t = tooltip();
    const long = 'x'.repeat(120);
    t.ansi(TEXT, long);
    t.send(TTM_ADDTOOLA, 0, t.info(44, 1, TEXT));
    t.bytes.fill(0, BUFFER, BUFFER + 512);
    assert.equal(t.send(TTM_ENUMTOOLSA, 0, t.info(44, 0, BUFFER)), 1);
    assert.equal(t.string(BUFFER).length, 80);
    assert.equal(t.view.getUint32(INFO + 12, true), 1, 'the id read back');
    t.bytes.fill(0, BUFFER, BUFFER + 512);
    t.send(TTM_GETTEXTW, 0, t.info(44, 1, BUFFER));
    assert.equal(t.view.getUint16(BUFFER + 119 * 2, true), 'x'.charCodeAt(0));
    assert.equal(t.view.getUint16(BUFFER + 120 * 2, true), 0);
});

test('a callback text is asked of the tool\'s window, a resource one loaded, NULL read as NULL',
    async()=>{
        const t = tooltip();
        t.send(TTM_ADDTOOLA, 0, t.info(44, 1, 0xffffffff));
        await t.send(TTM_GETTEXTA, 0, t.info(44, 1, BUFFER));
        assert.equal(t.string(BUFFER), 'from the window');
        assert.deepEqual(t.asked, [-520], 'TTN_GETDISPINFOA');
        t.send(TTM_GETTOOLINFOA, 0, t.info(44, 1, BUFFER));
        assert.equal(t.view.getUint32(INFO + 36, true), 0xffffffff, 'LPSTR_TEXTCALLBACK');

        t.send(TTM_UPDATETIPTEXTA, 0, t.info(44, 1, 7));
        t.send(TTM_GETTEXTA, 0, t.info(44, 1, BUFFER));
        assert.equal(t.string(BUFFER), 'resource 4194304');
        t.send(TTM_UPDATETIPTEXTA, 0, t.info(44, 1, 0));
        assert.equal(t.send(TTM_GETTOOLINFOA, 0, t.info(44, 1, BUFFER)), 1);
        assert.equal(t.view.getUint32(INFO + 36, true), 0, 'no text');
        assert.equal(t.view.getUint32(INFO + 40, true), 0xdeadbeef, 'lParam of version 2');
    });

test('the delays come from the double-click time, and the width is the program\'s', ()=>{
    const t = tooltip();
    assert.equal(t.send(TTM_GETDELAYTIME, 3, 0), 500, 'initial');
    assert.equal(t.send(TTM_GETDELAYTIME, 2, 0), 5000, 'autopop');
    assert.equal(t.send(TTM_GETDELAYTIME, 1, 0), 100, 'reshow');
    assert.equal(t.send(TTM_SETMAXTIPWIDTH, 0, 200), -1, 'no width before');
    assert.equal(t.send(TTM_GETMAXTIPWIDTH, 0, 0), 200);
});

test('version 6 knows the third TOOLINFO, with lpReserved', ()=>{
    const t = tooltip();
    Object.assign(t.record, { controlsVersion: 6 });
    assert.equal(t.send(TTM_ADDTOOLW, 0, t.info(48, 3, 0)), 1);
    assert.equal(t.send(TTM_ADDTOOLW, 0, t.info(49, 4, 0)), 0, 'past version 3');
});

test('a tip is made a bordered popup tool window whatever it was made as', ()=>{
    const t = tooltip();
    Object.assign(t.record, { style: (0xffffffff & ~0x40) >>> 0, exStyle: 0 });
    t.send(WM_CREATE, 0, 0);
    assert.equal(t.record.style >>> 0, 0xbebfffbf, 'no child, maximise or caption; popup, border');
    assert.equal(/** @type {any} */ (t.record).exStyle & 0x80, 0x80, 'WS_EX_TOOLWINDOW');
    Object.assign(t.record, { style: 0xffffffff, exStyle: 0 });
    t.send(WM_CREATE, 0, 0);
    assert.equal(t.record.style >>> 0, 0xbe3fffff, 'a balloon has no border');
});

test('TTM_ADJUSTRECT grows a text rectangle to its window and shrinks a window to its text',
    ()=>{
        const t = tooltip();
        t.record.style = 0x00800000;
        const rect = (/** @type {number[]} */ values)=>values.forEach((value, at)=>
            t.view.setInt32(BUFFER + at * 4, value, true));
        const read = ()=>[0, 4, 8, 12].map(at=>t.view.getInt32(BUFFER + at, true));
        rect([0, 0, 100, 100]);
        assert.equal(t.send(TTM_ADJUSTRECT, 1, BUFFER), 1);
        assert.deepEqual(read(), [-3, -3, 103, 103], 'the frame and the text margin');
        assert.equal(t.send(TTM_ADJUSTRECT, 0, BUFFER), 1);
        assert.deepEqual(read(), [0, 0, 100, 100], 'and back');
        [10, 20, 30, 40].forEach((value, at)=>t.view.setInt32(INFO + at * 4, value, true));
        t.send(TTM_SETMARGIN, 0, INFO);
        assert.equal(t.send(TTM_ADJUSTRECT, 1, BUFFER), 1);
        assert.deepEqual(read(), [-13, -23, 133, 143], 'with the margins TTM_SETMARGIN set');
        assert.equal(t.send(TTM_ADJUSTRECT, 1, 0), 0, 'no rectangle');
    });

test('version 6 adjusts by the frame and the text margin only, not the margins or a title', ()=>{
    const t = tooltip();
    Object.assign(t.record, { style: 0x00800000, controlsVersion: 6 });
    const read = ()=>[0, 4, 8, 12].map(at=>t.view.getInt32(BUFFER + at, true));
    [100, 100, 100, 100].forEach((value, at)=>t.view.setInt32(INFO + at * 4, value, true));
    t.send(TTM_SETMARGIN, 0, INFO);
    t.ansi(TEXT, 'A very long title');
    t.send(TTM_SETTITLEA, 1, TEXT);
    t.bytes.fill(0, BUFFER, BUFFER + 16);
    assert.equal(t.send(TTM_ADJUSTRECT, 1, BUFFER), 1);
    assert.deepEqual(read(), [-3, -3, 3, 3]);
});

test('version 5 counts a title\'s icon column and row, whatever the title\'s length', ()=>{
    const t = tooltip();
    t.record.style = 0x00800000;
    const read = ()=>[0, 4, 8, 12].map(at=>t.view.getInt32(BUFFER + at, true));
    const adjusted = (/** @type {string} */ title)=>{
        t.ansi(TEXT, title);
        t.send(TTM_SETTITLEA, 1, TEXT);
        t.bytes.fill(0, BUFFER, BUFFER + 16);
        t.send(TTM_ADJUSTRECT, 1, BUFFER);
        return read();
    };
    // The icon (16) and a gap (2) beside, the taller of the font's line (13)
    // and the icon above, and its gap.
    assert.deepEqual(adjusted('A very long title'), [-21, -21, 3, 3]);
    assert.deepEqual(adjusted('Short'), [-21, -21, 3, 3]);
});
