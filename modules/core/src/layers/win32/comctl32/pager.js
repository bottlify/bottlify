/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The pager, `SysPager`.
 *
 * A window that shows part of one child, scrolled along one axis: across
 * with PGS_HORZ, down otherwise. PGM_SETCHILD names the child; the pager
 * asks its parent how long the child is (PGN_CALCSIZE, the child's own size
 * the default) and puts the child at minus the scroll position, as tall
 * (or wide) as the pager, when the program next takes its messages
 * (roadmap/decisions.md, A267). PGM_SETPOS scrolls, within the child's
 * length.
 *
 * What the child tells its parent goes through the pager to the pager's
 * parent. The pager asks its parent at creation whether it wants Unicode
 * notifications (WM_NOTIFYFORMAT) and always tells its child it does; to an
 * ANSI parent it hands each notification that carries text in the A form -
 * the A code, the text converted, and what the parent wrote converted back
 * - as Wine's pager test (test_wm_notify) sees Windows do, field by field.
 *
 * What is not here: the scroll buttons, their hot tracking and
 * PGS_AUTOSCROLL.
 */

import { WM_CREATE, WM_PAINT, COLOR_3DFACE, after } from '../user32/controls.js';
import { encodeAnsi } from '../kernel32/locale.js';
import { notifyWindow } from './notify.js';
import { readText } from './strings.js';

/** The class name a program creates the control by. */
export const PAGER_CLASS = 'SysPager';

/** The atom spacing a build without a bridge gives the class's procedure. */
export const PAGER_ATOM = 0x801c;

/** Styles. */
export const PGS_HORZ = 0x0001;

/** Messages, off PGM_FIRST. */
const PGM_FIRST = 0x1400;
export const PGM_SETCHILD = PGM_FIRST + 1;
export const PGM_RECALCSIZE = PGM_FIRST + 2;
export const PGM_FORWARDMOUSE = PGM_FIRST + 3;
export const PGM_SETBKCOLOR = PGM_FIRST + 4;
export const PGM_GETBKCOLOR = PGM_FIRST + 5;
export const PGM_SETBORDER = PGM_FIRST + 6;
export const PGM_GETBORDER = PGM_FIRST + 7;
export const PGM_SETPOS = PGM_FIRST + 8;
export const PGM_GETPOS = PGM_FIRST + 9;
export const PGM_SETBUTTONSIZE = PGM_FIRST + 10;
export const PGM_GETBUTTONSIZE = PGM_FIRST + 11;
export const PGM_GETBUTTONSTATE = PGM_FIRST + 12;
/**
 * The pager's own message, posted to itself: place the child. Past the
 * pager messages Windows numbers.
 */
const PGM_PLACECHILD = PGM_FIRST + 0xff;

/** What the pager tells its parent. */
export const PGN_CALCSIZE = -902;
const PGF_CALCWIDTH = 1;
const PGF_CALCHEIGHT = 2;
/** PGM_GETBUTTONSTATE's answer for a button not shown. */
const PGF_INVISIBLE = 0;

export const WM_NOTIFY = 0x004e;
export const WM_NOTIFYFORMAT = 0x0055;
export const NF_QUERY = 3;
export const NF_REQUERY = 4;
export const NFR_ANSI = 1;
export const NFR_UNICODE = 2;

const WM_SIZE = 0x0005;
const WM_NCCALCSIZE = 0x0083;
const CLR_DEFAULT = 0xff000000;
/** The scroll buttons' default size: what PGM_GETBUTTONSIZE answers until it is set. */
const BUTTON_SIZE = 12;

/** How a notification's text crosses to an ANSI parent. */
/** Converted to an A copy on the way there. */
const SEND = 0x01;
/** What the parent left converted back into the program's buffer. */
const RECEIVE = 0x02;
/** A null text pointer handed over as an empty string. */
const EMPTY_IF_NULL = 0x04;
/** With the mask's text bit clear, the pointer handed over (and left) null. */
const NULL_IF_NO_MASK = 0x08;
/** An empty buffer of the text's length handed over, whatever the text was. */
const ZERO = 0x10;
/** An item's label being edited or set: both ways, and only with its mask bit. */
const EDITED = SEND | RECEIVE | NULL_IF_NO_MASK;

/**
 * A field at the same place in both forms, by pointer width: its offset in
 * a 32-bit structure, then a 64-bit one.
 *
 * @typedef {[number, number]} At
 *
 * @typedef {Object} TextField
 * @property {At} text  The text pointer.
 * @property {At} [max]  Its buffer's length in characters.
 * @property {[At, number]} [mask]  The mask and the bit that says the text is there.
 * @property {number} flags
 */

/** TVITEM's text and its length and mask, from the start of the item. */
const TVITEM_FIELDS = (/** @type {At} */ item)=>({
    text: /** @type {At} */ ([item[0] + 16, item[1] + 24]),
    max: /** @type {At} */ ([item[0] + 20, item[1] + 32]),
    mask: /** @type {[At, number]} */ ([item, 0x0001]),
});

/**
 * The notifications with text an ANSI parent is given in the A form: the
 * Unicode code, the A code and each text field. Offsets are after the
 * NMHDR's start; Wine's pager test, test_wm_notify, says how each field
 * crosses on Windows.
 *
 * @type {Map<number, { ansi: number, fields: TextField[] }>}
 */
const TEXT_NOTIFICATIONS = new Map([
    // CBEN_GETDISPINFO: NMCOMBOBOXEX's COMBOBOXEXITEM.
    [-807, { ansi: -800, fields: [{ text: [20, 40], max: [24, 48], mask: [[12, 24], 0x0001],
        flags: ZERO | NULL_IF_NO_MASK | RECEIVE }] }],
    // DTN_FORMATQUERY, DTN_WMKEYDOWN and DTN_USERSTRING: a format or a string.
    [-742, { ansi: -755, fields: [{ text: [12, 24], flags: SEND }] }],
    [-744, { ansi: -757, fields: [{ text: [16, 32], flags: SEND }] }],
    [-745, { ansi: -758, fields: [{ text: [12, 24], flags: SEND }] }],
    // HDN_GETDISPINFO: NMHDDISPINFO.
    [-329, { ansi: -309, fields: [{ text: [20, 32], max: [24, 40], mask: [[16, 28], 0x0002],
        flags: EMPTY_IF_NULL | SEND | RECEIVE }] }],
    // LVN_INCREMENTALSEARCH and LVN_ODFINDITEM: NMLVFINDITEM's LVFINDINFO.
    [-163, { ansi: -162, fields: [{ text: [20, 40], mask: [[16, 32], 0x0002], flags: SEND }] }],
    [-179, { ansi: -152, fields: [{ text: [20, 40], mask: [[16, 32], 0x0004], flags: SEND }] }],
    // LVN_BEGINLABELEDIT, _ENDLABELEDIT, _GETDISPINFO, _SETDISPINFO: NMLVDISPINFO's LVITEM.
    ...[[-175, -105, EDITED], [-176, -106, EDITED], [-177, -150, RECEIVE], [-178, -151, EDITED]]
        .map(([code, ansi, flags])=>/** @type {[number, any]} */ ([code, { ansi, fields: [{
            text: [32, 48], max: [36, 56], mask: [[12, 24], 0x0001], flags }] }])),
    // LVN_GETINFOTIP: NMLVGETINFOTIP.
    [-158, { ansi: -157, fields: [{ text: [16, 32], max: [20, 40], flags: SEND | RECEIVE }] }],
    // TBN_GETBUTTONINFO: NMTOOLBAR, past its TBBUTTON.
    [-720, { ansi: -700, fields: [{ text: [40, 72], max: [36, 64],
        flags: EMPTY_IF_NULL | SEND | RECEIVE }] }],
    // TBN_GETINFOTIP: NMTBGETINFOTIP.
    [-719, { ansi: -718, fields: [{ text: [12, 24], max: [16, 32], flags: RECEIVE }] }],
    // TVN_BEGINLABELEDIT, _ENDLABELEDIT, _GETDISPINFO, _SETDISPINFO: NMTVDISPINFO's TVITEM.
    ...[[-459, -410, EDITED], [-460, -411, EDITED], [-452, -403, ZERO | RECEIVE],
        [-453, -404, EDITED]]
        .map(([code, ansi, flags])=>/** @type {[number, any]} */ ([code, { ansi,
            fields: [{ ...TVITEM_FIELDS([12, 24]), flags }] }])),
    // TVN_GETINFOTIP: NMTVGETINFOTIP.
    [-414, { ansi: -413, fields: [{ text: [12, 24], max: [16, 32], flags: RECEIVE }] }],
    // NMTREEVIEW's two items: itemOld, then itemNew.
    ...[[-456, -407, 0, SEND], [-457, -408, 0, SEND], [-455, -406, 0, SEND],
        [-454, -405, 0, SEND], [-458, -409, SEND, 0], [-450, -401, SEND, SEND],
        [-451, -402, SEND, SEND]]
        .map(([code, ansi, old, now])=>/** @type {[number, any]} */ ([code, { ansi, fields: [
            { ...TVITEM_FIELDS([16, 32]), flags: old },
            { ...TVITEM_FIELDS([56, 88]), flags: now }] }])),
]);

/** The header's notifications whose item is handed over in the A form. */
const HEADER_ITEM_NOTIFICATIONS = new Map([[-326, -306], [-325, -305], [-327, -307],
    [-321, -301], [-320, -300], [-322, -302], [-323, -303], [-328, -308]]);

const CBEN_DRAGBEGINW = -809;
const CBEN_ENDEDITW = -806;
const DTN_FORMATW = -743;
const TTN_GETDISPINFOW = -530;
const LPSTR_TEXTCALLBACK = 0xffffffff;

/**
 * @typedef {import('../user32/controls.js').ControlHost} ControlHost
 * @typedef {import('../user32/controls.js').ControlMessage} ControlMessage
 */

/**
 * Builds the window procedure of a pager.
 *
 * @param {ControlHost} host
 * @param {any} tk  The drawing helpers the system classes share.
 * @returns {(record: any, message: ControlMessage, thread?: unknown)
 *     => number | Promise<number>}
 */
export function createPagerProcedure(host, tk){
    const pointer = host.pointerSize ?? 4;
    const wide = pointer === 8 ? 1 : 0;
    const HEADER = 3 * pointer;

    /**
     * @param {any} record
     * @returns {{ child: number, pos: number, border: number, button: number,
     *     background: number, ansiParent: boolean, extent: number }}
     */
    const state = record=>{
        const held = tk.stateOf(record);
        held.child ??= 0;
        held.pos ??= 0;
        held.border ??= 0;
        held.button ??= BUTTON_SIZE;
        held.background ??= CLR_DEFAULT;
        held.ansiParent ??= false;
        held.extent ??= 0;
        return held;
    };

    /** @param {number} address */
    const u32 = address=>{
        const bytes = host.readMemory(address >>> 0, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    /** @param {number} address @param {number} value */
    const setU32 = (address, value)=>host.writeMemory(address >>> 0,
        new Uint8Array(new Uint32Array([value >>> 0]).buffer));
    /** A pointer field: its low half is the address. @param {number} address */
    const pointerAt = address=>u32(address);
    /** @param {number} address @param {number} value */
    const setPointer = (address, value)=>{
        setU32(address, value);
        if (pointer === 8)
        {
            setU32(address + 4, 0);
        }
    };
    /** @param {At} at */
    const offset = at=>at[wide];

    /** Guest memory, zeroed. @param {number} bytes */
    const block = bytes=>{
        const address = host.allocate?.(Math.max(1, bytes)) ?? 0;
        if (address !== 0)
        {
            host.writeMemory(address, new Uint8Array(Math.max(1, bytes)));
        }
        return address;
    };

    /** An A copy of a text, in a buffer of at least `room` bytes. @param {string} text */
    const ansiCopy = (text, room = 0)=>{
        const bytes = encodeAnsi(text);
        const address = block(Math.max(bytes.length + 1, room));
        if (address !== 0)
        {
            host.writeMemory(address, bytes);
        }
        return address;
    };

    /**
     * A text written into a Unicode buffer of `room` characters: as much as
     * fits, its terminator only if there is room for it.
     *
     * @param {number} address @param {string} text @param {number} room
     */
    const putWide = (address, text, room)=>{
        const clipped = text.slice(0, Math.max(0, room));
        const units = clipped.length < room ? `${clipped}\0` : clipped;
        const bytes = new Uint8Array(units.length * 2);
        for (let at = 0; at < units.length; at++)
        {
            bytes[at * 2] = units.charCodeAt(at) & 0xff;
            bytes[at * 2 + 1] = units.charCodeAt(at) >>> 8;
        }
        host.writeMemory(address, bytes);
    };

    /** A Unicode copy of a text, left for the program to keep. @param {string} text */
    const wideCopy = text=>{
        const address = block((text.length + 1) * 2);
        if (address !== 0)
        {
            putWide(address, text, text.length + 1);
        }
        return address;
    };

    /** Where the pager's notifications go. @param {any} record */
    const parentOf = record=>notifyWindow(record);

    /**
     * A text field of a notification on its way to an ANSI parent, and back.
     * Returns what undoes it after the parent answered.
     *
     * @param {number} address  the notification @param {TextField} field
     * @returns {() => void}
     */
    const crossText = (address, field)=>{
        const textAt = address + offset(field.text);
        const maxAt = field.max ? address + offset(field.max) : 0;
        const masked = field.mask ? (u32(address + offset(field.mask[0])) & field.mask[1]) !== 0
            : true;
        if (!masked)
        {
            if ((field.flags & NULL_IF_NO_MASK) !== 0)
            {
                setPointer(textAt, 0);
            }
            return ()=>{};
        }
        const original = pointerAt(textAt);
        const room = maxAt !== 0 ? u32(maxAt) | 0 : 0;
        const textual = original !== 0 && original !== LPSTR_TEXTCALLBACK;
        /** @type {number[]} */
        const made = [];
        let handed = original;
        if (!textual)
        {
            if (original === 0 && (field.flags & EMPTY_IF_NULL) !== 0)
            {
                handed = block(Math.max(1, room));
                made.push(handed);
            }
        }
        else if ((field.flags & ZERO) !== 0)
        {
            handed = block(Math.max(1, room));
            made.push(handed);
        }
        else if ((field.flags & SEND) !== 0)
        {
            handed = ansiCopy(readText(host, original, true), room);
            made.push(handed);
        }
        setPointer(textAt, handed);
        return ()=>{
            const now = pointerAt(textAt);
            if ((field.flags & RECEIVE) !== 0 && textual && now !== 0
                && now !== LPSTR_TEXTCALLBACK)
            {
                // What the parent left - in the buffer it was given, or a
                // string of its own - in the program's buffer.
                const text = host.readCString(now, 0x10000);
                putWide(original, text, room > 0 ? room : text.length + 1);
                setPointer(textAt, original);
            }
            else if (textual && handed !== original && now === handed)
            {
                setPointer(textAt, original);
            }
            made.forEach(at=>host.release?.(at));
        };
    };

    /**
     * NMHEADER's item in the A form, its text and its text filter, while the
     * parent reads it.
     *
     * @param {number} address
     * @returns {() => void}
     */
    const crossHeaderItem = address=>{
        const itemAt = address + (pointer === 8 ? 32 : 20);
        const item = pointerAt(itemAt);
        if (item === 0)
        {
            return ()=>{};
        }
        const size = pointer === 8 ? 72 : 48;
        const copy = block(size);
        if (copy === 0)
        {
            return ()=>{};
        }
        host.writeMemory(copy, host.readMemory(item, size).slice());
        const mask = u32(copy);
        /** @type {number[]} */
        const made = [copy];
        const textAt = copy + 8;
        const text = pointerAt(textAt);
        if ((mask & 0x0002) !== 0 && text !== 0 && text !== LPSTR_TEXTCALLBACK)
        {
            const ansi = ansiCopy(readText(host, text, true));
            made.push(ansi);
            setPointer(textAt, ansi);
        }
        const filterAt = copy + (pointer === 8 ? 56 : 40);
        const filter = pointerAt(filterAt);
        const type = u32(copy + (pointer === 8 ? 48 : 36));
        if ((mask & 0x0100) !== 0 && filter !== 0 && (type & 0xf) === 0)
        {
            const filterSize = 2 * pointer;
            const filterCopy = block(filterSize);
            host.writeMemory(filterCopy, host.readMemory(filter, filterSize).slice());
            const filterText = pointerAt(filterCopy);
            if (filterText !== 0)
            {
                const ansi = ansiCopy(readText(host, filterText, true));
                made.push(ansi);
                setPointer(filterCopy, ansi);
            }
            made.push(filterCopy);
            setPointer(filterAt, filterCopy);
        }
        setPointer(itemAt, copy);
        return ()=>{
            setPointer(itemAt, item);
            made.forEach(at=>host.release?.(at));
        };
    };

    /**
     * A notification of fixed text inside it, given to the parent as an A
     * copy; the program's own is left as it was.
     *
     * @param {number} address @param {number} ansi @param {number} textAt
     *     where the text starts, after the NMHDR
     * @param {number} chars  its length in characters
     * @param {number} rest  bytes that follow it, copied as they are
     */
    const ansiStructure = (address, ansi, textAt, chars, rest)=>{
        const size = textAt + chars + rest;
        const copy = block(size);
        if (copy === 0)
        {
            return 0;
        }
        host.writeMemory(copy, host.readMemory(address, textAt).slice());
        setU32(copy + 2 * pointer, ansi);
        const text = readText(host, address + textAt, true, chars);
        const bytes = encodeAnsi(text).subarray(0, chars - 1);
        host.writeMemory(copy + textAt, bytes);
        host.writeMemory(copy + textAt + chars,
            host.readMemory(address + textAt + 2 * chars, rest).slice());
        return copy;
    };

    /**
     * TTN_GETDISPINFO to an ANSI parent: an NMTTDISPINFOA of its own, its
     * text converted there and what the parent answered converted back -
     * a text the parent pointed at fills szText as far as it holds and is
     * kept whole beside it, a resource id is handed back as it is.
     *
     * @param {any} record @param {number} address @param {unknown} thread
     */
    const tooltipText = (record, address, thread)=>{
        const textOffset = HEADER + pointer;
        const wideRest = textOffset + 160;
        const ansiRest = textOffset + 80;
        const tail = pointer === 8 ? 24 : 12;
        const copy = block(ansiRest + tail);
        if (copy === 0)
        {
            return 0;
        }
        host.writeMemory(copy, host.readMemory(address, HEADER).slice());
        setU32(copy + 2 * pointer, -520);
        host.writeMemory(copy + textOffset, encodeAnsi(readText(host, address + textOffset, true,
            80)).subarray(0, 79));
        setPointer(copy + HEADER, copy + textOffset);
        host.writeMemory(copy + ansiRest, host.readMemory(address + wideRest, tail).slice());
        return after(host.send(parentOf(record), WM_NOTIFY, u32(address + pointer), copy, thread),
            answer=>{
                const text = pointerAt(copy + HEADER);
                host.writeMemory(address + wideRest,
                    host.readMemory(copy + ansiRest, tail).slice());
                if (text === copy + textOffset)
                {
                    putWide(address + textOffset, host.readCString(text, 80), 80);
                    setPointer(address + HEADER, address + textOffset);
                }
                else if (text !== 0 && text < 0x10000)
                {
                    setPointer(address + HEADER, text);
                }
                else if (text !== 0)
                {
                    const whole = host.readCString(text, 0x10000);
                    putWide(address + textOffset, whole, 80);
                    setPointer(address + HEADER, wideCopy(whole));
                }
                host.release?.(copy);
                return answer;
            });
    };

    /**
     * DTN_FORMAT to an ANSI parent, in its own structure: the format
     * converted, pszDisplay pointed at szDisplay, and afterwards szDisplay
     * converted in place - or, when the parent pointed elsewhere, a Unicode
     * copy of what it pointed at.
     *
     * @param {any} record @param {number} address @param {unknown} thread
     */
    const dateFormat = (record, address, thread)=>{
        const formatAt = address + HEADER;
        const displayAt = address + (pointer === 8 ? 48 : 32);
        const display = address + (pointer === 8 ? 56 : 36);
        const format = pointerAt(formatAt);
        const ansiFormat = format !== 0 ? ansiCopy(readText(host, format, true)) : 0;
        setU32(address + 2 * pointer, -756);
        setPointer(formatAt, ansiFormat);
        setPointer(displayAt, display);
        return after(host.send(parentOf(record), WM_NOTIFY, u32(address + pointer), address,
            thread), answer=>{
            setPointer(formatAt, format);
            host.release?.(ansiFormat);
            const shown = pointerAt(displayAt);
            if (shown === display)
            {
                putWide(display, host.readCString(display, 64), 64);
            }
            else if (shown !== 0)
            {
                setPointer(displayAt, wideCopy(host.readCString(shown, 0x10000)));
            }
            return answer;
        });
    };

    /**
     * A child's notification on to the pager's parent: as it is to a parent
     * that takes Unicode or for a code that carries no text, else in the A
     * form.
     *
     * @param {any} record @param {number} wParam @param {number} address @param {unknown} thread
     */
    const forward = (record, wParam, address, thread)=>{
        const held = state(record);
        const to = parentOf(record);
        if (to === 0)
        {
            return 0;
        }
        const code = address !== 0 ? u32(address + 2 * pointer) | 0 : 0;
        if (!held.ansiParent || address === 0)
        {
            return host.send(to, WM_NOTIFY, wParam, address, thread);
        }
        if (code === TTN_GETDISPINFOW)
        {
            return tooltipText(record, address, thread);
        }
        if (code === DTN_FORMATW)
        {
            return dateFormat(record, address, thread);
        }
        if (code === CBEN_DRAGBEGINW || code === CBEN_ENDEDITW)
        {
            const drag = code === CBEN_DRAGBEGINW;
            const copy = ansiStructure(address, drag ? -808 : -805,
                HEADER + (drag ? 4 : 8), 260, drag ? 0 : 4);
            return copy === 0 ? 0 : after(host.send(to, WM_NOTIFY, wParam, copy, thread),
                answer=>{
                    host.release?.(copy);
                    return answer;
                });
        }
        const header = HEADER_ITEM_NOTIFICATIONS.get(code);
        if (header !== undefined)
        {
            setU32(address + 2 * pointer, header);
            const undo = crossHeaderItem(address);
            return after(host.send(to, WM_NOTIFY, wParam, address, thread), answer=>{
                undo();
                return answer;
            });
        }
        const spec = TEXT_NOTIFICATIONS.get(code);
        if (!spec)
        {
            return host.send(to, WM_NOTIFY, wParam, address, thread);
        }
        setU32(address + 2 * pointer, spec.ansi);
        const undo = spec.fields.map(field=>crossText(address, field));
        return after(host.send(to, WM_NOTIFY, wParam, address, thread), answer=>{
            undo.forEach(step=>step());
            return answer;
        });
    };

    /**
     * PGN_CALCSIZE: the parent asked how long the child is, the child's own
     * size the default; the answer is the length the pager scrolls over.
     *
     * @param {any} record @param {unknown} thread
     */
    const calcSize = (record, thread)=>{
        const held = state(record);
        const child = held.child !== 0 ? host.live(held.child) : null;
        const to = parentOf(record);
        const address = child && to !== 0 ? block(HEADER + 12) : 0;
        if (!child || address === 0)
        {
            return 0;
        }
        const across = (record.style & PGS_HORZ) !== 0;
        setPointer(address, record.hwnd);
        setPointer(address + pointer, record.id);
        setU32(address + 2 * pointer, PGN_CALCSIZE);
        setU32(address + HEADER, across ? PGF_CALCWIDTH : PGF_CALCHEIGHT);
        setU32(address + HEADER + 4, child.width);
        setU32(address + HEADER + 8, child.height);
        return after(host.send(to, WM_NOTIFY, record.id, address, thread), ()=>{
            held.extent = u32(address + HEADER + (across ? 4 : 8)) | 0;
            host.release?.(address);
            return 0;
        });
    };

    /**
     * Lays the pager out again: its frame recalculated - which is where it
     * asks its parent for the child's length - and the child placed by
     * PGM_PLACECHILD, posted to itself (roadmap/decisions.md, A267).
     *
     * @param {any} record
     */
    const layout = record=>{
        const held = state(record);
        if (held.child === 0 || !host.move)
        {
            return 0;
        }
        return after(host.move(record.hwnd, record.x, record.y, record.width, record.height),
            ()=>{
                host.post({ hwnd: record.hwnd, message: PGM_PLACECHILD, wParam: 0, lParam: 0 });
                return 0;
            });
    };

    /**
     * The child at minus the scroll position, as thick as the pager and as
     * long as its parent said, or the pager when that is longer.
     *
     * @param {any} record
     */
    const placeChild = record=>{
        const held = state(record);
        const child = held.child !== 0 ? host.live(held.child) : null;
        if (!child || !host.move)
        {
            return 0;
        }
        const across = (record.style & PGS_HORZ) !== 0;
        const client = host.clientSize(record);
        const room = across ? client.width : client.height;
        held.pos = Math.max(0, Math.min(held.pos, held.extent - room));
        return host.move(held.child, across ? -held.pos : 0, across ? 0 : -held.pos,
            across ? Math.max(held.extent, room) : client.width,
            across ? client.height : Math.max(held.extent, room));
    };

    /**
     * @param {any} record @param {ControlMessage} message @param {unknown} [thread]
     */
    return (record, message, thread)=>{
        const held = state(record);
        const id = message.message >>> 0;
        const wParam = message.wParam >>> 0;
        const lParam = message.lParam >>> 0;
        switch (id){
            case WM_CREATE: {
                const to = parentOf(record);
                return after(to !== 0 ? host.send(to, WM_NOTIFYFORMAT, record.hwnd, NF_QUERY,
                    thread) : NFR_UNICODE, format=>{
                    held.ansiParent = format === NFR_ANSI;
                    return tk.common(record, message, thread);
                });
            }
            case WM_NOTIFYFORMAT:
                // The child is always asked for Unicode; a requery asks the
                // pager's own parent again, whoever sent it.
                if (lParam !== NF_REQUERY)
                {
                    return NFR_UNICODE;
                }
                return after(parentOf(record) !== 0 ? host.send(parentOf(record),
                    WM_NOTIFYFORMAT, record.hwnd, NF_QUERY, thread) : 0, format=>{
                    held.ansiParent = format === NFR_ANSI;
                    return format;
                });
            case WM_NOTIFY:
                return forward(record, wParam, lParam, thread);
            case WM_NCCALCSIZE:
                return after(tk.common(record, message, thread), answer=>after(
                    calcSize(record, thread), ()=>answer));
            case WM_PAINT:
                return tk.painting(record, (/** @type {number} */ hdc)=>{
                    /** @type {any} */ (host.draw)?.fill(hdc, tk.clientRect(record),
                        held.background === CLR_DEFAULT ? tk.color(COLOR_3DFACE)
                            : held.background);
                    return 0;
                });
            case PGM_SETCHILD:
                held.child = lParam;
                held.pos = 0;
                return after(layout(record), ()=>0);
            case PGM_RECALCSIZE:
                return after(layout(record), ()=>0);
            case PGM_PLACECHILD:
            case WM_SIZE:
                return after(placeChild(record), ()=>0);
            case PGM_SETPOS: {
                const pos = Math.max(0, lParam | 0);
                if (pos === held.pos)
                {
                    return 0;
                }
                held.pos = pos;
                return after(layout(record), ()=>0);
            }
            case PGM_GETPOS:
                return held.pos;
            case PGM_SETBORDER: {
                const previous = held.border;
                held.border = Math.max(0, lParam | 0);
                return previous;
            }
            case PGM_GETBORDER:
                return held.border;
            case PGM_SETBUTTONSIZE: {
                const previous = held.button;
                held.button = Math.max(0, lParam | 0);
                return previous;
            }
            case PGM_GETBUTTONSIZE:
                return held.button;
            case PGM_SETBKCOLOR: {
                const previous = held.background;
                held.background = lParam;
                host.invalidate(record);
                return previous === CLR_DEFAULT ? tk.color(COLOR_3DFACE) : previous;
            }
            case PGM_GETBKCOLOR:
                return held.background === CLR_DEFAULT ? tk.color(COLOR_3DFACE) : held.background;
            case PGM_GETBUTTONSTATE:
                return PGF_INVISIBLE;
            case PGM_FORWARDMOUSE:
                return 0;
            default:
                return tk.common(record, message, thread);
        }
    };
}
