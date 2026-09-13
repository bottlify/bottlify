/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The window procedures of the system classes: Button, Static, Edit, ListBox,
 * ComboBox, ScrollBar and the dialog class.
 *
 * These run on this side rather than in the guest, because there is no
 * USER32.dll in the guest to hold them. To a program they are window
 * procedures like any other: a window of one of these classes has a procedure
 * address, GetWindowLong reads it, SetWindowLong replaces it, and
 * CallWindowProc reaches it -- the address is a stub the bridge traps back to
 * the handler here.
 *
 * What each class does is the observable half of the real one: what it paints,
 * which messages it answers and what it tells its parent. A push button is a
 * bordered box that sends BN_CLICKED when the mouse goes down and comes up
 * inside it; a static is text or a frame that a pointer passes through; an
 * edit is a line of text with a caret. The look is the classic one, from the
 * system colours, because the system colours are the one description of it a
 * program can also read.
 *
 * Each procedure takes the window record, the message and the thread whose
 * call it answers, and gives back the result -- or a promise of it when the
 * message reached guest code on the way, which is how a notification to a
 * parent whose procedure is the program's own is answered.
 */

import { layoutText } from './paint.js';

/** Messages the controls answer. */
export const WM_CREATE = 0x0001;
export const WM_SETFOCUS = 0x0007;
export const WM_KILLFOCUS = 0x0008;
export const WM_ENABLE = 0x000a;
export const WM_SETTEXT = 0x000c;
export const WM_GETTEXT = 0x000d;
export const WM_GETTEXTLENGTH = 0x000e;
export const WM_PAINT = 0x000f;
export const WM_CLOSE = 0x0010;
export const WM_ERASEBKGND = 0x0014;
export const WM_SHOWWINDOW = 0x0018;
export const WM_SETFONT = 0x0030;
export const WM_GETFONT = 0x0031;
export const WM_NCHITTEST = 0x0084;
export const WM_GETDLGCODE = 0x0087;
export const WM_KEYDOWN = 0x0100;
export const WM_KEYUP = 0x0101;
export const WM_CHAR = 0x0102;
export const WM_INITDIALOG = 0x0110;
export const WM_COMMAND = 0x0111;
export const WM_SYSCOMMAND = 0x0112;
export const WM_VSCROLL = 0x0115;
export const WM_HSCROLL = 0x0114;
export const WM_CTLCOLOREDIT = 0x0133;
export const WM_CTLCOLORLISTBOX = 0x0134;
export const WM_CTLCOLORBTN = 0x0135;
export const WM_CTLCOLORDLG = 0x0136;
export const WM_CTLCOLORSCROLLBAR = 0x0137;
export const WM_CTLCOLORSTATIC = 0x0138;
export const WM_MOUSEMOVE = 0x0200;
export const WM_LBUTTONDOWN = 0x0201;
export const WM_LBUTTONUP = 0x0202;
export const WM_LBUTTONDBLCLK = 0x0203;
export const WM_MOUSEWHEEL = 0x020a;
export const WM_CAPTURECHANGED = 0x0215;

/** Hit-test answers. */
export const HTTRANSPARENT = -1;
export const HTNOWHERE = 0;
export const HTCLIENT = 1;

/** WM_GETDLGCODE answers: what a control wants the dialog manager to leave to it. */
export const DLGC_WANTARROWS = 0x0001;
export const DLGC_WANTTAB = 0x0002;
export const DLGC_WANTALLKEYS = 0x0004;
export const DLGC_HASSETSEL = 0x0008;
export const DLGC_DEFPUSHBUTTON = 0x0010;
export const DLGC_UNDEFPUSHBUTTON = 0x0020;
export const DLGC_RADIOBUTTON = 0x0040;
export const DLGC_WANTCHARS = 0x0080;
export const DLGC_STATIC = 0x0100;
export const DLGC_BUTTON = 0x2000;

/** Virtual keys the controls act on. */
const VK_BACK = 0x08;
const VK_TAB = 0x09;
const VK_RETURN = 0x0d;
const VK_SHIFT = 0x10;
const VK_ESCAPE = 0x1b;
const VK_SPACE = 0x20;
const VK_PRIOR = 0x21;
const VK_NEXT = 0x22;
const VK_END = 0x23;
const VK_HOME = 0x24;
const VK_LEFT = 0x25;
const VK_UP = 0x26;
const VK_RIGHT = 0x27;
const VK_DOWN = 0x28;
const VK_DELETE = 0x2e;

/** Button styles: the kind is the low four bits. */
const BS_TYPEMASK = 0x0f;
const BS_PUSHBUTTON = 0x00;
const BS_DEFPUSHBUTTON = 0x01;
const BS_CHECKBOX = 0x02;
const BS_AUTOCHECKBOX = 0x03;
const BS_RADIOBUTTON = 0x04;
const BS_3STATE = 0x05;
const BS_AUTO3STATE = 0x06;
const BS_GROUPBOX = 0x07;
const BS_AUTORADIOBUTTON = 0x09;
const BS_OWNERDRAW = 0x0b;
const BS_LEFTTEXT = 0x20;
const BS_MULTILINE = 0x2000;
/** Without this a button reports clicks and nothing else. */
const BS_NOTIFY = 0x4000;
const PUSH_KINDS = new Set([BS_PUSHBUTTON, BS_DEFPUSHBUTTON]);
const CHECK_KINDS = new Set([BS_CHECKBOX, BS_AUTOCHECKBOX, BS_3STATE, BS_AUTO3STATE]);
const RADIO_KINDS = new Set([BS_RADIOBUTTON, BS_AUTORADIOBUTTON]);
const AUTO_KINDS = new Set([BS_AUTOCHECKBOX, BS_AUTO3STATE, BS_AUTORADIOBUTTON]);

/** Button messages and notifications. */
const BM_GETCHECK = 0x00f0;
const BM_SETCHECK = 0x00f1;
const BM_GETSTATE = 0x00f2;
const BM_SETSTATE = 0x00f3;
const BM_SETSTYLE = 0x00f4;
const BM_CLICK = 0x00f5;
const BST_UNCHECKED = 0;
const BST_CHECKED = 1;
const BST_INDETERMINATE = 2;
const BST_PUSHED = 4;
const BST_FOCUS = 8;
export const BN_CLICKED = 0;
const BN_SETFOCUS = 6;
const BN_KILLFOCUS = 7;
/** The box a check box or radio button draws, and the gap to its text. */
const CHECK_SIZE = 13;
const CHECK_GAP = 4;

/** Static styles: the kind is the low five bits. */
const SS_TYPEMASK = 0x1f;
const SS_CENTER = 0x01;
const SS_RIGHT = 0x02;
const SS_ICON = 0x03;
const SS_BLACKRECT = 0x04;
const SS_GRAYRECT = 0x05;
const SS_WHITERECT = 0x06;
const SS_BLACKFRAME = 0x07;
const SS_GRAYFRAME = 0x08;
const SS_WHITEFRAME = 0x09;
const SS_SIMPLE = 0x0b;
const SS_LEFTNOWORDWRAP = 0x0c;
const SS_OWNERDRAW = 0x0d;
const SS_BITMAP = 0x0e;
const SS_ETCHEDHORZ = 0x10;
const SS_ETCHEDVERT = 0x11;
const SS_ETCHEDFRAME = 0x12;
const SS_NOPREFIX = 0x80;
const SS_NOTIFY = 0x100;
const SS_CENTERIMAGE = 0x200;
const SS_SUNKEN = 0x1000;
const STM_SETICON = 0x170;
const STM_GETICON = 0x171;
const STM_SETIMAGE = 0x172;
const STM_GETIMAGE = 0x173;
const STN_CLICKED = 0;
const STN_DBLCLK = 1;
/** STM_SETIMAGE's image types. */
const IMAGE_BITMAP = 0;
const IMAGE_ICON = 1;

/** Edit styles and messages. */
const ES_MULTILINE = 0x0004;
const ES_PASSWORD = 0x0020;
const ES_AUTOHSCROLL = 0x0080;
const ES_READONLY = 0x0800;
const ES_WANTRETURN = 0x1000;
const EM_GETSEL = 0x00b0;
const EM_SETSEL = 0x00b1;
const EM_GETRECT = 0x00b2;
const EM_SCROLL = 0x00b5;
const EM_LINESCROLL = 0x00b6;
const EM_SCROLLCARET = 0x00b7;
const EM_GETMODIFY = 0x00b8;
const EM_SETMODIFY = 0x00b9;
const EM_GETLINECOUNT = 0x00ba;
const EM_LINEINDEX = 0x00bb;
const EM_LINELENGTH = 0x00c1;
const EM_REPLACESEL = 0x00c2;
const EM_GETLINE = 0x00c4;
const EM_LIMITTEXT = 0x00c5;
const EM_CANUNDO = 0x00c6;
const EM_EMPTYUNDOBUFFER = 0x00cd;
const EM_GETFIRSTVISIBLELINE = 0x00ce;
const EM_SETREADONLY = 0x00cf;
const EM_SETPASSWORDCHAR = 0x00cc;
const EM_GETPASSWORDCHAR = 0x00d2;
const EM_SETMARGINS = 0x00d3;
const EM_GETLIMITTEXT = 0x00d5;
const EM_POSFROMCHAR = 0x00d6;
const EM_CHARFROMPOS = 0x00d7;
const EN_SETFOCUS = 0x0100;
const EN_KILLFOCUS = 0x0200;
const EN_CHANGE = 0x0300;
const EN_UPDATE = 0x0400;
const EN_MAXTEXT = 0x0501;
/** The room an edit leaves between its border and its text. */
const EDIT_MARGIN = 1;
/** What a program that never set a limit may type: the documented default. */
const DEFAULT_EDIT_LIMIT = 0x7ffffffe;

/** List box styles, messages and notifications. */
const LBS_NOTIFY = 0x0001;
const LBS_SORT = 0x0002;
const LBS_MULTIPLESEL = 0x0008;
const LBS_EXTENDEDSEL = 0x0800;
const LBS_NOSEL = 0x4000;
const LB_ADDSTRING = 0x0180;
const LB_INSERTSTRING = 0x0181;
const LB_DELETESTRING = 0x0182;
const LB_RESETCONTENT = 0x0184;
const LB_SETSEL = 0x0185;
const LB_SETCURSEL = 0x0186;
const LB_GETSEL = 0x0187;
const LB_GETCURSEL = 0x0188;
const LB_GETTEXT = 0x0189;
const LB_GETTEXTLEN = 0x018a;
const LB_GETCOUNT = 0x018b;
const LB_GETTOPINDEX = 0x018e;
const LB_FINDSTRING = 0x018f;
const LB_GETSELCOUNT = 0x0190;
const LB_GETSELITEMS = 0x0191;
const LB_SETHORIZONTALEXTENT = 0x0194;
const LB_SETTOPINDEX = 0x0197;
const LB_GETITEMRECT = 0x0198;
const LB_GETITEMDATA = 0x0199;
const LB_SETITEMDATA = 0x019a;
const LB_SETITEMHEIGHT = 0x01a0;
const LB_GETITEMHEIGHT = 0x01a1;
const LB_FINDSTRINGEXACT = 0x01a2;
const LB_ERR = -1;
const LBN_SELCHANGE = 1;
const LBN_DBLCLK = 2;
const LBN_SETFOCUS = 4;
const LBN_KILLFOCUS = 5;

/** Combo box styles, messages and notifications. */
const CBS_TYPEMASK = 0x0003;
const CBS_SIMPLE = 0x0001;
const CBS_DROPDOWN = 0x0002;
const CBS_SORT = 0x0100;
const CB_GETEDITSEL = 0x0140;
const CB_LIMITTEXT = 0x0141;
const CB_SETEDITSEL = 0x0142;
const CB_ADDSTRING = 0x0143;
const CB_DELETESTRING = 0x0144;
const CB_GETCOUNT = 0x0146;
const CB_GETCURSEL = 0x0147;
const CB_GETLBTEXT = 0x0148;
const CB_GETLBTEXTLEN = 0x0149;
const CB_INSERTSTRING = 0x014a;
const CB_RESETCONTENT = 0x014b;
const CB_FINDSTRING = 0x014c;
const CB_SETCURSEL = 0x014e;
const CB_SHOWDROPDOWN = 0x014f;
const CB_GETITEMDATA = 0x0150;
const CB_SETITEMDATA = 0x0151;
const CB_GETDROPPEDCONTROLRECT = 0x0152;
const CB_SETEXTENDEDUI = 0x0155;
const CB_GETEXTENDEDUI = 0x0156;
const CB_GETDROPPEDSTATE = 0x0157;
const CB_FINDSTRINGEXACT = 0x0158;
const CB_SETDROPPEDWIDTH = 0x0160;
const CB_ERR = -1;
const CBN_SELCHANGE = 1;
const CBN_SETFOCUS = 3;
const CBN_KILLFOCUS = 4;
/** The drop button at the right of a combo box, as wide as a scroll bar. */
const COMBO_BUTTON = 16;

/** Scroll bar styles, messages and the codes a WM_VSCROLL carries. */
const SBS_VERT = 0x0001;
const SBM_SETPOS = 0x00e0;
const SBM_GETPOS = 0x00e1;
const SBM_SETRANGE = 0x00e2;
const SBM_GETRANGE = 0x00e3;
const SBM_ENABLE_ARROWS = 0x00e4;
const SBM_SETRANGEREDRAW = 0x00e6;
const SBM_SETSCROLLINFO = 0x00e9;
const SBM_GETSCROLLINFO = 0x00ea;
export const SB_LINEUP = 0;
export const SB_LINEDOWN = 1;
export const SB_PAGEUP = 2;
export const SB_PAGEDOWN = 3;
export const SB_THUMBPOSITION = 4;
export const SB_THUMBTRACK = 5;
export const SB_TOP = 6;
export const SB_BOTTOM = 7;
export const SB_ENDSCROLL = 8;
/** SetScrollInfo's bar for the control itself. */
const SB_CTL = 2;
/** SCROLLINFO, as SBM_SETSCROLLINFO and SBM_GETSCROLLINFO carry it. */
const SCROLLINFO = Object.freeze({
    cbSize: 0, fMask: 4, nMin: 8, nMax: 12, nPage: 16, nPos: 20, nTrackPos: 24, SIZE: 28,
});
const SIF_RANGE = 0x0001;
const SIF_PAGE = 0x0002;
const SIF_POS = 0x0004;
const SIF_TRACKPOS = 0x0010;
/** How long a scroll bar's arrow button is, along the bar. */
const ARROW_LENGTH = 16;

/** The dialog class: its messages, its extra bytes and what it answers Enter with. */
export const DLGWINDOWEXTRA = 30;
export const DWLP_MSGRESULT = 0;
export const DWLP_DLGPROC = 4;
export const DWLP_USER = 8;
const DM_GETDEFID = 0x0400;
const DM_SETDEFID = 0x0401;
const DC_HASDEFID = 0x534b;
export const IDOK = 1;
export const IDCANCEL = 2;

/** DrawText flags the controls lay text out with. */
const DT_CENTER = 0x0001;
const DT_RIGHT = 0x0002;
const DT_VCENTER = 0x0004;
const DT_WORDBREAK = 0x0010;
const DT_SINGLELINE = 0x0020;
const DT_NOPREFIX = 0x0800;

/** System colour indices, as GetSysColor numbers them. */
export const COLOR_SCROLLBAR = 0;
export const COLOR_WINDOW = 5;
export const COLOR_WINDOWFRAME = 6;
export const COLOR_WINDOWTEXT = 8;
export const COLOR_HIGHLIGHT = 13;
export const COLOR_HIGHLIGHTTEXT = 14;
export const COLOR_3DFACE = 15;
export const COLOR_3DSHADOW = 16;
export const COLOR_GRAYTEXT = 17;
export const COLOR_BTNTEXT = 18;
export const COLOR_3DHILIGHT = 20;
export const COLOR_3DDKSHADOW = 21;

/** Nothing bounds a string a program sets on a control, so something has to. */
const MAX_TEXT = 1 << 16;

/**
 * The check mark, the radio dot and the radio ring as pixel rows: what the
 * classic controls draw, at the size they draw it. Data rather than geometry
 * because a thirteen-pixel circle is not a circle by any formula.
 */
const CHECK_MARK = [
    '......#',
    '.....##',
    '#...###',
    '##.###.',
    '#####..',
    '.###...',
    '..#....',
];
const RADIO_RING_DARK = [
    '....####....',
    '..##....##..',
    '.#........#.',
    '.#..........',
    '#...........',
    '#...........',
    '#...........',
    '#...........',
    '.#..........',
    '.#..........',
    '............',
    '............',
];
const RADIO_RING_LIGHT = [
    '............',
    '............',
    '..........#.',
    '..........#.',
    '...........#',
    '...........#',
    '...........#',
    '...........#',
    '..........#.',
    '.#........#.',
    '..##....##..',
    '....####....',
];
const RADIO_DOT = [
    '.##.',
    '####',
    '####',
    '.##.',
];

/**
 * @typedef {Object} Rect
 * @property {number} left
 * @property {number} top
 * @property {number} right
 * @property {number} bottom
 */

/**
 * @typedef {Object} ControlMessage
 * @property {number} hwnd
 * @property {number} message
 * @property {number} wParam
 * @property {number} lParam
 */

/**
 * The drawing the window manager does itself, as gdi32 offers it.
 *
 * @typedef {Object} Drawing
 * @property {(color: number) => number} solidBrush
 * @property {(hdc: number, rect: Rect, color: number) => boolean} fill
 * @property {(hdc: number, rect: Rect, brush: number) => boolean} fillWith
 * @property {(hdc: number, rect: Rect, brush: number) => boolean} frame
 * @property {(hdc: number, rect: Rect) => boolean} invert
 * @property {(hdc: number, x: number, y: number, text: string,
 *     options?: { color?: number, clip?: Rect | null }) => boolean} text
 * @property {(hdc: number, text: string) => { width: number, height: number,
 *     ascent: number }} measure
 * @property {(hdc: number, x: number, y: number, bitmap: number) => boolean} bitmap
 */

/**
 * What the procedures need from the window manager around them.
 *
 * @typedef {Object} ControlHost
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {Drawing | null} draw
 * @property {(hwnd: number) => any | null} live
 * @property {(hwnd: number) => any | null} windowOf   Live or destroyed.
 * @property {(record: any) => { width: number, height: number }} clientSize
 * @property {(hwnd: number, message: number, wParam: number, lParam: number,
 *     thread?: unknown) => number | Promise<number>} send
 * @property {(message: { hwnd: number, message: number, wParam: number,
 *     lParam: number }) => void} post
 * @property {(record: any, message: ControlMessage, thread?: unknown) => number | Promise<number>}
 *     defWindowProc
 * @property {(record: any) => any[]} children   Its live children, in order.
 * @property {(address: number, message: ControlMessage, thread?: unknown)
 *     => number | Promise<number>} callProcedure
 *           Runs a window procedure by address: a program's own dialog procedure.
 * @property {(record: any) => { hdc: number, rect: Rect }
 *     | Promise<{ hdc: number, rect: Rect }>} beginPaint
 *           A device context on the window's client area, the update area
 *           cleared and erased. Zero when the build cannot draw.
 * @property {(record: any) => { hdc: number, rect: Rect }} contextOn
 *           The same context with the update area left alone, for
 *           measuring with; given back through endPaint.
 * @property {(record: any, hdc: number) => void} endPaint
 * @property {(record: any) => void} invalidate   The whole client area, erased.
 * @property {(hwnd: number, thread?: unknown) => number | Promise<number>} setFocus
 * @property {() => number} focus
 * @property {(hwnd: number) => void} setCapture
 * @property {() => number} capture
 * @property {() => void} releaseCapture
 * @property {(index: number) => number} sysColor
 * @property {(key: number) => boolean} keyDown
 * @property {(api: string, detail: string) => void} [divergence]
 */

/**
 * Continues with an answer that may still be on its way: a message that
 * reached guest code is answered with a promise, one that did not with a
 * value, and the caller need not care which.
 *
 * @template T
 * @param {T | Promise<T>} value @param {(answer: T) => any} then
 * @returns {any}
 */
export const after = (value, then)=>(typeof (/** @type {any} */ (value))?.then === 'function'
    ? /** @type {Promise<T>} */ (value).then(then)
    : then(/** @type {T} */ (value)));

/** @param {Rect} rect @param {number} by */
const shrink = (rect, by)=>({
    left: rect.left + by, top: rect.top + by, right: rect.right - by, bottom: rect.bottom - by,
});

/** @param {Rect} rect @param {number} x @param {number} y */
const contains = (rect, x, y)=>x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;

/** @param {number} lParam @returns {{ x: number, y: number }} the packed point, signed */
export const pointOf = lParam=>({
    x: (lParam & 0xffff) << 16 >> 16,
    y: (lParam >>> 16) << 16 >> 16,
});

/**
 * @typedef {(record: any, message: ControlMessage, thread?: unknown)
 *     => number | Promise<number>} ControlProcedure
 */

/**
 * @typedef {Object} ScrollBarState
 * @property {number} min
 * @property {number} max
 * @property {number} page
 * @property {number} pos
 */

/**
 * Builds the procedures, one per class name, and the pieces the frame
 * shares with them.
 *
 * @param {ControlHost} host
 * @returns {{ procedures: Record<string, ControlProcedure>,
 *     helpers: { defDlgProc: ControlProcedure,
 *         paintScrollBar: (hdc: number, rect: Rect, vertical: boolean,
 *             held: ScrollBarState) => void,
 *         scrollHit: (rect: Rect, vertical: boolean, held: ScrollBarState,
 *             x: number, y: number) => number } }}
 */
export function createControlProcedures(host){
    /** @param {number} index */
    const color = index=>host.sysColor(index);

    /**
     * One pixel-row picture, drawn in a colour at a point: how a check mark
     * and a radio button's ring are put down.
     *
     * @param {number} hdc @param {string[]} rows @param {number} x @param {number} y
     * @param {number} rgb
     */
    const glyph = (hdc, rows, x, y, rgb)=>{
        const draw = /** @type {Drawing} */ (host.draw);
        rows.forEach((row, dy)=>{
            for (let dx = 0; dx < row.length; dx++)
            {
                if (row[dx] === '#')
                {
                    draw.fill(hdc, { left: x + dx, top: y + dy, right: x + dx + 1,
                        bottom: y + dy + 1 }, rgb);
                }
            }
        });
    };

    /**
     * A raised or sunken edge one pixel wide on each side, in two colours:
     * top-left in one, bottom-right in the other.
     *
     * @param {number} hdc @param {Rect} rect @param {number} topLeft @param {number} bottomRight
     */
    const edge = (hdc, rect, topLeft, bottomRight)=>{
        const draw = /** @type {Drawing} */ (host.draw);
        draw.fill(hdc, { left: rect.left, top: rect.top, right: rect.right - 1,
            bottom: rect.top + 1 }, topLeft);
        draw.fill(hdc, { left: rect.left, top: rect.top, right: rect.left + 1,
            bottom: rect.bottom - 1 }, topLeft);
        draw.fill(hdc, { left: rect.left, top: rect.bottom - 1, right: rect.right,
            bottom: rect.bottom }, bottomRight);
        draw.fill(hdc, { left: rect.right - 1, top: rect.top, right: rect.right,
            bottom: rect.bottom }, bottomRight);
    };

    /**
     * The two-pixel raised edge of a button, or its sunken form when pressed.
     *
     * @param {number} hdc @param {Rect} rect @param {boolean} pressed
     */
    const buttonEdge = (hdc, rect, pressed)=>{
        if (pressed)
        {
            edge(hdc, rect, color(COLOR_3DSHADOW), color(COLOR_3DHILIGHT));
            edge(hdc, shrink(rect, 1), color(COLOR_3DDKSHADOW), color(COLOR_3DFACE));
            return;
        }
        edge(hdc, rect, color(COLOR_3DHILIGHT), color(COLOR_3DDKSHADOW));
        edge(hdc, shrink(rect, 1), color(COLOR_3DFACE), color(COLOR_3DSHADOW));
    };

    /**
     * The sunken two-pixel edge an edit or list box has.
     *
     * @param {number} hdc @param {Rect} rect
     */
    const sunkenEdge = (hdc, rect)=>{
        edge(hdc, rect, color(COLOR_3DSHADOW), color(COLOR_3DHILIGHT));
        edge(hdc, shrink(rect, 1), color(COLOR_3DDKSHADOW), color(COLOR_3DFACE));
    };

    /**
     * An etched line or frame: a shadow line with a highlight beside it.
     *
     * @param {number} hdc @param {Rect} rect
     */
    const etchedFrame = (hdc, rect)=>{
        edge(hdc, rect, color(COLOR_3DSHADOW), color(COLOR_3DHILIGHT));
        edge(hdc, shrink(rect, 1), color(COLOR_3DHILIGHT), color(COLOR_3DSHADOW));
    };

    /**
     * Text laid out in a rectangle the way DrawText lays it, drawn in a
     * colour, with the mnemonic's underline.
     *
     * @param {number} hdc @param {string} text @param {Rect} rect @param {number} format
     * @param {number} rgb
     */
    const drawText = (hdc, text, rect, format, rgb)=>{
        const draw = /** @type {Drawing} */ (host.draw);
        const metrics = draw.measure(hdc, 'M');
        /** @param {string} piece */
        const widthOf = piece=>draw.measure(hdc, piece).width;
        const lines = layoutText(text, rect, format, {
            cellWidth: metrics.width, cellHeight: metrics.height, width: widthOf,
        });
        for (const line of lines)
        {
            draw.text(hdc, line.x, line.y, line.text, { color: rgb, clip: rect });
            if (line.underline !== null)
            {
                const at = line.x + widthOf(line.text.slice(0, line.underline));
                draw.fill(hdc, { left: at, top: line.y + metrics.ascent,
                    right: at + widthOf(line.text[line.underline]),
                    bottom: line.y + metrics.ascent + 1 }, rgb);
            }
        }
    };

    /** @param {any} record @returns {Rect} */
    const clientRect = record=>{
        const size = host.clientSize(record);
        return { left: 0, top: 0, right: size.width, bottom: size.height };
    };

    /** @param {any} record @returns {any} the control's own state, made on first use */
    const stateOf = record=>{
        record.control ??= {};
        return record.control;
    };

    /**
     * Tells the parent something happened: WM_COMMAND with the control's
     * id and the notification code, as every control does.
     *
     * @param {any} record @param {number} code @param {unknown} [thread]
     */
    const notify = (record, code, thread)=>(record.parent
        ? host.send(record.parent, WM_COMMAND,
            ((code & 0xffff) << 16 | record.id & 0xffff) >>> 0, record.hwnd, thread)
        : 0);

    /**
     * Asks the parent which brush a control's background is painted with:
     * the WM_CTLCOLOR* handshake. A parent that answers zero -- or is not
     * there -- leaves the control to its own colour.
     *
     * @param {any} record @param {number} message @param {number} hdc @param {unknown} [thread]
     * @returns {number | Promise<number>} a brush handle, or zero
     */
    const controlColor = (record, message, hdc, thread)=>(record.parent
        ? host.send(record.parent, message, hdc, record.hwnd, thread)
        : 0);

    /**
     * Fills the client area with the brush the parent chose, or the given
     * colour when it chose none.
     *
     * @param {number} hdc @param {Rect} rect @param {number} brush @param {number} fallback
     */
    const background = (hdc, rect, brush, fallback)=>{
        const draw = /** @type {Drawing} */ (host.draw);
        if ((brush >>> 0) !== 0)
        {
            draw.fillWith(hdc, rect, brush);
        }
        else
        {
            draw.fill(hdc, rect, color(fallback));
        }
    };

    /**
     * Runs a paint: BeginPaint, the drawing, EndPaint, with the drawing
     * allowed to have asked the parent something on the way.
     *
     * @param {any} record
     * @param {(hdc: number, rect: Rect) => number | Promise<number> | void} paint
     */
    const painting = (record, paint)=>after(host.beginPaint(record), ({ hdc, rect })=>{
        if (hdc === 0 || !host.draw)
        {
            host.endPaint(record, hdc);
            return 0;
        }
        return after(paint(hdc, rect), ()=>{
            host.endPaint(record, hdc);
            return 0;
        });
    });

    /**
     * What every control does with the messages it has no opinion about:
     * text, font and the rest go to the default procedure, and a change of
     * text or enabled state repaints.
     *
     * @param {any} record @param {ControlMessage} message @param {unknown} [thread]
     */
    const common = (record, message, thread)=>{
        switch (message.message){
            case WM_SETTEXT:
            case WM_ENABLE:
                return after(host.defWindowProc(record, message, thread), answer=>{
                    host.invalidate(record);
                    return answer;
                });
            case WM_SETFONT:
                record.font = message.wParam >>> 0;
                if ((message.lParam & 0xffff) !== 0)
                {
                    host.invalidate(record);
                }
                return 0;
            case WM_GETFONT:
                return record.font ?? 0;
            default:
                return host.defWindowProc(record, message, thread);
        }
    };

    /** @param {any} record */
    const disabled = record=>(record.style & 0x08000000) !== 0;

    // --- Button -------------------------------------------------------------

    /** @param {any} record */
    const buttonKind = record=>record.style & BS_TYPEMASK;

    /**
     * A click, however it arrived: the auto kinds change their own state,
     * and the parent is told.
     *
     * @param {any} record @param {unknown} [thread]
     */
    const clickButton = (record, thread)=>{
        const state = stateOf(record);
        const kind = buttonKind(record);
        if (AUTO_KINDS.has(kind))
        {
            if (kind === BS_AUTORADIOBUTTON)
            {
                checkRadio(record);
            }
            else if (kind === BS_AUTO3STATE)
            {
                state.check = ((state.check ?? 0) + 1) % 3;
            }
            else
            {
                state.check = state.check === BST_CHECKED ? BST_UNCHECKED : BST_CHECKED;
            }
            host.invalidate(record);
        }
        return notify(record, BN_CLICKED, thread);
    };

    /**
     * Checks one radio button and clears its siblings back to the previous
     * WS_GROUP: the group is the run of siblings in creation order.
     *
     * @param {any} record
     */
    const checkRadio = record=>{
        const WS_GROUP = 0x00020000;
        const siblings = siblingsOf(record);
        const at = siblings.indexOf(record);
        let first = at;
        while (first > 0 && (siblings[first].style & WS_GROUP) === 0)
        {
            first--;
        }
        for (let index = first; index < siblings.length; index++)
        {
            if (index > first && (siblings[index].style & WS_GROUP) !== 0)
            {
                break;
            }
            const sibling = siblings[index];
            if (sibling.className === 'Button' && RADIO_KINDS.has(buttonKind(sibling)))
            {
                const was = stateOf(sibling).check ?? BST_UNCHECKED;
                stateOf(sibling).check = sibling === record ? BST_CHECKED : BST_UNCHECKED;
                if (was !== stateOf(sibling).check)
                {
                    host.invalidate(sibling);
                }
            }
        }
    };

    /** @param {any} record @returns {any[]} the live children of its parent, in order */
    const siblingsOf = record=>{
        const parent = host.windowOf(record.parent);
        return parent ? host.children(parent) : [record];
    };

    /**
     * @param {any} record @param {number} hdc @param {Rect} rect
     * @param {number} brush  What the parent answered for the background.
     */
    const paintButton = (record, hdc, rect, brush)=>{
        const draw = /** @type {Drawing} */ (host.draw);
        const state = stateOf(record);
        const kind = buttonKind(record);
        const text = record.title;
        const ink = color(disabled(record) ? COLOR_GRAYTEXT : COLOR_BTNTEXT);
        const multi = (record.style & BS_MULTILINE) !== 0 ? DT_WORDBREAK : DT_SINGLELINE;

        if (PUSH_KINDS.has(kind) || kind === BS_OWNERDRAW)
        {
            let box = rect;
            draw.fill(hdc, rect, color(COLOR_3DFACE));
            if (kind === BS_DEFPUSHBUTTON || state.default)
            {
                // The default button wears one more ring, in the frame colour.
                edge(hdc, box, color(COLOR_WINDOWFRAME), color(COLOR_WINDOWFRAME));
                box = shrink(box, 1);
            }
            buttonEdge(hdc, box, state.pushed === true);
            const inside = shrink(box, 2);
            const shifted = state.pushed
                ? { left: inside.left + 1, top: inside.top + 1, right: inside.right + 1,
                    bottom: inside.bottom + 1 }
                : inside;
            drawText(hdc, text, shifted, DT_CENTER | DT_VCENTER | multi, ink);
            return;
        }

        if (kind === BS_GROUPBOX)
        {
            const metrics = draw.measure(hdc, text);
            // The frame runs through the middle of the first text line, and
            // the text sits on a patch of face colour cut out of it.
            const frame = { ...rect, top: rect.top + Math.floor(metrics.height / 2) };
            etchedFrame(hdc, frame);
            if (text.length > 0)
            {
                const label = { left: rect.left + 8, top: rect.top,
                    right: rect.left + 8 + metrics.width + 4, bottom: rect.top + metrics.height };
                background(hdc, label, brush, COLOR_3DFACE);
                drawText(hdc, text, { ...label, left: label.left + 2 }, DT_SINGLELINE, ink);
            }
            return;
        }

        // Check boxes and radio buttons: the mark to the left of the text, or
        // to the right of it with BS_LEFTTEXT, vertically centred.
        background(hdc, rect, brush, COLOR_3DFACE);
        const leftText = (record.style & BS_LEFTTEXT) !== 0;
        const top = rect.top + Math.max(0, Math.floor((rect.bottom - rect.top - CHECK_SIZE) / 2));
        const left = leftText ? rect.right - CHECK_SIZE : rect.left;
        const box = { left, top, right: left + CHECK_SIZE, bottom: top + CHECK_SIZE };
        const check = state.check ?? BST_UNCHECKED;
        const face = color(disabled(record) || state.pushed ? COLOR_3DFACE : COLOR_WINDOW);
        if (RADIO_KINDS.has(kind))
        {
            glyph(hdc, RADIO_RING_DARK, box.left, box.top, color(COLOR_3DSHADOW));
            glyph(hdc, RADIO_RING_LIGHT, box.left, box.top, color(COLOR_3DHILIGHT));
            draw.fill(hdc, shrink(box, 3), face);
            if (check !== BST_UNCHECKED)
            {
                glyph(hdc, RADIO_DOT, box.left + 4, box.top + 4, ink);
            }
        }
        else
        {
            sunkenEdge(hdc, box);
            draw.fill(hdc, shrink(box, 2), check === BST_INDETERMINATE
                ? color(COLOR_3DFACE) : face);
            if (check === BST_CHECKED)
            {
                glyph(hdc, CHECK_MARK, box.left + 3, box.top + 3, ink);
            }
        }
        const textRect = leftText
            ? { ...rect, right: box.left - CHECK_GAP }
            : { ...rect, left: box.right + CHECK_GAP };
        drawText(hdc, text, textRect, DT_VCENTER | multi, ink);
    };

    /**
     * @param {any} record @param {ControlMessage} message @param {unknown} [thread]
     */
    const buttonProc = (record, message, thread)=>{
        const state = stateOf(record);
        const kind = buttonKind(record);
        switch (message.message){
            case WM_PAINT:
                return painting(record, (hdc, rect)=>{
                    const asked = PUSH_KINDS.has(kind) ? WM_CTLCOLORBTN : WM_CTLCOLORSTATIC;
                    return after(controlColor(record, asked, hdc, thread), brush=>{
                        paintButton(record, hdc, rect, brush);
                        return 0;
                    });
                });
            case WM_ERASEBKGND:
                // The paint covers the whole client area, so there is no
                // background to erase separately -- erasing it first would
                // paint every button twice.
                return 1;
            case WM_GETDLGCODE:
                if (PUSH_KINDS.has(kind))
                {
                    return DLGC_BUTTON | (kind === BS_DEFPUSHBUTTON || state.default
                        ? DLGC_DEFPUSHBUTTON : DLGC_UNDEFPUSHBUTTON);
                }
                if (RADIO_KINDS.has(kind))
                {
                    return DLGC_BUTTON | DLGC_RADIOBUTTON;
                }
                return kind === BS_GROUPBOX ? DLGC_STATIC : DLGC_BUTTON;
            case WM_NCHITTEST:
                return kind === BS_GROUPBOX ? HTTRANSPARENT : HTCLIENT;
            case WM_LBUTTONDOWN:
            case WM_LBUTTONDBLCLK:
                if (disabled(record) || kind === BS_GROUPBOX)
                {
                    return 0;
                }
                host.setCapture(record.hwnd);
                state.pushed = true;
                host.invalidate(record);
                return after(host.setFocus(record.hwnd, thread), ()=>0);
            case WM_MOUSEMOVE: {
                if (host.capture() !== record.hwnd)
                {
                    return 0;
                }
                const point = pointOf(message.lParam);
                const inside = contains(clientRect(record), point.x, point.y);
                if (inside !== (state.pushed === true))
                {
                    state.pushed = inside;
                    host.invalidate(record);
                }
                return 0;
            }
            case WM_LBUTTONUP: {
                if (host.capture() !== record.hwnd)
                {
                    return 0;
                }
                host.releaseCapture();
                const wasPushed = state.pushed === true;
                state.pushed = false;
                host.invalidate(record);
                const point = pointOf(message.lParam);
                return wasPushed && contains(clientRect(record), point.x, point.y)
                    ? clickButton(record, thread)
                    : 0;
            }
            case WM_KEYDOWN:
                if (message.wParam === VK_SPACE && !disabled(record) && kind !== BS_GROUPBOX)
                {
                    state.pushed = true;
                    host.invalidate(record);
                }
                return 0;
            case WM_KEYUP:
                if (message.wParam === VK_SPACE && state.pushed)
                {
                    state.pushed = false;
                    host.invalidate(record);
                    return clickButton(record, thread);
                }
                return 0;
            // The focus notifications go out only with BS_NOTIFY, as
            // documented: a parent that looks at the id alone and not the
            // code would otherwise take a focus change for a click.
            case WM_SETFOCUS:
                state.focused = true;
                host.invalidate(record);
                return (record.style & BS_NOTIFY) !== 0 ? notify(record, BN_SETFOCUS, thread) : 0;
            case WM_KILLFOCUS:
                state.focused = false;
                state.pushed = false;
                host.invalidate(record);
                return (record.style & BS_NOTIFY) !== 0 ? notify(record, BN_KILLFOCUS, thread) : 0;
            case WM_CAPTURECHANGED:
                if (state.pushed)
                {
                    state.pushed = false;
                    host.invalidate(record);
                }
                return 0;
            case BM_GETCHECK:
                return state.check ?? BST_UNCHECKED;
            case BM_SETCHECK:
                if (CHECK_KINDS.has(kind) || RADIO_KINDS.has(kind))
                {
                    const wanted = message.wParam === BST_INDETERMINATE
                        && (kind === BS_3STATE || kind === BS_AUTO3STATE)
                        ? BST_INDETERMINATE
                        : (message.wParam === BST_UNCHECKED ? BST_UNCHECKED : BST_CHECKED);
                    if ((state.check ?? BST_UNCHECKED) !== wanted)
                    {
                        state.check = wanted;
                        host.invalidate(record);
                    }
                }
                return 0;
            case BM_GETSTATE:
                return (state.check ?? BST_UNCHECKED)
                    | (state.pushed ? BST_PUSHED : 0) | (state.focused ? BST_FOCUS : 0);
            case BM_SETSTATE:
                state.pushed = message.wParam !== 0;
                host.invalidate(record);
                return 0;
            case BM_SETSTYLE:
                record.style = ((record.style & ~BS_TYPEMASK)
                    | (message.wParam & BS_TYPEMASK)) >>> 0;
                if ((message.lParam & 0xffff) !== 0)
                {
                    host.invalidate(record);
                }
                return 0;
            case BM_CLICK:
                return clickButton(record, thread);
            default:
                return common(record, message, thread);
        }
    };

    // --- Static -------------------------------------------------------------

    /**
     * @param {any} record @param {number} hdc @param {Rect} rect @param {number} brush
     */
    const paintStatic = (record, hdc, rect, brush)=>{
        const draw = /** @type {Drawing} */ (host.draw);
        const kind = record.style & SS_TYPEMASK;
        const state = stateOf(record);
        switch (kind){
            case SS_BLACKRECT:
                return draw.fill(hdc, rect, color(COLOR_3DDKSHADOW));
            case SS_GRAYRECT:
                return draw.fill(hdc, rect, color(COLOR_3DSHADOW));
            case SS_WHITERECT:
                return draw.fill(hdc, rect, color(COLOR_3DHILIGHT));
            case SS_BLACKFRAME:
                return draw.frame(hdc, rect, draw.solidBrush(color(COLOR_3DDKSHADOW)));
            case SS_GRAYFRAME:
                return draw.frame(hdc, rect, draw.solidBrush(color(COLOR_3DSHADOW)));
            case SS_WHITEFRAME:
                return draw.frame(hdc, rect, draw.solidBrush(color(COLOR_3DHILIGHT)));
            case SS_ETCHEDHORZ:
                return etchedFrame(hdc, { ...rect, bottom: rect.top + 2 });
            case SS_ETCHEDVERT:
                return etchedFrame(hdc, { ...rect, right: rect.left + 2 });
            case SS_ETCHEDFRAME:
                return etchedFrame(hdc, rect);
            case SS_ICON:
            case SS_BITMAP: {
                background(hdc, rect, brush, COLOR_3DFACE);
                const image = state.image ?? 0;
                if (image !== 0 && !draw.bitmap(hdc, rect.left, rect.top, image)
                    && !state.imageDivergenceSaid)
                {
                    state.imageDivergenceSaid = true;
                    host.divergence?.('Static',
                        `an SS_${kind === SS_ICON ? 'ICON' : 'BITMAP'} image without pixels this`
                        + ' build can draw is left blank');
                }
                return true;
            }
            case SS_OWNERDRAW:
                return background(hdc, rect, brush, COLOR_3DFACE);
            default:
                break;
        }
        background(hdc, rect, brush, COLOR_3DFACE);
        let inside = rect;
        if ((record.style & SS_SUNKEN) !== 0)
        {
            edge(hdc, rect, color(COLOR_3DSHADOW), color(COLOR_3DHILIGHT));
            inside = shrink(rect, 1);
        }
        const format = (kind === SS_CENTER ? DT_CENTER : kind === SS_RIGHT ? DT_RIGHT : 0)
            | (kind === SS_LEFTNOWORDWRAP || kind === SS_SIMPLE ? 0 : DT_WORDBREAK)
            | (kind === SS_SIMPLE ? DT_SINGLELINE : 0)
            | ((record.style & SS_CENTERIMAGE) !== 0 ? DT_VCENTER | DT_SINGLELINE : 0)
            | ((record.style & SS_NOPREFIX) !== 0 ? DT_NOPREFIX : 0);
        drawText(hdc, record.title, inside, format,
            color(disabled(record) ? COLOR_GRAYTEXT : COLOR_WINDOWTEXT));
        return true;
    };

    /**
     * @param {any} record @param {ControlMessage} message @param {unknown} [thread]
     */
    const staticProc = (record, message, thread)=>{
        const state = stateOf(record);
        switch (message.message){
            case WM_PAINT:
                return painting(record, (hdc, rect)=>after(
                    controlColor(record, WM_CTLCOLORSTATIC, hdc, thread), brush=>{
                        paintStatic(record, hdc, rect, brush);
                        return 0;
                    }));
            case WM_ERASEBKGND:
                return 1;
            case WM_NCHITTEST:
                return (record.style & SS_NOTIFY) !== 0 ? HTCLIENT : HTTRANSPARENT;
            case WM_GETDLGCODE:
                return DLGC_STATIC;
            case WM_LBUTTONDOWN:
                return (record.style & SS_NOTIFY) !== 0 ? notify(record, STN_CLICKED, thread) : 0;
            case WM_LBUTTONDBLCLK:
                return (record.style & SS_NOTIFY) !== 0 ? notify(record, STN_DBLCLK, thread) : 0;
            case STM_SETICON:
            case STM_SETIMAGE: {
                const previous = state.image ?? 0;
                state.image = (message.message === STM_SETICON
                    ? message.wParam : message.lParam) >>> 0;
                state.imageType = message.message === STM_SETICON
                    ? IMAGE_ICON : message.wParam & 0xffff;
                host.invalidate(record);
                return previous;
            }
            case STM_GETICON:
                return state.imageType === IMAGE_ICON ? state.image ?? 0 : 0;
            case STM_GETIMAGE:
                return (state.imageType ?? IMAGE_BITMAP) === (message.wParam & 0xffff)
                    ? state.image ?? 0 : 0;
            default:
                return common(record, message, thread);
        }
    };

    // --- Edit ---------------------------------------------------------------

    /** @param {any} record */
    const editState = record=>{
        const state = stateOf(record);
        state.selStart ??= 0;
        state.selEnd ??= 0;
        state.firstLine ??= 0;
        state.limit ??= DEFAULT_EDIT_LIMIT;
        state.modified ??= false;
        return state;
    };

    /** @param {any} record */
    const multiline = record=>(record.style & ES_MULTILINE) !== 0;

    /**
     * The lines an edit shows, each with the index of its first character in
     * the text, so a caret position maps to a line and back. A single-line
     * edit is one line; a multi-line one breaks at CR LF and, without
     * ES_AUTOHSCROLL, wraps at the client width.
     *
     * @param {any} record @param {number} columns  Characters that fit across.
     * @returns {{ text: string, start: number }[]}
     */
    const editLines = (record, columns)=>{
        const text = record.title;
        if (!multiline(record))
        {
            return [{ text, start: 0 }];
        }
        /** @type {{ text: string, start: number }[]} */
        const lines = [];
        let at = 0;
        const wrap = (record.style & ES_AUTOHSCROLL) === 0 && columns > 0;
        for (const paragraph of text.split(/\r\n|\r|\n/))
        {
            const start = at;
            // The break itself is counted in the paragraph's length so the
            // next line's start is right, but it is no part of any line.
            at += paragraph.length;
            const broke = text.slice(at, at + 2);
            at += broke === '\r\n' ? 2 : (broke.length > 0 ? 1 : 0);
            if (!wrap || paragraph.length <= columns)
            {
                lines.push({ text: paragraph, start });
                continue;
            }
            let from = 0;
            while (paragraph.length - from > columns)
            {
                let cut = paragraph.lastIndexOf(' ', from + columns);
                cut = cut <= from ? from + columns : cut + 1;
                lines.push({ text: paragraph.slice(from, cut), start: start + from });
                from = cut;
            }
            lines.push({ text: paragraph.slice(from), start: start + from });
        }
        return lines;
    };

    /**
     * How many characters fit across, and lines down, the client area.
     *
     * @param {any} record @param {number} hdc
     */
    const editGrid = (record, hdc)=>{
        const draw = /** @type {Drawing} */ (host.draw);
        const metrics = draw.measure(hdc, 'M');
        const size = host.clientSize(record);
        return {
            cellWidth: metrics.width,
            cellHeight: metrics.height,
            columns: Math.max(1, Math.floor((size.width - 2 * EDIT_MARGIN) / metrics.width)),
            rows: Math.max(1, Math.floor(size.height / metrics.height)),
        };
    };

    /**
     * Shows the text as the program may read it: a password edit shows its
     * password character, which is what makes it one.
     *
     * @param {any} record @param {string} text
     */
    const shown = (record, text)=>((record.style & ES_PASSWORD) !== 0
        ? String.fromCharCode(stateOf(record).passwordChar ?? 0x2a).repeat(text.length)
        : text);

    /**
     * @param {any} record @param {number} hdc @param {Rect} rect @param {number} brush
     */
    const paintEdit = (record, hdc, rect, brush)=>{
        const draw = /** @type {Drawing} */ (host.draw);
        const state = editState(record);
        const readOnly = (record.style & ES_READONLY) !== 0 || disabled(record);
        background(hdc, rect, brush, readOnly ? COLOR_3DFACE : COLOR_WINDOW);
        const grid = editGrid(record, hdc);
        const lines = editLines(record, grid.columns);
        const ink = color(disabled(record) ? COLOR_GRAYTEXT : COLOR_WINDOWTEXT);
        const selection = {
            from: Math.min(state.selStart, state.selEnd),
            to: Math.max(state.selStart, state.selEnd),
        };
        const focused = host.focus() === record.hwnd;
        // A single line is centred vertically as the real control centres
        // it; a multi-line edit starts at the top and shows from firstLine.
        const top = multiline(record)
            ? rect.top + EDIT_MARGIN
            : rect.top + Math.max(0, Math.floor((rect.bottom - rect.top - grid.cellHeight) / 2));
        const first = multiline(record) ? Math.min(state.firstLine, lines.length - 1) : 0;
        const scrolled = multiline(record) ? 0 : state.firstColumn ?? 0;
        for (let row = 0; row < grid.rows && first + row < lines.length; row++)
        {
            const line = lines[first + row];
            const y = top + row * grid.cellHeight;
            const x = rect.left + EDIT_MARGIN;
            const text = shown(record, line.text).slice(scrolled);
            // Where a character starts is where the drawn text before it
            // ends: the same measure the engine draws with, not a cell
            // grid, or a proportional face puts the caret and the
            // selection somewhere else than the characters.
            /** @param {number} at */
            const xOf = at=>x + draw.measure(hdc, text.slice(0, at)).width;
            const from = Math.max(selection.from, line.start) - line.start - scrolled;
            const to = Math.min(selection.to, line.start + line.text.length) - line.start
                - scrolled;
            if (focused && to > from && to > 0)
            {
                const start = Math.max(from, 0);
                draw.fill(hdc, { left: xOf(start), top: y, right: xOf(to),
                    bottom: y + grid.cellHeight }, color(COLOR_HIGHLIGHT));
                draw.text(hdc, x, y, text.slice(0, start), { color: ink, clip: rect });
                draw.text(hdc, xOf(start), y, text.slice(start, to),
                    { color: color(COLOR_HIGHLIGHTTEXT), clip: rect });
                draw.text(hdc, xOf(to), y, text.slice(to), { color: ink, clip: rect });
            }
            else
            {
                draw.text(hdc, x, y, text, { color: ink, clip: rect });
            }
            // The caret: a bar before the character the selection ends at.
            const caret = state.selEnd - line.start - scrolled;
            if (focused && !readOnly && caret >= 0 && caret <= text.length
                && (state.selEnd < line.start + line.text.length || first + row === lines.length - 1
                    || state.selEnd === line.start + line.text.length))
            {
                draw.fill(hdc, { left: xOf(caret), top: y, right: xOf(caret) + 1,
                    bottom: y + grid.cellHeight }, ink);
            }
        }
    };

    /**
     * Replaces the selection with text, keeps within the limit, moves the
     * caret past what was inserted, and tells the parent.
     *
     * @param {any} record @param {string} text @param {unknown} [thread]
     */
    const replaceSelection = (record, text, thread)=>{
        const state = editState(record);
        const from = Math.min(state.selStart, state.selEnd);
        const to = Math.max(state.selStart, state.selEnd);
        const room = state.limit - (record.title.length - (to - from));
        const inserted = text.slice(0, Math.max(0, room));
        record.title = record.title.slice(0, from) + inserted + record.title.slice(to);
        state.selStart = state.selEnd = from + inserted.length;
        state.modified = true;
        host.invalidate(record);
        return after(notify(record, EN_UPDATE, thread), ()=>after(
            notify(record, EN_CHANGE, thread),
            ()=>(inserted.length < text.length ? notify(record, EN_MAXTEXT, thread) : 0)));
    };

    /**
     * Moves the caret, extending the selection when Shift is held.
     *
     * @param {any} record @param {number} to
     */
    const moveCaret = (record, to)=>{
        const state = editState(record);
        const clamped = Math.max(0, Math.min(record.title.length, to));
        state.selEnd = clamped;
        if (!host.keyDown(VK_SHIFT))
        {
            state.selStart = clamped;
        }
        host.invalidate(record);
    };

    /**
     * The character at a client point, for a click.
     *
     * @param {any} record @param {number} hdc @param {number} x @param {number} y
     */
    const charFromPoint = (record, hdc, x, y)=>{
        const state = editState(record);
        const grid = editGrid(record, hdc);
        const lines = editLines(record, grid.columns);
        const row = multiline(record)
            ? Math.min(lines.length - 1, state.firstLine + Math.max(0,
                Math.floor((y - EDIT_MARGIN) / grid.cellHeight)))
            : 0;
        const line = lines[Math.max(0, row)];
        const scrolled = multiline(record) ? 0 : state.firstColumn ?? 0;
        const text = shown(record, line.text).slice(scrolled);
        // The nearest character boundary, measured the way the text is
        // drawn: a click lands between the two glyphs it fell between.
        const draw = /** @type {Drawing} */ (host.draw);
        let column = 0;
        let nearest = Infinity;
        for (let at = 0; at <= text.length; at++)
        {
            const distance = Math.abs(draw.measure(hdc, text.slice(0, at)).width
                - (x - EDIT_MARGIN));
            if (distance > nearest)
            {
                break;
            }
            nearest = distance;
            column = at;
        }
        return line.start + scrolled + column;
    };

    /**
     * Scrolls a multi-line edit by lines, clamped to the text.
     *
     * @param {any} record @param {number} lines
     */
    const scrollEdit = (record, lines)=>{
        const state = editState(record);
        const total = editLines(record, editGridColumns(record)).length;
        const rows = editGridRows(record);
        const ceiling = Math.max(0, total - rows);
        const wanted = Math.max(0, Math.min(ceiling, state.firstLine + lines));
        const moved = wanted - state.firstLine;
        state.firstLine = wanted;
        if (moved !== 0)
        {
            host.invalidate(record);
        }
        return moved;
    };

    /** Columns across the client without a context to measure with. @param {any} record */
    const editGridColumns = record=>{
        const size = host.clientSize(record);
        return Math.max(1, Math.floor((size.width - 2 * EDIT_MARGIN) / editCell(record).width));
    };
    /** @param {any} record */
    const editGridRows = record=>Math.max(1,
        Math.floor(host.clientSize(record).height / editCell(record).height));
    /**
     * The character cell, measured through a context on the window itself
     * -- the only place the selected font can be asked.
     *
     * @param {any} record
     */
    const editCell = record=>{
        const state = editState(record);
        if (!state.cell && host.draw)
        {
            const { hdc } = host.contextOn(record);
            const measured = hdc !== 0 ? host.draw.measure(hdc, 'M') : null;
            host.endPaint(record, hdc);
            state.cell = measured ? { width: measured.width, height: measured.height } : null;
        }
        return state.cell ?? { width: 8, height: 16 };
    };

    /**
     * @param {any} record @param {ControlMessage} message @param {unknown} [thread]
     */
    const editProc = (record, message, thread)=>{
        const state = editState(record);
        const readOnly = ()=>(record.style & ES_READONLY) !== 0;
        switch (message.message){
            case WM_PAINT:
                return painting(record, (hdc, rect)=>after(
                    controlColor(record, readOnly() || disabled(record)
                        ? WM_CTLCOLORSTATIC : WM_CTLCOLOREDIT, hdc, thread), brush=>{
                        paintEdit(record, hdc, rect, brush);
                        return 0;
                    }));
            case WM_ERASEBKGND:
                return 1;
            case WM_GETDLGCODE:
                return DLGC_WANTCHARS | DLGC_WANTARROWS | DLGC_HASSETSEL
                    | (multiline(record) && (record.style & ES_WANTRETURN) !== 0
                        ? DLGC_WANTALLKEYS : 0);
            case WM_SETFOCUS:
                host.invalidate(record);
                return notify(record, EN_SETFOCUS, thread);
            case WM_KILLFOCUS:
                host.invalidate(record);
                return notify(record, EN_KILLFOCUS, thread);
            case WM_LBUTTONDOWN:
            case WM_LBUTTONDBLCLK: {
                const point = pointOf(message.lParam);
                const { hdc } = host.contextOn(record);
                if (hdc !== 0)
                {
                    const at = charFromPoint(record, hdc, point.x, point.y);
                    state.selStart = state.selEnd = at;
                }
                host.endPaint(record, hdc);
                host.invalidate(record);
                return after(host.setFocus(record.hwnd, thread), ()=>0);
            }
            case WM_CHAR: {
                const character = message.wParam & 0xffff;
                if (readOnly() || disabled(record))
                {
                    return 0;
                }
                if (character === VK_BACK)
                {
                    if (state.selStart === state.selEnd && state.selEnd > 0)
                    {
                        state.selStart = state.selEnd - 1;
                    }
                    return replaceSelection(record, '', thread);
                }
                if (character === VK_RETURN)
                {
                    return multiline(record) && (record.style & ES_WANTRETURN) !== 0
                        ? replaceSelection(record, '\r\n', thread)
                        : 0;
                }
                if (character < VK_SPACE || character === VK_TAB || character === VK_ESCAPE)
                {
                    return 0;
                }
                return replaceSelection(record, String.fromCharCode(character), thread);
            }
            case WM_KEYDOWN: {
                const key = message.wParam & 0xff;
                const rows = editGridRows(record);
                switch (key){
                    case VK_LEFT:
                        moveCaret(record, state.selEnd - 1);
                        return 0;
                    case VK_RIGHT:
                        moveCaret(record, state.selEnd + 1);
                        return 0;
                    case VK_HOME:
                        moveCaret(record, lineStartOf(record, state.selEnd));
                        return 0;
                    case VK_END:
                        moveCaret(record, lineEndOf(record, state.selEnd));
                        return 0;
                    case VK_UP:
                    case VK_DOWN:
                        if (multiline(record))
                        {
                            moveCaret(record,
                                lineStepOf(record, state.selEnd, key === VK_UP ? -1 : 1));
                            keepCaretVisible(record);
                        }
                        return 0;
                    case VK_PRIOR:
                    case VK_NEXT:
                        if (multiline(record))
                        {
                            scrollEdit(record, key === VK_PRIOR ? -rows : rows);
                        }
                        return 0;
                    case VK_DELETE:
                        if (readOnly() || disabled(record))
                        {
                            return 0;
                        }
                        if (state.selStart === state.selEnd)
                        {
                            state.selEnd = Math.min(record.title.length, state.selEnd + 1);
                        }
                        return replaceSelection(record, '', thread);
                    default:
                        return 0;
                }
            }
            case WM_MOUSEWHEEL: {
                const delta = (message.wParam >>> 16) << 16 >> 16;
                if (multiline(record))
                {
                    scrollEdit(record, delta > 0 ? -3 : 3);
                }
                return 0;
            }
            case WM_VSCROLL: {
                const code = message.wParam & 0xffff;
                const rows = editGridRows(record);
                const total = editLines(record, editGridColumns(record)).length;
                const by = code === SB_LINEUP ? -1 : code === SB_LINEDOWN ? 1
                    : code === SB_PAGEUP ? -rows : code === SB_PAGEDOWN ? rows
                        : code === SB_TOP ? -total : code === SB_BOTTOM ? total
                            : code === SB_THUMBPOSITION || code === SB_THUMBTRACK
                                ? (message.wParam >>> 16) - state.firstLine : 0;
                scrollEdit(record, by);
                return 0;
            }
            case WM_SETTEXT: {
                const address = message.lParam >>> 0;
                record.title = address === 0 ? '' : host.readCString(address, MAX_TEXT);
                state.selStart = state.selEnd = 0;
                state.firstLine = 0;
                state.modified = false;
                host.invalidate(record);
                return after(notify(record, EN_UPDATE, thread),
                    ()=>after(notify(record, EN_CHANGE, thread), ()=>1));
            }
            case EM_GETSEL: {
                const from = Math.min(state.selStart, state.selEnd);
                const to = Math.max(state.selStart, state.selEnd);
                if ((message.wParam >>> 0) !== 0)
                {
                    writeU32(message.wParam, from);
                }
                if ((message.lParam >>> 0) !== 0)
                {
                    writeU32(message.lParam, to);
                }
                return ((to & 0xffff) << 16 | from & 0xffff) >>> 0;
            }
            case EM_SETSEL: {
                // -1 for the start means "deselect"; -1 for the end means
                // "to the end of the text".
                const start = message.wParam | 0;
                const end = message.lParam | 0;
                if (start === -1)
                {
                    state.selStart = state.selEnd;
                }
                else
                {
                    state.selStart = Math.min(record.title.length, Math.max(0, start));
                    state.selEnd = end === -1
                        ? record.title.length
                        : Math.min(record.title.length, Math.max(0, end));
                }
                host.invalidate(record);
                return 0;
            }
            case EM_REPLACESEL: {
                const address = message.lParam >>> 0;
                return replaceSelection(record,
                    address === 0 ? '' : host.readCString(address, MAX_TEXT), thread);
            }
            case EM_LIMITTEXT:
                state.limit = (message.wParam >>> 0) === 0
                    ? DEFAULT_EDIT_LIMIT : message.wParam >>> 0;
                return 0;
            case EM_GETLIMITTEXT:
                return state.limit;
            case EM_SETREADONLY:
                record.style = (message.wParam !== 0
                    ? record.style | ES_READONLY : record.style & ~ES_READONLY) >>> 0;
                host.invalidate(record);
                return 1;
            case EM_GETMODIFY:
                return state.modified ? 1 : 0;
            case EM_SETMODIFY:
                state.modified = message.wParam !== 0;
                return 0;
            case EM_GETLINECOUNT:
                return Math.max(1, editLines(record, editGridColumns(record)).length);
            case EM_LINEINDEX: {
                const lines = editLines(record, editGridColumns(record));
                const which = (message.wParam | 0) === -1
                    ? lineNumberOf(record, state.selEnd) : message.wParam | 0;
                return which >= 0 && which < lines.length ? lines[which].start : -1;
            }
            case EM_LINELENGTH: {
                const at = (message.wParam | 0) === -1 ? state.selEnd : message.wParam | 0;
                return lineEndOf(record, at) - lineStartOf(record, at);
            }
            case EM_GETLINE: {
                const lines = editLines(record, editGridColumns(record));
                const line = lines[message.wParam | 0];
                const out = message.lParam >>> 0;
                if (!line || out === 0)
                {
                    return 0;
                }
                // The first word of the buffer says how many characters it
                // holds; the line goes in over it, not terminated.
                const room = host.readMemory(out, 2);
                const limit = room[0] | room[1] << 8;
                const text = line.text.slice(0, limit);
                const bytes = new Uint8Array(text.length);
                for (let index = 0; index < text.length; index++)
                {
                    bytes[index] = text.charCodeAt(index) & 0xff;
                }
                host.writeMemory(out, bytes);
                return text.length;
            }
            case EM_GETFIRSTVISIBLELINE:
                return state.firstLine;
            case EM_LINESCROLL:
                return multiline(record) ? (scrollEdit(record, message.lParam | 0), 1) : 0;
            case EM_SCROLL: {
                const rows = editGridRows(record);
                const code = message.wParam & 0xffff;
                const moved = scrollEdit(record, code === SB_LINEUP ? -1 : code === SB_LINEDOWN ? 1
                    : code === SB_PAGEUP ? -rows : code === SB_PAGEDOWN ? rows : 0);
                return (1 << 16 | Math.abs(moved) & 0xffff) >>> 0;
            }
            case EM_SCROLLCARET:
                keepCaretVisible(record);
                return 1;
            case EM_SETPASSWORDCHAR:
                state.passwordChar = message.wParam & 0xffff;
                record.style = (state.passwordChar !== 0
                    ? record.style | ES_PASSWORD : record.style & ~ES_PASSWORD) >>> 0;
                host.invalidate(record);
                return 0;
            case EM_GETPASSWORDCHAR:
                return (record.style & ES_PASSWORD) !== 0 ? state.passwordChar ?? 0x2a : 0;
            case EM_CANUNDO:
            case EM_EMPTYUNDOBUFFER:
            case EM_SETMARGINS:
            case EM_GETRECT:
                return 0;
            case EM_POSFROMCHAR:
            case EM_CHARFROMPOS:
                return -1;
            default:
                return common(record, message, thread);
        }
    };

    /** @param {any} record @param {number} at @returns {number} the line the character is on */
    const lineNumberOf = (record, at)=>{
        const lines = editLines(record, editGridColumns(record));
        let found = 0;
        for (let index = 0; index < lines.length; index++)
        {
            if (lines[index].start <= at)
            {
                found = index;
            }
        }
        return found;
    };
    /** @param {any} record @param {number} at */
    const lineStartOf = (record, at)=>
        editLines(record, editGridColumns(record))[lineNumberOf(record, at)].start;
    /** @param {any} record @param {number} at */
    const lineEndOf = (record, at)=>{
        const line = editLines(record, editGridColumns(record))[lineNumberOf(record, at)];
        return line.start + line.text.length;
    };
    /** @param {any} record @param {number} at @param {number} by  Lines up or down. */
    const lineStepOf = (record, at, by)=>{
        const lines = editLines(record, editGridColumns(record));
        const number = lineNumberOf(record, at);
        const target = lines[Math.max(0, Math.min(lines.length - 1, number + by))];
        const column = at - lines[number].start;
        return target.start + Math.min(column, target.text.length);
    };
    /** Scrolls so the caret's line is on show. @param {any} record */
    const keepCaretVisible = record=>{
        const state = editState(record);
        const line = lineNumberOf(record, state.selEnd);
        const rows = editGridRows(record);
        if (line < state.firstLine)
        {
            scrollEdit(record, line - state.firstLine);
        }
        else if (line >= state.firstLine + rows)
        {
            scrollEdit(record, line - (state.firstLine + rows - 1));
        }
    };

    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>host.writeMemory(address >>> 0, new Uint8Array([
        value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
    ]));

    /** @param {number} address @param {string} text @returns {number} characters written */
    const writeString = (address, text)=>{
        const bytes = new Uint8Array(text.length + 1);
        for (let index = 0; index < text.length; index++)
        {
            bytes[index] = text.charCodeAt(index) & 0xff;
        }
        host.writeMemory(address >>> 0, bytes);
        return text.length;
    };

    // --- ListBox and ComboBox -----------------------------------------------

    /**
     * @typedef {Object} ListItem
     * @property {string} text
     * @property {number} data
     * @property {boolean} selected
     */

    /**
     * @param {any} record
     * @returns {{ items: ListItem[], current: number, top: number, itemHeight?: number,
     *     dropDivergenceSaid?: boolean }}
     */
    const listState = record=>{
        const state = stateOf(record);
        state.items ??= [];
        state.current ??= -1;
        state.top ??= 0;
        return state;
    };

    /**
     * Adds an item where LBS_SORT puts it, or at the end: the shared half
     * of LB_ADDSTRING and CB_ADDSTRING.
     *
     * @param {any} record @param {boolean} sorted @param {string} text @param {number} [at]
     * @returns {number} the index it landed at
     */
    const addItem = (record, sorted, text, at)=>{
        const state = listState(record);
        /** @type {ListItem} */
        const item = { text, data: 0, selected: false };
        let index = at ?? state.items.length;
        if (at === undefined && sorted)
        {
            index = state.items.findIndex(each=>each.text.toLowerCase() > text.toLowerCase());
            index = index === -1 ? state.items.length : index;
        }
        index = Math.max(0, Math.min(state.items.length, index));
        state.items.splice(index, 0, item);
        if (state.current >= index)
        {
            state.current++;
        }
        host.invalidate(record);
        return index;
    };

    /**
     * @param {any} record @param {number} index @param {boolean} exact @param {string} text
     * @returns {number} the first match after `index`, wrapping, or -1
     */
    const findItem = (record, index, exact, text)=>{
        const state = listState(record);
        const wanted = text.toLowerCase();
        const count = state.items.length;
        for (let step = 1; step <= count; step++)
        {
            const at = (index + step) % count;
            const have = state.items[at].text.toLowerCase();
            if (exact ? have === wanted : have.startsWith(wanted))
            {
                return at;
            }
        }
        return -1;
    };

    /**
     * The messages a list box and a combo box share, by the list box's
     * numbers; the combo box translates its own before calling this.
     *
     * @param {any} record @param {boolean} sorted @param {ControlMessage} message
     * @returns {number | null} null for a message that is not one of these
     */
    const listMessage = (record, sorted, message)=>{
        const state = listState(record);
        const items = state.items;
        const text = ()=>((message.lParam >>> 0) === 0
            ? '' : host.readCString(message.lParam >>> 0, MAX_TEXT));
        switch (message.message){
            case LB_ADDSTRING:
                return addItem(record, sorted, text());
            case LB_INSERTSTRING:
                return addItem(record, sorted, text(),
                    (message.wParam | 0) === -1 ? items.length : message.wParam | 0);
            case LB_DELETESTRING: {
                const at = message.wParam | 0;
                if (at < 0 || at >= items.length)
                {
                    return LB_ERR;
                }
                items.splice(at, 1);
                if (state.current === at)
                {
                    state.current = -1;
                }
                else if (state.current > at)
                {
                    state.current--;
                }
                host.invalidate(record);
                return items.length;
            }
            case LB_RESETCONTENT:
                items.length = 0;
                state.current = -1;
                state.top = 0;
                host.invalidate(record);
                return 0;
            case LB_GETCOUNT:
                return items.length;
            case LB_GETCURSEL:
                return state.current;
            case LB_SETCURSEL: {
                const at = message.wParam | 0;
                if (at !== -1 && (at < 0 || at >= items.length))
                {
                    return LB_ERR;
                }
                items.forEach(item=>{
                    item.selected = false;
                });
                state.current = at;
                if (at !== -1)
                {
                    items[at].selected = true;
                }
                host.invalidate(record);
                return at;
            }
            case LB_GETTEXT: {
                const item = items[message.wParam | 0];
                if (!item || (message.lParam >>> 0) === 0)
                {
                    return LB_ERR;
                }
                return writeString(message.lParam, item.text);
            }
            case LB_GETTEXTLEN: {
                const item = items[message.wParam | 0];
                return item ? item.text.length : LB_ERR;
            }
            case LB_GETITEMDATA: {
                const item = items[message.wParam | 0];
                return item ? item.data : LB_ERR;
            }
            case LB_SETITEMDATA: {
                const item = items[message.wParam | 0];
                if (!item)
                {
                    return LB_ERR;
                }
                item.data = message.lParam >>> 0;
                return 1;
            }
            case LB_FINDSTRING:
                return findItem(record, message.wParam | 0, false, text());
            case LB_FINDSTRINGEXACT:
                return findItem(record, message.wParam | 0, true, text());
            case LB_GETTOPINDEX:
                return state.top;
            case LB_SETTOPINDEX:
                state.top = Math.max(0, Math.min(items.length - 1, message.wParam | 0));
                host.invalidate(record);
                return 0;
            default:
                return null;
        }
    };

    /** The item height, which is the text height. @param {any} record @param {number} hdc */
    const itemHeight = (record, hdc)=>{
        const state = stateOf(record);
        return state.itemHeight ?? /** @type {Drawing} */ (host.draw).measure(hdc, 'M').height;
    };

    /**
     * Items from the top one down, each in its row, the selected ones in the
     * highlight colours.
     *
     * @param {any} record @param {number} hdc @param {Rect} rect @param {number} brush
     */
    const paintList = (record, hdc, rect, brush)=>{
        const draw = /** @type {Drawing} */ (host.draw);
        const state = listState(record);
        background(hdc, rect, brush, disabled(record) ? COLOR_3DFACE : COLOR_WINDOW);
        const height = itemHeight(record, hdc);
        const ink = color(disabled(record) ? COLOR_GRAYTEXT : COLOR_WINDOWTEXT);
        for (let index = state.top; index < state.items.length; index++)
        {
            const y = rect.top + (index - state.top) * height;
            if (y >= rect.bottom)
            {
                break;
            }
            const item = state.items[index];
            const row = { left: rect.left, top: y, right: rect.right, bottom: y + height };
            const selected = (item.selected || index === state.current)
                && (record.style & LBS_NOSEL) === 0;
            if (selected)
            {
                draw.fill(hdc, row, color(COLOR_HIGHLIGHT));
            }
            draw.text(hdc, rect.left + 2, y, item.text,
                { color: selected ? color(COLOR_HIGHLIGHTTEXT) : ink, clip: row });
        }
    };

    /**
     * Selects an item because the person did, and says so.
     *
     * @param {any} record @param {number} index @param {number} code  LBN_ or CBN_SELCHANGE.
     * @param {boolean} always  Whether to notify without LBS_NOTIFY.
     * @param {unknown} [thread]
     */
    const chooseItem = (record, index, code, always, thread)=>{
        const state = listState(record);
        if (index < 0 || index >= state.items.length || (record.style & LBS_NOSEL) !== 0)
        {
            return 0;
        }
        if ((record.style & (LBS_MULTIPLESEL | LBS_EXTENDEDSEL)) !== 0 && code === LBN_SELCHANGE)
        {
            state.items[index].selected = !state.items[index].selected;
        }
        else
        {
            state.items.forEach(item=>{
                item.selected = false;
            });
            state.items[index].selected = true;
        }
        state.current = index;
        host.invalidate(record);
        return always || (record.style & LBS_NOTIFY) !== 0 ? notify(record, code, thread) : 0;
    };

    /**
     * @param {any} record @param {ControlMessage} message @param {unknown} [thread]
     */
    const listBoxProc = (record, message, thread)=>{
        const state = listState(record);
        const sorted = (record.style & LBS_SORT) !== 0;
        switch (message.message){
            case WM_PAINT:
                return painting(record, (hdc, rect)=>after(
                    controlColor(record, WM_CTLCOLORLISTBOX, hdc, thread), brush=>{
                        paintList(record, hdc, rect, brush);
                        return 0;
                    }));
            case WM_ERASEBKGND:
                return 1;
            case WM_GETDLGCODE:
                return DLGC_WANTARROWS | DLGC_WANTCHARS;
            case WM_SETFOCUS:
                host.invalidate(record);
                return (record.style & LBS_NOTIFY) !== 0 ? notify(record, LBN_SETFOCUS, thread) : 0;
            case WM_KILLFOCUS:
                host.invalidate(record);
                return (record.style & LBS_NOTIFY) !== 0
                    ? notify(record, LBN_KILLFOCUS, thread) : 0;
            case WM_LBUTTONDOWN:
            case WM_LBUTTONDBLCLK: {
                const point = pointOf(message.lParam);
                const { hdc } = host.contextOn(record);
                const height = hdc !== 0 ? itemHeight(record, hdc) : 16;
                host.endPaint(record, hdc);
                const index = state.top + Math.floor(point.y / height);
                return after(host.setFocus(record.hwnd, thread), ()=>{
                    if (message.message === WM_LBUTTONDBLCLK)
                    {
                        return (record.style & LBS_NOTIFY) !== 0
                            ? notify(record, LBN_DBLCLK, thread) : 0;
                    }
                    return chooseItem(record, index, LBN_SELCHANGE, false, thread);
                });
            }
            case WM_KEYDOWN: {
                const key = message.wParam & 0xff;
                const step = key === VK_UP ? -1 : key === VK_DOWN ? 1
                    : key === VK_HOME ? -state.items.length : key === VK_END ? state.items.length
                        : 0;
                if (step === 0)
                {
                    return 0;
                }
                const index = Math.max(0, Math.min(state.items.length - 1, state.current + step));
                if (index < state.top)
                {
                    state.top = index;
                }
                return chooseItem(record, index, LBN_SELCHANGE, false, thread);
            }
            case LB_GETSEL: {
                const item = state.items[message.wParam | 0];
                return item ? (item.selected ? 1 : 0) : LB_ERR;
            }
            case LB_SETSEL: {
                const at = message.lParam | 0;
                const on = message.wParam !== 0;
                if (at === -1)
                {
                    state.items.forEach(item=>{
                        item.selected = on;
                    });
                }
                else if (state.items[at])
                {
                    state.items[at].selected = on;
                }
                else
                {
                    return LB_ERR;
                }
                host.invalidate(record);
                return 0;
            }
            case LB_GETSELCOUNT:
                return (record.style & (LBS_MULTIPLESEL | LBS_EXTENDEDSEL)) === 0
                    ? LB_ERR : state.items.filter(item=>item.selected).length;
            case LB_GETSELITEMS: {
                const chosen = state.items.map((item, index)=>(item.selected ? index : -1))
                    .filter(index=>index >= 0).slice(0, message.wParam | 0);
                chosen.forEach((index, slot)=>writeU32((message.lParam >>> 0) + slot * 4, index));
                return chosen.length;
            }
            case LB_GETITEMHEIGHT:
                return state.itemHeight ?? editCell(record).height;
            case LB_SETITEMHEIGHT:
                state.itemHeight = message.lParam & 0xffff;
                host.invalidate(record);
                return 0;
            case LB_GETITEMRECT: {
                const at = message.wParam | 0;
                if (at < 0 || at >= state.items.length || (message.lParam >>> 0) === 0)
                {
                    return LB_ERR;
                }
                const height = state.itemHeight ?? editCell(record).height;
                const top = (at - state.top) * height;
                const size = host.clientSize(record);
                [0, top, size.width, top + height].forEach((value, slot)=>
                    writeU32((message.lParam >>> 0) + slot * 4, value));
                return 1;
            }
            case LB_SETHORIZONTALEXTENT:
                return 0;
            default: {
                const answered = listMessage(record, sorted, message);
                return answered === null ? common(record, message, thread) : answered;
            }
        }
    };

    /**
     * The combo box's selection field: a sunken white box with the current
     * item's text and a drop button at the right. The list does not drop
     * down here, which is said once.
     *
     * @param {any} record @param {number} hdc @param {Rect} rect
     */
    const paintCombo = (record, hdc, rect)=>{
        const draw = /** @type {Drawing} */ (host.draw);
        const state = listState(record);
        draw.fill(hdc, rect, color(disabled(record) ? COLOR_3DFACE : COLOR_WINDOW));
        sunkenEdge(hdc, rect);
        const button = { left: rect.right - 2 - COMBO_BUTTON, top: rect.top + 2,
            right: rect.right - 2, bottom: rect.bottom - 2 };
        draw.fill(hdc, button, color(COLOR_3DFACE));
        buttonEdge(hdc, button, false);
        // The arrow: a triangle four rows high, as the scroll bars draw theirs.
        const arrowX = button.left + Math.floor((COMBO_BUTTON - 7) / 2);
        const arrowY = button.top + Math.floor((button.bottom - button.top - 4) / 2);
        for (let row = 0; row < 4; row++)
        {
            draw.fill(hdc, { left: arrowX + row, top: arrowY + row, right: arrowX + 7 - row,
                bottom: arrowY + row + 1 }, color(COLOR_BTNTEXT));
        }
        const current = state.items[state.current];
        const editable = (record.style & CBS_TYPEMASK) === CBS_DROPDOWN
            || (record.style & CBS_TYPEMASK) === CBS_SIMPLE;
        const text = editable ? record.title : current?.text ?? '';
        const field = { left: rect.left + 3, top: rect.top + 2, right: button.left - 1,
            bottom: rect.bottom - 2 };
        const focused = host.focus() === record.hwnd;
        if (focused)
        {
            draw.fill(hdc, field, color(COLOR_HIGHLIGHT));
        }
        const metrics = draw.measure(hdc, text);
        draw.text(hdc, field.left + 1,
            field.top + Math.max(0, Math.floor((field.bottom - field.top - metrics.height) / 2)),
            text, { color: color(focused ? COLOR_HIGHLIGHTTEXT
                : disabled(record) ? COLOR_GRAYTEXT : COLOR_WINDOWTEXT), clip: field });
    };

    /** A combo box message as the list box spells it, or null. @param {number} message */
    const comboAsList = message=>{
        switch (message){
            case CB_ADDSTRING: return LB_ADDSTRING;
            case CB_INSERTSTRING: return LB_INSERTSTRING;
            case CB_DELETESTRING: return LB_DELETESTRING;
            case CB_RESETCONTENT: return LB_RESETCONTENT;
            case CB_GETCOUNT: return LB_GETCOUNT;
            case CB_GETCURSEL: return LB_GETCURSEL;
            case CB_SETCURSEL: return LB_SETCURSEL;
            case CB_GETLBTEXT: return LB_GETTEXT;
            case CB_GETLBTEXTLEN: return LB_GETTEXTLEN;
            case CB_GETITEMDATA: return LB_GETITEMDATA;
            case CB_SETITEMDATA: return LB_SETITEMDATA;
            case CB_FINDSTRING: return LB_FINDSTRING;
            case CB_FINDSTRINGEXACT: return LB_FINDSTRINGEXACT;
            default: return null;
        }
    };

    /**
     * @param {any} record @param {ControlMessage} message @param {unknown} [thread]
     */
    const comboBoxProc = (record, message, thread)=>{
        const state = listState(record);
        const sorted = (record.style & CBS_SORT) !== 0;
        const asList = comboAsList(message.message);
        if (asList !== null)
        {
            const answer = listMessage(record, sorted, { ...message, message: asList });
            // A selection set by the program shows in the field; a text a
            // program reads back is that item's text.
            if (asList === LB_SETCURSEL && answer !== LB_ERR)
            {
                record.title = state.items[state.current]?.text ?? '';
            }
            return answer ?? CB_ERR;
        }
        switch (message.message){
            case WM_PAINT:
                return painting(record, (hdc, rect)=>{
                    paintCombo(record, hdc, rect);
                });
            case WM_ERASEBKGND:
                return 1;
            case WM_GETDLGCODE:
                return DLGC_WANTARROWS | DLGC_WANTCHARS;
            case WM_SETFOCUS:
                host.invalidate(record);
                return notify(record, CBN_SETFOCUS, thread);
            case WM_KILLFOCUS:
                host.invalidate(record);
                return notify(record, CBN_KILLFOCUS, thread);
            case WM_LBUTTONDOWN:
            case WM_LBUTTONDBLCLK:
                if (!state.dropDivergenceSaid)
                {
                    state.dropDivergenceSaid = true;
                    host.divergence?.('ComboBox',
                        'the list does not drop down; the arrow keys change the selection');
                }
                return after(host.setFocus(record.hwnd, thread), ()=>0);
            case WM_KEYDOWN: {
                const key = message.wParam & 0xff;
                const step = key === VK_UP ? -1 : key === VK_DOWN ? 1 : 0;
                if (step === 0 || state.items.length === 0)
                {
                    return 0;
                }
                const index = Math.max(0, Math.min(state.items.length - 1, state.current + step));
                if (index === state.current)
                {
                    return 0;
                }
                record.title = state.items[index].text;
                return chooseItem(record, index, CBN_SELCHANGE, true, thread);
            }
            case CB_SHOWDROPDOWN:
                return 1;
            case CB_GETDROPPEDSTATE:
                return 0;
            case CB_SETEXTENDEDUI:
                return 0;
            case CB_GETEXTENDEDUI:
                return 0;
            case CB_GETEDITSEL:
            case CB_SETEDITSEL:
            case CB_LIMITTEXT:
            case CB_SETDROPPEDWIDTH:
            case CB_GETDROPPEDCONTROLRECT:
                return 0;
            default:
                return common(record, message, thread);
        }
    };

    // --- ScrollBar ----------------------------------------------------------

    /** @param {any} record @param {number} bar */
    const scrollOf = (record, bar)=>{
        record.scroll ??= new Map();
        if (!record.scroll.has(bar))
        {
            record.scroll.set(bar, { min: 0, max: 100, page: 0, pos: 0, trackPos: 0 });
        }
        return record.scroll.get(bar);
    };

    /**
     * A scroll bar in a rectangle: two arrow buttons, a track and the thumb
     * where the position puts it. Shared with the bars a window's styles give
     * it, which are drawn in the frame.
     *
     * @param {number} hdc @param {Rect} rect @param {boolean} vertical
     * @param {ScrollBarState} held
     */
    const paintScrollBar = (hdc, rect, vertical, held)=>{
        const draw = /** @type {Drawing} */ (host.draw);
        draw.fill(hdc, rect, color(COLOR_SCROLLBAR));
        const length = vertical ? rect.bottom - rect.top : rect.right - rect.left;
        const arrow = Math.min(ARROW_LENGTH, Math.floor(length / 2));
        /** @param {Rect} box @param {number} direction  -1 for up/left, 1 for down/right. */
        const arrowButton = (box, direction)=>{
            draw.fill(hdc, box, color(COLOR_3DFACE));
            buttonEdge(hdc, box, false);
            const cx = Math.floor((box.left + box.right) / 2);
            const cy = Math.floor((box.top + box.bottom) / 2);
            for (let row = 0; row < 4; row++)
            {
                const span = 3 - row;
                if (vertical)
                {
                    const y = cy + direction * (row - 2);
                    draw.fill(hdc, { left: cx - span, top: y, right: cx + span + 1, bottom: y + 1 },
                        color(COLOR_BTNTEXT));
                }
                else
                {
                    const x = cx + direction * (row - 2);
                    draw.fill(hdc, { left: x, top: cy - span, right: x + 1, bottom: cy + span + 1 },
                        color(COLOR_BTNTEXT));
                }
            }
        };
        const first = vertical
            ? { ...rect, bottom: rect.top + arrow }
            : { ...rect, right: rect.left + arrow };
        const last = vertical
            ? { ...rect, top: rect.bottom - arrow }
            : { ...rect, left: rect.right - arrow };
        arrowButton(first, -1);
        arrowButton(last, 1);
        const track = length - 2 * arrow;
        const range = Math.max(1, held.max - held.min + 1);
        if (track <= 0 || range <= Math.max(held.page, 1) && held.page > 0)
        {
            return;
        }
        const thumbLength = held.page > 0
            ? Math.max(8, Math.floor(track * Math.min(held.page, range) / range))
            : Math.min(track, ARROW_LENGTH);
        const travel = track - thumbLength;
        const ceiling = Math.max(1, held.max - held.min - Math.max(held.page - 1, 0));
        const offset = Math.floor(travel * Math.min(held.pos - held.min, ceiling) / ceiling);
        const thumb = vertical
            ? { ...rect, top: rect.top + arrow + offset,
                bottom: rect.top + arrow + offset + thumbLength }
            : { ...rect, left: rect.left + arrow + offset,
                right: rect.left + arrow + offset + thumbLength };
        draw.fill(hdc, thumb, color(COLOR_3DFACE));
        buttonEdge(hdc, thumb, false);
    };

    /**
     * What a click on a scroll bar means: an arrow scrolls a line, the track
     * either side of the thumb scrolls a page. The thumb is not dragged.
     *
     * @param {Rect} rect @param {boolean} vertical
     * @param {ScrollBarState} held
     * @param {number} x @param {number} y
     * @returns {number} an SB_ code, or SB_ENDSCROLL for a miss
     */
    const scrollHit = (rect, vertical, held, x, y)=>{
        const along = vertical ? y - rect.top : x - rect.left;
        const length = vertical ? rect.bottom - rect.top : rect.right - rect.left;
        const arrow = Math.min(ARROW_LENGTH, Math.floor(length / 2));
        if (along < arrow)
        {
            return SB_LINEUP;
        }
        if (along >= length - arrow)
        {
            return SB_LINEDOWN;
        }
        const track = length - 2 * arrow;
        const range = Math.max(1, held.max - held.min + 1);
        const thumbLength = held.page > 0
            ? Math.max(8, Math.floor(track * Math.min(held.page, range) / range))
            : Math.min(track, ARROW_LENGTH);
        const ceiling = Math.max(1, held.max - held.min - Math.max(held.page - 1, 0));
        const offset = Math.floor((track - thumbLength)
            * Math.min(held.pos - held.min, ceiling) / ceiling);
        if (along - arrow < offset)
        {
            return SB_PAGEUP;
        }
        return along - arrow >= offset + thumbLength ? SB_PAGEDOWN : SB_ENDSCROLL;
    };

    /**
     * @param {any} record @param {ControlMessage} message @param {unknown} [thread]
     */
    const scrollBarProc = (record, message, thread)=>{
        const held = scrollOf(record, SB_CTL);
        const vertical = (record.style & SBS_VERT) !== 0;
        /** Clamps the position to where a thumb can sit. */
        const clamp = ()=>{
            const ceiling = Math.max(held.min, held.max - Math.max(held.page - 1, 0));
            held.pos = Math.min(Math.max(held.pos, held.min), ceiling);
        };
        switch (message.message){
            case WM_PAINT:
                return painting(record, (hdc, rect)=>{
                    paintScrollBar(hdc, rect, vertical, held);
                });
            case WM_ERASEBKGND:
                return 1;
            case WM_GETDLGCODE:
                return DLGC_WANTARROWS;
            case WM_LBUTTONDOWN: {
                const point = pointOf(message.lParam);
                const code = scrollHit(clientRect(record), vertical, held, point.x, point.y);
                if (code === SB_ENDSCROLL || !record.parent)
                {
                    return 0;
                }
                // The parent moves the position: the control only reports
                // which way, as the real one does.
                return host.send(record.parent, vertical ? WM_VSCROLL : WM_HSCROLL,
                    code, record.hwnd, thread);
            }
            case SBM_SETPOS: {
                const previous = held.pos;
                held.pos = message.wParam | 0;
                clamp();
                if ((message.lParam & 0xffff) !== 0)
                {
                    host.invalidate(record);
                }
                return previous;
            }
            case SBM_GETPOS:
                return held.pos;
            case SBM_SETRANGE:
            case SBM_SETRANGEREDRAW: {
                const previous = held.pos;
                held.min = message.wParam | 0;
                held.max = message.lParam | 0;
                clamp();
                if (message.message === SBM_SETRANGEREDRAW)
                {
                    host.invalidate(record);
                }
                return previous;
            }
            case SBM_GETRANGE:
                if ((message.wParam >>> 0) !== 0)
                {
                    writeU32(message.wParam, held.min);
                }
                if ((message.lParam >>> 0) !== 0)
                {
                    writeU32(message.lParam, held.max);
                }
                return 0;
            case SBM_ENABLE_ARROWS:
                return 1;
            case SBM_SETSCROLLINFO: {
                const info = message.lParam >>> 0;
                if (info === 0)
                {
                    return 0;
                }
                const mask = readU32(info + SCROLLINFO.fMask);
                if ((mask & SIF_RANGE) !== 0)
                {
                    held.min = readU32(info + SCROLLINFO.nMin) | 0;
                    held.max = readU32(info + SCROLLINFO.nMax) | 0;
                }
                if ((mask & SIF_PAGE) !== 0)
                {
                    held.page = readU32(info + SCROLLINFO.nPage) | 0;
                }
                if ((mask & SIF_POS) !== 0)
                {
                    held.pos = readU32(info + SCROLLINFO.nPos) | 0;
                }
                clamp();
                if ((message.wParam & 0xffff) !== 0)
                {
                    host.invalidate(record);
                }
                return held.pos;
            }
            case SBM_GETSCROLLINFO: {
                const info = message.lParam >>> 0;
                if (info === 0)
                {
                    return 0;
                }
                const mask = readU32(info + SCROLLINFO.fMask);
                if ((mask & SIF_RANGE) !== 0)
                {
                    writeU32(info + SCROLLINFO.nMin, held.min);
                    writeU32(info + SCROLLINFO.nMax, held.max);
                }
                if ((mask & SIF_PAGE) !== 0)
                {
                    writeU32(info + SCROLLINFO.nPage, held.page);
                }
                if ((mask & SIF_POS) !== 0)
                {
                    writeU32(info + SCROLLINFO.nPos, held.pos);
                }
                if ((mask & SIF_TRACKPOS) !== 0)
                {
                    writeU32(info + SCROLLINFO.nTrackPos, held.pos);
                }
                return 1;
            }
            default:
                return common(record, message, thread);
        }
    };

    /** @param {number} address */
    const readU32 = address=>{
        const bytes = host.readMemory(address >>> 0, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };

    // --- The dialog class ---------------------------------------------------

    /**
     * The messages whose answer is the dialog procedure's own return value
     * rather than DWLP_MSGRESULT.
     */
    const ANSWERED_DIRECTLY = new Set([
        WM_INITDIALOG, WM_CTLCOLOREDIT, WM_CTLCOLORLISTBOX, WM_CTLCOLORBTN, WM_CTLCOLORDLG,
        WM_CTLCOLORSCROLLBAR, WM_CTLCOLORSTATIC,
        0x002f, // WM_CHARTOITEM
        0x0039, // WM_COMPAREITEM
        0x0037, // WM_QUERYDRAGICON
        0x002e, // WM_VKEYTOITEM
    ]);

    /**
     * What a dialog does when its own procedure did not: DefDlgProc.
     *
     * @param {any} record @param {ControlMessage} message @param {unknown} [thread]
     */
    const defDlgProc = (record, message, thread)=>{
        const state = stateOf(record);
        switch (message.message){
            case WM_ERASEBKGND: {
                if (!host.draw)
                {
                    return 0;
                }
                const size = host.clientSize(record);
                const rect = { left: 0, top: 0, right: size.width, bottom: size.height };
                return after(host.send(record.hwnd, WM_CTLCOLORDLG, message.wParam, record.hwnd,
                    thread), brush=>{
                    background(message.wParam, rect, brush, COLOR_3DFACE);
                    return 1;
                });
            }
            case WM_CTLCOLORDLG:
            case WM_CTLCOLORSTATIC:
            case WM_CTLCOLORBTN:
            case WM_CTLCOLORSCROLLBAR:
                // The dialog's face for its statics and buttons; an edit and a
                // list box keep the window colour, which is their own default.
                return host.draw ? host.draw.solidBrush(color(COLOR_3DFACE)) : 0;
            case WM_CTLCOLOREDIT:
            case WM_CTLCOLORLISTBOX:
                return 0;
            case DM_GETDEFID:
                return state.defaultId !== undefined
                    ? ((DC_HASDEFID << 16) | state.defaultId & 0xffff) >>> 0
                    : 0;
            case DM_SETDEFID:
                state.defaultId = message.wParam & 0xffff;
                return 1;
            case WM_SETFONT:
                record.font = message.wParam >>> 0;
                return 0;
            case WM_GETFONT:
                return record.font ?? 0;
            case WM_CLOSE:
                // Closing a dialog is Cancel: what the person could have
                // pressed, sent the way a button would have sent it.
                host.post({ hwnd: record.hwnd, message: WM_COMMAND,
                    wParam: (BN_CLICKED << 16 | IDCANCEL) >>> 0,
                    lParam: host.children(record).find(child=>child.id === IDCANCEL)?.hwnd ?? 0 });
                return 0;
            default:
                return host.defWindowProc(record, message, thread);
        }
    };

    /**
     * The dialog class: every message goes to the program's own dialog
     * procedure first, and to DefDlgProc when that one answers FALSE.
     *
     * @param {any} record @param {ControlMessage} message @param {unknown} [thread]
     */
    const dialogProc = (record, message, thread)=>{
        const dlgProc = record.extra.byteLength >= DWLP_DLGPROC + 4
            ? record.extra.getUint32(DWLP_DLGPROC, true) : 0;
        if (dlgProc === 0 || stateOf(record).inDlgProc === message.message)
        {
            return defDlgProc(record, message, thread);
        }
        const state = stateOf(record);
        // A dialog procedure that sends its own window the same message it
        // is handling -- WM_CTLCOLORDLG from WM_ERASEBKGND -- must reach the
        // default, not itself again.
        const previous = state.inDlgProc;
        state.inDlgProc = message.message;
        return after(host.callProcedure(dlgProc, message, thread), handled=>{
            state.inDlgProc = previous;
            if ((handled | 0) === 0)
            {
                return defDlgProc(record, message, thread);
            }
            if (message.message === WM_INITDIALOG)
            {
                // TRUE from WM_INITDIALOG means "give the focus to the
                // control you chose", the first tab stop.
                const first = message.wParam >>> 0;
                return first !== 0 ? after(host.setFocus(first, thread), ()=>1) : 1;
            }
            return ANSWERED_DIRECTLY.has(message.message)
                ? handled >>> 0
                : record.extra.getUint32(DWLP_MSGRESULT, true);
        });
    };

    return {
        procedures: {
            Button: buttonProc,
            Static: staticProc,
            Edit: editProc,
            ListBox: listBoxProc,
            ComboBox: comboBoxProc,
            ScrollBar: scrollBarProc,
            '#32770': dialogProc,
        },
        helpers: { defDlgProc, paintScrollBar, scrollHit },
    };
}
