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
import { setupBars as setupWith, OUT, ITEM, TEXT } from './bars.fixture.js';
import {
    TOOLBAR_CLASS, TBSTATE_ENABLED, TBSTATE_WRAP, TBSTYLE_SEP, TBSTYLE_CHECKGROUP,
    TBSTYLE_GROUP, TBSTYLE_FLAT, TBSTYLE_WRAPABLE, TB_BUTTONSTRUCTSIZE, TB_GETIMAGELIST,
    TB_SETBITMAPSIZE, TB_SETBUTTONSIZE, TB_GETBUTTONSIZE, TB_ADDBITMAP, TB_ADDBUTTONSA,
    TB_INSERTBUTTONA, TB_DELETEBUTTON, TB_GETBUTTON, TB_GETITEMRECT, TB_ISBUTTONCHECKED,
    TB_ISBUTTONHIDDEN, TB_CHECKBUTTON, TB_SETIMAGELIST, TB_ADDSTRINGA, TB_SETPADDING,
    TB_GETPADDING, TB_GETHOTITEM, TB_SETHOTITEM, TB_SETSTYLE, TB_GETSTYLE,
    TBN_HOTITEMCHANGE, TBN_GETINFOTIPA,
} from './toolbar.js';

/**
 * The expectations are what Wine's toolbar tests (test_add_bitmap,
 * test_sizes, test_hotitem, test_recalc, test_WM_NOTIFY, basic_test)
 * record Windows answering.
 */

const setupBars = ()=>setupWith({ createGdiDrawing, createScreen, ...surfaces });

const WM_NOTIFY = 0x004e;
const HINST_COMMCTRL = 0xffffffff;
const IDB_STD_SMALL_COLOR = 0;
const CBEN_ENDEDITA = -805 >>> 0;
const CBEN_ENDEDITW = -806 >>> 0;
const TTN_GETDISPINFOW = -530 >>> 0;
const TTN_GETDISPINFOA = -520 >>> 0;

/** @param {number} x @param {number} y */
const pair = (x, y)=>((y & 0xffff) << 16 | x & 0xffff) >>> 0;

/** A plain toolbar, as Wine's rebuild_toolbar makes one. */
const plain = async(style = 0)=>{
    const context = setupBars();
    await context.makeParent();
    const hwnd = await context.control(TOOLBAR_CLASS, style, [0, 0, 0, 0]);
    context.send([hwnd, TB_BUTTONSTRUCTSIZE, 20, 0]);
    /** @param {number} width  A bitmap of 15 rows, blank. */
    const bitmap = width=>context.bitmap(width, 15, ()=>0x00c0c0c0);
    /** @param {number} count @param {number} handle */
    const add = (count, handle)=>{
        context.memory.put32s(ITEM, [0, handle]);
        return context.send([hwnd, TB_ADDBITMAP, count, ITEM]) | 0;
    };
    /** The image list's count and image size. */
    const list = ()=>{
        const himl = context.send([hwnd, TB_GETIMAGELIST, 0, 0]);
        context.lists.ImageList_GetIconSize.handler([himl, OUT, OUT + 4]);
        return [context.lists.ImageList_GetImageCount.handler([himl]),
            context.memory.i32(OUT), context.memory.i32(OUT + 4)];
    };
    const size = ()=>{
        const answer = context.send([hwnd, TB_GETBUTTONSIZE, 0, 0]);
        return [answer & 0xffff, answer >>> 16];
    };
    /**
     * @param {{ command: number, state?: number, style?: number, string?: number }[]} made
     * @param {number} [at]  where TB_INSERTBUTTON puts the first
     */
    const buttons = (made, at)=>{
        for (const button of made)
        {
            context.memory.bytes.fill(0, ITEM + 0x40, ITEM + 0x54);
            context.memory.put32s(ITEM + 0x40, [0, button.command]);
            context.memory.bytes[ITEM + 0x48] = button.state ?? TBSTATE_ENABLED;
            context.memory.bytes[ITEM + 0x49] = button.style ?? 0;
            context.memory.put32s(ITEM + 0x50, [button.string ?? -1]);
            context.send(at === undefined ? [hwnd, TB_ADDBUTTONSA, 1, ITEM + 0x40]
                : [hwnd, TB_INSERTBUTTONA, at, ITEM + 0x40]);
        }
    };
    return { context, hwnd, bitmap, add, list, size, buttons };
};

test('TB_ADDBITMAP answers the counts declared before; the list holds what each bitmap gives',
    async()=>{
        {
            const { add, list, bitmap } = await plain();
            const wide = bitmap(128);
            const narrow = bitmap(80);
            assert.equal(add(8, wide), 0);
            assert.deepEqual(list(), [8, 16, 16], 'sixteen pixels square at first');
            assert.equal(add(5, narrow), 8);
            assert.equal(add(8, wide), 0, 'a bitmap added again answers where it went');
            assert.equal(add(55, narrow), 8);
            assert.deepEqual(list(), [13, 16, 16]);
        }
        {
            const { add, list, bitmap } = await plain();
            assert.equal(add(3, bitmap(128)), 0);
            assert.deepEqual(list(), [8, 16, 16], 'all of a bitmap, more than declared');
            assert.equal(add(5, bitmap(80)), 3, 'the declared count, not the images');
        }
        {
            const { add, list, bitmap } = await plain();
            assert.equal(add(-143, bitmap(128)), 0);
            assert.equal(add(1, bitmap(80)), -143);
            assert.deepEqual(list(), [13, 16, 16]);
        }
        {
            const { add, list, bitmap } = await plain();
            assert.equal(add(0, bitmap(80)), 0);
            assert.deepEqual(list(), [1, 16, 16], 'a count of zero takes the first image');
        }
        {
            const { add, list, bitmap } = await plain();
            assert.equal(add(100, bitmap(80)), 0);
            assert.deepEqual(list(), [100, 16, 16], 'blank images up to the count');
        }
    });

test('TB_SETBITMAPSIZE makes the own list again at the size; -1 keeps a side, 0 is 1', async()=>{
    const { context, hwnd, add, list, bitmap, size } = await plain();
    add(5, bitmap(128));
    add(3, bitmap(80));
    assert.deepEqual(list(), [13, 16, 16]);
    assert.equal(context.send([hwnd, TB_SETBITMAPSIZE, 0, pair(30, 30)]), 1);
    assert.deepEqual(list(), [8, 30, 30], 'four become the five declared, two the three');
    assert.deepEqual(size(), [37, 36], 'the buttons the images and their padding');
    context.send([hwnd, TB_SETBITMAPSIZE, 0, pair(0, 0)]);
    assert.deepEqual(list(), [208, 1, 1]);
    context.send([hwnd, TB_SETBITMAPSIZE, 0, pair(5, 0xffff)]);
    assert.deepEqual(list(), [41, 5, 1]);

    // A standard strip sets the size to its own.
    context.memory.put32s(ITEM, [HINST_COMMCTRL, IDB_STD_SMALL_COLOR]);
    assert.equal(context.send([hwnd, TB_ADDBITMAP, 1, ITEM]), 8);
    assert.deepEqual(list(), [8 + 5 + 15, 16, 16]);
});

test('a list the program hands over keeps its size; the buttons follow the images', async()=>{
    const { context, hwnd, add, list, bitmap, size } = await plain();
    const himl = context.lists.ImageList_Create.handler([20, 15, 0x21, 4, 4]);
    context.lists.ImageList_SetImageCount.handler([himl, 4]);
    assert.equal(context.send([hwnd, TB_SETIMAGELIST, 0, himl]), 0);
    assert.equal(add(1, bitmap(128)), 0);
    assert.deepEqual(list(), [10, 20, 15]);
    context.send([hwnd, TB_SETBITMAPSIZE, 0, pair(8, 8)]);
    assert.deepEqual(size(), [15, 14]);
    assert.deepEqual(list(), [10, 20, 15], 'the list as it was');
});

test('a button is the image and its padding, larger as asked, never smaller', async()=>{
    const { context, hwnd, size, buttons } = await plain();
    assert.deepEqual(size(), [23, 22]);
    assert.equal(context.send([hwnd, TB_GETPADDING, 0, 0]), pair(7, 6));
    for (const [asked, got] of [[[22, 21], [23, 22]], [[5, 100], [23, 100]], [[3, 3], [23, 22]]])
    {
        assert.equal(context.send([hwnd, TB_SETBUTTONSIZE, 0, pair(asked[0], asked[1])]), 1);
        assert.deepEqual(size(), got, `asked ${asked}`);
    }
    context.memory.putString(TEXT, 'A');
    context.memory.putString(TEXT + 2, 'MMMMMMMMMMMMM');
    context.memory.bytes[TEXT + 16] = 0;
    context.send([hwnd, TB_ADDSTRINGA, 0, TEXT]);
    const [, tall] = size();
    assert.ok(tall > 22, 'a text row under the image once there are strings');
    buttons([{ command: 20 }]);
    assert.deepEqual(size(), [23, 22], 'a button with no text: no row');
    buttons([{ command: 30, string: 1 }]);
    const [wide] = size();
    assert.ok(wide > 23, 'as wide as the widest text');
    assert.equal(context.send([hwnd, TB_SETPADDING, 0, pair(1, 1)]), pair(7, 6));
    context.send([hwnd, TB_SETBUTTONSIZE, 0, pair(3, 3)]);
    assert.deepEqual(size(), [17, 17]);

    context.send([hwnd, TB_SETIMAGELIST, 0, 0]);
    context.send([hwnd, TB_SETBUTTONSIZE, 0, pair(1, 1)]);
    assert.deepEqual(size(), [2, 2], 'no list is images of a pixel');
});

test('hot items: set and cleared, refused by the owner, none on a disabled button', async()=>{
    const { context, hwnd, buttons } = await plain(TBSTYLE_FLAT);
    buttons([{ command: 1 }, { command: 3 }, { command: 5, style: TBSTYLE_SEP },
        { command: 7 }, { command: 9, state: 0 }]);
    /** @type {number[][]} */
    const heard = [];
    let refuse = false;
    context.answerParent(message=>{
        if (message.message === WM_NOTIFY
            && context.memory.u32(message.lParam + 8) === TBN_HOTITEMCHANGE)
        {
            heard.push([context.memory.i32(message.lParam + 12),
                context.memory.i32(message.lParam + 16)]);
            return refuse ? 1 : 0;
        }
        return undefined;
    });
    const hot = (/** @type {number} */ index)=>context.send([hwnd, TB_SETHOTITEM, index, 0]) | 0;
    assert.equal(context.send([hwnd, TB_GETHOTITEM, 0, 0]) | 0, -1);
    assert.equal(hot(1), -1);
    assert.equal(hot(0xbeef), 1, 'past the buttons: ignored');
    assert.equal(context.send([hwnd, TB_GETHOTITEM, 0, 0]), 1);
    assert.equal(hot(3), 1);
    refuse = true;
    assert.equal(hot(0), 3);
    assert.equal(context.send([hwnd, TB_GETHOTITEM, 0, 0]), 3, 'the owner kept it');
    refuse = false;
    heard.length = 0;
    assert.equal(hot(3), 3);
    assert.deepEqual(heard, [], 'the same item: no news');
    assert.equal(hot(4), 3);
    assert.deepEqual(heard, [[7, 9]], 'told, by command ids');
    assert.equal(context.send([hwnd, TB_GETHOTITEM, 0, 0]) | 0, -1, 'a disabled one is not hot');
    hot(1);
    context.send([hwnd, TB_DELETEBUTTON, 1, 0]);
    assert.equal(context.send([hwnd, TB_GETHOTITEM, 0, 0]) | 0, -1, 'gone with its button');

    const raised = await plain();
    raised.buttons([{ command: 1 }]);
    assert.equal(raised.context.send([raised.hwnd, TB_SETHOTITEM, 0, 0]) | 0, -1);
    assert.equal(raised.context.send([raised.hwnd, TB_GETHOTITEM, 0, 0]) | 0, -1,
        'version 5 has hot items only on a flat toolbar');
});

test('a check group runs over a separator in it; an unknown command is -1', async()=>{
    const { context, hwnd, buttons } = await plain();
    buttons([{ command: 1000, style: TBSTYLE_CHECKGROUP }, { command: 1001,
        style: TBSTYLE_SEP | TBSTYLE_GROUP }, { command: 1002, style: TBSTYLE_CHECKGROUP },
    { command: 1003, style: TBSTYLE_SEP }, { command: 1004, style: TBSTYLE_CHECKGROUP }]);
    context.send([hwnd, TB_CHECKBUTTON, 1000, 1]);
    context.send([hwnd, TB_CHECKBUTTON, 1004, 1]);
    context.send([hwnd, TB_CHECKBUTTON, 1002, 1]);
    assert.deepEqual([1000, 1002, 1004].map(id=>context.send([hwnd, TB_ISBUTTONCHECKED, id, 0])
        ? 1 : 0), [0, 1, 1], 'the group ends at the plain separator');
    assert.equal(context.send([hwnd, TB_ISBUTTONHIDDEN, 0xdeadbeef, 0]) | 0, -1);
});

test('a flat toolbar sized again has no top margin; TBSTYLE_WRAPABLE drops TBSTATE_WRAP',
    async()=>{
        const { context, hwnd, buttons } = await plain();
        buttons([{ command: 1, state: TBSTATE_ENABLED | TBSTATE_WRAP }, { command: 2 }]);
        const top = ()=>{
            context.send([hwnd, TB_GETITEMRECT, 1, OUT]);
            return context.memory.i32(OUT + 4);
        };
        const style = context.send([hwnd, TB_GETSTYLE, 0, 0]);
        context.send([hwnd, TB_SETSTYLE, 0, style | TBSTYLE_FLAT]);
        assert.ok(top() > 0, 'a second row, under the margin');
        context.send([hwnd, TB_SETSTYLE, 0, style | TBSTYLE_FLAT | TBSTYLE_WRAPABLE]);
        assert.equal(top(), 0, 'sized again: one row, no margin');
        context.send([hwnd, TB_GETBUTTON, 0, OUT]);
        assert.equal(context.memory.bytes[OUT + 8], TBSTATE_ENABLED);
    });

test('a WM_NOTIFY it is sent goes to its owner; CBEN_ENDEDITW as ANSI to an ANSI owner',
    async()=>{
        const { context, hwnd } = await plain();
        /** @type {any[]} */
        const heard = [];
        context.answerParent(message=>{
            if (message.message === WM_NOTIFY)
            {
                const code = context.memory.u32(message.lParam + 8);
                heard.push({ code, wParam: message.wParam,
                    text: code === CBEN_ENDEDITA ? context.memory.readCString(message.lParam + 20,
                        260) : null,
                    why: code === CBEN_ENDEDITA ? context.memory.i32(message.lParam + 280)
                        : null });
                if (code === TBN_GETINFOTIPA)
                {
                    context.memory.putString(context.memory.u32(message.lParam + 12), 'tip');
                }
                return 7;
            }
            return undefined;
        });
        const note = 0x13a00;
        context.memory.bytes.fill(0, note, note + 600);
        context.memory.put32s(note, [0xabcd0001, 0xabcd0002, CBEN_ENDEDITW, 3, 4]);
        context.memory.putWide(note + 20, 'Lorem');
        context.memory.put32s(note + 20 + 520, [5]);
        assert.equal(await context.send([hwnd, WM_NOTIFY, 0, note]), 7);
        assert.deepEqual(heard, [{ code: CBEN_ENDEDITA, wParam: 0xabcd0002, text: 'Lorem',
            why: 5 }]);

        heard.length = 0;
        context.memory.bytes.fill(0, note, note + 600);
        context.memory.put32s(note, [0, 21, TTN_GETDISPINFOW]);
        await context.send([hwnd, WM_NOTIFY, 0, note]);
        assert.deepEqual(heard.map(entry=>entry.code), [TBN_GETINFOTIPA, TTN_GETDISPINFOA],
            'the tip asked of the owner, then the tooltip\'s request in its encoding');
        assert.equal(context.memory.u32(note + 12), note + 16);
        assert.equal(String.fromCharCode(context.memory.bytes[note + 16],
            context.memory.bytes[note + 18], context.memory.bytes[note + 20]), 'tip');
    });
