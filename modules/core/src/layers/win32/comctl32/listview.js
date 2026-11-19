/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The list view control, `SysListView32`.
 *
 * Items - a text, an image, a state, an indent and a program's own data,
 * with a text for each further column (a subitem) - shown as large icons,
 * small icons, a list, or a report whose columns are the header control the
 * list view owns. A column is the list view's and its header's at once: the
 * column's width, title and order are the header item's, and what the header
 * does to them (a divider dragged, a column clicked) comes back to the list
 * view and on to its parent.
 *
 * The parent hears of every change to an item before and after it
 * (LVN_ITEMCHANGING, which it may refuse, and LVN_ITEMCHANGED), of an insert
 * and a delete, and is asked for whatever an item keeps as a callback: a text
 * or image of LPSTR_TEXTCALLBACK / I_IMAGECALLBACK, the states named by the
 * callback mask (LVN_GETDISPINFO). A list view with LVS_OWNERDATA keeps no
 * items at all: it has a count, a selection and a focus, and asks for the
 * rest. Which spelling notifications that carry a text use is the parent's
 * answer to WM_NOTIFYFORMAT, asked when the control is made.
 *
 * Selection follows Windows' rules: one focused item at most, one selected
 * under LVS_SINGLESEL, and the selection mark where a selection was last
 * made from. What is drawn is the report and list rows and the icon grid
 * with their labels; label editing and drag images are not here yet, and the
 * first request for one says so.
 */

import { WM_CREATE, WM_PAINT, WM_ERASEBKGND, WM_LBUTTONDOWN, WM_KEYDOWN, WM_GETDLGCODE,
    WM_SETFOCUS, WM_KILLFOCUS, DLGC_WANTARROWS, DLGC_WANTCHARS, after, pointOf }
    from '../user32/controls.js';
import { notifyWindow } from './notify.js';
import { LPSTR_TEXTCALLBACK, MAX_TEXT, readText, writeText } from './strings.js';
import { HDITEM, HDM, HEADER_CLASS } from './header.js';
import { CCM_GETVERSION, CCM_SETVERSION, answerVersion } from './version.js';
import { stableSort } from './stable-sort.js';

/** The class name a program creates the control by. */
export const LISTVIEW_CLASS = 'SysListView32';

/** The atom spacing a build without a bridge gives the class's procedure. */
export const LISTVIEW_ATOM = 0x801a;

const WM_NOTIFY = 0x004e;
const WM_NOTIFYFORMAT = 0x0055;
const WM_SIZE = 0x0005;
const WM_STYLECHANGED = 0x007d;
const WM_DESTROY = 0x0002;
const NF_QUERY = 3;
const NF_REQUERY = 4;
const NFR_UNICODE = 2;
const WS_CHILD = 0x40000000;
const WS_VISIBLE = 0x10000000;
const HDS_HORZ = 0x0000;
const HDS_BUTTONS = 0x0002;
const HDS_HIDDEN = 0x0008;
const HDS_DRAGDROP = 0x0040;

/** Styles. */
export const LVS_ICON = 0x0000;
export const LVS_REPORT = 0x0001;
export const LVS_SMALLICON = 0x0002;
export const LVS_LIST = 0x0003;
const LVS_TYPEMASK = 0x0003;
export const LVS_SINGLESEL = 0x0004;
const LVS_SORTASCENDING = 0x0010;
const LVS_SORTDESCENDING = 0x0020;
export const LVS_OWNERDATA = 0x1000;
const LVS_NOCOLUMNHEADER = 0x4000;
const LVS_NOSORTHEADER = 0x8000;
const LVS_EX_HEADERDRAGDROP = 0x0010;
const LVS_EX_FULLROWSELECT = 0x0020;

const LVM_FIRST = 0x1000;
/** The messages, numbered off LVM_FIRST as commctrl.h numbers them. */
export const LVM = Object.freeze({
    GETBKCOLOR: LVM_FIRST, SETBKCOLOR: LVM_FIRST + 1, GETIMAGELIST: LVM_FIRST + 2,
    SETIMAGELIST: LVM_FIRST + 3, GETITEMCOUNT: LVM_FIRST + 4, GETITEMA: LVM_FIRST + 5,
    SETITEMA: LVM_FIRST + 6, INSERTITEMA: LVM_FIRST + 7, DELETEITEM: LVM_FIRST + 8,
    DELETEALLITEMS: LVM_FIRST + 9, GETCALLBACKMASK: LVM_FIRST + 10,
    SETCALLBACKMASK: LVM_FIRST + 11, GETNEXTITEM: LVM_FIRST + 12, FINDITEMA: LVM_FIRST + 13,
    GETITEMRECT: LVM_FIRST + 14, SETITEMPOSITION: LVM_FIRST + 15,
    GETITEMPOSITION: LVM_FIRST + 16, GETSTRINGWIDTHA: LVM_FIRST + 17, HITTEST: LVM_FIRST + 18,
    ENSUREVISIBLE: LVM_FIRST + 19, SCROLL: LVM_FIRST + 20, REDRAWITEMS: LVM_FIRST + 21,
    ARRANGE: LVM_FIRST + 22, EDITLABELA: LVM_FIRST + 23, GETEDITCONTROL: LVM_FIRST + 24,
    GETCOLUMNA: LVM_FIRST + 25, SETCOLUMNA: LVM_FIRST + 26, INSERTCOLUMNA: LVM_FIRST + 27,
    DELETECOLUMN: LVM_FIRST + 28, GETCOLUMNWIDTH: LVM_FIRST + 29,
    SETCOLUMNWIDTH: LVM_FIRST + 30, GETHEADER: LVM_FIRST + 31,
    CREATEDRAGIMAGE: LVM_FIRST + 33, GETVIEWRECT: LVM_FIRST + 34,
    GETTEXTCOLOR: LVM_FIRST + 35, SETTEXTCOLOR: LVM_FIRST + 36,
    GETTEXTBKCOLOR: LVM_FIRST + 37, SETTEXTBKCOLOR: LVM_FIRST + 38,
    GETTOPINDEX: LVM_FIRST + 39, GETCOUNTPERPAGE: LVM_FIRST + 40, GETORIGIN: LVM_FIRST + 41,
    UPDATE: LVM_FIRST + 42, SETITEMSTATE: LVM_FIRST + 43, GETITEMSTATE: LVM_FIRST + 44,
    GETITEMTEXTA: LVM_FIRST + 45, SETITEMTEXTA: LVM_FIRST + 46, SETITEMCOUNT: LVM_FIRST + 47,
    SORTITEMS: LVM_FIRST + 48, SETITEMPOSITION32: LVM_FIRST + 49,
    GETSELECTEDCOUNT: LVM_FIRST + 50, GETITEMSPACING: LVM_FIRST + 51,
    GETISEARCHSTRINGA: LVM_FIRST + 52, SETICONSPACING: LVM_FIRST + 53,
    SETEXTENDEDLISTVIEWSTYLE: LVM_FIRST + 54, GETEXTENDEDLISTVIEWSTYLE: LVM_FIRST + 55,
    GETSUBITEMRECT: LVM_FIRST + 56, SUBITEMHITTEST: LVM_FIRST + 57,
    SETCOLUMNORDERARRAY: LVM_FIRST + 58, GETCOLUMNORDERARRAY: LVM_FIRST + 59,
    SETHOTITEM: LVM_FIRST + 60, GETHOTITEM: LVM_FIRST + 61, SETHOTCURSOR: LVM_FIRST + 62,
    GETHOTCURSOR: LVM_FIRST + 63, APPROXIMATEVIEWRECT: LVM_FIRST + 64,
    SETWORKAREAS: LVM_FIRST + 65, GETSELECTIONMARK: LVM_FIRST + 66,
    SETSELECTIONMARK: LVM_FIRST + 67, SETBKIMAGEA: LVM_FIRST + 68, GETBKIMAGEA: LVM_FIRST + 69,
    GETWORKAREAS: LVM_FIRST + 70, SETHOVERTIME: LVM_FIRST + 71, GETHOVERTIME: LVM_FIRST + 72,
    GETNUMBEROFWORKAREAS: LVM_FIRST + 73, SETTOOLTIPS: LVM_FIRST + 74,
    GETITEMW: LVM_FIRST + 75, SETITEMW: LVM_FIRST + 76, INSERTITEMW: LVM_FIRST + 77,
    GETTOOLTIPS: LVM_FIRST + 78, SORTITEMSEX: LVM_FIRST + 81, FINDITEMW: LVM_FIRST + 83,
    GETSTRINGWIDTHW: LVM_FIRST + 87, GETCOLUMNW: LVM_FIRST + 95, SETCOLUMNW: LVM_FIRST + 96,
    INSERTCOLUMNW: LVM_FIRST + 97, GETITEMTEXTW: LVM_FIRST + 115,
    SETITEMTEXTW: LVM_FIRST + 116, GETISEARCHSTRINGW: LVM_FIRST + 117,
    EDITLABELW: LVM_FIRST + 118, SETBKIMAGEW: LVM_FIRST + 138, GETBKIMAGEW: LVM_FIRST + 139,
    SETSELECTEDCOLUMN: LVM_FIRST + 140, SETVIEW: LVM_FIRST + 142, GETVIEW: LVM_FIRST + 143,
    ENABLEGROUPVIEW: LVM_FIRST + 157, ISGROUPVIEWENABLED: LVM_FIRST + 175,
    GETOUTLINECOLOR: LVM_FIRST + 176, SETOUTLINECOLOR: LVM_FIRST + 177,
    ISITEMVISIBLE: LVM_FIRST + 182, GETSELECTEDCOLUMN: LVM_FIRST + 174,
});
const CCM_SETUNICODEFORMAT = 0x2005;
const CCM_GETUNICODEFORMAT = 0x2006;

/** LVITEM, the same shape in both spellings: only the text differs. */
export const LVITEM = Object.freeze({ mask: 0, iItem: 4, iSubItem: 8, state: 12, stateMask: 16,
    pszText: 20, cchTextMax: 24, iImage: 28, lParam: 32, iIndent: 36, SIZE: 60 });
export const LVIF_TEXT = 0x0001;
export const LVIF_IMAGE = 0x0002;
export const LVIF_PARAM = 0x0004;
export const LVIF_STATE = 0x0008;
export const LVIF_INDENT = 0x0010;
const LVIF_DI_SETITEM = 0x1000;
export const LVIS_FOCUSED = 0x0001;
export const LVIS_SELECTED = 0x0002;
const I_IMAGECALLBACK = -1;

/** LVCOLUMN, the same shape in both spellings. */
export const LVCOLUMN = Object.freeze({ mask: 0, fmt: 4, cx: 8, pszText: 12, cchTextMax: 16,
    iSubItem: 20, iImage: 24, iOrder: 28, cxMin: 32, SIZE: 44 });
export const LVCF_FMT = 0x0001;
export const LVCF_WIDTH = 0x0002;
export const LVCF_TEXT = 0x0004;
export const LVCF_SUBITEM = 0x0008;
const LVCF_IMAGE = 0x0010;
const LVCF_ORDER = 0x0020;
const LVCF_MINWIDTH = 0x0040;
const LVCFMT_JUSTIFYMASK = 0x0003;
const LVSCW_AUTOSIZE = -1;
const LVSCW_AUTOSIZE_USEHEADER = -2;

/** GETNEXTITEM's flags. */
const LVNI_FOCUSED = 0x0001;
const LVNI_SELECTED = 0x0002;
const LVNI_CUT = 0x0004;
const LVNI_DROPHILITED = 0x0008;
const LVNI_STATEMASK = LVNI_FOCUSED | LVNI_SELECTED | LVNI_CUT | LVNI_DROPHILITED;
const LVNI_ABOVE = 0x0100;
const LVNI_BELOW = 0x0200;
const LVNI_TOLEFT = 0x0400;
const LVNI_TORIGHT = 0x0800;

/** LVFINDINFO: its flags, the string, lParam, a point and a direction. */
const FINDINFO = Object.freeze({ flags: 0, psz: 4, lParam: 8 });
const LVFI_PARAM = 0x0001;
const LVFI_STRING = 0x0002;
const LVFI_SUBSTRING = 0x0004;
const LVFI_PARTIAL = 0x0008;
const LVFI_WRAP = 0x0020;

/** LVHITTESTINFO: the point, the flags, the item, the subitem. */
const HITTEST = Object.freeze({ x: 0, y: 4, flags: 8, iItem: 12, iSubItem: 16 });
const LVHT_NOWHERE = 0x0001;
const LVHT_ONITEMICON = 0x0002;
const LVHT_ONITEMLABEL = 0x0004;
const LVHT_ABOVE = 0x0008;
const LVHT_BELOW = 0x0010;
const LVHT_TORIGHT = 0x0020;
const LVHT_TOLEFT = 0x0040;
/** On the state icon: the same bit as LVHT_ABOVE, answered only on an item. */
const LVHT_ONITEMSTATEICON = 0x0008;
const LVHT_ONITEM = LVHT_ONITEMICON | LVHT_ONITEMLABEL | LVHT_ONITEMSTATEICON;

/** GETITEMRECT's portions. */
const LVIR_ICON = 1;
const LVIR_LABEL = 2;

/** The notifications, and NMLISTVIEW and NMLVDISPINFO after their NMHDR. */
const LVN_ITEMCHANGING = -100;
const LVN_ITEMCHANGED = -101;
const LVN_INSERTITEM = -102;
const LVN_DELETEITEM = -103;
const LVN_DELETEALLITEMS = -104;
const LVN_COLUMNCLICK = -108;
const LVN_GETDISPINFOA = -150;
const LVN_GETDISPINFOW = -177;
const LVN_ODFINDITEMA = -152;
const LVN_ODFINDITEMW = -179;
const LVN_ODSTATECHANGED = -115;
/** NMLVODSTATECHANGE after its NMHDR: the range and its new and old states. */
const ODSTATECHANGE = Object.freeze({ iFrom: 12, iTo: 16, uNewState: 20, uOldState: 24,
    SIZE: 28 });
const NMLISTVIEW = Object.freeze({ iItem: 12, iSubItem: 16, uNewState: 20, uOldState: 24,
    uChanged: 28, x: 32, y: 36, lParam: 40, SIZE: 44 });
const DISPINFO_ITEM = 12;
const DISPINFO_SIZE = 12 + LVITEM.SIZE;
/** NMLVFINDITEM after its NMHDR: where to start, then the LVFINDINFO. */
const FINDITEM_START = 12;
const FINDITEM_INFO = 16;
const FINDITEM_SIZE = 16 + 24;
/** What the header tells its parent and the list view passes on. */
const HDN_ITEMCHANGEDA = -301;
const HDN_ITEMCHANGEDW = -321;
const HDN_ITEMCLICKA = -302;
const HDN_ITEMCLICKW = -322;
/** NMHEADER after its NMHDR: the item. */
const NMHEADER_ITEM = 12;

/** NM_CUSTOMDRAW: NMLVCUSTOMDRAW after its NMHDR, the stages, item states and answers. */
const NM_CUSTOMDRAW = -12;
/** SetBkMode's TRANSPARENT. */
const TRANSPARENT = 1;
const CUSTOMDRAW = Object.freeze({ dwDrawStage: 12, hdc: 16, rc: 20, dwItemSpec: 36,
    uItemState: 40, lItemlParam: 44, clrText: 48, clrTextBk: 52, iSubItem: 56, SIZE: 104 });
const CDDS_PREPAINT = 0x00001;
const CDDS_POSTPAINT = 0x00002;
const CDDS_ITEMPREPAINT = 0x10001;
const CDDS_ITEMPOSTPAINT = 0x10002;
const CDDS_SUBITEM = 0x20000;
const CDIS_SELECTED = 0x0001;
const CDIS_FOCUS = 0x0010;
const CDRF_SKIPDEFAULT = 0x04;
const CDRF_NOTIFYPOSTPAINT = 0x10;
const CDRF_NOTIFYITEMDRAW = 0x20;
const CDRF_NOTIFYSUBITEMDRAW = 0x20;

/** Colours, and the one a colour of "none" reads back as. */
const CLR_NONE = 0xffffffff;
const CLR_DEFAULT = 0xff000000;
const COLOR_WINDOW = 5;
const COLOR_WINDOWTEXT = 8;
const COLOR_HIGHLIGHT = 13;
const COLOR_HIGHLIGHTTEXT = 14;

/** The geometry a list view lays out with, until it measures its font. */
const ICON_SIZE = 32;
const SMALL_ICON_SIZE = 16;
const ICON_SPACING = Object.freeze({ x: 75, y: 70 });
const LIST_COLUMN_WIDTH = 96;
const LABEL_MARGIN = 2;
const DEFAULT_COLUMN_WIDTH = 0;
const HOVER_DEFAULT = -1;
const DT_LEFT = 0x0000;
const DT_CENTER = 0x0001;
const DT_RIGHT = 0x0002;
const DT_VCENTER = 0x0004;
const DT_SINGLELINE = 0x0020;
const DT_END_ELLIPSIS = 0x8000;
const VK_UP = 0x26;
const VK_DOWN = 0x28;
const VK_HOME = 0x24;
const VK_END = 0x23;
const VK_SHIFT = 0x10;
const VK_CONTROL = 0x11;

/**
 * @typedef {Object} ListItem
 * @property {(string | null)[]} texts  per subitem; null for LPSTR_TEXTCALLBACK
 * @property {number[]} images  per subitem
 * @property {number} state
 * @property {number} lParam
 * @property {number} indent
 * @property {{ x: number, y: number } | null} position
 *
 * @typedef {Object} Column
 * @property {number} fmt
 * @property {number} width
 * @property {string} text
 * @property {number} subItem
 * @property {number} image
 * @property {number} minWidth
 */

/**
 * Builds the window procedure of a list view.
 *
 * @param {import('../user32/controls.js').ControlHost} host
 * @param {any} tk  The drawing helpers the system classes share.
 * @param {(hdc: number, mode: number) => number} [setBkMode]  gdi32's.
 */
export function createListViewProcedure(host, tk, setBkMode){
    let toldEdit = false;
    /** @param {string} what */
    const notHere = what=>{
        if (!toldEdit)
        {
            toldEdit = true;
            host.divergence?.(LISTVIEW_CLASS, `${what} is not here yet`);
        }
    };
    /** @param {number} at */
    const read32 = at=>{
        const b = host.readMemory(at >>> 0, 4);
        return (b[0] | b[1] << 8 | b[2] << 16 | b[3] << 24) >>> 0;
    };
    /** @param {number} at @param {number} value */
    const write32 = (at, value)=>{
        const v = value >>> 0;
        host.writeMemory(at >>> 0,
            Uint8Array.of(v & 0xff, v >>> 8 & 0xff, v >>> 16 & 0xff, v >>> 24));
    };

    /** @param {any} record */
    const state = record=>{
        const held = tk.stateOf(record);
        /** @type {ListItem[]} */
        held.items ??= [];
        /** @type {Column[]} */
        held.columns ??= [];
        held.count ??= 0;
        held.unicode ??= true;
        held.images ??= [0, 0, 0];
        held.callbackMask ??= 0;
        held.extended ??= 0;
        held.background ??= host.sysColor(COLOR_WINDOW);
        held.textColor ??= host.sysColor(COLOR_WINDOWTEXT);
        held.textBackground ??= CLR_DEFAULT;
        held.outline ??= 0;
        held.mark ??= -1;
        held.hot ??= -1;
        held.hover ??= HOVER_DEFAULT;
        held.header ??= 0;
        held.headerHeight ??= 0;
        held.top ??= 0;
        held.scroll ??= { x: 0, y: 0 };
        held.iconSpacing ??= { ...ICON_SPACING };
        held.listWidth ??= LIST_COLUMN_WIDTH;
        held.selectedColumn ??= -1;
        held.tooltips ??= 0;
        return held;
    };

    /** @param {any} record */
    const ownerData = record=>(record.style & LVS_OWNERDATA) !== 0;
    /** @param {any} record */
    const count = record=>(ownerData(record) ? state(record).count : state(record).items.length);
    /** @param {any} record */
    const view = record=>state(record).view ?? record.style & LVS_TYPEMASK;
    /**
     * An item's state as a program reads it. An owner-data list keeps only
     * its focus and selection; the rest is the parent's.
     *
     * @param {any} record @param {number} index
     */
    const stateOf = (record, index)=>{
        const held = state(record);
        if (ownerData(record))
        {
            return (held.selected?.has(index) ? LVIS_SELECTED : 0)
                | (held.focus === index ? LVIS_FOCUSED : 0);
        }
        return held.items[index].state;
    };

    /**
     * Sends WM_NOTIFY to the parent, the structure in guest memory for as
     * long as the message is answered; `read` takes what the parent left
     * in it.
     *
     * @template T
     * @param {any} record @param {number} code @param {number} size
     * @param {(block: number) => void} fill @param {unknown} thread
     * @param {(block: number, answer: number) => T} [read]
     * @returns {number | T | Promise<number | T>}
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
     * An NMLISTVIEW notification about one item.
     *
     * @param {any} record @param {number} code @param {number} index
     * @param {{ subItem?: number, newState?: number, oldState?: number, changed?: number,
     *     lParam?: number }} what
     * @param {unknown} thread
     */
    const tellItem = (record, code, index, what, thread)=>notify(record, code, NMLISTVIEW.SIZE,
        block=>{
            write32(block + NMLISTVIEW.iItem, index);
            write32(block + NMLISTVIEW.iSubItem, what.subItem ?? 0);
            write32(block + NMLISTVIEW.uNewState, what.newState ?? 0);
            write32(block + NMLISTVIEW.uOldState, what.oldState ?? 0);
            write32(block + NMLISTVIEW.uChanged, what.changed ?? 0);
            write32(block + NMLISTVIEW.lParam, what.lParam ?? 0);
        }, thread);

    /**
     * Asks the parent for what an item keeps as a callback: LVN_GETDISPINFO
     * with the mask of what is wanted, and the answer's text, image and state.
     *
     * The text is asked into the caller's own buffer where there is one -
     * the parent fills what the program handed - else into one of the
     * control's.
     *
     * @param {any} record @param {number} index @param {number} subItem @param {number} mask
     * @param {number} stateMask @param {unknown} thread
     * @param {{ buffer: number, room: number }} [given]
     * @returns {Promise<{ text: string, image: number, state: number, indent: number,
     *     keep: boolean }> | { text: string, image: number, state: number, indent: number,
     *     keep: boolean }}
     */
    const askDisplay = (record, index, subItem, mask, stateMask, thread, given)=>{
        const held = state(record);
        const wide = held.unicode;
        const own = mask & LVIF_TEXT && !given?.buffer ? host.allocate?.(MAX_TEXT * 2) ?? 0 : 0;
        const buffer = given?.buffer || own;
        const room = given?.buffer ? given.room : MAX_TEXT;
        if (own !== 0)
        {
            host.writeMemory(own, new Uint8Array(2));
        }
        const item = ownerData(record) ? null : held.items[index];
        const answer = notify(record, wide ? LVN_GETDISPINFOW : LVN_GETDISPINFOA, DISPINFO_SIZE,
            block=>{
                const at = block + DISPINFO_ITEM;
                write32(at + LVITEM.mask, mask);
                write32(at + LVITEM.iItem, index);
                write32(at + LVITEM.iSubItem, subItem);
                write32(at + LVITEM.stateMask, stateMask);
                write32(at + LVITEM.pszText, buffer);
                write32(at + LVITEM.cchTextMax, buffer !== 0 ? room : 0);
                write32(at + LVITEM.lParam, item?.lParam ?? 0);
            }, thread, block=>{
                const at = block + DISPINFO_ITEM;
                const pointer = read32(at + LVITEM.pszText);
                return {
                    text: mask & LVIF_TEXT && pointer !== 0 && pointer !== LPSTR_TEXTCALLBACK
                        ? readText(host, pointer, wide) : '',
                    image: read32(at + LVITEM.iImage) | 0,
                    state: read32(at + LVITEM.state) & stateMask,
                    indent: read32(at + LVITEM.iIndent) | 0,
                    keep: (read32(at + LVITEM.mask) & LVIF_DI_SETITEM) !== 0,
                };
            });
        return after(answer, got=>{
            if (own !== 0)
            {
                host.release?.(own);
            }
            return typeof got === 'number'
                ? { text: '', image: 0, state: 0, indent: 0, keep: false } : got;
        });
    };

    // --- The header: the columns' titles, widths and order ------------------

    /**
     * Sends the header a message with an HDITEM made from a column, the text
     * in guest memory for the call.
     *
     * @param {any} record @param {number} message @param {number} index
     * @param {number} mask @param {Partial<Column> & { order?: number }} column
     * @param {unknown} thread
     */
    const headerItem = (record, message, index, mask, column, thread)=>{
        const held = state(record);
        if (held.header === 0)
        {
            return 0;
        }
        const text = column.text ?? '';
        const block = host.allocate?.(HDITEM.SIZE + (text.length + 1) * 2) ?? 0;
        if (block === 0)
        {
            return 0;
        }
        host.writeMemory(block, new Uint8Array(HDITEM.SIZE));
        let hdMask = 0;
        if (mask & LVCF_WIDTH)
        {
            hdMask |= 0x0001;
            write32(block + HDITEM.cxy, column.width ?? 0);
        }
        if (mask & LVCF_TEXT)
        {
            hdMask |= 0x0002;
            writeText(host, block + HDITEM.SIZE, text, true, text.length + 1);
            write32(block + HDITEM.pszText, block + HDITEM.SIZE);
        }
        if (mask & LVCF_FMT)
        {
            hdMask |= 0x0004;
            write32(block + HDITEM.fmt, (column.fmt ?? 0) & LVCFMT_JUSTIFYMASK | 0x4000);
        }
        if (mask & LVCF_ORDER)
        {
            hdMask |= 0x0080;
            write32(block + HDITEM.iOrder, column.order ?? 0);
        }
        write32(block + HDITEM.mask, hdMask);
        const wide = message === HDM.INSERTITEMA ? HDM.INSERTITEMW
            : message === HDM.SETITEMA ? HDM.SETITEMW : message;
        return after(host.send(held.header, wide, index, block, thread), answer=>{
            host.release?.(block);
            return answer;
        });
    };

    /**
     * The display order of the columns, as the header keeps it.
     *
     * @param {any} record @param {unknown} thread
     * @returns {number[] | Promise<number[]>}
     */
    const columnOrder = (record, thread)=>{
        const held = state(record);
        const columns = held.columns.length;
        if (held.header === 0 || columns === 0)
        {
            return held.columns.map((/** @type {Column} */ _, /** @type {number} */ i)=>i);
        }
        const block = host.allocate?.(columns * 4) ?? 0;
        if (block === 0)
        {
            return held.columns.map((/** @type {Column} */ _, /** @type {number} */ i)=>i);
        }
        return after(host.send(held.header, HDM.GETORDERARRAY, columns, block, thread), ()=>{
            const order = Array.from({ length: columns }, (_, i)=>read32(block + i * 4) | 0);
            host.release?.(block);
            return order;
        });
    };

    // --- Geometry ------------------------------------------------------------

    /** The height of a row: the font's, or the small icons', whichever is taller. @param {any} record */
    const rowHeight = record=>{
        const held = state(record);
        if (held.rowHeight !== undefined)
        {
            return held.rowHeight;
        }
        const { hdc } = host.contextOn(record);
        const font = hdc !== 0 && host.draw ? host.draw.measure(hdc, 'M').height : 13;
        host.endPaint(record, hdc);
        held.rowHeight = Math.max(font + LABEL_MARGIN, held.images[1] !== 0 ? SMALL_ICON_SIZE : 0);
        return held.rowHeight;
    };

    /** The width of the report's columns together. @param {any} record */
    const reportWidth = record=>state(record).columns
        .reduce((/** @type {number} */ total, /** @type {Column} */ column)=>
            total + Math.max(0, column.width), 0);

    /**
     * An item's bounding rectangle in client coordinates, in its view.
     *
     * @param {any} record @param {number} index
     */
    const bounds = (record, index)=>{
        const held = state(record);
        const height = rowHeight(record);
        const size = host.clientSize(record);
        switch (view(record))
        {
            case LVS_REPORT: {
                const top = held.headerHeight + (index - held.top) * height;
                return { left: -held.scroll.x, top, right: reportWidth(record) - held.scroll.x,
                    bottom: top + height };
            }
            case LVS_LIST: {
                const perColumn = Math.max(1, Math.floor(size.height / height));
                const column = Math.floor(index / perColumn);
                const left = column * held.listWidth - held.scroll.x;
                const top = index % perColumn * height;
                return { left, top, right: left + held.listWidth, bottom: top + height };
            }
            default: {
                const item = ownerData(record) ? null : held.items[index];
                const spacing = view(record) === LVS_SMALLICON
                    ? { x: held.iconSpacing.x + SMALL_ICON_SIZE, y: height }
                    : held.iconSpacing;
                const perRow = Math.max(1, Math.floor(size.width / spacing.x));
                const x = item?.position?.x ?? index % perRow * spacing.x;
                const y = item?.position?.y ?? Math.floor(index / perRow) * spacing.y;
                return { left: x - held.scroll.x, top: y - held.scroll.y,
                    right: x - held.scroll.x + spacing.x, bottom: y - held.scroll.y + spacing.y };
            }
        }
    };

    /**
     * The part of an item a rectangle asks for: the whole, its icon, its label.
     *
     * @param {any} record @param {number} index @param {number} portion
     */
    const itemRect = (record, index, portion)=>{
        const box = bounds(record, index);
        const icon = view(record) === LVS_ICON ? ICON_SIZE : SMALL_ICON_SIZE;
        const hasIcon = view(record) === LVS_ICON || state(record).images[1] !== 0;
        if (view(record) === LVS_ICON)
        {
            const iconBox = { left: box.left + (box.right - box.left - icon) / 2 | 0,
                top: box.top, right: 0, bottom: box.top + icon };
            iconBox.right = iconBox.left + icon;
            if (portion === LVIR_ICON)
            {
                return iconBox;
            }
            if (portion === LVIR_LABEL)
            {
                return { left: box.left, top: iconBox.bottom, right: box.right,
                    bottom: box.bottom };
            }
            return box;
        }
        const iconRight = box.left + (hasIcon ? icon : 0);
        const first = view(record) === LVS_REPORT && state(record).columns.length > 0
            ? box.left + Math.max(0, state(record).columns[0].width) : box.right;
        if (portion === LVIR_ICON)
        {
            return { left: box.left, top: box.top, right: iconRight, bottom: box.bottom };
        }
        if (portion === LVIR_LABEL)
        {
            return { left: iconRight, top: box.top, right: first, bottom: box.bottom };
        }
        return box;
    };

    /**
     * The item at a client point, and what of it.
     *
     * @param {any} record @param {number} x @param {number} y
     * @returns {{ index: number, flags: number }}
     */
    const hitTest = (record, x, y)=>{
        const size = host.clientSize(record);
        let flags = 0;
        if (y < 0)
        {
            flags |= LVHT_ABOVE;
        }
        else if (y >= size.height)
        {
            flags |= LVHT_BELOW;
        }
        if (x < 0)
        {
            flags |= LVHT_TOLEFT;
        }
        else if (x >= size.width)
        {
            flags |= LVHT_TORIGHT;
        }
        if (flags !== 0)
        {
            return { index: -1, flags };
        }
        // In the report view an item is its first column, or its whole row
        // with LVS_EX_FULLROWSELECT, whose other columns answer the whole item.
        const report = view(record) === LVS_REPORT;
        const fullRow = report && (state(record).extended & LVS_EX_FULLROWSELECT) !== 0;
        for (let index = 0; index < count(record); index++)
        {
            const box = bounds(record, index);
            const first = report && state(record).columns.length > 0
                ? box.left + Math.max(0, state(record).columns[0].width) : box.right;
            const right = fullRow ? box.right : first;
            if (x >= box.left && x < right && y >= box.top && y < box.bottom)
            {
                return { index, flags: x >= first ? LVHT_ONITEM
                    : firstColumnPart(record, index, x, y) };
            }
        }
        return { index: -1, flags: LVHT_NOWHERE };
    };

    /**
     * Which part of an item's first column a point is on: the state icon,
     * when the list has state images, then the icon, then the label.
     *
     * @param {any} record @param {number} index @param {number} x @param {number} y
     */
    const firstColumnPart = (record, index, x, y)=>{
        const held = state(record);
        const left = bounds(record, index).left;
        const stateRoom = view(record) !== LVS_ICON && held.images[2] !== 0 ? SMALL_ICON_SIZE : 0;
        if (x < left + stateRoom)
        {
            return LVHT_ONITEMSTATEICON;
        }
        const icon = itemRect(record, index, LVIR_ICON);
        const iconLeft = icon.left + stateRoom;
        const iconRight = icon.right + stateRoom;
        return iconRight > iconLeft && x >= iconLeft && x < iconRight && y >= icon.top
            && y < icon.bottom ? LVHT_ONITEMICON : LVHT_ONITEMLABEL;
    };

    /**
     * LVM_SUBITEMHITTEST in the report view: the column under the point,
     * whatever the client's size, and the row its height counts from the
     * first item's top, truncated toward zero - so a point in the header's
     * band is the first row's, the row just above is no item, and rows
     * further up answer negative indices, as Windows' own arithmetic does.
     * A point outside every column is nothing.
     *
     * @param {any} record @param {number} x @param {number} y
     * @returns {{ index: number, subItem: number, flags: number }}
     */
    const subItemHitTest = (record, x, y)=>{
        const held = state(record);
        let left = -held.scroll.x;
        let subItem = -1;
        held.columns.forEach((/** @type {Column} */ column, /** @type {number} */ c)=>{
            const width = Math.max(0, column.width);
            if (subItem === -1 && x >= left && x < left + width)
            {
                subItem = c;
            }
            left += width;
        });
        if (subItem === -1)
        {
            return { index: -1, subItem: -1, flags: LVHT_NOWHERE };
        }
        const row = Math.trunc((y - held.headerHeight) / rowHeight(record)) + held.top;
        if (row === -1 || row >= count(record))
        {
            return { index: -1, subItem, flags: LVHT_NOWHERE };
        }
        const flags = subItem === 0 && row >= 0
            ? firstColumnPart(record, row, x, bounds(record, row).top) : LVHT_ONITEMLABEL;
        return { index: row, subItem, flags };
    };

    // --- Items -----------------------------------------------------------------

    /** @returns {ListItem} */
    const newItem = ()=>({ texts: [''], images: [0], state: 0, lParam: 0, indent: 0,
        position: null });

    /**
     * Reads an LVITEM's text: a string, or null for the callback.
     *
     * @param {number} info @param {boolean} wide
     */
    const textIn = (info, wide)=>{
        const pointer = read32(info + LVITEM.pszText);
        return pointer === LPSTR_TEXTCALLBACK ? null
            : pointer === 0 ? '' : readText(host, pointer, wide);
    };

    /**
     * Changes an item's state, telling the parent before and after; the
     * parent's TRUE to LVN_ITEMCHANGING leaves it as it was. What changes is
     * the bits `mask` names; nothing told when nothing changes.
     *
     * @param {any} record @param {number} index @param {number} value @param {number} mask
     * @param {unknown} thread
     * @returns {Promise<boolean>}
     */
    const setState = async(record, index, value, mask, thread)=>{
        const held = state(record);
        const old = stateOf(record, index);
        const next = old & ~mask | value & mask;
        if (next === old)
        {
            return true;
        }
        const lParam = ownerData(record) ? 0 : held.items[index].lParam;
        if (!ownerData(record))
        {
            const refused = await tellItem(record, LVN_ITEMCHANGING, index, { newState: next,
                oldState: old, changed: LVIF_STATE, lParam }, thread);
            if (refused !== 0)
            {
                return false;
            }
        }
        await yieldState(record, index, next & ~old, thread);
        if (ownerData(record))
        {
            held.selected ??= new Set();
            if (next & LVIS_SELECTED)
            {
                held.selected.add(index);
            }
            else
            {
                held.selected.delete(index);
            }
            if (next & LVIS_FOCUSED)
            {
                held.focus = index;
            }
            else if (held.focus === index)
            {
                held.focus = -1;
            }
        }
        else
        {
            held.items[index].state = next;
        }
        // The mark follows the focus, not the selection: an item that takes
        // the focus becomes the mark when there is none (Wine's listview.c
        // test_multiselect, Windows' answers).
        if (next & LVIS_FOCUSED && !(old & LVIS_FOCUSED))
        {
            held.mark = held.mark < 0 ? index : held.mark;
        }
        await tellItem(record, LVN_ITEMCHANGED, index, { newState: next, oldState: old,
            changed: LVIF_STATE, lParam }, thread);
        host.invalidate(record);
        return true;
    };

    /**
     * One focused item, and one selected under LVS_SINGLESEL: an item taking
     * one takes it from whoever had it, told as that item's own change.
     *
     * @param {any} record @param {number} index @param {number} taken  the bits it gains
     * @param {unknown} thread
     */
    const yieldState = async(record, index, taken, thread)=>{
        if (taken & LVIS_FOCUSED)
        {
            const was = focusedItem(record);
            if (was >= 0 && was !== index)
            {
                await setState(record, was, 0, LVIS_FOCUSED, thread);
            }
        }
        if (taken & LVIS_SELECTED && record.style & LVS_SINGLESEL)
        {
            for (let other = 0; other < count(record); other++)
            {
                if (other !== index && stateOf(record, other) & LVIS_SELECTED)
                {
                    await setState(record, other, 0, LVIS_SELECTED, thread);
                }
            }
        }
    };

    /**
     * Takes the selection from every item but `keep`. An owner-data list does
     * it at once, told as one change to item -1.
     *
     * @param {any} record @param {number} keep @param {unknown} thread
     */
    const deselectOthers = async(record, keep, thread)=>{
        const held = state(record);
        if (ownerData(record))
        {
            const had = [...held.selected ?? []].filter(i=>i !== keep);
            if (had.length === 0)
            {
                return;
            }
            held.selected = new Set(held.selected?.has(keep) ? [keep] : []);
            await tellItem(record, LVN_ITEMCHANGED, -1, { newState: 0, oldState: LVIS_SELECTED,
                changed: LVIF_STATE }, thread);
            host.invalidate(record);
            return;
        }
        for (let other = 0; other < count(record); other++)
        {
            if (other !== keep && stateOf(record, other) & LVIS_SELECTED)
            {
                await setState(record, other, 0, LVIS_SELECTED, thread);
            }
        }
    };

    /**
     * Selects a range of an owner-data list at once: LVN_ODSTATECHANGED from
     * its first item to its last.
     *
     * @param {any} record @param {number} low @param {number} high @param {unknown} thread
     */
    const selectRange = async(record, low, high, thread)=>{
        const held = state(record);
        held.selected ??= new Set();
        for (let index = low; index <= high; index++)
        {
            held.selected.add(index);
        }
        await notify(record, LVN_ODSTATECHANGED, ODSTATECHANGE.SIZE, block=>{
            write32(block + ODSTATECHANGE.iFrom, low);
            write32(block + ODSTATECHANGE.iTo, high);
            write32(block + ODSTATECHANGE.uNewState, LVIS_SELECTED);
        }, thread);
        host.invalidate(record);
    };

    /** @param {any} record */
    const focusedItem = record=>{
        for (let index = 0; index < count(record); index++)
        {
            if (stateOf(record, index) & LVIS_FOCUSED)
            {
                return index;
            }
        }
        return -1;
    };

    /**
     * Sets what an LVITEM names on an item or subitem, the state through
     * setState; the parent hears of a change to anything else as one change.
     *
     * @param {any} record @param {number} info @param {boolean} wide @param {unknown} thread
     */
    const setItem = async(record, info, wide, thread)=>{
        const held = state(record);
        const index = read32(info + LVITEM.iItem) | 0;
        const subItem = read32(info + LVITEM.iSubItem) | 0;
        const mask = read32(info + LVITEM.mask);
        if (index < 0 || index >= count(record) || subItem < 0)
        {
            return 0;
        }
        if (ownerData(record))
        {
            // An owner-data list keeps nothing but its selection and focus.
            if (mask & LVIF_STATE && subItem === 0)
            {
                await setState(record, index, read32(info + LVITEM.state),
                    read32(info + LVITEM.stateMask), thread);
            }
            return 1;
        }
        const item = held.items[index];
        let changed = 0;
        if (mask & LVIF_TEXT && (item.texts[subItem] ?? '') !== textIn(info, wide))
        {
            changed |= LVIF_TEXT;
        }
        if (mask & LVIF_IMAGE && (item.images[subItem] ?? 0) !== (read32(info + LVITEM.iImage) | 0))
        {
            changed |= LVIF_IMAGE;
        }
        if (mask & LVIF_PARAM && subItem === 0 && item.lParam !== read32(info + LVITEM.lParam))
        {
            changed |= LVIF_PARAM;
        }
        if (mask & LVIF_INDENT && subItem === 0
            && item.indent !== (read32(info + LVITEM.iIndent) | 0))
        {
            changed |= LVIF_INDENT;
        }
        if (changed !== 0)
        {
            const refused = await tellItem(record, LVN_ITEMCHANGING, index,
                { subItem, changed, lParam: item.lParam, oldState: item.state,
                    newState: item.state }, thread);
            if (refused !== 0)
            {
                return 0;
            }
            if (changed & LVIF_TEXT)
            {
                item.texts[subItem] = textIn(info, wide);
            }
            if (changed & LVIF_IMAGE)
            {
                item.images[subItem] = read32(info + LVITEM.iImage) | 0;
            }
            if (changed & LVIF_PARAM)
            {
                item.lParam = read32(info + LVITEM.lParam);
            }
            if (changed & LVIF_INDENT)
            {
                item.indent = read32(info + LVITEM.iIndent) | 0;
            }
            await tellItem(record, LVN_ITEMCHANGED, index, { subItem, changed,
                lParam: item.lParam, oldState: item.state, newState: item.state }, thread);
            host.invalidate(record);
        }
        if (mask & LVIF_STATE && subItem === 0)
        {
            const done = await setState(record, index, read32(info + LVITEM.state),
                read32(info + LVITEM.stateMask), thread);
            return done ? 1 : 0;
        }
        return 1;
    };

    /**
     * Fills an LVITEM's fields its mask asks for, asking the parent for the
     * callbacks.
     *
     * @param {any} record @param {number} info @param {boolean} wide @param {unknown} thread
     */
    const getItem = async(record, info, wide, thread)=>{
        const held = state(record);
        const index = read32(info + LVITEM.iItem) | 0;
        const subItem = read32(info + LVITEM.iSubItem) | 0;
        const mask = read32(info + LVITEM.mask);
        if (index < 0 || index >= count(record) || subItem < 0)
        {
            return 0;
        }
        const item = ownerData(record) ? null : held.items[index];
        const textCallback = mask & LVIF_TEXT && (item === null || item.texts[subItem] === null);
        const imageCallback = mask & LVIF_IMAGE
            && (item === null || (item.images[subItem] ?? 0) === I_IMAGECALLBACK);
        const stateMask = read32(info + LVITEM.stateMask);
        const stateCallback = mask & LVIF_STATE && subItem === 0
            ? (item === null ? stateMask & ~(LVIS_FOCUSED | LVIS_SELECTED)
                : stateMask & held.callbackMask) : 0;
        const indentCallback = mask & LVIF_INDENT && item === null;
        const askMask = (textCallback ? LVIF_TEXT : 0) | (imageCallback ? LVIF_IMAGE : 0)
            | (stateCallback ? LVIF_STATE : 0) | (indentCallback ? LVIF_INDENT : 0);
        const asked = askMask !== 0
            ? await askDisplay(record, index, subItem, askMask, stateCallback, thread,
                textCallback ? { buffer: read32(info + LVITEM.pszText),
                    room: read32(info + LVITEM.cchTextMax) | 0 } : undefined) : null;
        if (asked?.keep && item !== null)
        {
            if (textCallback)
            {
                item.texts[subItem] = asked.text;
            }
            if (imageCallback)
            {
                item.images[subItem] = asked.image;
            }
        }
        if (mask & LVIF_TEXT)
        {
            const text = textCallback ? asked?.text ?? '' : item?.texts[subItem] ?? '';
            writeText(host, read32(info + LVITEM.pszText), text, wide,
                read32(info + LVITEM.cchTextMax) | 0);
        }
        if (mask & LVIF_IMAGE)
        {
            write32(info + LVITEM.iImage, imageCallback ? asked?.image ?? 0
                : item?.images[subItem] ?? 0);
        }
        if (mask & LVIF_PARAM && subItem === 0)
        {
            write32(info + LVITEM.lParam, item?.lParam ?? 0);
        }
        if (mask & LVIF_INDENT && subItem === 0)
        {
            write32(info + LVITEM.iIndent, indentCallback ? asked?.indent ?? 0
                : item?.indent ?? 0);
        }
        if (mask & LVIF_STATE)
        {
            const own = subItem === 0 ? stateOf(record, index) & ~stateCallback : 0;
            write32(info + LVITEM.state, (own | (asked?.state ?? 0)) & stateMask);
        }
        return 1;
    };

    /**
     * Inserts an item where an LVITEM says - at the end past the last - or
     * where its text sorts under LVS_SORTASCENDING/DESCENDING, and tells the
     * parent.
     *
     * @param {any} record @param {number} info @param {boolean} wide @param {unknown} thread
     */
    const insertItem = async(record, info, wide, thread)=>{
        const held = state(record);
        if (ownerData(record) || info >>> 0 === 0 || (read32(info + LVITEM.iSubItem) | 0) !== 0)
        {
            return -1;
        }
        const mask = read32(info + LVITEM.mask);
        let index = read32(info + LVITEM.iItem) | 0;
        if (index < 0)
        {
            return -1;
        }
        const item = newItem();
        if (mask & LVIF_TEXT)
        {
            item.texts[0] = textIn(info, wide);
        }
        if (mask & LVIF_IMAGE)
        {
            item.images[0] = read32(info + LVITEM.iImage) | 0;
        }
        if (mask & LVIF_PARAM)
        {
            item.lParam = read32(info + LVITEM.lParam);
        }
        if (mask & LVIF_INDENT)
        {
            item.indent = read32(info + LVITEM.iIndent) | 0;
        }
        const wanted = mask & LVIF_STATE
            ? read32(info + LVITEM.state) & read32(info + LVITEM.stateMask) : 0;
        index = Math.min(index, held.items.length);
        const sorting = record.style & (LVS_SORTASCENDING | LVS_SORTDESCENDING);
        if (sorting && item.texts[0] !== null)
        {
            const descending = (record.style & LVS_SORTDESCENDING) !== 0;
            const key = (item.texts[0] ?? '').toLowerCase();
            const at = held.items.findIndex((/** @type {ListItem} */ other)=>{
                const theirs = (other.texts[0] ?? '').toLowerCase();
                return descending ? theirs < key : theirs > key;
            });
            index = at < 0 ? held.items.length : at;
        }
        held.items.splice(index, 0, item);
        if (held.mark >= index)
        {
            held.mark++;
        }
        // The parent hears of the new item's state - a focus taken from
        // another, a selection - before it hears of the item.
        if (wanted !== 0)
        {
            await setState(record, index, wanted, wanted, thread);
        }
        await tellItem(record, LVN_INSERTITEM, index, { lParam: item.lParam }, thread);
        host.invalidate(record);
        return index;
    };

    /**
     * Deletes one item, telling the parent first with its lParam.
     *
     * @param {any} record @param {number} index @param {unknown} thread
     */
    const deleteItem = async(record, index, thread)=>{
        const held = state(record);
        if (index < 0 || index >= count(record))
        {
            return 0;
        }
        if (ownerData(record))
        {
            await tellItem(record, LVN_DELETEITEM, index, {}, thread);
            held.count--;
            held.selected = new Set([...held.selected ?? []]
                .filter(i=>i !== index).map(i=>(i > index ? i - 1 : i)));
            held.focus = held.focus === index ? -1 : held.focus > index ? held.focus - 1
                : held.focus;
        }
        else
        {
            await tellItem(record, LVN_DELETEITEM, index, { lParam: held.items[index].lParam },
                thread);
            held.items.splice(index, 1);
        }
        held.mark = held.mark === index ? -1 : held.mark > index ? held.mark - 1 : held.mark;
        host.invalidate(record);
        return 1;
    };

    /**
     * Deletes them all: LVN_DELETEALLITEMS, and a LVN_DELETEITEM for each
     * unless the parent answered TRUE to the first.
     *
     * @param {any} record @param {unknown} thread
     */
    const deleteAll = async(record, thread)=>{
        const held = state(record);
        const quiet = await tellItem(record, LVN_DELETEALLITEMS, -1, {}, thread);
        if (quiet === 0)
        {
            for (let index = 0; index < count(record); index++)
            {
                await tellItem(record, LVN_DELETEITEM, index,
                    { lParam: ownerData(record) ? 0 : held.items[index].lParam }, thread);
            }
        }
        held.items = [];
        held.count = 0;
        held.selected = new Set();
        held.focus = -1;
        held.mark = -1;
        held.top = 0;
        host.invalidate(record);
        return 1;
    };

    /**
     * The next item from `start` with the states `flags` names, or the
     * neighbour in a direction.
     *
     * @param {any} record @param {number} start @param {number} flags
     */
    const nextItem = (record, start, flags)=>{
        const total = count(record);
        const states = flags & LVNI_STATEMASK;
        /** @param {number} index */
        const matches = index=>(stateOf(record, index) & states) === states;
        if (flags & (LVNI_ABOVE | LVNI_BELOW | LVNI_TOLEFT | LVNI_TORIGHT))
        {
            const backwards = (flags & (LVNI_ABOVE | LVNI_TOLEFT)) !== 0;
            for (let index = start + (backwards ? -1 : 1); index >= 0 && index < total;
                index += backwards ? -1 : 1)
            {
                if (matches(index))
                {
                    return index;
                }
            }
            return -1;
        }
        for (let index = start + 1; index < total; index++)
        {
            if (states === 0 || matches(index))
            {
                return index;
            }
        }
        return -1;
    };

    /**
     * LVM_FINDITEM: an lParam, or a text matched whole or as a prefix without
     * regard to case, from after `start`, wrapping round under LVFI_WRAP. An
     * owner-data list asks its parent (LVN_ODFINDITEM).
     *
     * @param {any} record @param {number} start @param {number} info @param {boolean} wide
     * @param {unknown} thread
     */
    const findItem = async(record, start, info, wide, thread)=>{
        const held = state(record);
        const total = count(record);
        if (info >>> 0 === 0 || total === 0)
        {
            return -1;
        }
        const flags = read32(info + FINDINFO.flags);
        if (ownerData(record))
        {
            const answer = await notify(record, held.unicode ? LVN_ODFINDITEMW : LVN_ODFINDITEMA,
                FINDITEM_SIZE, block=>{
                    write32(block + FINDITEM_START, start + 1);
                    host.writeMemory(block + FINDITEM_INFO, host.readMemory(info, 24));
                }, thread);
            return answer | 0;
        }
        const lParam = read32(info + FINDINFO.lParam);
        const wanted = flags & (LVFI_STRING | LVFI_PARTIAL | LVFI_SUBSTRING)
            ? readText(host, read32(info + FINDINFO.psz), wide).toLowerCase() : null;
        const first = start < -1 || start >= total ? 0 : start + 1;
        const order = Array.from({ length: total }, (_, i)=>(first + i) % total)
            .filter(index=>flags & LVFI_WRAP || index >= first);
        for (const index of order)
        {
            const item = held.items[index];
            if (flags & LVFI_PARAM && item.lParam !== lParam)
            {
                continue;
            }
            if (wanted !== null)
            {
                const text = (item.texts[0] ?? '').toLowerCase();
                const partial = (flags & (LVFI_PARTIAL | LVFI_SUBSTRING)) !== 0;
                if (partial ? !text.startsWith(wanted) : text !== wanted)
                {
                    continue;
                }
            }
            return index;
        }
        return -1;
    };

    /**
     * Sorts the items by the program's comparison: LVM_SORTITEMS hands it two
     * items' lParams, LVM_SORTITEMSEX their indices as they stood before the
     * sort. A merge sort, so equal items keep their order.
     *
     * @param {any} record @param {number} compare @param {number} lParam @param {boolean} byIndex
     * @param {unknown} thread
     */
    const sortItems = async(record, compare, lParam, byIndex, thread)=>{
        const held = state(record);
        if (ownerData(record) || compare === 0 || !host.call)
        {
            return 0;
        }
        const call = host.call;
        /** @type {ListItem[]} */
        const items = held.items;
        const before = new Map(items.map((item, index)=>[item, index]));
        /** @param {ListItem} item */
        const word = item=>(byIndex ? /** @type {number} */ (before.get(item)) : item.lParam);
        held.items = await stableSort(items, (a, b)=>call(compare, [word(a), word(b), lParam],
            thread));
        host.invalidate(record);
        return 1;
    };

    // --- Columns ----------------------------------------------------------------

    /**
     * @param {any} record @param {number} index @param {number} info @param {boolean} wide
     * @param {unknown} thread
     */
    const insertColumn = async(record, index, info, wide, thread)=>{
        const held = state(record);
        if (info >>> 0 === 0 || index < 0)
        {
            return -1;
        }
        const mask = read32(info + LVCOLUMN.mask);
        const at = Math.min(index, held.columns.length);
        /** @type {Column} */
        const column = {
            fmt: mask & LVCF_FMT ? read32(info + LVCOLUMN.fmt) : 0,
            width: mask & LVCF_WIDTH ? read32(info + LVCOLUMN.cx) | 0 : DEFAULT_COLUMN_WIDTH,
            text: mask & LVCF_TEXT && read32(info + LVCOLUMN.pszText) !== 0
                ? readText(host, read32(info + LVCOLUMN.pszText), wide) : '',
            subItem: mask & LVCF_SUBITEM ? read32(info + LVCOLUMN.iSubItem) | 0 : at,
            image: mask & LVCF_IMAGE ? read32(info + LVCOLUMN.iImage) | 0 : 0,
            minWidth: mask & LVCF_MINWIDTH ? read32(info + LVCOLUMN.cxMin) | 0 : 0,
        };
        // The first column is always left aligned, whatever it asks.
        if (at === 0)
        {
            column.fmt &= ~LVCFMT_JUSTIFYMASK;
        }
        held.columns.splice(at, 0, column);
        await ensureHeader(record, thread);
        await headerItem(record, HDM.INSERTITEMW, at, LVCF_WIDTH | LVCF_TEXT | LVCF_FMT
            | (mask & LVCF_ORDER), { ...column, order: read32(info + LVCOLUMN.iOrder) | 0 },
        thread);
        host.invalidate(record);
        return at;
    };

    /**
     * @param {any} record @param {number} index @param {number} info @param {boolean} wide
     * @param {unknown} thread
     */
    const getColumn = async(record, index, info, wide, thread)=>{
        const held = state(record);
        const column = held.columns[index];
        if (info >>> 0 === 0 || !column)
        {
            return 0;
        }
        const mask = read32(info + LVCOLUMN.mask);
        if (mask & LVCF_FMT)
        {
            write32(info + LVCOLUMN.fmt, column.fmt);
        }
        if (mask & LVCF_WIDTH)
        {
            write32(info + LVCOLUMN.cx, column.width);
        }
        if (mask & LVCF_TEXT)
        {
            writeText(host, read32(info + LVCOLUMN.pszText), column.text, wide,
                read32(info + LVCOLUMN.cchTextMax) | 0);
        }
        if (mask & LVCF_SUBITEM)
        {
            write32(info + LVCOLUMN.iSubItem, column.subItem);
        }
        if (mask & LVCF_IMAGE)
        {
            write32(info + LVCOLUMN.iImage, column.image);
        }
        if (mask & LVCF_ORDER)
        {
            const order = await columnOrder(record, thread);
            write32(info + LVCOLUMN.iOrder, order.indexOf(index));
        }
        if (mask & LVCF_MINWIDTH)
        {
            write32(info + LVCOLUMN.cxMin, column.minWidth);
        }
        return 1;
    };

    /**
     * @param {any} record @param {number} index @param {number} info @param {boolean} wide
     * @param {unknown} thread
     */
    const setColumn = async(record, index, info, wide, thread)=>{
        const held = state(record);
        const column = held.columns[index];
        if (info >>> 0 === 0 || !column)
        {
            return 0;
        }
        const mask = read32(info + LVCOLUMN.mask);
        if (mask & LVCF_FMT)
        {
            column.fmt = index === 0 ? read32(info + LVCOLUMN.fmt) & ~LVCFMT_JUSTIFYMASK
                : read32(info + LVCOLUMN.fmt);
        }
        if (mask & LVCF_WIDTH)
        {
            column.width = read32(info + LVCOLUMN.cx) | 0;
        }
        if (mask & LVCF_TEXT)
        {
            const pointer = read32(info + LVCOLUMN.pszText);
            column.text = pointer === 0 ? '' : readText(host, pointer, wide);
        }
        if (mask & LVCF_SUBITEM)
        {
            column.subItem = read32(info + LVCOLUMN.iSubItem) | 0;
        }
        if (mask & LVCF_IMAGE)
        {
            column.image = read32(info + LVCOLUMN.iImage) | 0;
        }
        if (mask & LVCF_MINWIDTH)
        {
            column.minWidth = read32(info + LVCOLUMN.cxMin) | 0;
        }
        await headerItem(record, HDM.SETITEMW, index, mask & (LVCF_WIDTH | LVCF_TEXT | LVCF_FMT
            | LVCF_ORDER), { ...column, order: read32(info + LVCOLUMN.iOrder) | 0 }, thread);
        host.invalidate(record);
        return 1;
    };

    /**
     * The width a column needs for its widest text, or its title's too.
     *
     * @param {any} record @param {number} index @param {boolean} header
     */
    const autosize = (record, index, header)=>{
        const held = state(record);
        const { hdc } = host.contextOn(record);
        /** @param {string} text */
        const measure = text=>(hdc !== 0 && host.draw ? host.draw.measure(hdc, text).width
            : text.length * 7);
        let widest = 0;
        if (!ownerData(record))
        {
            for (const item of held.items)
            {
                widest = Math.max(widest, measure(item.texts[held.columns[index]?.subItem ?? index]
                    ?? ''));
            }
        }
        if (header)
        {
            widest = Math.max(widest, measure(held.columns[index]?.text ?? '') + 12);
        }
        host.endPaint(record, hdc);
        const iconRoom = index === 0 && held.images[1] !== 0 ? SMALL_ICON_SIZE : 0;
        return widest + iconRoom + LABEL_MARGIN * 6;
    };

    /**
     * @param {any} record @param {number} index @param {number} width @param {unknown} thread
     */
    const setColumnWidth = async(record, index, width, thread)=>{
        const held = state(record);
        if (view(record) === LVS_LIST)
        {
            if (index !== 0 || width <= 0)
            {
                return 0;
            }
            held.listWidth = width;
            host.invalidate(record);
            return 1;
        }
        if (view(record) !== LVS_REPORT)
        {
            return 0;
        }
        const column = held.columns[index];
        if (!column)
        {
            return 0;
        }
        column.width = width === LVSCW_AUTOSIZE ? autosize(record, index, false)
            : width === LVSCW_AUTOSIZE_USEHEADER ? autosize(record, index, true) : width;
        await headerItem(record, HDM.SETITEMW, index, LVCF_WIDTH, column, thread);
        host.invalidate(record);
        return 1;
    };

    // --- Drawing ------------------------------------------------------------------

    /**
     * NM_CUSTOMDRAW to the parent at one stage of painting, with the colours
     * the item is drawn in, answered with what more it wants to hear.
     *
     * @param {any} record @param {number} stage @param {number} hdc @param {any} box
     * @param {{ index?: number, subItem?: number, itemState?: number, lParam?: number }} what
     * @param {unknown} thread
     */
    const customDraw = (record, stage, hdc, box, what, thread)=>{
        const held = state(record);
        return notify(record, NM_CUSTOMDRAW, CUSTOMDRAW.SIZE, block=>{
            write32(block + CUSTOMDRAW.dwDrawStage, stage);
            write32(block + CUSTOMDRAW.hdc, hdc);
            [box.left, box.top, box.right, box.bottom]
                .forEach((value, i)=>write32(block + CUSTOMDRAW.rc + i * 4, value));
            write32(block + CUSTOMDRAW.dwItemSpec, what.index ?? 0);
            write32(block + CUSTOMDRAW.uItemState, what.itemState ?? 0);
            write32(block + CUSTOMDRAW.lItemlParam, what.lParam ?? 0);
            write32(block + CUSTOMDRAW.clrText, held.textColor);
            write32(block + CUSTOMDRAW.clrTextBk, held.textBackground);
            write32(block + CUSTOMDRAW.iSubItem, what.subItem ?? 0);
        }, thread);
    };

    /**
     * One item's label, and in report view its subitems, a selected item in
     * the highlight colours.
     *
     * @param {any} record @param {number} hdc @param {number} index
     */
    const paintItem = (record, hdc, index)=>{
        const held = state(record);
        const draw = /** @type {any} */ (host.draw);
        const report = view(record) === LVS_REPORT;
        const box = bounds(record, index);
        const item = ownerData(record) ? null : held.items[index];
        const selected = (stateOf(record, index) & LVIS_SELECTED) !== 0;
        const label = itemRect(record, index, LVIR_LABEL);
        const textColor = selected ? host.sysColor(COLOR_HIGHLIGHTTEXT) : held.textColor;
        if (selected)
        {
            draw.fill(hdc, report ? box : label, host.sysColor(COLOR_HIGHLIGHT));
        }
        const centred = view(record) === LVS_ICON ? DT_CENTER : DT_LEFT;
        tk.drawText(hdc, item?.texts[0] ?? '', { left: label.left + LABEL_MARGIN,
            top: label.top, right: label.right - LABEL_MARGIN, bottom: label.bottom },
        centred | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS, textColor);
        if (!report || item === null)
        {
            return;
        }
        let x = box.left;
        held.columns.forEach((/** @type {Column} */ column, /** @type {number} */ c)=>{
            const left = x;
            x += Math.max(0, column.width);
            if (c === 0)
            {
                return;
            }
            const align = (column.fmt & LVCFMT_JUSTIFYMASK) === 1 ? DT_RIGHT
                : (column.fmt & LVCFMT_JUSTIFYMASK) === 2 ? DT_CENTER : DT_LEFT;
            tk.drawText(hdc, item.texts[column.subItem] ?? '', { left: left + LABEL_MARGIN * 3,
                top: box.top, right: x - LABEL_MARGIN * 3, bottom: box.bottom },
            align | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS, textColor);
        });
    };

    /**
     * The background, then each visible item, the parent told of each stage
     * it asked to hear of (NM_CUSTOMDRAW): before the whole, before and
     * after each item and, in report view, each subitem, after the whole.
     *
     * @param {any} record @param {number} hdc @param {any} rect @param {unknown} thread
     */
    const paint = async(record, hdc, rect, thread)=>{
        const held = state(record);
        const draw = /** @type {any} */ (host.draw);
        if (held.background !== CLR_NONE)
        {
            draw.fill(hdc, rect, held.background);
        }
        // The items are painted, and their custom draw told, with the
        // context's background mode TRANSPARENT, whatever the text's
        // background colour: the list fills a background itself (Wine's
        // listview test_customdraw_background sees it at every stage).
        setBkMode?.(hdc, TRANSPARENT);
        const wants = await customDraw(record, CDDS_PREPAINT, hdc, rect, {}, thread);
        if (wants & CDRF_SKIPDEFAULT)
        {
            return;
        }
        for (let index = 0; index < count(record); index++)
        {
            const box = bounds(record, index);
            if (box.bottom <= rect.top || box.top >= rect.bottom)
            {
                continue;
            }
            const itemState = stateOf(record, index);
            const what = { index, lParam: ownerData(record) ? 0 : held.items[index].lParam,
                itemState: (itemState & LVIS_SELECTED ? CDIS_SELECTED : 0)
                    | (itemState & LVIS_FOCUSED ? CDIS_FOCUS : 0) };
            const answer = wants & CDRF_NOTIFYITEMDRAW
                ? await customDraw(record, CDDS_ITEMPREPAINT, hdc, box, what, thread) : 0;
            if (answer & CDRF_NOTIFYSUBITEMDRAW && view(record) === LVS_REPORT)
            {
                for (let subItem = 0; subItem < Math.max(1, held.columns.length); subItem++)
                {
                    const sub = await customDraw(record, CDDS_ITEMPREPAINT | CDDS_SUBITEM, hdc,
                        box, { ...what, subItem }, thread);
                    if (sub & CDRF_NOTIFYPOSTPAINT)
                    {
                        await customDraw(record, CDDS_ITEMPOSTPAINT | CDDS_SUBITEM, hdc, box,
                            { ...what, subItem }, thread);
                    }
                }
            }
            if (!(answer & CDRF_SKIPDEFAULT))
            {
                paintItem(record, hdc, index);
            }
            if (answer & CDRF_NOTIFYPOSTPAINT)
            {
                await customDraw(record, CDDS_ITEMPOSTPAINT, hdc, box, what, thread);
            }
        }
        if (wants & CDRF_NOTIFYPOSTPAINT)
        {
            await customDraw(record, CDDS_POSTPAINT, hdc, rect, {}, thread);
        }
    };

    /**
     * Makes the header the first time the list view needs one: made in
     * report view, or when a column is inserted. A list view in another
     * view that never had a column has none (LVM_GETHEADER answers NULL).
     *
     * @param {any} record @param {unknown} thread
     */
    const ensureHeader = (record, thread)=>{
        const held = state(record);
        if (held.header !== 0 || !host.popup)
        {
            return held.header;
        }
        const size = host.clientSize(record);
        const shown = view(record) === LVS_REPORT && !(record.style & LVS_NOCOLUMNHEADER);
        // A header whose columns sort when clicked has buttons; columns the
        // person may drag about make it a drag-and-drop header.
        const style = WS_CHILD | HDS_HORZ | (record.style & LVS_NOSORTHEADER ? 0 : HDS_BUTTONS)
            | (held.extended & LVS_EX_HEADERDRAGDROP ? HDS_DRAGDROP : 0)
            | (shown ? WS_VISIBLE : HDS_HIDDEN);
        return after(host.popup(HEADER_CLASS, { x: 0, y: 0, width: size.width, height: 0 },
            record.hwnd, 0, style, thread), header=>{
            held.header = header >>> 0;
            return after(placeHeader(record), ()=>held.header);
        });
    };

    /**
     * Places the header over the client area in report view, hidden in any
     * other or under LVS_NOCOLUMNHEADER.
     *
     * @param {any} record
     */
    const placeHeader = record=>{
        const held = state(record);
        if (held.header === 0)
        {
            return 0;
        }
        const shown = view(record) === LVS_REPORT && !(record.style & LVS_NOCOLUMNHEADER);
        const width = host.clientSize(record).width;
        held.headerHeight = shown ? rowHeight(record) + 6 : 0;
        return after(host.move?.(held.header, 0, 0, Math.max(width, reportWidth(record)),
            held.headerHeight) ?? 0, ()=>host.show?.(held.header, shown ? 5 : 0) ?? 0);
    };

    /**
     * @param {any} record
     * @param {import('../user32/controls.js').ControlMessage} message
     * @param {unknown} [thread]
     */
    return (record, message, thread)=>{
        const held = state(record);
        const { wParam, lParam } = message;
        const wide = [LVM.GETITEMW, LVM.SETITEMW, LVM.INSERTITEMW, LVM.FINDITEMW,
            LVM.GETSTRINGWIDTHW, LVM.GETCOLUMNW, LVM.SETCOLUMNW, LVM.INSERTCOLUMNW,
            LVM.GETITEMTEXTW, LVM.SETITEMTEXTW, LVM.GETISEARCHSTRINGW, LVM.EDITLABELW,
            LVM.SETBKIMAGEW, LVM.GETBKIMAGEW].includes(message.message);
        switch (message.message)
        {
            case WM_CREATE: {
                const to = notifyWindow(record);
                return after(to !== 0 ? host.send(to, WM_NOTIFYFORMAT, record.hwnd, NF_QUERY,
                    thread) : NFR_UNICODE, answer=>{
                    held.unicode = answer === NFR_UNICODE;
                    return after(view(record) === LVS_REPORT ? ensureHeader(record, thread) : 0,
                        ()=>tk.common(record, message, thread));
                });
            }
            case WM_NOTIFYFORMAT:
                // The header asks its parent, which is this: it hears wide.
                if (lParam === NF_REQUERY)
                {
                    const to = notifyWindow(record);
                    return after(to !== 0 ? host.send(to, WM_NOTIFYFORMAT, record.hwnd, NF_QUERY,
                        thread) : NFR_UNICODE, answer=>{
                        held.unicode = answer === NFR_UNICODE;
                        return answer;
                    });
                }
                return NFR_UNICODE;
            case WM_NOTIFY: {
                if (lParam >>> 0 === 0 || read32(lParam) !== held.header)
                {
                    return 0;
                }
                const code = read32(lParam + 8) | 0;
                const column = read32(lParam + NMHEADER_ITEM) | 0;
                if ((code === HDN_ITEMCHANGEDA || code === HDN_ITEMCHANGEDW)
                    && held.columns[column] && held.header !== 0)
                {
                    // A divider dragged: the column takes the header's width.
                    const block = host.allocate?.(HDITEM.SIZE) ?? 0;
                    if (block === 0)
                    {
                        return 0;
                    }
                    host.writeMemory(block, new Uint8Array(HDITEM.SIZE));
                    write32(block + HDITEM.mask, 0x0001);
                    return after(host.send(held.header, HDM.GETITEMW, column, block, thread),
                        ()=>{
                            held.columns[column].width = read32(block + HDITEM.cxy) | 0;
                            host.release?.(block);
                            host.invalidate(record);
                            return 0;
                        });
                }
                if (code === HDN_ITEMCLICKA || code === HDN_ITEMCLICKW)
                {
                    return tellItem(record, LVN_COLUMNCLICK, -1, { subItem: column }, thread);
                }
                return 0;
            }
            case WM_DESTROY:
                // Its items go with it, the parent told as for LVM_DELETEALLITEMS.
                held.header = 0;
                return after(!ownerData(record) && held.items.length > 0
                    ? deleteAll(record, thread) : 0, ()=>tk.common(record, message, thread));
            case WM_ERASEBKGND:
                return 1;
            case WM_PAINT:
                return tk.painting(record, (/** @type {number} */ hdc, /** @type {any} */ rect)=>
                    paint(record, hdc, rect, thread));
            case WM_SIZE:
            case WM_STYLECHANGED:
                return after(view(record) === LVS_REPORT ? ensureHeader(record, thread) : 0,
                    ()=>after(placeHeader(record), ()=>{
                        host.invalidate(record);
                        return message.message === WM_SIZE ? 0 : tk.common(record, message, thread);
                    }));
            case WM_GETDLGCODE:
                return DLGC_WANTARROWS | DLGC_WANTCHARS;
            case WM_SETFOCUS:
            case WM_KILLFOCUS:
                host.invalidate(record);
                return 0;
            case WM_LBUTTONDOWN: {
                const point = pointOf(lParam);
                const hit = hitTest(record, point.x, point.y);
                return (async()=>{
                    await host.setFocus(record.hwnd, thread);
                    if (hit.index < 0)
                    {
                        return 0;
                    }
                    await deselectOthers(record, hit.index, thread);
                    await setState(record, hit.index, LVIS_SELECTED | LVIS_FOCUSED,
                        LVIS_SELECTED | LVIS_FOCUSED, thread);
                    held.mark = hit.index;
                    return 0;
                })();
            }
            case WM_KEYDOWN: {
                const total = count(record);
                const from = focusedItem(record);
                const to = wParam === VK_DOWN ? Math.min(total - 1, from + 1)
                    : wParam === VK_UP ? Math.max(0, from - 1)
                        : wParam === VK_HOME ? 0 : wParam === VK_END ? total - 1 : -2;
                if (to === -2 || total === 0 || to === from)
                {
                    return 0;
                }
                // Shift extends the selection from the mark to where the focus
                // goes, Ctrl moves only the focus, and a plain arrow selects
                // the one item it lands on - in a single-selection list the
                // mark is always the item itself.
                const extend = host.keyDown(VK_SHIFT) && !(record.style & LVS_SINGLESEL);
                const focusOnly = host.keyDown(VK_CONTROL) && !extend;
                return (async()=>{
                    if (focusOnly)
                    {
                        await setState(record, to, LVIS_FOCUSED, LVIS_FOCUSED, thread);
                        return 0;
                    }
                    const anchor = extend && held.mark >= 0 ? held.mark : to;
                    const low = Math.min(anchor, to);
                    const high = Math.max(anchor, to);
                    if (ownerData(record))
                    {
                        await deselectOthers(record, -1, thread);
                        if (high > low)
                        {
                            await selectRange(record, low, high, thread);
                        }
                        await setState(record, to, LVIS_SELECTED | LVIS_FOCUSED,
                            LVIS_SELECTED | LVIS_FOCUSED, thread);
                        held.mark = anchor;
                        return 0;
                    }
                    for (let other = 0; other < total; other++)
                    {
                        const inside = other >= low && other <= high;
                        if (!inside && stateOf(record, other) & LVIS_SELECTED)
                        {
                            await setState(record, other, 0, LVIS_SELECTED, thread);
                        }
                        else if (inside && other !== to)
                        {
                            await setState(record, other, LVIS_SELECTED, LVIS_SELECTED, thread);
                        }
                    }
                    await setState(record, to, LVIS_SELECTED | LVIS_FOCUSED,
                        LVIS_SELECTED | LVIS_FOCUSED, thread);
                    held.mark = anchor;
                    return 0;
                })();
            }
            case LVM.GETITEMCOUNT:
                return count(record);
            case LVM.SETITEMCOUNT:
                if (ownerData(record))
                {
                    held.count = Math.max(0, wParam | 0);
                    held.selected = new Set([...held.selected ?? []].filter(i=>i < held.count));
                    if (held.focus >= held.count)
                    {
                        held.focus = -1;
                    }
                    if (held.mark >= held.count)
                    {
                        held.mark = -1;
                    }
                    host.invalidate(record);
                }
                return 1;
            case LVM.INSERTITEMA:
            case LVM.INSERTITEMW:
                return insertItem(record, lParam, wide, thread);
            case LVM.DELETEITEM:
                return deleteItem(record, wParam | 0, thread);
            case LVM.DELETEALLITEMS:
                return deleteAll(record, thread);
            case LVM.GETITEMA:
            case LVM.GETITEMW:
                return lParam >>> 0 === 0 ? 0 : getItem(record, lParam, wide, thread);
            case LVM.SETITEMA:
            case LVM.SETITEMW:
                return lParam >>> 0 === 0 ? 0 : setItem(record, lParam, wide, thread);
            case LVM.SETITEMSTATE: {
                if (lParam >>> 0 === 0)
                {
                    return 0;
                }
                const index = wParam | 0;
                const value = read32(lParam + LVITEM.state);
                const mask = read32(lParam + LVITEM.stateMask);
                if (index === -1)
                {
                    // Deselecting all when none is selected does nothing; a
                    // single-selection list cannot select all, and no list
                    // can focus all.
                    let selected = 0;
                    for (let i = 0; i < count(record); i++)
                    {
                        selected += stateOf(record, i) & LVIS_SELECTED ? 1 : 0;
                    }
                    if (value === 0 && mask === LVIS_SELECTED && selected === 0)
                    {
                        return 1;
                    }
                    if (value & mask & LVIS_SELECTED && record.style & LVS_SINGLESEL
                        || value & mask & LVIS_FOCUSED)
                    {
                        return 0;
                    }
                }
                if (index === -1 && ownerData(record))
                {
                    const old = (!(value & LVIS_SELECTED) && (held.selected?.size ?? 0) > 0
                        ? LVIS_SELECTED : 0) | ((held.focus ?? -1) >= 0 ? LVIS_FOCUSED : 0);
                    // An owner-data list changes them all at once, told as one
                    // change to item -1.
                    held.selected ??= new Set();
                    if (mask & LVIS_SELECTED)
                    {
                        held.selected = value & LVIS_SELECTED
                            ? new Set(Array.from({ length: count(record) }, (_, i)=>i))
                            : new Set();
                    }
                    if (mask & LVIS_FOCUSED && !(value & LVIS_FOCUSED))
                    {
                        held.focus = -1;
                    }
                    host.invalidate(record);
                    return after(tellItem(record, LVN_ITEMCHANGED, -1, { newState: value & mask,
                        oldState: old & mask, changed: LVIF_STATE }, thread), ()=>1);
                }
                if (index === -1)
                {
                    return (async()=>{
                        for (let i = 0; i < count(record); i++)
                        {
                            await setState(record, i, value, mask, thread);
                        }
                        return 1;
                    })();
                }
                if (index < 0 || index >= count(record))
                {
                    return 0;
                }
                return setState(record, index, value, mask, thread).then(done=>(done ? 1 : 0));
            }
            case LVM.GETITEMSTATE: {
                const index = wParam | 0;
                if (index < 0 || index >= count(record))
                {
                    return 0;
                }
                const own = stateOf(record, index) & lParam;
                const callback = (ownerData(record) ? ~(LVIS_FOCUSED | LVIS_SELECTED)
                    : held.callbackMask) & lParam;
                if (callback === 0)
                {
                    return own;
                }
                return after(askDisplay(record, index, 0, LVIF_STATE, callback, thread),
                    got=>own | got.state);
            }
            case LVM.GETITEMTEXTA:
            case LVM.GETITEMTEXTW: {
                const index = wParam | 0;
                if (lParam >>> 0 === 0 || index < 0 || index >= count(record))
                {
                    return 0;
                }
                write32(lParam + LVITEM.mask, LVIF_TEXT);
                write32(lParam + LVITEM.iItem, index);
                return getItem(record, lParam, wide, thread).then(()=>{
                    const buffer = read32(lParam + LVITEM.pszText);
                    return buffer === 0 ? 0 : readText(host, buffer, wide).length;
                });
            }
            case LVM.SETITEMTEXTA:
            case LVM.SETITEMTEXTW: {
                const index = wParam | 0;
                if (lParam >>> 0 === 0 || index < 0 || index >= count(record))
                {
                    return 0;
                }
                if (ownerData(record))
                {
                    return 0;
                }
                write32(lParam + LVITEM.mask, LVIF_TEXT);
                write32(lParam + LVITEM.iItem, index);
                return setItem(record, lParam, wide, thread);
            }
            case LVM.GETNEXTITEM:
                return nextItem(record, wParam | 0, lParam & 0xffff);
            case LVM.FINDITEMA:
            case LVM.FINDITEMW:
                return findItem(record, wParam | 0, lParam, wide, thread);
            case LVM.GETSELECTEDCOUNT: {
                let selected = 0;
                for (let index = 0; index < count(record); index++)
                {
                    selected += stateOf(record, index) & LVIS_SELECTED ? 1 : 0;
                }
                return selected;
            }
            case LVM.GETSELECTIONMARK:
                return held.mark;
            case LVM.SETSELECTIONMARK: {
                const previous = held.mark;
                held.mark = lParam | 0;
                return previous;
            }
            case LVM.SETCALLBACKMASK:
                held.callbackMask = wParam >>> 0;
                return 1;
            case LVM.GETCALLBACKMASK:
                return held.callbackMask;
            case LVM.SORTITEMS:
                return sortItems(record, lParam >>> 0, wParam >>> 0, false, thread);
            case LVM.SORTITEMSEX:
                return sortItems(record, lParam >>> 0, wParam >>> 0, true, thread);
            case LVM.GETITEMRECT:
            case LVM.GETSUBITEMRECT: {
                const index = wParam | 0;
                if (lParam >>> 0 === 0 || index < 0 || index >= count(record))
                {
                    return 0;
                }
                const portion = message.message === LVM.GETSUBITEMRECT ? read32(lParam + 8)
                    : read32(lParam);
                let box = itemRect(record, index, portion);
                if (message.message === LVM.GETSUBITEMRECT)
                {
                    const subItem = read32(lParam + 4) | 0;
                    if (view(record) !== LVS_REPORT || subItem < 0
                        || subItem >= Math.max(1, held.columns.length))
                    {
                        return 0;
                    }
                    if (subItem > 0)
                    {
                        const whole = bounds(record, index);
                        const left = whole.left + held.columns.slice(0, subItem)
                            .reduce((/** @type {number} */ t, /** @type {Column} */ c)=>
                                t + Math.max(0, c.width), 0);
                        box = { left, top: whole.top, right: left
                            + Math.max(0, held.columns[subItem].width), bottom: whole.bottom };
                    }
                }
                [box.left, box.top, box.right, box.bottom]
                    .forEach((value, i)=>write32(lParam + i * 4, value));
                return 1;
            }
            case LVM.GETITEMPOSITION: {
                const index = wParam | 0;
                if (lParam >>> 0 === 0 || index < 0 || index >= count(record))
                {
                    return 0;
                }
                const box = bounds(record, index);
                write32(lParam, box.left);
                write32(lParam + 4, box.top);
                return 1;
            }
            case LVM.SETITEMPOSITION:
            case LVM.SETITEMPOSITION32: {
                const index = wParam | 0;
                if (index < 0 || index >= count(record) || ownerData(record)
                    || view(record) === LVS_REPORT || view(record) === LVS_LIST)
                {
                    return 0;
                }
                const point = message.message === LVM.SETITEMPOSITION ? pointOf(lParam)
                    : { x: read32(lParam) | 0, y: read32(lParam + 4) | 0 };
                held.items[index].position = { x: point.x + held.scroll.x,
                    y: point.y + held.scroll.y };
                host.invalidate(record);
                return 1;
            }
            case LVM.HITTEST:
            case LVM.SUBITEMHITTEST: {
                if (lParam >>> 0 === 0)
                {
                    return -1;
                }
                const x = read32(lParam + HITTEST.x) | 0;
                const y = read32(lParam + HITTEST.y) | 0;
                const sub = message.message === LVM.SUBITEMHITTEST;
                const hit = sub && view(record) === LVS_REPORT ? subItemHitTest(record, x, y)
                    : { subItem: 0, ...hitTest(record, x, y) };
                write32(lParam + HITTEST.flags, hit.flags);
                write32(lParam + HITTEST.iItem, hit.index);
                if (sub)
                {
                    write32(lParam + HITTEST.iSubItem, hit.subItem);
                }
                return hit.index;
            }
            case LVM.GETSTRINGWIDTHA:
            case LVM.GETSTRINGWIDTHW: {
                if (lParam >>> 0 === 0)
                {
                    return 0;
                }
                const text = readText(host, lParam, wide);
                const { hdc } = host.contextOn(record);
                const width = hdc !== 0 && host.draw ? host.draw.measure(hdc, text).width : 0;
                host.endPaint(record, hdc);
                return width;
            }
            case LVM.INSERTCOLUMNA:
            case LVM.INSERTCOLUMNW:
                return insertColumn(record, wParam | 0, lParam, wide, thread);
            case LVM.DELETECOLUMN: {
                const index = wParam | 0;
                if (index < 0 || index >= held.columns.length)
                {
                    return 0;
                }
                held.columns.splice(index, 1);
                for (const item of held.items)
                {
                    if (index > 0)
                    {
                        item.texts.splice(index, 1);
                        item.images.splice(index, 1);
                    }
                }
                return after(held.header !== 0
                    ? host.send(held.header, HDM.DELETEITEM, index, 0, thread) : 1, ()=>{
                    host.invalidate(record);
                    return 1;
                });
            }
            case LVM.GETCOLUMNA:
            case LVM.GETCOLUMNW:
                return getColumn(record, wParam | 0, lParam, wide, thread);
            case LVM.SETCOLUMNA:
            case LVM.SETCOLUMNW:
                return setColumn(record, wParam | 0, lParam, wide, thread);
            case LVM.GETCOLUMNWIDTH: {
                if (view(record) === LVS_LIST)
                {
                    return held.listWidth;
                }
                if (view(record) !== LVS_REPORT)
                {
                    return 0;
                }
                return held.columns[wParam | 0]?.width ?? 0;
            }
            case LVM.SETCOLUMNWIDTH:
                return setColumnWidth(record, wParam | 0, (lParam & 0xffff) << 16 >> 16, thread);
            case LVM.GETCOLUMNORDERARRAY: {
                if (lParam >>> 0 === 0 || held.header === 0)
                {
                    return 0;
                }
                return host.send(held.header, HDM.GETORDERARRAY, wParam, lParam, thread);
            }
            case LVM.SETCOLUMNORDERARRAY: {
                if (lParam >>> 0 === 0 || held.header === 0)
                {
                    return 0;
                }
                return after(host.send(held.header, HDM.SETORDERARRAY, wParam, lParam, thread),
                    answer=>{
                        host.invalidate(record);
                        return answer;
                    });
            }
            case LVM.GETHEADER:
                return held.header;
            case LVM.SETIMAGELIST: {
                const which = wParam >>> 0;
                if (which > 2)
                {
                    return 0;
                }
                const previous = held.images[which];
                held.images[which] = lParam >>> 0;
                held.rowHeight = undefined;
                host.invalidate(record);
                return previous;
            }
            case LVM.GETIMAGELIST:
                return held.images[wParam >>> 0] ?? 0;
            case LVM.GETBKCOLOR:
                return held.background;
            case LVM.SETBKCOLOR:
                held.background = lParam >>> 0;
                host.invalidate(record);
                return 1;
            case LVM.GETTEXTCOLOR:
                return held.textColor;
            case LVM.SETTEXTCOLOR:
                held.textColor = lParam >>> 0;
                host.invalidate(record);
                return 1;
            case LVM.GETTEXTBKCOLOR:
                return held.textBackground;
            case LVM.SETTEXTBKCOLOR:
                held.textBackground = lParam >>> 0;
                host.invalidate(record);
                return 1;
            case LVM.GETOUTLINECOLOR:
                return held.outline;
            case LVM.SETOUTLINECOLOR: {
                const previous = held.outline;
                held.outline = lParam >>> 0;
                return previous;
            }
            case LVM.SETEXTENDEDLISTVIEWSTYLE: {
                // A mask of zero is all of them.
                const previous = held.extended;
                const mask = wParam >>> 0 === 0 ? 0xffffffff : wParam >>> 0;
                held.extended = (held.extended & ~mask | lParam & mask) >>> 0;
                host.invalidate(record);
                return previous;
            }
            case LVM.GETEXTENDEDLISTVIEWSTYLE:
                return held.extended;
            case LVM.GETTOPINDEX:
                return view(record) === LVS_REPORT || view(record) === LVS_LIST ? held.top : 0;
            case LVM.GETCOUNTPERPAGE: {
                const size = host.clientSize(record);
                const height = rowHeight(record);
                if (view(record) === LVS_REPORT)
                {
                    return Math.max(0, Math.floor((size.height - held.headerHeight) / height));
                }
                if (view(record) === LVS_LIST)
                {
                    return Math.max(1, Math.floor(size.height / height))
                        * Math.max(1, Math.floor(size.width / held.listWidth));
                }
                return count(record);
            }
            case LVM.ENSUREVISIBLE: {
                const index = wParam | 0;
                if (index < 0 || index >= count(record))
                {
                    return 0;
                }
                if (view(record) === LVS_REPORT)
                {
                    const size = host.clientSize(record);
                    const page = Math.max(1, Math.floor((size.height - held.headerHeight)
                        / rowHeight(record)));
                    if (index < held.top)
                    {
                        held.top = index;
                    }
                    else if (index >= held.top + page)
                    {
                        held.top = index - page + 1;
                    }
                    host.invalidate(record);
                }
                return 1;
            }
            case LVM.SCROLL: {
                if (view(record) === LVS_REPORT)
                {
                    const rows = Math.trunc((lParam | 0) / rowHeight(record));
                    held.top = Math.max(0, Math.min(Math.max(0, count(record) - 1),
                        held.top + rows));
                    held.scroll.x = Math.max(0, held.scroll.x + (wParam | 0));
                }
                else
                {
                    held.scroll.x += wParam | 0;
                    held.scroll.y += lParam | 0;
                }
                host.invalidate(record);
                return 1;
            }
            case LVM.GETORIGIN: {
                if (lParam >>> 0 === 0 || view(record) === LVS_REPORT
                    || view(record) === LVS_LIST)
                {
                    return 0;
                }
                write32(lParam, held.scroll.x);
                write32(lParam + 4, held.scroll.y);
                return 1;
            }
            case LVM.GETVIEWRECT: {
                if (lParam >>> 0 === 0)
                {
                    return 0;
                }
                let right = 0;
                let bottom = 0;
                for (let index = 0; index < count(record); index++)
                {
                    const box = bounds(record, index);
                    right = Math.max(right, box.right);
                    bottom = Math.max(bottom, box.bottom);
                }
                [0, 0, right, bottom].forEach((value, i)=>write32(lParam + i * 4, value));
                return 1;
            }
            case LVM.GETITEMSPACING: {
                const small = wParam !== 0;
                const spacing = small ? { x: held.iconSpacing.x + SMALL_ICON_SIZE,
                    y: rowHeight(record) } : held.iconSpacing;
                return (spacing.y & 0xffff) << 16 | spacing.x & 0xffff;
            }
            case LVM.SETICONSPACING: {
                const previous = held.iconSpacing;
                const x = (lParam & 0xffff) << 16 >> 16;
                const y = lParam >> 16;
                held.iconSpacing = { x: x === -1 ? ICON_SPACING.x : x,
                    y: y === -1 ? ICON_SPACING.y : y };
                host.invalidate(record);
                return (previous.y & 0xffff) << 16 | previous.x & 0xffff;
            }
            case LVM.SETHOTITEM: {
                const previous = held.hot;
                held.hot = wParam | 0;
                return previous;
            }
            case LVM.GETHOTITEM:
                return held.hot;
            case LVM.SETHOVERTIME: {
                const previous = held.hover;
                held.hover = lParam | 0;
                return previous;
            }
            case LVM.GETHOVERTIME:
                return held.hover;
            case LVM.SETTOOLTIPS: {
                const previous = held.tooltips;
                held.tooltips = wParam >>> 0;
                return previous;
            }
            case LVM.GETTOOLTIPS:
                return held.tooltips;
            case LVM.SETVIEW: {
                const next = wParam >>> 0;
                if (next > 4)
                {
                    return -1;
                }
                held.view = next === 4 ? LVS_ICON : next;
                return after(view(record) === LVS_REPORT ? ensureHeader(record, thread) : 0,
                    ()=>after(placeHeader(record), ()=>{
                        host.invalidate(record);
                        return 1;
                    }));
            }
            case LVM.GETVIEW:
                return view(record);
            case LVM.SETSELECTEDCOLUMN:
                held.selectedColumn = wParam | 0;
                return 0;
            case LVM.GETSELECTEDCOLUMN:
                return held.selectedColumn;
            case LVM.ISITEMVISIBLE: {
                const index = wParam | 0;
                if (index < 0 || index >= count(record))
                {
                    return 0;
                }
                const box = bounds(record, index);
                const size = host.clientSize(record);
                return box.bottom > 0 && box.top < size.height && box.right > 0
                    && box.left < size.width ? 1 : 0;
            }
            case LVM.ARRANGE:
                if (view(record) === LVS_ICON || view(record) === LVS_SMALLICON)
                {
                    for (const item of held.items)
                    {
                        item.position = null;
                    }
                    host.invalidate(record);
                }
                return 1;
            case LVM.UPDATE:
            case LVM.REDRAWITEMS:
                host.invalidate(record);
                return 1;
            case LVM.APPROXIMATEVIEWRECT: {
                const items = (wParam | 0) < 0 ? count(record) : wParam | 0;
                if (view(record) === LVS_REPORT)
                {
                    const height = held.headerHeight + items * rowHeight(record);
                    return (height & 0xffff) << 16 | reportWidth(record) & 0xffff;
                }
                return 0;
            }
            case LVM.EDITLABELA:
            case LVM.EDITLABELW:
                notHere('label editing');
                return 0;
            case LVM.CREATEDRAGIMAGE:
                notHere('a drag image');
                return 0;
            case LVM.GETEDITCONTROL:
            case LVM.GETISEARCHSTRINGA:
            case LVM.GETISEARCHSTRINGW:
            case LVM.SETWORKAREAS:
            case LVM.GETWORKAREAS:
            case LVM.GETNUMBEROFWORKAREAS:
            case LVM.SETHOTCURSOR:
            case LVM.GETHOTCURSOR:
            case LVM.SETBKIMAGEA:
            case LVM.SETBKIMAGEW:
            case LVM.GETBKIMAGEA:
            case LVM.GETBKIMAGEW:
            case LVM.ENABLEGROUPVIEW:
            case LVM.ISGROUPVIEWENABLED:
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
