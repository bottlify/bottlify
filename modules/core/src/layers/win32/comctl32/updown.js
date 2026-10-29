/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The up-down control, `msctls_updown32`: two arrows, a range and a position
 * in it, and usually a buddy -- the edit beside it whose number the arrows
 * step.
 *
 * What it answers is the contract comctl32's own tests pin on Windows:
 *
 * - The range is 100 down to 0 until set, the position 0, the base 10, the
 *   acceleration three steps (1 at once, 5 after two seconds, 20 after
 *   five). UDM_SETRANGE's low word is the upper end and its high word the
 *   lower; either may be the larger, and "up" moves toward the upper end.
 * - UDM_SETPOS clamps into the range, answers the position before, writes
 *   the buddy's text if the control was made with UDS_SETBUDDYINT, and
 *   raises EVENT_OBJECT_VALUECHANGE whether or not anything changed.
 *   UDS_SETBUDDYINT is read at creation only: set or cleared later, the
 *   control goes on as it was made.
 * - The buddy's text is read back first and only written when it differs,
 *   in the base's form: thousands grouped unless UDS_NOTHOUSANDS, hex as
 *   0x%04X. UDM_GETPOS reads the buddy's number, if the control has one,
 *   and answers the position with a high word that says whether the read
 *   failed -- always, without UDS_SETBUDDYINT.
 * - A control is always the default width across (its height for
 *   UDS_HORZ stays the program's); attached to a buddy with UDS_ALIGNLEFT
 *   or UDS_ALIGNRIGHT, it takes its width out of the buddy and sits in
 *   that space, each time it is attached.
 * - A click on an arrow moves the focus to an edit buddy, asks the parent
 *   with UDN_DELTAPOS (TRUE keeps the position), steps by the first
 *   acceleration's increment, and tells WM_VSCROLL -- WM_HSCROLL for
 *   UDS_HORZ -- with SB_THUMBPOSITION and the position; letting go tells
 *   SB_ENDSCROLL.
 *
 * - Attached with UDS_ARROWKEYS, the buddy is subclassed (comctl32's
 *   SetWindowSubclass): the up and down keys in it step the control, and
 *   reach the buddy no further.
 *
 * Holding an arrow down steps once: the auto-repeat on a timer is not done.
 */

import {
    WM_CREATE, WM_PAINT, WM_ERASEBKGND, WM_KEYDOWN, WM_LBUTTONDOWN, WM_LBUTTONUP,
    WM_CAPTURECHANGED, WM_HSCROLL, WM_VSCROLL, COLOR_3DFACE, COLOR_BTNTEXT, COLOR_GRAYTEXT,
    after, pointOf,
} from '../user32/controls.js';
import { encodeAnsi } from '../kernel32/locale.js';
import { notifyWindow } from './notify.js';
import { EVENT_OBJECT_VALUECHANGE, CHILDID_SELF, raiseEvent } from './winevents.js';

/** The class name a program creates the control by. */
export const UPDOWN_CLASS = 'msctls_updown32';

/** The atom spacing a build without a bridge gives the class's procedure. */
export const UPDOWN_ATOM = 0x8017;

/** Styles. */
export const UDS_WRAP = 0x0001;
export const UDS_SETBUDDYINT = 0x0002;
export const UDS_ALIGNRIGHT = 0x0004;
export const UDS_ALIGNLEFT = 0x0008;
export const UDS_AUTOBUDDY = 0x0010;
export const UDS_ARROWKEYS = 0x0020;
export const UDS_HORZ = 0x0040;
export const UDS_NOTHOUSANDS = 0x0080;

/** Messages, numbered off WM_USER as the header numbers them. */
const WM_USER = 0x0400;
export const UDM_SETRANGE = WM_USER + 101;
export const UDM_GETRANGE = WM_USER + 102;
export const UDM_SETPOS = WM_USER + 103;
export const UDM_GETPOS = WM_USER + 104;
export const UDM_SETBUDDY = WM_USER + 105;
export const UDM_GETBUDDY = WM_USER + 106;
export const UDM_SETACCEL = WM_USER + 107;
export const UDM_GETACCEL = WM_USER + 108;
export const UDM_SETBASE = WM_USER + 109;
export const UDM_GETBASE = WM_USER + 110;
export const UDM_SETRANGE32 = WM_USER + 111;
export const UDM_GETRANGE32 = WM_USER + 112;
export const UDM_SETPOS32 = WM_USER + 113;
export const UDM_GETPOS32 = WM_USER + 114;
export const UDM_SETUNICODEFORMAT = 0x2005;
export const UDM_GETUNICODEFORMAT = 0x2006;

/** UDN_DELTAPOS: UDN_FIRST (-721) minus one. */
export const UDN_DELTAPOS = -722;
const WM_NOTIFY = 0x004e;
const WM_NOTIFYFORMAT = 0x0055;
const WM_GETTEXT = 0x000d;
const WM_SETTEXT = 0x000c;
const NF_QUERY = 3;
const NFR_UNICODE = 2;
const LB_SETCURSEL = 0x0186;
const LB_GETCARETINDEX = 0x019f;
const SB_THUMBPOSITION = 4;
const SB_ENDSCROLL = 8;
const VK_UP = 0x26;
const VK_DOWN = 0x28;
const VK_LEFT = 0x25;
const VK_RIGHT = 0x27;
const WS_EX_CLIENTEDGE = 0x00000200;

/** NMUPDOWN: an NMHDR, then iPos and iDelta. */
const NMUPDOWN_SIZE = 20;
/** How wide the control is across its arrows, its border included. */
export const DEFAULT_WIDTH = 16;
/** How far it overlaps an edit buddy's sunken edge, to look part of it. */
const BUDDY_BORDER = 2;
/** The longest number text read back from a buddy. */
const TEXT_LIMIT = 64;

/** The id the buddy's subclass is installed under. */
const BUDDY_SUBCLASS = 1;
const WM_NCDESTROY = 0x0082;

/**
 * @typedef {Object} Subclassing
 * @property {(name: string, handler: (args: number[]) => number | Promise<number>) => number}
 *     procedure  A SUBCLASSPROC the guest can call that runs `handler`.
 * @property {(name: string, args: number[]) => number | Promise<number>} call
 *     One of comctl32's own exports: SetWindowSubclass and its family.
 * @property {() => unknown} [callerThread]
 *     Whose message the subclass procedure is handed, named before it awaits.
 */

/**
 * @typedef {import('../user32/controls.js').ControlHost} ControlHost
 * @typedef {import('../user32/controls.js').ControlMessage} ControlMessage
 * @typedef {import('../user32/controls.js').Rect} Rect
 */

/**
 * A number as the buddy shows it.
 *
 * @param {number} value @param {number} base @param {boolean} grouped
 */
export const formatPosition = (value, base, grouped)=>{
    if (base === 16)
    {
        return `0x${((value >>> 0) & 0xffffffff).toString(16).toUpperCase().padStart(4, '0')}`;
    }
    const digits = String(Math.abs(value));
    const shown = grouped ? digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : digits;
    return value < 0 ? `-${shown}` : shown;
};

/**
 * The buddy's text read as strtol reads it in the base, its thousands
 * separators dropped: the whole of it must be the number, and an empty text
 * is zero.
 *
 * @param {string} text @param {number} base @returns {number | null}
 */
export const parsePosition = (text, base)=>{
    const bare = text.replaceAll(',', '').replace(/^\s+/, '');
    const pattern = base === 16 ? /^([+-]?)(?:0[xX])?([0-9a-fA-F]*)$/ : /^([+-]?)([0-9]*)$/;
    const match = pattern.exec(bare);
    if (!match)
    {
        return null;
    }
    const magnitude = match[2] === '' ? 0 : parseInt(match[2], base);
    return match[1] === '-' ? -magnitude : magnitude;
};

/**
 * Builds the window procedure of an up-down control.
 *
 * @param {ControlHost} host
 * @param {any} tk  The drawing helpers the system classes share.
 * @param {Subclassing} [subclassing]  Absent, a buddy's arrow keys are its own.
 * @returns {(record: any, message: ControlMessage, thread?: unknown)
 *     => number | Promise<number>}
 */
export function createUpDownProcedure(host, tk, subclassing){
    /** The buddy's subclass procedure, made the first time a buddy is hooked. */
    let buddyProc = 0;

    /** @param {any} record */
    const state = record=>{
        const held = tk.stateOf(record);
        held.lower ??= 100;
        held.upper ??= 0;
        held.pos ??= 0;
        held.base ??= 10;
        held.buddy ??= 0;
        held.buddyInt ??= false;
        held.unicode ??= false;
        /** @type {{ sec: number, inc: number }[]} */
        held.accel ??= [{ sec: 0, inc: 1 }, { sec: 2, inc: 5 }, { sec: 5, inc: 20 }];
        held.pressed ??= 0;
        held.hooked ??= 0;
        return held;
    };

    /** @param {any} held @param {number} value */
    const inBounds = (held, value)=>value >= Math.min(held.lower, held.upper)
        && value <= Math.max(held.lower, held.upper);

    /** @param {any} held @param {number} value */
    const clamp = (held, value)=>Math.min(Math.max(value, Math.min(held.lower, held.upper)),
        Math.max(held.lower, held.upper));

    /** @param {any} record */
    const horizontal = record=>(record.style & UDS_HORZ) !== 0;

    /** @param {number} hwnd */
    const classOf = hwnd=>String(host.live(hwnd)?.className ?? '').toLowerCase();

    /**
     * Sends a message whose lParam is a buffer in guest memory, for as long
     * as the answer takes.
     *
     * @param {number} hwnd @param {number} message @param {number} wParam
     * @param {Uint8Array} bytes @param {unknown} thread
     * @param {(address: number, answer: number) => any} then
     */
    const withBuffer = (hwnd, message, wParam, bytes, thread, then)=>{
        const address = host.allocate?.(bytes.length) ?? 0;
        if (address === 0)
        {
            return then(0, 0);
        }
        host.writeMemory(address, bytes);
        return after(host.send(hwnd, message, wParam, address, thread), answer=>after(
            then(address, answer), result=>{
                host.release?.(address);
                return result;
            }));
    };

    /**
     * The buddy's number, taken as the position when it is one in the range.
     *
     * @param {any} record @param {unknown} thread
     * @returns {boolean | Promise<boolean>} whether it was read
     */
    const readBuddy = (record, thread)=>{
        const held = state(record);
        if (!held.buddyInt || !host.live(held.buddy))
        {
            return false;
        }
        if (classOf(held.buddy) === 'listbox')
        {
            return after(host.send(held.buddy, LB_GETCARETINDEX, 0, 0, thread), index=>{
                if ((index | 0) < 0)
                {
                    return false;
                }
                held.pos = index | 0;
                return true;
            });
        }
        return withBuffer(held.buddy, WM_GETTEXT, TEXT_LIMIT, new Uint8Array(TEXT_LIMIT), thread,
            address=>{
                if (address === 0)
                {
                    return false;
                }
                const value = parsePosition(host.readCString(address, TEXT_LIMIT), held.base);
                if (value === null || !inBounds(held, value))
                {
                    return false;
                }
                held.pos = value;
                return true;
            });
    };

    /**
     * The position written into the buddy, when its text says otherwise.
     *
     * @param {any} record @param {unknown} thread
     * @returns {number | Promise<number>}
     */
    const writeBuddy = (record, thread)=>{
        const held = state(record);
        if (!held.buddyInt || !host.live(held.buddy))
        {
            return 0;
        }
        if (classOf(held.buddy) === 'listbox')
        {
            return host.send(held.buddy, LB_SETCURSEL, held.pos, 0, thread);
        }
        const text = formatPosition(held.pos, held.base, (record.style & UDS_NOTHOUSANDS) === 0);
        return withBuffer(held.buddy, WM_GETTEXT, TEXT_LIMIT, new Uint8Array(TEXT_LIMIT), thread,
            address=>{
                if (address !== 0 && host.readCString(address, TEXT_LIMIT) === text)
                {
                    return 0;
                }
                return withBuffer(held.buddy, WM_SETTEXT, 0,
                    new Uint8Array([...encodeAnsi(text), 0]), thread, ()=>0);
            });
    };

    /**
     * Moves the position by a step, to the other end past one with UDS_WRAP.
     *
     * @param {any} record @param {number} delta @returns {boolean} whether it moved
     */
    const offset = (record, delta)=>{
        const held = state(record);
        const wanted = held.pos + delta;
        const previous = held.pos;
        if (inBounds(held, wanted))
        {
            held.pos = wanted;
        }
        else if ((record.style & UDS_WRAP) !== 0)
        {
            const towardUpper = (wanted > held.pos) === (held.upper > held.lower);
            held.pos = towardUpper ? held.lower : held.upper;
        }
        else
        {
            held.pos = clamp(held, wanted);
        }
        return held.pos !== previous;
    };

    /**
     * One step up or down, as a click or an arrow key makes it: the parent
     * asked first, then told.
     *
     * @param {any} record @param {number} direction  1 toward the upper end, -1 away.
     * @param {unknown} thread
     */
    const act = (record, direction, thread)=>{
        const held = state(record);
        const parent = notifyWindow(record);
        return after(readBuddy(record, thread), ()=>{
            // "Up" is toward the upper end, which may be the lower number.
            const sign = held.upper < held.lower ? -direction : direction;
            const delta = sign * (held.accel[0]?.inc ?? 1);
            const bytes = new Uint8Array(NMUPDOWN_SIZE);
            const view = new DataView(bytes.buffer);
            view.setUint32(0, record.hwnd >>> 0, true);
            view.setUint32(4, record.id >>> 0, true);
            view.setInt32(8, UDN_DELTAPOS, true);
            view.setInt32(12, held.pos, true);
            view.setInt32(16, delta, true);
            const asked = parent === 0 ? { refused: false, delta }
                : withBuffer(parent, WM_NOTIFY, record.id & 0xffff, bytes, thread,
                    (address, answer)=>({
                        refused: (answer | 0) !== 0,
                        // The parent may change the step it is told of.
                        delta: address === 0 ? delta
                            : new DataView(host.readMemory(address + 16, 4).slice().buffer)
                                .getInt32(0, true),
                    }));
            return after(asked, (/** @type {{ refused: boolean, delta: number }} */ answer)=>{
                if (answer.refused)
                {
                    return 0;
                }
                const moved = offset(record, answer.delta);
                host.invalidate(record);
                return after(moved ? writeBuddy(record, thread) : 0,
                    ()=>tell(record, SB_THUMBPOSITION, thread));
            });
        });
    };

    /**
     * WM_VSCROLL or WM_HSCROLL to the parent, the position in the high word.
     *
     * @param {any} record @param {number} code @param {unknown} thread
     */
    const tell = (record, code, thread)=>{
        const parent = notifyWindow(record);
        if (parent === 0)
        {
            return 0;
        }
        return host.send(parent, horizontal(record) ? WM_HSCROLL : WM_VSCROLL,
            ((state(record).pos & 0xffff) << 16 | code) >>> 0, record.hwnd >>> 0, thread);
    };

    /**
     * The control beside its buddy, its width taken out of the buddy's.
     *
     * @param {any} record
     */
    const align = record=>{
        const held = state(record);
        const buddy = host.live(held.buddy);
        if (!buddy || (record.style & (UDS_ALIGNLEFT | UDS_ALIGNRIGHT)) === 0 || !host.move)
        {
            return 0;
        }
        const move = host.move;
        const left = (record.style & UDS_ALIGNLEFT) !== 0;
        const width = record.width;
        const box = { x: buddy.x, y: buddy.y, width: buddy.width - width, height: buddy.height };
        const x = left ? buddy.x : buddy.x + box.width;
        if (left)
        {
            box.x += width;
        }
        // Against an edit's sunken edge it overlaps the edge, so the two
        // read as one control.
        const bordered = !horizontal(record) && classOf(held.buddy) === 'edit'
            && ((buddy.exStyle ?? 0) & WS_EX_CLIENTEDGE) !== 0;
        const ownWidth = bordered && left ? DEFAULT_WIDTH + BUDDY_BORDER : DEFAULT_WIDTH;
        const ownX = bordered && !left ? x - BUDDY_BORDER : x;
        return after(move(buddy.hwnd, box.x, box.y, box.width, box.height),
            ()=>move(record.hwnd, ownX, box.y, ownWidth, box.height));
    };

    /** @param {any} record @param {Rect} client */
    const arrowsOf = (record, client)=>{
        if (horizontal(record))
        {
            const middle = Math.floor((client.left + client.right) / 2);
            return { up: { ...client, left: middle }, down: { ...client, right: middle } };
        }
        const middle = Math.floor((client.top + client.bottom) / 2);
        return { up: { ...client, bottom: middle }, down: { ...client, top: middle } };
    };

    /** @param {any} record @param {number} hdc */
    const paintArrows = (record, hdc)=>{
        const draw = /** @type {any} */ (host.draw);
        const held = state(record);
        const { up, down } = arrowsOf(record, tk.clientRect(record));
        const ink = tk.color(tk.disabled(record) ? COLOR_GRAYTEXT : COLOR_BTNTEXT);
        /** @param {Rect} box @param {number} direction @param {boolean} pressed */
        const button = (box, direction, pressed)=>{
            draw.fill(hdc, box, tk.color(COLOR_3DFACE));
            tk.buttonEdge(hdc, box, pressed);
            const cx = Math.floor((box.left + box.right) / 2);
            const cy = Math.floor((box.top + box.bottom) / 2);
            for (let row = 0; row < 3; row++)
            {
                const span = row;
                if (horizontal(record))
                {
                    const x = cx - direction * (row - 1);
                    draw.fill(hdc, { left: x, top: cy - span, right: x + 1, bottom: cy + span + 1 },
                        ink);
                }
                else
                {
                    const y = cy - direction * (1 - row);
                    draw.fill(hdc, { left: cx - span, top: y, right: cx + span + 1, bottom: y + 1 },
                        ink);
                }
            }
        };
        button(up, 1, held.pressed === 1);
        button(down, -1, held.pressed === -1);
    };

    /**
     * What the buddy's subclass does: the up and down keys step the control
     * whose window is the reference data, and stop there; the rest goes on.
     *
     * @param {number[]} args  The SUBCLASSPROC's: hwnd, message, wParam, lParam, id, data.
     */
    const buddyMessage = ([hwnd, message, wParam, lParam, id, data])=>{
        const { call, callerThread } = /** @type {Subclassing} */ (subclassing);
        const control = host.live(data);
        const key = wParam >>> 0;
        if ((message >>> 0) === WM_KEYDOWN && control && (key === VK_UP || key === VK_DOWN))
        {
            return after(act(control, key === VK_UP ? 1 : -1, callerThread?.()), ()=>0);
        }
        if ((message >>> 0) === WM_NCDESTROY)
        {
            call('RemoveWindowSubclass', [hwnd, buddyProc, id]);
        }
        return call('DefSubclassProc', [hwnd, message, wParam, lParam]);
    };

    /**
     * @param {any} record @param {number} buddy
     * @returns {number | Promise<number>} the buddy before
     */
    const setBuddy = (record, buddy)=>{
        const held = state(record);
        const previous = held.buddy;
        if (held.hooked && subclassing)
        {
            subclassing.call('RemoveWindowSubclass', [held.hooked, buddyProc, BUDDY_SUBCLASS]);
            held.hooked = 0;
        }
        held.buddy = host.live(buddy) ? buddy >>> 0 : 0;
        if (held.buddy !== 0 && subclassing && (record.style & UDS_ARROWKEYS) !== 0)
        {
            buddyProc ||= subclassing.procedure('updown buddy', buddyMessage);
            subclassing.call('SetWindowSubclass', [held.buddy, buddyProc, BUDDY_SUBCLASS,
                record.hwnd]);
            held.hooked = held.buddy;
        }
        return after(align(record), ()=>previous);
    };

    /**
     * @param {any} record @param {number} value @param {unknown} thread
     * @returns {number | Promise<number>} the position before
     */
    const setPos = (record, value, thread)=>{
        const held = state(record);
        const previous = held.pos;
        held.pos = clamp(held, value);
        host.invalidate(record);
        return after(writeBuddy(record, thread), ()=>after(
            raiseEvent(host, record, EVENT_OBJECT_VALUECHANGE, CHILDID_SELF, thread),
            ()=>previous));
    };

    /**
     * @param {any} record @param {ControlMessage} message @param {unknown} [thread]
     */
    return (record, message, thread)=>{
        const held = state(record);
        switch (message.message){
            case WM_CREATE: {
                held.buddyInt = (record.style & UDS_SETBUDDYINT) !== 0;
                const parent = notifyWindow(record);
                const asked = parent === 0 ? 0
                    : host.send(parent, WM_NOTIFYFORMAT, record.hwnd, NF_QUERY, thread);
                return after(asked, format=>{
                    held.unicode = (format | 0) === NFR_UNICODE;
                    // Whatever width it was made with, as Windows makes it.
                    const sized = host.move && record.width !== DEFAULT_WIDTH
                        ? host.move(record.hwnd, record.x, record.y, DEFAULT_WIDTH, record.height)
                        : 0;
                    return after(sized, ()=>{
                        if ((record.style & UDS_AUTOBUDDY) === 0)
                        {
                            return tk.common(record, message, thread);
                        }
                        // The buddy is the window before it among its siblings.
                        const above = host.live(parent);
                        const siblings = above ? host.children(above) : [];
                        const at = siblings.indexOf(record);
                        return after(at > 0 ? setBuddy(record, siblings[at - 1].hwnd) : 0,
                            ()=>tk.common(record, message, thread));
                    });
                });
            }
            case WM_PAINT:
                return tk.painting(record, (/** @type {number} */ hdc)=>{
                    paintArrows(record, hdc);
                    return 0;
                });
            case WM_ERASEBKGND:
                return 1;
            case WM_LBUTTONDOWN: {
                const point = pointOf(message.lParam);
                const { up } = arrowsOf(record, tk.clientRect(record));
                const direction = tk.contains(up, point.x, point.y) ? 1 : -1;
                held.pressed = direction;
                const focused = classOf(held.buddy) === 'edit' && host.live(held.buddy)
                    ? host.setFocus(held.buddy, thread) : 0;
                return after(focused, ()=>{
                    host.setCapture(record.hwnd);
                    return after(act(record, direction, thread), ()=>0);
                });
            }
            case WM_LBUTTONUP: {
                if (held.pressed === 0)
                {
                    return 0;
                }
                held.pressed = 0;
                host.invalidate(record);
                if (host.capture() === record.hwnd)
                {
                    host.releaseCapture();
                }
                return after(tell(record, SB_ENDSCROLL, thread), ()=>0);
            }
            case WM_CAPTURECHANGED:
                held.pressed = 0;
                host.invalidate(record);
                return 0;
            case WM_KEYDOWN: {
                const key = message.wParam >>> 0;
                const direction = key === VK_UP || key === VK_RIGHT ? 1
                    : key === VK_DOWN || key === VK_LEFT ? -1 : 0;
                if (direction === 0 || (record.style & UDS_ARROWKEYS) === 0)
                {
                    return tk.common(record, message, thread);
                }
                return after(act(record, direction, thread),
                    ()=>after(tell(record, SB_ENDSCROLL, thread), ()=>0));
            }
            case UDM_SETRANGE:
                held.upper = (message.lParam << 16) >> 16;
                held.lower = message.lParam >> 16;
                held.pos = clamp(held, held.pos);
                host.invalidate(record);
                return 0;
            case UDM_GETRANGE:
                return ((held.lower & 0xffff) << 16 | held.upper & 0xffff) >>> 0;
            case UDM_SETRANGE32:
                held.lower = message.wParam | 0;
                held.upper = message.lParam | 0;
                held.pos = clamp(held, held.pos);
                host.invalidate(record);
                return 0;
            case UDM_GETRANGE32:
                if ((message.wParam >>> 0) !== 0)
                {
                    tk.writeU32(message.wParam, held.lower);
                }
                if ((message.lParam >>> 0) !== 0)
                {
                    tk.writeU32(message.lParam, held.upper);
                }
                return 0;
            case UDM_SETPOS:
                return setPos(record, (message.lParam << 16) >> 16, thread);
            case UDM_SETPOS32:
                return setPos(record, message.lParam | 0, thread);
            case UDM_GETPOS:
                return after(readBuddy(record, thread), read=>
                    ((read ? 0 : 1) << 16 | held.pos & 0xffff) >>> 0);
            case UDM_GETPOS32:
                return after(readBuddy(record, thread), read=>{
                    if ((message.lParam >>> 0) !== 0)
                    {
                        tk.writeU32(message.lParam, read ? 0 : 1);
                    }
                    return held.pos;
                });
            case UDM_SETBUDDY:
                return setBuddy(record, message.wParam >>> 0);
            case UDM_GETBUDDY:
                return held.buddy;
            case UDM_SETBASE: {
                const base = message.wParam >>> 0;
                if (base !== 10 && base !== 16)
                {
                    return 0;
                }
                const previous = held.base;
                held.base = base;
                return after(writeBuddy(record, thread), ()=>previous);
            }
            case UDM_GETBASE:
                return held.base;
            case UDM_SETACCEL: {
                const count = message.wParam >>> 0;
                const at = message.lParam >>> 0;
                if (count === 0 || at === 0)
                {
                    return 0;
                }
                const bytes = host.readMemory(at, count * 8);
                const view = new DataView(bytes.slice().buffer);
                held.accel = Array.from({ length: count }, (_, index)=>({
                    sec: view.getUint32(index * 8, true), inc: view.getUint32(index * 8 + 4, true),
                }));
                return 1;
            }
            case UDM_GETACCEL: {
                const at = message.lParam >>> 0;
                const count = Math.min(message.wParam >>> 0, held.accel.length);
                for (let index = 0; index < (at === 0 ? 0 : count); index++)
                {
                    tk.writeU32(at + index * 8, held.accel[index].sec);
                    tk.writeU32(at + index * 8 + 4, held.accel[index].inc);
                }
                return held.accel.length;
            }
            case UDM_SETUNICODEFORMAT: {
                const previous = held.unicode;
                held.unicode = (message.wParam >>> 0) !== 0;
                return previous ? 1 : 0;
            }
            case UDM_GETUNICODEFORMAT:
                return held.unicode ? 1 : 0;
            case WM_NCDESTROY:
                // The buddy outlives the control, and keeps its keys.
                if (held.hooked && subclassing)
                {
                    subclassing.call('RemoveWindowSubclass', [held.hooked, buddyProc,
                        BUDDY_SUBCLASS]);
                    held.hooked = 0;
                }
                return tk.common(record, message, thread);
            default:
                return tk.common(record, message, thread);
        }
    };
}
