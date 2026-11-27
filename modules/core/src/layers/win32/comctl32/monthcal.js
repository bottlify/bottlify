/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The month calendar, `SysMonthCal32`.
 *
 * One month or a grid of them - as many whole calendars as the window holds,
 * twelve at most - each a title with the month and the year, a row of day
 * names and six weeks, and under the grid the "Today:" line. The first
 * calendar shows the end of the month before it and the last the start of
 * the month after; a month that starts on the first day of the week shows the
 * whole week before it, so a click on the first row of a month always has a
 * day of the previous one to land on.
 *
 * What the control keeps is dates: a selection (one day, or with
 * MCS_MULTISELECT a run of up to MCM_SETMAXSELCOUNT days), "today", the
 * limits MCM_SETRANGE sets, and the month the grid starts at. A date is
 * checked as a date - a day of its month, from 14 September 1752 to the end
 * of 9999 - and its time of day is kept as given (Wine's monthcal tests,
 * test_currdate and test_monthcal). The calendar is the Gregorian one, which
 * Windows' control takes September 1752 to have 19 days of (test_monthrange).
 *
 * The geometry is in rows of the font's height: a calendar is two rows of
 * title, one of day names and six of weeks, seven days wide, and the today
 * line one row under the grid. MCM_GETMINREQRECT is one calendar and that
 * line in the window's frame; the grid is centred in a larger client area.
 *
 * Its parent hears of the selection through WM_NOTIFY: MCN_SELCHANGE as it
 * changes and MCN_SELECT when a person has chosen (a click on a day is chosen
 * when the button comes up; a run of days is changed as it is dragged), and a
 * MCS_DAYSTATE calendar asks for its bold days with MCN_GETDAYSTATE whenever
 * the months it shows change.
 */

import {
    WM_PAINT, WM_ERASEBKGND, WM_GETDLGCODE, WM_KEYDOWN, WM_LBUTTONDOWN, WM_LBUTTONUP,
    WM_MOUSEMOVE, WM_CAPTURECHANGED, WM_CREATE, WM_SETFONT, WM_GETFONT, after,
} from '../user32/controls.js';
import { notifyWindow } from './notify.js';
import { renderDate } from '../kernel32/datetime-format.js';
import { DAYS, MONTHS } from '../kernel32/locale-data.js';
import { wholeAddress } from '../common/pointers.js';

/** The class name a program creates the control by. */
export const MONTHCAL_CLASS = 'SysMonthCal32';

/** The atom spacing a build without a bridge gives the class's procedure. */
export const MONTHCAL_ATOM = 0x801d;

/** Styles. */
export const MCS_DAYSTATE = 0x0001;
export const MCS_MULTISELECT = 0x0002;
const MCS_WEEKNUMBERS = 0x0004;
const MCS_NOTODAYCIRCLE = 0x0008;
export const MCS_NOTODAY = 0x0010;
const MCS_NOTRAILINGDATES = 0x0040;

/** Messages, off MCM_FIRST as commctrl.h numbers them. */
const MCM_FIRST = 0x1000;
export const MCM_GETCURSEL = MCM_FIRST + 1;
export const MCM_SETCURSEL = MCM_FIRST + 2;
export const MCM_GETMAXSELCOUNT = MCM_FIRST + 3;
export const MCM_SETMAXSELCOUNT = MCM_FIRST + 4;
export const MCM_GETSELRANGE = MCM_FIRST + 5;
export const MCM_SETSELRANGE = MCM_FIRST + 6;
export const MCM_GETMONTHRANGE = MCM_FIRST + 7;
export const MCM_SETDAYSTATE = MCM_FIRST + 8;
export const MCM_GETMINREQRECT = MCM_FIRST + 9;
export const MCM_SETCOLOR = MCM_FIRST + 10;
export const MCM_GETCOLOR = MCM_FIRST + 11;
export const MCM_SETTODAY = MCM_FIRST + 12;
export const MCM_GETTODAY = MCM_FIRST + 13;
export const MCM_HITTEST = MCM_FIRST + 14;
export const MCM_SETFIRSTDAYOFWEEK = MCM_FIRST + 15;
export const MCM_GETFIRSTDAYOFWEEK = MCM_FIRST + 16;
export const MCM_GETRANGE = MCM_FIRST + 17;
export const MCM_SETRANGE = MCM_FIRST + 18;
export const MCM_GETMONTHDELTA = MCM_FIRST + 19;
export const MCM_SETMONTHDELTA = MCM_FIRST + 20;
const MCM_GETMAXTODAYWIDTH = MCM_FIRST + 21;
const MCM_GETCURRENTVIEW = MCM_FIRST + 22;
export const MCM_GETCALENDARCOUNT = MCM_FIRST + 23;
const MCM_GETCALID = MCM_FIRST + 27;
const MCM_SETCALID = MCM_FIRST + 28;
export const MCM_SIZERECTTOMIN = MCM_FIRST + 29;
export const MCM_SETCALENDARBORDER = MCM_FIRST + 30;
export const MCM_GETCALENDARBORDER = MCM_FIRST + 31;
const MCM_SETCURRENTVIEW = MCM_FIRST + 32;
const MCM_SETUNICODEFORMAT = 0x2005;
const MCM_GETUNICODEFORMAT = 0x2006;

/** The messages only Common Controls 6's calendar answers. */
const VERSION_6_MESSAGES = new Set([MCM_GETCURRENTVIEW, MCM_GETCALENDARCOUNT, MCM_GETCALID,
    MCM_SETCALID, MCM_SIZERECTTOMIN, MCM_SETCALENDARBORDER, MCM_GETCALENDARBORDER,
    MCM_SETCURRENTVIEW]);

/** MCM_GETRANGE's and MCM_SETRANGE's limits. */
export const GDTR_MIN = 1;
export const GDTR_MAX = 2;
/** MCM_GETMONTHRANGE's spans: the months shown whole, or every day shown. */
export const GMR_VISIBLE = 0;
export const GMR_DAYSTATE = 1;

/** MCM_SETCOLOR's parts. */
export const MCSC_BACKGROUND = 0;
export const MCSC_TEXT = 1;
export const MCSC_TITLEBK = 2;
export const MCSC_TITLETEXT = 3;
export const MCSC_MONTHBK = 4;
export const MCSC_TRAILINGTEXT = 5;

/** What MCM_HITTEST finds. */
export const MCHT_NOWHERE = 0;
export const MCHT_TITLE = 0x00010000;
const MCHT_CALENDAR = 0x00020000;
export const MCHT_TODAYLINK = 0x00030000;
const MCHT_NEXT = 0x01000000;
const MCHT_PREV = 0x02000000;
export const MCHT_TITLEMONTH = MCHT_TITLE | 1;
export const MCHT_TITLEYEAR = MCHT_TITLE | 2;
export const MCHT_TITLEBTNNEXT = (MCHT_TITLE | MCHT_NEXT | 3) >>> 0;
export const MCHT_TITLEBTNPREV = (MCHT_TITLE | MCHT_PREV | 3) >>> 0;
export const MCHT_CALENDARDATE = MCHT_CALENDAR | 1;
export const MCHT_CALENDARDATENEXT = (MCHT_CALENDARDATE | MCHT_NEXT) >>> 0;
export const MCHT_CALENDARDATEPREV = (MCHT_CALENDARDATE | MCHT_PREV) >>> 0;
const MCHT_CALENDARDAY = MCHT_CALENDAR | 2;
const MCHT_CALENDARWEEKNUM = MCHT_CALENDAR | 3;

/** MCHITTESTINFO: the first version's size, and version 6's with the place found. */
export const MCHITTESTINFO_V1_SIZE = 32;
export const MCHITTESTINFO_SIZE = 60;

/** The notifications, off MCN_FIRST (-746). */
export const MCN_SELECT = -746 >>> 0;
export const MCN_GETDAYSTATE = -747 >>> 0;
export const MCN_SELCHANGE = -749 >>> 0;

const WM_SIZE = 0x0005;
const WM_NOTIFY = 0x004e;
const WM_NOTIFYFORMAT = 0x0055;
const WM_STYLECHANGING = 0x007c;
const WM_STYLECHANGED = 0x007d;
const NF_QUERY = 3;
const NFR_UNICODE = 2;
const GWL_STYLE = -16;
const DLGC_WANTARROWS = 0x0001;
const VK_PRIOR = 0x21;
const VK_NEXT = 0x22;
const VK_END = 0x23;
const VK_HOME = 0x24;
const VK_LEFT = 0x25;
const VK_UP = 0x26;
const VK_RIGHT = 0x27;
const VK_DOWN = 0x28;

const COLOR_WINDOW = 5;
const COLOR_WINDOWTEXT = 8;
const COLOR_ACTIVECAPTION = 2;
const COLOR_CAPTIONTEXT = 9;
const COLOR_GRAYTEXT = 17;
/** Today's mark, as Windows draws it: red. */
const TODAY_MARK = 0x000000ff;

const DT_CENTER = 0x0001;
const DT_VCENTER = 0x0004;
const DT_SINGLELINE = 0x0020;

/** The styles a calendar is made with and keeps: what its selection and day states are. */
const FIXED_STYLES = MCS_MULTISELECT | MCS_DAYSTATE;
/** The most calendars a control shows. */
const MOST_CALENDARS = 12;
/** A run of days a multiple-selection calendar takes until told otherwise: a week. */
const DEFAULT_MAX_SELECTION = 7;
/** The space between calendars until MCM_SETCALENDARBORDER sets one. */
const DEFAULT_BORDER = 6;
/** The calendar MCM_GETCALID names: the Gregorian one. */
const CAL_GREGORIAN = 1;
const MCMV_MONTH = 0;

/** The LCTYPEs the calendar's text comes from. */
const LOCALE_SDAYNAME1 = 0x2a;
const LOCALE_SABBREVDAYNAME1 = 0x31;
const LOCALE_SMONTHNAME1 = 0x38;
const LOCALE_SABBREVMONTHNAME1 = 0x44;
const LOCALE_SSHORTESTDAYNAME1 = 0x60;
const LOCALE_SSHORTDATE = 0x1f;
const LOCALE_SYEARMONTH = 0x1006;
const LOCALE_IFIRSTDAYOFWEEK = 0x100c;

/** The label in front of today's date: comctl32's own string. */
const TODAY_LABEL = 'Today:';

/**
 * A SYSTEMTIME, field by field.
 *
 * @typedef {Object} Time
 * @property {number} year @property {number} month @property {number} dow
 * @property {number} day @property {number} hour @property {number} minute
 * @property {number} second @property {number} ms
 */

/**
 * What the control reads of the machine: the clock GetLocalTime reads and
 * the user's locale's answers to GetLocaleInfo. Absent, the calendar is the
 * host's clock and en-US.
 *
 * @typedef {Object} CalendarSources
 * @property {() => number} [localTime]  Milliseconds since 1970 on the local clock.
 * @property {(type: number) => string | null} [localeText]  GetLocaleInfoW's text.
 */

const MS_PER_DAY = 86_400_000;

/** The days of a month in the common years' order; February is the leap rule's. */
const MONTH_LENGTHS = Object.freeze([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);

/**
 * A month's length. September 1752, the month Britain moved to the Gregorian
 * calendar in, is the 19 days Windows' control gives it (test_monthrange).
 *
 * @param {number} year @param {number} month
 */
export const daysIn = (year, month)=>{
    if (year === 1752 && month === 9)
    {
        return 19;
    }
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return month === 2 && leap ? 29 : MONTH_LENGTHS[month - 1];
};

/** The day number of a date, from 1970. @param {number} year @param {number} month @param {number} day */
const dayNumber = (year, month, day)=>Math.floor(Date.UTC(year, month - 1, day) / MS_PER_DAY);

/** @param {number} number @returns {Time} the date a day number is, at midnight */
const dateOf = number=>{
    const date = new Date(number * MS_PER_DAY);
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, dow: date.getUTCDay(),
        day: date.getUTCDate(), hour: 0, minute: 0, second: 0, ms: 0 };
};

/** Sunday 0. @param {number} year @param {number} month @param {number} day */
const weekdayOf = (year, month, day)=>new Date(Date.UTC(year, month - 1, day)).getUTCDay();

/** The first day the calendar holds, and the last. */
const FIRST_DATE = dayNumber(1752, 9, 14);
const LAST_DATE = dayNumber(9999, 12, 31);

/** @param {Time} time  Whether it is a day of its month the calendar holds. */
export const isDate = time=>time.month >= 1 && time.month <= 12 && time.day >= 1
    && time.day <= daysIn(time.year, time.month)
    && dayNumber(time.year, time.month, time.day) >= FIRST_DATE
    && dayNumber(time.year, time.month, time.day) <= LAST_DATE;

/** @param {Time} time */
export const isTimeOfDay = time=>time.hour < 24 && time.minute < 60 && time.second < 60;

/** @param {Time} time */
const dayOf = time=>dayNumber(time.year, time.month, time.day);

/** @param {Time} a @param {Time} b  The order of two moments, to the millisecond. */
export const compareTimes = (a, b)=>dayOf(a) - dayOf(b) || a.hour - b.hour || a.minute - b.minute
    || a.second - b.second || a.ms - b.ms;

/** @param {Time} time @returns {Time} the same, its weekday the date's */
export const withWeekday = time=>({ ...time, dow: weekdayOf(time.year, time.month, time.day) });

/** @param {number} year @param {number} month  A month's index, to count months by. */
const monthIndex = (year, month)=>year * 12 + month - 1;

/** @param {number} index */
const monthAt = index=>({ year: Math.floor(index / 12), month: index % 12 + 1 });

/** @returns {Time} */
export const noTime = ()=>({ year: 0, month: 0, dow: 0, day: 0, hour: 0, minute: 0, second: 0,
    ms: 0 });

/**
 * MCM_SETRANGE's and DTM_SETRANGE's rule: the limits named replace both - a
 * limit not named is cleared - each a date, its time of day `clock`'s when it
 * is not one. Two limits the wrong way round are taken the right way.
 *
 * @param {[Time, Time]} given  The array the program handed in.
 * @param {[boolean, boolean]} named  Whether GDTR_MIN and GDTR_MAX are set.
 * @param {Time} clock  The time of day a limit without one takes.
 * @param {(time: Time) => boolean} [valid]  What a limit must be: a day the
 *     calendar holds, unless the control says otherwise.
 * @returns {{ min: Time | null, max: Time | null, given: [Time, Time] } | null}
 *     the limits, and the array as it is to be written back (a limit's time of
 *     day filled in); null when a named limit is not a date.
 */
export const takeRange = (given, named, clock, valid = isDate)=>{
    if (named.some((on, at)=>on && !valid(given[at])))
    {
        return null;
    }
    /** @type {[Time, Time]} */
    const limits = [given[0], given[1]];
    named.forEach((on, at)=>{
        if (on && !isTimeOfDay(limits[at]))
        {
            limits[at] = { ...limits[at], hour: clock.hour, minute: clock.minute,
                second: clock.second };
        }
    });
    let [low, high] = limits;
    if (named[0] && named[1] && compareTimes(high, low) < 0)
    {
        [low, high] = [high, low];
    }
    return { min: named[0] ? low : null, max: named[1] ? high : null, given: limits };
};

/**
 * A picture's month and year as pieces of their own, the text between them
 * as pieces too: the title is hit by part.
 *
 * @param {string} picture
 * @returns {{ kind: 'month' | 'year' | 'text', picture: string }[]}
 */
export const titlePieces = picture=>{
    /** @type {{ kind: 'month' | 'year' | 'text', picture: string }[]} */
    const pieces = [];
    let at = 0;
    while (at < picture.length)
    {
        const character = picture[at];
        if (character === 'M' || character === 'y')
        {
            let end = at;
            while (picture[end] === character)
            {
                end++;
            }
            pieces.push({ kind: character === 'M' ? 'month' : 'year',
                picture: picture.slice(at, end) });
            at = end;
            continue;
        }
        let end = at;
        while (end < picture.length && picture[end] !== 'M' && picture[end] !== 'y')
        {
            if (picture[end] === '\'')
            {
                const close = picture.indexOf('\'', end + 1);
                end = close < 0 ? picture.length : close + 1;
                continue;
            }
            end++;
        }
        const last = pieces[pieces.length - 1];
        if (last?.kind === 'text')
        {
            last.picture += picture.slice(at, end);
        }
        else
        {
            pieces.push({ kind: 'text', picture: picture.slice(at, end) });
        }
        at = end;
    }
    return pieces;
};

/**
 * The names a date is written with, in the user's locale: what
 * GetLocaleInfoW answers, en-US's where it answers nothing.
 *
 * @param {(type: number, fallback: string) => string} localeText
 * @returns {import('../kernel32/datetime-format.js').CalendarNames
 *     & { shortestDays: string[] }}
 */
export const calendarNames = localeText=>{
    const week = (/** @type {number} */ first, /** @type {readonly string[]} */ english)=>
        [6, 0, 1, 2, 3, 4, 5].map((at, day)=>localeText(first + at, english[day]));
    return {
        days: week(LOCALE_SDAYNAME1, DAYS),
        shortDays: week(LOCALE_SABBREVDAYNAME1, DAYS.map(day=>day.slice(0, 3))),
        shortestDays: week(LOCALE_SSHORTESTDAYNAME1, DAYS.map(day=>day.slice(0, 2))),
        months: MONTHS.map((month, at)=>localeText(LOCALE_SMONTHNAME1 + at, month)),
        shortMonths: MONTHS.map((month, at)=>localeText(LOCALE_SABBREVMONTHNAME1 + at,
            month.slice(0, 3))),
        genitive: null,
        am: 'AM',
        pm: 'PM',
        era: 'A.D.',
    };
};

/**
 * The local clock now, as GetLocalTime reads it.
 *
 * @param {CalendarSources} sources
 * @returns {Time}
 */
export const localNow = sources=>{
    const date = new Date(sources.localTime?.() ?? Date.now());
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, dow: date.getUTCDay(),
        day: date.getUTCDate(), hour: date.getUTCHours(), minute: date.getUTCMinutes(),
        second: date.getUTCSeconds(), ms: date.getUTCMilliseconds() };
};

/**
 * Builds the window procedure of a month calendar.
 *
 * @param {import('../user32/controls.js').ControlHost} host
 * @param {any} tk  The drawing helpers the system classes share.
 * @param {CalendarSources} [sources]
 * @returns {(record: any, message: import('../user32/controls.js').ControlMessage,
 *     thread?: unknown) => number | Promise<number>}
 */
export function createMonthCalProcedure(host, tk, sources = {}){
    const pointer = host.pointerSize ?? 4;
    /** NMHDR's size: a window, an id as wide as a pointer, the code. */
    const HEADER = pointer === 8 ? 24 : 12;

    /** @param {number} type @param {string} fallback */
    const localeText = (type, fallback)=>sources.localeText?.(type) || fallback;

    /** The names a date is written with, in the user's locale. */
    const names = ()=>calendarNames(localeText);

    /** The locale's first day of the week, Monday 0. */
    const localeFirstDay = ()=>{
        const day = Number.parseInt(localeText(LOCALE_IFIRSTDAYOFWEEK, '6'), 10);
        return day >= 0 && day <= 6 ? day : 6;
    };

    /** The local clock now, as GetLocalTime reads it. */
    const now = ()=>localNow(sources);

    /** @param {any} record */
    const state = record=>{
        const held = tk.stateOf(record);
        if (held.today === undefined)
        {
            held.today = now();
            /** @type {Time} */
            held.selection = { ...held.today };
            /** @type {Time} */
            held.selectionEnd = { ...held.today };
            held.first = monthIndex(held.today.year, held.today.month);
            held.colors = [COLOR_WINDOW, COLOR_WINDOWTEXT, COLOR_ACTIVECAPTION, COLOR_CAPTIONTEXT,
                COLOR_WINDOW, COLOR_GRAYTEXT].map(index=>host.sysColor(index));
            /** @type {number | null} the first day of the week a program set, Monday 0 */
            held.firstDay = null;
            held.delta = 0;
            held.maxSelection = DEFAULT_MAX_SELECTION;
            /** @type {Time | null} */
            held.min = null;
            /** @type {Time | null} */
            held.max = null;
            held.unicode = record.unicode === true;
            held.border = DEFAULT_BORDER;
            /** @type {Map<number, number>} a month's bold days, by month index */
            held.dayStates = new Map();
            /** @type {Time | null} the day a held-down button is over */
            held.tracking = null;
            /** @type {number | null} where a run of days being dragged started */
            held.anchor = null;
            held.metrics = null;
        }
        return held;
    };

    /** @param {any} record */
    const multiple = record=>(record.style & MCS_MULTISELECT) !== 0;

    /** @param {any} record  The first day of the week the grid starts on, Sunday 0. */
    const weekStart = record=>{
        const set = state(record).firstDay;
        const monday = set === null ? localeFirstDay() : ((set % 7) + 7) % 7;
        return (monday + 1) % 7;
    };

    /** @param {number} address @returns {Time} */
    const readTime = address=>{
        const view = new DataView(host.readMemory(wholeAddress(address), 16).buffer);
        const field = (/** @type {number} */ at)=>view.getUint16(at * 2, true);
        return { year: field(0), month: field(1), dow: field(2), day: field(3), hour: field(4),
            minute: field(5), second: field(6), ms: field(7) };
    };

    /** @param {number} address @param {Time} time */
    const writeTime = (address, time)=>{
        const bytes = new Uint8Array(16);
        const view = new DataView(bytes.buffer);
        [time.year, time.month, time.dow, time.day, time.hour, time.minute, time.second, time.ms]
            .forEach((value, at)=>view.setUint16(at * 2, value & 0xffff, true));
        host.writeMemory(wholeAddress(address), bytes);
    };

    /**
     * @param {number} address
     * @param {{ left: number, top: number, right: number, bottom: number }} rect
     */
    const writeRect = (address, rect)=>host.writeMemory(wholeAddress(address), new Uint8Array(
        new Int32Array([rect.left, rect.top, rect.right, rect.bottom]).buffer));

    /** @param {number} address */
    const readI32 = address=>new DataView(host.readMemory(wholeAddress(address), 4).buffer)
        .getInt32(0, true);

    /** @param {number} address @param {number} value */
    const writeI32 = (address, value)=>host.writeMemory(wholeAddress(address),
        new Uint8Array(new Int32Array([value]).buffer));

    /**
     * The sizes everything is laid out in, measured in the control's font:
     * a row's height, a day's width, a calendar's size and the space the
     * window's frame takes.
     *
     * @param {any} record
     */
    const metrics = record=>{
        const held = state(record);
        const key = `${record.font ?? 0}:${record.style & (MCS_WEEKNUMBERS | MCS_NOTODAY)}`;
        if (held.metrics?.key === key)
        {
            return held.metrics;
        }
        const written = names();
        const picture = localeText(LOCALE_SYEARMONTH, 'MMMM, yyyy');
        /** @type {(text: string) => { width: number, height: number }} */
        let measure = text=>({ width: text.length * 8, height: 16 });
        let release = ()=>{};
        if (host.draw)
        {
            const draw = host.draw;
            const { hdc } = host.contextOn(record);
            measure = text=>draw.measure(hdc, text);
            release = ()=>host.endPaint(record, hdc);
        }
        try
        {
            const text = measure('0');
            const row = text.height + 2;
            const digits = measure('00').width;
            const dayNames = written.shortestDays.map(name=>measure(name).width);
            const button = row;
            const widestTitle = Math.max(...written.months.map((month, at)=>
                measure(renderDate(picture, { year: 2000, month: at + 1, day: 1, weekday: 0,
                    hour: 0, minute: 0, second: 0 }, { ...written })).width));
            const columns = (record.style & MCS_WEEKNUMBERS) !== 0 ? 8 : 7;
            const day = Math.max(digits + 6, ...dayNames.map(width=>width + 4),
                Math.ceil((widestTitle + 2 * button + 4 * text.width) / columns));
            const width = columns * day;
            const height = 9 * row;
            const today = (record.style & MCS_NOTODAY) !== 0 ? 0 : row;
            /** The title's month names and the text around them, measured once. */
            const titleWidths = new Map();
            for (let month = 1; month <= 12; month++)
            {
                for (const piece of titlePieces(picture))
                {
                    if (piece.kind !== 'year')
                    {
                        const rendered = renderDate(piece.picture, { year: 2000, month, day: 1,
                            weekday: 0, hour: 0, minute: 0, second: 0 }, written);
                        titleWidths.set(rendered, measure(rendered).width);
                    }
                }
            }
            held.metrics = {
                key, row, day, width, height, today, button, picture, names: written,
                weeks: columns === 8 ? day : 0, titleWidths, digitWidth: text.width,
            };
            return held.metrics;
        }
        finally
        {
            release();
        }
    };

    /**
     * A piece of the title's width: a month's name as measured, a year its
     * digits'.
     *
     * @param {any} record @param {string} text
     */
    const titleWidth = (record, text)=>{
        const sizes = metrics(record);
        return sizes.titleWidths.get(text) ?? text.length * sizes.digitWidth;
    };

    /**
     * The calendars' grid in the client area: how many across and down, and
     * where it starts, centred.
     *
     * @param {any} record
     */
    const grid = record=>{
        const sizes = metrics(record);
        const held = state(record);
        const client = host.clientSize(record);
        const gap = held.border;
        let columns = Math.max(1, Math.floor((client.width + gap) / (sizes.width + gap)));
        let rows = Math.max(1, Math.floor((client.height - sizes.today + gap)
            / (sizes.height + gap)));
        columns = Math.min(columns, MOST_CALENDARS);
        rows = Math.min(rows, Math.floor(MOST_CALENDARS / columns));
        const width = columns * sizes.width + (columns - 1) * gap;
        const height = rows * sizes.height + (rows - 1) * gap + sizes.today;
        return {
            columns, rows, count: columns * rows, gap, width, height,
            left: Math.max(0, Math.floor((client.width - width) / 2)),
            top: Math.max(0, Math.floor((client.height - height) / 2)),
            client,
        };
    };

    /**
     * Draws the calendar again now, not at the queue's next look: what
     * Windows' calendar does when a program changes its selection or today.
     *
     * @param {any} record @param {unknown} thread
     */
    const repaint = (record, thread)=>{
        host.invalidate(record);
        return host.update?.(record, thread) ?? 0;
    };

    /** @param {any} record  How many calendars are shown. */
    const calendarCount = record=>grid(record).count;

    /**
     * The first day a month's six weeks show: a day of the month before,
     * a whole week of it when the month starts on the week's first day.
     *
     * @param {any} record @param {number} index  The month's index.
     */
    const gridStart = (record, index)=>{
        const { year, month } = monthAt(index);
        const lead = (weekdayOf(year, month, 1) - weekStart(record) + 7) % 7 || 7;
        return dayNumber(year, month, 1) - lead;
    };

    /** @param {any} record @param {Time} time  Shows a month that holds a day, if none does. */
    const reveal = (record, time)=>{
        const held = state(record);
        const index = monthIndex(time.year, time.month);
        const count = calendarCount(record);
        if (index < held.first || index >= held.first + count)
        {
            held.first = index;
            return true;
        }
        return false;
    };

    /** @param {any} record @param {Time} time  Whether a day is inside MCM_SETRANGE's limits. */
    const allowed = (record, time)=>{
        const held = state(record);
        return (held.min === null || dayOf(time) >= dayOf(held.min))
            && (held.max === null || dayOf(time) <= dayOf(held.max));
    };

    /**
     * Sends a WM_NOTIFY, the structure in guest memory while it is answered.
     *
     * @param {any} record @param {number} code @param {number} size
     * @param {(block: number) => void} fill @param {unknown} thread
     * @param {(block: number) => void} [read]
     */
    const notify = (record, code, size, fill, thread, read)=>{
        const to = notifyWindow(record);
        const block = to !== 0 ? host.allocate?.(size) ?? 0 : 0;
        if (block === 0)
        {
            return 0;
        }
        host.writeMemory(block, new Uint8Array(size));
        writeI32(block, record.hwnd);
        writeI32(block + pointer, record.id);
        writeI32(block + 2 * pointer, code);
        fill(block);
        return after(host.send(to, WM_NOTIFY, record.id, block, thread), answer=>{
            read?.(block);
            host.release?.(block);
            return answer;
        });
    };

    /**
     * MCN_SELCHANGE or MCN_SELECT: the selection's first and last day as
     * dates alone; one day's end is left empty (Wine's test_sel_notify).
     *
     * @param {any} record @param {number} code @param {unknown} thread
     */
    const tellSelection = (record, code, thread)=>{
        const held = state(record);
        /** @param {Time} time */
        const dateOnly = time=>({ ...noTime(), year: time.year, month: time.month, day: time.day });
        return notify(record, code, HEADER + 32, block=>{
            writeTime(block + HEADER, dateOnly(held.selection));
            if (multiple(record))
            {
                writeTime(block + HEADER + 16, dateOnly(held.selectionEnd));
            }
        }, thread);
    };

    /**
     * MCN_GETDAYSTATE: a MCS_DAYSTATE calendar asks for the bold days of every
     * month it shows a day of, and keeps what the parent answers.
     *
     * @param {any} record @param {unknown} thread
     */
    const askDayStates = (record, thread)=>{
        if ((record.style & MCS_DAYSTATE) === 0)
        {
            return 0;
        }
        const held = state(record);
        const count = calendarCount(record) + 2;
        const start = dateOf(gridStart(record, held.first));
        // NMDAYSTATE: the header, stStart, cDayState and prgDayState, after
        // which the control's own array goes, for a parent that fills it.
        const states = HEADER + 16 + 4 + (pointer === 8 ? 4 : 0);
        const array = states + pointer;
        return notify(record, MCN_GETDAYSTATE, array + count * 4, block=>{
            writeTime(block + HEADER, start);
            writeI32(block + HEADER + 16, count);
            writeI32(states + block, block + array);
        }, thread, block=>{
            const given = readI32(block + states) >>> 0;
            if (given === 0)
            {
                return;
            }
            for (let at = 0; at < count; at++)
            {
                held.dayStates.set(held.first - 1 + at, readI32(given + at * 4) >>> 0);
            }
        });
    };

    /**
     * Moves the grid by months, as the title's buttons and the keys do, and
     * asks for the new months' day states.
     *
     * @param {any} record @param {number} months @param {unknown} thread
     */
    const scroll = (record, months, thread)=>{
        const held = state(record);
        const first = Math.max(monthIndex(1752, 9), Math.min(monthIndex(9999, 12),
            held.first + months));
        if (first === held.first)
        {
            return 0;
        }
        held.first = first;
        host.invalidate(record);
        return askDayStates(record, thread);
    };

    /**
     * What is at a point of the client area, and where it is.
     *
     * @param {any} record @param {{ x: number, y: number }} point
     * @returns {{ hit: number, date?: Time, calendar?: number, row?: number, column?: number,
     *     rect?: { left: number, top: number, right: number, bottom: number } }}
     */
    const hitTest = (record, point)=>{
        const held = state(record);
        const sizes = metrics(record);
        const place = grid(record);
        const { row, day } = sizes;
        const inside = point.x >= place.left && point.x < place.left + place.width;
        const todayTop = place.top + place.height - sizes.today;
        if (sizes.today > 0 && inside && point.y >= todayTop && point.y < todayTop + row)
        {
            return { hit: MCHT_TODAYLINK, rect: { left: place.left, top: todayTop,
                right: place.left + place.width, bottom: todayTop + row } };
        }
        const across = point.x - place.left;
        const down = point.y - place.top;
        const column = Math.floor(across / (sizes.width + place.gap));
        const line = Math.floor(down / (sizes.height + place.gap));
        const x = across - column * (sizes.width + place.gap);
        const y = down - line * (sizes.height + place.gap);
        if (across < 0 || down < 0 || column >= place.columns || line >= place.rows
            || x >= sizes.width || y >= sizes.height)
        {
            return { hit: MCHT_NOWHERE };
        }
        const calendar = line * place.columns + column;
        const index = held.first + calendar;
        const left = place.left + column * (sizes.width + place.gap);
        const top = place.top + line * (sizes.height + place.gap);
        if (y < 2 * row)
        {
            const title = { left, top, right: left + sizes.width, bottom: top + 2 * row };
            const margin = Math.ceil(sizes.digitWidth / 2);
            if (calendar === 0 && x >= margin && x < margin + sizes.button)
            {
                return { hit: MCHT_TITLEBTNPREV, calendar, rect: title };
            }
            if (calendar === place.columns - 1 && x >= sizes.width - margin - sizes.button
                && x < sizes.width - margin)
            {
                return { hit: MCHT_TITLEBTNNEXT, calendar, rect: title };
            }
            const piece = titleLayout(record, index).find(part=>x >= part.left && x < part.right);
            const hit = piece?.kind === 'month' ? MCHT_TITLEMONTH
                : piece?.kind === 'year' ? MCHT_TITLEYEAR : MCHT_TITLE;
            return { hit, calendar, rect: title };
        }
        const cell = Math.floor((x - sizes.weeks) / day);
        if (y < 3 * row)
        {
            return x < sizes.weeks ? { hit: MCHT_CALENDAR, calendar }
                : { hit: MCHT_CALENDARDAY, calendar, column: cell };
        }
        const week = Math.floor((y - 3 * row) / row);
        if (x < sizes.weeks)
        {
            return { hit: MCHT_CALENDARWEEKNUM, calendar, row: week };
        }
        const date = dateOf(gridStart(record, index) + week * 7 + cell);
        const rect = { left: left + sizes.weeks + cell * day, top: top + (3 + week) * row,
            right: left + sizes.weeks + (cell + 1) * day, bottom: top + (4 + week) * row };
        const shown = monthIndex(date.year, date.month);
        const trailing = (record.style & MCS_NOTRAILINGDATES) !== 0;
        if (shown < index)
        {
            return calendar === 0 && !trailing
                ? { hit: MCHT_CALENDARDATEPREV, date, calendar, row: week, column: cell, rect }
                : { hit: MCHT_CALENDAR, calendar };
        }
        if (shown > index)
        {
            return calendar === place.count - 1 && !trailing
                ? { hit: MCHT_CALENDARDATENEXT, date, calendar, row: week, column: cell, rect }
                : { hit: MCHT_CALENDAR, calendar };
        }
        return { hit: MCHT_CALENDARDATE, date, calendar, row: week, column: cell, rect };
    };

    /**
     * A calendar's title, piece by piece across the calendar: the month, the
     * year and the text between them in the locale's year-and-month picture,
     * centred between the buttons.
     *
     * @param {any} record @param {number} index  The month's index.
     */
    const titleLayout = (record, index)=>{
        const sizes = metrics(record);
        const { year, month } = monthAt(index);
        const when = { year, month, day: 1, weekday: weekdayOf(year, month, 1), hour: 0,
            minute: 0, second: 0 };
        const pieces = titlePieces(sizes.picture).map(piece=>{
            const text = renderDate(piece.picture, when, sizes.names);
            return { kind: piece.kind, text, width: titleWidth(record, text) };
        });
        const total = pieces.reduce((sum, piece)=>sum + piece.width, 0);
        let x = Math.floor((sizes.width - total) / 2);
        return pieces.map(piece=>{
            const left = x;
            x += piece.width;
            return { ...piece, left, right: x };
        });
    };

    /** @param {any} record  The today line's text. */
    const todayText = record=>{
        const held = state(record);
        const today = held.today;
        const sizes = metrics(record);
        const text = isDate(today) ? renderDate(localeText(LOCALE_SSHORTDATE, 'M/d/yyyy'),
            { year: today.year, month: today.month, day: today.day, weekday: today.dow,
                hour: 0, minute: 0, second: 0 }, sizes.names) : '';
        return `${TODAY_LABEL} ${text}`;
    };

    /** @param {any} record @param {number} hdc */
    const paint = (record, hdc)=>{
        const draw = /** @type {any} */ (host.draw);
        const held = state(record);
        const sizes = metrics(record);
        const place = grid(record);
        const [background, text, titleBack, titleText, monthBack, trailingText] = held.colors;
        const { row, day } = sizes;
        draw.fill(hdc, { left: 0, top: 0, right: place.client.width,
            bottom: place.client.height }, background);
        const today = isDate(held.today) ? dayOf(held.today) : null;
        const chosen = held.tracking ? [dayOf(held.tracking), dayOf(held.tracking)]
            : [dayOf(held.selection), dayOf(multiple(record) ? held.selectionEnd : held.selection)];
        const weekdays = sizes.names.shortestDays;
        for (let calendar = 0; calendar < place.count; calendar++)
        {
            const column = calendar % place.columns;
            const line = Math.floor(calendar / place.columns);
            const left = place.left + column * (sizes.width + place.gap);
            const top = place.top + line * (sizes.height + place.gap);
            const index = held.first + calendar;
            draw.fill(hdc, { left, top, right: left + sizes.width, bottom: top + sizes.height },
                monthBack);
            draw.fill(hdc, { left, top, right: left + sizes.width, bottom: top + 2 * row },
                titleBack);
            for (const piece of titleLayout(record, index))
            {
                tk.drawText(hdc, piece.text, { left: left + piece.left, top,
                    right: left + piece.right, bottom: top + 2 * row },
                DT_SINGLELINE | DT_VCENTER, titleText);
            }
            const margin = Math.ceil(sizes.digitWidth / 2);
            const middle = top + row;
            const half = Math.max(2, Math.floor(row / 4));
            if (calendar === 0)
            {
                arrow(hdc, left + margin + Math.floor(sizes.button / 2) - Math.floor(half / 2),
                    middle, half, -1, titleText);
            }
            if (calendar === place.columns - 1)
            {
                arrow(hdc, left + sizes.width - margin - Math.floor(sizes.button / 2)
                    + Math.floor(half / 2), middle, half, 1, titleText);
            }
            for (let cell = 0; cell < 7; cell++)
            {
                const x = left + sizes.weeks + cell * day;
                tk.drawText(hdc, weekdays[(weekStart(record) + cell) % 7],
                    { left: x, top: top + 2 * row, right: x + day, bottom: top + 3 * row },
                    DT_SINGLELINE | DT_VCENTER | DT_CENTER, titleBack);
            }
            draw.fill(hdc, { left: left + sizes.weeks, top: top + 3 * row - 1,
                right: left + sizes.width, bottom: top + 3 * row }, text);
            const start = gridStart(record, index);
            for (let at = 0; at < 42; at++)
            {
                const number = start + at;
                const date = dateOf(number);
                const own = monthIndex(date.year, date.month) === index;
                const trailing = !own && (record.style & MCS_NOTRAILINGDATES) === 0
                    && ((number < start + 7 && calendar === 0)
                        || (number >= start + 7 && calendar === place.count - 1));
                if (!own && !trailing)
                {
                    continue;
                }
                const x = left + sizes.weeks + (at % 7) * day;
                const y = top + (3 + Math.floor(at / 7)) * row;
                const cell = { left: x, top: y, right: x + day, bottom: y + row };
                const selected = own && number >= chosen[0] && number <= chosen[1];
                if (selected)
                {
                    draw.fill(hdc, cell, titleBack);
                }
                const ink = selected ? titleText : own ? text : trailingText;
                const label = String(date.day);
                tk.drawText(hdc, label, cell, DT_SINGLELINE | DT_VCENTER | DT_CENTER, ink);
                if (own && ((held.dayStates.get(index) ?? 0) >>> (date.day - 1) & 1) !== 0)
                {
                    tk.drawText(hdc, label, { ...cell, left: cell.left + 1, right: cell.right + 1 },
                        DT_SINGLELINE | DT_VCENTER | DT_CENTER, ink);
                }
                if (number === today && (record.style & MCS_NOTODAYCIRCLE) === 0)
                {
                    tk.edge(hdc, cell, TODAY_MARK, TODAY_MARK);
                }
            }
            if (sizes.weeks > 0)
            {
                for (let week = 0; week < 6; week++)
                {
                    const date = dateOf(start + week * 7);
                    const y = top + (3 + week) * row;
                    tk.drawText(hdc, String(weekNumber(date)), { left, top: y,
                        right: left + sizes.weeks, bottom: y + row },
                    DT_SINGLELINE | DT_VCENTER | DT_CENTER, titleBack);
                }
            }
        }
        if (sizes.today > 0)
        {
            const y = place.top + place.height - sizes.today;
            let x = place.left + sizes.digitWidth;
            if ((record.style & MCS_NOTODAYCIRCLE) === 0)
            {
                tk.edge(hdc, { left: x, top: y + 2, right: x + day, bottom: y + row - 2 },
                    TODAY_MARK, TODAY_MARK);
                x += day + sizes.digitWidth;
            }
            tk.drawText(hdc, todayText(record), { left: x, top: y,
                right: place.left + place.width, bottom: y + row },
            DT_SINGLELINE | DT_VCENTER, text);
        }
        return 0;
    };

    /**
     * A filled triangle pointing left (-1) or right (1), its point `size`
     * from its base.
     *
     * @param {number} hdc @param {number} x @param {number} y @param {number} size
     * @param {number} way @param {number} rgb
     */
    const arrow = (hdc, x, y, size, way, rgb)=>{
        const draw = /** @type {any} */ (host.draw);
        for (let step = 0; step < size; step++)
        {
            const at = x + way * step;
            const reach = size - step;
            draw.fill(hdc, { left: at, top: y - reach, right: at + 1, bottom: y + reach }, rgb);
        }
    };

    /** @param {Time} date  The week of the year a week's first day is in: Jan 1's is the first. */
    const weekNumber = date=>{
        const sunday = dayOf(date) + 6;
        const end = dateOf(sunday);
        return Math.floor((sunday - dayNumber(end.year, 1, 1) + weekdayOf(end.year, 1, 1)) / 7) + 1;
    };

    /**
     * A person chose a day: the selection moves to it - a run of days from
     * where a drag began - and is shown.
     *
     * @param {any} record @param {Time} date
     */
    const choose = (record, date)=>{
        const held = state(record);
        if (!allowed(record, date))
        {
            return false;
        }
        if (multiple(record))
        {
            const anchor = held.anchor ?? dayOf(date);
            const reach = held.maxSelection - 1;
            const end = Math.max(anchor - reach, Math.min(anchor + reach, dayOf(date)));
            const [from, to] = end < anchor ? [end, anchor] : [anchor, end];
            const changed = from !== dayOf(held.selection) || to !== dayOf(held.selectionEnd);
            held.selection = { ...dateOf(from), hour: held.selection.hour,
                minute: held.selection.minute, second: held.selection.second,
                ms: held.selection.ms };
            held.selectionEnd = { ...dateOf(to), hour: held.selectionEnd.hour,
                minute: held.selectionEnd.minute, second: held.selectionEnd.second,
                ms: held.selectionEnd.ms };
            return changed;
        }
        const changed = dayOf(date) !== dayOf(held.selection);
        held.selection = withWeekday({ ...held.selection, year: date.year, month: date.month,
            day: date.day });
        return changed;
    };

    /**
     * MCM_SETRANGE: the limits named replace both - a limit not named is
     * cleared - each a date, its time of day today's when it is not one
     * (written back to the caller's array, the milliseconds as they were).
     * Two limits the wrong way round are taken the right way.
     *
     * @param {any} record @param {number} flags @param {number} address
     */
    const setRange = (record, flags, address)=>{
        const held = state(record);
        if (address === 0)
        {
            return 0;
        }
        const given = /** @type {[Time, Time]} */ ([readTime(address), readTime(address + 16)]);
        const named = /** @type {[boolean, boolean]} */ (
            [GDTR_MIN, GDTR_MAX].map(flag=>(flags & flag) !== 0));
        const taken = takeRange(given, named, held.today);
        if (!taken)
        {
            return 0;
        }
        taken.given.forEach((limit, at)=>{
            if (limit !== given[at])
            {
                writeTime(address + at * 16, limit);
            }
        });
        held.min = taken.min;
        held.max = taken.max;
        host.invalidate(record);
        return 1;
    };

    /**
     * MCM_SETSELRANGE: a run of days, the earlier first, no longer than the
     * most a person may select and inside the limits.
     *
     * @param {any} record @param {number} address
     */
    const setSelectionRange = (record, address)=>{
        const held = state(record);
        if (!multiple(record) || address === 0)
        {
            return 0;
        }
        let [from, to] = [readTime(address), readTime(address + 16)];
        if (!isDate(from) || !isDate(to))
        {
            return 0;
        }
        if (dayOf(to) < dayOf(from))
        {
            [from, to] = [to, from];
        }
        if (dayOf(to) - dayOf(from) + 1 > held.maxSelection || !allowed(record, from)
            || !allowed(record, to))
        {
            return 0;
        }
        held.selection = withWeekday(from);
        held.selectionEnd = withWeekday(to);
        reveal(record, held.selection);
        host.invalidate(record);
        return 1;
    };

    /**
     * MCM_SETCURSEL: one day, checked as a date and against the limits - the
     * day already selected is always taken - its time of day kept as given.
     * The calendar is drawn again there and then (Wine's monthcal_curr_date_seq).
     *
     * @param {any} record @param {number} address @param {unknown} thread
     */
    const setSelection = (record, address, thread)=>{
        const held = state(record);
        if (multiple(record) || address === 0)
        {
            return 0;
        }
        const time = readTime(address);
        if (!isDate(time))
        {
            return 0;
        }
        if (dayOf(time) !== dayOf(held.selection) && !allowed(record, time))
        {
            return 0;
        }
        held.selection = withWeekday(time);
        held.selectionEnd = { ...held.selection };
        reveal(record, held.selection);
        return after(repaint(record, thread), ()=>1);
    };

    /**
     * MCM_GETMONTHRANGE: the months shown whole, or every day shown, and how
     * many months either touches.
     *
     * @param {any} record @param {number} which @param {number} address
     */
    const monthRange = (record, which, address)=>{
        const held = state(record);
        const count = calendarCount(record);
        const lastIndex = held.first + count - 1;
        let from;
        let to;
        let months = count;
        if ((which & GMR_DAYSTATE) !== 0)
        {
            from = dateOf(gridStart(record, held.first));
            to = dateOf(gridStart(record, lastIndex) + 41);
            months = count + 2;
        }
        else
        {
            const first = monthAt(held.first);
            const last = monthAt(lastIndex);
            from = dateOf(Math.max(FIRST_DATE, dayNumber(first.year, first.month, 1)));
            to = withWeekday({ ...noTime(), year: last.year, month: last.month,
                day: daysIn(last.year, last.month) });
        }
        if (address !== 0)
        {
            writeTime(address, from);
            writeTime(address + 16, to);
        }
        return months;
    };

    /**
     * MCM_HITTEST: what is at the point, the day there if it is one; version
     * 6's structure also gets the place - which calendar, row and column, and
     * the rectangle of what was hit.
     *
     * @param {any} record @param {number} address
     */
    const hitTestInfo = (record, address)=>{
        if (address === 0)
        {
            return -1;
        }
        const size = readI32(address) >>> 0;
        if (size < MCHITTESTINFO_V1_SIZE)
        {
            return -1;
        }
        const point = { x: readI32(address + 4), y: readI32(address + 8) };
        const found = hitTest(record, point);
        writeI32(address + 12, found.hit);
        if (found.date)
        {
            writeTime(address + 16, found.date);
        }
        if ((record.controlsVersion ?? 5) >= 6 && size >= MCHITTESTINFO_SIZE)
        {
            if (found.hit === MCHT_NOWHERE)
            {
                const client = host.clientSize(record);
                writeRect(address + 32, { left: 0, top: 0, right: client.width,
                    bottom: client.height });
            }
            else
            {
                if (found.rect)
                {
                    writeRect(address + 32, found.rect);
                }
                writeI32(address + 48, found.calendar ?? 0);
                writeI32(address + 52, found.row ?? -1);
                writeI32(address + 56, found.column ?? -1);
            }
        }
        return found.hit;
    };

    /**
     * The window a calendar needs for a grid of calendars: one, or as many as
     * fit a rectangle, in the frame the window has.
     *
     * @param {any} record @param {number} columns @param {number} rows
     */
    const neededSize = (record, columns, rows)=>{
        const sizes = metrics(record);
        const gap = state(record).border;
        const frame = frameOf(record);
        return {
            width: columns * sizes.width + (columns - 1) * gap + frame.width,
            height: rows * sizes.height + (rows - 1) * gap + sizes.today + frame.height,
        };
    };

    /** @param {any} record  What the window's frame takes of its size. */
    const frameOf = record=>{
        const client = host.clientSize(record);
        return { width: Math.max(0, (record.width ?? 0) - client.width),
            height: Math.max(0, (record.height ?? 0) - client.height) };
    };

    /**
     * A key moves the selection, a day, a week or a month, and the grid with
     * it when it leaves the months shown.
     *
     * @param {any} record @param {number} key @param {unknown} thread
     */
    const keyDown = (record, key, thread)=>{
        const held = state(record);
        const from = held.selection;
        let target = dayOf(from);
        switch (key){
            case VK_LEFT: target -= 1; break;
            case VK_RIGHT: target += 1; break;
            case VK_UP: target -= 7; break;
            case VK_DOWN: target += 7; break;
            case VK_HOME: target = dayNumber(from.year, from.month, 1); break;
            case VK_END: target = dayNumber(from.year, from.month, daysIn(from.year, from.month));
                break;
            case VK_PRIOR: case VK_NEXT: {
                const index = monthIndex(from.year, from.month) + (key === VK_PRIOR ? -1 : 1);
                const { year, month } = monthAt(index);
                target = dayNumber(year, month, Math.min(from.day, daysIn(year, month)));
                break;
            }
            default:
                return 0;
        }
        const date = dateOf(target);
        if (!isDate(date))
        {
            return 0;
        }
        held.anchor = null;
        if (!choose(record, date))
        {
            return 0;
        }
        const moved = reveal(record, date);
        host.invalidate(record);
        return after(moved ? askDayStates(record, thread) : 0,
            ()=>tellSelection(record, MCN_SELCHANGE, thread));
    };

    /**
     * @param {any} record @param {import('../user32/controls.js').ControlMessage} message
     * @param {unknown} [thread]
     */
    return (record, message, thread)=>{
        const held = state(record);
        const id = message.message >>> 0;
        const wParam = message.wParam >>> 0;
        const lParam = message.lParam >>> 0;
        if (VERSION_6_MESSAGES.has(id) && (record.controlsVersion ?? 5) < 6)
        {
            return tk.common(record, message, thread);
        }
        switch (id){
            case WM_CREATE: {
                // It asks its parent which notifications it takes and starts
                // in the parent's font (Wine's create_monthcal_control_seq).
                const to = notifyWindow(record);
                return after(to !== 0 ? host.send(to, WM_NOTIFYFORMAT, record.hwnd, NF_QUERY,
                    thread) : 0, format=>{
                    if (to !== 0)
                    {
                        held.unicode = format === NFR_UNICODE;
                    }
                    return after(to !== 0 ? host.send(to, WM_GETFONT, 0, 0, thread) : 0, font=>{
                        if ((font >>> 0) !== 0)
                        {
                            record.font = font >>> 0;
                        }
                        return after(askDayStates(record, thread),
                            ()=>tk.common(record, message, thread));
                    });
                });
            }
            case WM_PAINT:
                return tk.painting(record, (/** @type {number} */ hdc)=>paint(record, hdc));
            case WM_ERASEBKGND:
                return 1;
            case WM_SIZE:
                host.invalidate(record);
                return 0;
            case WM_SETFONT:
                held.metrics = null;
                return tk.common(record, message, thread);
            case WM_GETDLGCODE:
                return DLGC_WANTARROWS;
            case WM_STYLECHANGING:
                // Whether it selects runs of days and keeps day states is
                // fixed when it is made (Wine's test_maxselday, test_daystate).
                if ((message.wParam | 0) === GWL_STYLE && lParam !== 0)
                {
                    const old = readI32(lParam) >>> 0;
                    const wanted = readI32(lParam + 4) >>> 0;
                    writeI32(lParam + 4, (wanted & ~FIXED_STYLES) | (old & FIXED_STYLES));
                }
                return 0;
            case WM_STYLECHANGED:
                held.metrics = null;
                host.invalidate(record);
                return 0;
            case WM_KEYDOWN:
                return keyDown(record, wParam, thread);
            case WM_LBUTTONDOWN: {
                const point = { x: (lParam << 16) >> 16, y: lParam >> 16 };
                const found = hitTest(record, point);
                return after(host.setFocus(record.hwnd, thread), ()=>{
                    switch (found.hit){
                        case MCHT_TITLEBTNPREV:
                        case MCHT_TITLEBTNNEXT: {
                            const step = held.delta || calendarCount(record);
                            return after(scroll(record, found.hit === MCHT_TITLEBTNPREV
                                ? -step : step, thread), ()=>0);
                        }
                        case MCHT_TITLEMONTH:
                        case MCHT_TITLEYEAR:
                            host.divergence?.('SysMonthCal32',
                                'the title\'s month menu and year spinner are not offered');
                            return 0;
                        case MCHT_TODAYLINK: {
                            // Today chosen at once - the press ends as it
                            // starts - and shown there and then (Wine's
                            // monthcal_todaylink_seq).
                            if (!isDate(held.today))
                            {
                                return 0;
                            }
                            host.setCapture(record.hwnd);
                            held.anchor = null;
                            choose(record, held.today);
                            const moved = reveal(record, held.today);
                            host.releaseCapture();
                            return after(repaint(record, thread), ()=>after(
                                moved ? askDayStates(record, thread) : 0,
                                ()=>after(tellSelection(record, MCN_SELCHANGE, thread),
                                    ()=>after(tellSelection(record, MCN_SELECT, thread), ()=>0))));
                        }
                        case MCHT_CALENDARDATE:
                        case MCHT_CALENDARDATEPREV:
                        case MCHT_CALENDARDATENEXT: {
                            const date = /** @type {Time} */ (found.date);
                            if (!allowed(record, date))
                            {
                                return 0;
                            }
                            host.setCapture(record.hwnd);
                            if (!multiple(record))
                            {
                                // One day is chosen when the button comes up.
                                held.tracking = date;
                                host.invalidate(record);
                                return 0;
                            }
                            held.anchor = dayOf(date);
                            held.tracking = null;
                            choose(record, date);
                            held.dragging = true;
                            host.invalidate(record);
                            return after(tellSelection(record, MCN_SELCHANGE, thread), ()=>0);
                        }
                        default:
                            return 0;
                    }
                });
            }
            case WM_MOUSEMOVE: {
                if (!held.tracking && !held.dragging)
                {
                    return 0;
                }
                const found = hitTest(record, { x: (lParam << 16) >> 16, y: lParam >> 16 });
                if (!found.date || (found.hit & MCHT_CALENDARDATE) !== MCHT_CALENDARDATE)
                {
                    return 0;
                }
                if (held.tracking)
                {
                    held.tracking = found.date;
                    host.invalidate(record);
                    return 0;
                }
                if (!choose(record, found.date))
                {
                    return 0;
                }
                host.invalidate(record);
                return after(tellSelection(record, MCN_SELCHANGE, thread), ()=>0);
            }
            case WM_LBUTTONUP: {
                const tracked = held.tracking;
                const dragged = held.dragging === true;
                held.tracking = null;
                held.dragging = false;
                if (host.capture() === record.hwnd)
                {
                    host.releaseCapture();
                }
                if (dragged)
                {
                    return after(tellSelection(record, MCN_SELECT, thread), ()=>0);
                }
                if (!tracked)
                {
                    return 0;
                }
                const changed = choose(record, tracked);
                const moved = reveal(record, tracked);
                host.invalidate(record);
                return after(moved ? askDayStates(record, thread) : 0,
                    ()=>after(changed ? tellSelection(record, MCN_SELCHANGE, thread) : 0,
                        ()=>after(tellSelection(record, MCN_SELECT, thread), ()=>0)));
            }
            case WM_CAPTURECHANGED:
                if (held.tracking || held.dragging)
                {
                    held.tracking = null;
                    held.dragging = false;
                    host.invalidate(record);
                }
                return 0;
            case MCM_GETCURSEL:
                if (multiple(record) || lParam === 0)
                {
                    return 0;
                }
                writeTime(lParam, held.selection);
                return 1;
            case MCM_SETCURSEL:
                return setSelection(record, lParam, thread);
            case MCM_GETMAXSELCOUNT:
                return multiple(record) ? held.maxSelection : 1;
            case MCM_SETMAXSELCOUNT:
                if (!multiple(record) || (message.wParam | 0) <= 0)
                {
                    return 0;
                }
                held.maxSelection = message.wParam | 0;
                return 1;
            case MCM_GETSELRANGE:
                if (!multiple(record) || lParam === 0)
                {
                    return 0;
                }
                writeTime(lParam, held.selection);
                writeTime(lParam + 16, held.selectionEnd);
                return 1;
            case MCM_SETSELRANGE:
                return setSelectionRange(record, lParam);
            case MCM_GETMONTHRANGE:
                return monthRange(record, wParam, lParam);
            case MCM_SETDAYSTATE: {
                // Only a MCS_DAYSTATE calendar keeps day states, one for every
                // month it shows a day of.
                const count = message.wParam | 0;
                if ((record.style & MCS_DAYSTATE) === 0 || lParam === 0
                    || count !== calendarCount(record) + 2)
                {
                    return 0;
                }
                for (let at = 0; at < count; at++)
                {
                    held.dayStates.set(held.first - 1 + at, readI32(lParam + at * 4) >>> 0);
                }
                host.invalidate(record);
                return 1;
            }
            case MCM_GETMINREQRECT: {
                if (lParam === 0)
                {
                    return 0;
                }
                const size = neededSize(record, 1, 1);
                writeRect(lParam, { left: 0, top: 0, right: size.width, bottom: size.height });
                return 1;
            }
            case MCM_SETCOLOR: {
                if (wParam > MCSC_TRAILINGTEXT)
                {
                    return -1;
                }
                const previous = held.colors[wParam];
                held.colors[wParam] = lParam;
                host.invalidate(record);
                return previous;
            }
            case MCM_GETCOLOR:
                return wParam > MCSC_TRAILINGTEXT ? -1 : held.colors[wParam];
            case MCM_SETTODAY:
                // Kept as given, a day or not; none is the clock's again.
                held.today = lParam === 0 ? now() : readTime(lParam);
                return after(repaint(record, thread), ()=>0);
            case MCM_GETTODAY:
                if (lParam === 0)
                {
                    return 0;
                }
                writeTime(lParam, held.today);
                return 1;
            case MCM_HITTEST:
                return hitTestInfo(record, lParam);
            case MCM_SETFIRSTDAYOFWEEK: {
                // -1 is the locale's again; past Sunday is Sunday. The answer
                // is what MCM_GETFIRSTDAYOFWEEK answered before.
                const previous = firstDayAnswer(record);
                const day = message.lParam | 0;
                held.firstDay = day === -1 ? null : Math.min(day, 6);
                held.metrics = null;
                host.invalidate(record);
                return previous;
            }
            case MCM_GETFIRSTDAYOFWEEK:
                return firstDayAnswer(record);
            case MCM_GETRANGE: {
                if (lParam !== 0)
                {
                    writeTime(lParam, held.min ?? noTime());
                    writeTime(lParam + 16, held.max ?? noTime());
                }
                return (held.min ? GDTR_MIN : 0) | (held.max ? GDTR_MAX : 0);
            }
            case MCM_SETRANGE:
                return setRange(record, wParam, lParam);
            case MCM_GETMONTHDELTA:
                return held.delta || calendarCount(record);
            case MCM_SETMONTHDELTA: {
                const previous = held.delta;
                held.delta = message.wParam | 0;
                return previous;
            }
            case MCM_GETMAXTODAYWIDTH: {
                if (!host.draw)
                {
                    return todayText(record).length * 8;
                }
                const { hdc } = host.contextOn(record);
                try
                {
                    return host.draw.measure(hdc, todayText(record)).width
                        + metrics(record).day + 2 * metrics(record).digitWidth;
                }
                finally
                {
                    host.endPaint(record, hdc);
                }
            }
            case MCM_SETUNICODEFORMAT: {
                const previous = held.unicode ? 1 : 0;
                held.unicode = wParam !== 0;
                return previous;
            }
            case MCM_GETUNICODEFORMAT:
                return held.unicode ? 1 : 0;
            case MCM_GETCURRENTVIEW:
                return MCMV_MONTH;
            case MCM_SETCURRENTVIEW:
                if (lParam !== MCMV_MONTH)
                {
                    host.divergence?.('SysMonthCal32', 'only the month view is drawn');
                    return 0;
                }
                return 1;
            case MCM_GETCALENDARCOUNT:
                return calendarCount(record);
            case MCM_GETCALID:
                return CAL_GREGORIAN;
            case MCM_SETCALID:
                if (wParam !== CAL_GREGORIAN)
                {
                    host.divergence?.('SysMonthCal32', 'only the Gregorian calendar is drawn');
                }
                return 0;
            case MCM_SIZERECTTOMIN: {
                // The rectangle shrunk to the whole calendars it holds, one
                // at the least.
                if (lParam === 0)
                {
                    return 0;
                }
                const [left, top, right, bottom] = [0, 4, 8, 12].map(at=>readI32(lParam + at));
                const sizes = metrics(record);
                const frame = frameOf(record);
                const gap = held.border;
                const columns = Math.max(1, Math.min(MOST_CALENDARS,
                    Math.floor((right - left - frame.width + gap) / (sizes.width + gap))));
                const rows = Math.max(1, Math.min(Math.floor(MOST_CALENDARS / columns),
                    Math.floor((bottom - top - frame.height - sizes.today + gap)
                        / (sizes.height + gap))));
                const size = neededSize(record, columns, rows);
                writeRect(lParam, { left, top, right: left + size.width,
                    bottom: top + size.height });
                return 1;
            }
            case MCM_SETCALENDARBORDER:
                held.border = wParam !== 0 ? message.lParam | 0 : DEFAULT_BORDER;
                host.invalidate(record);
                return 0;
            case MCM_GETCALENDARBORDER:
                return held.border;
            default:
                return tk.common(record, message, thread);
        }
    };

    /**
     * MCM_GETFIRSTDAYOFWEEK's answer: the day in the low word, whether it
     * differs from the locale's in the high one.
     *
     * @param {any} record
     */
    function firstDayAnswer(record){
        const set = state(record).firstDay;
        return set === null ? localeFirstDay() : ((set & 0xffff) | 1 << 16) >>> 0;
    }
}
