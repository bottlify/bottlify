/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The header control, `SysHeader32`.
 *
 * A row of column titles, each an item with a width, a text, a format and a
 * program's own data, laid out left to right in their display order - which
 * is not their index: an item keeps its index while HDM_SETORDERARRAY or a
 * drag moves where it shows. The control tells its parent before and after
 * an item changes (HDN_ITEMCHANGING, which the parent may refuse, and
 * HDN_ITEMCHANGED), and asks it for a text kept as LPSTR_TEXTCALLBACK
 * (HDN_GETDISPINFO). Which spelling those notifications use is the parent's
 * answer to WM_NOTIFYFORMAT, asked when the control is made.
 *
 * A list view in report view owns one and lays its columns out by it.
 */

import { WM_CREATE, WM_PAINT, WM_ERASEBKGND, COLOR_3DFACE, COLOR_BTNTEXT, after }
    from '../user32/controls.js';
import { notifyWindow } from './notify.js';
import { LPSTR_TEXTCALLBACK, MAX_TEXT, readText, writeText } from './strings.js';
import { CCM_GETVERSION, CCM_SETVERSION, answerVersion } from './version.js';
import {
    EVENT_OBJECT_CREATE, EVENT_OBJECT_DESTROY, EVENT_OBJECT_REORDER, CHILDID_SELF, raiseEvent,
} from './winevents.js';
import { wholeAddress } from '../common/pointers.js';

/** The class name a program creates the control by. */
export const HEADER_CLASS = 'SysHeader32';

/** The atom spacing a build without a bridge gives the class's procedure. */
export const HEADER_ATOM = 0x8019;

const WM_NOTIFY = 0x004e;
const WM_NOTIFYFORMAT = 0x0055;
const WM_SIZE = 0x0005;
const NF_QUERY = 3;
const NFR_UNICODE = 2;

const HDM_FIRST = 0x1200;
export const HDM = Object.freeze({
    GETITEMCOUNT: HDM_FIRST, INSERTITEMA: HDM_FIRST + 1, DELETEITEM: HDM_FIRST + 2,
    GETITEMA: HDM_FIRST + 3, SETITEMA: HDM_FIRST + 4, LAYOUT: HDM_FIRST + 5,
    HITTEST: HDM_FIRST + 6, GETITEMRECT: HDM_FIRST + 7, SETIMAGELIST: HDM_FIRST + 8,
    GETIMAGELIST: HDM_FIRST + 9, INSERTITEMW: HDM_FIRST + 10, GETITEMW: HDM_FIRST + 11,
    SETITEMW: HDM_FIRST + 12, ORDERTOINDEX: HDM_FIRST + 15, CREATEDRAGIMAGE: HDM_FIRST + 16,
    GETORDERARRAY: HDM_FIRST + 17, SETORDERARRAY: HDM_FIRST + 18,
    SETHOTDIVIDER: HDM_FIRST + 19, SETBITMAPMARGIN: HDM_FIRST + 20,
    GETBITMAPMARGIN: HDM_FIRST + 21, SETFILTERCHANGETIMEOUT: HDM_FIRST + 22,
    EDITFILTER: HDM_FIRST + 23, CLEARFILTER: HDM_FIRST + 24,
    GETITEMDROPDOWNRECT: HDM_FIRST + 25, GETOVERFLOWRECT: HDM_FIRST + 26,
    GETFOCUSEDITEM: HDM_FIRST + 27, SETFOCUSEDITEM: HDM_FIRST + 28,
});
const CCM_SETUNICODEFORMAT = 0x2005;
const CCM_GETUNICODEFORMAT = 0x2006;

/** HDITEM, the same shape in both spellings: only the text differs. */
export const HDITEM = Object.freeze({ mask: 0, cxy: 4, pszText: 8, hbm: 12, cchTextMax: 16,
    fmt: 20, lParam: 24, iImage: 28, iOrder: 32, type: 36, pvFilter: 40, state: 44, SIZE: 48 });
export const HDI_WIDTH = 0x0001;
export const HDI_TEXT = 0x0002;
export const HDI_FORMAT = 0x0004;
export const HDI_LPARAM = 0x0008;
const HDI_BITMAP = 0x0010;
const HDI_IMAGE = 0x0020;
const HDI_DI_SETITEM = 0x0040;
export const HDI_ORDER = 0x0080;
const HDI_FILTER = 0x0100;
const HDI_STATE = 0x0200;
const HDF_RIGHT = 0x0001;
const HDF_CENTER = 0x0002;
const HDF_IMAGE = 0x0800;
const HDF_BITMAP = 0x2000;
export const HDF_STRING = 0x4000;
const HDF_OWNERDRAW = 0x8000;
const HDS_HIDDEN = 0x0008;

/** NM_CUSTOMDRAW: NMCUSTOMDRAW after its NMHDR, and the stages and answers. */
const NM_CUSTOMDRAW = -12;
const CUSTOMDRAW = Object.freeze({ dwDrawStage: 12, hdc: 16, rc: 20, dwItemSpec: 36,
    SIZE: 48 });
const CDDS_PREPAINT = 0x00001;
const CDDS_POSTPAINT = 0x00002;
const CDDS_ITEMPREPAINT = 0x10001;
const CDDS_ITEMPOSTPAINT = 0x10002;
const CDRF_SKIPDEFAULT = 0x04;
const CDRF_NOTIFYPOSTPAINT = 0x10;
const CDRF_NOTIFYITEMDRAW = 0x20;
/** An owner-drawn item: WM_DRAWITEM with a DRAWITEMSTRUCT of ODT_HEADER. */
const WM_DRAWITEM = 0x002b;
const DRAWITEM_SIZE = 48;
const ODT_HEADER = 100;
const ODA_DRAWENTIRE = 0x0001;

/** HDHITTESTINFO: the point, the flags the test answers in, and the item. */
const HITTEST = Object.freeze({ x: 0, y: 4, flags: 8, iItem: 12 });
const HHT_NOWHERE = 0x0001;
const HHT_ONHEADER = 0x0002;
const HHT_ONDIVIDER = 0x0004;
const HHT_ABOVE = 0x0100;
const HHT_BELOW = 0x0200;
const HHT_TORIGHT = 0x0400;
const HHT_TOLEFT = 0x0800;
/** How far either side of a divider a point is on it. */
const DIVIDER_SLOP = 5;

/** NMHEADER after its NMHDR: the item, the mouse button, the item structure. */
const NMHEADER_SIZE = 24;
/** NMHDDISPINFO after its NMHDR: the item, the mask, the text, its room, image, lParam. */
const DISPINFO = Object.freeze({ iItem: 12, mask: 16, pszText: 20, cchTextMax: 24, iImage: 28,
    lParam: 32, SIZE: 36 });
const HDN_ITEMCHANGINGA = -300;
const HDN_ITEMCHANGEDA = -301;
const HDN_GETDISPINFOA = -309;
const HDN_ITEMCHANGINGW = -320;
const HDN_ITEMCHANGEDW = -321;
const HDN_GETDISPINFOW = -329;

/** The room either side of a title, and above and below the font. */
const TEXT_MARGIN = 6;
const VERTICAL_BORDER = 4;
/** The bitmap margin, three edge widths, until HDM_SETBITMAPMARGIN. */
const BITMAP_MARGIN = 6;
const FILTER_TIMEOUT = 1000;
const DT_LEFT = 0x0000;
const DT_CENTER = 0x0001;
const DT_RIGHT = 0x0002;
const DT_VCENTER = 0x0004;
const DT_SINGLELINE = 0x0020;
const DT_END_ELLIPSIS = 0x8000;

/**
 * @typedef {Object} HeaderItem
 * @property {number} width
 * @property {string | null} text  null for LPSTR_TEXTCALLBACK
 * @property {boolean} hasText
 * @property {number} fmt
 * @property {number} lParam
 * @property {number} bitmap
 * @property {number} image
 * @property {number} type
 * @property {number} filter
 * @property {number} state
 */

/**
 * Builds the window procedure of a header control.
 *
 * @param {import('../user32/controls.js').ControlHost} host
 * @param {any} tk  The drawing helpers the system classes share.
 */
export function createHeaderProcedure(host, tk){
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

    /** @param {any} record */
    const state = record=>{
        const held = tk.stateOf(record);
        /** @type {HeaderItem[]} */
        held.items ??= [];
        /** @type {number[]} order -> index */
        held.order ??= [];
        held.unicode ??= true;
        held.images ??= [0, 0, 0];
        held.bitmapMargin ??= BITMAP_MARGIN;
        held.filterTimeout ??= FILTER_TIMEOUT;
        held.focused ??= 0;
        return held;
    };

    /**
     * Sends WM_NOTIFY to whoever the control tells, the structure in guest
     * memory for as long as the message is answered.
     *
     * @param {any} record @param {number} code @param {number} size
     * @param {(block: number) => void} fill @param {unknown} thread
     * @param {(block: number, answer: number) => number} [read]
     */
    const notify = (record, code, size, fill, thread, read)=>{
        const to = notifyWindow(record);
        const block = to !== 0 ? host.allocate?.(size) ?? 0 : 0;
        if (block === 0)
        {
            return 0;
        }
        host.writeMemory(block, new Uint8Array(size));
        write32(block, record.hwnd);
        write32(block + 4, record.id);
        write32(block + 8, code);
        fill(block);
        return after(host.send(to, WM_NOTIFY, record.id, block, thread), answer=>{
            const result = read ? read(block, answer) : answer;
            host.release?.(block);
            return result;
        });
    };

    /**
     * Stores what an HDITEM sets on an item.
     *
     * @param {HeaderItem} item @param {number} info @param {boolean} wide
     */
    const store = (item, info, wide)=>{
        const mask = read32(info + HDITEM.mask);
        if (mask & HDI_WIDTH)
        {
            item.width = read32(info + HDITEM.cxy) | 0;
        }
        if (mask & HDI_FORMAT)
        {
            item.fmt = read32(info + HDITEM.fmt);
        }
        if (mask & HDI_TEXT)
        {
            const pointer = read32(info + HDITEM.pszText);
            item.hasText = true;
            item.text = pointer === LPSTR_TEXTCALLBACK ? null
                : pointer === 0 ? '' : readText(host, pointer, wide);
        }
        if (mask & HDI_LPARAM)
        {
            item.lParam = read32(info + HDITEM.lParam);
        }
        if (mask & HDI_BITMAP)
        {
            item.bitmap = read32(info + HDITEM.hbm);
        }
        if (mask & HDI_IMAGE)
        {
            item.image = read32(info + HDITEM.iImage) | 0;
        }
        if (mask & HDI_FILTER)
        {
            item.type = read32(info + HDITEM.type);
            item.filter = read32(info + HDITEM.pvFilter);
        }
        if (mask & HDI_STATE)
        {
            item.state = read32(info + HDITEM.state);
        }
    };

    /**
     * An item's text, asking the parent for a callback one. What the parent
     * answers is kept when it says HDI_DI_SETITEM.
     *
     * @param {any} record @param {number} index @param {unknown} thread
     * @returns {string | Promise<string>}
     */
    const textOf = (record, index, thread)=>{
        const held = state(record);
        const item = held.items[index];
        if (item.text !== null)
        {
            return item.text;
        }
        const wide = held.unicode;
        const room = MAX_TEXT;
        const buffer = host.allocate?.(room * 2) ?? 0;
        if (buffer === 0)
        {
            return '';
        }
        host.writeMemory(buffer, new Uint8Array(2));
        return after(notify(record, wide ? HDN_GETDISPINFOW : HDN_GETDISPINFOA, DISPINFO.SIZE,
            block=>{
                write32(block + DISPINFO.iItem, index);
                write32(block + DISPINFO.mask, HDI_TEXT);
                write32(block + DISPINFO.pszText, buffer);
                write32(block + DISPINFO.cchTextMax, room);
                write32(block + DISPINFO.lParam, item.lParam);
            }, thread, block=>{
                const mask = read32(block + DISPINFO.mask);
                const pointer = read32(block + DISPINFO.pszText);
                const text = pointer === 0 || pointer === LPSTR_TEXTCALLBACK ? ''
                    : readText(host, pointer, wide);
                if (mask & HDI_DI_SETITEM)
                {
                    item.text = text;
                }
                return /** @type {any} */ (text);
            }), text=>{
            host.release?.(buffer);
            return /** @type {string} */ (/** @type {unknown} */ (text));
        });
    };

    /**
     * Fills an HDITEM's fields its mask asks for. A text is copied into the
     * program's buffer of cchTextMax characters.
     *
     * @param {any} record @param {number} index @param {number} info @param {boolean} wide
     * @param {unknown} thread
     */
    const fill = (record, index, info, wide, thread)=>{
        const held = state(record);
        const item = held.items[index];
        const mask = read32(info + HDITEM.mask);
        if (mask & HDI_WIDTH)
        {
            write32(info + HDITEM.cxy, item.width);
        }
        if (mask & HDI_FORMAT)
        {
            write32(info + HDITEM.fmt, item.fmt);
        }
        if (mask & HDI_LPARAM)
        {
            write32(info + HDITEM.lParam, item.lParam);
        }
        if (mask & HDI_BITMAP)
        {
            write32(info + HDITEM.hbm, item.bitmap);
        }
        if (mask & HDI_IMAGE)
        {
            write32(info + HDITEM.iImage, item.image);
        }
        if (mask & HDI_ORDER)
        {
            write32(info + HDITEM.iOrder, held.order.indexOf(index));
        }
        if (mask & HDI_FILTER)
        {
            write32(info + HDITEM.type, item.type);
            write32(info + HDITEM.pvFilter, item.filter);
        }
        if (mask & HDI_STATE)
        {
            write32(info + HDITEM.state, item.state);
        }
        if (!(mask & HDI_TEXT))
        {
            return 1;
        }
        return after(textOf(record, index, thread), text=>{
            writeText(host, read32(info + HDITEM.pszText), text, wide,
                read32(info + HDITEM.cchTextMax) | 0);
            return 1;
        });
    };

    /** The item rectangles, in display order from the left. @param {any} record */
    const layout = record=>{
        const held = state(record);
        const height = host.clientSize(record).height;
        /** @type {{ left: number, top: number, right: number, bottom: number }[]} */
        const rects = [];
        let x = 0;
        for (const index of held.order)
        {
            const width = Math.max(0, held.items[index].width);
            rects[index] = { left: x, top: 0, right: x + width, bottom: height };
            x += width;
        }
        return rects;
    };

    /** The height a header of its font has. @param {any} record */
    const naturalHeight = record=>{
        if (record.style & HDS_HIDDEN)
        {
            return 0;
        }
        const { hdc } = host.contextOn(record);
        const height = hdc !== 0 && host.draw ? host.draw.measure(hdc, 'M').height : 16;
        host.endPaint(record, hdc);
        return height + VERTICAL_BORDER;
    };

    /**
     * NM_CUSTOMDRAW to the parent at one stage of painting, answered with
     * what more it wants to hear.
     *
     * @param {any} record @param {number} stage @param {number} hdc @param {any} box
     * @param {number} item @param {unknown} thread
     */
    const customDraw = (record, stage, hdc, box, item, thread)=>notify(record,
        NM_CUSTOMDRAW, CUSTOMDRAW.SIZE, block=>{
            write32(block + CUSTOMDRAW.dwDrawStage, stage);
            write32(block + CUSTOMDRAW.hdc, hdc);
            [box.left, box.top, box.right, box.bottom]
                .forEach((value, i)=>write32(block + CUSTOMDRAW.rc + i * 4, value));
            write32(block + CUSTOMDRAW.dwItemSpec, item);
        }, thread);

    /**
     * One item: handed to the parent with WM_DRAWITEM if it is owner-drawn,
     * else an edge and its title.
     *
     * @param {any} record @param {number} hdc @param {number} index @param {any} box
     * @param {unknown} thread
     */
    const paintItem = (record, hdc, index, box, thread)=>{
        const item = state(record).items[index];
        if (item.fmt & HDF_OWNERDRAW)
        {
            const to = notifyWindow(record);
            const block = to !== 0 ? host.allocate?.(DRAWITEM_SIZE) ?? 0 : 0;
            if (block === 0)
            {
                return 0;
            }
            [ODT_HEADER, record.id, index, ODA_DRAWENTIRE, 0, record.hwnd, hdc,
                box.left, box.top, box.right, box.bottom, item.lParam]
                .forEach((value, i)=>write32(block + i * 4, value));
            return after(host.send(to, WM_DRAWITEM, record.id, block, thread), ()=>{
                host.release?.(block);
                return 0;
            });
        }
        tk.buttonEdge(hdc, box, false);
        const text = item.text ?? '';
        if (text !== '')
        {
            const align = item.fmt & HDF_CENTER ? DT_CENTER
                : item.fmt & HDF_RIGHT ? DT_RIGHT : DT_LEFT;
            tk.drawText(hdc, text, { left: box.left + TEXT_MARGIN, top: box.top,
                right: box.right - TEXT_MARGIN, bottom: box.bottom },
            align | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS, tk.color(COLOR_BTNTEXT));
        }
        return 0;
    };

    /**
     * The face, then each item in display order, the parent told of each stage
     * it asked to hear of (NM_CUSTOMDRAW): before the whole, before and after
     * each item, after the whole.
     *
     * @param {any} record @param {number} hdc @param {any} rect @param {unknown} thread
     */
    const paint = (record, hdc, rect, thread)=>{
        const held = state(record);
        const draw = /** @type {any} */ (host.draw);
        draw.fill(hdc, rect, tk.color(COLOR_3DFACE));
        const rects = layout(record);
        return after(customDraw(record, CDDS_PREPAINT, hdc, rect, 0, thread), wants=>{
            const order = [...held.order];
            const step = (/** @type {number} */ at)=>{
                if (at >= order.length)
                {
                    return wants & CDRF_NOTIFYPOSTPAINT
                        ? customDraw(record, CDDS_POSTPAINT, hdc, rect, 0, thread) : 0;
                }
                const index = order[at];
                const box = rects[index];
                const asked = wants & CDRF_NOTIFYITEMDRAW
                    ? customDraw(record, CDDS_ITEMPREPAINT, hdc, box, index, thread)
                    : 0;
                return after(asked, answer=>{
                    const drawn = answer & CDRF_SKIPDEFAULT ? 0
                        : paintItem(record, hdc, index, box, thread);
                    return after(drawn, ()=>after(answer & CDRF_NOTIFYPOSTPAINT
                        ? customDraw(record, CDDS_ITEMPOSTPAINT, hdc, box, index, thread) : 0,
                    ()=>step(at + 1)));
                });
            };
            return step(0);
        });
    };

    /**
     * @param {any} record
     * @param {import('../user32/controls.js').ControlMessage} message
     * @param {unknown} [thread]
     */
    return (record, message, thread)=>{
        const held = state(record);
        const { wParam, lParam } = message;
        switch (message.message)
        {
            case WM_CREATE: {
                const to = notifyWindow(record);
                return after(to !== 0 ? host.send(to, WM_NOTIFYFORMAT, record.hwnd, NF_QUERY,
                    thread) : NFR_UNICODE, answer=>{
                    held.unicode = answer === NFR_UNICODE;
                    return tk.common(record, message, thread);
                });
            }
            case WM_ERASEBKGND:
                return 1;
            case WM_PAINT:
                return tk.painting(record, (/** @type {number} */ hdc, /** @type {any} */ rect)=>
                    paint(record, hdc, rect, thread));
            case WM_SIZE:
                host.invalidate(record);
                return 0;
            case HDM.GETITEMCOUNT:
                return held.items.length;
            case HDM.INSERTITEMA:
            case HDM.INSERTITEMW: {
                if (lParam >>> 0 === 0 || (wParam | 0) < 0 || read32(lParam + HDITEM.mask) === 0)
                {
                    return -1;
                }
                const wide = message.message === HDM.INSERTITEMW;
                const index = Math.min(wParam | 0, held.items.length);
                /** @type {HeaderItem} */
                const item = { width: 0, text: '', hasText: false, fmt: 0, lParam: 0, bitmap: 0,
                    image: 0, type: 0, filter: 0, state: 0 };
                store(item, lParam, wide);
                const mask = read32(lParam + HDITEM.mask);
                // An inserted item's kind follows what it was handed, whatever
                // its format said: a text makes it a string item, a bitmap a
                // bitmap one, an image an image one.
                item.fmt = mask & HDI_TEXT ? item.fmt | HDF_STRING : item.fmt & ~HDF_STRING;
                item.fmt = item.bitmap !== 0 ? item.fmt | HDF_BITMAP : item.fmt & ~HDF_BITMAP;
                if (mask & HDI_IMAGE)
                {
                    item.fmt |= HDF_IMAGE;
                }
                const asked = read32(lParam + HDITEM.iOrder) | 0;
                // An item takes the place in the display order it names, or
                // its index's; the indices at or past it move up by one.
                const order = mask & HDI_ORDER && asked >= 0 && asked <= held.items.length
                    ? asked : index;
                held.items.splice(index, 0, item);
                held.order = held.order.map((/** @type {number} */ i)=>(i >= index ? i + 1 : i));
                held.order.splice(order, 0, index);
                host.invalidate(record);
                // Accessibility hears of the item made (Wine's header tests,
                // insertItem sequence).
                return after(raiseEvent(host, record, EVENT_OBJECT_CREATE, index + 1, thread),
                    ()=>index);
            }
            case HDM.DELETEITEM: {
                const index = wParam | 0;
                if (index < 0 || index >= held.items.length)
                {
                    return 0;
                }
                held.items.splice(index, 1);
                held.order = held.order.filter((/** @type {number} */ i)=>i !== index)
                    .map((/** @type {number} */ i)=>(i > index ? i - 1 : i));
                host.invalidate(record);
                return after(raiseEvent(host, record, EVENT_OBJECT_DESTROY, index + 1, thread),
                    ()=>1);
            }
            case HDM.GETITEMA:
            case HDM.GETITEMW: {
                const index = wParam | 0;
                if (lParam >>> 0 === 0 || index < 0 || index >= held.items.length)
                {
                    return 0;
                }
                return fill(record, index, lParam, message.message === HDM.GETITEMW, thread);
            }
            case HDM.SETITEMA:
            case HDM.SETITEMW: {
                const index = wParam | 0;
                if (lParam >>> 0 === 0 || index < 0 || index >= held.items.length)
                {
                    return 0;
                }
                const wide = message.message === HDM.SETITEMW;
                // The parent reads the item in the spelling it asked for: one
                // handed in the other is copied over with its text converted.
                const mask = read32(lParam + HDITEM.mask);
                const textAt = read32(lParam + HDITEM.pszText);
                const convert = wide !== held.unicode && mask & HDI_TEXT
                    && textAt !== 0 && textAt !== LPSTR_TEXTCALLBACK;
                const copy = convert ? host.allocate?.(HDITEM.SIZE + MAX_TEXT * 2) ?? 0 : 0;
                if (copy !== 0)
                {
                    host.writeMemory(copy, host.readMemory(lParam, HDITEM.SIZE));
                    writeText(host, copy + HDITEM.SIZE, readText(host, textAt, wide),
                        held.unicode, MAX_TEXT);
                    write32(copy + HDITEM.pszText, copy + HDITEM.SIZE);
                }
                const shown = copy !== 0 ? copy : lParam;
                const tell = (/** @type {number} */ codeA, /** @type {number} */ codeW)=>
                    notify(record, held.unicode ? codeW : codeA, NMHEADER_SIZE, block=>{
                        write32(block + 12, index);
                        write32(block + 20, shown);
                    }, thread);
                const done = (/** @type {number} */ answer)=>{
                    if (copy !== 0)
                    {
                        host.release?.(copy);
                    }
                    return answer;
                };
                return after(tell(HDN_ITEMCHANGINGA, HDN_ITEMCHANGINGW), refused=>{
                    if (refused !== 0)
                    {
                        return done(0);
                    }
                    store(held.items[index], lParam, wide);
                    if (mask & HDI_ORDER)
                    {
                        const to = read32(lParam + HDITEM.iOrder) | 0;
                        if (to >= 0 && to < held.items.length)
                        {
                            held.order = held.order.filter((/** @type {number} */ i)=>
                                i !== index);
                            held.order.splice(to, 0, index);
                        }
                    }
                    host.invalidate(record);
                    return after(tell(HDN_ITEMCHANGEDA, HDN_ITEMCHANGEDW), ()=>done(1));
                });
            }
            case HDM.GETITEMRECT: {
                const index = wParam | 0;
                if (lParam >>> 0 === 0 || index < 0 || index >= held.items.length)
                {
                    return 0;
                }
                const box = layout(record)[index];
                [box.left, box.top, box.right, box.bottom]
                    .forEach((value, i)=>write32(lParam + i * 4, value));
                return 1;
            }
            case HDM.LAYOUT: {
                if (lParam >>> 0 === 0)
                {
                    return 0;
                }
                const rect = read32(lParam);
                const position = read32(lParam + 4);
                if (rect === 0 || position === 0)
                {
                    return 0;
                }
                const [left, top, right, bottom] = [0, 4, 8, 12].map(at=>read32(rect + at) | 0);
                const height = Math.min(naturalHeight(record), Math.max(0, bottom - top));
                [record.hwnd, 0, left, top, right - left, height, 0]
                    .forEach((value, i)=>write32(position + i * 4, value));
                write32(rect + 4, top + height);
                return 1;
            }
            case HDM.HITTEST: {
                if (lParam >>> 0 === 0)
                {
                    return -1;
                }
                const x = read32(lParam + HITTEST.x) | 0;
                const y = read32(lParam + HITTEST.y) | 0;
                const size = host.clientSize(record);
                let flags = 0;
                let found = -1;
                if (y < 0)
                {
                    flags |= HHT_ABOVE;
                }
                else if (y >= size.height)
                {
                    flags |= HHT_BELOW;
                }
                if (x < 0)
                {
                    flags |= HHT_TOLEFT;
                }
                else if (x >= size.width)
                {
                    flags |= HHT_TORIGHT;
                }
                if (flags === 0)
                {
                    const rects = layout(record);
                    for (const index of held.order)
                    {
                        const box = rects[index];
                        if (Math.abs(x - box.right) <= DIVIDER_SLOP)
                        {
                            flags = HHT_ONDIVIDER;
                            found = index;
                            break;
                        }
                        if (x >= box.left && x < box.right)
                        {
                            flags = HHT_ONHEADER;
                            found = index;
                        }
                    }
                    if (flags === 0)
                    {
                        flags = HHT_NOWHERE;
                    }
                }
                write32(lParam + HITTEST.flags, flags);
                write32(lParam + HITTEST.iItem, found);
                return found;
            }
            case HDM.ORDERTOINDEX: {
                const order = wParam | 0;
                return order >= 0 && order < held.order.length ? held.order[order] : order;
            }
            case HDM.GETORDERARRAY: {
                if (lParam >>> 0 === 0 || wParam >>> 0 !== held.items.length)
                {
                    return 0;
                }
                held.order.forEach((/** @type {number} */ index, /** @type {number} */ i)=>
                    write32(lParam + i * 4, index));
                return 1;
            }
            case HDM.SETORDERARRAY: {
                const count = held.items.length;
                if (lParam >>> 0 === 0 || wParam >>> 0 !== count)
                {
                    return 0;
                }
                const order = Array.from({ length: count }, (_, i)=>read32(lParam + i * 4) | 0);
                if (order.some(i=>i < 0 || i >= count))
                {
                    return 0;
                }
                held.order = order;
                host.invalidate(record);
                return after(raiseEvent(host, record, EVENT_OBJECT_REORDER, CHILDID_SELF, thread),
                    ()=>1);
            }
            case HDM.SETIMAGELIST: {
                const which = wholeAddress(wParam);
                if (which > 2)
                {
                    return 0;
                }
                const previous = held.images[which];
                held.images[which] = lParam >>> 0;
                return previous;
            }
            case HDM.GETIMAGELIST:
                return held.images[wParam >>> 0] ?? 0;
            case HDM.SETBITMAPMARGIN: {
                const previous = held.bitmapMargin;
                held.bitmapMargin = wParam | 0;
                return previous;
            }
            case HDM.GETBITMAPMARGIN:
                return held.bitmapMargin;
            case HDM.SETFILTERCHANGETIMEOUT: {
                const previous = held.filterTimeout;
                held.filterTimeout = lParam | 0;
                return previous;
            }
            case HDM.SETHOTDIVIDER: {
                // wParam TRUE names a point in lParam, FALSE a divider by index:
                // the divider a point is nearest is the left edge of the item
                // whose middle it is left of, or the end of the row.
                if (wParam === 0)
                {
                    return lParam | 0;
                }
                const x = (lParam & 0xffff) << 16 >> 16;
                const rects = layout(record);
                const at = held.order.findIndex((/** @type {number} */ index)=>
                    x < (rects[index].left + rects[index].right) / 2);
                return at < 0 ? held.order.length : at;
            }
            case HDM.GETFOCUSEDITEM:
                return held.focused;
            case HDM.SETFOCUSEDITEM:
                held.focused = lParam | 0;
                return 1;
            case HDM.EDITFILTER:
            case HDM.CLEARFILTER:
            case HDM.CREATEDRAGIMAGE:
            case HDM.GETITEMDROPDOWNRECT:
            case HDM.GETOVERFLOWRECT:
                return 0;
            case CCM_SETUNICODEFORMAT: {
                const previous = held.unicode ? 1 : 0;
                held.unicode = wParam !== 0;
                return previous;
            }
            case CCM_GETUNICODEFORMAT:
                return held.unicode ? 1 : 0;
            case CCM_SETVERSION:
            case CCM_GETVERSION:
                return answerVersion(record, held, message.message, wParam);
            default:
                return tk.common(record, message, thread);
        }
    };
}
