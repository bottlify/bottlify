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
    MONTHCAL_CLASS, MCS_MULTISELECT, MCS_DAYSTATE, MCS_NOTODAY, MCM_GETCURSEL, MCM_SETCURSEL,
    MCM_GETMAXSELCOUNT, MCM_SETMAXSELCOUNT, MCM_GETSELRANGE, MCM_SETSELRANGE, MCM_GETMONTHRANGE,
    MCM_SETDAYSTATE, MCM_GETMINREQRECT, MCM_SETCOLOR, MCM_GETCOLOR, MCM_SETTODAY, MCM_GETTODAY,
    MCM_HITTEST, MCM_SETFIRSTDAYOFWEEK, MCM_GETFIRSTDAYOFWEEK, MCM_GETRANGE, MCM_SETRANGE,
    MCM_GETMONTHDELTA, MCM_SETMONTHDELTA, MCM_GETCALENDARCOUNT, MCM_SIZERECTTOMIN,
    MCM_SETCALENDARBORDER, MCM_GETCALENDARBORDER, GDTR_MIN, GDTR_MAX, GMR_VISIBLE, GMR_DAYSTATE,
    MCSC_TRAILINGTEXT, MCHT_TITLE, MCHT_TITLEBTNPREV, MCHT_TITLEBTNNEXT, MCHT_TITLEMONTH,
    MCHT_TITLEYEAR, MCHT_NOWHERE, MCHT_CALENDARDATE, MCHT_CALENDARDATEPREV,
    MCHT_CALENDARDATENEXT, MCHT_TODAYLINK, MCHITTESTINFO_V1_SIZE, MCHITTESTINFO_SIZE,
    MCN_SELECT, MCN_SELCHANGE, MCN_GETDAYSTATE, daysIn, isDate, titlePieces,
} from './monthcal.js';

/**
 * The expectations are the month calendar's documented contract and what
 * Wine's conformance tests (monthcal.c) record Windows answering.
 */

const setupBars = ()=>setupWith({ createGdiDrawing, createScreen, ...surfaces });

const WM_NOTIFY = 0x004e;
const WM_NOTIFYFORMAT = 0x0055;
const WM_GETFONT = 0x0031;
const WM_STYLECHANGING = 0x007c;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const WS_BORDER = 0x00800000;
const GWL_STYLE = -16;
const ST = OUT + 0x200;

/** @param {number} x @param {number} y */
const point = (x, y)=>((y & 0xffff) << 16 | x & 0xffff) >>> 0;

/** @param {ReturnType<typeof setupBars>} context @param {number} at @param {number[]} fields */
const putTime = (context, at, fields)=>{
    const bytes = new Uint8Array(16);
    fields.forEach((value, index)=>{
        bytes[index * 2] = value & 0xff;
        bytes[index * 2 + 1] = value >>> 8 & 0xff;
    });
    context.memory.bytes.set(bytes, at);
};

/** @param {ReturnType<typeof setupBars>} context @param {number} at */
const timeAt = (context, at)=>Array.from({ length: 8 }, (_, index)=>
    context.memory.bytes[at + index * 2] | context.memory.bytes[at + index * 2 + 1] << 8);

/** A date as SYSTEMTIME's fields: year, month, weekday, day, then the time. */
const date = (/** @type {number} */ year, /** @type {number} */ month, /** @type {number} */ day,
    /** @type {number[]} */ ...time)=>[year, month, 0, day, ...time];

/** @param {ReturnType<typeof setupBars>} context @param {number} hwnd */
const minRect = (context, hwnd)=>{
    assert.equal(context.send([hwnd, MCM_GETMINREQRECT, 0, OUT]), 1);
    return { right: context.memory.i32(OUT + 8), bottom: context.memory.i32(OUT + 12) };
};

/**
 * A bordered calendar on a parent, sized as Wine's create_monthcal_control
 * sizes it: two calendars across.
 *
 * @param {number} [style]
 */
const calendar = async(style = 0)=>{
    const context = setupBars();
    await context.makeParent(320, 240);
    const hwnd = await context.control(MONTHCAL_CLASS, WS_BORDER | style, [0, 0, 300, 400]);
    assert.notEqual(hwnd, 0, 'SysMonthCal32 is a class of its own');
    const rect = minRect(context, hwnd);
    await context.fns.MoveWindow.handler([hwnd, 0, 0, Math.floor(rect.right * 5 / 2),
        Math.floor(rect.bottom * 3 / 2), 0]);
    return { context, hwnd, rect };
};

/**
 * MCM_HITTEST at a point, with the first version's structure or version 6's.
 *
 * @param {ReturnType<typeof setupBars>} context @param {number} hwnd
 * @param {number} x @param {number} y @param {number} [size]
 */
const hit = (context, hwnd, x, y, size = MCHITTESTINFO_V1_SIZE)=>{
    context.memory.bytes.fill(0xff, OUT, OUT + MCHITTESTINFO_SIZE);
    context.memory.put32s(OUT, [size, x, y]);
    const answer = context.send([hwnd, MCM_HITTEST, 0, OUT]) >>> 0;
    assert.equal(context.memory.u32(OUT + 12), answer, 'uHit is the answer');
    return { answer, day: timeAt(context, OUT + 16)[3], at: OUT };
};

test('the calendar\'s months: the Gregorian ones, September 1752 as Windows counts it', ()=>{
    assert.equal(daysIn(2000, 2), 29);
    assert.equal(daysIn(1900, 2), 28);
    assert.equal(daysIn(2001, 4), 30);
    assert.equal(daysIn(1752, 9), 19);
    assert.equal(isDate({ year: 1752, month: 9, day: 14, dow: 0, hour: 0, minute: 0, second: 0,
        ms: 0 }), true);
    assert.equal(isDate({ year: 1752, month: 9, day: 13, dow: 0, hour: 0, minute: 0, second: 0,
        ms: 0 }), false, 'before the calendar starts');
    assert.equal(isDate({ year: 10000, month: 1, day: 1, dow: 0, hour: 0, minute: 0, second: 0,
        ms: 0 }), false);
    assert.deepEqual(titlePieces('MMMM, yyyy').map(piece=>piece.kind), ['month', 'text', 'year']);
    assert.deepEqual(titlePieces('\'year\' yyyy MMM').map(piece=>piece.kind),
        ['text', 'year', 'text', 'month'], 'a quoted letter is text');
});

test('it is made asking its parent which notifications it takes and for its font', async()=>{
    const context = setupBars();
    await context.makeParent(320, 240);
    const hwnd = await context.control(MONTHCAL_CLASS, WS_BORDER, [0, 0, 300, 400]);
    const asked = context.sent.map(message=>message.message);
    assert.ok(asked.indexOf(WM_NOTIFYFORMAT) >= 0 && asked.indexOf(WM_GETFONT)
        > asked.indexOf(WM_NOTIFYFORMAT), 'WM_NOTIFYFORMAT, then WM_GETFONT');
    assert.ok(minRect(context, hwnd).right > 0, 'MCM_GETMINREQRECT answers a size');
    assert.equal(context.send([hwnd, MCM_GETCALENDARCOUNT, 0, 0]), 0,
        'MCM_GETCALENDARCOUNT is version 6\'s alone');
});

test('a larger font is a larger calendar', async()=>{
    const { context, hwnd } = await calendar();
    const small = context.gdi32.CreateFontA.handler([12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const large = context.gdi32.CreateFontA.handler([24, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    context.send([hwnd, 0x0030, small, 0]);
    const first = minRect(context, hwnd);
    context.send([hwnd, 0x0030, large, 0]);
    assert.ok(minRect(context, hwnd).bottom > first.bottom);
});

test('MCM_SETRANGE: the limits named replace both, a bad date is refused, a bad time is today\'s',
    async()=>{
        const { context, hwnd } = await calendar();
        assert.equal(context.send([hwnd, MCM_GETRANGE, 0, ST]), 0, 'none at first');
        assert.deepEqual(timeAt(context, ST), [0, 0, 0, 0, 0, 0, 0, 0]);
        context.send([hwnd, MCM_GETTODAY, 0, OUT]);
        const today = timeAt(context, OUT);
        putTime(context, ST, date(2000, 1, 1));
        putTime(context, ST + 16, date(2010, 5, 20, 70, 70, 70, 1200));
        assert.equal(context.send([hwnd, MCM_SETRANGE, GDTR_MAX, ST]), 1);
        assert.deepEqual(timeAt(context, ST + 16).slice(4), [...today.slice(4, 7), 1200],
            'the caller\'s time of day is today\'s, its milliseconds kept');
        assert.equal(context.send([hwnd, MCM_GETRANGE, 0, OUT]), GDTR_MAX);
        assert.equal(timeAt(context, OUT)[0], 0, 'the minimum not named is none');

        putTime(context, ST + 16, date(2010, 0, 20));
        assert.equal(context.send([hwnd, MCM_SETRANGE, GDTR_MIN | GDTR_MAX, ST]), 0,
            'month 0 is no date');
        assert.equal(context.send([hwnd, MCM_GETRANGE, 0, OUT]), GDTR_MAX, 'and nothing changed');

        putTime(context, ST, date(2011, 5, 25));
        putTime(context, ST + 16, date(2010, 5, 25));
        assert.equal(context.send([hwnd, MCM_SETRANGE, GDTR_MIN | GDTR_MAX, ST]), 1);
        assert.equal(context.send([hwnd, MCM_GETRANGE, 0, OUT]), GDTR_MIN | GDTR_MAX);
        assert.equal(timeAt(context, OUT)[0], 2010, 'the two the right way round');

        assert.equal(context.send([hwnd, MCM_SETRANGE, GDTR_MIN, ST]), 1);
        assert.equal(context.send([hwnd, MCM_GETRANGE, 0, OUT]), GDTR_MIN);
        assert.deepEqual(timeAt(context, OUT + 16), [0, 0, 0, 0, 0, 0, 0, 0]);
        assert.equal(context.send([hwnd, MCM_SETRANGE, 0, ST]), 1, 'none named clears both');
        assert.equal(context.send([hwnd, MCM_GETRANGE, 0, 0]), 0);
    });

test('MCM_SETCURSEL checks the date, not the time, and keeps the time', async()=>{
    const { context, hwnd } = await calendar();
    await context.pump();
    putTime(context, ST, date(2000, 11, 28, 11, 59, 30));
    assert.equal(await context.send([hwnd, MCM_SETCURSEL, 0, ST]), 1);
    assert.equal(context.fns.GetUpdateRect.handler([hwnd, 0, 0]), 0,
        'drawn again at once, nothing left for the queue');
    putTime(context, ST, date(2000, 11, 32));
    assert.equal(context.send([hwnd, MCM_SETCURSEL, 0, ST]), 0, 'November has no 32nd');
    putTime(context, ST, date(2000, 15, 28));
    assert.equal(context.send([hwnd, MCM_SETCURSEL, 0, ST]), 0);
    assert.equal(context.send([hwnd, MCM_GETCURSEL, 0, OUT]), 1);
    assert.deepEqual(timeAt(context, OUT), [2000, 11, 2, 28, 11, 59, 30, 0],
        'Tuesday, at the time it was given');
    assert.equal(context.send([hwnd, MCM_GETCURSEL, 0, 0]), 0);

    putTime(context, ST, date(9999, 12, 31));
    assert.equal(context.send([hwnd, MCM_SETCURSEL, 0, ST]), 1, 'the last day there is');
    putTime(context, ST, date(10000, 1, 1));
    assert.equal(context.send([hwnd, MCM_SETCURSEL, 0, ST]), 0);

    putTime(context, ST, date(2009, 10, 5));
    assert.equal(context.send([hwnd, MCM_SETCURSEL, 0, ST]), 1);
    putTime(context, ST + 32, date(2009, 10, 6));
    assert.equal(context.send([hwnd, MCM_SETRANGE, GDTR_MIN, ST + 32]), 1);
    assert.equal(context.send([hwnd, MCM_SETCURSEL, 0, ST]), 1,
        'the day selected is taken again though the limit is past it');
    putTime(context, ST, date(2009, 10, 4));
    assert.equal(context.send([hwnd, MCM_SETCURSEL, 0, ST]), 0, 'another day below the limit');
});

test('MCM_SETFIRSTDAYOFWEEK answers what it was; -1 is the locale\'s, past Sunday Sunday',
    async()=>{
        const { context, hwnd } = await calendar();
        assert.equal(context.send([hwnd, MCM_GETFIRSTDAYOFWEEK, 0, 0]), 6, 'en-US: Sunday');
        assert.equal(context.send([hwnd, MCM_SETFIRSTDAYOFWEEK, 0, 2]), 6);
        assert.equal(context.send([hwnd, MCM_GETFIRSTDAYOFWEEK, 0, 0]), 0x10002);
        assert.equal(context.send([hwnd, MCM_SETFIRSTDAYOFWEEK, 0, 9]), 0x10002);
        assert.equal(context.send([hwnd, MCM_GETFIRSTDAYOFWEEK, 0, 0]), 0x10006);
        context.send([hwnd, MCM_SETFIRSTDAYOFWEEK, 0, -5]);
        assert.equal(context.send([hwnd, MCM_GETFIRSTDAYOFWEEK, 0, 0]), 0x1fffb);
        context.send([hwnd, MCM_SETFIRSTDAYOFWEEK, 0, -1]);
        assert.equal(context.send([hwnd, MCM_GETFIRSTDAYOFWEEK, 0, 0]), 6);
    });

test('colours, the month delta and the selection count answer what they were', async()=>{
    const { context, hwnd } = await calendar();
    assert.equal(context.send([hwnd, MCM_GETCOLOR, MCSC_TRAILINGTEXT + 1, 0]), -1);
    const before = context.send([hwnd, MCM_GETCOLOR, MCSC_TRAILINGTEXT, 0]);
    assert.equal(context.send([hwnd, MCM_SETCOLOR, MCSC_TRAILINGTEXT, 0x123456]), before);
    assert.equal(context.send([hwnd, MCM_GETCOLOR, MCSC_TRAILINGTEXT, 0]), 0x123456);

    assert.equal(context.send([hwnd, MCM_GETMONTHDELTA, 0, 0]), 2, 'the months shown');
    assert.equal(context.send([hwnd, MCM_SETMONTHDELTA, 3, 0]), 0, 'none was set');
    assert.equal(context.send([hwnd, MCM_SETMONTHDELTA, -5, 0]), 3);
    assert.equal(context.send([hwnd, MCM_GETMONTHDELTA, 0, 0]), -5);

    assert.equal(context.send([hwnd, MCM_GETMAXSELCOUNT, 0, 0]), 1);
    assert.equal(context.send([hwnd, MCM_SETMAXSELCOUNT, 5, 0]), 0, 'one day is one day');
});

test('MCM_SETTODAY keeps any value; a click on the today line selects it', async()=>{
    const { context, hwnd, rect } = await calendar();
    await context.fns.MoveWindow.handler([hwnd, 0, 0, rect.right, rect.bottom, 0]);
    putTime(context, ST, [0, 38, 0, 38]);
    assert.equal(context.send([hwnd, MCM_SETTODAY, 0, ST]), 0);
    assert.equal(context.send([hwnd, MCM_GETTODAY, 0, OUT]), 1);
    assert.deepEqual(timeAt(context, OUT).slice(0, 4), [0, 38, 0, 38]);

    const x = Math.floor(rect.right / 14);
    const y = Math.floor(18 * rect.bottom / 19);
    assert.equal(hit(context, hwnd, x, y).answer, MCHT_TODAYLINK);
    putTime(context, ST, date(2005, 1, 1));
    context.send([hwnd, MCM_SETTODAY, 0, ST]);
    assert.equal(await context.send([hwnd, WM_LBUTTONDOWN, 1, point(x, y)]), 0);
    context.send([hwnd, MCM_GETCURSEL, 0, OUT]);
    assert.deepEqual(timeAt(context, OUT).slice(0, 4), [2005, 1, 6, 1]);
});

test('the months shown, and every day shown, two calendars of 2000', async()=>{
    const { context, hwnd, rect } = await calendar();
    putTime(context, ST, date(2000, 11, 28, 11, 59, 30));
    assert.equal(context.send([hwnd, MCM_SETCURSEL, 0, ST]), 1);
    context.send([hwnd, MCM_SETFIRSTDAYOFWEEK, 0, 6]);
    await context.fns.MoveWindow.handler([hwnd, 0, 0, rect.right, 2 * rect.bottom, 0]);
    assert.equal(context.send([hwnd, MCM_GETMONTHRANGE, GMR_VISIBLE, OUT]), 2,
        'two down in a window of two minimums');
    assert.deepEqual([timeAt(context, OUT), timeAt(context, OUT + 16)].map(t=>[t[0], t[1], t[3]]),
        [[2000, 11, 1], [2000, 12, 31]]);
    assert.equal(context.send([hwnd, MCM_GETMONTHRANGE, GMR_DAYSTATE, OUT]), 4);
    assert.deepEqual([timeAt(context, OUT), timeAt(context, OUT + 16)].map(t=>[t[0], t[1], t[3]]),
        [[2000, 10, 29], [2001, 1, 6]]);

    await context.fns.MoveWindow.handler([hwnd, 0, 0, rect.right, rect.bottom, 0]);
    putTime(context, ST, date(1752, 9, 14));
    assert.equal(context.send([hwnd, MCM_SETCURSEL, 0, ST]), 1);
    assert.equal(context.send([hwnd, MCM_GETMONTHRANGE, GMR_VISIBLE, OUT]), 1);
    assert.deepEqual([timeAt(context, OUT), timeAt(context, OUT + 16)].map(t=>[t[0], t[1], t[3]]),
        [[1752, 9, 14], [1752, 9, 19]]);
});

test('a hit test reads the calendar the way Windows lays it out', async()=>{
    const { context, hwnd, rect } = await calendar();
    context.memory.put32s(OUT, [MCHITTESTINFO_V1_SIZE - 1, 0, 0, 0]);
    assert.equal(context.send([hwnd, MCM_HITTEST, 0, OUT]), -1, 'a structure too small');
    assert.equal(context.memory.u32(OUT + 12), 0);
    assert.equal(context.send([hwnd, MCM_HITTEST, 0, 0]), -1);

    await context.fns.MoveWindow.handler([hwnd, 0, 0, rect.right, rect.bottom, 0]);
    putTime(context, ST, date(2007, 4, 11, 1));
    context.send([hwnd, MCM_SETCURSEL, 0, ST]);
    const { right: w, bottom: h } = rect;
    assert.equal(hit(context, hwnd, 0, 0).answer, MCHT_TITLE);
    assert.equal(hit(context, hwnd, w, h).answer, MCHT_NOWHERE);
    assert.equal(hit(context, hwnd, Math.floor(w / 2), Math.floor(h / 2)).answer,
        MCHT_CALENDARDATE);
    assert.equal(hit(context, hwnd, Math.floor(w / 14), Math.floor(6 * h / 19)).answer,
        MCHT_CALENDARDATEPREV, 'April 2007 starts on a Sunday: the week before is shown');
    assert.equal(hit(context, hwnd, Math.floor(11 * w / 14), Math.floor(16 * h / 19)).answer,
        MCHT_CALENDARDATENEXT);
    assert.equal(hit(context, hwnd, Math.floor(w / 2), Math.floor(18 * h / 19)).answer,
        MCHT_TODAYLINK);

    // Along the title: the edge, the button back, the month and the year,
    // the button on, the edge, then past the calendar.
    /** @type {number[]} */
    const seen = [];
    for (let x = 0; x < w; x++)
    {
        const answer = hit(context, hwnd, x, Math.floor(2 * h / 19)).answer;
        if (seen[seen.length - 1] !== answer)
        {
            seen.push(answer);
        }
    }
    assert.deepEqual(seen, [MCHT_TITLE, MCHT_TITLEBTNPREV, MCHT_TITLE, MCHT_TITLEMONTH,
        MCHT_TITLE, MCHT_TITLEYEAR, MCHT_TITLE, MCHT_TITLEBTNNEXT, MCHT_TITLE, MCHT_NOWHERE]);
});

test('a multiple-selection calendar keeps a run of days, a week at most until told', async()=>{
    const { context, hwnd } = await calendar(MCS_MULTISELECT);
    context.send([hwnd, MCM_GETTODAY, 0, OUT]);
    const today = timeAt(context, OUT);
    assert.equal(context.send([hwnd, MCM_GETSELRANGE, 0, ST]), 1);
    assert.deepEqual([timeAt(context, ST), timeAt(context, ST + 16)], [today, today],
        'today, to the millisecond');
    assert.equal(context.send([hwnd, MCM_GETMAXSELCOUNT, 0, 0]), 7);
    assert.equal(context.send([hwnd, MCM_SETMAXSELCOUNT, 0, 0]), 0);
    assert.equal(context.send([hwnd, MCM_SETMAXSELCOUNT, -1, 0]), 0);
    assert.equal(context.send([hwnd, MCM_GETMAXSELCOUNT, 0, 0]), 7);

    putTime(context, ST, date(2009, 10, 5));
    putTime(context, ST + 16, date(2009, 10, 3));
    assert.equal(context.send([hwnd, MCM_SETSELRANGE, 0, ST]), 1);
    context.send([hwnd, MCM_GETSELRANGE, 0, OUT]);
    assert.deepEqual([timeAt(context, OUT), timeAt(context, OUT + 16)],
        [[2009, 10, 6, 3, 0, 0, 0, 0], [2009, 10, 1, 5, 0, 0, 0, 0]], 'swapped, with weekdays');
    putTime(context, ST, date(2009, 10, 1));
    putTime(context, ST + 16, date(2009, 10, 8));
    assert.equal(context.send([hwnd, MCM_SETSELRANGE, 0, ST]), 0, 'eight days are too many');
    assert.equal(context.send([hwnd, MCM_GETCURSEL, 0, OUT]), 0, 'not one day\'s message');
});

test('the selection style and the day state style are the ones it was made with', async()=>{
    const { context, hwnd } = await calendar(MCS_MULTISELECT);
    context.memory.put32s(OUT, [MCS_MULTISELECT | MCS_DAYSTATE, 0]);
    context.send([hwnd, WM_STYLECHANGING, GWL_STYLE >>> 0, OUT]);
    assert.equal(context.memory.u32(OUT + 4), MCS_MULTISELECT | MCS_DAYSTATE,
        'WM_STYLECHANGING puts both back as they were');
});

test('a day state calendar asks for its months and takes one for each it shows', async()=>{
    /** @type {number[]} */
    const asked = [];
    const context = setupBars();
    await context.makeParent(320, 240);
    context.answerParent(message=>{
        if (message.message === WM_NOTIFY && context.memory.u32(message.lParam + 8)
            === MCN_GETDAYSTATE)
        {
            asked.push(context.memory.i32(message.lParam + 28));
            assert.notEqual(context.memory.u32(message.lParam + 32), 0, 'an array to fill');
            return 1;
        }
        return undefined;
    });
    const hwnd = await context.control(MONTHCAL_CLASS, WS_BORDER | MCS_DAYSTATE | MCS_NOTODAY,
        [0, 0, 300, 400]);
    assert.ok(asked.length > 0 && asked.every(count=>count >= 1 && count <= 14));
    const count = context.send([hwnd, MCM_GETMONTHRANGE, GMR_DAYSTATE, 0]);
    assert.equal(context.send([hwnd, MCM_SETDAYSTATE, count, ST]), 1);
    assert.equal(context.send([hwnd, MCM_SETDAYSTATE, count - 1, ST]), 0);
});

test('a click on a day selects it when the button comes up; a run of days as it goes down',
    async()=>{
        for (const style of [0, MCS_MULTISELECT])
        {
            const { context, hwnd, rect } = await calendar(style | MCS_NOTODAY);
            /** @type {number[]} */
            const codes = [];
            context.answerParent(message=>{
                if (message.message === WM_NOTIFY)
                {
                    codes.push(context.memory.u32(message.lParam + 8));
                    return 1;
                }
                return undefined;
            });
            await context.fns.MoveWindow.handler([hwnd, 0, 0, rect.right, rect.bottom, 0]);
            const x = Math.floor(rect.right / 2);
            const y = Math.floor(rect.bottom / 2);
            context.send([hwnd, MCM_GETTODAY, 0, OUT]);
            const target = hit(context, hwnd, x, y);
            assert.equal(target.answer, MCHT_CALENDARDATE);
            await context.send([hwnd, WM_LBUTTONDOWN, 1, point(x, y)]);
            assert.deepEqual(codes, style ? [MCN_SELCHANGE] : []);
            codes.length = 0;
            await context.send([hwnd, WM_LBUTTONUP, 0, point(x, y)]);
            assert.deepEqual(codes, style ? [MCN_SELECT] : [MCN_SELCHANGE, MCN_SELECT].slice(
                target.day === timeAt(context, OUT)[3] ? 1 : 0));
            const selected = context.send([hwnd, style ? MCM_GETSELRANGE : MCM_GETCURSEL, 0, OUT]);
            assert.equal(selected, 1);
            assert.equal(timeAt(context, OUT)[3], target.day);
        }
    });

test('version 6 says where a hit is, how many calendars there are and their border',
    async()=>{
        const { context, hwnd, rect } = await calendar();
        context.recordOf(hwnd).controlsVersion = 6;
        assert.equal(context.send([hwnd, MCM_GETCALENDARCOUNT, 0, 0]), 2);
        assert.equal(context.send([hwnd, MCM_SETCALENDARBORDER, 1, 10]), 0);
        assert.equal(context.send([hwnd, MCM_GETCALENDARBORDER, 0, 0]), 10);
        context.send([hwnd, MCM_SETCALENDARBORDER, 1, 0]);

        await context.fns.MoveWindow.handler([hwnd, 0, 0, Math.floor(rect.right * 3 / 2),
            Math.floor(rect.bottom * 3 / 2), 0]);
        const outside = hit(context, hwnd, 0, 0, MCHITTESTINFO_SIZE);
        assert.equal(outside.answer, MCHT_NOWHERE, 'the calendar is centred');
        assert.equal(context.memory.i32(outside.at + 48), -1, 'no calendar named');

        await context.fns.MoveWindow.handler([hwnd, 0, 0, rect.right, rect.bottom, 0]);
        const day = hit(context, hwnd, Math.floor(rect.right / 14), Math.floor(rect.bottom / 2),
            MCHITTESTINFO_SIZE);
        assert.equal(day.answer, MCHT_CALENDARDATE);
        assert.deepEqual([48, 52, 56].map(at=>context.memory.i32(day.at + at)), [0, 2, 0],
            'the first calendar, its third week, its first day');
        const [left, top, right, bottom] = [32, 36, 40, 44]
            .map(at=>context.memory.i32(day.at + at));
        assert.ok(Math.abs(right - left - rect.right / 7) <= 2, 'a day wide');
        assert.ok(Math.abs(bottom - top - rect.bottom / 10) <= 2, 'a row high');

        const title = hit(context, hwnd, 1, 1, MCHITTESTINFO_SIZE);
        assert.equal(title.answer, MCHT_TITLE);
        assert.deepEqual([32, 36, 40, 52, 56].map(at=>context.memory.i32(title.at + at)),
            [0, 0, rect.right - 2, -1, -1], 'the title across the calendar, no row or column');

        context.memory.put32s(OUT, [0, 0, 0, 0]);
        assert.equal(context.send([hwnd, MCM_SIZERECTTOMIN, 0, OUT]), 1);
        assert.deepEqual([context.memory.i32(OUT + 8), context.memory.i32(OUT + 12)],
            [rect.right, rect.bottom], 'an empty rectangle grows to one calendar');
        context.memory.put32s(OUT, [0, 0, rect.right * 3, rect.bottom * 3]);
        assert.equal(context.send([hwnd, MCM_SIZERECTTOMIN, 0, OUT]), 1);
        assert.ok(context.memory.i32(OUT + 8) <= rect.right * 3
            && context.memory.i32(OUT + 8) > rect.right * 2, 'three across, shrunk to them');
        assert.equal(context.send([hwnd, MCM_SIZERECTTOMIN, 0, 0]), 0);
    });
