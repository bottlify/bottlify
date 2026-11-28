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
import { setupBars as setupWith, OUT, ITEM } from './bars.fixture.js';
import {
    REBAR_CLASS, RB_INSERTBANDA, RB_DELETEBAND, RB_SETBANDINFOA, RB_GETBANDINFOA, RB_GETRECT,
    RB_GETBANDCOUNT, RB_GETROWCOUNT, RB_GETROWHEIGHT, RB_MAXIMIZEBAND, RB_MINIMIZEBAND,
    RB_SHOWBAND, RB_PUSHCHEVRON, RB_GETTEXTCOLOR, RB_GETBKCOLOR, RBN_HEIGHTCHANGE,
    RBN_CHEVRONPUSHED, RBBIM_STYLE, RBBIM_COLORS, RBBIM_TEXT, RBBIM_CHILD, RBBIM_CHILDSIZE,
    RBBIM_SIZE, RBBIM_IDEALSIZE, RBBIM_HEADERSIZE, RBBS_CHILDEDGE, RBBS_HIDDEN,
    RBBS_VARIABLEHEIGHT, RBBS_USECHEVRON, RBBS_NOGRIPPER, RBS_BANDBORDERS, CCS_VERT,
    CCS_NODIVIDER, createRebarProcedure,
} from './rebar.js';
import { HIGH, wideControl } from './wide.fixture.js';
import { TOOLBAR_CLASS } from './toolbar.js';

const setupBars = ()=>setupWith({ createGdiDrawing, createScreen, ...surfaces });

const WM_NOTIFY = 0x004e;
const WM_MEASUREITEM = 0x002c;
/** A REBARBANDINFOA of version 6, in the fixture's item buffer. */
const INFO = ITEM;
const INFO_SIZE = 80;
const FACE = 0x00c0c0c0;

/**
 * A REBARBANDINFOA at INFO: the mask and the fields it names, by offset.
 *
 * @param {ReturnType<typeof setupBars>} context @param {number} mask
 * @param {Record<number, number>} [fields]
 */
const info = (context, mask, fields = {})=>{
    context.memory.bytes.fill(0xdd, INFO, INFO + INFO_SIZE);
    context.memory.put32s(INFO, [INFO_SIZE, mask]);
    for (const [at, value] of Object.entries(fields))
    {
        context.memory.put32s(INFO + Number(at), [value]);
    }
    return INFO;
};

/** Field offsets of REBARBANDINFOA in a 32-bit process. */
const F = { fStyle: 8, clrFore: 12, clrBack: 16, lpText: 20, cch: 24, iImage: 28,
    hwndChild: 32, cxMinChild: 36, cyMinChild: 40, cx: 44, cyChild: 56, cyMaxChild: 60,
    cyIntegral: 64, cxIdeal: 68, cxHeader: 76 };

/**
 * A band of `cx` asking for a child of `cxMinChild` by `cyMinChild`, its
 * child a toolbar when `child` says so.
 *
 * @param {ReturnType<typeof setupBars>} context @param {number} hwnd
 * @param {{ cx: number, cxMinChild?: number, cyMinChild?: number, style?: number,
 *     child?: boolean, at?: number, ideal?: number }} band
 */
const insert = async(context, hwnd, band)=>{
    const child = band.child
        ? await context.fns.CreateWindowExA.handler([0, putName(context, TOOLBAR_CLASS), 0,
            0x50000004, 0, 0, 0, 0, hwnd, 5, 0x400000, 0])
        : 0;
    info(context, RBBIM_SIZE | RBBIM_CHILDSIZE | RBBIM_CHILD | RBBIM_STYLE | RBBIM_IDEALSIZE, {
        [F.cx]: band.cx, [F.cxMinChild]: band.cxMinChild ?? 0,
        [F.cyMinChild]: band.cyMinChild ?? 20, [F.hwndChild]: child, [F.fStyle]: band.style ?? 0,
        [F.cxIdeal]: band.ideal ?? 0 });
    assert.equal(await context.send([hwnd, RB_INSERTBANDA, band.at ?? -1, INFO]), 1);
    return child;
};

/** @param {ReturnType<typeof setupBars>} context @param {string} name */
const putName = (context, name)=>{
    context.memory.putString(OUT + 0x200, name);
    return OUT + 0x200;
};

/** RB_GETRECT's rectangle of a band. @param {ReturnType<typeof setupBars>} context */
const rectOf = async(context, /** @type {number} */ hwnd, /** @type {number} */ index)=>{
    assert.equal(await context.send([hwnd, RB_GETRECT, index, OUT]), 1);
    return [0, 4, 8, 12].map(at=>context.memory.i32(OUT + at));
};

/**
 * The band's cx and style as RB_GETBANDINFOA reports them.
 *
 * @param {ReturnType<typeof setupBars>} context @param {number} hwnd @param {number} index
 */
const sizeOf = async(context, hwnd, index)=>{
    await context.send([hwnd, RB_GETBANDINFOA, index, info(context, RBBIM_STYLE | RBBIM_SIZE)]);
    return { cx: context.memory.i32(INFO + F.cx), style: context.memory.i32(INFO + F.fStyle) };
};

/**
 * Each band's length along the bar, one RB_GETRECT after another: they share
 * the buffer they are answered in.
 *
 * @param {ReturnType<typeof setupBars>} context @param {number} hwnd @param {number} count
 */
const lengthsOf = async(context, hwnd, count)=>{
    const lengths = [];
    for (let index = 0; index < count; index++)
    {
        const rect = await rectOf(context, hwnd, index);
        lengths.push(rect[2] - rect[0]);
    }
    return lengths;
};

/** A rebar on a 400 by 200 parent, as a child at the top. */
const rebar = async(/** @type {number} */ style = 0)=>{
    const context = setupBars();
    await context.makeParent(400, 200);
    const hwnd = await context.control(REBAR_CLASS, style);
    return { context, hwnd, width: context.clientSize(context.sent[0]?.hwnd ?? 0).width };
};

test('bands fill a row as long as they ask, the last taking the room left', async()=>{
    const { context, hwnd } = await rebar(CCS_NODIVIDER);
    const room = context.clientSize(hwnd).width;
    assert.ok(room > 300, 'the bar is as wide as its parent');
    assert.deepEqual(context.clientSize(hwnd), { width: room, height: 0 });
    // A band without a child is four pixels tall, whatever it asks.
    await insert(context, hwnd, { cx: 100, cxMinChild: 50, cyMinChild: 30 });
    await insert(context, hwnd, { cx: 100, cxMinChild: 50, style: RBBS_CHILDEDGE });
    assert.deepEqual(await rectOf(context, hwnd, 0), [0, 0, 100, 4]);
    assert.deepEqual(await rectOf(context, hwnd, 1), [100, 0, room, 4]);
    assert.deepEqual(await sizeOf(context, hwnd, 1), { cx: 100, style: RBBS_CHILDEDGE });
    // A child makes the row as tall as it asks, and an edge round it four more.
    await insert(context, hwnd, { cx: 100, cxMinChild: 30, cyMinChild: 30, child: true,
        style: RBBS_CHILDEDGE });
    assert.equal(await context.send([hwnd, RB_GETROWHEIGHT, 0, 0]), 34);
    assert.deepEqual(context.clientSize(hwnd), { width: room, height: 34 });
    assert.equal(await context.send([hwnd, RB_GETBANDCOUNT, 0, 0]), 3);
    assert.equal(await context.send([hwnd, RB_GETROWCOUNT, 0, 0]), 1);
});

test('a row too short takes from the last band backwards, each down to its least, and a '
    + 'band that cannot fit starts the next row', async()=>{
    const { context, hwnd } = await rebar(CCS_NODIVIDER | RBS_BANDBORDERS);
    const room = context.clientSize(hwnd).width;
    await insert(context, hwnd, { cx: 200, cxMinChild: 40 });
    await insert(context, hwnd, { cx: 200, cxMinChild: 40 });
    // A third of 200 and a border: the last gives up what does not fit down
    // to its least - the gripper's nine, the child's least and four - and the
    // one before it the rest.
    await insert(context, hwnd, { cx: 200, cxMinChild: 40 });
    const least = 9 + 40 + 4;
    assert.deepEqual(await lengthsOf(context, hwnd, 3), [200, room - 4 - 200 - least, least]);
    assert.deepEqual(await sizeOf(context, hwnd, 2), { cx: 200, style: 0 }, 'cx is kept');
    // One whose least is longer than what is left of the row goes below it,
    // two pixels down for the border between rows.
    await insert(context, hwnd, { cx: 50, cxMinChild: room - 2 * least });
    assert.equal(await context.send([hwnd, RB_GETROWCOUNT, 0, 0]), 2);
    assert.deepEqual(await rectOf(context, hwnd, 3), [0, 6, room, 10]);
    assert.deepEqual(context.clientSize(hwnd).height, 10);
    // Deleted, and a band hidden, the rest lay out again.
    assert.equal(await context.send([hwnd, RB_DELETEBAND, 3, 0]), 1);
    assert.equal(await context.send([hwnd, RB_SHOWBAND, 2, 0]), 1);
    assert.equal((await sizeOf(context, hwnd, 2)).style, RBBS_HIDDEN);
    assert.deepEqual((await rectOf(context, hwnd, 1))[2], room);
    assert.equal(await context.send([hwnd, RB_SHOWBAND, 5, 1]), 0, 'no such band');
});

test('the parent hears RBN_HEIGHTCHANGE when the bar grows, with the bar already its new '
    + 'size', async()=>{
    const { context, hwnd } = await rebar();
    context.sent.length = 0;
    await insert(context, hwnd, { cx: 100, cxMinChild: 20, child: true });
    const notes = context.sent.filter(message=>message.message === WM_NOTIFY);
    assert.equal(notes.length, 1);
    assert.equal(context.memory.i32(notes[0].lParam + 8), RBN_HEIGHTCHANGE);
    assert.equal(notes[0].lParam !== 0 && context.memory.i32(notes[0].lParam), hwnd);
    // Two pixels down from the top for the divider, as tall as the row.
    const placed = context.windowRect(hwnd);
    assert.equal(placed.bottom - placed.top, 20);
    context.sent.length = 0;
    await insert(context, hwnd, { cx: 100, cxMinChild: 20 });
    assert.equal(context.sent.filter(message=>message.message === WM_NOTIFY).length, 0,
        'the same height says nothing');
    // What a child tells its parent reaches the bar's.
    await context.send([hwnd, WM_MEASUREITEM, 0, OUT]);
    assert.equal(context.sent.filter(message=>message.message === WM_MEASUREITEM).length, 1);
});

test('RB_GETBANDINFO answers a new band\'s defaults, and the heights of variable height '
    + 'alone', async()=>{
    const { context, hwnd } = await rebar();
    assert.equal(await context.send([hwnd, RB_INSERTBANDA, 0, info(context, 0)]), 1);
    const all = RBBIM_STYLE | RBBIM_COLORS | RBBIM_CHILDSIZE | RBBIM_SIZE | RBBIM_HEADERSIZE;
    await context.send([hwnd, RB_GETBANDINFOA, 0, info(context, all)]);
    assert.deepEqual([F.fStyle, F.clrFore, F.clrBack, F.cx, F.cxHeader, F.cyChild]
        .map(at=>context.memory.i32(INFO + at) >>> 0), [0, 0, FACE, 0, 0, 0xdddddddd]);
    // The heights a band not of variable height is given are not kept.
    await context.send([hwnd, RB_SETBANDINFOA, 0, info(context, RBBIM_CHILDSIZE, {
        [F.cxMinChild]: 15, [F.cyMinChild]: 20, [F.cyChild]: 30, [F.cyMaxChild]: 20,
        [F.cyIntegral]: 10 })]);
    // A header set is fixed, and says so in the style, until the style is set.
    await context.send([hwnd, RB_SETBANDINFOA, 0, info(context, RBBIM_HEADERSIZE,
        { [F.cxHeader]: 50 })]);
    await context.send([hwnd, RB_GETBANDINFOA, 0, info(context, all)]);
    assert.deepEqual([F.fStyle, F.cxHeader].map(at=>context.memory.i32(INFO + at) >>> 0),
        [0x40000000, 50]);
    await context.send([hwnd, RB_SETBANDINFOA, 0, info(context, RBBIM_STYLE,
        { [F.fStyle]: RBBS_VARIABLEHEIGHT })]);
    await context.send([hwnd, RB_GETBANDINFOA, 0, info(context, all)]);
    assert.deepEqual([F.fStyle, F.cxHeader, F.cyChild, F.cyMaxChild, F.cyIntegral]
        .map(at=>context.memory.i32(INFO + at) >>> 0),
    [RBBS_VARIABLEHEIGHT, 0, 20, 0x7fffffff, 0]);
    // A title is read and handed back.
    context.memory.putString(OUT, 'ABC');
    await context.send([hwnd, RB_SETBANDINFOA, 0, info(context, RBBIM_TEXT, { [F.lpText]: OUT })]);
    await context.send([hwnd, RB_GETBANDINFOA, 0, info(context, RBBIM_TEXT,
        { [F.lpText]: OUT + 0x40, [F.cch]: 16 })]);
    assert.equal(context.memory.readCString(OUT + 0x40, 16), 'ABC');
    assert.equal(await context.send([hwnd, RB_GETTEXTCOLOR, 0, 0]) >>> 0, 0xffffffff);
    assert.equal(await context.send([hwnd, RB_GETBKCOLOR, 0, 0]) >>> 0, 0xffffffff);
});

test('a band of variable height stands in steps of cyIntegral from its least', async()=>{
    const { context, hwnd } = await rebar(CCS_NODIVIDER);
    await context.send([hwnd, RB_INSERTBANDA, -1, info(context,
        RBBIM_STYLE | RBBIM_CHILD | RBBIM_CHILDSIZE | RBBIM_SIZE, {
            [F.fStyle]: RBBS_VARIABLEHEIGHT, [F.hwndChild]: 0, [F.cxMinChild]: 50,
            [F.cyMinChild]: 10, [F.cyChild]: 70, [F.cyMaxChild]: 200, [F.cyIntegral]: 11,
            [F.cx]: 90 })]);
    await context.send([hwnd, RB_GETBANDINFOA, 0, info(context, RBBIM_CHILDSIZE)]);
    assert.equal(context.memory.i32(INFO + F.cyChild), 65, 'ten and five steps of eleven');
});

test('RB_MAXIMIZEBAND grows a band to its ideal, then as far as the others let it; '
    + 'RB_MINIMIZEBAND gives its length to the band before', async()=>{
    const { context, hwnd } = await rebar(CCS_NODIVIDER);
    const room = context.clientSize(hwnd).width;
    for (const cx of [60, 60, 60])
    {
        await insert(context, hwnd, { cx, cxMinChild: 20, ideal: 80 });
    }
    const lengths = ()=>lengthsOf(context, hwnd, 3);
    assert.deepEqual(await lengths(), [60, 60, room - 120]);
    await context.send([hwnd, RB_MAXIMIZEBAND, 0, 1]);
    // The ideal, the gripper and four, taken from the next band first.
    assert.deepEqual(await lengths(), [93, 33, room - 126]);
    assert.equal((await sizeOf(context, hwnd, 0)).cx, 93);
    await context.send([hwnd, RB_MAXIMIZEBAND, 0, 1]);
    assert.deepEqual(await lengths(), [room - 66, 33, 33], 'the others at their least');
    await context.send([hwnd, RB_MINIMIZEBAND, 0, 0]);
    assert.deepEqual(await lengths(), [33, room - 66, 33], 'the first gives to the next');
});

test('a vertical bar is as tall as its parent, and its bands read along it', async()=>{
    const { context, hwnd } = await rebar(CCS_VERT | CCS_NODIVIDER);
    const parentHeight = 200 - context.windowRect(hwnd).top;
    await insert(context, hwnd, { cx: 90, cxMinChild: 50, cyMinChild: 30, child: true });
    const size = context.clientSize(hwnd);
    assert.equal(size.width, 30);
    assert.ok(size.height > 100 && size.height <= parentHeight);
    assert.deepEqual(await rectOf(context, hwnd, 0), [0, 0, size.height, 30]);
});

test('RB_PUSHCHEVRON tells where the chevron is, empty when the child has its ideal width',
    async()=>{
        const { context, hwnd } = await rebar(CCS_NODIVIDER);
        await insert(context, hwnd, { cx: 131, cxMinChild: 100, ideal: 128, child: true,
            style: RBBS_USECHEVRON | RBBS_NOGRIPPER });
        await insert(context, hwnd, { cx: 131, cxMinChild: 100, ideal: 128, child: true,
            style: RBBS_USECHEVRON | RBBS_NOGRIPPER });
        /** The NMREBARCHEVRON's rectangle of the last RBN_CHEVRONPUSHED. */
        const pushed = async()=>{
            context.sent.length = 0;
            await context.send([hwnd, RB_PUSHCHEVRON, 0, 0]);
            const note = context.sent.find(message=>message.message === WM_NOTIFY);
            assert.equal(context.memory.i32(note.lParam + 8), RBN_CHEVRONPUSHED);
            return [24, 28, 32, 36].map(at=>context.memory.i32(note.lParam + at));
        };
        const shown = await pushed();
        assert.ok(shown[2] > shown[0] && shown[3] > shown[1], 'a chevron');
        await context.send([hwnd, RB_SETBANDINFOA, 0, info(context, RBBIM_SIZE,
            { [F.cx]: 132 })]);
        assert.deepEqual(await pushed(), [0, 0, 0, 0]);
    });

test('in a 64-bit process a band\'s text, child, bitmap and the bar\'s image list are whole',
    async()=>{
        const control = wideControl((host, tk)=>createRebarProcedure(host, tk), undefined,
            { move: ()=>0, show: ()=>0 });
        const { guest } = control;
        const RBBIM_BACKGROUND = 0x0080;
        const band = 0x1000;
        const child = 0x1_0000_0042;
        const bitmap = 0x2_0000_0099;
        guest.writeAnsi(HIGH + 0x100, 'band');
        guest.set32(band, 108);
        guest.set32(band + 4, RBBIM_TEXT | RBBIM_CHILD | RBBIM_BACKGROUND);
        guest.setPtr(band + 24, HIGH + 0x100);
        guest.setPtr(band + 40, child);
        guest.setPtr(band + 64, bitmap);
        assert.equal(await control.send(RB_INSERTBANDA, -1, band), 1);
        guest.fill(band + 8, 0, 100);
        guest.setPtr(band + 24, HIGH + 0x200);
        guest.set32(band + 32, 16);
        assert.equal(await control.send(RB_GETBANDINFOA, 0, band), 1);
        assert.equal(guest.cstr(HIGH + 0x200), 'band', 'into the buffer past 4 GiB');
        assert.equal(guest.ptr(band + 40), child);
        assert.equal(guest.ptr(band + 64), bitmap);
        const bar = 0x1100;
        const list = 0x5_0000_1000;
        guest.set32s(bar, [16, 1]);
        guest.setPtr(bar + 8, list);
        assert.equal(await control.send(0x0404, 0, bar), 1);
        guest.setPtr(bar + 8, 0);
        assert.equal(await control.send(0x0403, 0, bar), 1);
        assert.equal(guest.ptr(bar + 8), list);
    });
