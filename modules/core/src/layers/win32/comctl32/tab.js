/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The tab control, `SysTabControl32`.
 *
 * A row of labelled tabs over a pane. The control keeps the items -- a text,
 * an image index, a program's own data and a state -- which one is selected
 * and which has the focus, and tells its parent when the person moves from
 * one to another: TCN_SELCHANGING, which the parent may refuse, and then
 * TCN_SELCHANGE. What sits in the pane is the parent's; the control only
 * says where the pane is, through TCM_ADJUSTRECT. A property sheet is the
 * commonest owner of one.
 *
 * In the tab form the focus is the selection: moving one moves the other.
 * The button form (TCS_BUTTONS) keeps them apart -- the focus walks the
 * buttons and the parent hears TCN_FOCUSCHANGE -- and is drawn as a row of
 * push buttons over a pane with no border. A tab's image, from the image list
 * TCM_SETIMAGELIST names, is drawn at its left, its label beside it.
 */

import {
    WM_CREATE, WM_PAINT, WM_ERASEBKGND, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_KEYDOWN,
    WM_GETDLGCODE, WM_SETFOCUS, WM_KILLFOCUS, DLGC_WANTARROWS, DLGC_WANTCHARS,
    COLOR_3DFACE, COLOR_3DHILIGHT, COLOR_3DSHADOW, COLOR_3DDKSHADOW, COLOR_BTNTEXT,
    COLOR_GRAYTEXT,
    after, pointOf,
} from '../user32/controls.js';
import { encodeAnsi } from '../kernel32/locale.js';
import {
    EVENT_OBJECT_CREATE, EVENT_OBJECT_DESTROY, EVENT_OBJECT_FOCUS, EVENT_OBJECT_SELECTION,
    raiseEvent,
} from './winevents.js';
import { notifyWindow } from './notify.js';

/** The class name a program creates the control by. */
export const TAB_CLASS = 'SysTabControl32';

/** The atom spacing a build without a bridge gives the class's procedure. */
export const TAB_ATOM = 0x8012;

/** Styles. */
export const TCS_FLATBUTTONS = 0x0008;
export const TCS_VERTICAL = 0x0080;
export const TCS_BUTTONS = 0x0100;
export const TCS_MULTILINE = 0x0200;
export const TCS_FIXEDWIDTH = 0x0400;
export const TCS_FOCUSNEVER = 0x8000;
const WS_CLIPSIBLINGS = 0x04000000;

/** Messages, numbered off TCM_FIRST as the header numbers them. */
const TCM_FIRST = 0x1300;
export const TCM_GETIMAGELIST = TCM_FIRST + 2;
export const TCM_SETIMAGELIST = TCM_FIRST + 3;
export const TCM_GETITEMCOUNT = TCM_FIRST + 4;
export const TCM_GETITEMA = TCM_FIRST + 5;
export const TCM_SETITEMA = TCM_FIRST + 6;
export const TCM_INSERTITEMA = TCM_FIRST + 7;
export const TCM_DELETEITEM = TCM_FIRST + 8;
export const TCM_DELETEALLITEMS = TCM_FIRST + 9;
export const TCM_GETITEMRECT = TCM_FIRST + 10;
export const TCM_GETCURSEL = TCM_FIRST + 11;
export const TCM_SETCURSEL = TCM_FIRST + 12;
export const TCM_HITTEST = TCM_FIRST + 13;
export const TCM_SETITEMEXTRA = TCM_FIRST + 14;
export const TCM_ADJUSTRECT = TCM_FIRST + 40;
export const TCM_SETITEMSIZE = TCM_FIRST + 41;
export const TCM_REMOVEIMAGE = TCM_FIRST + 42;
export const TCM_SETPADDING = TCM_FIRST + 43;
export const TCM_GETROWCOUNT = TCM_FIRST + 44;
export const TCM_GETTOOLTIPS = TCM_FIRST + 45;
export const TCM_SETTOOLTIPS = TCM_FIRST + 46;
export const TCM_GETCURFOCUS = TCM_FIRST + 47;
export const TCM_SETCURFOCUS = TCM_FIRST + 48;
export const TCM_SETMINTABWIDTH = TCM_FIRST + 49;
export const TCM_DESELECTALL = TCM_FIRST + 50;
export const TCM_HIGHLIGHTITEM = TCM_FIRST + 51;
export const TCM_SETEXTENDEDSTYLE = TCM_FIRST + 52;
export const TCM_GETEXTENDEDSTYLE = TCM_FIRST + 53;
export const TCM_GETITEMW = TCM_FIRST + 60;
export const TCM_SETITEMW = TCM_FIRST + 61;
export const TCM_INSERTITEMW = TCM_FIRST + 62;
export const TCM_SETUNICODEFORMAT = 0x2005;
export const TCM_GETUNICODEFORMAT = 0x2006;

/** TCITEM, the same shape in both spellings: only the text differs. */
export const TCITEM = Object.freeze({
    mask: 0, dwState: 4, dwStateMask: 8, pszText: 12, cchTextMax: 16, iImage: 20,
    lParam: 24, SIZE: 28,
});
export const TCIF_TEXT = 0x0001;
export const TCIF_IMAGE = 0x0002;
export const TCIF_PARAM = 0x0008;
export const TCIF_STATE = 0x0010;
export const TCIS_BUTTONPRESSED = 0x0001;
export const TCIS_HIGHLIGHTED = 0x0002;

/** TCHITTESTINFO: the point, then the flags the hit test answers in. */
export const TCHITTESTINFO = Object.freeze({ x: 0, y: 4, flags: 8 });
export const TCHT_NOWHERE = 0x0001;
export const TCHT_ONITEM = 0x0006;

/** WM_NOTIFY and the codes the control sends its parent. */
export const WM_NOTIFY = 0x004e;
export const NM_CLICK = -2;
export const TCN_SELCHANGE = -551;
export const TCN_SELCHANGING = -552;
export const TCN_FOCUSCHANGE = -554;
/** NMHDR: whom it is from, its id, and the code. */
const NMHDR_SIZE = 12;

const VK_LEFT = 0x25;
const VK_RIGHT = 0x27;

const DT_CENTER = 0x0001;
const DT_VCENTER = 0x0004;
const DT_SINGLELINE = 0x0020;

/**
 * A fixed-width tab is a logical inch wide until TCM_SETITEMSIZE says
 * otherwise, and the room either side of a label and above and below it
 * is TCM_SETPADDING's to change.
 */
const FIXED_WIDTH = 96;
const PADDING = Object.freeze({ x: 6, y: 3 });
/** A tab is at least this many average characters wide, padding aside. */
const MIN_CHARACTERS = 6;
/** Where the row starts, and how far the selected tab stands out of it. */
const ROW_TOP = 2;
const RAISE = 2;
/** The pane's border and the margin inside it. */
const PANE_INSET = 4;

/**
 * @typedef {import('../user32/controls.js').ControlHost} ControlHost
 * @typedef {import('../user32/controls.js').ControlMessage} ControlMessage
 * @typedef {import('../user32/controls.js').Rect} Rect
 *
 * @typedef {Object} TabItem
 * @property {string} text
 * @property {number} image
 * @property {Uint8Array} param  The item's own data: TCM_SETITEMEXTRA's many bytes.
 * @property {number} state
 *
 * @typedef {Object} TabState
 * @property {TabItem[]} items
 * @property {number} selected
 * @property {number} focus
 * @property {number} extra
 * @property {number} imageList
 * @property {number} minWidth  Negative for the default, which follows the font.
 * @property {number} extendedStyle
 * @property {number} width  A fixed-width tab's width.
 * @property {number} height  The row's height, 0 to follow the font.
 * @property {{ x: number, y: number }} padding  As TCM_SETPADDING last set it.
 * @property {{ x: number, y: number }} applied  The padding the tabs are laid
 *           out with: TCM_SETPADDING's, from the next time the list, the item
 *           size or the items change (Wine's tab tests).
 * @property {boolean} unicode
 * @property {number} pressed  The tab a button press landed on.
 */

/**
 * The image lists a tab control draws from: an image's size, and an image
 * drawn through its mask. Absent in a build without comctl32's image lists,
 * and then a tab has no image.
 *
 * @typedef {Object} TabImages
 * @property {(list: number) => { cx: number, cy: number } | null} size
 * @property {(list: number, index: number, hdc: number, x: number, y: number)
 *     => boolean} draw
 */

/**
 * Builds the window procedure of a tab control.
 *
 * @param {ControlHost} host
 * @param {any} tk  The drawing helpers the system classes share.
 * @param {TabImages} [images]
 * @returns {(record: any, message: ControlMessage, thread?: unknown)
 *     => number | Promise<number>}
 */
export function createTabProcedure(host, tk, images){
    /** @param {any} record @returns {TabState} */
    const state = record=>{
        const held = tk.stateOf(record);
        held.items ??= [];
        held.selected ??= -1;
        held.focus ??= -1;
        held.extra ??= 4;
        held.imageList ??= 0;
        held.minWidth ??= -1;
        held.extendedStyle ??= 0;
        held.width ??= FIXED_WIDTH;
        held.height ??= 0;
        held.padding ??= { ...PADDING };
        held.applied ??= { ...held.padding };
        held.unicode ??= false;
        held.pressed ??= -1;
        return held;
    };

    /** @param {any} record */
    const buttons = record=>(record.style & TCS_BUTTONS) !== 0;

    /** @param {number} address */
    const readU32 = address=>{
        const bytes = host.readMemory(address >>> 0, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };

    /** @param {number} address @param {number} limit */
    const readWide = (address, limit)=>{
        const bytes = host.readMemory(address >>> 0, limit * 2);
        let text = '';
        for (let at = 0; at + 1 < bytes.length; at += 2)
        {
            const unit = bytes[at] | bytes[at + 1] << 8;
            if (unit === 0)
            {
                break;
            }
            text += String.fromCharCode(unit);
        }
        return text;
    };

    /**
     * Copies text into a buffer of `room` characters, clipped and
     * terminated, in the program's spelling: UTF-16, or the ANSI page.
     *
     * @param {number} address @param {string} text @param {number} room @param {boolean} wide
     */
    const writeText = (address, text, room, wide)=>{
        if (room <= 0 || (address >>> 0) === 0)
        {
            return;
        }
        const clipped = text.slice(0, room - 1);
        if (!wide)
        {
            host.writeMemory(address >>> 0, encodeAnsi(`${clipped}\0`));
            return;
        }
        const bytes = new Uint8Array((clipped.length + 1) * 2);
        for (let index = 0; index < clipped.length; index++)
        {
            const unit = clipped.charCodeAt(index);
            bytes[index * 2] = unit & 0xff;
            bytes[index * 2 + 1] = unit >>> 8;
        }
        host.writeMemory(address >>> 0, bytes);
    };

    /**
     * Reads the fields of a TCITEM its mask names onto an item. The item's
     * data is as many bytes as TCM_SETITEMEXTRA said, from lParam on.
     *
     * @param {any} record @param {TabItem} item @param {number} address @param {boolean} wide
     * @param {boolean} states  Whether dwState is read, which an insert does not.
     */
    const readItem = (record, item, address, wide, states)=>{
        const mask = readU32(address + TCITEM.mask);
        if ((mask & TCIF_TEXT) !== 0)
        {
            const text = readU32(address + TCITEM.pszText);
            item.text = text === 0 ? '' : wide ? readWide(text, 1024)
                : host.readCString(text, 1024);
        }
        if ((mask & TCIF_IMAGE) !== 0)
        {
            item.image = readU32(address + TCITEM.iImage) | 0;
        }
        if ((mask & TCIF_PARAM) !== 0)
        {
            item.param = host.readMemory(address + TCITEM.lParam, state(record).extra);
        }
        if (states && (mask & TCIF_STATE) !== 0)
        {
            const stateMask = readU32(address + TCITEM.dwStateMask);
            item.state = (item.state & ~stateMask | readU32(address + TCITEM.dwState)
                & stateMask) >>> 0;
        }
    };

    /**
     * The fields of a TCITEM its mask asks for, filled in; for an item that
     * is not there, the numbers the mask names are zeroed and the text left.
     *
     * @param {any} record @param {TabItem | undefined} item @param {number} address
     * @param {boolean} wide
     */
    const writeItem = (record, item, address, wide)=>{
        const mask = readU32(address + TCITEM.mask);
        if ((mask & TCIF_TEXT) !== 0 && item)
        {
            writeText(readU32(address + TCITEM.pszText), item.text,
                readU32(address + TCITEM.cchTextMax) | 0, wide);
        }
        if ((mask & TCIF_IMAGE) !== 0)
        {
            tk.writeU32(address + TCITEM.iImage, item ? item.image : 0);
        }
        if ((mask & TCIF_PARAM) !== 0)
        {
            host.writeMemory(address + TCITEM.lParam,
                item ? item.param : new Uint8Array(state(record).extra));
        }
        if ((mask & TCIF_STATE) !== 0)
        {
            tk.writeU32(address + TCITEM.dwState,
                item ? item.state & readU32(address + TCITEM.dwStateMask) : 0);
        }
    };

    /**
     * The font's measures a layout needs: each label's width, the average
     * character's (the width of an x, as a font's average is defined) and
     * the line's height.
     *
     * @param {any} record
     */
    const measures = record=>{
        const held = state(record);
        if (!host.draw)
        {
            return { labels: held.items.map(()=>0), average: 7, line: 16 };
        }
        const draw = host.draw;
        const { hdc } = host.contextOn(record);
        const found = hdc === 0
            ? { labels: held.items.map(()=>0), average: 7, line: 16 }
            : {
                labels: held.items.map(item=>draw.measure(hdc, item.text).width),
                average: draw.measure(hdc, 'x').width,
                line: draw.measure(hdc, 'M').height,
            };
        host.endPaint(record, hdc);
        return found;
    };

    /**
     * The size of the images a tab shows, or null with no image list.
     *
     * @param {any} record
     */
    const iconOf = record=>{
        const list = state(record).imageList;
        return list !== 0 && images ? images.size(list) : null;
    };

    /**
     * Where each tab sits in the row, left to right, as it is drawn when not
     * selected. A fixed-width tab is as wide as it was set, and with an image
     * list no narrower than an image and four; any other is its label and
     * two paddings wide, or with an image the image and three, and no
     * narrower than the minimum -- six average characters and two paddings,
     * unless TCM_SETMINTABWIDTH named one (Wine's test_tab).
     *
     * @param {any} record
     * @returns {Rect[]}
     */
    const layout = record=>{
        const held = state(record);
        const measured = measures(record);
        const icon = iconOf(record);
        const padding = held.applied;
        const height = rowHeight(record);
        const least = held.minWidth < 0
            ? measured.average * MIN_CHARACTERS + 2 * padding.x
            : held.minWidth;
        let left = RAISE;
        return measured.labels.map((label, index)=>{
            const imaged = icon !== null && held.items[index].image >= 0;
            const width = (record.style & TCS_FIXEDWIDTH) !== 0
                ? Math.max(held.width, imaged ? icon.cx + 4 : 0)
                : Math.max(least, imaged ? label + icon.cx + 3 * padding.x
                    : label + 2 * padding.x);
            const rect = { left, top: ROW_TOP, right: left + width, bottom: ROW_TOP + height };
            left += width;
            return rect;
        });
    };

    /**
     * The row's height as it stands: as set, or the label's line -- or the
     * image, when that is taller -- and two paddings.
     *
     * @param {any} record
     */
    const rowHeight = record=>{
        const held = state(record);
        const icon = iconOf(record);
        return held.height > 0 ? held.height
            : Math.max(measures(record).line, icon ? icon.cy : 0) + 2 * held.applied.y - 1;
    };

    /** A new padding takes effect when the tabs are next laid out. @param {any} record */
    const relayout = record=>{
        const held = state(record);
        held.applied = { ...held.padding };
    };

    /** The pane under the row, border included. @param {any} record */
    const paneOf = record=>({ ...tk.clientRect(record), top: ROW_TOP + rowHeight(record) });

    /**
     * Tells the parent, WM_NOTIFY with an NMHDR in guest memory for as long
     * as the parent answers.
     *
     * @param {any} record @param {number} code @param {unknown} [thread]
     * @returns {number | Promise<number>}
     */
    const notify = (record, code, thread)=>{
        const address = notifyWindow(record) && host.allocate ? host.allocate(NMHDR_SIZE) : 0;
        if (address === 0)
        {
            return 0;
        }
        const bytes = new Uint8Array(NMHDR_SIZE);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, record.hwnd >>> 0, true);
        view.setUint32(4, record.id >>> 0, true);
        view.setInt32(8, code, true);
        host.writeMemory(address, bytes);
        const sent = host.send(notifyWindow(record), WM_NOTIFY, record.id & 0xffff, address,
            thread);
        return after(sent, answer=>{
            host.release?.(address);
            return answer;
        });
    };

    /** @param {any} record @param {number} index  The selection, marked on the items. */
    const select = (record, index)=>{
        const held = state(record);
        held.items.forEach((item, at)=>{
            item.state = at === index ? item.state | TCIS_BUTTONPRESSED
                : item.state & ~TCIS_BUTTONPRESSED;
        });
        held.selected = index;
        if (!buttons(record))
        {
            held.focus = index;
        }
        host.invalidate(record);
    };

    /**
     * Moves the selection to an item as the person does: the parent is
     * asked with TCN_SELCHANGING first, and a TRUE answer keeps things as
     * they were; then it is told TCN_SELCHANGE. Taking the selection away
     * altogether is only told. In the tab form the focus goes with it.
     *
     * @param {any} record @param {number} index @param {unknown} [thread]
     * @returns {number | Promise<number>}
     */
    const choose = (record, index, thread)=>{
        const held = state(record);
        const current = buttons(record) ? held.selected : held.focus;
        if (index === current || index >= held.items.length)
        {
            return 0;
        }
        const apply = ()=>{
            select(record, index < 0 ? -1 : index);
            if (buttons(record) && index >= 0)
            {
                held.focus = index;
            }
            const told = raiseEvent(host, record, EVENT_OBJECT_SELECTION, held.selected + 1,
                thread);
            return after(told, ()=>after(notify(record, TCN_SELCHANGE, thread), ()=>0));
        };
        if (index < 0)
        {
            return apply();
        }
        return after(notify(record, TCN_SELCHANGING, thread),
            refused=>((refused | 0) !== 0 ? 0 : apply()));
    };

    /**
     * Moves the focus alone, as the button form does: the parent is told
     * TCN_FOCUSCHANGE, and an index outside the buttons is passed over.
     *
     * @param {any} record @param {number} index @param {unknown} [thread]
     * @returns {number | Promise<number>}
     */
    const moveFocus = (record, index, thread)=>{
        const held = state(record);
        if (index < 0 || index >= held.items.length || index === held.focus)
        {
            return 0;
        }
        held.focus = index;
        host.invalidate(record);
        return after(raiseEvent(host, record, EVENT_OBJECT_FOCUS, index + 1, thread),
            ()=>after(notify(record, TCN_FOCUSCHANGE, thread), ()=>0));
    };

    /** @param {any} record @param {number} x @param {number} y */
    const itemAt = (record, x, y)=>layout(record).findIndex(rect=>x >= rect.left
        && x < rect.right && y >= rect.top - RAISE && y < rect.bottom);

    /**
     * A tab's image at its left, a padding in and centred on its height, and
     * the rectangle left for its label.
     *
     * @param {any} record @param {number} hdc @param {number} index @param {Rect} rect
     * @returns {Rect}
     */
    const drawImage = (record, hdc, index, rect)=>{
        const held = state(record);
        const icon = iconOf(record);
        const item = held.items[index];
        if (!icon || !images || item.image < 0)
        {
            return rect;
        }
        const x = rect.left + held.applied.x;
        images.draw(held.imageList, item.image, hdc, x,
            rect.top + ((rect.bottom - rect.top - icon.cy) >> 1));
        return { ...rect, left: x + icon.cx };
    };

    /** @param {any} record @param {number} hdc */
    const paintTabs = (record, hdc)=>{
        const draw = /** @type {any} */ (host.draw);
        const held = state(record);
        const face = tk.color(COLOR_3DFACE);
        const light = tk.color(COLOR_3DHILIGHT);
        const shadow = tk.color(COLOR_3DSHADOW);
        const dark = tk.color(COLOR_3DDKSHADOW);
        draw.fill(hdc, tk.clientRect(record), face);
        const ink = tk.disabled(record) ? tk.color(COLOR_GRAYTEXT) : tk.color(COLOR_BTNTEXT);
        if (buttons(record))
        {
            // Push buttons over a pane with no border: a pressed one sunk in
            // and its label moved with it, and in the flat form the others
            // level with the face.
            layout(record).forEach((rect, index)=>{
                const pressed = (held.items[index].state & TCIS_BUTTONPRESSED) !== 0;
                if (pressed || (record.style & TCS_FLATBUTTONS) === 0)
                {
                    tk.buttonEdge(hdc, rect, pressed);
                }
                const shift = pressed ? 1 : 0;
                const label = drawImage(record, hdc, index, {
                    left: rect.left + shift, top: rect.top + shift,
                    right: rect.right + shift, bottom: rect.bottom + shift,
                });
                tk.drawText(hdc, held.items[index].text, label,
                    DT_CENTER | DT_VCENTER | DT_SINGLELINE, ink);
            });
            return;
        }
        tk.buttonEdge(hdc, paneOf(record), false);
        layout(record).forEach((rect, index)=>{
            // The selected tab stands out of the row and over the pane's own
            // top edge, so the two read as one piece.
            const tab = index === held.selected
                ? { left: rect.left - RAISE, top: rect.top - RAISE, right: rect.right + RAISE,
                    bottom: rect.bottom + 2 }
                : rect;
            draw.fill(hdc, tab, face);
            draw.fill(hdc, { left: tab.left, top: tab.top + 2, right: tab.left + 1,
                bottom: tab.bottom }, light);
            draw.fill(hdc, { left: tab.left + 1, top: tab.top + 1, right: tab.left + 2,
                bottom: tab.top + 2 }, light);
            draw.fill(hdc, { left: tab.left + 2, top: tab.top, right: tab.right - 2,
                bottom: tab.top + 1 }, light);
            draw.fill(hdc, { left: tab.right - 2, top: tab.top + 1, right: tab.right - 1,
                bottom: tab.bottom }, shadow);
            draw.fill(hdc, { left: tab.right - 1, top: tab.top + 2, right: tab.right,
                bottom: tab.bottom }, dark);
            tk.drawText(hdc, held.items[index].text, drawImage(record, hdc, index, tab),
                DT_CENTER | DT_VCENTER | DT_SINGLELINE, ink);
        });
    };

    /**
     * @param {any} record @param {ControlMessage} message @param {unknown} [thread]
     */
    return (record, message, thread)=>{
        const held = state(record);
        const wide = message.message === TCM_GETITEMW || message.message === TCM_SETITEMW
            || message.message === TCM_INSERTITEMW;
        switch (message.message){
            case WM_CREATE:
                // The control clips its siblings, and a vertical row only
                // fits as several.
                record.style = (record.style | WS_CLIPSIBLINGS
                    | ((record.style & TCS_VERTICAL) !== 0 ? TCS_MULTILINE : 0)) >>> 0;
                return tk.common(record, message, thread);
            case WM_PAINT:
                return tk.painting(record, (/** @type {number} */ hdc)=>{
                    paintTabs(record, hdc);
                    return 0;
                });
            case WM_ERASEBKGND:
                return 1;
            case WM_GETDLGCODE:
                return DLGC_WANTARROWS | DLGC_WANTCHARS;
            case WM_SETFOCUS:
            case WM_KILLFOCUS:
                host.invalidate(record);
                return 0;
            case WM_LBUTTONDOWN: {
                const point = pointOf(message.lParam);
                const index = itemAt(record, point.x, point.y);
                held.pressed = index;
                const focused = (record.style & TCS_FOCUSNEVER) !== 0
                    ? 0 : host.setFocus(record.hwnd, thread);
                return after(focused, ()=>(index >= 0 ? choose(record, index, thread) : 0));
            }
            case WM_LBUTTONUP: {
                const pressed = held.pressed;
                held.pressed = -1;
                return pressed >= 0 ? after(notify(record, NM_CLICK, thread), ()=>0) : 0;
            }
            case WM_KEYDOWN: {
                const key = message.wParam >>> 0;
                const step = key === VK_LEFT ? -1 : key === VK_RIGHT ? 1 : 0;
                const to = held.focus + step;
                if (step === 0 || to < 0 || to >= held.items.length)
                {
                    return 0;
                }
                return buttons(record) ? moveFocus(record, to, thread)
                    : choose(record, to, thread);
            }
            case TCM_GETITEMCOUNT:
                return held.items.length;
            case TCM_INSERTITEMA:
            case TCM_INSERTITEMW: {
                if ((message.lParam >>> 0) === 0)
                {
                    return -1 >>> 0;
                }
                /** @type {TabItem} */
                const item = { text: '', image: -1, param: new Uint8Array(held.extra), state: 0 };
                readItem(record, item, message.lParam >>> 0, wide, false);
                const index = Math.max(0, Math.min(held.items.length, message.wParam | 0));
                held.items.splice(index, 0, item);
                relayout(record);
                if (held.selected >= index)
                {
                    held.selected++;
                }
                if (held.focus >= index)
                {
                    held.focus++;
                }
                // A control with no focus gives it to the tab it is handed:
                // the first of a new control, the new one of an emptied.
                if (held.focus === -1)
                {
                    select(record, index);
                    held.focus = index;
                }
                host.invalidate(record);
                // The new item is told of, and the selection a control with
                // no focus gave it is not: comctl32's tab tests see exactly that.
                return after(raiseEvent(host, record, EVENT_OBJECT_CREATE, index + 1, thread),
                    ()=>index);
            }
            case TCM_GETITEMA:
            case TCM_GETITEMW: {
                const item = held.items[message.wParam | 0];
                if ((message.lParam >>> 0) === 0)
                {
                    return 0;
                }
                writeItem(record, item, message.lParam >>> 0, wide);
                return item ? 1 : 0;
            }
            case TCM_SETITEMA:
            case TCM_SETITEMW: {
                const item = held.items[message.wParam | 0];
                if (!item || (message.lParam >>> 0) === 0)
                {
                    return 0;
                }
                readItem(record, item, message.lParam >>> 0, wide, true);
                host.invalidate(record);
                return 1;
            }
            case TCM_DELETEITEM: {
                const index = message.wParam | 0;
                if (index < 0 || index >= held.items.length)
                {
                    return 0;
                }
                held.items.splice(index, 1);
                /** @param {number} at */
                const shifted = at=>(at === index ? -1 : at > index ? at - 1 : at);
                held.selected = shifted(held.selected);
                held.focus = shifted(held.focus);
                host.invalidate(record);
                return after(raiseEvent(host, record, EVENT_OBJECT_DESTROY, index + 1, thread),
                    ()=>1);
            }
            case TCM_DELETEALLITEMS:
                held.items.length = 0;
                held.selected = -1;
                held.focus = -1;
                host.invalidate(record);
                return 1;
            case TCM_GETCURSEL:
                return held.selected >>> 0;
            case TCM_SETCURSEL: {
                // Told to nobody: the program moved it, not the person.
                const index = message.wParam | 0;
                if (index >= held.items.length)
                {
                    return -1 >>> 0;
                }
                const previous = held.selected;
                select(record, index < 0 ? -1 : index);
                return after(raiseEvent(host, record, EVENT_OBJECT_SELECTION, held.selected + 1,
                    thread), ()=>previous >>> 0);
            }
            case TCM_GETCURFOCUS:
                return held.focus >>> 0;
            case TCM_SETCURFOCUS: {
                const index = message.wParam | 0;
                return after(buttons(record) ? moveFocus(record, index, thread)
                    : choose(record, index, thread), ()=>0);
            }
            case TCM_GETITEMRECT: {
                const rect = layout(record)[message.wParam | 0];
                if (!rect || (message.lParam >>> 0) === 0)
                {
                    return 0;
                }
                [rect.left, rect.top, rect.right, rect.bottom].forEach((value, index)=>
                    tk.writeU32((message.lParam >>> 0) + index * 4, value));
                return 1;
            }
            case TCM_HITTEST: {
                const at = message.lParam >>> 0;
                if (at === 0)
                {
                    return -1 >>> 0;
                }
                const index = itemAt(record, readU32(at + TCHITTESTINFO.x) | 0,
                    readU32(at + TCHITTESTINFO.y) | 0);
                tk.writeU32(at + TCHITTESTINFO.flags, index >= 0 ? TCHT_ONITEM : TCHT_NOWHERE);
                return index >>> 0;
            }
            case TCM_ADJUSTRECT: {
                // The pane inside a window rectangle (FALSE), or the window
                // rectangle around a pane (TRUE): the row of tabs above it,
                // its border and margin around it.
                const at = message.lParam >>> 0;
                if (at === 0)
                {
                    return -1 >>> 0;
                }
                const top = ROW_TOP + rowHeight(record) + PANE_INSET;
                const [left, upper, right, bottom] = [0, 4, 8, 12].map(offset=>
                    readU32(at + offset) | 0);
                const sign = message.wParam !== 0 ? -1 : 1;
                [left + sign * PANE_INSET, upper + sign * top, right - sign * PANE_INSET,
                    bottom - sign * PANE_INSET].forEach((value, index)=>
                    tk.writeU32(at + index * 4, value));
                return 0;
            }
            case TCM_SETITEMEXTRA:
                if (held.items.length > 0 || (message.wParam | 0) < 0)
                {
                    return 0;
                }
                held.extra = message.wParam | 0;
                return 1;
            case TCM_SETITEMSIZE: {
                // A fixed-width tab takes both; any other only the height. The
                // same size again lays nothing out anew.
                const answer = ((rowHeight(record) & 0xffff) << 16 | held.width & 0xffff) >>> 0;
                if ((message.lParam & 0xffff) !== held.width
                    || message.lParam >>> 16 !== held.height)
                {
                    relayout(record);
                }
                held.width = message.lParam & 0xffff;
                held.height = message.lParam >>> 16;
                host.invalidate(record);
                return answer;
            }
            case TCM_SETPADDING:
                held.padding = { x: message.lParam & 0xffff, y: message.lParam >>> 16 };
                host.invalidate(record);
                return 0;
            case TCM_SETMINTABWIDTH: {
                const previous = held.minWidth;
                held.minWidth = message.lParam | 0;
                host.invalidate(record);
                return previous >>> 0;
            }
            case TCM_GETROWCOUNT:
                return 1;
            case TCM_GETIMAGELIST:
                return held.imageList;
            case TCM_SETIMAGELIST: {
                const previous = held.imageList;
                held.imageList = message.lParam >>> 0;
                relayout(record);
                host.invalidate(record);
                return previous;
            }
            case TCM_REMOVEIMAGE: {
                // The items follow the images that are left; the list itself
                // is comctl32's, and nothing here takes an image out of it.
                const removed = message.wParam | 0;
                for (const item of held.items)
                {
                    item.image = item.image === removed ? -1
                        : item.image > removed ? item.image - 1 : item.image;
                }
                host.divergence?.('TCM_REMOVEIMAGE', 'the image list keeps the image');
                host.invalidate(record);
                return 0;
            }
            case TCM_GETTOOLTIPS:
            case TCM_SETTOOLTIPS:
                return 0;
            case TCM_DESELECTALL: {
                // Only buttons stay pressed apart from the selection.
                if (buttons(record))
                {
                    const keep = message.wParam !== 0 ? held.focus : -1;
                    held.items.forEach((item, at)=>{
                        item.state = at === keep ? item.state : item.state & ~TCIS_BUTTONPRESSED;
                    });
                    held.selected = keep;
                    host.invalidate(record);
                }
                return 0;
            }
            case TCM_HIGHLIGHTITEM: {
                const item = held.items[message.wParam | 0];
                if (!item)
                {
                    return 0;
                }
                item.state = (message.lParam & 0xffff) !== 0 ? item.state | TCIS_HIGHLIGHTED
                    : item.state & ~TCIS_HIGHLIGHTED;
                host.invalidate(record);
                return 1;
            }
            case TCM_SETEXTENDEDSTYLE: {
                const previous = held.extendedStyle;
                const mask = (message.wParam >>> 0) || 0xffffffff;
                held.extendedStyle = (previous & ~mask | message.lParam & mask) >>> 0;
                return previous;
            }
            case TCM_GETEXTENDEDSTYLE:
                return held.extendedStyle;
            case TCM_SETUNICODEFORMAT: {
                const previous = held.unicode ? 1 : 0;
                held.unicode = message.wParam !== 0;
                return previous;
            }
            case TCM_GETUNICODEFORMAT:
                return held.unicode ? 1 : 0;
            default:
                return tk.common(record, message, thread);
        }
    };
}
