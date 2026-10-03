/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RICHEDIT_CLASSES, createRichEditControls, rtfToText } from './richedit.js';

const WM_USER = 0x0400;
const EM_EXGETSEL = WM_USER + 52;
const EM_EXSETSEL = WM_USER + 55;
const EM_SETBKGNDCOLOR = WM_USER + 67;
const EM_STREAMIN = WM_USER + 73;
const EM_GETTEXTRANGE = WM_USER + 75;
const SF_TEXT = 1;
const SF_RTF = 2;
const SFF_SELECTION = 0x8000;

/** @param {string} text */
const latin1 = text=>Uint8Array.from([...text].map(character=>character.charCodeAt(0)));

test('an RTF document is read as its text, its tables and properties read past', ()=>{
    const rtf = latin1('{\\rtf1\\ansi\\ansicpg1252\\deff0'
        + '{\\fonttbl{\\f0\\fswiss\\fcharset0 Arial;}}'
        + '{\\colortbl ;\\red0\\green0\\blue255;}\r\n{\\*\\generator Msftedit 5.41;}'
        + '\\viewkind4\\uc1\\pard\\b\\f0\\fs20 STEAM\\b0  SUBSCRIBER AGREEMENT\\par\r\n'
        + '\\par\r\ncaf\\\'e9 \\u8212?dash \\{brace\\}\\tab x\\line y'
        + '{\\pict\\wmetafile8 0102030405}\\~z}');
    assert.equal(rtfToText(rtf),
        'STEAM SUBSCRIBER AGREEMENT\r\n\r\ncaf\u00e9 \u2014dash {brace}\tx\r\ny\u00a0z');
});

test('a \\u is followed by as many characters for an older reader as \\uc says', ()=>{
    assert.equal(rtfToText(latin1('{\\rtf1\\uc2 a\\u1060\\\'d4\\\'d5b{\\uc0 \\u1061c}\\u1062??d}')),
        'a\u0424b\u0425c\u0426d');
    assert.equal(rtfToText(latin1('{\\rtf1 x\\u-3913?y}')), 'x\uf0b7y',
        'a negative number is the character it is short for');
});

/**
 * A rich edit over a guest memory of its own, its procedure the edit's for
 * everything it does not answer itself, and a program's stream callback that
 * hands over `source` a few bytes at a time.
 *
 * @param {Uint8Array} source @param {number} [step]
 */
function richEdit(source, step = 7){
    const memory = new Uint8Array(0x10000);
    let heap = 0x8000;
    let offered = 0;
    /** @type {number[]} */
    const released = [];
    /** @type {any[]} */
    const toEdit = [];
    /** @type {WeakMap<object, any>} */
    const states = new WeakMap();
    const view = new DataView(memory.buffer);
    const CALLBACK = 0x401000;
    const host = /** @type {any} */ ({
        readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
            memory.subarray(at, at + length),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ bytes)=>
            memory.set(bytes, at),
        allocate: (/** @type {number} */ bytes)=>{
            const at = heap;
            heap += bytes;
            return at;
        },
        release: (/** @type {number} */ at)=>released.push(at),
        call: (/** @type {number} */ entry, /** @type {number[]} */ [cookie, buffer, room, count])=>{
            assert.equal(entry, CALLBACK);
            assert.equal(cookie, 0x1234, 'the program\'s own cookie');
            const chunk = source.subarray(offered, offered + Math.min(room, step));
            memory.set(chunk, buffer);
            view.setUint32(count, chunk.length, true);
            offered += chunk.length;
            return Promise.resolve(0);
        },
        invalidate: ()=>{},
        sysColor: (/** @type {number} */ index)=>(index === 5 ? 0xffffff : 0),
    });
    const toolkit = {
        stateOf: (/** @type {object} */ record)=>{
            if (!states.has(record))
            {
                states.set(record, {});
            }
            return states.get(record);
        },
        writeU32: (/** @type {number} */ at, /** @type {number} */ value)=>
            view.setUint32(at, value >>> 0, true),
        writeString: (/** @type {number} */ at, /** @type {string} */ text)=>
            memory.set(latin1(`${text}\0`), at),
        editProc: (/** @type {any} */ record, /** @type {any} */ message)=>{
            toEdit.push(message);
            if (message.message === 0x00b1)
            {
                toolkit.stateOf(record).selStart = message.wParam;
                toolkit.stateOf(record).selEnd = message.lParam;
            }
            return 0;
        },
    };
    const definitions = createRichEditControls(host, toolkit);
    const record = { hwnd: 0x40, title: '' };
    const STREAM = 0x100;
    view.setUint32(STREAM, 0x1234, true);
    view.setUint32(STREAM + 8, CALLBACK, true);
    /** @param {number} message @param {number} wParam @param {number} lParam */
    const send = (message, wParam, lParam)=>definitions[0].procedure(record,
        { hwnd: record.hwnd, message, wParam, lParam });
    return { definitions, record, send, memory, view, STREAM, released, toEdit, toolkit };
}

test('EM_STREAMIN reads the program\'s stream through its callback, RTF as its text', async()=>{
    const rtf = latin1('{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}Read me.\\par Then agree.}');
    const { definitions, record, send, view, STREAM, released } = richEdit(rtf);
    assert.deepEqual(definitions.map(each=>each.name), RICHEDIT_CLASSES);
    assert.equal(await send(EM_STREAMIN, SF_RTF, STREAM), 'Read me.\r\nThen agree.'.length);
    assert.equal(record.title, 'Read me.\r\nThen agree.');
    assert.equal(view.getUint32(STREAM + 4, true), 0, 'no error');
    assert.equal(released.length, 1, 'the buffer it lent the callback is given back');

    const RANGE = 0x200;
    const TEXT = 0x300;
    view.setUint32(RANGE, 2, true);
    view.setUint32(RANGE + 4, 7, true);
    view.setUint32(RANGE + 8, TEXT, true);
    assert.equal(send(EM_GETTEXTRANGE, 0, RANGE), 5);
    assert.equal(new TextDecoder().decode(new Uint8Array(view.buffer, TEXT, 6)), 'ad me\0');
});

test('EM_STREAMIN with SFF_SELECTION puts plain text where the selection is', async()=>{
    const { record, send, view, STREAM } = richEdit(latin1('NEW'), 2);
    record.title = 'old text';
    const RANGE = 0x200;
    view.setUint32(RANGE, 4, true);
    view.setUint32(RANGE + 4, 8, true);
    assert.equal(await send(EM_EXSETSEL, 0, RANGE), 8);
    assert.equal(await send(EM_STREAMIN, SF_TEXT | SFF_SELECTION, STREAM), 3);
    assert.equal(record.title, 'old NEW');
    send(EM_EXGETSEL, 0, RANGE);
    assert.deepEqual([view.getUint32(RANGE, true), view.getUint32(RANGE + 4, true)], [7, 7]);
});

test('a rich edit paints in its own background, which EM_SETBKGNDCOLOR sets', ()=>{
    const { record, send, toolkit, toEdit } = richEdit(new Uint8Array(0));
    send(0x000f, 0, 0);
    assert.equal(toEdit.at(-1).message, 0x000f, 'painted by the edit');
    assert.equal(toolkit.stateOf(record).richBackground, 0xffffff, 'in the window colour');
    assert.equal(send(EM_SETBKGNDCOLOR, 0, 0x00336699), 0xffffff);
    assert.equal(toolkit.stateOf(record).richBackground, 0x00336699);
    assert.equal(send(EM_SETBKGNDCOLOR, 1, 0), 0x00336699);
    assert.equal(toolkit.stateOf(record).richBackground, 0xffffff, 'and the system\'s again');
});
