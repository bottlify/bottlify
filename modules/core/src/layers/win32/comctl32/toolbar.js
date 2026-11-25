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
 * A button is as large as its image and the padding around it (TB_SETPADDING,
 * 7 by 6 at first), a text row under it once a button has text, and as wide
 * as its widest text; TB_SETBUTTONSIZE makes it larger, never smaller than
 * the image and padding. The size is worked out again when the images'
 * size, the strings or the buttons change, as Wine's toolbar test
 * (test_sizes, test_add_bitmap) records Windows doing it.
 *
 * TB_ADDBITMAP counts images two ways, as Windows does: its answer is the
 * sum of the counts the program declared for the bitmaps before (the
 * standard strips' own counts for theirs), while the list holds what each
 * bitmap actually gives at the image size - all of its images, more blank
 * ones up to the declared count, or for a count of zero only the first. A
 * bitmap added twice answers where it was added first. The toolbar's own list
 * is made again at the new size when TB_SETBITMAPSIZE or a standard strip
 * changes it; a list the program handed over keeps its size.
 *
 * What is not here: tooltips, the hot look of a flat button under the mouse,
 * drop-down buttons, customization, TB_AUTOSIZE, wrapping by width, and
 * comctl32's standard bitmaps, whose images are left blank.
 */

import {
    WM_PAINT, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_CAPTURECHANGED, WM_COMMAND,
    COLOR_3DFACE, COLOR_3DHILIGHT, COLOR_3DSHADOW, COLOR_BTNTEXT, COLOR_GRAYTEXT,
    pointOf, after,
} from '../user32/controls.js';
import { encodeAnsi } from '../kernel32/locale.js';
import { notifyWindow } from './notify.js';
import { readText, writeText, LPSTR_TEXTCALLBACK } from './strings.js';
import { CCM_GETVERSION, CCM_SETVERSION, answerVersion } from './version.js';
import { stripOfBitmapId } from './strips.js';
import { wholeAddress } from '../common/pointers.js';
import { utf16z } from '../common/utf16.js';

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
export const TBSTYLE_WRAPABLE = 0x0200;

/** Messages, numbered off WM_USER as the header numbers them. */
const WM_USER = 0x0400;
const WM_SETFONT = 0x0030;
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
export const TB_LOADIMAGES = WM_USER + 50;
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
export const TB_GETPADDING = WM_USER + 86;
export const TB_SETPADDING = WM_USER + 87;
export const TB_SETUNICODEFORMAT = 0x2005;
export const TB_GETUNICODEFORMAT = 0x2006;
export const TB_GETBUTTONINFOW = WM_USER + 63;
export const TB_SETBUTTONINFOW = WM_USER + 64;
export const TB_GETBUTTONINFOA = WM_USER + 65;
export const TB_SETBUTTONINFOA = WM_USER + 66;

/**
 * TBBUTTONINFO, the same shape in both spellings: its size, the mask of what
 * it carries, the command, image, state and style, the width, lParam, text.
 */
const BUTTONINFO = Object.freeze({ cbSize: 0, dwMask: 4, idCommand: 8, iImage: 12,
    fsState: 16, fsStyle: 17, cx: 18, lParam: 20, pszText: 24, cchText: 28, SIZE: 32 });
const TBIF_IMAGE = 0x0001;
const TBIF_TEXT = 0x0002;
const TBIF_STATE = 0x0004;
const TBIF_STYLE = 0x0008;
const TBIF_LPARAM = 0x0010;
const TBIF_COMMAND = 0x0020;
const TBIF_SIZE = 0x0040;
const TBIF_BYINDEX = 0x80000000;

/** What the toolbar tells its owner, off TBN_FIRST (-700). */
export const TBN_HOTITEMCHANGE = -713 >>> 0;
const WM_CREATE = 0x0001;
const WM_STYLECHANGED = 0x007d;
const GWL_STYLE = -16;
const WM_NOTIFY = 0x004e;
const WM_NOTIFYFORMAT = 0x0055;
const NF_QUERY = 3;
const NFR_UNICODE = 2;
/** NMTBHOTITEM's dwFlags for a hot item set by a program. */
const HICF_OTHER = 0x00;
const HICF_LEAVING = 0x20;
/** CBEN_ENDEDIT's two spellings, which a toolbar hands its owner in the owner's. */
const CBEN_ENDEDITA = -805 >>> 0;
const CBEN_ENDEDITW = -806 >>> 0;
const CBEMAXSTRLEN = 260;
/** A tooltip's request for its text, and the toolbar's to its owner for a button's tip. */
const TTN_GETDISPINFOA = -520 >>> 0;
const TTN_GETDISPINFOW = -530 >>> 0;
export const TBN_GETINFOTIPA = -718 >>> 0;
export const TBN_GETINFOTIPW = -719 >>> 0;
const INFOTIPSIZE = 1024;
/** NMTTDISPINFO's szText, in characters. */
const TIP_TEXT = 80;

/** TBBUTTON: iBitmap, idCommand, fsState, fsStyle, two bytes, dwData, iString. */
const TBBUTTON_SIZE = 20;
/** TBADDBITMAP's hInst for comctl32's own strips, and how many images each holds. */
const HINST_COMMCTRL = 0xffffffff;
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
 * A bitmap TB_ADDBITMAP was given: where, the count declared for it (a
 * standard strip's own), and the declared counts before it.
 *
 * @typedef {Object} Source
 * @property {number} instance @property {number} id @property {number} bitmap
 * @property {number} declared @property {number} index
 * @property {{ count: number, side: number } | null} strip
 */

/**
 * @typedef {Object} Button
 * @property {number} image @property {number} command
 * @property {number} state @property {number} style
 * @property {number} data
 * @property {number | string} string  An index into the toolbar's strings, or the text.
 * @property {number} [width]  TBBUTTONINFO's cx: a width of its own, not the toolbar's.
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
     *     declared: number, sources: Source[], pressed: number, said: Set<number>,
     *     padding: { cx: number, cy: number }, hot: number, top: number, unicode: boolean,
     *     version?: number }}
     */
    const state = record=>{
        const held = tk.stateOf(record);
        held.buttons ??= [];
        held.structSize ??= TBBUTTON_SIZE;
        held.bitmap ??= { cx: 16, cy: 16 };
        held.padding ??= { cx: 7, cy: 6 };
        held.button ??= { cx: 23, cy: 22 };
        held.hot ??= -1;
        held.top ??= TOP_MARGIN;
        held.unicode ??= false;
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
        held.declared ??= 0;
        held.sources ??= [];
        held.pressed ??= -1;
        held.said ??= new Set();
        return held;
    };

    /** @param {string} name @param {...number} args */
    const imageCall = (name, ...args)=>images?.functions[name]?.handler(args) ?? -1;

    /** @param {number} at */
    const read32 = at=>{
        const b = host.readMemory(wholeAddress(at), 4);
        return (b[0] | b[1] << 8 | b[2] << 16 | b[3] << 24) >>> 0;
    };
    /** @param {number} at @param {number} value */
    const write32 = (at, value)=>{
        const v = value >>> 0;
        host.writeMemory(wholeAddress(at),
            Uint8Array.of(v & 0xff, v >>> 8 & 0xff, v >>> 16 & 0xff, v >>> 24));
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
            string: string !== -1 && (string >>> 0) > 0xffff
                ? readText(host, string >>> 0, wide) : string,
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
        let y = held.top;
        return held.buttons.map(button=>{
            if ((button.state & TBSTATE_HIDDEN) !== 0)
            {
                return null;
            }
            const separator = (button.style & TBSTYLE_SEP) !== 0;
            const width = button.width ? button.width
                : separator ? (button.image > 0 ? button.image : SEPARATOR_WIDTH)
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
            // A group runs over a separator that is in it (TBSTYLE_SEP |
            // TBSTYLE_GROUP) and ends at one that is not (Wine's basic_test).
            const grouped = at=>held.buttons[at] && (held.buttons[at].style & TBSTYLE_GROUP) !== 0;
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
     * The images a bitmap gives at a list's image width: all it holds, blank
     * ones more up to the count declared for it, only the first for a count
     * of zero; a standard strip its own count, at its own image size.
     *
     * @param {Source} source @param {number} actual  the images the bitmap holds
     */
    const imagesOf = (source, actual)=>(source.declared === 0 ? 1
        : source.declared < 0 ? actual : Math.max(source.declared, actual));

    /**
     * Puts a bitmap's images at the end of the list, making the toolbar's
     * own at the image size when there is none.
     *
     * @param {any} record @param {Source} source
     */
    const fill = (record, source)=>{
        const held = state(record);
        if (!images)
        {
            return;
        }
        if (held.list === 0)
        {
            held.list = imageCall('ImageList_Create', held.bitmap.cx, held.bitmap.cy,
                ILC_MASK_COLOR32, 4, 4);
            held.ownList = true;
        }
        const before = imageCall('ImageList_GetImageCount', held.list);
        if (source.strip)
        {
            // The strip's pixels are not here: its images, at the list's
            // width, go in blank.
            const width = images.size(held.list)?.cx || source.strip.side;
            imageCall('ImageList_SetImageCount', held.list,
                before + Math.floor(source.strip.count * source.strip.side / width));
            return;
        }
        imageCall('ImageList_AddMasked', held.list, source.bitmap, tk.color(COLOR_3DFACE));
        const actual = imageCall('ImageList_GetImageCount', held.list) - before;
        const wanted = imagesOf(source, actual);
        if (wanted > actual)
        {
            imageCall('ImageList_SetImageCount', held.list, before + wanted);
        }
        for (let at = before + actual - 1; at >= before + wanted; at--)
        {
            imageCall('ImageList_Remove', held.list, at);
        }
    };

    /**
     * The toolbar's own list made again at the image size from every bitmap
     * in order; a list the program handed over is left as it is.
     *
     * @param {any} record
     */
    const refill = record=>{
        const held = state(record);
        if (!held.ownList || held.list === 0)
        {
            return;
        }
        imageCall('ImageList_Destroy', held.list);
        held.list = 0;
        held.ownList = false;
        for (const source of held.sources)
        {
            fill(record, source);
        }
    };

    /**
     * TB_ADDBITMAP's TBADDBITMAP: a bitmap handle (hInst NULL), a bitmap
     * resource of a module, or one of comctl32's standard strips.
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
        return addFrom(record, count, view.getUint32(0, true), view.getUint32(4, true));
    };

    /**
     * Adds a bitmap's images, named as a TBADDBITMAP names it: the declared
     * counts before it, or -1. A standard strip sets the image size to its own.
     *
     * @param {any} record @param {number} count @param {number} instance @param {number} id
     */
    const addFrom = (record, count, instance, id)=>{
        const held = state(record);
        const known = held.sources.find(source=>source.instance === instance
            && source.id === id);
        if (known)
        {
            return known.index;
        }
        /** @type {Source} */
        let source;
        if (instance === HINST_COMMCTRL)
        {
            const strip = stripOfBitmapId(id);
            if (!strip)
            {
                return -1;
            }
            host.divergence?.('TB_ADDBITMAP', `comctl32's standard bitmap ${id} is left blank`);
            source = { instance, id, bitmap: 0, declared: strip.count, strip,
                index: held.declared };
            if (held.bitmap.cx !== strip.side || held.bitmap.cy !== strip.side)
            {
                held.bitmap = { cx: strip.side, cy: strip.side };
                refill(record);
                recalc(record);
            }
        }
        else
        {
            const bitmap = instance === 0 ? id : resources.loadBitmap?.(instance, id) ?? 0;
            if (bitmap === 0)
            {
                return -1;
            }
            source = { instance, id, bitmap, declared: count | 0, strip: null,
                index: held.declared };
        }
        held.declared += source.declared;
        held.sources.push(source);
        fill(record, source);
        host.invalidate(record);
        return source.index;
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
        Object.assign(source, { instance, id, bitmap, strip: null,
            declared: view.getInt32(16, true) });
        if (!held.ownList)
        {
            host.divergence?.('TB_REPLACEBITMAP', 'a list the program gave is not refilled');
            return 0;
        }
        refill(record);
        host.invalidate(record);
        return 1;
    };

    /**
     * The text sizes the buttons need: the widest text and whether a row of
     * it is under the images. A toolbar with no buttons yet takes the row
     * from its strings, not their width (test_sizes).
     *
     * @param {any} record
     */
    const textNeeds = record=>{
        const held = state(record);
        const texts = held.buttons.filter(button=>(button.state & TBSTATE_HIDDEN) === 0)
            .map(button=>textOf(record, button)).filter(text=>text !== '');
        const row = texts.length > 0 || (held.buttons.length === 0 && held.strings.length > 0);
        if (!row)
        {
            return { width: 0, height: 0 };
        }
        if (!host.draw)
        {
            return { width: Math.max(0, ...texts.map(text=>text.length * 8)), height: 17 };
        }
        const { hdc } = host.contextOn(record);
        try
        {
            const draw = host.draw;
            return { width: Math.max(0, ...texts.map(text=>draw.measure(hdc, text).width)),
                height: draw.measure(hdc, 'M').height + 1 };
        }
        finally
        {
            host.endPaint(record, hdc);
        }
    };

    /** @param {any} record  The smallest button: the image and its padding. */
    const leastButton = record=>{
        const held = state(record);
        return { cx: held.bitmap.cx + held.padding.cx, cy: held.bitmap.cy + held.padding.cy };
    };

    /**
     * The button size worked out again: the image and padding, the widest
     * text and padding, a text row.
     *
     * @param {any} record @returns {{ cx: number, cy: number }}
     */
    const neededButton = record=>{
        const held = state(record);
        const least = leastButton(record);
        const text = textNeeds(record);
        return { cx: Math.max(least.cx, text.width > 0 ? text.width + held.padding.cx : 0),
            cy: least.cy + text.height };
    };

    /**
     * The buttons sized again, and the first row's distance from the top
     * with them: none on a flat toolbar (test_recalc reads a recalculation
     * by it).
     *
     * @param {any} record
     */
    const recalc = record=>{
        const held = state(record);
        held.button = neededButton(record);
        held.top = (record.style & TBSTYLE_FLAT) !== 0 ? 0 : TOP_MARGIN;
        host.invalidate(record);
    };

    /**
     * A style changed: turning TBSTYLE_WRAPABLE on or off sizes the buttons
     * again, and a wrappable toolbar's rows are its width's, not the
     * buttons' TBSTATE_WRAP (test_sizes, test_recalc).
     *
     * @param {any} record @param {number} before
     */
    const restyled = (record, before)=>{
        const held = state(record);
        if (((before ^ record.style) & TBSTYLE_WRAPABLE) === 0)
        {
            host.invalidate(record);
            return;
        }
        if ((record.style & TBSTYLE_WRAPABLE) !== 0)
        {
            for (const button of held.buttons)
            {
                button.state &= ~TBSTATE_WRAP;
            }
        }
        recalc(record);
    };

    /**
     * Sets the hot item: an index past the buttons is ignored, a negative one
     * clears it. The owner hears TBN_HOTITEMCHANGE and may refuse it; a
     * disabled button is announced but not made hot.
     *
     * @param {any} record @param {number} index @param {unknown} thread
     * @returns {number | Promise<number>} the hot item before
     */
    const setHot = (record, index, thread)=>{
        const held = state(record);
        const previous = held.hot;
        if (index >= held.buttons.length || index === previous
            || ((record.controlsVersion ?? 5) < 6 && (record.style & TBSTYLE_FLAT) === 0))
        {
            return previous;
        }
        const target = index < 0 ? null : held.buttons[index];
        const idOld = previous >= 0 ? held.buttons[previous]?.command ?? 0 : 0;
        const idNew = target ? target.command : 0;
        if (!target && previous < 0)
        {
            return previous;
        }
        return after(notifyOwner(record, TBN_HOTITEMCHANGE, 12, block=>{
            write32(block + 12, idOld);
            write32(block + 16, idNew);
            write32(block + 20, target ? HICF_OTHER : HICF_LEAVING);
        }, thread), refused=>{
            if ((refused | 0) === 0)
            {
                held.hot = target && (target.state & TBSTATE_ENABLED) !== 0 ? index : -1;
                host.invalidate(record);
            }
            return previous;
        });
    };

    /**
     * Sends the owner a WM_NOTIFY, the structure in guest memory while it is
     * answered: an NMHDR and `extra` bytes after it.
     *
     * @param {any} record @param {number} code @param {number} extra
     * @param {(block: number) => void} write @param {unknown} thread
     */
    const notifyOwner = (record, code, extra, write, thread)=>{
        const to = ownerOf(record);
        const block = to !== 0 ? host.allocate?.(12 + extra) ?? 0 : 0;
        if (block === 0)
        {
            return 0;
        }
        host.writeMemory(block, new Uint8Array(12 + extra));
        write32(block, record.hwnd);
        write32(block + 4, record.id);
        write32(block + 8, code);
        write(block);
        return after(host.send(to, WM_NOTIFY, record.id, block, thread), answer=>{
            host.release?.(block);
            return answer;
        });
    };

    /**
     * A WM_NOTIFY the toolbar is sent - a combo box's in it, say - goes on to
     * its owner as the sender's (wParam its idFrom); CBEN_ENDEDITW to an owner
     * that takes ANSI goes as CBEN_ENDEDITA (Wine's toolbar test,
     * test_WM_NOTIFY), and a tooltip asking for a button's text is answered
     * first from TBN_GETINFOTIP.
     *
     * @param {any} record @param {number} lParam @param {unknown} thread
     */
    const forwardNotify = (record, lParam, thread)=>{
        const held = state(record);
        const to = ownerOf(record);
        if (to === 0 || lParam === 0)
        {
            return 0;
        }
        const code = read32(lParam + 8);
        const from = read32(lParam + 4);
        if (code === TTN_GETDISPINFOA || code === TTN_GETDISPINFOW)
        {
            return after(infoTip(record, lParam, code === TTN_GETDISPINFOW, thread),
                ()=>tipText(record, lParam, code === TTN_GETDISPINFOW, thread));
        }
        if (code !== CBEN_ENDEDITW || held.unicode)
        {
            return host.send(to, WM_NOTIFY, from, lParam, thread);
        }
        const size = 12 + 8 + CBEMAXSTRLEN + 4;
        return withCopy(size, copy=>{
            host.writeMemory(copy, host.readMemory(lParam, 20));
            write32(copy + 8, CBEN_ENDEDITA);
            writeText(host, copy + 20, readText(host, lParam + 20, true), false, CBEMAXSTRLEN);
            write32(copy + 20 + CBEMAXSTRLEN, read32(lParam + 20 + CBEMAXSTRLEN * 2));
            return host.send(to, WM_NOTIFY, from, copy, thread);
        }, 'CBEN_ENDEDITW');
    };

    /**
     * A zeroed block of guest memory for as long as `use` needs it.
     *
     * @param {number} size @param {(at: number) => any} use @param {string} what
     */
    const withCopy = (size, use, what)=>{
        const at = host.allocate?.(size) ?? 0;
        if (at === 0)
        {
            host.divergence?.('WM_NOTIFY', `no memory to convert ${what}: not forwarded`);
            return 0;
        }
        host.writeMemory(at, new Uint8Array(size));
        return after(use(at), answer=>{
            host.release?.(at);
            return answer;
        });
    };

    /**
     * TBN_GETINFOTIP: the owner asked for a button's tip in its own encoding;
     * text it gives goes into the tooltip's NMTTDISPINFO.
     *
     * @param {any} record @param {number} info  the tooltip's NMTTDISPINFO
     * @param {boolean} wide  the tooltip's encoding @param {unknown} thread
     */
    const infoTip = (record, info, wide, thread)=>{
        const held = state(record);
        const command = read32(info + 4) | 0;
        const button = held.buttons[indexOf(record, command)];
        const own = held.unicode;
        return withCopy(28 + INFOTIPSIZE * (own ? 2 : 1), block=>{
            write32(block, record.hwnd);
            write32(block + 4, record.id);
            write32(block + 8, own ? TBN_GETINFOTIPW : TBN_GETINFOTIPA);
            write32(block + 12, block + 28);
            write32(block + 16, INFOTIPSIZE);
            write32(block + 20, command);
            write32(block + 24, button?.data ?? 0);
            return after(host.send(ownerOf(record), WM_NOTIFY, record.id, block, thread), ()=>{
                const pointer = read32(block + 12);
                const text = pointer !== 0 ? readText(host, pointer, own) : '';
                if (text !== '')
                {
                    writeText(host, info + 16, text, wide, TIP_TEXT);
                    write32(info + 12, info + 16);
                }
                return 0;
            });
        }, 'TBN_GETINFOTIP');
    };

    /**
     * TTN_GETDISPINFO handed on to the owner in its encoding, and its answer
     * back in the tooltip's.
     *
     * @param {any} record @param {number} info @param {boolean} wide @param {unknown} thread
     */
    const tipText = (record, info, wide, thread)=>{
        const held = state(record);
        const to = ownerOf(record);
        const from = read32(info + 4);
        if (wide === held.unicode)
        {
            return host.send(to, WM_NOTIFY, from, info, thread);
        }
        const own = held.unicode;
        /** NMTTDISPINFO's hinst, uFlags and lParam, after a szText of either width. */
        const tail = (/** @type {boolean} */ w)=>16 + TIP_TEXT * (w ? 2 : 1);
        return withCopy(tail(own) + 12, copy=>{
            host.writeMemory(copy, host.readMemory(info, 12));
            write32(copy + 8, own ? TTN_GETDISPINFOW : TTN_GETDISPINFOA);
            writeText(host, copy + 16, readText(host, info + 16, wide, TIP_TEXT), own, TIP_TEXT);
            const text = read32(info + 12);
            write32(copy + 12, text === info + 16 ? copy + 16 : text);
            host.writeMemory(copy + tail(own), host.readMemory(info + tail(wide), 12));
            return after(host.send(to, WM_NOTIFY, from, copy, thread), answer=>{
                const given = read32(copy + 12);
                // Text the owner gave, at either place, comes back in the
                // tooltip's encoding; a resource id or the callback stays.
                if (given === copy + 16 || given > 0xffff && given !== LPSTR_TEXTCALLBACK)
                {
                    writeText(host, info + 16, readText(host, given, own, TIP_TEXT), wide,
                        TIP_TEXT);
                    write32(info + 12, info + 16);
                }
                else
                {
                    write32(info + 12, given);
                }
                host.writeMemory(info + tail(wide), host.readMemory(copy + tail(own), 12));
                return answer;
            });
        }, 'TTN_GETDISPINFO');
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
            return button ? button.state & STATE_GETTERS[id] : -1;
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
            // The toolbar keeps the font for its text and answers that it
            // took it (Wine's toolbar and rebar tests, rebuild_toolbar).
            case WM_SETFONT:
                record.font = wParam;
                if ((lParam & 0xffff) !== 0)
                {
                    host.invalidate(record);
                }
                return 1;
            case TB_BUTTONSTRUCTSIZE:
                held.structSize = wParam;
                return 0;
            case CCM_SETVERSION:
            case CCM_GETVERSION:
                return answerVersion(record, held, id, wParam);
            case TB_SETBITMAPSIZE: {
                // -1 keeps a side, 0 is 1; the toolbar's own list is made
                // again at the size, and the buttons are sized to it.
                /** @param {number} asked @param {number} was */
                const side = (asked, was)=>(asked === 0xffff ? was : Math.max(1, asked));
                held.bitmap = { cx: side(lParam & 0xffff, held.bitmap.cx),
                    cy: side(lParam >>> 16, held.bitmap.cy) };
                refill(record);
                recalc(record);
                return 1;
            }
            case TB_SETBUTTONSIZE: {
                // Larger than the image and its padding, never smaller.
                const least = leastButton(record);
                held.button = { cx: Math.max(lParam & 0xffff, least.cx),
                    cy: Math.max(lParam >>> 16, least.cy) };
                host.invalidate(record);
                return 1;
            }
            case TB_SETPADDING: {
                const previous = (held.padding.cy << 16 | held.padding.cx) >>> 0;
                held.padding = { cx: lParam & 0xffff, cy: lParam >>> 16 };
                return previous;
            }
            case TB_GETPADDING:
                return (held.padding.cy << 16 | held.padding.cx) >>> 0;
            case TB_GETBUTTONSIZE:
                return (held.button.cy << 16 | held.button.cx) >>> 0;
            case TB_ADDBITMAP:
                return addBitmap(record, wParam | 0, lParam);
            // A standard strip by its IDB_ number, from HINST_COMMCTRL.
            case TB_LOADIMAGES:
                return addFrom(record, 0, lParam, wParam);
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
                if (held.hot >= at)
                {
                    held.hot += count;
                }
                // Buttons with text, or any once there are strings, size the
                // buttons again (test_sizes).
                if (held.strings.length > 0 || added.some(button=>textOf(record, button) !== ''))
                {
                    recalc(record);
                }
                host.invalidate(record);
                return 1;
            }
            case TB_DELETEBUTTON: {
                const index = wParam | 0;
                if (index < 0 || index >= held.buttons.length)
                {
                    return 0;
                }
                held.buttons.splice(index, 1);
                // The hot button gone, none is hot; the size is kept.
                held.hot = held.hot === index ? -1 : held.hot > index ? held.hot - 1 : held.hot;
                host.invalidate(record);
                return 1;
            }
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
                const shown = (button.state & TBSTATE_HIDDEN) !== 0
                    && (lParam & TBSTATE_HIDDEN) === 0;
                button.state = lParam & 0xff;
                if (shown)
                {
                    recalc(record);
                }
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
                const height = Math.max(0, ...rects.map(rect=>rect.bottom)) - held.top;
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
                    const text = readText(host, at, wide);
                    if (text === '')
                    {
                        break;
                    }
                    held.strings.push(text);
                    at += (text.length + 1) * (wide ? 2 : 1);
                }
                recalc(record);
                return first;
            }
            case TB_GETBUTTONINFOA:
            case TB_GETBUTTONINFOW: {
                // A structure of any other size is refused, as is a button
                // the command (or, under TBIF_BYINDEX, the index) names none of.
                if (lParam === 0 || read32(lParam + BUTTONINFO.cbSize) !== BUTTONINFO.SIZE)
                {
                    return -1;
                }
                const mask = read32(lParam + BUTTONINFO.dwMask);
                const index = mask & TBIF_BYINDEX ? wParam | 0 : indexOf(record, wParam);
                const button = held.buttons[index];
                if (!button)
                {
                    return -1;
                }
                if (mask & TBIF_COMMAND)
                {
                    write32(lParam + BUTTONINFO.idCommand, button.command);
                }
                if (mask & TBIF_IMAGE)
                {
                    write32(lParam + BUTTONINFO.iImage, button.image);
                }
                if (mask & TBIF_STATE || mask & TBIF_STYLE)
                {
                    host.writeMemory(lParam + BUTTONINFO.fsState, Uint8Array.of(
                        mask & TBIF_STATE ? button.state
                            : host.readMemory(lParam + BUTTONINFO.fsState, 1)[0],
                        mask & TBIF_STYLE ? button.style
                            : host.readMemory(lParam + BUTTONINFO.fsStyle, 1)[0]));
                }
                if (mask & TBIF_SIZE)
                {
                    const rect = layout(record)[index];
                    const width = rect ? rect.right - rect.left : button.width ?? 0;
                    host.writeMemory(lParam + BUTTONINFO.cx, Uint8Array.of(width & 0xff,
                        width >>> 8 & 0xff));
                }
                if (mask & TBIF_LPARAM)
                {
                    write32(lParam + BUTTONINFO.lParam, button.data);
                }
                if (mask & TBIF_TEXT)
                {
                    writeText(host, read32(lParam + BUTTONINFO.pszText), textOf(record, button),
                        id === TB_GETBUTTONINFOW, read32(lParam + BUTTONINFO.cchText) | 0);
                }
                return index;
            }
            case TB_SETBUTTONINFOA:
            case TB_SETBUTTONINFOW: {
                if (lParam === 0 || read32(lParam + BUTTONINFO.cbSize) !== BUTTONINFO.SIZE)
                {
                    return 0;
                }
                const mask = read32(lParam + BUTTONINFO.dwMask);
                const index = mask & TBIF_BYINDEX ? wParam | 0 : indexOf(record, wParam);
                const button = held.buttons[index];
                if (!button)
                {
                    return 0;
                }
                if (mask & TBIF_COMMAND)
                {
                    button.command = read32(lParam + BUTTONINFO.idCommand) | 0;
                }
                if (mask & TBIF_IMAGE)
                {
                    button.image = read32(lParam + BUTTONINFO.iImage) | 0;
                }
                if (mask & TBIF_STATE)
                {
                    button.state = host.readMemory(lParam + BUTTONINFO.fsState, 1)[0];
                }
                if (mask & TBIF_STYLE)
                {
                    button.style = host.readMemory(lParam + BUTTONINFO.fsStyle, 1)[0];
                }
                if (mask & TBIF_SIZE)
                {
                    const [low, high] = host.readMemory(lParam + BUTTONINFO.cx, 2);
                    button.width = low | high << 8;
                }
                if (mask & TBIF_LPARAM)
                {
                    button.data = read32(lParam + BUTTONINFO.lParam);
                }
                if (mask & TBIF_TEXT)
                {
                    const pointer = read32(lParam + BUTTONINFO.pszText);
                    button.string = pointer === 0 ? '' : readText(host, pointer,
                        id === TB_SETBUTTONINFOW);
                }
                host.invalidate(record);
                return 1;
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
                        ? utf16z(text)
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
            case TB_SETSTYLE: {
                const before = record.style;
                record.style = lParam;
                restyled(record, before);
                return 0;
            }
            case WM_STYLECHANGED:
                if ((message.wParam | 0) === GWL_STYLE && lParam !== 0)
                {
                    restyled(record, read32(lParam));
                }
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
                // The images' size, 1 by 1 for none: the buttons as tall as
                // it needs, as wide only if they must grow (test_sizes).
                const size = lParam !== 0 ? images?.size(lParam) : null;
                const bitmap = { cx: Math.max(1, size?.cx ?? 0), cy: Math.max(1, size?.cy ?? 0) };
                if (bitmap.cx !== held.bitmap.cx || bitmap.cy !== held.bitmap.cy)
                {
                    held.bitmap = bitmap;
                    const needed = neededButton(record);
                    held.button = { cx: Math.max(held.button.cx, needed.cx), cy: needed.cy };
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
                return held.hot;
            case TB_SETHOTITEM:
                return setHot(record, message.wParam | 0, thread);
            case TB_SETUNICODEFORMAT: {
                const previous = held.unicode ? 1 : 0;
                held.unicode = wParam !== 0;
                return previous;
            }
            case TB_GETUNICODEFORMAT:
                return held.unicode ? 1 : 0;
            case WM_CREATE: {
                // It asks its owner which notifications it takes.
                const to = ownerOf(record);
                return after(to !== 0 ? host.send(to, WM_NOTIFYFORMAT, record.hwnd, NF_QUERY,
                    thread) : 0, format=>{
                    held.unicode = format === NFR_UNICODE;
                    return tk.common(record, message, thread);
                });
            }
            case WM_NOTIFY:
                return forwardNotify(record, lParam, thread);
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
