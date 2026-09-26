/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The tree view, `SysTreeView32`.
 *
 * A list with a shape: every item may hold children, and the rows a program
 * sees are the ones on the path of expansions from the roots down. That shape
 * is the whole reason the control exists -- an installer's component list, a
 * registry editor, a folder pane -- and everything else serves it: the indent
 * that shows depth, the lines and the [+] / [-] buttons that show and change
 * the expansions, the check boxes a component list stores its "selected" in,
 * and the notifications that tell the parent the shape or the selection moved.
 *
 * Items are named to the program by handles this control hands out on insert
 * and takes back everywhere else. Text is kept here unless the item was
 * inserted with LPSTR_TEXTCALLBACK, in which case every read of it asks the
 * parent first, through TVN_GETDISPINFO, because the parent is the one that
 * knows it. Images are the one thing not drawn: an image list here holds
 * handles rather than pixels, so a row leaves the space an image would take
 * and says once that nothing went in it.
 *
 * Telling the parent is WM_NOTIFY, not WM_COMMAND: the notification carries a
 * structure the parent reads (and for TVN_GETDISPINFO writes), so it lives in
 * guest memory for the length of the message and nowhere longer.
 */

import {
    WM_PAINT, WM_ERASEBKGND, WM_KEYDOWN, WM_CHAR, WM_SETFOCUS, WM_KILLFOCUS,
    WM_LBUTTONDOWN, WM_LBUTTONDBLCLK, WM_VSCROLL,
    COLOR_WINDOW, COLOR_WINDOWTEXT, COLOR_HIGHLIGHT, COLOR_HIGHLIGHTTEXT,
    COLOR_GRAYTEXT, COLOR_BTNTEXT, COLOR_3DFACE,
    SB_LINEUP, SB_LINEDOWN, SB_PAGEUP, SB_PAGEDOWN, SB_TOP, SB_BOTTOM,
    SB_THUMBPOSITION, SB_THUMBTRACK,
    after, pointOf,
} from '../user32/controls.js';
import { encodeAnsi } from '../kernel32/locale.js';

/** The class name a program creates the control by. */
export const TREEVIEW_CLASS = 'SysTreeView32';

/** The atom spacing a build without a bridge gives the class's procedure. */
export const TREEVIEW_ATOM = 0x8011;

/** Styles. */
export const TVS_HASBUTTONS = 0x0001;
export const TVS_HASLINES = 0x0002;
export const TVS_LINESATROOT = 0x0004;
export const TVS_SHOWSELALWAYS = 0x0020;
export const TVS_CHECKBOXES = 0x0100;

/** Messages, numbered off TVM_FIRST. */
const TVM_FIRST = 0x1100;
export const TVM_INSERTITEMA = TVM_FIRST + 0;
export const TVM_DELETEITEM = TVM_FIRST + 1;
export const TVM_EXPAND = TVM_FIRST + 2;
export const TVM_GETCOUNT = TVM_FIRST + 5;
export const TVM_GETINDENT = TVM_FIRST + 6;
export const TVM_SETINDENT = TVM_FIRST + 7;
export const TVM_GETIMAGELIST = TVM_FIRST + 8;
export const TVM_SETIMAGELIST = TVM_FIRST + 9;
export const TVM_GETNEXTITEM = TVM_FIRST + 10;
export const TVM_SELECTITEM = TVM_FIRST + 11;
export const TVM_GETITEMA = TVM_FIRST + 12;
export const TVM_SETITEMA = TVM_FIRST + 13;
export const TVM_GETVISIBLECOUNT = TVM_FIRST + 16;
export const TVM_HITTEST = TVM_FIRST + 17;
export const TVM_ENSUREVISIBLE = TVM_FIRST + 20;

/** TVITEM masks. */
export const TVIF_TEXT = 0x0001;
export const TVIF_IMAGE = 0x0002;
export const TVIF_PARAM = 0x0004;
export const TVIF_STATE = 0x0008;
export const TVIF_SELECTEDIMAGE = 0x0020;
export const TVIF_CHILDREN = 0x0040;

/** TVITEM state bits. */
export const TVIS_SELECTED = 0x0002;
export const TVIS_EXPANDED = 0x0020;
export const TVIS_STATEIMAGEMASK = 0xf000;

/** "Ask the parent" sentinels. */
export const LPSTR_TEXTCALLBACK = -1;
const I_IMAGECALLBACK = -1;

/** Insert-after positions. */
const TVI_ROOT = 0xffff0000;
const TVI_FIRST = 0xffff0001;
const TVI_LAST = 0xffff0002;
const TVI_SORT = 0xffff0003;

/** TVM_EXPAND actions. */
const TVE_COLLAPSE = 0x0001;
const TVE_EXPAND = 0x0002;
const TVE_TOGGLE = 0x0003;

/** TVM_GETNEXTITEM relations. */
const TVGN_ROOT = 0;
const TVGN_NEXT = 1;
const TVGN_PREVIOUS = 2;
const TVGN_PARENT = 3;
const TVGN_CHILD = 4;
const TVGN_FIRSTVISIBLE = 5;
const TVGN_NEXTVISIBLE = 6;
const TVGN_PREVIOUSVISIBLE = 7;
const TVGN_CARET = 9;

/** TVM_SETIMAGELIST / TVM_GETIMAGELIST kinds; normal is the default branch. */
const TVSIL_STATE = 2;

/** Notifications to the parent. */
export const WM_NOTIFY = 0x004e;
export const NM_CLICK = -2;
export const NM_DBLCLK = -3;
const TVN_FIRST = -400;
export const TVN_SELCHANGINGA = TVN_FIRST - 1;
export const TVN_SELCHANGEDA = TVN_FIRST - 2;
export const TVN_GETDISPINFOA = TVN_FIRST - 3;
export const TVN_ITEMEXPANDINGA = TVN_FIRST - 5;
export const TVN_ITEMEXPANDEDA = TVN_FIRST - 6;

/** Structure layouts, in bytes, as the guest compiled them. */
export const TVITEM = Object.freeze({
    mask: 0, hItem: 4, state: 8, stateMask: 12, pszText: 16, cchTextMax: 20,
    iImage: 24, iSelectedImage: 28, cChildren: 32, lParam: 36, SIZE: 40,
});
export const TVINSERTSTRUCT = Object.freeze({
    hParent: 0, hInsertAfter: 4, item: 8, SIZE: 48,
});
export const NMHDR = Object.freeze({ hwndFrom: 0, idFrom: 4, code: 8, SIZE: 12 });
const NMTVDISPINFO = Object.freeze({ hdr: 0, item: 12, SIZE: 52 });
// NMTREEVIEW carries an `action` word between the header and the two items;
// leaving it out puts both items four bytes early, and a parent reading a
// handle or a text pointer from there reads garbage.
const NMTREEVIEW = Object.freeze({
    hdr: 0, action: 12, itemOld: 16, itemNew: 56, ptDrag: 96, SIZE: 104,
});
const TVHT = Object.freeze({ x: 0, y: 4, flags: 8, hItem: 12, SIZE: 16 });

/** Virtual keys the tree acts on. */
const VK_SPACE = 0x20;
const VK_LEFT = 0x25;
const VK_UP = 0x26;
const VK_RIGHT = 0x27;
const VK_DOWN = 0x28;
const VK_ADD = 0x6b;
const VK_SUBTRACT = 0x6d;

/** The width of a scroll bar reserved at the right when the rows overflow. */
const SCROLLBAR = 16;
/** Pixels of indent per level of depth, until TVM_SETINDENT says otherwise. */
const DEFAULT_INDENT = 16;
/** The [+] / [-] button and the check box, and the gap after each. */
const BUTTON = 9;
const CHECK = 13;
const GAP = 3;
/** TVHT_ flag for "on the item's text or icon". */
const TVHT_ONITEM = 0x0040;

/**
 * @typedef {import('../user32/controls.js').ControlHost} ControlHost
 * @typedef {import('../user32/controls.js').ControlMessage} ControlMessage
 * @typedef {import('../user32/controls.js').Rect} Rect
 */

/** @param {number} value */
const u32 = value=>new Uint8Array([
    value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff,
]);

/** Terminated, in the ANSI page the text was read in. @param {string} text */
const stringBytes = text=>encodeAnsi(`${text}\0`);

/**
 * Builds the window procedure of a tree view.
 *
 * @param {ControlHost} host
 * @param {any} tk  The drawing helpers the system classes share.
 * @returns {(record: any, message: ControlMessage, thread?: unknown)
 *     => number | Promise<number>}
 */
export function createTreeViewProcedure(host, tk){
    /**
     * @typedef {Object} TreeNode
     * @property {number} handle
     * @property {number} parent
     * @property {number[]} children
     * @property {string} text
     * @property {boolean} textCallback
     * @property {number} param
     * @property {number} image
     * @property {number} selectedImage
     * @property {number} state
     * @property {number} childrenCount
     * @property {boolean} expanded
     */

    /** @param {any} record */
    const state = record=>{
        const held = tk.stateOf(record);
        held.nodes ??= new Map();
        held.roots ??= [];
        held.next ??= 1;
        held.caret ??= 0;
        held.top ??= 0;
        held.indent ??= DEFAULT_INDENT;
        held.lists ??= { normal: 0, state: 0 };
        return held;
    };

    /** @param {any} record @param {number} handle @returns {TreeNode | null} */
    const node = (record, handle)=>state(record).nodes.get(handle >>> 0) ?? null;

    /** @param {any} record */
    const disabled = record=>(record.style & 0x08000000) !== 0;

    /**
     * The rows on show: the roots and, under each expanded item, its children,
     * depth first, in the order they were inserted.
     *
     * @param {any} record
     * @returns {{ item: TreeNode, depth: number }[]}
     */
    const rows = record=>{
        const held = state(record);
        /** @type {{ item: TreeNode, depth: number }[]} */
        const out = [];
        /** @param {number[]} siblings @param {number} depth */
        const walk = (siblings, depth)=>{
            for (const handle of siblings)
            {
                const item = held.nodes.get(handle);
                if (!item)
                {
                    continue;
                }
                out.push({ item, depth });
                if (item.expanded)
                {
                    walk(item.children, depth + 1);
                }
            }
        };
        walk(held.roots, 0);
        return out;
    };

    /** @param {any} record @param {TreeNode} item */
    const siblingsOf = (record, item)=>(item.parent === 0
        ? state(record).roots
        : node(record, item.parent)?.children ?? []);

    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>host.writeMemory(address >>> 0, u32(value));
    /** @param {number} address @returns {number} */
    const readU32 = address=>{
        const bytes = host.readMemory(address >>> 0, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    /** @param {number} address @returns {number} signed */
    const readI32 = address=>readU32(address) | 0;

    /** The row height, measured through a context on the window itself. @param {any} record */
    const measureHeight = record=>{
        if (!host.draw)
        {
            return 16;
        }
        const { hdc } = host.contextOn(record);
        const measured = hdc !== 0 ? host.draw.measure(hdc, 'M') : null;
        host.endPaint(record, hdc);
        return measured ? measured.height : 16;
    };

    /** How many rows fit the client area. @param {any} record */
    const fitting = record=>{
        const height = measureHeight(record);
        const area = tk.clientRect(record);
        return Math.max(1,
            Math.floor((area.bottom - area.top) / Math.max(1, height)));
    };

    /**
     * Moves the first visible row, clamped to what there is to show.
     *
     * @param {any} record @param {number} pos
     */
    const setTop = (record, pos)=>{
        const held = state(record);
        const ceiling = Math.max(0, rows(record).length - fitting(record));
        const next = Math.max(0, Math.min(ceiling, pos));
        if (next !== held.top)
        {
            held.top = next;
            host.invalidate(record);
        }
    };

    /**
     * Writes an NMHDR at the start of a notification structure.
     *
     * @param {Uint8Array} bytes @param {any} record @param {number} code
     */
    const header = (bytes, record, code)=>{
        const view = new DataView(bytes.buffer);
        view.setUint32(NMHDR.hwndFrom, record.hwnd >>> 0, true);
        view.setUint32(NMHDR.idFrom, record.id & 0xffff, true);
        view.setInt32(NMHDR.code, code, true);
    };

    /**
     * Writes a TVITEM for an item into a structure at `at`, as the
     * notifications carry one.
     *
     * @param {Uint8Array} bytes @param {number} at @param {TreeNode} item
     * @param {number} textPointer @param {number} cchTextMax
     */
    const writeItem = (bytes, at, item, textPointer, cchTextMax)=>{
        const view = new DataView(bytes.buffer);
        view.setUint32(at + TVITEM.mask,
            TVIF_STATE | TVIF_PARAM | TVIF_IMAGE | TVIF_SELECTEDIMAGE | TVIF_CHILDREN, true);
        view.setUint32(at + TVITEM.hItem, item.handle >>> 0, true);
        view.setUint32(at + TVITEM.state, item.state >>> 0, true);
        view.setUint32(at + TVITEM.stateMask, TVIS_STATEIMAGEMASK | TVIS_SELECTED, true);
        view.setInt32(at + TVITEM.pszText, textPointer | 0, true);
        view.setInt32(at + TVITEM.cchTextMax, cchTextMax | 0, true);
        view.setInt32(at + TVITEM.iImage, item.image | 0, true);
        view.setInt32(at + TVITEM.iSelectedImage, item.selectedImage | 0, true);
        view.setInt32(at + TVITEM.cChildren, item.childrenCount | 0, true);
        view.setUint32(at + TVITEM.lParam, item.param >>> 0, true);
    };

    /**
     * Tells the parent something happened, handing it a structure in guest
     * memory for the length of the message.
     *
     * The buffer is kept per control and reused, not freed when the parent
     * returns: a parent is entitled to hold the NMHDR it was handed for as
     * long as it is still inside the notification, and a block handed back to
     * the allocator can be given to someone else and rewritten under it.
     *
     * @param {any} record @param {number} code @param {Uint8Array} bytes
     * @param {unknown} [thread]
     * @returns {number | Promise<number>}
     */
    const notify = (record, code, bytes, thread)=>{
        if (!record.parent || !host.allocate)
        {
            return 0;
        }
        header(bytes, record, code);
        const held = state(record);
        if ((held.notifySize ?? 0) < bytes.length)
        {
            if (held.notifyAddress)
            {
                host.release?.(held.notifyAddress);
            }
            held.notifyAddress = host.allocate(bytes.length);
            held.notifySize = bytes.length;
        }
        const address = held.notifyAddress;
        if (!address)
        {
            return 0;
        }
        host.writeMemory(address, bytes);
        return host.send(record.parent, WM_NOTIFY, record.id & 0xffff, address, thread);
    };

    /**
     * Asks the parent for an item's text, TVN_GETDISPINFO: the structure holds
     * a buffer the parent writes the text into, or the parent replaces the
     * pointer in item.pszText with one of its own; either way the text is read
     * back out of guest memory once the parent has answered, and cached, so a
     * paint never has to wait on it.
     *
     * @param {any} record @param {TreeNode} item @param {unknown} [thread]
     * @returns {Promise<string>}
     */
    const askDispInfo = (record, item, thread)=>{
        const BUFFER = 64;
        if (!record.parent || !host.allocate)
        {
            return Promise.resolve(item.text);
        }
        const bytes = new Uint8Array(NMTVDISPINFO.SIZE + BUFFER);
        writeItem(bytes, NMTVDISPINFO.item, item, 0, BUFFER);
        const address = host.allocate(bytes.length);
        if (address === 0)
        {
            return Promise.resolve(item.text);
        }
        // The text buffer sits just past the structure, in the same block.
        new DataView(bytes.buffer).setInt32(NMTVDISPINFO.item + TVITEM.pszText,
            (address + NMTVDISPINFO.SIZE) | 0, true);
        header(bytes, record, TVN_GETDISPINFOA);
        host.writeMemory(address, bytes);
        return Promise.resolve(host.send(record.parent, WM_NOTIFY, record.id & 0xffff,
            address, thread)).then(()=>{
            const pointer = readI32(address + NMTVDISPINFO.item + TVITEM.pszText) >>> 0;
            const text = pointer === 0 ? '' : host.readCString(pointer, BUFFER);
            host.release?.(address);
            item.text = text;
            return text;
        });
    };

    /**
     * Reads the TVITEM an insert or a set handed in, into a fresh item or onto
     * an existing one, honouring the mask.
     *
     * @param {any} record @param {number} address @param {TreeNode} [into]
     * @returns {TreeNode}
     */
    const readItem = (record, address, into)=>{
        const held = state(record);
        const item = into ?? {
            handle: held.next++,
            parent: 0,
            children: [],
            text: '',
            textCallback: false,
            param: 0,
            image: I_IMAGECALLBACK,
            selectedImage: I_IMAGECALLBACK,
            state: 0,
            childrenCount: 0,
            expanded: false,
        };
        const mask = readU32(address + TVITEM.mask);
        if ((mask & TVIF_TEXT) !== 0)
        {
            const pointer = readI32(address + TVITEM.pszText);
            if (pointer === LPSTR_TEXTCALLBACK)
            {
                item.textCallback = true;
            }
            else if (pointer !== 0)
            {
                item.text = host.readCString(pointer >>> 0, 0x10000);
                item.textCallback = false;
            }
        }
        if ((mask & TVIF_PARAM) !== 0)
        {
            item.param = readU32(address + TVITEM.lParam);
        }
        if ((mask & TVIF_IMAGE) !== 0)
        {
            item.image = readI32(address + TVITEM.iImage);
        }
        if ((mask & TVIF_SELECTEDIMAGE) !== 0)
        {
            item.selectedImage = readI32(address + TVITEM.iSelectedImage);
        }
        if ((mask & TVIF_STATE) !== 0)
        {
            const bits = readU32(address + TVITEM.stateMask);
            item.state = (item.state & ~bits) | (readU32(address + TVITEM.state) & bits);
        }
        if ((mask & TVIF_CHILDREN) !== 0)
        {
            item.childrenCount = readI32(address + TVITEM.cChildren);
        }
        return item;
    };

    /**
     * Places a new item among its siblings, honouring the insert-after the
     * program named.
     *
     * @param {any} record @param {TreeNode} item @param {number} parent
     * @param {number} afterFlag
     */
    const place = (record, item, parent, afterFlag)=>{
        const held = state(record);
        item.parent = parent >>> 0;
        const siblings = parent === 0 ? held.roots : node(record, parent)?.children;
        if (!siblings)
        {
            return;
        }
        if (afterFlag === TVI_FIRST)
        {
            siblings.unshift(item.handle);
        }
        else if (afterFlag === TVI_SORT)
        {
            const at = siblings.findIndex(/** @param {number} each */ each=>{
                const other = held.nodes.get(each);
                return other ? other.text.toLowerCase() > item.text.toLowerCase() : false;
            });
            siblings.splice(at === -1 ? siblings.length : at, 0, item.handle);
        }
        else if (afterFlag !== TVI_LAST && afterFlag !== TVI_ROOT
            && siblings.indexOf(afterFlag >>> 0) !== -1)
        {
            siblings.splice(siblings.indexOf(afterFlag >>> 0) + 1, 0, item.handle);
        }
        else
        {
            siblings.push(item.handle);
        }
        held.nodes.set(item.handle, item);
        if (item.parent !== 0)
        {
            const parentNode = node(record, item.parent);
            if (parentNode)
            {
                parentNode.childrenCount = Math.max(1, parentNode.childrenCount);
            }
        }
    };

    /** @param {any} record @param {number} handle  Removes an item and its subtree. */
    const remove = (record, handle)=>{
        const held = state(record);
        const item = node(record, handle);
        if (!item)
        {
            return;
        }
        for (const child of [...item.children])
        {
            remove(record, child);
        }
        const siblings = siblingsOf(record, item);
        const at = siblings.indexOf(item.handle);
        if (at !== -1)
        {
            siblings.splice(at, 1);
        }
        held.nodes.delete(item.handle);
        if (held.caret === item.handle)
        {
            held.caret = 0;
        }
    };

    /**
     * Sends a selection change through the parent: SELCHANGING first, and only
     * if the parent did not refuse it, the move and SELCHANGED.
     *
     * @param {any} record @param {number} handle @param {unknown} [thread]
     */
    const select = (record, handle, thread)=>{
        const held = state(record);
        if (held.caret === (handle >>> 0))
        {
            return 0;
        }
        const from = node(record, held.caret);
        const to = node(record, handle);
        const bytes = new Uint8Array(NMTREEVIEW.SIZE);
        const fill = ()=>{
            if (from)
            {
                writeItem(bytes, NMTREEVIEW.itemOld, from, 0, 0);
            }
            if (to)
            {
                writeItem(bytes, NMTREEVIEW.itemNew, to, 0, 0);
            }
        };
        fill();
        return after(notify(record, TVN_SELCHANGINGA, bytes, thread), refused=>{
            if ((refused | 0) !== 0)
            {
                return 0;
            }
            if (from)
            {
                from.state &= ~TVIS_SELECTED;
            }
            held.caret = handle >>> 0;
            if (to)
            {
                to.state |= TVIS_SELECTED;
            }
            host.invalidate(record);
            fill();
            return notify(record, TVN_SELCHANGEDA, bytes, thread);
        });
    };

    /**
     * Changes an item's expansion, telling the parent before and after.
     *
     * @param {any} record @param {TreeNode} item @param {boolean} open
     * @param {unknown} [thread]
     */
    const expand = (record, item, open, thread)=>{
        if (item.expanded === open)
        {
            return 0;
        }
        const bytes = new Uint8Array(NMTREEVIEW.SIZE);
        writeItem(bytes, NMTREEVIEW.itemNew, item, 0, 0);
        new DataView(bytes.buffer).setUint32(NMTREEVIEW.action,
            open ? TVE_EXPAND : TVE_COLLAPSE, true);
        return after(notify(record, TVN_ITEMEXPANDINGA, bytes, thread), refused=>{
            if ((refused | 0) !== 0)
            {
                return 0;
            }
            item.expanded = open;
            item.state = open ? item.state | TVIS_EXPANDED : item.state & ~TVIS_EXPANDED;
            host.invalidate(record);
            return notify(record, TVN_ITEMEXPANDEDA, bytes, thread);
        });
    };

    /**
     * Where a row sits: its band across the client area and the x its gutter
     * starts at, for a row index into the visible list.
     *
     * @param {any} record @param {Rect} area @param {number} index
     * @param {number} depth @param {number} height
     */
    const rowAt = (record, area, index, depth, height)=>{
        const held = state(record);
        const top = area.top + (index - held.top) * height;
        return {
            row: { left: area.left, top, right: area.right, bottom: top + height },
            y: top,
            x: area.left + 1 + depth * held.indent,
        };
    };

    /**
     * Where a row sits in client coordinates, for hit testing: a click arrives
     * relative to the client area, not the screen.
     *
     * @param {any} record @param {number} index @param {number} depth
     * @param {number} height
     */
    const clientRow = (record, index, depth, height)=>{
        const held = state(record);
        return { x: 1 + depth * held.indent, y: (index - held.top) * height };
    };

    /**
     * The x a row's check box starts at, after any expansion button.
     *
     * @param {any} record @param {{ x: number }} at @param {TreeNode} item
     */
    const checkX = (record, at, item)=>{
        let x = at.x;
        if ((record.style & TVS_HASBUTTONS) !== 0 && hasChildren(item))
        {
            x += BUTTON + GAP;
        }
        return x;
    };

    /** @param {TreeNode} item */
    const hasChildren = item=>item.children.length > 0 || item.childrenCount > 0;

    /**
     * A check mark in a check box, as the button draws its own.
     *
     * @param {number} hdc @param {Rect} box @param {number} rgb
     */
    const glyphCheck = (hdc, box, rgb)=>{
        const draw = /** @type {any} */ (host.draw);
        [
            '......#',
            '.....##',
            '#...###',
            '##.###.',
            '#####..',
            '.###...',
            '..#....',
        ].forEach((row, dy)=>{
            for (let dx = 0; dx < row.length; dx++)
            {
                if (row[dx] === '#')
                {
                    draw.fill(hdc, { left: box.left + 3 + dx, top: box.top + 3 + dy,
                        right: box.left + 4 + dx, bottom: box.top + 4 + dy }, rgb);
                }
            }
        });
    };

    /**
     * @param {any} record @param {number} hdc @param {Rect} rect
     */
    const paintTree = (record, hdc, rect)=>{
        const draw = /** @type {any} */ (host.draw);
        const held = state(record);
        draw.fill(hdc, rect, tk.color(disabled(record) ? COLOR_3DFACE : COLOR_WINDOW));
        const height = measureHeight(record);
        const listed = rows(record);
        const fit = fitting(record);
        // A scroll bar takes the right edge when the rows overflow, and the
        // rows keep to what is left of the width.
        const overflow = listed.length > fit;
        const area = overflow ? { ...rect, right: rect.right - SCROLLBAR } : rect;
        const focused = host.focus() === record.hwnd;
        const ink = tk.color(disabled(record) ? COLOR_GRAYTEXT : COLOR_WINDOWTEXT);
        const lines = (record.style & TVS_HASLINES) !== 0;
        const linesAtRoot = (record.style & TVS_LINESATROOT) !== 0;
        const buttons = (record.style & TVS_HASBUTTONS) !== 0;
        const checks = (record.style & TVS_CHECKBOXES) !== 0;

        for (let index = held.top; index < listed.length; index++)
        {
            const { item, depth } = listed[index];
            const at = rowAt(record, area, index, depth, height);
            if (at.y >= area.bottom)
            {
                break;
            }
            const selected = item.handle === held.caret
                && (focused || (record.style & TVS_SHOWSELALWAYS) !== 0);
            if (selected)
            {
                draw.fill(hdc, at.row, tk.color(COLOR_HIGHLIGHT));
            }
            if (lines && (depth > 0 || linesAtRoot))
            {
                const mid = at.y + Math.floor(height / 2);
                draw.fill(hdc, { left: at.x - 8, top: mid, right: at.x - 2, bottom: mid + 1 },
                    ink);
            }
            let x = at.x;
            if (buttons && hasChildren(item))
            {
                const top = at.y + Math.floor((height - BUTTON) / 2);
                const box = { left: x, top, right: x + BUTTON, bottom: top + BUTTON };
                draw.fill(hdc, box, tk.color(COLOR_WINDOW));
                tk.edge(hdc, box, ink, ink);
                const cy = Math.floor((box.top + box.bottom) / 2);
                const cx = Math.floor((box.left + box.right) / 2);
                draw.fill(hdc, { left: box.left + 2, top: cy, right: box.right - 2,
                    bottom: cy + 1 }, ink);
                if (!item.expanded)
                {
                    draw.fill(hdc, { left: cx, top: box.top + 2, right: cx + 1,
                        bottom: box.bottom - 2 }, ink);
                }
                x += BUTTON + GAP;
            }
            if (checks)
            {
                const top = at.y + Math.floor((height - CHECK) / 2);
                const box = { left: x, top, right: x + CHECK, bottom: top + CHECK };
                tk.sunkenEdge(hdc, box);
                draw.fill(hdc, tk.shrink(box, 2), tk.color(COLOR_WINDOW));
                if ((item.state & TVIS_STATEIMAGEMASK) >>> 12 >= 2)
                {
                    glyphCheck(hdc, box, tk.color(COLOR_BTNTEXT));
                }
                x += CHECK + GAP;
            }
            draw.text(hdc, x + 1, at.y, item.text,
                { color: selected ? tk.color(COLOR_HIGHLIGHTTEXT) : ink, clip: at.row });
        }
        if (held.lists.normal !== 0 && !held.imageDivergenceSaid)
        {
            held.imageDivergenceSaid = true;
            host.divergence?.('SysTreeView32',
                'an image list is not drawn here; rows leave the space an image would take');
        }
        if (overflow)
        {
            tk.paintScrollBar(hdc, { left: rect.right - SCROLLBAR, top: rect.top,
                right: rect.right, bottom: rect.bottom }, true,
            { min: 0, max: listed.length - 1, page: fit, pos: held.top });
        }
    };

    /**
     * The row a client point falls in, for hit testing and clicks.
     *
     * @param {any} record @param {number} y @param {number} height
     */
    const rowAtPoint = (record, y, height)=>{
        const held = state(record);
        const listed = rows(record);
        const index = held.top + Math.floor(y / Math.max(1, height));
        if (index < 0 || index >= listed.length)
        {
            return null;
        }
        return { index, ...listed[index] };
    };

    /**
     * @param {any} record @param {ControlMessage} message @param {unknown} [thread]
     */
    return (record, message, thread)=>{
        const held = state(record);
        switch (message.message){
            case WM_PAINT:
                return tk.painting(record, (/** @type {number} */ hdc)=>{
                    paintTree(record, hdc, tk.clientRect(record));
                    return 0;
                });
            case WM_ERASEBKGND:
                return 1;
            case WM_SETFOCUS:
            case WM_KILLFOCUS:
                host.invalidate(record);
                return 0;
            case WM_VSCROLL: {
                const code = message.wParam & 0xffff;
                const fit = fitting(record);
                const total = rows(record).length;
                const by = code === SB_LINEUP ? -1 : code === SB_LINEDOWN ? 1
                    : code === SB_PAGEUP ? -fit : code === SB_PAGEDOWN ? fit
                        : code === SB_TOP ? -total : code === SB_BOTTOM ? total
                            : code === SB_THUMBPOSITION || code === SB_THUMBTRACK
                                ? (message.wParam >>> 16) - held.top : 0;
                setTop(record, held.top + by);
                return 0;
            }
            case WM_LBUTTONDOWN: {
                const point = pointOf(message.lParam);
                const area = tk.clientRect(record);
                const width = area.right - area.left;
                const depth = area.bottom - area.top;
                const height = measureHeight(record);
                // A click on the scroll bar scrolls rather than selects.
                if (rows(record).length > fitting(record)
                    && point.x >= width - SCROLLBAR)
                {
                    const code = tk.scrollHit({ left: width - SCROLLBAR, top: 0,
                        right: width, bottom: depth }, true,
                    { min: 0, max: rows(record).length - 1, page: fitting(record),
                        pos: held.top }, point.x, point.y);
                    const fit = fitting(record);
                    const by = code === SB_LINEUP ? -1 : code === SB_LINEDOWN ? 1
                        : code === SB_PAGEUP ? -fit : code === SB_PAGEDOWN ? fit : 0;
                    setTop(record, held.top + by);
                    return 0;
                }
                const hit = rowAtPoint(record, point.y, height);
                return after(host.setFocus(record.hwnd, thread), ()=>{
                    if (!hit)
                    {
                        return 0;
                    }
                    const at = clientRow(record, hit.index, hit.depth, height);
                    // A click on the check box toggles the state image; the old
                    // common controls say so with NM_CLICK and nothing else.
                    if ((record.style & TVS_CHECKBOXES) !== 0)
                    {
                        const cx = checkX(record, at, hit.item);
                        if (point.x >= cx && point.x < cx + CHECK)
                        {
                            const current = (hit.item.state & TVIS_STATEIMAGEMASK) >>> 12;
                            hit.item.state = (hit.item.state & ~TVIS_STATEIMAGEMASK)
                                | ((current === 2 ? 1 : 2) << 12);
                            host.invalidate(record);
                            return notify(record, NM_CLICK,
                                new Uint8Array(NMHDR.SIZE), thread);
                        }
                    }
                    // A click on the [+] / [-] toggles the expansion.
                    if ((record.style & TVS_HASBUTTONS) !== 0 && hasChildren(hit.item)
                        && point.x >= at.x && point.x < at.x + BUTTON)
                    {
                        return expand(record, hit.item, !hit.item.expanded, thread);
                    }
                    return select(record, hit.item.handle, thread);
                });
            }
            case WM_LBUTTONDBLCLK:
                return notify(record, NM_DBLCLK, new Uint8Array(NMHDR.SIZE), thread);
            case WM_KEYDOWN: {
                const key = message.wParam & 0xff;
                const listed = rows(record);
                const atIndex = listed.findIndex(each=>each.item.handle === held.caret);
                if (key === VK_DOWN || key === VK_UP)
                {
                    const target = listed[Math.max(0, Math.min(listed.length - 1,
                        atIndex + (key === VK_DOWN ? 1 : -1)))];
                    return target ? select(record, target.item.handle, thread) : 0;
                }
                const item = node(record, held.caret);
                if (!item)
                {
                    return 0;
                }
                if (key === VK_RIGHT)
                {
                    return expand(record, item, true, thread);
                }
                if (key === VK_LEFT)
                {
                    return item.expanded
                        ? expand(record, item, false, thread)
                        : item.parent !== 0 ? select(record, item.parent, thread) : 0;
                }
                if (key === VK_ADD || key === VK_SUBTRACT)
                {
                    return expand(record, item, key === VK_ADD, thread);
                }
                return 0;
            }
            case WM_CHAR: {
                const character = message.wParam & 0xffff;
                if (character !== VK_SPACE || (record.style & TVS_CHECKBOXES) === 0)
                {
                    return 0;
                }
                const item = node(record, held.caret);
                if (!item)
                {
                    return 0;
                }
                const current = (item.state & TVIS_STATEIMAGEMASK) >>> 12;
                item.state = (item.state & ~TVIS_STATEIMAGEMASK)
                    | ((current === 2 ? 1 : 2) << 12);
                host.invalidate(record);
                return notify(record, NM_CLICK, new Uint8Array(NMHDR.SIZE), thread);
            }
            case TVM_INSERTITEMA: {
                const at = message.lParam >>> 0;
                if (at === 0)
                {
                    return 0;
                }
                const parent = readU32(at + TVINSERTSTRUCT.hParent);
                const afterFlag = readU32(at + TVINSERTSTRUCT.hInsertAfter);
                const item = readItem(record, at + TVINSERTSTRUCT.item);
                place(record, item, parent === TVI_ROOT ? 0 : parent, afterFlag);
                host.invalidate(record);
                return item.handle;
            }
            case TVM_DELETEITEM: {
                if ((message.lParam >>> 0) === TVI_ROOT)
                {
                    held.roots.length = 0;
                    held.nodes.clear();
                    held.caret = 0;
                    held.top = 0;
                    host.invalidate(record);
                    return 1;
                }
                const item = node(record, message.lParam);
                if (!item)
                {
                    return 0;
                }
                remove(record, item.handle);
                host.invalidate(record);
                return 1;
            }
            case TVM_EXPAND: {
                const item = node(record, message.lParam);
                if (!item)
                {
                    return 0;
                }
                const action = message.wParam & 0xffff;
                const open = action === TVE_TOGGLE ? !item.expanded : action === TVE_EXPAND;
                return after(expand(record, item, open, thread), ()=>1);
            }
            case TVM_GETCOUNT:
                return held.nodes.size;
            case TVM_GETINDENT:
                return held.indent;
            case TVM_SETINDENT:
                held.indent = Math.max(1, message.wParam | 0);
                host.invalidate(record);
                return 0;
            case TVM_GETIMAGELIST:
                return (message.wParam & 0xffff) === TVSIL_STATE
                    ? held.lists.state : held.lists.normal;
            case TVM_SETIMAGELIST: {
                const previous = (message.wParam & 0xffff) === TVSIL_STATE
                    ? held.lists.state : held.lists.normal;
                if ((message.wParam & 0xffff) === TVSIL_STATE)
                {
                    held.lists.state = message.lParam >>> 0;
                }
                else
                {
                    held.lists.normal = message.lParam >>> 0;
                }
                return previous;
            }
            case TVM_GETNEXTITEM: {
                const item = node(record, message.lParam);
                switch (message.wParam & 0xffff){
                    case TVGN_ROOT:
                        return held.roots[0] ?? 0;
                    case TVGN_NEXT:
                    case TVGN_PREVIOUS: {
                        if (!item)
                        {
                            return 0;
                        }
                        const siblings = siblingsOf(record, item);
                        const at = siblings.indexOf(item.handle);
                        return siblings[at + ((message.wParam & 0xffff) === TVGN_NEXT ? 1 : -1)]
                            ?? 0;
                    }
                    case TVGN_PARENT:
                        return item ? item.parent : 0;
                    case TVGN_CHILD:
                        return item ? item.children[0] ?? 0 : 0;
                    case TVGN_CARET:
                        return held.caret;
                    case TVGN_FIRSTVISIBLE:
                        return rows(record)[held.top]?.item.handle ?? 0;
                    case TVGN_NEXTVISIBLE: {
                        const listed = rows(record);
                        const at = listed.findIndex(each=>each.item.handle
                            === (item ? item.handle : -1));
                        return listed[at + 1]?.item.handle ?? 0;
                    }
                    case TVGN_PREVIOUSVISIBLE: {
                        const listed = rows(record);
                        const at = listed.findIndex(each=>each.item.handle
                            === (item ? item.handle : -1));
                        return at > 0 ? listed[at - 1].item.handle : 0;
                    }
                    default:
                        return 0;
                }
            }
            case TVM_SELECTITEM:
                return (message.wParam & 0xffff) === TVGN_CARET
                    ? select(record, message.lParam, thread) : 0;
            case TVM_GETITEMA: {
                const at = message.lParam >>> 0;
                if (at === 0)
                {
                    return 0;
                }
                const item = node(record, readU32(at + TVITEM.hItem));
                if (!item)
                {
                    return 0;
                }
                const mask = readU32(at + TVITEM.mask);
                // A callback text is the parent's to give: ask before filling
                // the buffer, which is what makes this case asynchronous.
                const asked = (mask & TVIF_TEXT) !== 0 && item.textCallback
                    ? askDispInfo(record, item, thread) : null;
                return after(/** @type {any} */ (asked ?? 0), ()=>{
                    if ((mask & TVIF_TEXT) !== 0)
                    {
                        const buffer = readI32(at + TVITEM.pszText) >>> 0;
                        const room = readI32(at + TVITEM.cchTextMax);
                        if (buffer !== 0 && room > 0)
                        {
                            host.writeMemory(buffer,
                                stringBytes(item.text.slice(0, room - 1)));
                        }
                    }
                    if ((mask & TVIF_PARAM) !== 0)
                    {
                        writeU32(at + TVITEM.lParam, item.param);
                    }
                    if ((mask & TVIF_STATE) !== 0)
                    {
                        writeU32(at + TVITEM.state,
                            item.state & readU32(at + TVITEM.stateMask));
                    }
                    if ((mask & TVIF_IMAGE) !== 0)
                    {
                        writeU32(at + TVITEM.iImage, item.image);
                    }
                    if ((mask & TVIF_SELECTEDIMAGE) !== 0)
                    {
                        writeU32(at + TVITEM.iSelectedImage, item.selectedImage);
                    }
                    if ((mask & TVIF_CHILDREN) !== 0)
                    {
                        writeU32(at + TVITEM.cChildren, item.childrenCount);
                    }
                    return 1;
                });
            }
            case TVM_SETITEMA: {
                const at = message.lParam >>> 0;
                if (at === 0)
                {
                    return 0;
                }
                const item = node(record, readU32(at + TVITEM.hItem));
                if (!item)
                {
                    return 0;
                }
                readItem(record, at, item);
                host.invalidate(record);
                return 1;
            }
            case TVM_GETVISIBLECOUNT:
                return fitting(record);
            case TVM_HITTEST: {
                const at = message.lParam >>> 0;
                if (at === 0)
                {
                    return 0;
                }
                const hit = rowAtPoint(record, readI32(at + TVHT.y), measureHeight(record));
                if (!hit)
                {
                    writeU32(at + TVHT.hItem, 0);
                    writeU32(at + TVHT.flags, 0);
                    return 0;
                }
                writeU32(at + TVHT.hItem, hit.item.handle);
                writeU32(at + TVHT.flags, TVHT_ONITEM);
                return hit.item.handle;
            }
            case TVM_ENSUREVISIBLE: {
                const item = node(record, message.lParam);
                if (!item)
                {
                    return 0;
                }
                let changed = 0;
                for (let ancestor = item.parent; ancestor !== 0;
                    ancestor = node(record, ancestor)?.parent ?? 0)
                {
                    const parent = node(record, ancestor);
                    if (parent && !parent.expanded)
                    {
                        parent.expanded = true;
                        parent.state |= TVIS_EXPANDED;
                        changed = 1;
                    }
                }
                const listed = rows(record);
                const at = listed.findIndex(each=>each.item.handle === item.handle);
                const fit = fitting(record);
                if (at < held.top)
                {
                    held.top = at;
                    changed = 1;
                }
                else if (at >= held.top + fit)
                {
                    held.top = at - fit + 1;
                    changed = 1;
                }
                if (changed)
                {
                    host.invalidate(record);
                }
                return changed;
            }
            default:
                return tk.common(record, message, thread);
        }
    };
}
