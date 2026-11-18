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
import { setupBars as setupWith, OUT, ITEM, HINSTANCE } from './bars.fixture.js';
import {
    PAGER_CLASS, PGS_HORZ, PGM_SETCHILD, PGM_SETPOS, PGM_GETPOS, PGN_CALCSIZE, WM_NOTIFY,
    WM_NOTIFYFORMAT, NF_QUERY, NF_REQUERY, NFR_ANSI, NFR_UNICODE,
} from './pager.js';

const setupBars = ()=>setupWith({ createGdiDrawing, createScreen, ...surfaces });

/** A Unicode buffer the program's notification points at. */
const WIDE = OUT + 0x100;
/** A string of the parent's own. */
const ANSWER = OUT + 0x300;

/**
 * A pager on a parent that answers WM_NOTIFYFORMAT with `format`, and
 * `onNotify` for what the parent does with a WM_NOTIFY.
 *
 * @param {number} format @param {(address: number, context: any) => void} [onNotify]
 * @param {number} [style]
 */
const pagerOn = async(format, onNotify = ()=>{}, style = 0)=>{
    const context = setupBars();
    await context.makeParent();
    context.answerParent((/** @type {any} */ message)=>{
        if (message.message === WM_NOTIFYFORMAT)
        {
            return format;
        }
        if (message.message === WM_NOTIFY)
        {
            onNotify(message.lParam >>> 0, context);
            return 0;
        }
        return undefined;
    });
    const hwnd = await context.control(PAGER_CLASS, style, [0, 0, 100, 40]);
    return { context, hwnd };
};

/** @param {ReturnType<typeof setupBars>} context @param {number} address @param {string} text */
const putWide = (context, address, text)=>{
    [...`${text}\0`].forEach((unit, at)=>{
        context.memory.bytes[address + at * 2] = unit.charCodeAt(0) & 0xff;
        context.memory.bytes[address + at * 2 + 1] = unit.charCodeAt(0) >>> 8;
    });
};

/** @param {ReturnType<typeof setupBars>} context @param {number} address */
const readWide = (context, address)=>{
    let text = '';
    for (let at = address; ; at += 2)
    {
        const unit = context.memory.bytes[at] | context.memory.bytes[at + 1] << 8;
        if (unit === 0)
        {
            return text;
        }
        text += String.fromCharCode(unit);
    }
};

/**
 * A notification from a child at ITEM: its NMHDR, then the words given.
 *
 * @param {ReturnType<typeof setupBars>} context @param {number} code @param {number[]} words
 */
const notification = (context, code, words)=>{
    context.memory.bytes.fill(0, ITEM, ITEM + 0x200);
    context.memory.put32s(ITEM, [0x1234, 1, code >>> 0, ...words]);
    return ITEM;
};

test('a pager asks its parent for the notify format, and tells its child Unicode', async()=>{
    const { context, hwnd } = await pagerOn(NFR_ANSI);
    assert.equal(await context.send([hwnd, WM_NOTIFYFORMAT, 0x1234, NF_QUERY]), NFR_UNICODE);
    context.sent.length = 0;
    assert.equal(await context.send([hwnd, WM_NOTIFYFORMAT, 0, NF_REQUERY]), NFR_ANSI);
    assert.deepEqual(context.sent.filter(message=>message.message === WM_NOTIFYFORMAT)
        .map(message=>[message.wParam, message.lParam]), [[hwnd, NF_QUERY]]);
});

test('to a Unicode parent a child\'s notification goes on as it is', async()=>{
    /** @type {number[]} */
    const seen = [];
    const { context, hwnd } = await pagerOn(NFR_UNICODE, address=>{
        seen.push(context.memory.i32(address + 8), context.memory.i32(address + 32));
    });
    putWide(context, WIDE, 'test');
    // LVN_GETDISPINFOW: LVITEMW's mask at 12, its text at 32.
    const item = notification(context, -177, [1, 0, 0, 0, 0, WIDE, 64]);
    await context.send([hwnd, WM_NOTIFY, 1, item]);
    assert.deepEqual(seen, [-177, WIDE]);
});

test('to an ANSI parent a text is handed over in the A form and what it wrote comes back',
    async()=>{
        /** @type {string[]} */
        const seen = [];
        const { context, hwnd } = await pagerOn(NFR_ANSI, address=>{
            const code = context.memory.i32(address + 8);
            const text = context.memory.u32(address + 32);
            if (text === 0)
            {
                seen.push(`${code} no text`);
                return;
            }
            seen.push(`${code} ${context.memory.readCString(text, 64)}`);
            // The parent answers in its own string.
            context.memory.putString(ANSWER, 'answer');
            context.memory.put32s(address + 32, [ANSWER]);
        });
        putWide(context, WIDE, 'test');
        // LVN_BEGINLABELEDITW: converted both ways.
        const item = notification(context, -175, [1, 0, 0, 0, 0, WIDE, 64]);
        await context.send([hwnd, WM_NOTIFY, 1, item]);
        assert.deepEqual(seen, ['-105 test']);
        assert.equal(context.memory.i32(item + 8), -105, 'the code stays the A one');
        assert.equal(context.memory.u32(item + 32), WIDE, 'the program\'s buffer again');
        assert.equal(readWide(context, WIDE), 'answer');
        // With the mask's text bit clear, the text is not there at all.
        const bare = notification(context, -175, [0, 0, 0, 0, 0, WIDE, 64]);
        await context.send([hwnd, WM_NOTIFY, 1, bare]);
        assert.equal(context.memory.u32(bare + 32), 0);
        assert.deepEqual(seen, ['-105 test', '-105 no text']);
    });

test('TTN_GETDISPINFO to an ANSI parent is a structure of its own, and a text the parent '
    + 'points at fills szText', async()=>{
    const { context, hwnd } = await pagerOn(NFR_ANSI, address=>{
        assert.equal(context.memory.i32(address + 8), -520);
        assert.equal(context.memory.u32(address + 12), address + 16, 'lpszText is szText');
        assert.equal(context.memory.readCString(address + 16, 80), 'in');
        context.memory.putString(ANSWER, 'from the parent');
        context.memory.put32s(address + 12, [ANSWER]);
    });
    const item = notification(context, -530, [0]);
    putWide(context, item + 16, 'in');
    await context.send([hwnd, WM_NOTIFY, 1, item]);
    assert.equal(context.memory.i32(item + 8), -530, 'the program\'s own is left its code');
    assert.equal(readWide(context, item + 16), 'from the parent');
    assert.equal(readWide(context, context.memory.u32(item + 12)), 'from the parent');
});

test('PGM_SETCHILD asks the parent how wide the child is and puts it at minus the position',
    async()=>{
        const { context, hwnd } = await pagerOn(NFR_UNICODE, (address, ctx)=>{
            if (ctx.memory.i32(address + 8) === PGN_CALCSIZE)
            {
                assert.equal(ctx.memory.i32(address + 12), 1, 'PGF_CALCWIDTH');
                ctx.memory.put32s(address + 16, [500]);
            }
        }, PGS_HORZ);
        context.memory.putString(OUT, 'Button');
        const child = await context.fns.CreateWindowExA.handler([0, OUT, 0, 0x50000000,
            0, 0, 30, 30, hwnd, 1, HINSTANCE, 0]);
        await context.send([hwnd, PGM_SETCHILD, 0, child]);
        assert.ok(context.sent.some(message=>message.message === WM_NOTIFY
            && context.memory.i32(message.lParam + 8) === PGN_CALCSIZE));
        await context.pump();
        const width = context.clientSize(hwnd).width;
        const placed = ()=>{
            const rect = context.windowRect(child);
            const pager = context.windowRect(hwnd);
            return [rect.left - pager.left, rect.right - rect.left];
        };
        assert.deepEqual(placed(), [0, 500]);
        await context.send([hwnd, PGM_SETPOS, 0, 100]);
        await context.pump();
        assert.equal(await context.send([hwnd, PGM_GETPOS, 0, 0]), 100);
        assert.deepEqual(placed(), [-100, 500]);
        // Not past the end.
        await context.send([hwnd, PGM_SETPOS, 0, 1000]);
        await context.pump();
        assert.equal(await context.send([hwnd, PGM_GETPOS, 0, 0]), 500 - width);
    });

test('a pager keeps no font', async()=>{
    const { context, hwnd } = await pagerOn(NFR_UNICODE);
    await context.send([hwnd, 0x0030, 0x1d0, 0]);
    assert.equal(await context.send([hwnd, 0x0031, 0, 0]), 0);
});
