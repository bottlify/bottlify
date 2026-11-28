/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGdiDrawing } from '../../graphics/gdi/context.js';
import * as surfaces from '../../graphics/gdi/surface.js';
import { createScreen } from '../../graphics/gdi/screen.js';
import { setupBars as setupWith, OUT, TEXT } from './bars.fixture.js';
import {
    COMBOBOXEX_CLASS, CBEM_INSERTITEMA, CBEM_GETITEMA, CBEM_SETITEMA, CBEM_DELETEITEM,
    CBEM_GETCOMBOCONTROL, CBEM_GETEDITCONTROL, CBEM_SETEXTENDEDSTYLE, CBEM_GETEXTENDEDSTYLE,
    CBEM_SETEXSTYLE, CB_GETLBTEXT, CB_GETLBTEXTLEN, CB_GETITEMDATA, CB_SETITEMDATA, CB_SETCURSEL,
    CB_GETCURSEL, CB_FINDSTRINGEXACT, CBEIF_TEXT, CBEIF_IMAGE, CBEIF_INDENT, CBEIF_LPARAM,
    CBEIF_DI_SETITEM, CBEN_GETDISPINFOA, CBEN_INSERTITEM, CBEN_DELETEITEM, CBEN_ENDEDITA,
    CBENF_DROPDOWN, CBES_EX_CASESENSITIVE, createComboBoxExProcedure,
} from './comboex.js';
import { HIGH, wideControl } from './wide.fixture.js';

/**
 * The expectations are the extended combo box's documented contract and
 * what Wine's conformance tests (combo.c, its test_comboex_* part) record
 * Windows answering.
 */

const setupBars = ()=>setupWith({ createGdiDrawing, createScreen, ...surfaces });

const WM_NOTIFY = 0x004e;
const WM_COMMAND = 0x0111;
const WM_GETTEXT = 0x000d;
const WM_WINDOWPOSCHANGING = 0x0046;
const WM_DRAWITEM = 0x002b;
const COLOR_HIGHLIGHT = 13;
const CB_SHOWDROPDOWN = 0x014f;
const CB_RESETCONTENT = 0x014b;
const CBS_DROPDOWN = 0x0002;
const CBS_DROPDOWNLIST = 0x0003;
const WS_BORDER = 0x00800000;
const ITEM = 0x13600;
const STRINGS = 0x13700;
const BUFFER = 0x13900;

/** COMBOBOXEXITEMA's offsets, 32-bit. */
const F = { mask: 0, iItem: 4, pszText: 8, cchTextMax: 12, iImage: 16, iSelectedImage: 20,
    iOverlay: 24, iIndent: 28, lParam: 32 };

/** @param {number} [style] */
const comboEx = async(style = CBS_DROPDOWN)=>{
    const context = setupBars();
    await context.makeParent(320, 240);
    const hwnd = await context.control(COMBOBOXEX_CLASS, WS_BORDER | style, [0, 0, 300, 300]);
    assert.notEqual(hwnd, 0, 'ComboBoxEx32 is a class of its own');
    /** @param {number[]} args */
    const send = args=>context.send(args);
    /**
     * A COMBOBOXEXITEMA at ITEM.
     *
     * @param {number} mask @param {number} index
     * @param {Record<string, number | string | null>} [fields]
     */
    const item = (mask, index, fields = {})=>{
        context.memory.bytes.fill(0, ITEM, ITEM + 36);
        context.memory.put32s(ITEM + F.mask, [mask]);
        context.memory.put32s(ITEM + F.iItem, [index]);
        for (const [name, value] of Object.entries(fields))
        {
            if (typeof value === 'string')
            {
                const at = STRINGS + 0x40 * (Object.keys(fields).indexOf(name) + 1);
                context.memory.putString(at, value);
                context.memory.put32s(ITEM + F.pszText, [at]);
            }
            else if (value === null)
            {
                context.memory.put32s(ITEM + F.pszText, [0]);
            }
            else
            {
                context.memory.put32s(ITEM + /** @type {any} */ (F)[name], [value]);
            }
        }
        return ITEM;
    };
    /** @param {number} index @param {string | null} text */
    const add = (index, text)=>
        send([hwnd, CBEM_INSERTITEMA, 0, item(CBEIF_TEXT, index, { pszText: text })]);
    /** @param {number} index */
    const textOf = index=>{
        context.memory.bytes.fill(0x55, BUFFER, BUFFER + 100);
        const at = item(CBEIF_TEXT, index, { pszText: 0, cchTextMax: 100 });
        context.memory.put32s(at + F.pszText, [BUFFER]);
        const answer = send([hwnd, CBEM_GETITEMA, 0, at]);
        return answer === 0 ? null : context.memory.readCString(BUFFER, 100);
    };
    return { context, hwnd, send, item, add, textOf };
};

test('items go in at their index, the end for -1, nowhere past the end', async()=>{
    const { send, hwnd, add, textOf, item } = await comboEx();
    assert.equal(add(-1, 'First Item'), 0);
    assert.equal(add(-1, 'Second Item'), 1);
    assert.equal(add(2, 'Third Item'), 2);
    assert.equal(add(1, 'Between'), 1);
    assert.equal(add(99, 'Out'), -1);
    assert.equal(add(5, 'Out'), -1);
    assert.deepEqual([0, 1, 2, 3].map(textOf), ['First Item', 'Between', 'Second Item',
        'Third Item']);
    assert.equal(textOf(4), null);
    assert.equal(textOf(-2), null);

    assert.equal(send([hwnd, CBEM_SETITEMA, 0, item(CBEIF_TEXT, 4, { pszText: 'X' })]), 0);
    assert.equal(send([hwnd, CBEM_SETITEMA, 0, item(CBEIF_TEXT, 0, { pszText: 'New' })]), 1);
    assert.equal(textOf(0), 'New');

    assert.equal(send([hwnd, CBEM_DELETEITEM, -1, 0]), -1);
    assert.equal(send([hwnd, CBEM_DELETEITEM, 4, 0]), -1);
    assert.deepEqual([3, 0, 0, 0].map(index=>send([hwnd, CBEM_DELETEITEM, index, 0])),
        [3, 2, 1, 0], 'the items left');
    assert.equal(send([hwnd, CBEM_DELETEITEM, 0, 0]), -1);
});

test('the parent hears of items inserted and deleted', async()=>{
    const { context, hwnd, add, send } = await comboEx();
    /** @type {number[]} */
    const codes = [];
    context.answerParent(message=>{
        if (message.message === WM_NOTIFY)
        {
            codes.push(context.memory.u32(message.lParam + 8));
        }
        return undefined;
    });
    add(-1, 'one');
    send([hwnd, CBEM_DELETEITEM, 0, 0]);
    assert.deepEqual(codes, [CBEN_INSERTITEM, CBEN_DELETEITEM]);
    add(-1, 'two');
    add(-1, 'three');
    codes.length = 0;
    send([hwnd, CB_RESETCONTENT, 0, 0]);
    assert.deepEqual(codes, [CBEN_DELETEITEM, CBEN_DELETEITEM], 'emptied, one by one');
    assert.equal(send([hwnd, CB_GETLBTEXTLEN, 0, 0]), -1);
});

test('an item\'s text, value and the combo box\'s messages about items are the box\'s own',
    async()=>{
        const { context, hwnd, add, send } = await comboEx();
        add(-1, null);
        add(-1, 'Beta');
        context.memory.bytes[BUFFER] = 0x61;
        assert.equal(send([hwnd, CB_GETLBTEXT, 0, BUFFER]), 0);
        assert.equal(context.memory.bytes[BUFFER], 0, 'no text is the empty string');
        assert.equal(send([hwnd, CB_GETLBTEXTLEN, 1, 0]), 4);
        assert.equal(send([hwnd, CB_GETLBTEXT, 1, BUFFER]), 4);
        assert.equal(context.memory.readCString(BUFFER, 10), 'Beta');
        assert.equal(send([hwnd, CB_GETLBTEXT, 2, BUFFER]), -1);

        assert.equal(send([hwnd, CB_SETITEMDATA, 1, 0x1abe11ed]), 1);
        assert.equal(send([hwnd, CB_GETITEMDATA, 1, 0]) >>> 0, 0x1abe11ed);
        assert.equal(send([hwnd, CB_GETITEMDATA, 5, 0]), -1);

        context.memory.putString(TEXT, 'beta');
        assert.equal(send([hwnd, CB_FINDSTRINGEXACT, -1, TEXT]), 1, 'without case');
        send([hwnd, CBEM_SETEXTENDEDSTYLE, 0, CBES_EX_CASESENSITIVE]);
        assert.equal(send([hwnd, CB_FINDSTRINGEXACT, -1, TEXT]), -1, 'with it');
        assert.equal(send([hwnd, CBEM_SETEXSTYLE, 0, 0]), CBES_EX_CASESENSITIVE);
        assert.equal(send([hwnd, CBEM_GETEXTENDEDSTYLE, 0, 0]), 0);

        assert.equal(send([hwnd, CB_SETCURSEL, 1, 0]), 1, 'handed to the combo box');
        assert.equal(send([hwnd, CB_GETCURSEL, 0, 0]), 1);
    });

test('it is as tall as its combo box\'s field, whatever it is given', async()=>{
    const { context, hwnd, send } = await comboEx();
    const combo = send([hwnd, CBEM_GETCOMBOCONTROL, 0, 0]);
    assert.notEqual(combo, 0);
    assert.notEqual(send([hwnd, CBEM_GETEDITCONTROL, 0, 0]), 0, 'a drop-down has an edit');
    const outer = context.windowRect(hwnd);
    const inner = context.windowRect(combo);
    const height = outer.bottom - outer.top;
    assert.equal(height, inner.bottom - inner.top + 2, 'the field in a border');
    for (const asked of [height * 2, Math.floor(height / 2)])
    {
        context.memory.put32s(OUT, [hwnd, 0, 0, 0, 300, asked, 0]);
        assert.equal(send([hwnd, WM_WINDOWPOSCHANGING, 0, OUT]), 0);
        assert.equal(context.memory.i32(OUT + 20), height);
    }

    const list = await comboEx(CBS_DROPDOWNLIST);
    assert.equal(list.send([list.hwnd, CBEM_GETEDITCONTROL, 0, 0]), 0, 'a list has none');
});

test('item -1 is the edit: setting its text puts it there, and its value is kept',
    async()=>{
        const { context, hwnd, send, item } = await comboEx();
        assert.equal(send([hwnd, CBEM_SETITEMA, 0, item(CBEIF_TEXT, -1, { pszText: 'test' })]),
            1);
        const edit = send([hwnd, CBEM_GETEDITCONTROL, 0, 0]);
        context.send([edit, WM_GETTEXT, 100, BUFFER]);
        assert.equal(context.memory.readCString(BUFFER, 100), 'test');

        assert.equal(send([hwnd, CBEM_GETITEMA, 0, item(CBEIF_LPARAM, -1, { lParam: 7 })]), 1);
        assert.equal(context.memory.u32(ITEM + F.lParam), 0);
        send([hwnd, CBEM_SETITEMA, 0, item(CBEIF_LPARAM, -1, { lParam: 0x1abe11ed })]);
        send([hwnd, CBEM_GETITEMA, 0, item(CBEIF_LPARAM, -1)]);
        assert.equal(context.memory.u32(ITEM + F.lParam), 0x1abe11ed);
    });

test('a field left to the parent is asked for, and kept when the parent says so', async()=>{
    const { context, hwnd, send, item } = await comboEx();
    /** @type {number[]} */
    const masks = [];
    let keep = false;
    context.answerParent(message=>{
        if (message.message === WM_NOTIFY
            && context.memory.u32(message.lParam + 8) === CBEN_GETDISPINFOA)
        {
            const at = message.lParam + 12;
            const mask = context.memory.u32(at + F.mask);
            masks.push(mask);
            if (mask & CBEIF_TEXT)
            {
                assert.notEqual(context.memory.u32(at + F.pszText), 0, 'a buffer to fill');
                assert.equal(context.memory.u32(at + F.cchTextMax), 0);
                context.memory.putString(context.memory.u32(at + F.pszText), 'given');
            }
            if (mask & CBEIF_IMAGE)
            {
                context.memory.put32s(at + F.iImage, [123]);
            }
            if (keep)
            {
                context.memory.put32s(at + F.mask, [mask | CBEIF_DI_SETITEM]);
            }
            return 0;
        }
        return undefined;
    });
    send([hwnd, CBEM_INSERTITEMA, 0, item(CBEIF_TEXT | CBEIF_IMAGE | CBEIF_INDENT, 0,
        { pszText: 0, iImage: -1, iIndent: -1 })]);
    context.memory.put32s(ITEM + F.pszText, [-1]);
    send([hwnd, CBEM_SETITEMA, 0, ITEM]);
    assert.equal(send([hwnd, CBEM_GETITEMA, 0, item(CBEIF_IMAGE, 0)]), 1);
    assert.equal(context.memory.i32(ITEM + F.iImage), 123);
    assert.deepEqual(masks, [CBEIF_IMAGE], 'only what was asked and left to it');

    context.memory.put32s(BUFFER, [0]);
    send([hwnd, CBEM_GETITEMA, 0, item(CBEIF_TEXT, 0, { cchTextMax: 50 })]);
    context.memory.put32s(ITEM + F.pszText, [BUFFER]);
    send([hwnd, CBEM_GETITEMA, 0, ITEM]);
    assert.equal(context.memory.readCString(BUFFER, 50), 'given');

    keep = true;
    masks.length = 0;
    send([hwnd, CBEM_GETITEMA, 0, item(CBEIF_IMAGE, 0)]);
    send([hwnd, CBEM_GETITEMA, 0, item(CBEIF_IMAGE | CBEIF_INDENT, 0)]);
    assert.deepEqual(masks, [CBEIF_IMAGE, CBEIF_INDENT], 'the image kept, the indent still asked');
});

test('the list dropping ends an edit, and the combo box\'s news is the box\'s', async()=>{
    const { context, hwnd, send, add } = await comboEx();
    add(-1, '');
    add(-1, 'Two');
    /** @type {any[]} */
    const heard = [];
    context.answerParent(message=>{
        if (message.message === WM_NOTIFY
            && context.memory.u32(message.lParam + 8) === CBEN_ENDEDITA)
        {
            heard.push({ why: context.memory.i32(message.lParam + 12 + 8 + 260),
                selection: context.memory.i32(message.lParam + 16),
                text: context.memory.readCString(message.lParam + 20, 260) });
        }
        if (message.message === WM_COMMAND)
        {
            heard.push({ command: message.wParam >>> 16, from: message.lParam });
        }
        return undefined;
    });
    send([hwnd, CB_SETCURSEL, 1, 0]);
    await send([hwnd, CB_SHOWDROPDOWN, 1, 0]);
    assert.deepEqual(heard[0], { why: CBENF_DROPDOWN, selection: 1, text: 'Two' });
    assert.ok(heard.length > 1 && heard.slice(1).every(entry=>entry.from === hwnd),
        'told as the extended box\'s, not its combo box\'s');
});

test('an item the combo box asks it to draw is drawn, highlighted when selected', async()=>{
    const { context, hwnd, add } = await comboEx();
    add(-1, 'One');
    const combo = context.send([hwnd, CBEM_GETCOMBOCONTROL, 0, 0]);
    const hdc = context.fns.GetDC.handler([hwnd]);
    const ODS_SELECTED = 1;
    // DRAWITEMSTRUCT: CtlType, CtlID, itemID, itemAction, itemState, hwndItem,
    // hDC, rcItem and itemData.
    context.memory.put32s(OUT, [3, 7, 0, 1, ODS_SELECTED, combo, hdc, 0, 0, 60, 12, 0]);
    assert.equal(context.send([hwnd, WM_DRAWITEM, 7, OUT]), 1);
    context.fns.ReleaseDC.handler([hwnd, hdc]);
    const highlight = context.fns.GetSysColor.handler([COLOR_HIGHLIGHT]);
    assert.equal(context.pixel(hwnd, 58, 1) & 0xffffff, (highlight & 0xff) << 16
        | highlight & 0xff00 | highlight >>> 16 & 0xff, 'the highlight behind it');
});

/** COMBOBOXEXITEM's offsets in a 64-bit process. */
const ITEM64 = { iItem: 8, pszText: 16, cchTextMax: 24, lParam: 48, header: 24 };

test('in a 64-bit process an item\'s text, index and lParam are whole, both ways', async()=>{
    /** @type {number[]} */
    const told = [];
    const control = wideControl((host, tk)=>createComboBoxExProcedure(host, tk),
        (hwnd, message, wParam, lParam)=>{
            if (message === 0x004e && control.guest.u32(lParam + 16) === CBEN_INSERTITEM)
            {
                const at = lParam + ITEM64.header;
                told.push(control.guest.ptr(lParam), control.guest.iptr(at + ITEM64.iItem),
                    control.guest.iptr(at + ITEM64.lParam));
            }
            return undefined;
        });
    const { guest } = control;
    const item = 0x1000;
    guest.writeAnsi(HIGH + 0x100, 'one');
    guest.set32(item, CBEIF_TEXT | CBEIF_LPARAM);
    guest.setIptr(item + ITEM64.iItem, -1);
    guest.setPtr(item + ITEM64.pszText, HIGH + 0x100);
    guest.setIptr(item + ITEM64.lParam, -0x1_2345_6789);
    assert.equal(await control.send(CBEM_INSERTITEMA, 0, item), 0);
    assert.deepEqual(told, [control.record.hwnd, 0, -0x1_2345_6789]);

    guest.fill(item, 0, 56);
    guest.set32(item, CBEIF_TEXT | CBEIF_LPARAM);
    guest.setPtr(item + ITEM64.pszText, HIGH + 0x200);
    guest.set32(item + ITEM64.cchTextMax, 32);
    await control.send(CBEM_GETITEMA, 0, item);
    assert.equal(guest.cstr(HIGH + 0x200), 'one', 'into the buffer past 4 GiB');
    assert.equal(guest.iptr(item + ITEM64.lParam), -0x1_2345_6789);
});

test('in a 64-bit process LPSTR_TEXTCALLBACK, all ones, asks the parent for the text',
    async()=>{
        const control = wideControl((host, tk)=>createComboBoxExProcedure(host, tk),
            (hwnd, message, wParam, lParam)=>{
                if (message === 0x004e && control.guest.u32(lParam + 16) === CBEN_GETDISPINFOA)
                {
                    const at = lParam + ITEM64.header;
                    control.guest.writeAnsi(control.guest.ptr(at + ITEM64.pszText), 'asked');
                }
                return undefined;
            });
        const { guest } = control;
        const item = 0x1000;
        guest.set32(item, CBEIF_TEXT);
        guest.setIptr(item + ITEM64.iItem, 0);
        guest.setIptr(item + ITEM64.pszText, -1);
        assert.equal(await control.send(CBEM_INSERTITEMA, 0, item), 0);
        guest.setPtr(item + ITEM64.pszText, HIGH + 0x200);
        guest.set32(item + ITEM64.cchTextMax, 32);
        await control.send(CBEM_GETITEMA, 0, item);
        assert.equal(guest.cstr(HIGH + 0x200), 'asked');
    });
