/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The status bar, `msctls_statusbar32`.
 *
 * A strip cut into parts at the right edges SB_SETPARTS gives -- -1 for the
 * rest of the width -- each a line of text, drawn sunken, raised
 * (SBT_POPOUT) or with no border (SBT_NOBORDERS); in the text a tab centres
 * what follows it and a second tab puts the rest at the right. In simple
 * mode one part, the whole width, shows a text of its own. Unless
 * CCS_NORESIZE, the bar places itself as wide as its parent and as tall as
 * its font and borders, at the parent's bottom (or top, with CCS_TOP): when
 * it is made, and whenever it is sent WM_SIZE, which is how a parent tells
 * it the parent's size changed.
 *
 * What is not here: icons in a part, owner-drawn parts, tips, the size grip
 * and NM_CLICK.
 */

import {
    WM_CREATE, WM_PAINT, WM_SETTEXT, WM_GETTEXT, WM_GETTEXTLENGTH,
    COLOR_3DFACE, COLOR_3DHILIGHT, COLOR_3DSHADOW, COLOR_BTNTEXT,
    after,
} from '../user32/controls.js';
import { encodeAnsi } from '../kernel32/locale.js';

/** The class name a program creates the control by. */
export const STATUSBAR_CLASS = 'msctls_statusbar32';

/** The atom spacing a build without a bridge gives the class's procedure. */
export const STATUSBAR_ATOM = 0x8016;

/** Styles. */
export const CCS_TOP = 0x0001;
export const CCS_NOMOVEY = 0x0002;
export const CCS_NORESIZE = 0x0004;
export const CCS_NOPARENTALIGN = 0x0008;

/** How a part's text is drawn, in SB_SETTEXT's wParam beside the part. */
export const SBT_NOBORDERS = 0x0100;
export const SBT_POPOUT = 0x0200;
export const SBT_OWNERDRAW = 0x1000;
/** The part SB_SETTEXT names for simple mode's text. */
export const SB_SIMPLEID = 0xff;

/** Messages, numbered off WM_USER as the header numbers them. */
const WM_USER = 0x0400;
export const SB_SETTEXTA = WM_USER + 1;
export const SB_GETTEXTA = WM_USER + 2;
export const SB_GETTEXTLENGTHA = WM_USER + 3;
export const SB_SETPARTS = WM_USER + 4;
export const SB_GETPARTS = WM_USER + 6;
export const SB_GETBORDERS = WM_USER + 7;
export const SB_SETMINHEIGHT = WM_USER + 8;
export const SB_SIMPLE = WM_USER + 9;
export const SB_GETRECT = WM_USER + 10;
export const SB_SETTEXTW = WM_USER + 11;
export const SB_GETTEXTLENGTHW = WM_USER + 12;
export const SB_GETTEXTW = WM_USER + 13;
export const SB_ISSIMPLE = WM_USER + 14;
export const SB_SETBKCOLOR = 0x2001;

const WM_SIZE = 0x0005;
/** The borders SB_GETBORDERS reports: across, up and down, and between parts. */
const BORDERS = Object.freeze([0, 2, 2]);
const MAX_PARTS = 256;
const CLR_DEFAULT = 0xff000000;
const DT_LEFT = 0x0000;
const DT_CENTER = 0x0001;
const DT_RIGHT = 0x0002;
const DT_VCENTER = 0x0004;
const DT_SINGLELINE = 0x0020;

/**
 * @typedef {import('../user32/controls.js').ControlHost} ControlHost
 * @typedef {import('../user32/controls.js').ControlMessage} ControlMessage
 * @typedef {import('../user32/controls.js').Rect} Rect
 * @typedef {{ right: number, text: string, type: number }} Part
 */

/**
 * Builds the window procedure of a status bar.
 *
 * @param {ControlHost} host
 * @param {any} tk  The drawing helpers the system classes share.
 * @returns {(record: any, message: ControlMessage, thread?: unknown)
 *     => number | Promise<number>}
 */
export function createStatusBarProcedure(host, tk){
    /**
     * @param {any} record
     * @returns {{ parts: Part[], simple: boolean, simplePart: Part, minHeight: number,
     *     background: number, placing: boolean }}
     */
    const state = record=>{
        const held = tk.stateOf(record);
        held.parts ??= [{ right: -1, text: '', type: 0 }];
        held.simple ??= false;
        held.simplePart ??= { right: -1, text: '', type: 0 };
        held.minHeight ??= 0;
        held.background ??= CLR_DEFAULT;
        held.placing ??= false;
        return held;
    };

    /** @param {number} address @param {boolean} wide */
    const readText = (address, wide)=>{
        if (address === 0)
        {
            return '';
        }
        if (!wide)
        {
            return host.readCString(address, 1024);
        }
        let text = '';
        for (let at = address; text.length < 1024; at += 2)
        {
            const [low, high] = host.readMemory(at, 2);
            if ((low | high) === 0)
            {
                break;
            }
            text += String.fromCharCode(low | high << 8);
        }
        return text;
    };

    /** @param {number} address @param {string} text @param {boolean} wide */
    const writeText = (address, text, wide)=>host.writeMemory(address, wide
        ? new Uint8Array(new Uint16Array([...`${text}\0`].map(c=>c.charCodeAt(0))).buffer)
        : encodeAnsi(`${text}\0`));

    /**
     * The part a message names: simple mode's for SB_SIMPLEID, else one of
     * the parts, or null.
     *
     * @param {any} record @param {number} index
     */
    const partOf = (record, index)=>{
        const held = state(record);
        return index === SB_SIMPLEID ? held.simplePart : held.parts[index] ?? null;
    };

    /**
     * Each part's rectangle in the client area: from the part before it, a
     * gap on, to its right edge or the bar's end.
     *
     * @param {any} record @returns {Rect[]}
     */
    const partRects = record=>{
        const held = state(record);
        const client = tk.clientRect(record);
        const [across, down, between] = BORDERS;
        if (held.simple)
        {
            return [{ left: across, top: down, right: client.right, bottom: client.bottom - down }];
        }
        let left = across;
        return held.parts.map(part=>{
            const right = part.right < 0 ? client.right : Math.min(part.right, client.right);
            const rect = { left, top: down, right: Math.max(left, right),
                bottom: client.bottom - down };
            left = rect.right + between;
            return rect;
        });
    };

    /**
     * Where the bar puts itself: its parent's width, its own height, at the
     * bottom of the parent or the top, or left where it is across.
     *
     * @param {any} record
     * @returns {number | Promise<number>}
     */
    const place = record=>{
        const held = state(record);
        const parent = host.live(record.parent);
        if ((record.style & CCS_NORESIZE) !== 0 || !parent || !host.move || held.placing)
        {
            return 0;
        }
        const context = host.contextOn(record);
        const textHeight = context.hdc !== 0 && host.draw
            ? host.draw.measure(context.hdc, 'M').height : 16;
        host.endPaint(record, context.hdc);
        const height = Math.max(textHeight + 2, held.minHeight) + 2 * BORDERS[1] + 2;
        const room = host.clientSize(parent);
        const keepY = (record.style & (CCS_NOMOVEY | CCS_NOPARENTALIGN)) !== 0;
        const y = keepY ? record.y
            : (record.style & 0x3) === CCS_TOP ? 0 : room.height - height;
        if (record.x === 0 && record.y === y && record.width === room.width
            && record.height === height)
        {
            return 0;
        }
        held.placing = true;
        return after(host.move(record.hwnd, 0, y, room.width, height), ()=>{
            held.placing = false;
            return 0;
        });
    };

    /**
     * A part's text, a tab putting what follows in the middle and a second
     * the rest at the right.
     *
     * @param {number} hdc @param {Part} part @param {Rect} rect
     */
    const paintPart = (hdc, part, rect)=>{
        if ((part.type & SBT_NOBORDERS) === 0)
        {
            const [topLeft, bottomRight] = (part.type & SBT_POPOUT) !== 0
                ? [COLOR_3DHILIGHT, COLOR_3DSHADOW] : [COLOR_3DSHADOW, COLOR_3DHILIGHT];
            tk.edge(hdc, rect, tk.color(topLeft), tk.color(bottomRight));
        }
        if ((part.type & SBT_OWNERDRAW) !== 0)
        {
            return;
        }
        const inside = { left: rect.left + 3, top: rect.top + 1, right: rect.right - 3,
            bottom: rect.bottom - 1 };
        part.text.split('\t').slice(0, 3).forEach((piece, at)=>{
            if (piece !== '')
            {
                tk.drawText(hdc, piece, inside, [DT_LEFT, DT_CENTER, DT_RIGHT][at]
                    | DT_VCENTER | DT_SINGLELINE, tk.color(COLOR_BTNTEXT));
            }
        });
    };

    /** @param {any} record @param {number} hdc */
    const paintBar = (record, hdc)=>{
        const held = state(record);
        const draw = /** @type {any} */ (host.draw);
        draw.fill(hdc, tk.clientRect(record), held.background === CLR_DEFAULT
            ? tk.color(COLOR_3DFACE) : held.background);
        const rects = partRects(record);
        (held.simple ? [held.simplePart] : held.parts)
            .forEach((part, index)=>paintPart(hdc, part, rects[index]));
    };

    /** @param {Part} part */
    const lengthAndType = part=>((part.type & 0xffff) << 16 | part.text.length & 0xffff) >>> 0;

    /**
     * @param {any} record @param {ControlMessage} message @param {unknown} [thread]
     */
    return (record, message, thread)=>{
        const held = state(record);
        const wParam = message.wParam >>> 0;
        const lParam = message.lParam >>> 0;
        switch (message.message >>> 0){
            case WM_CREATE:
                return after(place(record), ()=>tk.common(record, message, thread));
            case WM_SIZE:
                return place(record);
            case WM_PAINT:
                return tk.painting(record, (/** @type {number} */ hdc)=>{
                    paintBar(record, hdc);
                    return 0;
                });
            case WM_SETTEXT:
                (held.simple ? held.simplePart : held.parts[0]).text
                    = readText(lParam, record.unicode);
                host.invalidate(record);
                return 1;
            case WM_GETTEXT: {
                const text = (held.simple ? held.simplePart : held.parts[0]).text
                    .slice(0, Math.max(0, wParam - 1));
                if (wParam > 0 && lParam !== 0)
                {
                    writeText(lParam, text, record.unicode);
                }
                return text.length;
            }
            case WM_GETTEXTLENGTH:
                return (held.simple ? held.simplePart : held.parts[0]).text.length;
            case SB_SETTEXTA:
            case SB_SETTEXTW: {
                const part = partOf(record, wParam & 0xff);
                if (!part)
                {
                    return 0;
                }
                part.type = wParam & 0xff00;
                part.text = (part.type & SBT_OWNERDRAW) !== 0 ? ''
                    : readText(lParam, message.message === SB_SETTEXTW);
                host.invalidate(record);
                return 1;
            }
            case SB_GETTEXTA:
            case SB_GETTEXTW: {
                const part = partOf(record, wParam & 0xff);
                if (!part)
                {
                    return 0;
                }
                if (lParam !== 0)
                {
                    writeText(lParam, part.text, message.message === SB_GETTEXTW);
                }
                return lengthAndType(part);
            }
            case SB_GETTEXTLENGTHA:
            case SB_GETTEXTLENGTHW: {
                const part = partOf(record, wParam & 0xff);
                return part ? lengthAndType(part) : 0;
            }
            case SB_SETPARTS: {
                if (wParam === 0 || wParam > MAX_PARTS || lParam === 0)
                {
                    return 0;
                }
                const bytes = host.readMemory(lParam, wParam * 4);
                const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                held.parts = Array.from({ length: wParam }, (_, index)=>({
                    ...(held.parts[index] ?? { text: '', type: 0 }),
                    right: view.getInt32(index * 4, true),
                }));
                host.invalidate(record);
                return 1;
            }
            case SB_GETPARTS: {
                if (lParam !== 0)
                {
                    const rights = held.parts.slice(0, wParam).map(part=>part.right);
                    host.writeMemory(lParam, new Uint8Array(new Int32Array(rights).buffer));
                }
                return held.parts.length;
            }
            case SB_GETBORDERS:
                if (lParam === 0)
                {
                    return 0;
                }
                host.writeMemory(lParam, new Uint8Array(new Int32Array(BORDERS).buffer));
                return 1;
            case SB_SETMINHEIGHT:
                held.minHeight = wParam;
                return 0;
            case SB_SIMPLE:
                held.simple = wParam !== 0;
                host.invalidate(record);
                return 0;
            case SB_ISSIMPLE:
                return held.simple ? 1 : 0;
            case SB_GETRECT: {
                const rect = partRects(record)[held.simple ? 0 : wParam];
                if (!rect || lParam === 0 || (held.simple && wParam !== 0))
                {
                    return 0;
                }
                host.writeMemory(lParam, new Uint8Array(new Int32Array([rect.left, rect.top,
                    rect.right, rect.bottom]).buffer));
                return 1;
            }
            case SB_SETBKCOLOR: {
                const previous = held.background;
                held.background = lParam;
                host.invalidate(record);
                return previous;
            }
            default:
                return tk.common(record, message, thread);
        }
    };
}
