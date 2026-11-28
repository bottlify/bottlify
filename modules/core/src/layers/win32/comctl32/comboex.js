/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The extended combo box, `ComboBoxEx32`.
 *
 * comctl32's window around one of user32's: the combo box is its child,
 * with the edit of a drop-down one inside that, and what a program meets is
 * the outer window, whose items carry an image, a selected image, an
 * overlay, an indent and a value beside their text (COMBOBOXEXITEM). The
 * items are the extended box's own; the combo box holds their text, so its
 * list, its field and its typing find what the items say, and the extended
 * box answers the messages about items itself (CBEM_*, CB_GETLBTEXT,
 * CB_GETITEMDATA, CB_FINDSTRINGEXACT, CB_DELETESTRING) and hands the combo
 * box the rest of CB_*.
 *
 * The window is as tall as the combo box's field, whatever height it is
 * given: the height it is made with is how far the list drops (Wine's combo
 * test, test_comboex_WM_WINDOWPOSCHANGING). What the combo box tells its
 * parent is told on to the extended box's parent as the extended box's
 * (WM_COMMAND with its id), and the parent hears of the edit through
 * WM_NOTIFY: CBEN_ENDEDIT as the list drops, Enter or Escape is pressed or
 * the edit loses the focus with a change, CBEN_INSERTITEM and CBEN_DELETEITEM
 * as items come and go, and CBEN_GETDISPINFO for a field an item left to its
 * parent (LPSTR_TEXTCALLBACK, I_IMAGECALLBACK, I_INDENTCALLBACK), kept from
 * then on when the parent answers with CBEIF_DI_SETITEM.
 *
 * The combo box and its edit are subclassed with comctl32's own
 * SetWindowSubclass: the edit for the keys and the focus that end an edit,
 * the combo box to draw the selected item's image beside its edit.
 */

import { WM_CREATE, WM_SETFOCUS, WM_KILLFOCUS, WM_SETFONT, WM_KEYDOWN, WM_GETTEXT, after }
    from '../user32/controls.js';
import { NMHDR, notifyWindow, sendNotify } from './notify.js';
import { encodeAnsi } from '../kernel32/locale.js';
import { readText as readString, writeText as writeString } from './strings.js';
import { wholeAddress } from '../common/pointers.js';

/** The class name a program creates the control by. */
export const COMBOBOXEX_CLASS = 'ComboBoxEx32';

/** The atom spacing a build without a bridge gives the class's procedure. */
export const COMBOBOXEX_ATOM = 0x801e;

const WM_USER = 0x0400;
export const CBEM_INSERTITEMA = WM_USER + 1;
const CBEM_SETIMAGELIST = WM_USER + 2;
const CBEM_GETIMAGELIST = WM_USER + 3;
export const CBEM_GETITEMA = WM_USER + 4;
export const CBEM_SETITEMA = WM_USER + 5;
export const CBEM_GETCOMBOCONTROL = WM_USER + 6;
export const CBEM_GETEDITCONTROL = WM_USER + 7;
export const CBEM_SETEXSTYLE = WM_USER + 8;
export const CBEM_GETEXTENDEDSTYLE = WM_USER + 9;
const CBEM_HASEDITCHANGED = WM_USER + 10;
const CBEM_INSERTITEMW = WM_USER + 11;
const CBEM_SETITEMW = WM_USER + 12;
const CBEM_GETITEMW = WM_USER + 13;
export const CBEM_SETEXTENDEDSTYLE = WM_USER + 14;
const CBEM_SETUNICODEFORMAT = 0x2005;
const CBEM_GETUNICODEFORMAT = 0x2006;
const CBEM_SETWINDOWTHEME = 0x200b;

/** The combo box's messages: the ones the extended box answers itself, and its range. */
const CB_GETEDITSEL = 0x0140;
const CB_DELETESTRING = 0x0144;
export const CBEM_DELETEITEM = CB_DELETESTRING;
export const CB_GETCURSEL = 0x0147;
export const CB_GETLBTEXT = 0x0148;
export const CB_GETLBTEXTLEN = 0x0149;
const CB_INSERTSTRING = 0x014a;
const CB_RESETCONTENT = 0x014b;
export const CB_SETCURSEL = 0x014e;
export const CB_GETITEMDATA = 0x0150;
export const CB_SETITEMDATA = 0x0151;
const CB_SETITEMHEIGHT = 0x0153;
export const CB_FINDSTRINGEXACT = 0x0158;
const CB_LAST = 0x0165;
const CB_ERR = -1;

/** COMBOBOXEXITEM's mask. */
export const CBEIF_TEXT = 0x01;
export const CBEIF_IMAGE = 0x02;
const CBEIF_SELECTEDIMAGE = 0x04;
const CBEIF_OVERLAY = 0x08;
export const CBEIF_INDENT = 0x10;
export const CBEIF_LPARAM = 0x20;
export const CBEIF_DI_SETITEM = 0x10000000;

/** The extended styles. */
const CBES_EX_NOEDITIMAGE = 0x01;
export const CBES_EX_CASESENSITIVE = 0x10;

/** The notifications, off CBEN_FIRST (-800). */
export const CBEN_GETDISPINFOA = -800 >>> 0;
export const CBEN_INSERTITEM = -801 >>> 0;
export const CBEN_DELETEITEM = -802 >>> 0;
const CBEN_BEGINEDIT = -804 >>> 0;
export const CBEN_ENDEDITA = -805 >>> 0;
const CBEN_ENDEDITW = -806 >>> 0;
const CBEN_GETDISPINFOW = -807 >>> 0;
/** Why an edit ended. */
const CBENF_KILLFOCUS = 1;
const CBENF_RETURN = 2;
const CBENF_ESCAPE = 3;
export const CBENF_DROPDOWN = 4;
/** The longest text CBEN_ENDEDIT carries. */
const CBEMAXSTRLEN = 260;

/** A field an item leaves to its parent. */
const CALLBACK = -1;

const WM_SIZE = 0x0005;
const WM_ENABLE = 0x000a;
const WM_PAINT = 0x000f;
const WM_DRAWITEM = 0x002b;
const WM_MEASUREITEM = 0x002c;
const WM_WINDOWPOSCHANGING = 0x0046;
const WM_NOTIFYFORMAT = 0x0055;
const WM_COMMAND = 0x0111;
const WM_NCDESTROY = 0x0082;
const WM_SETTEXT = 0x000c;
const EM_SETSEL = 0x00b1;
const NF_QUERY = 3;
const NF_REQUERY = 4;
const NFR_UNICODE = 2;
const SWP_NOSIZE = 0x0001;
const VK_RETURN = 0x0d;
const VK_ESCAPE = 0x1b;

const WS_CHILD = 0x40000000;
const WS_VISIBLE = 0x10000000;
const WS_VSCROLL = 0x00200000;
const WS_DISABLED = 0x08000000;
const CBS_TYPEMASK = 0x0003;
const CBS_DROPDOWNLIST = 0x0003;
const CBS_OWNERDRAWFIXED = 0x0010;
const CBS_AUTOHSCROLL = 0x0040;
const CBS_DISABLENOSCROLL = 0x0800;
const CBS_NOINTEGRALHEIGHT = 0x0400;
const CBS_HASSTRINGS = 0x0200;

/** The combo box's notifications the extended box acts on. */
const CBN_SELCHANGE = 1;
const CBN_SETFOCUS = 3;
const CBN_EDITCHANGE = 5;
const CBN_DROPDOWN = 7;

const ODS_SELECTED = 0x0001;
const ODS_COMBOBOXEDIT = 0x1000;
const COLOR_HIGHLIGHT = 13;
const COLOR_HIGHLIGHTTEXT = 14;
const COLOR_WINDOW = 5;
const COLOR_WINDOWTEXT = 8;
const DT_VCENTER = 0x0004;
const DT_SINGLELINE = 0x0020;

/** The edit's and the combo box's subclass ids. */
const EDIT_SUBCLASS = 1;
const COMBO_SUBCLASS = 2;
/** The space an indent level takes, and the gap beside an image. */
const INDENT_WIDTH = 10;
const IMAGE_GAP = 3;

/**
 * An item: its text (null for none, CALLBACK for its parent's) and its other
 * fields, null where it has none.
 *
 * @typedef {Object} Item
 * @property {string | null | -1} text
 * @property {number | null} image @property {number | null} selectedImage
 * @property {number | null} overlay @property {number | null} indent
 * @property {number} lParam
 */

/**
 * COMBOBOXEXITEM's offsets at a pointer size.
 *
 * @param {number} pointer
 */
const itemLayout = pointer=>(pointer === 8
    ? { mask: 0, iItem: 8, pszText: 16, cchTextMax: 24, iImage: 28, iSelectedImage: 32,
        iOverlay: 36, iIndent: 40, lParam: 48, size: 56 }
    : { mask: 0, iItem: 4, pszText: 8, cchTextMax: 12, iImage: 16, iSelectedImage: 20,
        iOverlay: 24, iIndent: 28, lParam: 32, size: 36 });

/**
 * Builds the window procedure of an extended combo box.
 *
 * @param {import('../user32/controls.js').ControlHost} host
 * @param {any} tk  The drawing helpers the system classes share.
 * @param {import('./toolbar.js').ToolbarImages} [images]  The image lists items are drawn from.
 * @param {import('./updown.js').Subclassing} [subclassing]  comctl32's SetWindowSubclass.
 * @returns {(record: any, message: import('../user32/controls.js').ControlMessage,
 *     thread?: unknown) => number | Promise<number>}
 */
export function createComboBoxExProcedure(host, tk, images, subclassing){
    const { guest } = host;
    const pointer = guest.pointerSize;
    const HEADER = NMHDR.sizeOf(pointer);
    const ITEM = itemLayout(pointer);
    /**
     * pszText as an item holds it: CALLBACK for LPSTR_TEXTCALLBACK, all ones
     * at the width, else the address, NULL for none.
     *
     * @param {number} at
     */
    const textPointer = at=>(guest.iptr(at + ITEM.pszText) === CALLBACK ? CALLBACK
        : guest.ptr(at + ITEM.pszText));

    /** @param {number} address @param {boolean} wide */
    const readText = (address, wide)=>readString(host, address, wide, 0x10000);

    /**
     * Text into a caller's buffer of `room` characters, cut to fit and ended.
     *
     * @param {number} address @param {number} room @param {string} text @param {boolean} wide
     */
    const writeText = (address, room, text, wide)=>writeString(host, address, text, wide, room);

    /** @param {any} record */
    const state = record=>{
        const held = tk.stateOf(record);
        /** @type {Item[]} */
        held.items ??= [];
        /** @type {Item} what the edit stands for: the item -1 of CBEM_GETITEM and CBEM_SETITEM */
        held.editItem ??= { text: null, image: null, selectedImage: null, overlay: null,
            indent: null, lParam: 0 };
        held.combo ??= 0;
        held.edit ??= 0;
        held.imageList ??= 0;
        held.extended ??= 0;
        held.unicode ??= false;
        held.changed ??= false;
        /** @type {number} the window's height: the combo box's field and its frame */
        held.height ??= 0;
        /** @type {number} how far the list drops: the height the window was made with */
        held.dropHeight ??= 0;
        return held;
    };

    /** @param {any} record  The combo box's window record. */
    const comboOf = record=>host.live(state(record).combo);

    /** @param {any} record */
    const editable = record=>(record.style & CBS_TYPEMASK) !== CBS_DROPDOWNLIST;

    /** @param {Item} item  The text the combo box holds for an item. */
    const shownText = item=>(typeof item.text === 'string' ? item.text : '');

    /**
     * Sends a WM_NOTIFY, the structure in guest memory while it is answered.
     *
     * @param {any} record @param {number} code @param {number} size
     * @param {(block: number) => void} fill @param {unknown} thread
     * @param {(block: number) => void} [read]
     */
    const notify = (record, code, size, fill, thread, read)=>sendNotify(host, record,
        notifyWindow(record), code, size, thread, fill, read);

    /**
     * An item as COMBOBOXEXITEM holds it, every field there, at an address.
     *
     * @param {number} at @param {number} mask @param {number} index @param {Item} item
     * @param {number} text  Where the text is, or zero.
     */
    const fillItem = (at, mask, index, item, text)=>{
        guest.set32(at + ITEM.mask, mask);
        guest.setIptr(at + ITEM.iItem, index);
        guest.setPtr(at + ITEM.pszText, text);
        guest.set32(at + ITEM.iImage, item.image ?? 0);
        guest.set32(at + ITEM.iSelectedImage, item.selectedImage ?? 0);
        guest.set32(at + ITEM.iOverlay, item.overlay ?? 0);
        guest.set32(at + ITEM.iIndent, item.indent === CALLBACK ? 0 : item.indent ?? 0);
        guest.setIptr(at + ITEM.lParam, item.lParam);
    };

    /**
     * CBEN_INSERTITEM or CBEN_DELETEITEM: an NMCOMBOBOXEX with the item.
     *
     * @param {any} record @param {number} code @param {number} index @param {Item} item
     * @param {unknown} thread
     */
    const tellItem = (record, code, index, item, thread)=>notify(record, code, HEADER + ITEM.size,
        block=>fillItem(block + HEADER, code === CBEN_DELETEITEM ? 0
            : CBEIF_TEXT | CBEIF_IMAGE | CBEIF_SELECTEDIMAGE | CBEIF_OVERLAY | CBEIF_INDENT
                | CBEIF_LPARAM, index, item, 0), thread);

    /**
     * Reads what a COMBOBOXEXITEM sets onto an item.
     *
     * @param {number} address @param {Item} item @param {boolean} wide
     */
    const store = (address, item, wide)=>{
        const mask = guest.i32(address + ITEM.mask);
        if ((mask & CBEIF_TEXT) !== 0)
        {
            const text = textPointer(address);
            item.text = text === CALLBACK ? CALLBACK : text === 0 ? null : readText(text, wide);
        }
        if ((mask & CBEIF_IMAGE) !== 0)
        {
            item.image = guest.i32(address + ITEM.iImage);
        }
        if ((mask & CBEIF_SELECTEDIMAGE) !== 0)
        {
            item.selectedImage = guest.i32(address + ITEM.iSelectedImage);
        }
        if ((mask & CBEIF_OVERLAY) !== 0)
        {
            item.overlay = guest.i32(address + ITEM.iOverlay);
        }
        if ((mask & CBEIF_INDENT) !== 0)
        {
            item.indent = guest.i32(address + ITEM.iIndent);
        }
        if ((mask & CBEIF_LPARAM) !== 0)
        {
            item.lParam = guest.iptr(address + ITEM.lParam);
        }
        return mask;
    };

    /**
     * A string in guest memory while a call to the combo box needs it.
     *
     * @param {string} text @param {(address: number) => any} use
     */
    const withString = (text, use)=>{
        const bytes = encodeAnsi(text);
        const at = host.allocate?.(bytes.length + 1) ?? 0;
        if (at === 0)
        {
            host.divergence?.('ComboBoxEx32', 'no memory for an item\'s text: the list shows none');
            return use(0);
        }
        guest.setBytes(at, Uint8Array.from([...bytes, 0]));
        return after(use(at), answer=>{
            host.release?.(at);
            return answer;
        });
    };

    /**
     * CBEM_INSERTITEM: at its index, the end for -1, and nowhere past the end.
     *
     * @param {any} record @param {number} address @param {boolean} wide @param {unknown} thread
     */
    const insertItem = (record, address, wide, thread)=>{
        const held = state(record);
        if (address === 0)
        {
            return CB_ERR;
        }
        const asked = guest.iptr(address + ITEM.iItem);
        const index = asked === -1 ? held.items.length : asked;
        if (index < 0 || index > held.items.length)
        {
            return CB_ERR;
        }
        /** @type {Item} */
        const item = { text: null, image: null, selectedImage: null, overlay: null,
            indent: null, lParam: 0 };
        store(address, item, wide);
        held.items.splice(index, 0, item);
        return after(withString(shownText(item), at=>(held.combo !== 0
            ? host.send(held.combo, CB_INSERTSTRING, index, at, thread) : 0)),
        ()=>after(tellItem(record, CBEN_INSERTITEM, index, item, thread), ()=>index));
    };

    /**
     * CBEM_DELETEITEM: the items left, or CB_ERR for no such item.
     *
     * @param {any} record @param {number} index @param {unknown} thread
     */
    const deleteItem = (record, index, thread)=>{
        const held = state(record);
        if (index < 0 || index >= held.items.length)
        {
            return CB_ERR;
        }
        const [item] = held.items.splice(index, 1);
        return after(held.combo !== 0 ? host.send(held.combo, CB_DELETESTRING, index, 0, thread)
            : 0, ()=>after(tellItem(record, CBEN_DELETEITEM, index, item, thread),
            ()=>held.items.length));
    };

    /**
     * The text of what the edit holds, read through its own WM_GETTEXT.
     *
     * @param {any} record @param {unknown} thread
     * @returns {string | Promise<string>}
     */
    const editText = (record, thread)=>{
        const held = state(record);
        const at = held.edit !== 0 ? host.allocate?.(CBEMAXSTRLEN) ?? 0 : 0;
        if (at === 0)
        {
            return shownText(held.editItem);
        }
        return after(host.send(held.edit, WM_GETTEXT, CBEMAXSTRLEN, at, thread), ()=>{
            const text = guest.cstr(at, CBEMAXSTRLEN);
            host.release?.(at);
            return text;
        });
    };

    /**
     * CBEM_GETITEM: the fields asked for, the ones the item left to its parent
     * asked of the parent with CBEN_GETDISPINFO first - and kept if it says so.
     *
     * @param {any} record @param {number} address @param {boolean} wide @param {unknown} thread
     */
    const getItem = (record, address, wide, thread)=>{
        const held = state(record);
        if (address === 0)
        {
            return 0;
        }
        const index = guest.iptr(address + ITEM.iItem);
        const item = index === -1 ? held.editItem : held.items[index];
        if (!item)
        {
            return 0;
        }
        const mask = guest.i32(address + ITEM.mask);
        const fields = /** @type {[number, keyof Item][]} */ ([[CBEIF_TEXT, 'text'],
            [CBEIF_IMAGE, 'image'], [CBEIF_SELECTEDIMAGE, 'selectedImage'],
            [CBEIF_OVERLAY, 'overlay'], [CBEIF_INDENT, 'indent']]);
        const asked = fields.reduce((bits, [bit, field])=>((mask & bit) !== 0
            && item[field] === CALLBACK ? bits | bit : bits), 0);
        const answer = { ...item };
        return after(asked === 0 ? 0 : askParent(record, index, item, asked, answer, thread),
            ()=>after(index === -1 && (mask & CBEIF_TEXT) !== 0 && held.edit !== 0
                ? editText(record, thread) : null, text=>{
                if (text !== null)
                {
                    answer.text = text;
                }
                if ((mask & CBEIF_TEXT) !== 0 && typeof answer.text === 'string'
                    && answer.text !== '')
                {
                    writeText(guest.ptr(address + ITEM.pszText),
                        guest.i32(address + ITEM.cchTextMax),
                        answer.text, wide);
                }
                else if ((mask & CBEIF_TEXT) !== 0 && guest.ptr(address + ITEM.pszText) !== 0)
                {
                    // No text is an empty string where the caller gave room
                    // for one (Wine's test_comboex_CB_GETLBTEXT).
                    writeText(guest.ptr(address + ITEM.pszText),
                        guest.i32(address + ITEM.cchTextMax),
                        '', wide);
                }
                if ((mask & CBEIF_IMAGE) !== 0)
                {
                    guest.set32(address + ITEM.iImage, answer.image ?? 0);
                }
                if ((mask & CBEIF_SELECTEDIMAGE) !== 0)
                {
                    guest.set32(address + ITEM.iSelectedImage, answer.selectedImage ?? 0);
                }
                if ((mask & CBEIF_OVERLAY) !== 0)
                {
                    guest.set32(address + ITEM.iOverlay, answer.overlay ?? 0);
                }
                if ((mask & CBEIF_INDENT) !== 0)
                {
                    guest.set32(address + ITEM.iIndent, answer.indent ?? 0);
                }
                if ((mask & CBEIF_LPARAM) !== 0)
                {
                    guest.setIptr(address + ITEM.lParam, answer.lParam);
                }
                return 1;
            }));
    };

    /**
     * CBEN_GETDISPINFO for the fields an item left to its parent: the text
     * into a buffer of the control's, the rest in place; what the parent
     * answers is the answer, and the item's own when it adds CBEIF_DI_SETITEM.
     *
     * @param {any} record @param {number} index @param {Item} item @param {number} asked
     * @param {Item} answer @param {unknown} thread
     */
    const askParent = (record, index, item, asked, answer, thread)=>{
        const held = state(record);
        const wide = held.unicode;
        const buffer = HEADER + ITEM.size;
        const size = buffer + CBEMAXSTRLEN * (wide ? 2 : 1);
        return notify(record, wide ? CBEN_GETDISPINFOW : CBEN_GETDISPINFOA, size, block=>{
            fillItem(block + HEADER, asked, index, item, (asked & CBEIF_TEXT) !== 0
                ? block + buffer : 0);
            guest.set32(block + HEADER + ITEM.cchTextMax, 0);
        }, thread, block=>{
            const at = block + HEADER;
            const back = guest.i32(at + ITEM.mask);
            /** @type {Item} */
            const given = { ...item };
            if ((asked & CBEIF_TEXT) !== 0)
            {
                const text = textPointer(at);
                given.text = text === 0 || text === CALLBACK ? null : readText(text, wide);
            }
            if ((asked & CBEIF_IMAGE) !== 0)
            {
                given.image = guest.i32(at + ITEM.iImage);
            }
            if ((asked & CBEIF_SELECTEDIMAGE) !== 0)
            {
                given.selectedImage = guest.i32(at + ITEM.iSelectedImage);
            }
            if ((asked & CBEIF_OVERLAY) !== 0)
            {
                given.overlay = guest.i32(at + ITEM.iOverlay);
            }
            if ((asked & CBEIF_INDENT) !== 0)
            {
                given.indent = guest.i32(at + ITEM.iIndent);
            }
            Object.assign(answer, given);
            if ((back & CBEIF_DI_SETITEM) !== 0)
            {
                Object.assign(item, given);
            }
        });
    };

    /**
     * CBEM_SETITEM: an item's fields, or with -1 the edit's - its text put in
     * the edit and selected (Wine's test_setitem_edit_seq).
     *
     * @param {any} record @param {number} address @param {boolean} wide @param {unknown} thread
     */
    const setItem = (record, address, wide, thread)=>{
        const held = state(record);
        if (address === 0)
        {
            return 0;
        }
        const index = guest.iptr(address + ITEM.iItem);
        const item = index === -1 ? held.editItem : held.items[index];
        if (!item)
        {
            return 0;
        }
        const before = shownText(item);
        const mask = store(address, item, wide);
        if (index === -1)
        {
            if ((mask & CBEIF_TEXT) === 0 || held.edit === 0)
            {
                return 1;
            }
            const edit = held.edit;
            return withString(shownText(item), at=>after(host.send(edit, WM_SETTEXT, 0, at, thread),
                ()=>after(host.send(edit, EM_SETSEL, 0, 0, thread),
                    ()=>after(host.send(edit, EM_SETSEL, 0, -1, thread), ()=>{
                        held.changed = false;
                        return 1;
                    }))));
        }
        if (shownText(item) === before || held.combo === 0)
        {
            host.invalidate(record);
            return 1;
        }
        // The combo box's copy of the text, put back where it was.
        const combo = held.combo;
        return after(host.send(combo, CB_GETCURSEL, 0, 0, thread), selected=>after(
            host.send(combo, CB_DELETESTRING, index, 0, thread), ()=>after(
                withString(shownText(item),
                    at=>host.send(combo, CB_INSERTSTRING, index, at, thread)),
                ()=>after((selected | 0) === index
                    ? host.send(combo, CB_SETCURSEL, index, 0, thread) : 0, ()=>1))));
    };

    /**
     * CBEN_ENDEDIT: the edit's text, whether it changed and the selection,
     * and why the edit ended.
     *
     * @param {any} record @param {number} why @param {unknown} thread
     */
    const endEdit = (record, why, thread)=>{
        const held = state(record);
        if (!editable(record))
        {
            return 0;
        }
        const wide = held.unicode;
        const size = HEADER + 12 + CBEMAXSTRLEN * (wide ? 2 : 1);
        return after(editText(record, thread), text=>after(held.combo !== 0
            ? host.send(held.combo, CB_GETCURSEL, 0, 0, thread) : CB_ERR, selection=>{
            const changed = held.changed;
            held.changed = false;
            return notify(record, wide ? CBEN_ENDEDITW : CBEN_ENDEDITA, size, block=>{
                guest.set32(block + HEADER, changed ? 1 : 0);
                guest.set32(block + HEADER + 4, selection);
                writeText(block + HEADER + 8, CBEMAXSTRLEN, text, wide);
                guest.set32(block + size - 4, why);
            }, thread);
        }));
    };

    /** @param {any} record  What the window's frame takes of its height. */
    const frameHeight = record=>Math.max(0, (record.height ?? 0) - host.clientSize(record).height);

    /**
     * The window made as tall as the combo box's field.
     *
     * @param {any} record
     */
    const fitHeight = record=>{
        const held = state(record);
        const combo = comboOf(record);
        if (!combo || !host.move)
        {
            return 0;
        }
        held.height = combo.height + frameHeight(record);
        return record.height === held.height ? 0
            : host.move(record.hwnd, record.x, record.y, record.width, held.height);
    };

    /**
     * Makes the combo box, as wide as the window and as tall as the list
     * drops, and subclasses it and its edit.
     *
     * @param {any} record @param {unknown} thread
     */
    const makeCombo = (record, thread)=>{
        const held = state(record);
        if (!host.popup)
        {
            return 0;
        }
        const client = host.clientSize(record);
        held.dropHeight = client.height;
        const style = (WS_CHILD | WS_VISIBLE | WS_VSCROLL | CBS_OWNERDRAWFIXED | CBS_HASSTRINGS
            | (record.style & (CBS_TYPEMASK | CBS_AUTOHSCROLL | CBS_DISABLENOSCROLL
                | CBS_NOINTEGRALHEIGHT | WS_DISABLED))) >>> 0;
        return after(host.popup('ComboBox', { x: 0, y: 0, width: client.width,
            height: client.height }, record.hwnd, 0, style, thread, record.id), hwnd=>{
            held.combo = hwnd >>> 0;
            const combo = comboOf(record);
            const edit = combo
                ? host.children(combo).find(child=>child.className === 'Edit') : null;
            held.edit = edit?.hwnd ?? 0;
            hook(record);
            return fitHeight(record);
        });
    };

    /** @type {number} */
    let editProc = 0;
    /** @type {number} */
    let comboProc = 0;

    /** @param {any} record  The combo box and its edit subclassed. */
    const hook = record=>{
        const held = state(record);
        if (!subclassing)
        {
            return;
        }
        if (held.edit !== 0)
        {
            editProc ||= subclassing.procedure('comboex edit', editMessage);
            subclassing.call('SetWindowSubclass', [held.edit, editProc, EDIT_SUBCLASS,
                record.hwnd]);
        }
        if (held.combo !== 0)
        {
            comboProc ||= subclassing.procedure('comboex combo', comboMessage);
            subclassing.call('SetWindowSubclass', [held.combo, comboProc, COMBO_SUBCLASS,
                record.hwnd]);
        }
    };

    /**
     * The edit's subclass: Enter and Escape end an edit, and so does the
     * focus leaving it with a change made.
     *
     * @param {number[]} args  The SUBCLASSPROC's: hwnd, message, wParam, lParam, id, data.
     */
    const editMessage = ([hwnd, message, wParam, lParam, id, data])=>{
        const { call, callerThread } = /** @type {import('./updown.js').Subclassing} */ (
            subclassing);
        const thread = callerThread?.();
        const control = host.live(data);
        const on = ()=>call('DefSubclassProc', [hwnd, message, wParam, lParam]);
        switch (message >>> 0){
            case WM_KEYDOWN: {
                const key = wholeAddress(wParam);
                if (control && (key === VK_RETURN || key === VK_ESCAPE))
                {
                    return after(endEdit(control, key === VK_RETURN ? CBENF_RETURN : CBENF_ESCAPE,
                        thread), on);
                }
                return on();
            }
            case WM_KILLFOCUS:
                return control && state(control).changed
                    ? after(endEdit(control, CBENF_KILLFOCUS, thread), on) : on();
            case WM_NCDESTROY:
                call('RemoveWindowSubclass', [hwnd, editProc, id]);
                return on();
            default:
                return on();
        }
    };

    /**
     * The combo box's subclass: its field drawn as it draws it, and then the
     * selected item's image beside the edit.
     *
     * @param {number[]} args  The SUBCLASSPROC's: hwnd, message, wParam, lParam, id, data.
     */
    const comboMessage = ([hwnd, message, wParam, lParam, id, data])=>{
        const { call } = /** @type {import('./updown.js').Subclassing} */ (subclassing);
        const answer = call('DefSubclassProc', [hwnd, message, wParam, lParam]);
        const control = host.live(data);
        if ((message >>> 0) === WM_NCDESTROY)
        {
            call('RemoveWindowSubclass', [hwnd, comboProc, id]);
            return answer;
        }
        if ((message >>> 0) === WM_PAINT && control)
        {
            return after(answer, result=>{
                drawEditImage(control);
                return result;
            });
        }
        return answer;
    };

    /**
     * The selected item's image at the left of a drop-down's field, where
     * the edit leaves room for it.
     *
     * @param {any} record
     */
    const drawEditImage = record=>{
        const held = state(record);
        const combo = comboOf(record);
        const size = held.imageList !== 0 ? images?.size(held.imageList) : null;
        if (!combo || !size || !editable(record) || (held.extended & CBES_EX_NOEDITIMAGE) !== 0
            || !host.draw)
        {
            return;
        }
        const selected = held.items[held.selected ?? -1];
        const image = selected?.selectedImage ?? selected?.image ?? null;
        if (image === null || image < 0)
        {
            return;
        }
        const { hdc } = host.contextOn(combo);
        try
        {
            images?.draw(held.imageList, image, hdc, IMAGE_GAP,
                Math.max(0, Math.floor((host.clientSize(combo).height - size.cy) / 2)));
        }
        finally
        {
            host.endPaint(combo, hdc);
        }
    };

    /**
     * WM_DRAWITEM from the combo box: an item's image, indented, and its text,
     * highlighted when it is selected.
     *
     * @param {any} record @param {number} address
     */
    const drawItem = (record, address)=>{
        const held = state(record);
        const draw = host.draw;
        const index = guest.i32(address + 8);
        const itemState = guest.u32(address + 16);
        const hdc = guest.u32(address + 24);
        const rect = { left: guest.i32(address + 28), top: guest.i32(address + 32),
            right: guest.i32(address + 36), bottom: guest.i32(address + 40) };
        const item = held.items[index];
        if (!draw || !item)
        {
            return 1;
        }
        const selected = (itemState & ODS_SELECTED) !== 0;
        draw.fill(hdc, rect, host.sysColor(selected ? COLOR_HIGHLIGHT : COLOR_WINDOW));
        let x = rect.left + IMAGE_GAP + ((itemState & ODS_COMBOBOXEDIT) !== 0 ? 0
            : Math.max(0, item.indent ?? 0) * INDENT_WIDTH);
        const size = held.imageList !== 0 ? images?.size(held.imageList) : null;
        const image = selected ? item.selectedImage ?? item.image : item.image;
        if (size)
        {
            if (image !== null && image >= 0)
            {
                images?.draw(held.imageList, image, hdc, x,
                    rect.top + Math.floor((rect.bottom - rect.top - size.cy) / 2));
            }
            x += size.cx + IMAGE_GAP;
        }
        tk.drawText(hdc, shownText(item), { ...rect, left: x }, DT_SINGLELINE | DT_VCENTER,
            host.sysColor(selected ? COLOR_HIGHLIGHTTEXT : COLOR_WINDOWTEXT));
        return 1;
    };

    /**
     * An item as tall as its text or its image, whichever is taller: what
     * WM_MEASUREITEM answers the combo box.
     *
     * @param {any} record @param {number} address
     */
    const measureItem = (record, address)=>{
        const held = state(record);
        const size = held.imageList !== 0 ? images?.size(held.imageList) : null;
        if (size)
        {
            guest.set32(address + 16, Math.max(guest.i32(address + 16), size.cy + 2));
        }
        return 1;
    };

    /**
     * CB_FINDSTRINGEXACT over the items: from after `start` round to it,
     * without case unless CBES_EX_CASESENSITIVE.
     *
     * @param {any} record @param {number} start @param {string} text
     */
    const findExact = (record, start, text)=>{
        const held = state(record);
        const count = held.items.length;
        const exact = (held.extended & CBES_EX_CASESENSITIVE) !== 0;
        /** @param {string} value */
        const fold = value=>(exact ? value : value.toLowerCase());
        for (let step = 1; step <= count; step++)
        {
            const index = ((start < 0 ? -1 : start) + step) % count;
            if (fold(shownText(held.items[index])) === fold(text))
            {
                return index;
            }
        }
        return CB_ERR;
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
                const to = notifyWindow(record);
                return after(to !== 0 ? host.send(to, WM_NOTIFYFORMAT, record.hwnd, NF_QUERY,
                    thread) : 0, format=>{
                    held.unicode = format === NFR_UNICODE;
                    return after(makeCombo(record, thread), ()=>tk.common(record, message,
                        thread));
                });
            }
            case WM_NOTIFYFORMAT: {
                if (lParam !== NF_REQUERY)
                {
                    return tk.common(record, message, thread);
                }
                const to = notifyWindow(record);
                return after(to !== 0 ? host.send(to, WM_NOTIFYFORMAT, record.hwnd, NF_QUERY,
                    thread) : 0, format=>{
                    held.unicode = format === NFR_UNICODE;
                    return format;
                });
            }
            case WM_WINDOWPOSCHANGING: {
                // As tall as the field, whatever it is given.
                const at = lParam + 2 * pointer;
                if (lParam !== 0 && held.height > 0 && (guest.i32(at + 16) & SWP_NOSIZE) === 0)
                {
                    guest.set32(at + 12, held.height);
                }
                return 0;
            }
            case WM_SIZE: {
                const combo = comboOf(record);
                return combo && host.move ? after(host.move(combo.hwnd, 0, 0,
                    host.clientSize(record).width, Math.max(held.dropHeight, combo.height)),
                ()=>0) : 0;
            }
            case WM_SETFOCUS:
                return held.edit !== 0 || held.combo !== 0
                    ? after(host.setFocus(held.edit || held.combo, thread), ()=>0) : 0;
            case WM_SETFONT: {
                const combo = held.combo;
                return after(combo !== 0 ? host.send(combo, WM_SETFONT, wParam, lParam, thread) : 0,
                    ()=>after(tk.common(record, message, thread), ()=>after(fitHeight(record),
                        ()=>0)));
            }
            case WM_ENABLE:
                return after(held.combo !== 0 ? host.send(held.combo, WM_ENABLE, wParam, 0,
                    thread) : 0, ()=>tk.common(record, message, thread));
            case WM_COMMAND: {
                if (lParam === 0 || lParam !== held.combo)
                {
                    return tk.common(record, message, thread);
                }
                const code = wParam >>> 16;
                const onward = ()=>{
                    const to = notifyWindow(record);
                    return to !== 0 ? host.send(to, WM_COMMAND,
                        ((code << 16) | (record.id & 0xffff)) >>> 0, record.hwnd, thread) : 0;
                };
                switch (code){
                    case CBN_EDITCHANGE:
                        held.changed = true;
                        return onward();
                    case CBN_DROPDOWN:
                        return after(endEdit(record, CBENF_DROPDOWN, thread), onward);
                    case CBN_SELCHANGE:
                        return after(host.send(held.combo, CB_GETCURSEL, 0, 0, thread), index=>{
                            held.selected = index | 0;
                            return onward();
                        });
                    case CBN_SETFOCUS:
                        return after(notify(record, CBEN_BEGINEDIT, HEADER, ()=>{}, thread),
                            onward);
                    default:
                        return onward();
                }
            }
            case WM_DRAWITEM:
                return drawItem(record, lParam);
            case WM_MEASUREITEM:
                return measureItem(record, lParam);
            case CBEM_INSERTITEMA:
            case CBEM_INSERTITEMW:
                return insertItem(record, lParam, id === CBEM_INSERTITEMW, thread);
            case CBEM_SETITEMA:
            case CBEM_SETITEMW:
                return setItem(record, lParam, id === CBEM_SETITEMW, thread);
            case CBEM_GETITEMA:
            case CBEM_GETITEMW:
                return getItem(record, lParam, id === CBEM_GETITEMW, thread);
            case CBEM_DELETEITEM:
                return deleteItem(record, message.wParam | 0, thread);
            case CBEM_GETCOMBOCONTROL:
                return held.combo;
            case CBEM_GETEDITCONTROL:
                return held.edit;
            case CBEM_SETIMAGELIST: {
                const previous = held.imageList;
                held.imageList = lParam;
                const size = lParam !== 0 ? images?.size(lParam) : null;
                host.invalidate(record);
                return after(size && held.combo !== 0 ? host.send(held.combo, CB_SETITEMHEIGHT, 0,
                    size.cy + 2, thread) : 0, ()=>previous);
            }
            case CBEM_GETIMAGELIST:
                return held.imageList;
            case CBEM_SETEXSTYLE:
            case CBEM_SETEXTENDEDSTYLE: {
                // A mask of zero changes every style, as CBEM_SETEXSTYLE does.
                const previous = held.extended;
                const mask = id === CBEM_SETEXSTYLE || wParam === 0 ? 0xffffffff : wParam;
                held.extended = ((previous & ~mask) | (lParam & mask)) >>> 0;
                host.invalidate(record);
                return previous;
            }
            case CBEM_GETEXTENDEDSTYLE:
                return held.extended;
            case CBEM_HASEDITCHANGED:
                return held.changed ? 1 : 0;
            case CBEM_SETUNICODEFORMAT: {
                const previous = held.unicode ? 1 : 0;
                held.unicode = wParam !== 0;
                return previous;
            }
            case CBEM_GETUNICODEFORMAT:
                return held.unicode ? 1 : 0;
            case CBEM_SETWINDOWTHEME:
                return 0;
            case CB_GETLBTEXT: {
                const item = held.items[message.wParam | 0];
                if (!item)
                {
                    return CB_ERR;
                }
                return writeText(lParam, 0x7fffffff, shownText(item), message.unicode === true);
            }
            case CB_GETLBTEXTLEN: {
                const item = held.items[message.wParam | 0];
                return item ? shownText(item).length : CB_ERR;
            }
            case CB_GETITEMDATA: {
                const item = held.items[message.wParam | 0];
                return item ? item.lParam : CB_ERR;
            }
            case CB_SETITEMDATA: {
                const item = held.items[message.wParam | 0];
                if (!item)
                {
                    return CB_ERR;
                }
                item.lParam = message.lParam | 0;
                return 1;
            }
            case CB_FINDSTRINGEXACT:
                return lParam === 0 ? CB_ERR : findExact(record, message.wParam | 0,
                    readText(lParam, message.unicode === true));
            case CB_RESETCONTENT: {
                /** @type {Item[]} */
                const gone = held.items.splice(0);
                /** @param {number} index @returns {any} each item's CBEN_DELETEITEM in turn */
                const tell = index=>(index >= gone.length ? 0
                    : after(tellItem(record, CBEN_DELETEITEM, index, gone[index], thread),
                        ()=>tell(index + 1)));
                return after(held.combo !== 0 ? host.send(held.combo, CB_RESETCONTENT, 0, 0,
                    thread) : 0, ()=>tell(0));
            }
            case CB_SETCURSEL:
                held.selected = message.wParam | 0;
                return held.combo !== 0 ? host.send(held.combo, id, wParam, lParam, thread)
                    : CB_ERR;
            default:
                // The rest of the combo box's messages are the combo box's.
                if (id >= CB_GETEDITSEL && id <= CB_LAST)
                {
                    return held.combo !== 0 ? host.send(held.combo, id, wParam, lParam, thread)
                        : CB_ERR;
                }
                return tk.common(record, message, thread);
        }
    };
}
