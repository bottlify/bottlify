/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The date and time picker, `SysDateTimePick32`.
 *
 * One moment, written out in a format: the style's (the locale's short or
 * long date, its time, or the short date with the century) until
 * DTM_SETFORMAT names a picture of its own, whose date letters are
 * GetDateFormat's and time letters GetTimeFormat's. The text is the window's
 * text: WM_GETTEXT answers it and WM_SETTEXT changes nothing (Wine's datetime
 * tests, test_wm_set_get_text). A DTS_SHOWNONE picker has a check box in front
 * and may hold no moment at all; whether it has one is fixed when it is made.
 *
 * The moment keeps its time of day as given. DTM_SETSYSTEMTIME refuses a day
 * that is not one or a time that is not one, and takes a valid moment outside
 * DTM_SETRANGE's limits as done without changing anything, as Windows
 * answers (test_dtm_set_and_get_systemtime_with_limits). The limits follow
 * the month calendar's rule (`takeRange`), and the calendar a person drops
 * down is a SysMonthCal32 given the picker's colours, font, limits and day.
 *
 * A person picks a field with the mouse or the arrow keys, steps it with up
 * and down or types its number; the parent hears DTN_DATETIMECHANGE whenever
 * the moment changes that way, and DTN_DROPDOWN and DTN_CLOSEUP around the
 * calendar.
 */

import {
    WM_PAINT, WM_ERASEBKGND, WM_GETDLGCODE, WM_KEYDOWN, WM_CHAR, WM_LBUTTONDOWN, WM_CREATE,
    WM_SETFONT, WM_GETFONT, WM_SETTEXT, WM_GETTEXT, WM_GETTEXTLENGTH, WM_SETFOCUS, WM_KILLFOCUS,
    after,
} from '../user32/controls.js';
import { CHECK_MARK } from '../user32/paint.js';
import { notifyWindow } from './notify.js';
import { readText, writeText } from './strings.js';
import { EVENT_OBJECT_VALUECHANGE, CHILDID_SELF, raiseEvent } from './winevents.js';
import { dateTimePieces } from '../kernel32/datetime-format.js';
import { encodeAnsi } from '../kernel32/locale.js';
import {
    MONTHCAL_CLASS, MCM_SETCOLOR, MCM_SETCURSEL, MCM_SETRANGE, MCN_SELECT, GDTR_MIN, GDTR_MAX,
    MCSC_BACKGROUND, MCSC_TRAILINGTEXT, daysIn, isTimeOfDay, compareTimes, withWeekday,
    noTime, takeRange, calendarNames, localNow,
} from './monthcal.js';

/** The class name a program creates the control by. */
export const DATETIMEPICK_CLASS = 'SysDateTimePick32';

/** The atom spacing a build without a bridge gives the class's procedure. */
export const DATETIMEPICK_ATOM = 0x801f;

/** Styles. The format is two bits; the time format carries DTS_UPDOWN in it. */
const DTS_UPDOWN = 0x0001;
export const DTS_SHOWNONE = 0x0002;
export const DTS_SHORTDATEFORMAT = 0x0000;
export const DTS_LONGDATEFORMAT = 0x0004;
export const DTS_SHORTDATECENTURYFORMAT = 0x000c;
export const DTS_TIMEFORMAT = 0x0009;
export const DTS_APPCANPARSE = 0x0010;
const DTS_RIGHTALIGN = 0x0020;
const FORMAT_BITS = 0x000c;

/** Messages, off DTM_FIRST as commctrl.h numbers them. */
const DTM_FIRST = 0x1000;
export const DTM_GETSYSTEMTIME = DTM_FIRST + 1;
export const DTM_SETSYSTEMTIME = DTM_FIRST + 2;
export const DTM_GETRANGE = DTM_FIRST + 3;
export const DTM_SETRANGE = DTM_FIRST + 4;
export const DTM_SETFORMATA = DTM_FIRST + 5;
export const DTM_SETMCCOLOR = DTM_FIRST + 6;
export const DTM_GETMCCOLOR = DTM_FIRST + 7;
export const DTM_GETMONTHCAL = DTM_FIRST + 8;
export const DTM_SETMCFONT = DTM_FIRST + 9;
export const DTM_GETMCFONT = DTM_FIRST + 10;
const DTM_SETMCSTYLE = DTM_FIRST + 11;
const DTM_GETMCSTYLE = DTM_FIRST + 12;
const DTM_CLOSEMONTHCAL = DTM_FIRST + 13;
const DTM_GETDATETIMEPICKERINFO = DTM_FIRST + 14;
const DTM_GETIDEALSIZE = DTM_FIRST + 15;
const DTM_SETFORMATW = DTM_FIRST + 50;

/** DTM_GETSYSTEMTIME's answers and DTM_SETSYSTEMTIME's flags. */
export const GDT_ERROR = -1;
export const GDT_VALID = 0;
export const GDT_NONE = 1;

/** The notifications, off DTN_FIRST2 (-753). */
export const DTN_CLOSEUP = -753 >>> 0;
export const DTN_DROPDOWN = -754 >>> 0;
export const DTN_DATETIMECHANGE = -759 >>> 0;

const WM_NOTIFY = 0x004e;
const WM_STYLECHANGING = 0x007c;
const WM_STYLECHANGED = 0x007d;
const GWL_STYLE = -16;
const CB_ERR = -1;
const WS_POPUP = 0x80000000;
const WS_BORDER = 0x00800000;
const SW_SHOWNA = 8;
const DLGC_WANTARROWS = 0x0001;
const DLGC_WANTCHARS = 0x0080;
const VK_ESCAPE = 0x1b;
const VK_RETURN = 0x0d;
const VK_LEFT = 0x25;
const VK_UP = 0x26;
const VK_RIGHT = 0x27;
const VK_DOWN = 0x28;
const VK_F4 = 0x73;

const COLOR_WINDOW = 5;
const COLOR_WINDOWTEXT = 8;
const COLOR_HIGHLIGHT = 13;
const COLOR_HIGHLIGHTTEXT = 14;
const COLOR_ACTIVECAPTION = 2;
const COLOR_CAPTIONTEXT = 9;
const COLOR_GRAYTEXT = 17;
const COLOR_BTNFACE = 15;

const DT_SINGLELINE = 0x0020;
const DT_VCENTER = 0x0004;

/** The LCTYPEs the style's formats come from. */
const LOCALE_SSHORTDATE = 0x1f;
const LOCALE_SLONGDATE = 0x20;
const LOCALE_STIMEFORMAT = 0x1003;

/** The years a moment may be in: FILETIME's first to SYSTEMTIME's last. */
const FIRST_YEAR = 1601;
const LAST_YEAR = 30827;

/** The fields a person steps: a day written as a weekday steps the day. */
const STEPPED = 'dMyhHmst';

/**
 * @typedef {import('./monthcal.js').CalendarSources} CalendarSources
 * @typedef {{ year: number, month: number, dow: number, day: number, hour: number,
 *     minute: number, second: number, ms: number }} Time
 */

/**
 * A day of its month, any year: the picker holds moments the calendar it
 * drops down does not (Wine's test_dtm_set_and_get_range sets 1601 as a limit).
 *
 * @param {Time} time
 */
const isDay = time=>time.month >= 1 && time.month <= 12 && time.day >= 1
    && time.day <= daysIn(time.year, time.month);

/**
 * A picture with every year written as a short date writes it changed to the
 * full year: DTS_SHORTDATECENTURYFORMAT's format.
 *
 * @param {string} picture
 */
const withCentury = picture=>{
    let out = '';
    let quoted = false;
    for (let at = 0; at < picture.length; at++)
    {
        const character = picture[at];
        if (character === '\'')
        {
            quoted = !quoted;
            out += character;
            continue;
        }
        if (!quoted && character === 'y')
        {
            while (picture[at + 1] === 'y')
            {
                at++;
            }
            out += 'yyyy';
            continue;
        }
        out += character;
    }
    return out;
};

/**
 * A moment stepped in one field: a year, month or day keeps the day in its
 * month; an hour, minute or second wraps in its day; AM and PM swap.
 *
 * @param {Time} time @param {string} letter @param {number} by
 * @returns {Time}
 */
export const stepField = (time, letter, by)=>{
    /** @param {number} value @param {number} low @param {number} count */
    const wrap = (value, low, count)=>((value - low + by) % count + count) % count + low;
    const next = { ...time };
    switch (letter)
    {
        case 'y':
            next.year = Math.max(FIRST_YEAR, Math.min(LAST_YEAR, time.year + by));
            break;
        case 'M':
            next.month = wrap(time.month, 1, 12);
            break;
        case 'd':
            next.day = wrap(time.day, 1, daysIn(time.year, time.month));
            break;
        case 'h':
        case 'H':
            next.hour = wrap(time.hour, 0, 24);
            break;
        case 'm':
            next.minute = wrap(time.minute, 0, 60);
            break;
        case 's':
            next.second = wrap(time.second, 0, 60);
            break;
        case 't':
            next.hour = (time.hour + 12) % 24;
            break;
        default:
            return time;
    }
    next.day = Math.min(next.day, daysIn(next.year, next.month));
    return withWeekday(next);
};

/**
 * A field given a number a person typed: the number if it fits the field,
 * else its last digit, else nothing.
 *
 * @param {Time} time @param {string} letter @param {number} number
 * @returns {Time | null}
 */
export const typeField = (time, letter, number)=>{
    const next = { ...time };
    switch (letter)
    {
        case 'y':
            next.year = number < 100 ? Math.floor(time.year / 100) * 100 + number : number;
            break;
        case 'M':
            next.month = number;
            break;
        case 'd':
            next.day = number;
            break;
        case 'h':
            next.hour = (number % 12) + (time.hour >= 12 ? 12 : 0);
            break;
        case 'H':
            next.hour = number;
            break;
        case 'm':
            next.minute = number;
            break;
        case 's':
            next.second = number;
            break;
        default:
            return null;
    }
    const fits = next.month >= 1 && next.month <= 12 && next.day >= 1
        && next.day <= daysIn(next.year, next.month) && isTimeOfDay(next);
    return fits ? withWeekday(next) : null;
};

/**
 * Builds the window procedure of a date and time picker.
 *
 * @param {import('../user32/controls.js').ControlHost} host
 * @param {any} tk  The drawing helpers the system classes share.
 * @param {CalendarSources} [sources]
 * @returns {(record: any, message: import('../user32/controls.js').ControlMessage,
 *     thread?: unknown) => number | Promise<number>}
 */
export function createDateTimePickProcedure(host, tk, sources = {}){
    const { guest } = host;
    const pointer = guest.pointerSize;
    /** NMHDR's size: a window, an id as wide as a pointer, the code. */
    const HEADER = pointer === 8 ? 24 : 12;

    /** @param {number} type @param {string} fallback */
    const localeText = (type, fallback)=>sources.localeText?.(type) || fallback;

    /** @param {any} record */
    const state = record=>{
        const held = tk.stateOf(record);
        if (held.time === undefined)
        {
            /** @type {Time} */
            held.time = localNow(sources);
            held.valid = true;
            /** @type {Time | null} */
            held.min = null;
            /** @type {Time | null} */
            held.max = null;
            /** @type {string | null} the picture DTM_SETFORMAT named */
            held.format = null;
            held.colors = [COLOR_WINDOW, COLOR_WINDOWTEXT, COLOR_ACTIVECAPTION, COLOR_CAPTIONTEXT,
                COLOR_WINDOW, COLOR_GRAYTEXT].map(index=>host.sysColor(index));
            held.calendarFont = 0;
            held.calendarStyle = 0;
            held.calendar = 0;
            /** @type {number} the field a person has picked, by its place among the fields */
            held.field = 0;
            /** @type {number | null} a number being typed into the field */
            held.typed = null;
            held.focused = false;
        }
        return held;
    };

    /** @param {number} address @returns {Time} */
    const readTime = address=>{
        const field = (/** @type {number} */ at)=>guest.u16(address + at * 2);
        return { year: field(0), month: field(1), dow: field(2), day: field(3), hour: field(4),
            minute: field(5), second: field(6), ms: field(7) };
    };

    /** @param {number} address @param {Time} time */
    const writeTime = (address, time)=>{
        [time.year, time.month, time.dow, time.day, time.hour, time.minute, time.second, time.ms]
            .forEach((value, at)=>guest.set16(address + at * 2, value));
    };

    /** @param {any} record  The picture the text is written in. */
    const picture = record=>{
        const held = state(record);
        if (held.format !== null)
        {
            return held.format;
        }
        switch (record.style & FORMAT_BITS)
        {
            case DTS_LONGDATEFORMAT:
                return localeText(LOCALE_SLONGDATE, 'dddd, MMMM d, yyyy');
            case DTS_TIMEFORMAT & FORMAT_BITS:
                return localeText(LOCALE_STIMEFORMAT, 'h:mm:ss tt');
            case DTS_SHORTDATECENTURYFORMAT:
                return withCentury(localeText(LOCALE_SSHORTDATE, 'M/d/yyyy'));
            default:
                return localeText(LOCALE_SSHORTDATE, 'M/d/yyyy');
        }
    };

    /** @param {any} record  The text's pieces, each field with its letter. */
    const pieces = record=>{
        const { time } = state(record);
        return dateTimePieces(picture(record), { year: time.year, month: time.month,
            day: time.day, weekday: time.dow, hour: time.hour, minute: time.minute,
            second: time.second }, calendarNames(localeText));
    };

    /** @param {any} record */
    const textOf = record=>pieces(record).map(piece=>piece.text).join('');

    /** @param {any} record  The fields a person can step, in order. */
    const fields = record=>pieces(record).filter(piece=>piece.letter !== undefined
        && STEPPED.includes(piece.letter));

    /**
     * The window's text follows the moment, so a window of another thread
     * reads it from its caption as one of this thread asks it; Common
     * Controls 6's picker tells accessibility its value changed (Wine's
     * test_dtm_set_format_v6).
     *
     * @param {any} record @param {unknown} [thread]
     */
    const retitle = (record, thread)=>{
        record.title = textOf(record);
        host.invalidate(record);
        return (record.controlsVersion ?? 5) >= 6
            ? raiseEvent(host, record, EVENT_OBJECT_VALUECHANGE, CHILDID_SELF, thread) : 0;
    };

    /**
     * Whether a moment is one the picker holds: inside the limits, and in a
     * year a FILETIME holds - year 0 is a day of its month the picker answers
     * as set and keeps none of (Wine's test_dtm_set_and_get_system_time).
     *
     * @param {any} record @param {Time} time
     */
    const allowed = (record, time)=>{
        const held = state(record);
        return time.year >= FIRST_YEAR && time.year <= LAST_YEAR
            && (held.min === null || compareTimes(time, held.min) >= 0)
            && (held.max === null || compareTimes(time, held.max) <= 0);
    };

    /**
     * Sends a WM_NOTIFY, the structure in guest memory while it is answered.
     *
     * @param {any} record @param {number} code @param {number} size
     * @param {(block: number) => void} fill @param {unknown} thread
     */
    const notify = (record, code, size, fill, thread)=>{
        const to = notifyWindow(record);
        const block = to !== 0 ? host.allocate?.(size) ?? 0 : 0;
        if (block === 0)
        {
            return 0;
        }
        guest.fill(block, 0, size);
        guest.set32s(block, [record.hwnd, record.id, 0]);
        guest.set32(block + 2 * pointer, code);
        fill(block);
        return after(host.send(to, WM_NOTIFY, record.id, block, thread), answer=>{
            host.release?.(block);
            return answer;
        });
    };

    /**
     * DTN_DATETIMECHANGE: the moment a person made, or GDT_NONE when the
     * check box was cleared.
     *
     * @param {any} record @param {unknown} thread
     */
    const tellChange = (record, thread)=>{
        const held = state(record);
        return notify(record, DTN_DATETIMECHANGE, HEADER + 4 + 16, block=>{
            guest.set32(block + HEADER, held.valid ? GDT_VALID : GDT_NONE);
            writeTime(block + HEADER + 4, held.valid ? held.time : noTime());
        }, thread);
    };

    /**
     * A moment a person made: taken when it is inside the limits, and told.
     *
     * @param {any} record @param {Time} time @param {unknown} thread
     */
    const personSets = (record, time, thread)=>{
        const held = state(record);
        if (!allowed(record, time) || compareTimes(time, held.time) === 0)
        {
            return 0;
        }
        held.time = time;
        held.valid = true;
        return after(retitle(record, thread), ()=>after(tellChange(record, thread), ()=>0));
    };

    /**
     * The layout across the client area: the check box of DTS_SHOWNONE at
     * the left, the drop-down button (or the up-down arrows) at the right,
     * the text between.
     *
     * @param {any} record
     */
    const layout = record=>{
        const client = host.clientSize(record);
        const box = (record.style & DTS_SHOWNONE) !== 0 ? Math.min(13, client.height) : 0;
        const button = Math.min(client.height, Math.max(0, client.width - box));
        const text = { left: box ? box + 4 : 2, top: 0, right: client.width - button - 2,
            bottom: client.height };
        return {
            client,
            check: box ? { left: 2, top: Math.floor((client.height - box) / 2), right: 2 + box,
                bottom: Math.floor((client.height - box) / 2) + box } : null,
            button: { left: client.width - button, top: 0, right: client.width,
                bottom: client.height },
            text,
        };
    };

    /**
     * Where each field is drawn, measured in the control's font.
     *
     * @param {any} record @param {number} hdc
     * @returns {{ left: number, right: number, piece: { text: string, letter?: string } }[]}
     */
    const placePieces = (record, hdc)=>{
        const place = layout(record);
        const draw = host.draw;
        const measure = (/** @type {string} */ text)=>(draw && hdc
            ? draw.measure(hdc, text).width : text.length * 8);
        const all = pieces(record);
        const width = all.reduce((sum, piece)=>sum + measure(piece.text), 0);
        let x = (record.style & DTS_RIGHTALIGN) !== 0
            ? Math.max(place.text.left, place.text.right - width) : place.text.left;
        return all.map(piece=>{
            const left = x;
            x += measure(piece.text);
            return { left, right: x, piece };
        });
    };

    /** @param {any} record @param {number} hdc */
    const paint = (record, hdc)=>{
        const draw = /** @type {any} */ (host.draw);
        const held = state(record);
        const place = layout(record);
        const enabled = !tk.disabled(record);
        draw.fill(hdc, { left: 0, top: 0, right: place.client.width,
            bottom: place.client.height }, host.sysColor(enabled ? COLOR_WINDOW : COLOR_BTNFACE));
        if (place.check)
        {
            tk.sunkenEdge(hdc, place.check);
            draw.fill(hdc, tk.shrink(place.check, 2), host.sysColor(COLOR_WINDOW));
            if (held.valid)
            {
                tk.glyph(hdc, CHECK_MARK, place.check.left + 3, place.check.top + 3,
                    host.sysColor(COLOR_WINDOWTEXT));
            }
        }
        const ink = host.sysColor(enabled && held.valid ? COLOR_WINDOWTEXT : COLOR_GRAYTEXT);
        const picked = fields(record)[held.field];
        for (const { left, right, piece } of placePieces(record, hdc))
        {
            const rect = { left, top: place.text.top, right, bottom: place.text.bottom };
            const chosen = held.focused && held.valid && piece === picked;
            if (chosen)
            {
                draw.fill(hdc, { ...rect, top: 2, bottom: place.client.height - 2 },
                    host.sysColor(COLOR_HIGHLIGHT));
            }
            tk.drawText(hdc, piece.text, rect, DT_SINGLELINE | DT_VCENTER,
                chosen ? host.sysColor(COLOR_HIGHLIGHTTEXT) : ink);
        }
        const button = place.button;
        if (button.right > button.left)
        {
            const halves = (record.style & DTS_UPDOWN) !== 0
                ? [{ ...button, bottom: Math.floor((button.top + button.bottom) / 2), up: true },
                    { ...button, top: Math.floor((button.top + button.bottom) / 2), up: false }]
                : [{ ...button, up: false }];
            for (const half of halves)
            {
                tk.buttonEdge(hdc, half, held.calendar !== 0 && halves.length === 1);
                arrow(hdc, half, half.up, host.sysColor(COLOR_WINDOWTEXT));
            }
        }
        return 0;
    };

    /**
     * A small filled triangle in the middle of a rectangle.
     *
     * @param {number} hdc
     * @param {{ left: number, top: number, right: number, bottom: number }} rect
     * @param {boolean} up @param {number} rgb
     */
    function arrow(hdc, rect, up, rgb){
        const draw = /** @type {any} */ (host.draw);
        const half = Math.max(2, Math.floor(Math.min(rect.right - rect.left,
            rect.bottom - rect.top) / 5));
        const middle = Math.floor((rect.left + rect.right) / 2);
        const top = Math.floor((rect.top + rect.bottom - half) / 2);
        for (let row = 0; row < half; row++)
        {
            const reach = up ? row : half - 1 - row;
            draw.fill(hdc, { left: middle - reach, top: top + row, right: middle + reach + 1,
                bottom: top + row + 1 }, rgb);
        }
    }

    /**
     * Drops the calendar down under the picker: a SysMonthCal32 popup it
     * owns, given the picker's colours, font, limits and day.
     *
     * @param {any} record @param {unknown} thread
     */
    const dropDown = (record, thread)=>{
        const held = state(record);
        if (held.calendar !== 0 || !host.popup)
        {
            return 0;
        }
        return after(notify(record, DTN_DROPDOWN, HEADER, ()=>{}, thread), ()=>{
            const origin = host.clientOrigin?.(record) ?? { x: record.x ?? 0, y: record.y ?? 0 };
            const client = host.clientSize(record);
            const style = WS_POPUP | WS_BORDER | (held.calendarStyle & 0xffff);
            return after(/** @type {NonNullable<typeof host.popup>} */ (host.popup)(MONTHCAL_CLASS,
                { x: origin.x, y: origin.y + client.height, width: 180, height: 160 },
                record.hwnd, 0, style, thread), calendar=>{
                held.calendar = calendar >>> 0;
                if (held.calendar === 0)
                {
                    return 0;
                }
                /** @type {(() => number | Promise<number>)[]} */
                const steps = held.colors.map((/** @type {number} */ color,
                    /** @type {number} */ part)=>
                    ()=>host.send(held.calendar, MCM_SETCOLOR, part, color, thread));
                if (held.calendarFont !== 0)
                {
                    steps.push(()=>host.send(held.calendar, WM_SETFONT, held.calendarFont, 0,
                        thread));
                }
                const block = host.allocate?.(32) ?? 0;
                if (block !== 0)
                {
                    steps.push(()=>{
                        writeTime(block, held.min ?? noTime());
                        writeTime(block + 16, held.max ?? noTime());
                        return host.send(held.calendar, MCM_SETRANGE,
                            (held.min ? GDTR_MIN : 0) | (held.max ? GDTR_MAX : 0), block, thread);
                    });
                    steps.push(()=>{
                        writeTime(block, held.time);
                        return host.send(held.calendar, MCM_SETCURSEL, 0, block, thread);
                    });
                    steps.push(()=>{
                        host.release?.(block);
                        return 0;
                    });
                }
                steps.push(()=>host.show?.(held.calendar, SW_SHOWNA) ?? 0);
                steps.push(()=>{
                    host.invalidate(record);
                    return 0;
                });
                return steps.reduce((/** @type {number | Promise<number>} */ done, step)=>
                    after(done, ()=>step()), /** @type {number | Promise<number>} */ (0));
            });
        });
    };

    /**
     * Closes the calendar, if it is down, and tells the parent.
     *
     * @param {any} record @param {unknown} thread
     */
    const closeUp = (record, thread)=>{
        const held = state(record);
        const calendar = held.calendar;
        if (calendar === 0)
        {
            return 0;
        }
        held.calendar = 0;
        host.invalidate(record);
        return after(host.destroy?.(calendar) ?? 0,
            ()=>after(notify(record, DTN_CLOSEUP, HEADER, ()=>{}, thread), ()=>0));
    };

    /**
     * WM_NOTIFY from the calendar it dropped down: the day chosen, the time
     * of day kept, and the calendar closed.
     *
     * @param {any} record @param {number} block @param {unknown} thread
     */
    const fromCalendar = (record, block, thread)=>{
        const held = state(record);
        const from = guest.ptr(block);
        const code = guest.u32(block + 2 * pointer);
        if (held.calendar === 0 || from !== held.calendar || code !== MCN_SELECT)
        {
            return 0;
        }
        const day = readTime(block + HEADER);
        const time = withWeekday({ ...held.time, year: day.year, month: day.month,
            day: day.day });
        return after(personSets(record, time, thread), ()=>closeUp(record, thread));
    };

    /**
     * A key steps or picks a field, or drops the calendar down.
     *
     * @param {any} record @param {number} key @param {unknown} thread
     */
    const keyDown = (record, key, thread)=>{
        const held = state(record);
        const count = fields(record).length;
        switch (key)
        {
            case VK_LEFT:
            case VK_RIGHT:
                if (count > 0)
                {
                    held.field = (held.field + (key === VK_LEFT ? count - 1 : 1)) % count;
                    held.typed = null;
                    host.invalidate(record);
                }
                return 0;
            case VK_UP:
            case VK_DOWN: {
                if (host.keyDown(0x12) && key === VK_DOWN)
                {
                    return dropDown(record, thread);
                }
                const field = fields(record)[held.field];
                if (!field || !held.valid)
                {
                    return 0;
                }
                held.typed = null;
                return personSets(record, stepField(held.time, /** @type {string} */
                    (field.letter), key === VK_UP ? 1 : -1), thread);
            }
            case VK_F4:
                return held.calendar !== 0 ? closeUp(record, thread) : dropDown(record, thread);
            case VK_ESCAPE:
            case VK_RETURN:
                return closeUp(record, thread);
            default:
                return 0;
        }
    };

    /**
     * A digit typed into the picked field: two digits make the number, a
     * number that does not fit starts again from the digit.
     *
     * @param {any} record @param {number} character @param {unknown} thread
     */
    const typed = (record, character, thread)=>{
        const held = state(record);
        const field = fields(record)[held.field];
        if (!field || !held.valid || character < 0x30 || character > 0x39)
        {
            return 0;
        }
        const digit = character - 0x30;
        const letter = /** @type {string} */ (field.letter);
        const together = held.typed === null ? null : held.typed * 10 + digit;
        const time = (together !== null ? typeField(held.time, letter, together) : null)
            ?? typeField(held.time, letter, digit);
        held.typed = together !== null && together >= 10 ? null : digit;
        return time ? personSets(record, time, thread) : 0;
    };

    /**
     * A click: the check box, the button, or a field.
     *
     * @param {any} record @param {{ x: number, y: number }} point @param {unknown} thread
     */
    const click = (record, point, thread)=>{
        const held = state(record);
        const place = layout(record);
        const inside = (/** @type {any} */ rect)=>rect && point.x >= rect.left
            && point.x < rect.right && point.y >= rect.top && point.y < rect.bottom;
        if (inside(place.check))
        {
            held.valid = !held.valid;
            host.invalidate(record);
            return tellChange(record, thread);
        }
        if (inside(place.button) && place.button.right > place.button.left)
        {
            if ((record.style & DTS_UPDOWN) !== 0)
            {
                const up = point.y < (place.button.top + place.button.bottom) / 2;
                return keyDown(record, up ? VK_UP : VK_DOWN, thread);
            }
            return held.calendar !== 0 ? closeUp(record, thread) : dropDown(record, thread);
        }
        const { hdc } = host.contextOn(record);
        try
        {
            const placed = placePieces(record, hdc);
            const stepped = fields(record);
            const hit = placed.find(({ left, right, piece })=>point.x >= left && point.x < right
                && stepped.some(field=>field.text === piece.text && field.letter === piece.letter));
            if (hit)
            {
                const index = placed.filter(({ piece })=>piece.letter !== undefined
                    && STEPPED.includes(piece.letter)).indexOf(hit);
                if (index >= 0)
                {
                    held.field = index;
                    held.typed = null;
                    host.invalidate(record);
                }
            }
        }
        finally
        {
            host.endPaint(record, hdc);
        }
        return 0;
    };

    /**
     * DTM_SETSYSTEMTIME: a moment, checked as a day and a time of day; a
     * valid one outside the limits is answered as done and not taken. None
     * is only for a DTS_SHOWNONE picker.
     *
     * @param {any} record @param {number} flag @param {number} address
     * @param {unknown} thread
     */
    const setTime = (record, flag, address, thread)=>{
        const held = state(record);
        if (flag === GDT_NONE)
        {
            if ((record.style & DTS_SHOWNONE) === 0)
            {
                return 0;
            }
            held.valid = false;
            return after(retitle(record, thread), ()=>1);
        }
        if (flag !== GDT_VALID || address === 0)
        {
            return 0;
        }
        const time = readTime(address);
        if (!isDay(time) || !isTimeOfDay(time) || time.ms >= 1000)
        {
            return 0;
        }
        if (!allowed(record, time))
        {
            return 1;
        }
        held.time = withWeekday(time);
        held.valid = true;
        return after(retitle(record, thread), ()=>1);
    };

    /**
     * DTM_SETFORMAT: a picture of the program's, or none for the style's.
     *
     * @param {any} record @param {number} address @param {boolean} wide
     * @param {unknown} thread
     */
    const setFormat = (record, address, wide, thread)=>{
        const held = state(record);
        held.format = address === 0 ? null : readText(host, address, wide);
        // A run of X is a field the parent writes (DTN_FORMAT, DTN_FORMATQUERY):
        // written here as the letters themselves.
        if (held.format !== null && /X/.test(held.format.replace(/'[^']*'?/g, '')))
        {
            host.divergence?.('SysDateTimePick32', 'callback fields (X) are written as they '
                + 'stand; DTN_FORMAT and DTN_FORMATQUERY are not sent');
        }
        const count = fields(record).length;
        held.field = count === 0 ? 0 : Math.min(held.field, count - 1);
        return after(retitle(record, thread), ()=>1);
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
        switch (id){
            case WM_CREATE: {
                // It starts in its parent's font, and its text is the moment's,
                // not the title it was made with.
                const to = notifyWindow(record);
                return after(to !== 0 ? host.send(to, WM_GETFONT, 0, 0, thread) : 0, font=>{
                    if ((font >>> 0) !== 0)
                    {
                        record.font = font >>> 0;
                    }
                    record.title = textOf(record);
                    return 0;
                });
            }
            case WM_PAINT:
                return tk.painting(record, (/** @type {number} */ hdc)=>paint(record, hdc));
            case WM_ERASEBKGND:
                return 1;
            case WM_GETDLGCODE:
                return DLGC_WANTARROWS | DLGC_WANTCHARS;
            case WM_SETTEXT:
                return CB_ERR;
            case WM_GETTEXT: {
                const text = textOf(record);
                return writeText(host, lParam, text, message.unicode === true, message.wParam | 0);
            }
            case WM_GETTEXTLENGTH: {
                const text = textOf(record);
                return message.unicode === true ? text.length : encodeAnsi(text).length;
            }
            case WM_STYLECHANGING:
                // Whether it may hold no moment is fixed when it is made
                // (Wine's test_dts_shownone).
                if ((message.wParam | 0) === GWL_STYLE && lParam !== 0)
                {
                    const old = guest.u32(lParam);
                    const wanted = guest.u32(lParam + 4);
                    guest.set32(lParam + 4, (wanted & ~DTS_SHOWNONE) | (old & DTS_SHOWNONE));
                }
                return 0;
            case WM_STYLECHANGED:
                return after(retitle(record, thread), ()=>0);
            case WM_SETFOCUS:
            case WM_KILLFOCUS:
                held.focused = id === WM_SETFOCUS;
                held.typed = null;
                host.invalidate(record);
                return tk.common(record, message, thread);
            case WM_KEYDOWN:
                return keyDown(record, wParam, thread);
            case WM_CHAR:
                return typed(record, wParam, thread);
            case WM_LBUTTONDOWN: {
                const point = { x: (lParam << 16) >> 16, y: lParam >> 16 };
                return after(host.setFocus(record.hwnd, thread), ()=>click(record, point, thread));
            }
            case WM_NOTIFY:
                return fromCalendar(record, lParam, thread);
            case DTM_GETSYSTEMTIME:
                if (lParam === 0)
                {
                    return GDT_NONE;
                }
                if (!held.valid)
                {
                    return GDT_NONE;
                }
                writeTime(lParam, held.time);
                return GDT_VALID;
            case DTM_SETSYSTEMTIME:
                return setTime(record, message.wParam | 0, lParam, thread);
            case DTM_GETRANGE:
                if (lParam !== 0)
                {
                    writeTime(lParam, held.min ?? noTime());
                    writeTime(lParam + 16, held.max ?? noTime());
                }
                return (held.min ? GDTR_MIN : 0) | (held.max ? GDTR_MAX : 0);
            case DTM_SETRANGE: {
                if (lParam === 0)
                {
                    return 0;
                }
                const given = /** @type {[Time, Time]} */ ([readTime(lParam),
                    readTime(lParam + 16)]);
                const taken = takeRange(given, [(wParam & GDTR_MIN) !== 0,
                    (wParam & GDTR_MAX) !== 0], localNow(sources), isDay);
                if (!taken)
                {
                    return 0;
                }
                taken.given.forEach((limit, at)=>{
                    if (limit !== given[at])
                    {
                        writeTime(lParam + at * 16, limit);
                    }
                });
                held.min = taken.min;
                held.max = taken.max;
                return 1;
            }
            case DTM_SETFORMATA:
            case DTM_SETFORMATW:
                return setFormat(record, lParam, id === DTM_SETFORMATW, thread);
            case DTM_SETMCCOLOR: {
                if (wParam < MCSC_BACKGROUND || wParam > MCSC_TRAILINGTEXT)
                {
                    return -1;
                }
                const previous = held.colors[wParam];
                held.colors[wParam] = lParam;
                return held.calendar !== 0
                    ? after(host.send(held.calendar, MCM_SETCOLOR, wParam, lParam, thread),
                        ()=>previous)
                    : previous;
            }
            case DTM_GETMCCOLOR:
                return wParam > MCSC_TRAILINGTEXT ? -1 : held.colors[wParam];
            case DTM_GETMONTHCAL:
                return held.calendar;
            case DTM_SETMCFONT:
                held.calendarFont = wParam;
                return held.calendar !== 0
                    ? after(host.send(held.calendar, WM_SETFONT, wParam, lParam, thread), ()=>0)
                    : 0;
            case DTM_GETMCFONT:
                return held.calendarFont;
            case DTM_SETMCSTYLE: {
                if ((record.controlsVersion ?? 5) < 6)
                {
                    return tk.common(record, message, thread);
                }
                const previous = held.calendarStyle;
                held.calendarStyle = lParam;
                return previous;
            }
            case DTM_GETMCSTYLE:
                return (record.controlsVersion ?? 5) < 6 ? tk.common(record, message, thread)
                    : held.calendarStyle;
            case DTM_CLOSEMONTHCAL:
                return after(closeUp(record, thread), ()=>0);
            case DTM_GETDATETIMEPICKERINFO:
            case DTM_GETIDEALSIZE:
                if ((record.controlsVersion ?? 5) >= 6)
                {
                    host.divergence?.('SysDateTimePick32', 'DTM_GETDATETIMEPICKERINFO and '
                        + 'DTM_GETIDEALSIZE are not answered');
                }
                return tk.common(record, message, thread);
            default:
                return tk.common(record, message, thread);
        }
    };
}
