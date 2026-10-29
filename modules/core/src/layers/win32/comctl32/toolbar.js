/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The toolbar, `ToolbarWindow32`.
 *
 * A row of buttons, each an image and a command id, with separators between
 * groups. A click on an enabled button sends the owner -- the parent, or
 * the window TB_SETPARENT named -- WM_COMMAND with the button's id, as a
 * menu item does; a check button stays down until it is clicked again, and
 * of a check group one button is down at a time. The buttons sit side by
 * side from the indent, two pixels down, each as large as TB_SETBUTTONSIZE
 * made it and a separator as wide as its iBitmap, and a button whose state
 * carries TBSTATE_WRAP ends its row.
 *
 * The images are the toolbar's own image list, filled by TB_ADDBITMAP from
 * a bitmap handle or a resource of the program's -- masked by the button
 * face colour, which is the background a toolbar bitmap is drawn on -- or an
 * image list the program hands over with TB_SETIMAGELIST. A disabled button
 * shows its image embossed.
 *
 * What is not here: tooltips, the hot look of a flat button under the mouse,
 * drop-down buttons, customization, TB_AUTOSIZE, wrapping by width, and
 * comctl32's standard bitmaps, whose images are left blank.
 */

import {
    WM_PAINT, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_CAPTURECHANGED, WM_COMMAND,
    COLOR_3DFACE, COLOR_3DHILIGHT, COLOR_3DSHADOW, COLOR_BTNTEXT, COLOR_GRAYTEXT,
    pointOf,
} from '../user32/controls.js';
import { encodeAnsi } from '../kernel32/locale.js';
import { notifyWindow } from './notify.js';

/** The class name a program creates the control by. */
export const TOOLBAR_CLASS = 'ToolbarWindow32';

/** The atom spacing a build without a bridge gives the class's procedure. */
export const TOOLBAR_ATOM = 0x8014;

/** Button states. */
export const TBSTATE_CHECKED = 0x01;
export const TBSTATE_PRESSED = 0x02;
export const TBSTATE_ENABLED = 0x04;
export const TBSTATE_HIDDEN = 0x08;
export const TBSTATE_INDETERMINATE = 0x10;
export const TBSTATE_WRAP = 0x20;
export const TBSTATE_MARKED = 0x80;

/** Button styles. */
export const TBSTYLE_BUTTON = 0x00;
export const TBSTYLE_SEP = 0x01;
export const TBSTYLE_CHECK = 0x02;
export const TBSTYLE_GROUP = 0x04;
export const TBSTYLE_CHECKGROUP = TBSTYLE_GROUP | TBSTYLE_CHECK;

/** Window styles. */
export const TBSTYLE_FLAT = 0x0800;
export const TBSTYLE_LIST = 0x1000;

/** Messages, numbered off WM_USER as the header numbers them. */
const WM_USER = 0x0400;
export const TB_ENABLEBUTTON = WM_USER + 1;
export const TB_CHECKBUTTON = WM_USER + 2;
export const TB_PRESSBUTTON = WM_USER + 3;
export const TB_HIDEBUTTON = WM_USER + 4;
export const TB_INDETERMINATE = WM_USER + 5;
export const TB_MARKBUTTON = WM_USER + 6;
export const TB_ISBUTTONENABLED = WM_USER + 9;
export const TB_ISBUTTONCHECKED = WM_USER + 10;
export const TB_ISBUTTONPRESSED = WM_USER + 11;
export const TB_ISBUTTONHIDDEN = WM_USER + 12;
export const TB_ISBUTTONINDETERMINATE = WM_USER + 13;
export const TB_ISBUTTONHIGHLIGHTED = WM_USER + 14;
export const TB_SETSTATE = WM_USER + 17;
export const TB_GETSTATE = WM_USER + 18;
export const TB_ADDBITMAP = WM_USER + 19;
export const TB_ADDBUTTONSA = WM_USER + 20;
export const TB_INSERTBUTTONA = WM_USER + 21;
export const TB_DELETEBUTTON = WM_USER + 22;
export const TB_GETBUTTON = WM_USER + 23;
export const TB_BUTTONCOUNT = WM_USER + 24;
export const TB_COMMANDTOINDEX = WM_USER + 25;
export const TB_ADDSTRINGA = WM_USER + 28;
export const TB_GETITEMRECT = WM_USER + 29;
export const TB_BUTTONSTRUCTSIZE = WM_USER + 30;
export const TB_SETBUTTONSIZE = WM_USER + 31;
export const TB_SETBITMAPSIZE = WM_USER + 32;
export const TB_GETTOOLTIPS = WM_USER + 35;
export const TB_SETTOOLTIPS = WM_USER + 36;
export const TB_SETPARENT = WM_USER + 37;
export const TB_GETROWS = WM_USER + 40;
export const TB_GETBITMAPFLAGS = WM_USER + 41;
export const TB_SETCMDID = WM_USER + 42;
export const TB_GETBUTTONTEXTA = WM_USER + 45;
export const TB_REPLACEBITMAP = WM_USER + 46;
export const TB_SETINDENT = WM_USER + 47;
export const TB_SETIMAGELIST = WM_USER + 48;
export const TB_GETIMAGELIST = WM_USER + 49;
export const TB_GETRECT = WM_USER + 51;
export const TB_SETHOTIMAGELIST = WM_USER + 52;
export const TB_GETHOTIMAGELIST = WM_USER + 53;
export const TB_SETDISABLEDIMAGELIST = WM_USER + 54;
export const TB_GETDISABLEDIMAGELIST = WM_USER + 55;
export const TB_SETSTYLE = WM_USER + 56;
export const TB_GETSTYLE = WM_USER + 57;
export const TB_GETBUTTONSIZE = WM_USER + 58;
export const TB_SETMAXTEXTROWS = WM_USER + 60;
export const TB_GETTEXTROWS = WM_USER + 61;
export const TB_INSERTBUTTONW = WM_USER + 67;
export const TB_ADDBUTTONSW = WM_USER + 68;
export const TB_HITTEST = WM_USER + 69;
export const TB_GETHOTITEM = WM_USER + 71;
export const TB_SETHOTITEM = WM_USER + 72;
export const TB_GETBUTTONTEXTW = WM_USER + 75;
export const TB_ADDSTRINGW = WM_USER + 77;
export const TB_MOVEBUTTON = WM_USER + 82;
export const TB_GETMAXSIZE = WM_USER + 83;
export const TB_SETEXTENDEDSTYLE = WM_USER + 84;
export const TB_GETEXTENDEDSTYLE = WM_USER + 85;

/** TBBUTTON: iBitmap, idCommand, fsState, fsStyle, two bytes, dwData, iString. */
const TBBUTTON_SIZE = 20;
/** TBADDBITMAP's hInst for comctl32's own strips, and how many images each holds. */
const HINST_COMMCTRL = 0xffffffff;
const STANDARD_COUNTS = Object.freeze({ 0: 15, 1: 15, 4: 12, 5: 12, 8: 5, 9: 5 });
const ILC_MASK_COLOR32 = 0x0021;
/** The first row's distance from the top, and a separator's width when it gives none. */
const TOP_MARGIN = 2;
const SEPARATOR_WIDTH = 8;
const DT_CENTER = 0x0001;
const DT_VCENTER = 0x0004;
const DT_SINGLELINE = 0x0020;

/**
 * @typedef {import('../user32/controls.js').ControlHost} ControlHost
 * @typedef {import('../user32/controls.js').ControlMessage} ControlMessage
 * @typedef {import('../user32/controls.js').Rect} Rect
 */

/**
 * The image lists a toolbar keeps its images in: the tab control's two calls,
 * the exports that make and fill a list, and a disabled button's embossed
 * picture. Absent in a build without comctl32's image lists, and then a
 * button has no image.
 *
 * @typedef {Object} ToolbarImages
 * @property {(list: number) => { cx: number, cy: number } | null} size
 * @property {(list: number, index: number, hdc: number, x: number, y: number) => boolean} draw
 * @property {(list: number, index: number, hdc: number, x: number, y: number,
 *     colors: { face: number, light: number, shadow: number }) => boolean} drawEmbossed
 * @property {Record<string, { handler: (args: number[]) => any }>} functions
 */

/**
 * @typedef {Object} Button
 * @property {number} image @property {number} command
 * @property {number} state @property {number} style
 * @property {number} data
 * @property {number | string} string  An index into the toolbar's strings, or the text.
 */

/**
 * Builds the window procedure of a toolbar.
 *
 * @param {ControlHost} host
 * @param {any} tk  The drawing helpers the system classes share.
 * @param {ToolbarImages} [images]
 * @param {{ loadBitmap?: (instance: number, id: number) => number }} [resources]
 * @returns {(record: any, message: ControlMessage, thread?: unknown)
 *     => number | Promise<number>}
 */
export function createToolbarProcedure(host, tk, images, resources = {}){
    /**
     * @param {any} record
     * @returns {{ buttons: Button[], structSize: number, bitmap: { cx: number, cy: number },
     *     button: { cx: number, cy: number }, indent: number, owner: number | null,
     *     extended: number, list: number, ownList: boolean, disabledList: number,
     *     hotList: number, tooltips: number, textRows: number, strings: string[],
     *     images: number, sources: { instance: number, id: number, bitmap: number,
     *         count: number }[], pressed: number, said: Set<number> }}
     */
    const state = record=>{
        const held = tk.stateOf(record);
        held.buttons ??= [];
        held.structSize ??= TBBUTTON_SIZE;
        held.bitmap ??= { cx: 16, cy: 15 };
        held.button ??= { cx: 23, cy: 22 };
        held.indent ??= 0;
        held.owner ??= null;
        held.extended ??= 0;
        held.list ??= 0;
        held.ownList ??= false;
        held.disabledList ??= 0;
        held.hotList ??= 0;
        held.tooltips ??= 0;
        held.textRows ??= 1;
        held.strings ??= [];
        held.images ??= 0;
        held.sources ??= [];
        held.pressed ??= -1;
        held.said ??= new Set();
        return held;
    };

    /** @param {string} name @param {...number} args */
    const imageCall = (name, ...args)=>images?.functions[name]?.handler(args) ?? -1;

    /** @param {number} address @param {boolean} wide */
    const readText = (address, wide)=>{
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

    /** @param {number} address @param {boolean} wide @returns {Button} */
    const readButton = (address, wide)=>{
        const bytes = host.readMemory(address, TBBUTTON_SIZE);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const string = view.getInt32(16, true);
        return {
            image: view.getInt32(0, true),
            command: view.getInt32(4, true),
            state: bytes[8],
            style: bytes[9],
            data: view.getUint32(12, true),
            // Past the 64K an index can be, iString is the text itself; -1 is
            // no text at all.
            string: string !== -1 && (string >>> 0) > 0xffff ? readText(string >>> 0, wide)
                : string,
        };
    };

    /** @param {any} record @param {number} address @param {Button} button */
    const writeButton = (record, address, button)=>{
        const bytes = new Uint8Array(TBBUTTON_SIZE);
        const view = new DataView(bytes.buffer);
        view.setInt32(0, button.image, true);
        view.setInt32(4, button.command, true);
        bytes[8] = button.state;
        bytes[9] = button.style;
        view.setUint32(12, button.data, true);
        view.setInt32(16, typeof button.string === 'number' ? button.string : -1, true);
        host.writeMemory(address, bytes.subarray(0, Math.min(TBBUTTON_SIZE,
            state(record).structSize)));
    };

    /** @param {any} record @param {Button} button @returns {string} */
    const textOf = (record, button)=>(typeof button.string === 'string' ? button.string
        : state(record).strings[button.string] ?? '');

    /** @param {any} record @param {number} command */
    const indexOf = (record, command)=>state(record).buttons
        .findIndex(button=>button.command === (command | 0));

    /**
     * Each button's rectangle in the client area, null for a hidden one.
     *
     * @param {any} record @returns {(Rect | null)[]}
     */
    const layout = record=>{
        const held = state(record);
        const flat = (record.style & TBSTYLE_FLAT) !== 0;
        let x = held.indent;
        let y = TOP_MARGIN;
        return held.buttons.map(button=>{
            if ((button.state & TBSTATE_HIDDEN) !== 0)
            {
                return null;
            }
            const separator = (button.style & TBSTYLE_SEP) !== 0;
            const width = separator ? (button.image > 0 ? button.image : SEPARATOR_WIDTH)
                : held.button.cx;
            const rect = { left: x, top: y, right: x + width, bottom: y + held.button.cy };
            x += width;
            if ((button.state & TBSTATE_WRAP) !== 0)
            {
                // A wrapping separator stands for a gap between the rows,
                // two thirds of its width on a toolbar with raised buttons.
                x = held.indent;
                y += held.button.cy + (separator ? (flat ? width : Math.floor(width * 2 / 3)) : 0);
            }
            return rect;
        });
    };

    /** @param {any} record @param {number} x @param {number} y */
    const hit = (record, x, y)=>layout(record)
        .findIndex(rect=>rect !== null && tk.contains(rect, x, y));

    /**
     * Sets or clears state bits; checking a button of a check group clears
     * the rest of its group.
     *
     * @param {any} record @param {number} index @param {number} bits @param {boolean} on
     */
    const setState = (record, index, bits, on)=>{
        const held = state(record);
        const button = held.buttons[index];
        button.state = on ? button.state | bits : button.state & ~bits;
        if (on && (bits & TBSTATE_CHECKED) !== 0 && (button.style & TBSTYLE_GROUP) !== 0)
        {
            /** @param {number} at */
            const grouped = at=>held.buttons[at] && (held.buttons[at].style & TBSTYLE_GROUP) !== 0
                && (held.buttons[at].style & TBSTYLE_SEP) === 0;
            for (const step of [-1, 1])
            {
                for (let at = index + step; grouped(at); at += step)
                {
                    held.buttons[at].state &= ~TBSTATE_CHECKED;
                }
            }
        }
        host.invalidate(record);
    };

    /** @param {any} record @returns {number} the window WM_COMMAND and notifications go to */
    const ownerOf = record=>state(record).owner ?? notifyWindow(record);

    /**
     * Fills a list of the toolbar's own with `count` images from a bitmap,
     * each where the button's iBitmap counts it: the images before it padded
     * blank, any the bitmap has past `count` dropped.
     *
     * @param {any} record @param {number} bitmap @param {number} count
     * @returns {number} the first image's index
     */
    const addImages = (record, bitmap, count)=>{
        const held = state(record);
        const first = held.images;
        if (!images)
        {
            held.images += count;
            return first;
        }
        if (held.list === 0)
        {
            held.list = imageCall('ImageList_Create', held.bitmap.cx, held.bitmap.cy,
                ILC_MASK_COLOR32, 4, 4);
            held.ownList = true;
        }
        while (imageCall('ImageList_GetImageCount', held.list) < first)
        {
            imageCall('ImageList_Add', held.list, 0, 0);
        }
        if (bitmap !== 0)
        {
            imageCall('ImageList_AddMasked', held.list, bitmap, tk.color(COLOR_3DFACE));
        }
        const added = imageCall('ImageList_GetImageCount', held.list) - first;
        const kept = count > 0 ? count : Math.max(0, added);
        for (let at = first + added - 1; at >= first + kept; at--)
        {
            imageCall('ImageList_Remove', held.list, at);
        }
        held.images = first + kept;
        return first;
    };

    /**
     * TB_ADDBITMAP: a bitmap handle (hInst NULL), a bitmap resource of a
     * module, or one of comctl32's standard strips.
     *
     * @param {any} record @param {number} count @param {number} address  the TBADDBITMAP
     */
    const addBitmap = (record, count, address)=>{
        if (address === 0)
        {
            return -1;
        }
        const bytes = host.readMemory(address, 8);
        const view = new DataView(bytes.buffer, bytes.byteOffset, 8);
        const instance = view.getUint32(0, true);
        const id = view.getUint32(4, true);
        let bitmap = 0;
        if (instance === HINST_COMMCTRL)
        {
            host.divergence?.('TB_ADDBITMAP', `comctl32's standard bitmap ${id} is left blank`);
            count = /** @type {any} */ (STANDARD_COUNTS)[id] ?? count;
        }
        else
        {
            bitmap = instance === 0 ? id : resources.loadBitmap?.(instance, id) ?? 0;
            if (bitmap === 0)
            {
                return -1;
            }
        }
        const first = addImages(record, bitmap, count);
        state(record).sources.push({ instance, id, bitmap, count: state(record).images - first });
        host.invalidate(record);
        return first;
    };

    /**
     * TB_REPLACEBITMAP: the images one bitmap gave replaced by another's,
     * the list refilled from every bitmap in order.
     *
     * @param {any} record @param {number} address  the TBREPLACEBITMAP
     */
    const replaceBitmap = (record, address)=>{
        const held = state(record);
        if (address === 0)
        {
            return 0;
        }
        const bytes = host.readMemory(address, 20);
        const view = new DataView(bytes.buffer, bytes.byteOffset, 20);
        const [oldInstance, oldId, instance, id] = [0, 4, 8, 12]
            .map(at=>view.getUint32(at, true));
        const source = held.sources.find(entry=>entry.instance === oldInstance
            && entry.id === oldId);
        const bitmap = instance === 0 ? id : resources.loadBitmap?.(instance, id) ?? 0;
        if (!source || bitmap === 0)
        {
            return 0;
        }
        Object.assign(source, { instance, id, bitmap, count: view.getInt32(16, true) });
        // ponytail: refilled from the bitmap handles, so a bitmap the program
        // has deleted since comes back blank; copy out of the old list if one does.
        if (held.ownList)
        {
            imageCall('ImageList_Remove', held.list, -1);
        }
        held.images = 0;
        for (const entry of held.sources)
        {
            addImages(record, entry.bitmap, entry.count);
        }
        host.invalidate(record);
        return 1;
    };

    /**
     * @param {any} record @param {number} hdc @param {Button} button @param {Rect} rect
     */
    const paintButton = (record, hdc, button, rect)=>{
        const held = state(record);
        const draw = /** @type {any} */ (host.draw);
        const flat = (record.style & TBSTYLE_FLAT) !== 0;
        if ((button.style & TBSTYLE_SEP) !== 0)
        {
            if (flat)
            {
                const middle = Math.floor((rect.left + rect.right) / 2) - 1;
                tk.edge(hdc, { ...rect, left: middle, right: middle + 2 },
                    tk.color(COLOR_3DSHADOW), tk.color(COLOR_3DHILIGHT));
            }
            return;
        }
        const down = (button.state & (TBSTATE_PRESSED | TBSTATE_CHECKED)) !== 0;
        const enabled = (button.state & TBSTATE_ENABLED) !== 0;
        // ponytail: a checked button's face is the highlight colour, not the
        // dither between it and the face; a pattern brush when one is to hand.
        if ((button.state & TBSTATE_CHECKED) !== 0 && (button.state & TBSTATE_PRESSED) === 0)
        {
            draw.fill(hdc, tk.shrink(rect, 2), tk.color(COLOR_3DHILIGHT));
        }
        if (!flat)
        {
            tk.buttonEdge(hdc, rect, down);
        }
        else if (down)
        {
            tk.edge(hdc, rect, tk.color(COLOR_3DSHADOW), tk.color(COLOR_3DHILIGHT));
        }
        const text = textOf(record, button);
        const list = !enabled && held.disabledList !== 0 ? held.disabledList : held.list;
        const shift = down ? 1 : 0;
        const beside = (record.style & TBSTYLE_LIST) !== 0;
        const x = beside && text !== '' ? rect.left + 3 + shift
            : rect.left + Math.floor((rect.right - rect.left - held.bitmap.cx) / 2) + shift;
        const y = !beside && text !== '' ? rect.top + 3 + shift
            : rect.top + Math.floor((rect.bottom - rect.top - held.bitmap.cy) / 2) + shift;
        if (images && list !== 0 && button.image >= 0)
        {
            if (enabled || held.disabledList !== 0)
            {
                images.draw(list, button.image, hdc, x, y);
            }
            else
            {
                images.drawEmbossed(list, button.image, hdc, x, y, {
                    face: tk.color(COLOR_3DFACE), light: tk.color(COLOR_3DHILIGHT),
                    shadow: tk.color(COLOR_3DSHADOW),
                });
            }
        }
        if (text !== '')
        {
            const room = beside
                ? { left: x + held.bitmap.cx + 2, top: rect.top, right: rect.right - 2,
                    bottom: rect.bottom }
                : { left: rect.left + 2, top: y + held.bitmap.cy, right: rect.right - 2,
                    bottom: rect.bottom - 2 };
            tk.drawText(hdc, text, beside ? room : { ...room, left: room.left + shift },
                (beside ? 0 : DT_CENTER) | DT_VCENTER | DT_SINGLELINE,
                tk.color(enabled ? COLOR_BTNTEXT : COLOR_GRAYTEXT));
        }
    };

    /** @param {any} record @param {number} hdc */
    const paintToolbar = (record, hdc)=>{
        const rects = layout(record);
        state(record).buttons.forEach((button, index)=>{
            const rect = rects[index];
            if (rect)
            {
                paintButton(record, hdc, button, rect);
            }
        });
    };

    /** @param {number} address @param {Rect} rect */
    const writeRect = (address, rect)=>{
        const bytes = new Uint8Array(16);
        const view = new DataView(bytes.buffer);
        [rect.left, rect.top, rect.right, rect.bottom]
            .forEach((value, at)=>view.setInt32(at * 4, value, true));
        host.writeMemory(address, bytes);
    };

    /**
     * The state messages that take a command id and a flag in LOWORD(lParam).
     *
     * @type {Record<number, number>}
     */
    const STATE_SETTERS = {
        [TB_ENABLEBUTTON]: TBSTATE_ENABLED,
        [TB_CHECKBUTTON]: TBSTATE_CHECKED,
        [TB_PRESSBUTTON]: TBSTATE_PRESSED,
        [TB_HIDEBUTTON]: TBSTATE_HIDDEN,
        [TB_INDETERMINATE]: TBSTATE_INDETERMINATE,
        [TB_MARKBUTTON]: TBSTATE_MARKED,
    };
    /** @type {Record<number, number>} */
    const STATE_GETTERS = {
        [TB_ISBUTTONENABLED]: TBSTATE_ENABLED,
        [TB_ISBUTTONCHECKED]: TBSTATE_CHECKED,
        [TB_ISBUTTONPRESSED]: TBSTATE_PRESSED,
        [TB_ISBUTTONHIDDEN]: TBSTATE_HIDDEN,
        [TB_ISBUTTONINDETERMINATE]: TBSTATE_INDETERMINATE,
        [TB_ISBUTTONHIGHLIGHTED]: TBSTATE_MARKED,
    };

    /**
     * @param {any} record @param {ControlMessage} message @param {unknown} [thread]
     */
    return (record, message, thread)=>{
        const held = state(record);
        const wParam = message.wParam >>> 0;
        const lParam = message.lParam >>> 0;
        const id = message.message >>> 0;
        if (id in STATE_SETTERS)
        {
            const index = indexOf(record, wParam);
            if (index < 0)
            {
                return 0;
            }
            setState(record, index, STATE_SETTERS[id], (lParam & 0xffff) !== 0);
            return 1;
        }
        if (id in STATE_GETTERS)
        {
            const button = held.buttons[indexOf(record, wParam)];
            return button ? button.state & STATE_GETTERS[id] : 0;
        }
        switch (id){
            case WM_PAINT:
                return tk.painting(record, (/** @type {number} */ hdc)=>{
                    paintToolbar(record, hdc);
                    return 0;
                });
            case WM_LBUTTONDOWN: {
                const point = pointOf(lParam);
                const index = hit(record, point.x, point.y);
                const button = held.buttons[index];
                if (!button || (button.style & TBSTYLE_SEP) !== 0
                    || (button.state & TBSTATE_ENABLED) === 0)
                {
                    return 0;
                }
                held.pressed = index;
                host.setCapture(record.hwnd);
                setState(record, index, TBSTATE_PRESSED, true);
                return 0;
            }
            case WM_MOUSEMOVE: {
                const rect = held.pressed < 0 ? null : layout(record)[held.pressed];
                if (!rect)
                {
                    return 0;
                }
                const point = pointOf(lParam);
                const inside = tk.contains(rect, point.x, point.y);
                if (inside !== ((held.buttons[held.pressed].state & TBSTATE_PRESSED) !== 0))
                {
                    setState(record, held.pressed, TBSTATE_PRESSED, inside);
                }
                return 0;
            }
            case WM_LBUTTONUP: {
                const index = held.pressed;
                const button = held.buttons[index];
                held.pressed = -1;
                if (host.capture() === record.hwnd)
                {
                    host.releaseCapture();
                }
                if (!button || (button.state & TBSTATE_PRESSED) === 0)
                {
                    return 0;
                }
                setState(record, index, TBSTATE_PRESSED, false);
                if ((button.style & TBSTYLE_CHECK) !== 0)
                {
                    // A check group's button stays checked when clicked again.
                    const checked = (button.state & TBSTATE_CHECKED) !== 0;
                    setState(record, index, TBSTATE_CHECKED,
                        !checked || (button.style & TBSTYLE_GROUP) !== 0);
                }
                return host.send(ownerOf(record), WM_COMMAND, button.command & 0xffff,
                    record.hwnd, thread);
            }
            case WM_CAPTURECHANGED:
                if (held.pressed >= 0 && held.buttons[held.pressed])
                {
                    setState(record, held.pressed, TBSTATE_PRESSED, false);
                }
                held.pressed = -1;
                return 0;
            case TB_BUTTONSTRUCTSIZE:
                held.structSize = wParam;
                return 0;
            case TB_SETBITMAPSIZE:
                // The size is the images', fixed once an image is in the list.
                if (held.ownList && imageCall('ImageList_GetImageCount', held.list) > 0)
                {
                    return 0;
                }
                if (held.ownList)
                {
                    imageCall('ImageList_Destroy', held.list);
                    held.list = 0;
                    held.ownList = false;
                }
                held.bitmap = { cx: (lParam & 0xffff) || 16, cy: (lParam >>> 16) || 15 };
                return 1;
            case TB_SETBUTTONSIZE:
                held.button = { cx: (lParam & 0xffff) || 24, cy: (lParam >>> 16) || 22 };
                host.invalidate(record);
                return 1;
            case TB_GETBUTTONSIZE:
                return (held.button.cy << 16 | held.button.cx) >>> 0;
            case TB_ADDBITMAP:
                return addBitmap(record, wParam | 0, lParam);
            case TB_REPLACEBITMAP:
                return replaceBitmap(record, lParam);
            case TB_ADDBUTTONSA:
            case TB_ADDBUTTONSW:
            case TB_INSERTBUTTONA:
            case TB_INSERTBUTTONW: {
                const wide = id === TB_ADDBUTTONSW || id === TB_INSERTBUTTONW;
                const adding = id === TB_ADDBUTTONSA || id === TB_ADDBUTTONSW;
                if (lParam === 0)
                {
                    return 0;
                }
                const count = adding ? wParam : 1;
                const at = adding || (wParam | 0) < 0 || (wParam | 0) > held.buttons.length
                    ? held.buttons.length : wParam | 0;
                const added = Array.from({ length: count },
                    (_, index)=>readButton(lParam + index * held.structSize, wide));
                held.buttons.splice(at, 0, ...added);
                host.invalidate(record);
                return 1;
            }
            case TB_DELETEBUTTON:
                if ((wParam | 0) < 0 || (wParam | 0) >= held.buttons.length)
                {
                    return 0;
                }
                held.buttons.splice(wParam | 0, 1);
                host.invalidate(record);
                return 1;
            case TB_MOVEBUTTON: {
                const [button] = held.buttons.splice(wParam | 0, 1);
                if (!button)
                {
                    return 0;
                }
                held.buttons.splice(Math.min(lParam | 0, held.buttons.length), 0, button);
                host.invalidate(record);
                return 1;
            }
            case TB_GETBUTTON: {
                const button = held.buttons[wParam | 0];
                if (!button || lParam === 0)
                {
                    return 0;
                }
                writeButton(record, lParam, button);
                return 1;
            }
            case TB_BUTTONCOUNT:
                return held.buttons.length;
            case TB_COMMANDTOINDEX:
                return indexOf(record, wParam);
            case TB_SETCMDID: {
                const button = held.buttons[wParam | 0];
                if (!button)
                {
                    return 0;
                }
                button.command = lParam | 0;
                return 1;
            }
            case TB_SETSTATE: {
                const button = held.buttons[indexOf(record, wParam)];
                if (!button)
                {
                    return 0;
                }
                button.state = lParam & 0xff;
                host.invalidate(record);
                return 1;
            }
            case TB_GETSTATE: {
                const button = held.buttons[indexOf(record, wParam)];
                return button ? button.state : -1 >>> 0;
            }
            case TB_GETITEMRECT:
            case TB_GETRECT: {
                const index = id === TB_GETRECT ? indexOf(record, wParam) : wParam | 0;
                const rect = layout(record)[index];
                if (!rect || lParam === 0)
                {
                    return 0;
                }
                writeRect(lParam, rect);
                return 1;
            }
            case TB_HITTEST: {
                if (lParam === 0)
                {
                    return -1 >>> 0;
                }
                const bytes = host.readMemory(lParam, 8);
                const view = new DataView(bytes.buffer, bytes.byteOffset, 8);
                const index = hit(record, view.getInt32(0, true), view.getInt32(4, true));
                // A separator answers its index negated, nowhere -1.
                return (index < 0 ? -1
                    : (held.buttons[index].style & TBSTYLE_SEP) !== 0 ? -index : index) >>> 0;
            }
            case TB_GETMAXSIZE: {
                const rects = /** @type {Rect[]} */ (layout(record).filter(Boolean));
                if (lParam === 0)
                {
                    return 0;
                }
                const width = Math.max(0, ...rects.map(rect=>rect.right)) - held.indent;
                const height = Math.max(0, ...rects.map(rect=>rect.bottom)) - TOP_MARGIN;
                host.writeMemory(lParam, new Uint8Array(new Int32Array([width, height]).buffer));
                return 1;
            }
            case TB_GETROWS:
                return 1 + held.buttons.filter(button=>(button.state & TBSTATE_WRAP) !== 0
                    && (button.state & TBSTATE_HIDDEN) === 0).length;
            case TB_ADDSTRINGA:
            case TB_ADDSTRINGW: {
                const wide = id === TB_ADDSTRINGW;
                if (wParam !== 0)
                {
                    host.divergence?.(wide ? 'TB_ADDSTRINGW' : 'TB_ADDSTRINGA',
                        'a string resource is not read');
                    return -1 >>> 0;
                }
                // A run of strings, each ended by a null, the run by another.
                const first = held.strings.length;
                for (let at = lParam; at !== 0;)
                {
                    const text = readText(at, wide);
                    if (text === '')
                    {
                        break;
                    }
                    held.strings.push(text);
                    at += (text.length + 1) * (wide ? 2 : 1);
                }
                return first;
            }
            case TB_GETBUTTONTEXTA:
            case TB_GETBUTTONTEXTW: {
                const button = held.buttons[indexOf(record, wParam)];
                if (!button)
                {
                    return -1 >>> 0;
                }
                const text = textOf(record, button);
                if (lParam !== 0)
                {
                    host.writeMemory(lParam, id === TB_GETBUTTONTEXTW
                        ? new Uint8Array(new Uint16Array([...`${text}\0`]
                            .map(c=>c.charCodeAt(0))).buffer)
                        : encodeAnsi(`${text}\0`));
                }
                return text.length;
            }
            case TB_SETPARENT: {
                const previous = ownerOf(record);
                held.owner = wParam;
                return previous;
            }
            case TB_SETINDENT:
                held.indent = wParam | 0;
                host.invalidate(record);
                return 1;
            case TB_SETEXTENDEDSTYLE: {
                const previous = held.extended;
                // A mask in wParam limits which bits change; none, every one.
                const mask = wParam === 0 ? 0xffffffff : wParam;
                held.extended = ((held.extended & ~mask) | (lParam & mask)) >>> 0;
                return previous;
            }
            case TB_GETEXTENDEDSTYLE:
                return held.extended;
            case TB_SETSTYLE:
                record.style = lParam;
                host.invalidate(record);
                return 0;
            case TB_GETSTYLE:
                return record.style >>> 0;
            case TB_GETTOOLTIPS:
                return held.tooltips;
            case TB_SETTOOLTIPS:
                held.tooltips = wParam;
                return 0;
            case TB_SETMAXTEXTROWS:
                held.textRows = wParam;
                return 1;
            case TB_GETTEXTROWS:
                return held.textRows;
            case TB_GETBITMAPFLAGS:
                return 0;
            case TB_SETIMAGELIST: {
                const previous = held.list;
                const wasOwn = held.ownList;
                if (wasOwn)
                {
                    imageCall('ImageList_Destroy', held.list);
                }
                held.list = lParam;
                held.ownList = false;
                const size = images?.size(lParam);
                if (size)
                {
                    held.bitmap = { cx: size.cx, cy: size.cy };
                }
                host.invalidate(record);
                return wasOwn ? 0 : previous;
            }
            case TB_GETIMAGELIST:
                return held.list;
            case TB_SETDISABLEDIMAGELIST: {
                const previous = held.disabledList;
                held.disabledList = lParam;
                return previous;
            }
            case TB_GETDISABLEDIMAGELIST:
                return held.disabledList;
            case TB_SETHOTIMAGELIST: {
                const previous = held.hotList;
                held.hotList = lParam;
                return previous;
            }
            case TB_GETHOTIMAGELIST:
                return held.hotList;
            case TB_GETHOTITEM:
                return -1 >>> 0;
            case TB_SETHOTITEM:
                return -1 >>> 0;
            default:
                if (id >= WM_USER && id < WM_USER + 0x100 && !held.said.has(id))
                {
                    held.said.add(id);
                    host.divergence?.(TOOLBAR_CLASS,
                        `message 0x${id.toString(16)} is not handled`);
                }
                return tk.common(record, message, thread);
        }
    };
}
