/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The tooltip control, `tooltips_class32`.
 *
 * A list of tools - a rectangle of a window, or a whole window, each with a
 * text - and the settings a tip is shown with. A tool is named by its window
 * and its id (the id itself a window under TTF_IDISHWND). Its text is a
 * string the control keeps a copy of, a resource string of the instance it
 * names, or LPSTR_TEXTCALLBACK: asked of the tool's window with
 * TTN_GETDISPINFO each time it is wanted. What is shown of a string ends at
 * its first tab unless the control has TTS_NOPREFIX - the accelerator a menu
 * text carries after one is no part of a tip - and the string is kept whole.
 *
 * What a program reads back is all here: the tools, their texts and
 * rectangles, the delays, colours, margins, width and title. The tip itself
 * is not popped up over the program yet - TTM_POPUP, TTM_TRACKACTIVATE and a
 * hover show nothing - and the first such request says so once.
 */

import { encodeAnsi } from '../kernel32/locale.js';
import { wholeAddress } from '../common/pointers.js';

/** The class name a program creates the control by. */
export const TOOLTIPS_CLASS = 'tooltips_class32';

/** The atom spacing a build without a bridge gives the class's procedure. */
export const TOOLTIPS_ATOM = 0x8018;

const WM_USER = 0x0400;
const WM_NOTIFY = 0x004e;
const WM_CREATE = 0x0001;
const WM_GETTEXTLENGTH = 0x000e;
const WM_GETTEXT = 0x000d;

const TTM = Object.freeze({
    ACTIVATE: WM_USER + 1, SETDELAYTIME: WM_USER + 3, ADDTOOLA: WM_USER + 4,
    DELTOOLA: WM_USER + 5, NEWTOOLRECTA: WM_USER + 6, RELAYEVENT: WM_USER + 7,
    GETTOOLINFOA: WM_USER + 8, SETTOOLINFOA: WM_USER + 9, HITTESTA: WM_USER + 10,
    GETTEXTA: WM_USER + 11, UPDATETIPTEXTA: WM_USER + 12, GETTOOLCOUNT: WM_USER + 13,
    ENUMTOOLSA: WM_USER + 14, GETCURRENTTOOLA: WM_USER + 15, WINDOWFROMPOINT: WM_USER + 16,
    TRACKACTIVATE: WM_USER + 17, TRACKPOSITION: WM_USER + 18, SETTIPBKCOLOR: WM_USER + 19,
    SETTIPTEXTCOLOR: WM_USER + 20, GETDELAYTIME: WM_USER + 21, GETTIPBKCOLOR: WM_USER + 22,
    GETTIPTEXTCOLOR: WM_USER + 23, SETMAXTIPWIDTH: WM_USER + 24, GETMAXTIPWIDTH: WM_USER + 25,
    SETMARGIN: WM_USER + 26, GETMARGIN: WM_USER + 27, POP: WM_USER + 28, UPDATE: WM_USER + 29,
    GETBUBBLESIZE: WM_USER + 30, ADJUSTRECT: WM_USER + 31, SETTITLEA: WM_USER + 32,
    SETTITLEW: WM_USER + 33, POPUP: WM_USER + 34, GETTITLE: WM_USER + 35,
    ADDTOOLW: WM_USER + 50, DELTOOLW: WM_USER + 51, NEWTOOLRECTW: WM_USER + 52,
    GETTOOLINFOW: WM_USER + 53, SETTOOLINFOW: WM_USER + 54, HITTESTW: WM_USER + 55,
    GETTEXTW: WM_USER + 56, UPDATETIPTEXTW: WM_USER + 57, ENUMTOOLSW: WM_USER + 58,
    GETCURRENTTOOLW: WM_USER + 59,
});

/** TTTOOLINFO: the version-1 structure ends at its text, version 2 adds lParam, 3 lpReserved. */
const TOOLINFO = Object.freeze({ cbSize: 0, uFlags: 4, hwnd: 8, uId: 12, rect: 16, hinst: 32,
    lpszText: 36, lParam: 40, V1: 40, V2: 44, V3: 48 });
/** TTHITTESTINFO: the window, the point, and the TOOLINFO filled for the tool there. */
const HITTEST = Object.freeze({ hwnd: 0, x: 4, y: 8, ti: 12 });
/** TTGETTITLE: its size, the icon, the room and the buffer. */
const GETTITLE = Object.freeze({ dwSize: 0, uTitleBitmap: 4, cch: 8, pszTitle: 12 });
/**
 * NMTTDISPINFO after its NMHDR: the text pointer, an 80-character buffer, the
 * instance, its flags and lParam.
 */
const DISPINFO = Object.freeze({ lpszText: 12, szText: 16 });

const TTF_IDISHWND = 0x0001;
const TTS_NOPREFIX = 0x02;
const TTS_BALLOON = 0x40;
const WS_POPUP = 0x80000000;
const WS_CHILD = 0x40000000;
const WS_CLIPSIBLINGS = 0x04000000;
const WS_MAXIMIZE = 0x01000000;
const WS_BORDER = 0x00800000;
const WS_DLGFRAME = 0x00400000;
const WS_EX_TOOLWINDOW = 0x00000080;
/** The space between a tip's text and its frame, inside the margins TTM_SETMARGIN sets. */
const TEXT_MARGIN = 2;
/** A balloon's: wider, and its stem above the text. */
const BALLOON_MARGIN = 10;
const BALLOON_STEM = 13;
/** A title's icon: the small icon size; TTI_NONE is a title with none. */
const SMALL_ICON = 16;
const TTI_NONE = 0;
const TTDT_AUTOMATIC = 0;
const TTDT_RESHOW = 1;
const TTDT_AUTOPOP = 2;
const TTDT_INITIAL = 3;
const TTN_GETDISPINFOA = -520;
const TTN_GETDISPINFOW = -530;
const LPSTR_TEXTCALLBACK = 0xffffffff;
const COLOR_INFOTEXT = 23;
const COLOR_INFOBK = 24;
/** The double-click time the delays are made from, as GetDoubleClickTime answers it. */
const DOUBLE_CLICK_TIME = 500;
/** How long a tip waits, stays and waits again, each from the double-click time. */
/** @type {Readonly<Record<number, number>>} */
const DEFAULT_DELAYS = Object.freeze({ [TTDT_INITIAL]: DOUBLE_CLICK_TIME,
    [TTDT_AUTOPOP]: DOUBLE_CLICK_TIME * 10, [TTDT_RESHOW]: DOUBLE_CLICK_TIME / 5 });
/** What an ANSI copy of a tool's text holds at most. */
const ANSI_COPY = 80;
/** A tip's text, as long as the control keeps one. */
const MAX_TEXT = 1024;

/**
 * @typedef {{ kind: 'none' } | { kind: 'string', text: string } | { kind: 'callback' }
 *     | { kind: 'resource', id: number }} ToolText
 * @typedef {Object} Tool
 * @property {number} flags
 * @property {number} hwnd
 * @property {number} id
 * @property {[number, number, number, number]} rect
 * @property {number} hinst
 * @property {ToolText} text
 * @property {number} lParam
 */

/**
 * Builds the window procedure of a tooltip control.
 *
 * @param {import('../user32/controls.js').ControlHost} host
 * @param {any} tk  The drawing helpers the system classes share.
 * @param {{ loadString?: (instance: number, id: number) => string | null }} [resources]
 */
export function createTooltipProcedure(host, tk, resources){
    const { guest } = host;
    let told = false;
    const notShown = ()=>{
        if (!told)
        {
            told = true;
            host.divergence?.('tooltips_class32', 'a tip is not popped up over the program');
        }
    };
    /** A string handed in, up to its terminator. @param {number} address @param {boolean} wide */
    const readText = (address, wide)=>guest.text(address, wide, wide ? MAX_TEXT * 2 : MAX_TEXT);
    /**
     * A copy into the program's buffer. An ANSI copy of a tool's text is at
     * most eighty characters, and one that long has no terminator (Wine's
     * test_longtextA records it so); a wide copy is the whole text.
     *
     * @param {number} address @param {string} text @param {boolean} wide @param {number} [room]
     */
    const writeText = (address, text, wide, room = MAX_TEXT)=>{
        if (address >>> 0 === 0 || room <= 0)
        {
            return;
        }
        if (!wide)
        {
            const bytes = encodeAnsi(`${text.slice(0, room - 1)}\0`);
            guest.setBytes(address, bytes.subarray(0, ANSI_COPY));
            return;
        }
        guest.writeWide(address, text, room);
    };

    /** @param {any} record */
    const state = record=>{
        const held = tk.stateOf(record);
        /** @type {Tool[]} */
        held.tools ??= [];
        held.active ??= true;
        held.delays ??= { ...DEFAULT_DELAYS };
        held.maxWidth ??= -1;
        held.margin ??= [0, 0, 0, 0];
        held.title ??= '';
        held.icon ??= 0;
        return held;
    };

    /**
     * The text a TOOLINFO hands in: none, the callback, a resource id (a
     * pointer whose high word is zero), or a string cut at a tab.
     *
     * @param {any} record @param {number} pointer @param {boolean} wide @returns {ToolText}
     */
    const textOf = (record, pointer, wide)=>{
        if (pointer >>> 0 === 0)
        {
            return { kind: 'none' };
        }
        if (pointer >>> 0 === LPSTR_TEXTCALLBACK)
        {
            return { kind: 'callback' };
        }
        if (pointer >>> 16 === 0)
        {
            return { kind: 'resource', id: pointer & 0xffff };
        }
        return { kind: 'string', text: readText(pointer, wide) };
    };

    /** The tool a TOOLINFO names, by its window and id. @param {any} record @param {number} info */
    const find = (record, info)=>{
        const hwnd = guest.u32(info + TOOLINFO.hwnd);
        const id = guest.u32(info + TOOLINFO.uId);
        return state(record).tools.findIndex((/** @type {Tool} */ tool)=>
            tool.hwnd === hwnd && tool.id === id);
    };

    /**
     * Whether a TOOLINFO of this spelling is one the control takes: the wide
     * one is checked against the sizes its version knows (version 6 knows
     * the third, with lpReserved), the ANSI one is read as version 1 whatever
     * its size says.
     *
     * @param {number} info @param {boolean} wide @param {number} [version]
     */
    const acceptable = (info, wide, version = 5)=>info >>> 0 !== 0
        && (!wide
            || guest.u32(info + TOOLINFO.cbSize) <= (version >= 6 ? TOOLINFO.V3 : TOOLINFO.V2));

    /**
     * The room a title takes beside and above a version 5 tip's text: its
     * icon's column, when it has one, and its row, a line of the tip's font
     * or the icon, whichever is taller. The title's length does not count:
     * the row is as wide as the tip.
     *
     * @param {any} record @param {any} held @returns {[number, number]}
     */
    const titleRoom = (record, held)=>{
        if (held.title === '')
        {
            return [0, 0];
        }
        const icon = held.icon !== TTI_NONE ? SMALL_ICON + TEXT_MARGIN : 0;
        const { hdc } = host.contextOn(record);
        const line = hdc !== 0 && host.draw ? host.draw.measure(hdc, 'M').height : SMALL_ICON;
        host.endPaint(record, hdc);
        return [icon, Math.max(line, held.icon !== TTI_NONE ? SMALL_ICON : 0) + TEXT_MARGIN];
    };

    /** @param {any} record @param {number} info @param {boolean} wide @returns {Tool} */
    const readTool = (record, info, wide)=>({
        flags: guest.u32(info + TOOLINFO.uFlags),
        hwnd: guest.u32(info + TOOLINFO.hwnd),
        id: guest.u32(info + TOOLINFO.uId),
        rect: /** @type {[number, number, number, number]} */ ([0, 4, 8, 12]
            .map(at=>guest.u32(info + TOOLINFO.rect + at) | 0)),
        hinst: guest.u32(info + TOOLINFO.hinst),
        text: textOf(record, guest.u32(info + TOOLINFO.lpszText), wide),
        lParam: guest.u32(info + TOOLINFO.cbSize) >= TOOLINFO.V2
            ? guest.u32(info + TOOLINFO.lParam) : 0,
    });

    /**
     * A tool's text, asking its window for a callback one and loading a
     * resource one.
     *
     * @param {any} record @param {Tool} tool @param {boolean} wide @param {unknown} thread
     * @returns {string | Promise<string>}
     */
    const textNow = (record, tool, wide, thread)=>{
        switch (tool.text.kind)
        {
            case 'string':
                // A tab ends what is shown, unless TTS_NOPREFIX keeps the text whole.
                return record.style & TTS_NOPREFIX ? tool.text.text
                    : tool.text.text.split('\t')[0];
            case 'resource':
                return resources?.loadString?.(tool.hinst, tool.text.id) ?? '';
            case 'callback':
                return ask(record, tool, wide, thread);
            default:
                return '';
        }
    };

    /**
     * TTN_GETDISPINFO to the tool's window.
     *
     * @param {any} record @param {Tool} tool @param {boolean} wide @param {unknown} thread
     */
    const ask = async(record, tool, wide, thread)=>{
        const size = wide ? 188 : 108;
        const block = host.allocate?.(size) ?? 0;
        if (block === 0)
        {
            return '';
        }
        try
        {
            guest.fill(block, 0, size);
            guest.set32(block, record.hwnd);
            guest.set32(block + 4, tool.id);
            guest.set32(block + 8, wide ? TTN_GETDISPINFOW : TTN_GETDISPINFOA);
            // The text points at the structure's own buffer, which a window
            // that answers with a short string copies into.
            guest.set32(block + DISPINFO.lpszText, block + DISPINFO.szText);
            guest.set32(block + DISPINFO.szText + (wide ? 160 : 80), tool.hinst);
            guest.set32(block + DISPINFO.szText + (wide ? 164 : 84), tool.flags);
            guest.set32(block + DISPINFO.szText + (wide ? 168 : 88), tool.lParam);
            await host.send(tool.hwnd, WM_NOTIFY, tool.id, block, thread);
            const answer = guest.u32(block + DISPINFO.lpszText);
            if (answer === 0 || answer === LPSTR_TEXTCALLBACK)
            {
                return '';
            }
            if (answer >>> 16 === 0)
            {
                return resources?.loadString?.(
                    guest.u32(block + DISPINFO.szText + (wide ? 160 : 80)),
                    answer) ?? '';
            }
            return readText(answer, wide);
        }
        finally
        {
            host.release?.(block);
        }
    };

    /**
     * Fills a TOOLINFO from a tool: everything but the text, whose pointer
     * says what kind it is (NULL, the callback, the resource id) or which
     * receives a copy of a string.
     *
     * @param {Tool} tool @param {number} info @param {boolean} wide
     */
    const writeTool = (tool, info, wide)=>{
        guest.set32(info + TOOLINFO.uFlags, tool.flags);
        guest.set32(info + TOOLINFO.hwnd, tool.hwnd);
        guest.set32(info + TOOLINFO.uId, tool.id);
        tool.rect.forEach((value, index)=>guest.set32(info + TOOLINFO.rect + index * 4, value));
        guest.set32(info + TOOLINFO.hinst, tool.hinst);
        const text = tool.text;
        if (text.kind === 'string')
        {
            writeText(guest.u32(info + TOOLINFO.lpszText), text.text, wide);
        }
        else
        {
            guest.set32(info + TOOLINFO.lpszText,
                text.kind === 'callback' ? LPSTR_TEXTCALLBACK
                    : text.kind === 'resource' ? text.id : 0);
        }
        if (guest.u32(info + TOOLINFO.cbSize) >= TOOLINFO.V2)
        {
            guest.set32(info + TOOLINFO.lParam, tool.lParam);
        }
    };

    /**
     * @param {any} record
     * @param {import('../user32/controls.js').ControlMessage} message
     * @param {unknown} [thread]
     */
    return (record, message, thread)=>{
        const held = state(record);
        const { wParam, lParam } = message;
        const wide = [TTM.ADDTOOLW, TTM.DELTOOLW, TTM.NEWTOOLRECTW, TTM.GETTOOLINFOW,
            TTM.SETTOOLINFOW, TTM.HITTESTW, TTM.GETTEXTW, TTM.UPDATETIPTEXTW, TTM.ENUMTOOLSW,
            TTM.GETCURRENTTOOLW].includes(message.message);
        switch (message.message)
        {
            case WM_CREATE:
                // A tip is a bordered popup of its own whatever it was made as:
                // never a child, maximised or captioned, and a tool window; a
                // balloon draws its own outline (Wine's tooltips tests,
                // test_create_tooltip).
                record.style = (((record.style & ~(WS_CHILD | WS_MAXIMIZE | WS_BORDER
                    | WS_DLGFRAME)) | WS_POPUP | WS_BORDER | WS_CLIPSIBLINGS)
                    & ~((record.style & TTS_BALLOON) !== 0 ? WS_BORDER : 0)) >>> 0;
                record.exStyle = (record.exStyle | WS_EX_TOOLWINDOW) >>> 0;
                host.frameChanged?.(record);
                return tk.common(record, message, thread);
            case WM_GETTEXTLENGTH:
            case WM_GETTEXT:
                // The window's own text is no tool's: a tip shows its tool's.
                return 0;
            case TTM.ACTIVATE:
                held.active = wParam !== 0;
                return 0;
            case TTM.ADDTOOLA:
            case TTM.ADDTOOLW: {
                if (!acceptable(lParam, wide, record.controlsVersion ?? 5))
                {
                    return 0;
                }
                held.tools.push(readTool(record, lParam, wide));
                return 1;
            }
            case TTM.DELTOOLA:
            case TTM.DELTOOLW: {
                const index = !acceptable(lParam, wide, record.controlsVersion ?? 5) ? -1
                    : find(record, lParam);
                if (index >= 0)
                {
                    held.tools.splice(index, 1);
                }
                return 0;
            }
            case TTM.NEWTOOLRECTA:
            case TTM.NEWTOOLRECTW: {
                const index = lParam >>> 0 === 0 ? -1 : find(record, lParam);
                if (index >= 0)
                {
                    held.tools[index].rect = /** @type {[number, number, number, number]} */ (
                        [0, 4, 8, 12].map(at=>guest.u32(lParam + TOOLINFO.rect + at) | 0));
                }
                return 0;
            }
            case TTM.GETTOOLINFOA:
            case TTM.GETTOOLINFOW: {
                const index = lParam >>> 0 === 0 ? -1 : find(record, lParam);
                if (index < 0)
                {
                    return 0;
                }
                writeTool(held.tools[index], lParam, wide);
                return 1;
            }
            case TTM.SETTOOLINFOA:
            case TTM.SETTOOLINFOW: {
                const index = !acceptable(lParam, wide, record.controlsVersion ?? 5) ? -1
                    : find(record, lParam);
                if (index >= 0)
                {
                    held.tools[index] = readTool(record, lParam, wide);
                }
                return 0;
            }
            case TTM.UPDATETIPTEXTA:
            case TTM.UPDATETIPTEXTW: {
                const index = lParam >>> 0 === 0 ? -1 : find(record, lParam);
                if (index >= 0)
                {
                    held.tools[index].text = textOf(record, guest.u32(lParam + TOOLINFO.lpszText),
                        wide);
                }
                return 0;
            }
            case TTM.GETTEXTA:
            case TTM.GETTEXTW: {
                const index = lParam >>> 0 === 0 ? -1 : find(record, lParam);
                const buffer = lParam >>> 0 === 0 ? 0 : guest.u32(lParam + TOOLINFO.lpszText);
                if (index < 0)
                {
                    writeText(buffer, '', wide);
                    return 0;
                }
                // wParam is the buffer's room in characters from version 6;
                // before it, the buffer is taken to hold what the control keeps.
                const room = wParam > 0 ? wParam : MAX_TEXT;
                const text = textNow(record, held.tools[index], wide, thread);
                return typeof text === 'string'
                    ? (writeText(buffer, text, wide, room), 0)
                    : text.then(got=>(writeText(buffer, got, wide, room), 0));
            }
            case TTM.GETTOOLCOUNT:
                return held.tools.length;
            case TTM.ENUMTOOLSA:
            case TTM.ENUMTOOLSW: {
                const tool = held.tools[wParam >>> 0];
                if (!tool || lParam >>> 0 === 0)
                {
                    return 0;
                }
                writeTool(tool, lParam, wide);
                return 1;
            }
            case TTM.GETCURRENTTOOLA:
            case TTM.GETCURRENTTOOLW:
                // No tip is up, so no tool is current.
                return 0;
            case TTM.HITTESTA:
            case TTM.HITTESTW: {
                if (lParam >>> 0 === 0)
                {
                    return 0;
                }
                const hwnd = guest.u32(lParam + HITTEST.hwnd);
                const x = guest.u32(lParam + HITTEST.x) | 0;
                const y = guest.u32(lParam + HITTEST.y) | 0;
                const tool = held.tools.find((/** @type {Tool} */ t)=>(t.flags & TTF_IDISHWND
                    ? t.id === hwnd
                    : t.hwnd === hwnd && x >= t.rect[0] && x < t.rect[2] && y >= t.rect[1]
                        && y < t.rect[3]));
                if (!tool)
                {
                    return 0;
                }
                writeTool(tool, lParam + HITTEST.ti, wide);
                return 1;
            }
            case TTM.SETDELAYTIME: {
                const which = wholeAddress(wParam);
                const time = (lParam & 0xffff) === 0xffff || (lParam | 0) < 0 ? -1
                    : lParam & 0xffff;
                if (which === TTDT_AUTOMATIC)
                {
                    const base = time < 0 ? DOUBLE_CLICK_TIME : time;
                    held.delays = { [TTDT_INITIAL]: base, [TTDT_AUTOPOP]: base * 10,
                        [TTDT_RESHOW]: base / 5 };
                }
                else if (which in held.delays)
                {
                    held.delays[which] = time < 0
                        ? DEFAULT_DELAYS[which] : time;
                }
                return 0;
            }
            case TTM.GETDELAYTIME:
                return held.delays[wParam === TTDT_AUTOMATIC ? TTDT_AUTOPOP : wParam >>> 0] ?? 0;
            case TTM.SETTIPBKCOLOR:
                held.background = wParam >>> 0;
                return 0;
            case TTM.SETTIPTEXTCOLOR:
                held.foreground = wParam >>> 0;
                return 0;
            case TTM.GETTIPBKCOLOR:
                return held.background ?? host.sysColor(COLOR_INFOBK);
            case TTM.GETTIPTEXTCOLOR:
                return held.foreground ?? host.sysColor(COLOR_INFOTEXT);
            case TTM.SETMAXTIPWIDTH: {
                const previous = held.maxWidth;
                held.maxWidth = lParam | 0;
                return previous;
            }
            case TTM.GETMAXTIPWIDTH:
                return held.maxWidth;
            case TTM.SETMARGIN:
                if (lParam >>> 0 !== 0)
                {
                    held.margin = [0, 4, 8, 12].map(at=>guest.u32(lParam + at) | 0);
                }
                return 0;
            case TTM.GETMARGIN:
                if (lParam >>> 0 !== 0)
                {
                    held.margin.forEach((/** @type {number} */ value, /** @type {number} */ i)=>
                        guest.set32(lParam + i * 4, value));
                }
                return 0;
            case TTM.SETTITLEA:
            case TTM.SETTITLEW:
                held.icon = wParam >>> 0;
                held.title = lParam >>> 0 === 0 ? ''
                    : readText(lParam, message.message === TTM.SETTITLEW);
                return 1;
            case TTM.GETTITLE:
                if (lParam >>> 0 !== 0)
                {
                    guest.set32(lParam + GETTITLE.uTitleBitmap, held.icon);
                    writeText(guest.u32(lParam + GETTITLE.pszTitle), held.title, true,
                        guest.u32(lParam + GETTITLE.cch));
                }
                return 0;
            case TTM.TRACKPOSITION:
                held.track = lParam >>> 0;
                return 0;
            case TTM.TRACKACTIVATE:
            case TTM.POPUP:
                notShown();
                return 0;
            case TTM.POP:
            case TTM.UPDATE:
            case TTM.RELAYEVENT:
            case TTM.WINDOWFROMPOINT:
            case TTM.GETBUBBLESIZE:
                return 0;
            case TTM.ADJUSTRECT: {
                // The text's rectangle and the tip's window around it differ by
                // the frame and the text's own margin: TRUE grows a text
                // rectangle to its window, FALSE shrinks a window to its text.
                // Common Controls 5 also counts the margins TTM_SETMARGIN set
                // and a title's row and icon; version 6 counts neither.
                if (lParam >>> 0 === 0)
                {
                    return 0;
                }
                const frame = (record.style & WS_BORDER) !== 0 ? 1 : 0;
                const balloon = (record.style & TTS_BALLOON) !== 0;
                const classic = (record.controlsVersion ?? 5) < 6;
                const title = classic ? titleRoom(record, held) : [0, 0];
                const sides = held.margin.map((/** @type {number} */ side,
                    /** @type {number} */ at)=>(classic ? side : 0) + frame + (balloon
                    ? BALLOON_MARGIN + (at === 1 ? BALLOON_STEM : 0) : TEXT_MARGIN)
                    + (at === 0 ? title[0] : at === 1 ? title[1] : 0));
                const sign = wParam !== 0 ? 1 : -1;
                const rect = [0, 4, 8, 12].map(at=>guest.u32(lParam + at) | 0);
                [rect[0] - sign * sides[0], rect[1] - sign * sides[1],
                    rect[2] + sign * sides[2], rect[3] + sign * sides[3]]
                    .forEach((value, index)=>guest.set32(lParam + index * 4, value));
                return 1;
            }
            default:
                return tk.common(record, message, thread);
        }
    };
}
