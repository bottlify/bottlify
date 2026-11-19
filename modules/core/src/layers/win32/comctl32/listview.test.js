/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeAnsi } from '../kernel32/locale.js';
import { LVCF_TEXT, LVCF_WIDTH, LVCOLUMN, LVIF_PARAM, LVIF_STATE, LVIF_TEXT, LVIS_FOCUSED,
    LVIS_SELECTED, LVITEM, LVM, LVS_OWNERDATA, LVS_REPORT, LVS_SINGLESEL,
    createListViewProcedure } from './listview.js';

const ITEM = 0x10100;
const TEXT = 0x10200;
const BUFFER = 0x10400;
const WM_NOTIFY = 0x004e;
const LVN_ITEMCHANGING = -100;
const LVN_ITEMCHANGED = -101;
const LVN_INSERTITEM = -102;
const LVN_DELETEITEM = -103;
const LVN_DELETEALLITEMS = -104;
const LVN_GETDISPINFOW = -177;

/**
 * A list view over plain memory. Its parent notes each notification as
 * [code, item, new state, old state] and answers LVN_GETDISPINFO by writing
 * "asked <item>" into the buffer it is handed.
 *
 * @param {number} style @param {(code: number) => number} [answer]
 * @param {(hdc: number, mode: number) => number} [setBkMode]
 */
function listview(style, answer = ()=>0, setBkMode = undefined){
    const bytes = new Uint8Array(0x20000);
    const view = new DataView(bytes.buffer);
    let heap = 0x11000;
    /** @type {number[][]} */
    const heard = [];
    const procedure = createListViewProcedure(/** @type {any} */ ({
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
        clientSize: ()=>({ width: 200, height: 100 }),
        contextOn: ()=>({ hdc: 0 }),
        endPaint: ()=>{},
        invalidate: ()=>{},
        send: (/** @type {number} */ hwnd, /** @type {number} */ message,
            /** @type {number} */ wParam, /** @type {number} */ lParam)=>
        {
            if (message !== WM_NOTIFY)
            {
                return 2;
            }
            const code = view.getInt32(lParam + 8, true);
            if (code === LVN_GETDISPINFOW)
            {
                const item = view.getInt32(lParam + 12 + LVITEM.iItem, true);
                const buffer = view.getUint32(lParam + 12 + LVITEM.pszText, true);
                [...`asked ${item}\0`].forEach((c, i)=>view.setUint16(buffer + i * 2,
                    c.charCodeAt(0), true));
                heard.push([code, item]);
                return 0;
            }
            heard.push([code, view.getInt32(lParam + 12, true), view.getUint32(lParam + 20, true),
                view.getUint32(lParam + 24, true)]);
            return answer(code);
        },
        draw: { fill: ()=>true },
    }), { stateOf: (/** @type {any} */ record)=>(record.held ??= {}), common: ()=>0,
        painting: (/** @type {any} */ _record, /** @type {any} */ paint)=>paint(0x99,
            { left: 0, top: 0, right: 200, bottom: 100 }) }, setBkMode);
    const record = { hwnd: 0x50, id: 3, parent: 0x40, style };
    const send = (/** @type {number} */ message, /** @type {number} */ wParam,
        /** @type {number} */ lParam)=>procedure(record, { hwnd: 0x50, message, wParam, lParam });
    /** An ANSI LVITEM. */
    const item = (/** @type {number} */ mask, /** @type {number} */ index,
        /** @type {{ text?: string | null, state?: number, stateMask?: number, lParam?: number,
         *     subItem?: number }} */ what = {})=>
    {
        bytes.fill(0, ITEM, ITEM + LVITEM.SIZE);
        view.setUint32(ITEM + LVITEM.mask, mask, true);
        view.setInt32(ITEM + LVITEM.iItem, index, true);
        view.setInt32(ITEM + LVITEM.iSubItem, what.subItem ?? 0, true);
        view.setUint32(ITEM + LVITEM.state, what.state ?? 0, true);
        view.setUint32(ITEM + LVITEM.stateMask, what.stateMask ?? 0, true);
        view.setUint32(ITEM + LVITEM.lParam, what.lParam ?? 0, true);
        if (what.text === null)
        {
            view.setUint32(ITEM + LVITEM.pszText, 0xffffffff, true);
        }
        else if (what.text !== undefined)
        {
            bytes.set(new TextEncoder().encode(`${what.text}\0`), TEXT);
            view.setUint32(ITEM + LVITEM.pszText, TEXT, true);
        }
        return ITEM;
    };
    const string = (/** @type {number} */ at)=>decodeAnsi(bytes.subarray(at, bytes.indexOf(0, at)));
    return { send, item, view, bytes, heard, record, string };
}

test('an inserted item is told after the state it takes; a focus moves from the item that had it',
    async()=>{
        const lv = listview(LVS_REPORT);
        await lv.send(0x0001, 0, 0);
        assert.equal(await lv.send(LVM.INSERTITEMA, 0, lv.item(LVIF_TEXT | LVIF_PARAM, 0,
            { text: 'first', lParam: 10 })), 0);
        assert.equal(await lv.send(LVM.INSERTITEMA, 5, lv.item(LVIF_TEXT | LVIF_STATE, 5,
            { text: 'second', state: LVIS_FOCUSED, stateMask: LVIS_FOCUSED })), 1,
        'an index past the end is the end');
        assert.deepEqual(lv.heard.map(h=>h.slice(0, 2)), [[LVN_INSERTITEM, 0],
            [LVN_ITEMCHANGING, 1], [LVN_ITEMCHANGED, 1], [LVN_INSERTITEM, 1]]);
        lv.heard.length = 0;
        await lv.send(LVM.SETITEMSTATE, 0, lv.item(0, 0, { state: LVIS_FOCUSED,
            stateMask: LVIS_FOCUSED }));
        assert.deepEqual(lv.heard.map(h=>h.slice(0, 2)), [[LVN_ITEMCHANGING, 0],
            [LVN_ITEMCHANGING, 1], [LVN_ITEMCHANGED, 1], [LVN_ITEMCHANGED, 0]],
        'the new focus is asked first, the old one loses it inside');
        assert.equal(lv.send(LVM.GETNEXTITEM, -1, 0x0001), 0);
        assert.equal(lv.send(LVM.GETITEMSTATE, 1, LVIS_FOCUSED), 0);
    });

test('a single-selection list keeps one selected; LVN_ITEMCHANGING refused leaves the state',
    async()=>{
        const lv = listview(LVS_REPORT | LVS_SINGLESEL);
        for (const index of [0, 1, 2])
        {
            await lv.send(LVM.INSERTITEMA, index, lv.item(LVIF_TEXT, index, { text: `${index}` }));
        }
        for (const index of [0, 2])
        {
            await lv.send(LVM.SETITEMSTATE, index, lv.item(0, 0, { state: LVIS_SELECTED,
                stateMask: LVIS_SELECTED }));
        }
        assert.equal(lv.send(LVM.GETSELECTEDCOUNT, 0, 0), 1);
        assert.equal(lv.send(LVM.GETNEXTITEM, -1, 0x0002), 2);
        assert.equal(await lv.send(LVM.SETITEMSTATE, -1, lv.item(0, 0, { state: LVIS_SELECTED,
            stateMask: LVIS_SELECTED })), 0, 'a single-selection list cannot select all');

        const refusing = listview(LVS_REPORT, code=>(code === LVN_ITEMCHANGING ? 1 : 0));
        await refusing.send(LVM.INSERTITEMA, 0, refusing.item(LVIF_TEXT, 0, { text: 'x' }));
        assert.equal(await refusing.send(LVM.SETITEMSTATE, 0, refusing.item(0, 0,
            { state: LVIS_SELECTED, stateMask: LVIS_SELECTED })), 0);
        assert.equal(refusing.send(LVM.GETITEMSTATE, 0, LVIS_SELECTED), 0);
    });

test('a text, a subitem and a callback read back; a callback is asked into the caller\'s buffer',
    async()=>{
        const lv = listview(LVS_REPORT);
        await lv.send(0x0001, 0, 0);
        await lv.send(LVM.INSERTITEMA, 0, lv.item(LVIF_TEXT, 0, { text: 'Alpha' }));
        await lv.send(LVM.INSERTITEMA, 1, lv.item(LVIF_TEXT, 1, { text: null }));
        await lv.send(LVM.SETITEMTEXTA, 0, lv.item(0, 0, { text: 'sub', subItem: 1 }));
        const get = (/** @type {number} */ index, /** @type {number} */ subItem)=>{
            const at = lv.item(LVIF_TEXT, index, { subItem });
            lv.view.setUint32(at + LVITEM.pszText, BUFFER, true);
            lv.view.setUint32(at + LVITEM.cchTextMax, 64, true);
            return at;
        };
        assert.equal(await lv.send(LVM.GETITEMTEXTA, 0, get(0, 0)), 5);
        assert.equal(lv.string(BUFFER), 'Alpha');
        await lv.send(LVM.GETITEMA, 0, get(0, 1));
        assert.equal(lv.string(BUFFER), 'sub');
        await lv.send(LVM.GETITEMA, 0, get(1, 0));
        assert.equal(lv.string(BUFFER), 'asked 1');
        assert.deepEqual(lv.heard.at(-1), [LVN_GETDISPINFOW, 1]);
    });

test('LVM_FINDITEM matches a text whole or as a prefix, and wraps only when told', async()=>{
    const lv = listview(LVS_REPORT);
    for (const [index, text] of ['apple', 'Banana', 'apricot'].entries())
    {
        await lv.send(LVM.INSERTITEMA, index, lv.item(LVIF_TEXT, index, { text }));
    }
    const find = (/** @type {number} */ flags, /** @type {string} */ text)=>{
        lv.bytes.set(new TextEncoder().encode(`${text}\0`), TEXT);
        lv.view.setUint32(BUFFER, flags, true);
        lv.view.setUint32(BUFFER + 4, TEXT, true);
        return BUFFER;
    };
    assert.equal(await lv.send(LVM.FINDITEMA, -1, find(0x0002, 'banana')), 1);
    assert.equal(await lv.send(LVM.FINDITEMA, 0, find(0x0008, 'ap')), 2);
    assert.equal(await lv.send(LVM.FINDITEMA, 2, find(0x0008, 'ap')), -1);
    assert.equal(await lv.send(LVM.FINDITEMA, 2, find(0x0008 | 0x0020, 'ap')), 0);
});

test('an owner-data list keeps a count and a selection, all changed at once as item -1', async()=>{
    const lv = listview(LVS_REPORT | LVS_OWNERDATA);
    assert.equal(await lv.send(LVM.INSERTITEMA, 0, lv.item(LVIF_TEXT, 0, { text: 'x' })), -1);
    lv.send(LVM.SETITEMCOUNT, 5, 0);
    assert.equal(lv.send(LVM.GETITEMCOUNT, 0, 0), 5);
    assert.equal(await lv.send(LVM.SETITEMSTATE, -1, lv.item(0, 0, { state: LVIS_SELECTED,
        stateMask: LVIS_SELECTED })), 1);
    assert.equal(lv.send(LVM.GETSELECTEDCOUNT, 0, 0), 5);
    assert.deepEqual(lv.heard, [[LVN_ITEMCHANGED, -1, LVIS_SELECTED, 0]]);
});

test('LVM_DELETEALLITEMS asks once, and tells each item only when not answered TRUE', async()=>{
    const lv = listview(LVS_REPORT, code=>(code === LVN_DELETEALLITEMS ? 1 : 0));
    await lv.send(LVM.INSERTITEMA, 0, lv.item(LVIF_TEXT, 0, { text: 'a' }));
    await lv.send(LVM.INSERTITEMA, 1, lv.item(LVIF_TEXT, 1, { text: 'b' }));
    lv.heard.length = 0;
    await lv.send(LVM.DELETEALLITEMS, 0, 0);
    assert.deepEqual(lv.heard.map(h=>h[0]), [LVN_DELETEALLITEMS]);
    assert.equal(lv.send(LVM.GETITEMCOUNT, 0, 0), 0);

    const told = listview(LVS_REPORT);
    await told.send(LVM.INSERTITEMA, 0, told.item(LVIF_TEXT, 0, { text: 'a' }));
    told.heard.length = 0;
    await told.send(LVM.DELETEALLITEMS, 0, 0);
    assert.deepEqual(told.heard.map(h=>h[0]), [LVN_DELETEALLITEMS, LVN_DELETEITEM]);
});

test('a column keeps its title and width; the first is always left aligned', async()=>{
    const lv = listview(LVS_REPORT);
    lv.bytes.fill(0, BUFFER, BUFFER + LVCOLUMN.SIZE);
    lv.view.setUint32(BUFFER + LVCOLUMN.mask, LVCF_WIDTH | LVCF_TEXT | 0x0001, true);
    lv.view.setUint32(BUFFER + LVCOLUMN.fmt, 1, true);
    lv.view.setInt32(BUFFER + LVCOLUMN.cx, 80, true);
    lv.bytes.set(new TextEncoder().encode('Name\0'), TEXT);
    lv.view.setUint32(BUFFER + LVCOLUMN.pszText, TEXT, true);
    assert.equal(await lv.send(LVM.INSERTCOLUMNA, 0, BUFFER), 0);
    assert.equal(lv.send(LVM.GETCOLUMNWIDTH, 0, 0), 80);
    lv.view.setUint32(BUFFER + LVCOLUMN.pszText, TEXT + 0x80, true);
    lv.view.setUint32(BUFFER + LVCOLUMN.cchTextMax, 16, true);
    assert.equal(await lv.send(LVM.GETCOLUMNA, 0, BUFFER), 1);
    assert.equal(lv.string(TEXT + 0x80), 'Name');
    assert.equal(lv.view.getUint32(BUFFER + LVCOLUMN.fmt, true), 0);
});

test('a list view tells its custom draw with the context TRANSPARENT', async()=>{
    // Wine's listview test_customdraw_background: GetBkMode in the parent's
    // NM_CUSTOMDRAW is TRANSPARENT at every stage, whatever the text's colour.
    /** @type {string[]} */
    const order = [];
    const lv = listview(LVS_REPORT, code=>{
        order.push(`notify ${code}`);
        return 0;
    }, (/** @type {number} */ hdc, /** @type {number} */ mode)=>{
        order.push(`mode ${hdc.toString(16)} ${mode}`);
        return 2;
    });
    await lv.send(0x000f, 0, 0);
    assert.deepEqual(order.slice(0, 2), ['mode 99 1', 'notify -12'],
        'TRANSPARENT before NM_CUSTOMDRAW\'s first stage');
});

test('LVM_SUBITEMHITTEST in the report view finds the column, and counts rows as Windows does',
    async()=>{
        const lv = listview(LVS_REPORT);
        for (const index of [0, 1])
        {
            lv.bytes.fill(0, BUFFER, BUFFER + LVCOLUMN.SIZE);
            lv.view.setUint32(BUFFER + LVCOLUMN.mask, LVCF_WIDTH, true);
            lv.view.setInt32(BUFFER + LVCOLUMN.cx, 100, true);
            await lv.send(LVM.INSERTCOLUMNA, index, BUFFER);
        }
        await lv.send(LVM.INSERTITEMA, 0, lv.item(LVIF_TEXT, 0, { text: 'one' }));
        const rect = 0x10600;
        lv.view.setInt32(rect, 0, true);
        lv.send(LVM.GETITEMRECT, 0, rect);
        const height = lv.view.getInt32(rect + 12, true) - lv.view.getInt32(rect + 4, true);
        const HITINFO = 0x10700;
        /** @param {number} message @param {number} x @param {number} y */
        const hit = (message, x, y)=>{
            lv.view.setInt32(HITINFO, x, true);
            lv.view.setInt32(HITINFO + 4, y, true);
            lv.view.setInt32(HITINFO + 16, 10, true);
            const index = lv.send(message, 0, HITINFO);
            return [index, lv.view.getInt32(HITINFO + 12, true),
                lv.view.getInt32(HITINFO + 16, true), lv.view.getUint32(HITINFO + 8, true)];
        };
        const middle = height >> 1;
        assert.deepEqual(hit(LVM.SUBITEMHITTEST, 150, middle), [0, 0, 1, 0x4], 'the second column');
        assert.deepEqual(hit(LVM.SUBITEMHITTEST, 250, middle), [-1, -1, -1, 0x1], 'past them');
        assert.deepEqual(hit(LVM.SUBITEMHITTEST, -1, middle), [-1, -1, -1, 0x1], 'before them');
        assert.deepEqual(hit(LVM.SUBITEMHITTEST, 150, -height), [-1, -1, 1, 0x1],
            'the row above the first is no item, its column still told');
        assert.deepEqual(hit(LVM.SUBITEMHITTEST, 150, -2 * height), [-2, -2, 1, 0x4],
            'further up the index goes negative');
        assert.deepEqual(hit(LVM.SUBITEMHITTEST, 150, 3 * height), [-1, -1, 1, 0x1], 'below');
        assert.deepEqual(hit(LVM.HITTEST, 150, middle), [-1, -1, 10, 0x1],
            'LVM_HITTEST: the item is its first column, the subitem untouched');
        lv.send(LVM.SETEXTENDEDLISTVIEWSTYLE, 0, 0x20);
        assert.deepEqual(hit(LVM.HITTEST, 150, middle), [0, 0, 10, 0xe],
            'a full row answers the whole item');
        assert.deepEqual(hit(LVM.HITTEST, 50, middle), [0, 0, 10, 0x4],
            'its first column still its part');
    });
