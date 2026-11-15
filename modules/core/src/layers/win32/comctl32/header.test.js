/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeAnsi } from '../kernel32/locale.js';
import { HDF_STRING, HDI_FORMAT, HDI_LPARAM, HDI_ORDER, HDI_TEXT, HDI_WIDTH,
    HDITEM, HDM, createHeaderProcedure } from './header.js';

const ITEM = 0x10100;
const TEXT = 0x10200;
const BUFFER = 0x10400;
const ARRAY = 0x10600;
const WM_NOTIFY = 0x004e;
const HDN_ITEMCHANGINGW = -320;
const HDN_ITEMCHANGEDW = -321;

/** A control over plain memory, its parent answering with `answer` and noting what it hears. */
function header(answer = 0){
    const bytes = new Uint8Array(0x14000);
    const view = new DataView(bytes.buffer);
    let heap = 0x11000;
    /** @type {{ code: number, item: number, text: string }[]} */
    const heard = [];
    const procedure = createHeaderProcedure(/** @type {any} */ ({
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
        clientSize: ()=>({ width: 300, height: 18 }),
        invalidate: ()=>{},
        send: (/** @type {number} */ hwnd, /** @type {number} */ message,
            /** @type {number} */ wParam, /** @type {number} */ lParam)=>
        {
            if (message !== WM_NOTIFY)
            {
                return 2;
            }
            // The item the parent is shown, its text in the parent's (wide) spelling.
            const item = view.getUint32(lParam + 20, true);
            const textAt = view.getUint32(item + HDITEM.pszText, true);
            let text = '';
            for (let at = textAt; at !== 0 && view.getUint16(at, true) !== 0; at += 2)
            {
                text += String.fromCharCode(view.getUint16(at, true));
            }
            heard.push({ code: view.getInt32(lParam + 8, true),
                item: view.getInt32(lParam + 12, true), text });
            return answer;
        },
    }), { stateOf: (/** @type {any} */ record)=>(record.held ??= {}), common: ()=>0 });
    const record = { hwnd: 0x50, id: 7, parent: 0x40, style: 0 };
    const send = (/** @type {number} */ message, /** @type {number} */ wParam,
        /** @type {number} */ lParam)=>procedure(record, { hwnd: 0x50, message, wParam, lParam });
    /** An ANSI HDITEM of this mask, width, lParam and text. */
    const item = (/** @type {number} */ mask, /** @type {number} */ width,
        /** @type {number} */ lParam, /** @type {string} */ text = '', order = 0)=>
    {
        bytes.fill(0, ITEM, ITEM + HDITEM.SIZE);
        bytes.set(new TextEncoder().encode(`${text}\0`), TEXT);
        view.setUint32(ITEM + HDITEM.mask, mask, true);
        view.setInt32(ITEM + HDITEM.cxy, width, true);
        view.setUint32(ITEM + HDITEM.pszText, TEXT, true);
        view.setUint32(ITEM + HDITEM.lParam, lParam, true);
        view.setInt32(ITEM + HDITEM.iOrder, order, true);
        return ITEM;
    };
    return { send, item, view, bytes, heard, record };
}

test('items keep their index while the display order lays them out', async()=>{
    const h = header();
    await h.send(0x0001, 0, 0);
    for (const [index, width] of [[0, 40], [1, 60], [2, 80]])
    {
        assert.equal(h.send(HDM.INSERTITEMA, index, h.item(HDI_WIDTH | HDI_LPARAM, width,
            index + 10)), index);
    }
    assert.equal(h.send(HDM.GETITEMCOUNT, 0, 0), 3);
    // Shown as 2, 0, 1: item 2 at the left.
    [2, 0, 1].forEach((index, i)=>h.view.setInt32(ARRAY + i * 4, index, true));
    assert.equal(h.send(HDM.SETORDERARRAY, 3, ARRAY), 1);
    assert.equal(h.send(HDM.GETITEMRECT, 0, BUFFER), 1);
    assert.deepEqual([0, 4, 8, 12].map(at=>h.view.getInt32(BUFFER + at, true)), [80, 0, 120, 18]);
    assert.equal(h.send(HDM.ORDERTOINDEX, 0, 0), 2);
    assert.equal(h.send(HDM.GETORDERARRAY, 2, ARRAY), 0, 'a wrong count is refused');
    // An item inserted at order 1 moves the others' indices, not their places.
    h.send(HDM.INSERTITEMA, 0, h.item(HDI_WIDTH | HDI_ORDER, 10, 0, '', 1));
    assert.equal(h.send(HDM.GETORDERARRAY, 4, ARRAY), 1);
    assert.deepEqual([0, 1, 2, 3].map(i=>h.view.getInt32(ARRAY + i * 4, true)), [3, 0, 1, 2]);
    assert.equal(h.send(HDM.DELETEITEM, 0, 0), 1);
    h.send(HDM.GETORDERARRAY, 3, ARRAY);
    assert.deepEqual([0, 1, 2].map(i=>h.view.getInt32(ARRAY + i * 4, true)), [2, 0, 1]);
    assert.equal(h.send(HDM.INSERTITEMA, 0, h.item(0, 0, 0)), -1, 'nothing to set is refused');
});

test('an inserted text makes a string item; a text and lParam read back cut to the room', ()=>{
    const h = header();
    h.send(HDM.INSERTITEMA, 0, h.item(HDI_TEXT | HDI_FORMAT, 0, 0, 'Column'));
    const at = h.item(HDI_TEXT | HDI_FORMAT, 0, 0);
    h.view.setUint32(at + HDITEM.pszText, BUFFER, true);
    h.view.setUint32(at + HDITEM.cchTextMax, 4, true);
    assert.equal(h.send(HDM.GETITEMA, 0, at), 1);
    assert.equal(decodeAnsi(h.bytes.subarray(BUFFER, h.bytes.indexOf(0, BUFFER))), 'Col');
    assert.equal(h.view.getUint32(at + HDITEM.fmt, true) & HDF_STRING, HDF_STRING);
    assert.equal(h.send(HDM.GETITEMA, 5, at), 0, 'an index past the items');
});

test('a change is told before and after, in the parent\'s spelling, and refused when it says so',
    async()=>{
        const h = header();
        await h.send(0x0001, 0, 0);
        h.send(HDM.INSERTITEMA, 0, h.item(HDI_WIDTH, 50, 0));
        assert.equal(await h.send(HDM.SETITEMA, 0, h.item(HDI_TEXT, 0, 0, 'TST')), 1);
        assert.deepEqual(h.heard, [{ code: HDN_ITEMCHANGINGW, item: 0, text: 'TST' },
            { code: HDN_ITEMCHANGEDW, item: 0, text: 'TST' }]);

        const refusing = header(1);
        await refusing.send(0x0001, 0, 0);
        refusing.send(HDM.INSERTITEMA, 0, refusing.item(HDI_WIDTH, 50, 0));
        assert.equal(await refusing.send(HDM.SETITEMA, 0, refusing.item(HDI_WIDTH, 99, 0)), 0);
        const at = refusing.item(HDI_WIDTH, 0, 0);
        refusing.send(HDM.GETITEMA, 0, at);
        assert.equal(refusing.view.getInt32(at + HDITEM.cxy, true), 50, 'the width is kept');
    });
