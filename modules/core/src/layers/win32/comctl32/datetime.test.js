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
import { setupBars as setupWith, OUT } from './bars.fixture.js';
import {
    DATETIMEPICK_CLASS, DTS_SHOWNONE, DTS_LONGDATEFORMAT, DTS_TIMEFORMAT,
    DTS_SHORTDATECENTURYFORMAT, DTM_GETSYSTEMTIME, DTM_SETSYSTEMTIME, DTM_GETRANGE, DTM_SETRANGE,
    DTM_SETFORMATA, DTM_SETMCCOLOR, DTM_GETMCCOLOR, DTM_GETMONTHCAL, DTM_SETMCFONT, DTM_GETMCFONT,
    DTN_DATETIMECHANGE, DTN_DROPDOWN, DTN_CLOSEUP, GDT_VALID, GDT_NONE, stepField, typeField,
} from './datetime.js';
import { GDTR_MIN, GDTR_MAX, MCSC_TEXT } from './monthcal.js';

/**
 * The expectations are the date and time picker's documented contract and
 * what Wine's conformance tests (datetime.c) record Windows answering.
 */

const setupBars = ()=>setupWith({ createGdiDrawing, createScreen, ...surfaces });

const WM_SETTEXT = 0x000c;
const WM_GETTEXT = 0x000d;
const WM_GETTEXTLENGTH = 0x000e;
const WM_KEYDOWN = 0x0100;
const WM_CHAR = 0x0102;
const WM_NOTIFY = 0x004e;
const VK_RIGHT = 0x27;
const VK_UP = 0x26;
const GWL_STYLE = -16;
const ST = OUT + 0x200;
const TEXT = OUT + 0x400;

/** @param {ReturnType<typeof setupBars>} context @param {number} at @param {number[]} fields */
const putTime = (context, at, fields)=>{
    fields.forEach((value, index)=>{
        context.memory.bytes[at + index * 2] = value & 0xff;
        context.memory.bytes[at + index * 2 + 1] = value >>> 8 & 0xff;
    });
};

/** @param {ReturnType<typeof setupBars>} context @param {number} at */
const timeAt = (context, at)=>Array.from({ length: 8 }, (_, index)=>
    context.memory.bytes[at + index * 2] | context.memory.bytes[at + index * 2 + 1] << 8);

/** A moment as SYSTEMTIME's fields: year, month, weekday, day, then the time. */
const moment = (/** @type {number} */ year, /** @type {number} */ month,
    /** @type {number} */ day, /** @type {number[]} */ ...time)=>[year, month, 0, day, ...time];

/** @param {ReturnType<typeof setupBars>} context @param {number} hwnd */
const textOf = (context, hwnd)=>{
    context.memory.bytes.fill(0, TEXT, TEXT + 128);
    const length = context.send([hwnd, WM_GETTEXT, 128, TEXT]);
    return context.memory.readCString(TEXT, 128).slice(0, length);
};

/** @param {number} [style] */
const picker = async(style = 0)=>{
    const context = setupBars();
    await context.makeParent(320, 240);
    const hwnd = await context.control(DATETIMEPICK_CLASS, style, [0, 0, 150, 24]);
    assert.notEqual(hwnd, 0, 'SysDateTimePick32 is a class of its own');
    return { context, hwnd };
};

test('its text is the moment in the style\'s format, and WM_SETTEXT changes nothing', async()=>{
    const { context, hwnd } = await picker();
    putTime(context, ST, moment(2026, 11, 19, 14, 5, 9, 0));
    assert.equal(context.send([hwnd, DTM_SETSYSTEMTIME, GDT_VALID, ST]), 1);
    assert.equal(textOf(context, hwnd), '11/19/2026', 'the locale\'s short date');
    assert.equal(context.send([hwnd, WM_GETTEXTLENGTH, 0, 0]), 10);
    context.memory.putString(OUT, 'a');
    assert.equal(context.send([hwnd, WM_SETTEXT, 0, OUT]) | 0, -1, 'CB_ERR');
    assert.equal(textOf(context, hwnd), '11/19/2026', 'the text is the moment\'s');

    const long = await picker(DTS_LONGDATEFORMAT);
    putTime(long.context, ST, moment(2026, 11, 19, 14, 5, 9, 0));
    long.context.send([long.hwnd, DTM_SETSYSTEMTIME, GDT_VALID, ST]);
    assert.equal(textOf(long.context, long.hwnd), 'Thursday, November 19, 2026');

    const time = await picker(DTS_TIMEFORMAT);
    putTime(time.context, ST, moment(2026, 11, 19, 14, 5, 9, 0));
    time.context.send([time.hwnd, DTM_SETSYSTEMTIME, GDT_VALID, ST]);
    assert.equal(textOf(time.context, time.hwnd), '2:05:09 PM');

    const century = await picker(DTS_SHORTDATECENTURYFORMAT);
    putTime(century.context, ST, moment(2026, 1, 2));
    century.context.send([century.hwnd, DTM_SETSYSTEMTIME, GDT_VALID, ST]);
    assert.equal(textOf(century.context, century.hwnd), '1/2/2026');
});

test('DTM_SETFORMAT takes a picture of date and time letters, and none is the style\'s', async()=>{
    const { context, hwnd } = await picker(DTS_SHOWNONE);
    assert.equal(context.send([hwnd, DTM_SETFORMATA, 0, 0]), 1);
    context.memory.putString(OUT, '\'hh\' hh');
    assert.equal(context.send([hwnd, DTM_SETFORMATA, 0, OUT]), 1);
    putTime(context, ST, moment(2000, 1, 1));
    assert.equal(context.send([hwnd, DTM_SETSYSTEMTIME, GDT_VALID, ST]), 1);
    assert.equal(textOf(context, hwnd), 'hh 12', 'midnight is twelve on the twelve-hour clock');
    context.memory.putString(OUT, 'dddd MMM dd\', \'yyyy HH:mm');
    context.send([hwnd, DTM_SETFORMATA, 0, OUT]);
    assert.equal(textOf(context, hwnd), 'Saturday Jan 01, 2000 00:00');
    context.send([hwnd, DTM_SETFORMATA, 0, 0]);
    assert.equal(textOf(context, hwnd), '1/1/2000');
});

test('DTM_SETSYSTEMTIME checks the moment; outside the limits it is answered and not taken',
    async()=>{
        const { context, hwnd } = await picker();
        putTime(context, ST, moment(2026, 2, 30));
        assert.equal(context.send([hwnd, DTM_SETSYSTEMTIME, GDT_VALID, ST]), 0, 'no such day');
        putTime(context, ST, moment(2026, 2, 3, 24));
        assert.equal(context.send([hwnd, DTM_SETSYSTEMTIME, GDT_VALID, ST]), 0, 'no such hour');
        assert.equal(context.send([hwnd, DTM_SETSYSTEMTIME, GDT_VALID, 0]), 0);
        assert.equal(context.send([hwnd, DTM_SETSYSTEMTIME, GDT_NONE, 0]), 0,
            'none only for DTS_SHOWNONE');
        putTime(context, ST, moment(2001, 2, 3, 0, 0, 0, 0));
        context.send([hwnd, DTM_SETSYSTEMTIME, GDT_VALID, ST]);
        putTime(context, ST, moment(0, 2, 3, 0, 0, 0, 0));
        assert.equal(context.send([hwnd, DTM_SETSYSTEMTIME, GDT_VALID, ST]), 1,
            'year 0 is answered as set');
        context.send([hwnd, DTM_GETSYSTEMTIME, 0, OUT]);
        assert.equal(timeAt(context, OUT)[0], 2001, 'and not taken');
        putTime(context, ST, moment(1601, 1, 1));
        putTime(context, ST + 16, moment(0, 0, 0));
        assert.equal(context.send([hwnd, DTM_SETRANGE, GDTR_MIN, ST]), 1,
            '1601 is a limit, a year the calendar does not show');

        putTime(context, ST, moment(1980, 1, 23, 14, 34, 37, 465));
        putTime(context, ST + 16, moment(2007, 3, 31, 23, 59, 59, 999));
        assert.equal(context.send([hwnd, DTM_SETRANGE, GDTR_MIN | GDTR_MAX, ST]), 1);
        assert.equal(context.send([hwnd, DTM_GETRANGE, 0, OUT]), GDTR_MIN | GDTR_MAX);
        assert.deepEqual(timeAt(context, OUT), moment(1980, 1, 23, 14, 34, 37, 465));
        assert.deepEqual(timeAt(context, OUT + 16), moment(2007, 3, 31, 23, 59, 59, 999));

        putTime(context, ST, moment(1999, 9, 9, 19, 34, 37, 465));
        assert.equal(context.send([hwnd, DTM_SETSYSTEMTIME, GDT_VALID, ST]), 1);
        putTime(context, ST, moment(2010, 1, 1));
        assert.equal(context.send([hwnd, DTM_SETSYSTEMTIME, GDT_VALID, ST]), 1,
            'a valid moment outside the limits is answered as done');
        assert.equal(context.send([hwnd, DTM_GETSYSTEMTIME, 0, OUT]), GDT_VALID);
        const kept = timeAt(context, OUT);
        assert.deepEqual([kept[0], kept[1], kept[3], kept[4]], [1999, 9, 9, 19], 'and not taken');
        assert.equal(kept[2], 4, 'its weekday the date\'s');
    });

test('a DTS_SHOWNONE picker may hold no moment, and keeps the style it was made with', async()=>{
    const { context, hwnd } = await picker(DTS_SHOWNONE);
    assert.equal(context.send([hwnd, DTM_GETSYSTEMTIME, 0, OUT]), GDT_VALID, 'checked at first');
    assert.equal(context.send([hwnd, DTM_SETSYSTEMTIME, GDT_NONE, 0]), 1);
    assert.equal(context.send([hwnd, DTM_GETSYSTEMTIME, 0, OUT]), GDT_NONE);
    const style = context.fns.GetWindowLongA.handler([hwnd, GWL_STYLE]);
    await context.fns.SetWindowLongA.handler([hwnd, GWL_STYLE, style & ~DTS_SHOWNONE]);
    assert.notEqual(context.fns.GetWindowLongA.handler([hwnd, GWL_STYLE]) & DTS_SHOWNONE, 0);

    const plain = await picker();
    const plainStyle = plain.context.fns.GetWindowLongA.handler([plain.hwnd, GWL_STYLE]);
    await plain.context.fns.SetWindowLongA.handler([plain.hwnd, GWL_STYLE,
        plainStyle | DTS_SHOWNONE]);
    assert.equal(plain.context.fns.GetWindowLongA.handler([plain.hwnd, GWL_STYLE])
        & DTS_SHOWNONE, 0);
});

test('the calendar\'s colours and font are kept for the calendar it drops down', async()=>{
    const { context, hwnd } = await picker();
    const before = context.send([hwnd, DTM_GETMCCOLOR, MCSC_TEXT, 0]);
    assert.equal(context.send([hwnd, DTM_SETMCCOLOR, MCSC_TEXT, 0xdcb464]), before,
        'the colour before');
    assert.equal(context.send([hwnd, DTM_GETMCCOLOR, MCSC_TEXT, 0]), 0xdcb464);
    assert.equal(context.send([hwnd, DTM_SETMCCOLOR, 6, 0]) | 0, -1, 'no such part');
    assert.equal(context.send([hwnd, DTM_SETMCFONT, 0x4c, 1]), 0);
    assert.equal(context.send([hwnd, DTM_GETMCFONT, 0, 0]), 0x4c);
    assert.equal(context.send([hwnd, DTM_GETMONTHCAL, 0, 0]), 0, 'none while it is up');
});

test('a person steps the picked field and the parent hears DTN_DATETIMECHANGE', async()=>{
    const { context, hwnd } = await picker();
    putTime(context, ST, moment(2026, 1, 31));
    context.send([hwnd, DTM_SETSYSTEMTIME, GDT_VALID, ST]);
    context.sent.length = 0;
    context.send([hwnd, WM_KEYDOWN, VK_UP, 0]);
    assert.equal(textOf(context, hwnd), '2/28/2026', 'the month steps; the day stays in it');
    const told = context.sent.filter(message=>message.message === WM_NOTIFY);
    assert.equal(told.length, 1);
    assert.equal(context.memory.u32(told[0].lParam + 8), DTN_DATETIMECHANGE);
    context.send([hwnd, WM_KEYDOWN, VK_RIGHT, 0]);
    context.send([hwnd, WM_CHAR, 0x31, 0]);
    context.send([hwnd, WM_CHAR, 0x34, 0]);
    assert.equal(textOf(context, hwnd), '2/14/2026', 'two digits typed are the day');
});

test('a field steps within its own range', ()=>{
    const base = { year: 2024, month: 2, dow: 4, day: 29, hour: 23, minute: 59, second: 0,
        ms: 0 };
    assert.equal(stepField(base, 'y', 1).day, 28, 'no 29 February in 2025');
    assert.equal(stepField(base, 'H', 1).hour, 0, 'the hour wraps in its day');
    assert.equal(stepField(base, 't', 1).hour, 11, 'PM to AM');
    assert.equal(stepField(base, 'M', -1).month, 1);
    assert.equal(typeField(base, 'd', 31), null, 'no 31 February');
    assert.equal(typeField(base, 'h', 3)?.hour, 15, 'the twelve-hour clock keeps PM');
});

test('F4 drops a calendar down with the picker\'s day; the day chosen there is the picker\'s',
    async()=>{
        const { context, hwnd } = await picker();
        putTime(context, ST, moment(2026, 3, 10, 8, 30, 0, 0));
        context.send([hwnd, DTM_SETSYSTEMTIME, GDT_VALID, ST]);
        context.sent.length = 0;
        await context.send([hwnd, WM_KEYDOWN, 0x73, 0]);
        const calendar = context.send([hwnd, DTM_GETMONTHCAL, 0, 0]);
        assert.notEqual(calendar, 0, 'a calendar is down');
        const codes = ()=>context.sent.filter(message=>message.message === WM_NOTIFY)
            .map(message=>context.memory.u32(message.lParam + 8));
        assert.deepEqual(codes(), [DTN_DROPDOWN]);
        context.send([calendar, 0x1001, 0, OUT]);
        assert.deepEqual(timeAt(context, OUT).slice(0, 4).filter((_, at)=>at !== 2),
            [2026, 3, 10], 'it shows the picker\'s day');
        context.sent.length = 0;
        // MCN_SELECT from the calendar, as a click on 20 March sends it.
        context.memory.put32s(OUT, [calendar, 0, -746]);
        putTime(context, OUT + 12, moment(2026, 3, 20, 0, 0, 0, 0));
        await context.send([hwnd, WM_NOTIFY, 0, OUT]);
        assert.equal(context.send([hwnd, DTM_GETMONTHCAL, 0, 0]), 0, 'closed');
        assert.deepEqual(codes(), [DTN_DATETIMECHANGE, DTN_CLOSEUP]);
        context.send([hwnd, DTM_GETSYSTEMTIME, 0, OUT]);
        assert.deepEqual(timeAt(context, OUT).filter((_, at)=>at !== 2),
            [2026, 3, 20, 8, 30, 0, 0], 'the day chosen, the time of day kept');
    });
