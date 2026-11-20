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

import { CHECK_MARK, RADIO_DOT, RADIO_RING_DARK, RADIO_RING_LIGHT, layoutText } from './paint.js';
import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';
import { createTabWalk } from './tabwalk.js';
import { directoryItems } from './dlgdir.js';
import { createButtonV6 } from './button-v6.js';
import { translated } from './unicode.js';
import { wholeAddress } from '../common/pointers.js';

/** Messages the controls answer. */
export const WM_CREATE = 0x0001;
export const WM_SETFOCUS = 0x0007;
const WM_SIZE = 0x0005;
export const WM_KILLFOCUS = 0x0008;
const WM_NCDESTROY = 0x0082;
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

/**
 * Owner drawing: WM_DRAWITEM and its DRAWITEMSTRUCT -- CtlType, CtlID, itemID,
 * itemAction, itemState, hwndItem, hDC, rcItem and itemData, forty-eight
 * bytes -- with the kinds of control, the reasons to draw and the states.
 */
const WM_DRAWITEM = 0x002b;
const WM_MEASUREITEM = 0x002c;
const ODT_COMBOBOX = 3;
const DRAWITEMSTRUCT_SIZE = 48;
const ODT_BUTTON = 4;
const ODT_STATIC = 5;
const ODA_DRAWENTIRE = 0x1;
const ODA_SELECT = 0x2;
const ODA_FOCUS = 0x4;
const ODS_SELECTED = 0x1;
const ODS_DISABLED = 0x4;
const ODS_FOCUS = 0x10;
const BS_LEFTTEXT = 0x20;
/** Where a button's label sits: two bits across, two down; neither is the default. */
const BS_LEFT = 0x0100;
const BS_RIGHT = 0x0200;
const BS_CENTER = 0x0300;
const BS_TOP = 0x0400;
const BS_BOTTOM = 0x0800;
const BS_VCENTER = 0x0c00;
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
const BM_GETIMAGE = 0x00f6;
const BM_SETIMAGE = 0x00f7;
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
/** A static control's image stretched to the control rather than the control to it. */
const SS_REALSIZECONTROL = 0x40;
const SS_SUNKEN = 0x1000;
const WS_EX_STATICEDGE = 0x00020000;
const STM_SETICON = 0x170;
const STM_GETICON = 0x171;
const STM_SETIMAGE = 0x172;
const STM_GETIMAGE = 0x173;
const STN_CLICKED = 0;
const STN_DBLCLK = 1;
/** STM_SETIMAGE's image types. */
const IMAGE_BITMAP = 0;
const IMAGE_ICON = 1;
const IMAGE_CURSOR = 2;
const IMAGE_ENHMETAFILE = 3;
const SS_ENHMETAFILE = 0x0f;

/** The window styles a dialog's Tab order is read from. */
const WS_TABSTOP = 0x00010000;
/** A dialog that is a page inside another (a property sheet's). */
const DS_CONTROL = 0x0400;
const WS_DISABLED = 0x08000000;
const WS_VISIBLE = 0x10000000;
const WS_MINIMIZE = 0x20000000;
const WS_CHILD = 0x40000000;
const WS_EX_CONTROLPARENT = 0x00010000;
/** WM_ACTIVATE: the window gaining or losing the activation. */
const WM_ACTIVATE = 0x0006;

/** Edit styles and messages. */
const ES_MULTILINE = 0x0004;
const ES_PASSWORD = 0x0020;
const ES_AUTOHSCROLL = 0x0080;
/** A rich edit's bars kept, disabled, when there is nothing to scroll. */
const ES_DISABLENOSCROLL = 0x2000;
const ES_READONLY = 0x0800;
const ES_WANTRETURN = 0x1000;
const EM_GETSEL = 0x00b0;
const EM_SETSEL = 0x00b1;
const WM_NEXTDLGCTL = 0x0028;
const EM_GETHANDLE = 0x00bd;
const EM_SETHANDLE = 0x00bc;
const EM_GETRECT = 0x00b2;
const EM_SETRECT = 0x00b3;
const EM_SETRECTNP = 0x00b4;
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
const EM_UNDO = 0x00c7;
/** The clipboard messages an edit answers, and the undo they share with it. */
const WM_CUT = 0x0300;
const WM_COPY = 0x0301;
const WM_PASTE = 0x0302;
const WM_CLEAR = 0x0303;
const WM_UNDO = 0x0304;
/** The control characters an edit answers as commands: Ctrl+C, V, X and Z. */
const EDIT_CONTROL_CHARACTERS = new Map([[0x03, WM_COPY], [0x16, WM_PASTE], [0x18, WM_CUT],
    [0x1a, WM_UNDO]]);
const EM_EMPTYUNDOBUFFER = 0x00cd;
const EM_GETFIRSTVISIBLELINE = 0x00ce;
const EM_SETREADONLY = 0x00cf;
const EM_SETPASSWORDCHAR = 0x00cc;
const EM_GETPASSWORDCHAR = 0x00d2;
const EM_SETMARGINS = 0x00d3;
const EM_GETMARGINS = 0x00d4;
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
/** EM_SETMARGINS' sides, and the value that asks for the font's own margin. */
const EC_LEFTMARGIN = 0x0001;
const EC_RIGHTMARGIN = 0x0002;
const EC_USEFONTINFO = 0xffff;
/**
 * The client width the font's margins are judged against when the client
 * area is empty: Windows lays out a zero-sized edit as if it were this wide.
 */
const EMPTY_EDIT_WIDTH = 80;
/** How much room past its text an edit's buffer is given, so typing does not move it. */
const EDIT_BUFFER_STEP = 64;
/** WM_SIZE's kinds that lay an edit out again; a minimized one keeps its rectangle. */
const SIZE_RESTORED = 0;
const SIZE_MAXIMIZED = 2;
const WS_EX_CLIENTEDGE = 0x00000200;
const WS_CLIPSIBLINGS = 0x04000000;
/** SM_CYBORDER: a thin border's height, which an edit's WS_BORDER insets by and one. */
const THIN_BORDER = 1;
/** What a program that never set a limit may type: the documented default. */
const DEFAULT_EDIT_LIMIT = 0x7ffffffe;

/**
 * A multi-line edit's text as lines, each with the index of its first
 * character: broken at CR LF, CR or LF, and -- when it wraps -- where the
 * next character would take the line past `room`, at the last space before
 * that (the space staying on the line it ends) or, in a word wider than the
 * line, at that character.
 *
 * @param {string} text @param {boolean} wrap @param {number} room
 * @param {(character: string) => number} advance
 * @returns {{ text: string, start: number }[]}
 */
export function wrapEditText(text, wrap, room, advance){
    /** @type {{ text: string, start: number }[]} */
    const lines = [];
    let at = 0;
    for (const paragraph of text.split(/\r\n|\r|\n/))
    {
        const start = at;
        // The break itself is counted in the paragraph's length so the next
        // line's start is right, but it is no part of any line.
        at += paragraph.length;
        const broke = text.slice(at, at + 2);
        at += broke === '\r\n' ? 2 : (broke.length > 0 ? 1 : 0);
        let from = 0;
        while (from < (wrap ? paragraph.length : 0))
        {
            let width = 0;
            let end = from;
            while (end < paragraph.length && width + advance(paragraph[end]) <= room)
            {
                width += advance(paragraph[end]);
                end++;
            }
            if (end >= paragraph.length)
            {
                break;
            }
            const space = paragraph.lastIndexOf(' ', end);
            const cut = space <= from ? Math.max(end, from + 1) : space + 1;
            lines.push({ text: paragraph.slice(from, cut), start: start + from });
            from = cut;
        }
        lines.push({ text: paragraph.slice(from), start: start + from });
    }
    return lines;
}

/** List box styles, messages and notifications. */
const LBS_NOTIFY = 0x0001;
const LBS_SORT = 0x0002;
const LBS_MULTIPLESEL = 0x0008;
const LBS_EXTENDEDSEL = 0x0800;
const LBS_NOSEL = 0x4000;
/** A list box that keeps its scroll bar, disabled, when everything fits; one in columns. */
const LBS_DISABLENOSCROLL = 0x1000;
const LBS_MULTICOLUMN = 0x0200;
/** An owner-drawn list box, and one that still keeps the strings it is handed. */
const LBS_OWNERDRAW = 0x0030;
const LBS_HASSTRINGS = 0x0040;
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
const LB_DIR = 0x018d;
const LB_GETTOPINDEX = 0x018e;
const LB_SELECTSTRING = 0x018c;
const LB_FINDSTRING = 0x018f;
const LB_GETSELCOUNT = 0x0190;
const LB_GETSELITEMS = 0x0191;
const LB_SETHORIZONTALEXTENT = 0x0194;
const LB_SETTOPINDEX = 0x0197;
const LB_GETITEMRECT = 0x0198;
const LB_GETITEMDATA = 0x0199;
const LB_SETITEMDATA = 0x019a;
const LB_SELITEMRANGEEX = 0x0183;
const LB_SELITEMRANGE = 0x019b;
const LB_SETANCHORINDEX = 0x019c;
const LB_GETANCHORINDEX = 0x019d;
const LB_SETCARETINDEX = 0x019e;
const LB_GETCARETINDEX = 0x019f;
const LB_SETITEMHEIGHT = 0x01a0;
const LB_GETITEMHEIGHT = 0x01a1;
const LB_GETLISTBOXINFO = 0x01b2;
const LB_FINDSTRINGEXACT = 0x01a2;
const LB_ERR = -1;
/** The list box messages run from LB_ADDSTRING to this one. */
const LB_LAST = 0x01b5;
const LBN_SELCHANGE = 1;
const LBN_DBLCLK = 2;
const LBN_SETFOCUS = 4;
const LBN_KILLFOCUS = 5;

/** Combo box styles, messages and notifications. */
const CBS_TYPEMASK = 0x0003;
/** The scroll bars a combo box is given, which are its list's. */
const WS_VSCROLL = 0x00200000;
/** A window's own vertical bar, as GetScrollInfo names it. */
const SB_VERT_BAR = 1;
const WS_HSCROLL = 0x00100000;
const CBS_SIMPLE = 0x0001;
const CBS_DROPDOWN = 0x0002;
const CBS_SORT = 0x0100;
const CBS_OWNERDRAW = 0x0030;
const CBS_OWNERDRAWFIXED = 0x0010;
const CBS_HASSTRINGS = 0x0200;
const CBS_NOINTEGRALHEIGHT = 0x0400;
const CB_GETEDITSEL = 0x0140;
const CB_LIMITTEXT = 0x0141;
const CB_SETEDITSEL = 0x0142;
const CB_ADDSTRING = 0x0143;
const CB_DELETESTRING = 0x0144;
const CB_DIR = 0x0145;
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
const CB_SELECTSTRING = 0x014d;
const CB_SETDROPPEDWIDTH = 0x0160;
const CB_ERR = -1;
const CBN_SELCHANGE = 1;
const CBN_DBLCLK = 2;
const CBN_SETFOCUS = 3;
const CBN_KILLFOCUS = 4;
const CBN_EDITUPDATE = 5;
const CBN_EDITCHANGE = 6;
const CBN_DROPDOWN = 7;
const CBN_CLOSEUP = 8;
const CBN_SELENDOK = 9;
const CBN_SELENDCANCEL = 10;
/** The dropped list: a child of the desktop over everything, never activated. */
const WS_BORDER = 0x00800000;
const WS_EX_TOOLWINDOW = 0x00000080;
const HWND_TOPMOST = -1;
const SWP_NOACTIVATE = 0x0010;
const SWP_SHOWWINDOW = 0x0040;
const WM_DESTROY = 0x0002;
const WM_MOUSEACTIVATE = 0x0021;
const WM_SYSKEYDOWN = 0x0104;
const MA_NOACTIVATE = 3;
const VK_F4 = 0x73;
/** How far one notch of the wheel scrolls a dropped list, in items. */
const WHEEL_ITEMS = 3;

/** The drop button at the right of a combo box, as wide as a scroll bar. */
const COMBO_BUTTON = 16;
const CB_SETITEMHEIGHT = 0x0153;
const CB_GETITEMHEIGHT = 0x0154;
const CB_GETDROPPEDWIDTH = 0x015f;
const CB_GETCOMBOBOXINFO = 0x0164;
/** The ids a combo box gives its list and its edit, as Windows gives them. */
const COMBO_LIST_ID = 1000;
const COMBO_EDIT_ID = 1001;
/** The combo box styles its edit takes on as the edit's own. */
const CBS_AUTOHSCROLL = 0x0040;
const CBS_OEMCONVERT = 0x0080;
const CBS_UPPERCASE = 0x2000;
const CBS_LOWERCASE = 0x4000;
const ES_UPPERCASE = 0x0008;
const ES_LOWERCASE = 0x0010;
const ES_NOHIDESEL = 0x0100;
const ES_OEMCONVERT = 0x0400;
const WM_CTLCOLORMSGBOX = 0x0132;
/** What a 16-bit control asked its colour with, still passed on. */
const WM_CTLCOLOR = 0x0019;
/** A combo box's list: a list box that tells the combo box, not its parent. */
const LBS_COMBOBOX = 0x8000;
const LBS_NOINTEGRALHEIGHT = 0x0100;
const SW_HIDE = 0;
const WM_WINDOWPOSCHANGING = 0x0046;
const SWP_NOSIZE = 0x0001;

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
const DT_BOTTOM = 0x0008;
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
 * @property {boolean} [unicode]  its text wide; the dialog class's procedure
 *     takes a message in its window's encoding, every other one in ANSI
 */

/** SetBkMode's mode in which text is drawn over the context's background colour. */
const OPAQUE = 2;

/**
 * The drawing the window manager does itself, as gdi32 offers it.
 *
 * @typedef {Object} Drawing
 * @property {(color: number) => number} solidBrush
 * @property {(hdc: number, rect: Rect, color: number) => boolean} fill
 * @property {(hdc: number, rect: Rect, brush: number) => boolean} fillWith
 * @property {(hdc: number, rect: Rect, brush: number) => boolean} frame
 * @property {(hdc: number, rect: Rect, halftone?: boolean) => boolean} invert
 * @property {(hdc: number, rect: Rect, dx: number, dy: number, clip: Rect) => boolean} [scroll]
 *           The pixels of a rectangle moved within the context, only what
 *           lands inside `clip` changing.
 * @property {(hdc: number) => number} [textColor]  The colour a context draws text in.
 * @property {(hdc: number) => number} [bkMode]
 *           OPAQUE or TRANSPARENT, as SetBkMode left the context.
 * @property {(hdc: number, color: number) => number} [setTextColor]
 * @property {(hdc: number, color: number) => number} [setBkColor]
 * @property {(hdc: number, x: number, y: number, text: string,
 *     options?: { color?: number, clip?: Rect | null, transparent?: boolean }) => boolean} text
 *           `transparent: false` draws over the context's own background
 *           colour, in its own mode; otherwise over what is there.
 * @property {(hdc: number, text: string) => { width: number, height: number,
 *     ascent: number }} measure
 * @property {(hdc: number) => number} [averageWidth]  The context's font's average
 *     character width, as GdiGetCharDimensions measures it.
 * @property {(hdc: number, rect: Rect) => number} [clipTo]  The context's clip narrowed
 *     to a rectangle while a control paints; answers what `unclip` puts back.
 * @property {(hdc: number, saved: number) => void} [unclip]
 * @property {(hdc: number, x: number, y: number, bitmap: number, width?: number,
 *     height?: number) => boolean} bitmap  Stretched to a size when one is given.
 * @property {(bitmap: number) => { width: number, height: number, corner: number } | null}
 *     [bitmapShape]  A bitmap's size and its top-left pixel's colour.
 * @property {(hdc: number, x: number, y: number,
 *     picture: { width: number, height: number, bgra: Uint8Array },
 *     width?: number, height?: number) => boolean} [picture]
 *           A decoded icon drawn at a point, its transparent pixels left out.
 */

/**
 * Where a static control's image goes, as its styles say: SS_CENTERIMAGE
 * centres it, clipped when it is larger; SS_REALSIZECONTROL alone
 * stretches it to the control; otherwise it sits at the top left at its
 * own size.
 *
 * @param {{ style: number }} record @param {Rect} rect
 * @param {{ width: number, height: number } | null} shape
 * @returns {{ x: number, y: number, width?: number, height?: number, centred: boolean }}
 */
export const imagePlace = (record, rect, shape)=>{
    if (!shape)
    {
        return { x: rect.left, y: rect.top, centred: false };
    }
    if ((record.style & SS_CENTERIMAGE) !== 0)
    {
        return { x: rect.left + Math.floor((rect.right - rect.left - shape.width) / 2),
            y: rect.top + Math.floor((rect.bottom - rect.top - shape.height) / 2),
            centred: true };
    }
    if ((record.style & SS_REALSIZECONTROL) !== 0)
    {
        return { x: rect.left, y: rect.top, width: rect.right - rect.left,
            height: rect.bottom - rect.top, centred: false };
    }
    return { x: rect.left, y: rect.top, centred: false };
};

/**
 * What the procedures need from the window manager around them.
 *
 * @typedef {Object} ControlHost
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {Drawing | null} draw
 * @property {(handle: number) => import('./cursors.js').CursorPicture | null} [picture]
 *           The picture an icon or cursor handle stands for, null for one this
 *           build cannot read: what a static showing an icon draws.
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
 * @property {(address: number, message: ControlMessage, thread?: unknown,
 *     unicode?: boolean) => number | Promise<number>} callProcedure
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
 * @property {(record: any, thread?: unknown) => number | Promise<number>} [update]
 *           Paints it now, as the call of `thread` -- the control's caller's,
 *           not whichever thread holds the processor past an await.
 * @property {(record: any) => void} [frameChanged]
 *           Its frame changed -- a scroll bar of its own moved -- and is drawn again.
 *           UpdateWindow: what is to paint painted now, when it is shown.
 * @property {(hwnd: number, x: number, y: number, width: number, height: number)
 *     => number | Promise<number>} [move]
 *           MoveWindow, for a control that places itself in its parent.
 * @property {(hwnd: number, after: number, x: number, y: number, width: number,
 *     height: number, flags: number, thread?: unknown) => number | Promise<number>} [place]
 *           SetWindowPos with its flags, on the thread named: a frame
 *           recalculated (SWP_FRAMECHANGED), a child moved without
 *           SWP_NOACTIVATE told WM_CHILDACTIVATE, as Windows' controls do.
 * @property {(record: any) => { x: number, y: number }} [clientOrigin]
 *           Where its client area is on the screen.
 * @property {(className: string, rect: { x: number, y: number, width: number,
 *     height: number }, owner: number, exStyle: number, style: number,
 *     thread?: unknown, id?: number) => number | Promise<number>} [popup]
 *           A window of a system class, made by name: a combo box's list,
 *           a popup on the screen or a child (WS_CHILD) in its parent with
 *           the control id `id`, a child of the desktop for an owner of
 *           zero. Absent, a combo box has no list window.
 * @property {(hwnd: number, command: number) => number | Promise<number>} [show]
 * @property {(hwnd: number) => number | Promise<number>} [destroy]
 * @property {(hwnd: number, address: number) => number} [comboBoxInfo]
 *           GetComboBoxInfo, which CB_GETCOMBOBOXINFO answers with.
 * @property {(hwnd: number, thread?: unknown) => number | Promise<number>} setFocus
 * @property {() => number} focus
 * @property {(hwnd: number) => void} setCapture
 * @property {() => number} capture
 * @property {() => void} releaseCapture
 * @property {(index: number) => number} sysColor
 * @property {(key: number) => boolean} keyDown
 * @property {(bytes: number) => number} [allocate]
 *           Guest memory for a structure a notification hands the parent,
 *           which lives only as long as the message carrying it. Absent in a
 *           build with no heap behind it, and then a notification that needs
 *           a structure cannot be sent.
 * @property {(address: number) => void} [release]
 * @property {(address: number) => { size: number, capacity: number } | null} [block]
 *           A block of the process heap an address starts, as LocalSize and an
 *           in-place LocalReAlloc see it: an edit's text buffer is one.
 * @property {(entry: number, args: number[], thread?: unknown) => number | Promise<number>} [call]
 *           Calls the program's own code: a callback a control is handed.
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {(event: number, hwnd: number, object: number, child: number, thread?: unknown)
 *     => number | Promise<number>} [winEvent]
 *           NotifyWinEvent, as the call of `thread`: what a control raises
 *           where a screen reader would want to hear of a change.
 * @property {import('./objects.js').ClipboardService} [clipboard]
 *           The clipboard an edit copies to and pastes from. Absent, the
 *           clipboard messages do nothing.
 * @property {Record<'CreateCaret' | 'DestroyCaret' | 'ShowCaret' | 'SetCaretPos',
 *     { handler: (args: number[]) => number }>} [caret]
 *           The thread's caret, which an edit takes while it has the focus.
 *           Absent, an edit draws its own bar where typing goes.
 * @property {import('../kernel32/files.js').FileSystem} [files]
 * @property {4 | 8} [pointerSize]  8 in a 64-bit process: a handle's width in a structure.
 * @property {(code: number) => void} [setLastError]
 * @property {(himl: number) => ({ cx: number, cy: number } | null)} [imageListSize]
 *           An image list's image size (comctl32's), for a version 6 button's
 *           ideal size. Absent, a button's list has no size.
 *           The volume LB_DIR and CB_DIR list. Absent, they list nothing.
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
 * Where a scroll bar's parts are along it: the arrow at each end, the track
 * between, and the thumb on it as long as the page is of the range and as far
 * along as the position is -- none when the page holds the whole range. What
 * the bar is painted by, a click is placed by and a drag is read by.
 *
 * @param {Rect} rect @param {boolean} vertical @param {ScrollBarState} held
 * @returns {{ arrow: number, length: number, travel: number, ceiling: number,
 *     thumb: { start: number, length: number } | null }}  `start` from the bar's start.
 */
export function thumbOf(rect, vertical, held){
    const length = vertical ? rect.bottom - rect.top : rect.right - rect.left;
    const arrow = Math.min(ARROW_LENGTH, Math.floor(length / 2));
    const track = length - 2 * arrow;
    const range = Math.max(1, held.max - held.min + 1);
    const ceiling = Math.max(1, held.max - held.min - Math.max(held.page - 1, 0));
    if (track <= 0 || (held.page > 0 && range <= held.page))
    {
        return { arrow, length, travel: 0, ceiling, thumb: null };
    }
    const thumbLength = held.page > 0
        ? Math.max(8, Math.floor(track * Math.min(held.page, range) / range))
        : Math.min(track, ARROW_LENGTH);
    const travel = track - thumbLength;
    const along = Math.max(0, Math.min(held.pos - held.min, ceiling));
    return { arrow, length, travel, ceiling,
        thumb: { start: arrow + Math.floor(travel * along / ceiling), length: thumbLength } };
}

/**
 * The position a thumb dragged to `start` along the bar stands for, as
 * SB_THUMBTRACK reports it: the nearest one, at the ends the range's.
 *
 * @param {Rect} rect @param {boolean} vertical @param {ScrollBarState} held
 * @param {number} start
 */
export function thumbValue(rect, vertical, held, start){
    const { arrow, travel, ceiling } = thumbOf(rect, vertical, held);
    if (travel <= 0)
    {
        return held.min;
    }
    return held.min + Math.round(Math.max(0, Math.min(travel, start - arrow)) * ceiling / travel);
}

/**
 * The drawing and messaging the system classes share, handed to the common
 * controls so a control in comctl32 paints and tells its parent with the same
 * helpers the ones here use. Deliberately loose: it is a bag of the closures
 * below, and naming every one of them here would only restate them.
 *
 * @typedef {Record<string, any>} ControlToolkit
 */

/**
 * Builds the procedures, one per class name, and the pieces the frame
 * shares with them.
 *
 * @param {ControlHost} host
 * @returns {{ procedures: Record<string, ControlProcedure>,
 *     helpers: { dialogProc: ControlProcedure,
 *         markDefault: (dialog: any, focused: number) => void,
 *         defaultControlColors: (message: number, hdc: number) => number,
 *         paintScrollBar: (hdc: number, rect: Rect, vertical: boolean,
 *             held: ScrollBarState) => void,
 *         scrollHit: (rect: Rect, vertical: boolean, held: ScrollBarState,
 *             x: number, y: number) => number,
 *         comboInfo: (combo: any) => { item: Rect, button: Rect, edit: number,
 *             list: number } },
 *     toolkit: ControlToolkit }}
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
     * colour, with the mnemonic's underline, and cut to `clip`.
     *
     * @param {number} hdc @param {string} text @param {Rect} rect @param {number} format
     * @param {number} rgb @param {boolean} [opaque] @param {Rect} [clip]
     */
    const drawText = (hdc, text, rect, format, rgb, opaque = false, clip = rect)=>{
        const draw = /** @type {Drawing} */ (host.draw);
        const metrics = draw.measure(hdc, 'M');
        /** @param {string} piece */
        const widthOf = piece=>draw.measure(hdc, piece).width;
        const lines = layoutText(text, rect, format, {
            cellWidth: metrics.width, cellHeight: metrics.height, width: widthOf,
        });
        for (const line of lines)
        {
            draw.text(hdc, line.x, line.y, line.text,
                { color: rgb, clip, transparent: !opaque });
            if (line.underline !== null)
            {
                const at = line.x + widthOf(line.text.slice(0, line.underline));
                draw.fill(hdc, { left: at, top: line.y + metrics.ascent,
                    right: at + widthOf(line.text[line.underline]),
                    bottom: line.y + metrics.ascent + 1 }, rgb);
            }
        }
    };

    /**
     * A button's label, placed as the button places it: across by BS_LEFT,
     * BS_RIGHT or BS_CENTER -- centred on a push button and at the left of
     * the rest when it says neither -- and down by BS_TOP, BS_BOTTOM or, by
     * default, the middle. One line DrawText places itself; a BS_MULTILINE
     * label is measured and its block put there, since DrawText centres
     * only a single line and leaves every other at the top.
     *
     * @param {any} record @param {number} hdc @param {Rect} rect @param {number} rgb
     * @param {boolean} [opaque]
     */
    const drawLabel = (record, hdc, rect, rgb, opaque = false)=>{
        const draw = /** @type {Drawing} */ (host.draw);
        const style = record.style;
        const across = style & BS_CENTER;
        const horizontal = across === BS_CENTER ? DT_CENTER : across === BS_RIGHT ? DT_RIGHT
            : across === BS_LEFT || !PUSH_KINDS.has(buttonKind(record)) ? 0 : DT_CENTER;
        const down = style & BS_VCENTER;
        if ((style & BS_MULTILINE) === 0)
        {
            drawText(hdc, record.title, rect, horizontal | DT_SINGLELINE
                | (down === BS_TOP ? 0 : down === BS_BOTTOM ? DT_BOTTOM : DT_VCENTER), rgb, opaque);
            return;
        }
        const metrics = draw.measure(hdc, 'M');
        const lines = layoutText(record.title, rect, horizontal | DT_WORDBREAK, {
            cellWidth: metrics.width, cellHeight: metrics.height,
            width: (/** @type {string} */ piece)=>draw.measure(hdc, piece).width,
        });
        const height = lines.length === 0 ? 0
            : lines[lines.length - 1].y + metrics.height - lines[0].y;
        const room = rect.bottom - rect.top;
        const top = down === BS_TOP ? rect.top
            : down === BS_BOTTOM ? rect.bottom - height
                : rect.top + Math.floor((room - height) / 2);
        drawText(hdc, record.title, { ...rect, top, bottom: top + height },
            horizontal | DT_WORDBREAK, rgb, opaque, rect);
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
    const notify = (record, code, thread)=>{
        // The window CreateWindowEx was handed as the parent: a child's
        // parent, or a top-level control's owner, which it was given the same
        // way and which hears it the same way on Windows.
        const to = record.parent || record.owner;
        return to ? host.send(to, WM_COMMAND,
            ((code & 0xffff) << 16 | record.id & 0xffff) >>> 0, record.hwnd, thread) : 0;
    };

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
     * The drawing is handed the client rectangle, not rcPaint: a control lays
     * itself out in all of itself, and the context is already clipped to what
     * needs painting. Laid out in rcPaint, a static half uncovered by a
     * closing dropped list drew its text again from the uncovered part's edge.
     *
     * @param {any} record
     * @param {(hdc: number, rect: Rect) => number | Promise<number> | void} paint
     */
    const painting = (record, paint)=>after(host.beginPaint(record), ({ hdc })=>{
        if (hdc === 0 || !host.draw)
        {
            host.endPaint(record, hdc);
            return 0;
        }
        const size = host.clientSize(record);
        const rect = { left: 0, top: 0, right: size.width, bottom: size.height };
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
                // Painted now, not when the queue is next looked at, as the
                // real static and button paint themselves: a program that
                // labels its progress from a loop that never pumps shows it.
                return after(host.defWindowProc(record, message, thread), answer=>{
                    host.invalidate(record);
                    return after(host.update?.(record, thread) ?? 1, ()=>answer);
                });
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

    /**
     * Hands a control's drawing to its parent: WM_DRAWITEM, the structure
     * in guest memory for as long as the message is being answered. A build
     * with no heap has nowhere to put it, and the control is left undrawn.
     *
     * @param {any} record @param {number} hdc @param {Rect} rect
     * @param {{ type: number, action: number, state: number, item?: number, data?: number }} what
     * @param {unknown} [thread]
     * @returns {number | Promise<number>}
     */
    const drawItem = (record, hdc, rect, what, thread)=>{
        const at = record.parent && host.allocate ? host.allocate(DRAWITEMSTRUCT_SIZE) : 0;
        if (at === 0)
        {
            return 0;
        }
        const fields = [what.type, record.id, what.item ?? 0, what.action, what.state,
            record.hwnd, hdc, rect.left, rect.top, rect.right, rect.bottom, what.data ?? 0];
        const bytes = new Uint8Array(DRAWITEMSTRUCT_SIZE);
        const view = new DataView(bytes.buffer);
        fields.forEach((value, index)=>view.setUint32(index * 4, value >>> 0, true));
        host.writeMemory(at, bytes);
        return after(host.send(record.parent, WM_DRAWITEM, record.id, at, thread), ()=>{
            host.release?.(at);
            return 0;
        });
    };

    /**
     * The colour a control painted on WM_CTLCOLORSTATIC writes its text in:
     * whatever the parent left in the context it was handed -- the window
     * text colour unless the parent set its own -- and grey while disabled.
     *
     * @param {any} record @param {number} hdc
     */
    const staticInk = (record, hdc)=>(disabled(record) ? color(COLOR_GRAYTEXT)
        : host.draw?.textColor?.(hdc) ?? color(COLOR_WINDOWTEXT));

    /**
     * Whether that text is drawn over the context's background colour: the
     * mode a context starts in, unless the parent made it transparent.
     *
     * @param {number} hdc
     */
    const staticOpaque = hdc=>host.draw?.bkMode?.(hdc) === OPAQUE;

    /**
     * What the default procedure answers a control that asked WM_CTLCOLOR*:
     * the window text on the window colour for an edit or a list box, on
     * the 3D face for the rest, set in the context, and a brush of that
     * background (zero in a build that draws nothing).
     *
     * @param {number} message @param {number} hdc
     * @returns {number}
     */
    const defaultControlColors = (message, hdc)=>{
        const face = message === WM_CTLCOLOREDIT || message === WM_CTLCOLORLISTBOX
            ? COLOR_WINDOW : COLOR_3DFACE;
        host.draw?.setTextColor?.(hdc, color(COLOR_WINDOWTEXT));
        host.draw?.setBkColor?.(hdc, color(face));
        return host.draw ? host.draw.solidBrush(color(face)) : 0;
    };

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

        if (PUSH_KINDS.has(kind))
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
            drawLabel(record, hdc, shifted, ink);
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
                drawText(hdc, text, { ...label, left: label.left + 2 }, DT_SINGLELINE,
                    staticInk(record, hdc), staticOpaque(hdc));
            }
            return;
        }

        // Check boxes and radio buttons: the mark to the left of the text, or
        // to the right of it with BS_LEFTTEXT, at the top or bottom with the
        // text that BS_TOP or BS_BOTTOM puts there, and centred otherwise --
        // a BS_TOP box left in the middle stood a line below its label.
        background(hdc, rect, brush, COLOR_3DFACE);
        const leftText = (record.style & BS_LEFTTEXT) !== 0;
        const down = record.style & BS_VCENTER;
        const top = down === BS_TOP ? rect.top
            : down === BS_BOTTOM ? Math.max(rect.top, rect.bottom - CHECK_SIZE)
                : rect.top + Math.max(0, Math.floor((rect.bottom - rect.top - CHECK_SIZE) / 2));
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
        drawLabel(record, hdc, textRect, staticInk(record, hdc), staticOpaque(hdc));
    };

    /** @param {any} record  How an owner-drawn button's parent is told it stands. */
    const buttonItemState = record=>{
        const state = stateOf(record);
        return (state.pushed ? ODS_SELECTED : 0) | (disabled(record) ? ODS_DISABLED : 0)
            | (state.focused ? ODS_FOCUS : 0);
    };

    /**
     * An owner-drawn button's change drawn at once, as the button draws it
     * rather than waiting for a paint: its parent asked for the colour and
     * then told what changed.
     *
     * @param {any} record @param {number} action @param {unknown} [thread]
     */
    const redrawOwnerButton = (record, action, thread)=>{
        if ((record.style & WS_VISIBLE) === 0)
        {
            return 0;
        }
        const { hdc, rect } = host.contextOn(record);
        if (hdc === 0)
        {
            host.endPaint(record, hdc);
            return 0;
        }
        return after(controlColor(record, WM_CTLCOLORBTN, hdc, thread), ()=>after(
            drawItem(record, hdc, rect,
                { type: ODT_BUTTON, action, state: buttonItemState(record) }, thread),
            ()=>{
                host.endPaint(record, hdc);
                return 0;
            }));
    };

    /**
     * A button pushed in or let out: repainted, or for an owner-drawn one
     * drawn by its parent there and then.
     *
     * @param {any} record @param {boolean} pushed @param {unknown} [thread]
     */
    const setPushed = (record, pushed, thread)=>{
        const state = stateOf(record);
        const changed = (state.pushed === true) !== pushed;
        state.pushed = pushed;
        if (buttonKind(record) === BS_OWNERDRAW)
        {
            return changed ? redrawOwnerButton(record, ODA_SELECT, thread) : 0;
        }
        host.invalidate(record);
        return 0;
    };

    /**
     * The text of a button in its font, for its ideal size: through a
     * context on the window, the only place its font can be asked.
     *
     * @param {any} record @param {string} text @param {number} [wrapAt]
     */
    const buttonTextExtent = (record, text, wrapAt)=>{
        const draw = host.draw;
        if (!draw)
        {
            return { width: text.length * 8, height: 16 };
        }
        const { hdc } = host.contextOn(record);
        try
        {
            const metrics = draw.measure(hdc, 'M');
            const lines = layoutText(text, { left: 0, top: 0, right: wrapAt ?? 0x7fff,
                bottom: 0x7fff }, wrapAt === undefined ? 0 : DT_WORDBREAK, {
                cellWidth: metrics.width, cellHeight: metrics.height,
                width: (/** @type {string} */ piece)=>draw.measure(hdc, piece).width,
            });
            const widest = lines.reduce((most, line)=>
                Math.max(most, draw.measure(hdc, line.text).width), 0);
            return {
                width: widest,
                height: Math.max(lines.length, 1) * metrics.height,
            };
        }
        finally
        {
            host.endPaint(record, hdc);
        }
    };
    const buttonV6 = createButtonV6({
        read: host.readMemory, write: host.writeMemory, pointerSize: host.pointerSize ?? 4,
        imageListSize: himl=>host.imageListSize?.(himl) ?? null,
        imageSize: image=>imageSize(image),
        textExtent: buttonTextExtent,
        clientSize: record=>host.clientSize(record),
        setLastError: code=>host.setLastError?.(code),
    });

    /**
     * @param {any} record @param {ControlMessage} message @param {unknown} [thread]
     */
    const buttonProc = (record, message, thread)=>{
        const state = stateOf(record);
        const kind = buttonKind(record);
        const six = buttonV6.answer(record, state, message);
        if (six !== undefined)
        {
            return six;
        }
        switch (message.message){
            case WM_PAINT:
                if (kind === BS_OWNERDRAW)
                {
                    return painting(record, (hdc, rect)=>after(
                        controlColor(record, WM_CTLCOLORBTN, hdc, thread), ()=>drawItem(record,
                            hdc, rect, { type: ODT_BUTTON, action: ODA_DRAWENTIRE,
                                state: buttonItemState(record) }, thread)));
                }
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
                return after(setPushed(record, true, thread),
                    ()=>after(host.setFocus(record.hwnd, thread), ()=>0));
            case WM_MOUSEMOVE: {
                if (host.capture() !== record.hwnd)
                {
                    return 0;
                }
                const point = pointOf(message.lParam);
                const inside = contains(clientRect(record), point.x, point.y);
                return inside !== (state.pushed === true) ? setPushed(record, inside, thread) : 0;
            }
            case WM_LBUTTONUP: {
                if (host.capture() !== record.hwnd)
                {
                    return 0;
                }
                host.releaseCapture();
                const wasPushed = state.pushed === true;
                const point = pointOf(message.lParam);
                return after(setPushed(record, false, thread), ()=>
                    (wasPushed && contains(clientRect(record), point.x, point.y)
                        ? clickButton(record, thread)
                        : 0));
            }
            case WM_KEYDOWN:
                if (message.wParam === VK_SPACE && !disabled(record) && kind !== BS_GROUPBOX)
                {
                    return after(setPushed(record, true, thread), ()=>0);
                }
                return 0;
            case WM_KEYUP:
                if (message.wParam === VK_SPACE && state.pushed)
                {
                    return after(setPushed(record, false, thread),
                        ()=>clickButton(record, thread));
                }
                return 0;
            // The focus notifications go out only with BS_NOTIFY, as
            // documented: a parent that looks at the id alone and not the
            // code would otherwise take a focus change for a click.
            case WM_SETFOCUS:
            case WM_KILLFOCUS: {
                const gained = message.message === WM_SETFOCUS;
                state.focused = gained;
                if (!gained)
                {
                    state.pushed = false;
                }
                const drawn = kind === BS_OWNERDRAW
                    ? redrawOwnerButton(record, ODA_FOCUS, thread)
                    : (host.invalidate(record), 0);
                return after(drawn, ()=>((record.style & BS_NOTIFY) !== 0
                    ? notify(record, gained ? BN_SETFOCUS : BN_KILLFOCUS, thread) : 0));
            }
            case WM_CAPTURECHANGED:
                return state.pushed ? after(setPushed(record, false, thread), ()=>0) : 0;
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
                    // A radio button checked is the one Tab reaches in its
                    // group, and one unchecked is not (dialog.c test_focus:
                    // the dialog's first tab stop is the group's checked one).
                    if (RADIO_KINDS.has(kind))
                    {
                        record.style = (wanted === BST_UNCHECKED ? record.style & ~WS_TABSTOP
                            : record.style | WS_TABSTOP) >>> 0;
                    }
                }
                return 0;
            case BM_GETSTATE:
                return (state.check ?? BST_UNCHECKED)
                    | (state.pushed ? BST_PUSHED : 0) | (state.focused ? BST_FOCUS : 0);
            case BM_SETSTATE:
                return after(setPushed(record, message.wParam !== 0, thread), ()=>0);
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
            // The image a button holds, whatever its style says it shows:
            // the one before is handed back, and a type that is neither a
            // bitmap nor an icon is no image.
            case BM_SETIMAGE: {
                if (message.wParam !== IMAGE_BITMAP && message.wParam !== IMAGE_ICON)
                {
                    return 0;
                }
                const before = state.image?.handle ?? 0;
                state.image = message.lParam === 0 ? null
                    : { type: message.wParam, handle: message.lParam >>> 0 };
                host.invalidate(record);
                return before;
            }
            case BM_GETIMAGE:
                return state.image && state.image.type === message.wParam ? state.image.handle : 0;
            default:
                return common(record, message, thread);
        }
    };

    // --- Static -------------------------------------------------------------

    /**
     * An image's size: an icon's or cursor's picture, or a bitmap's. Null for
     * a handle with nothing this build can measure.
     *
     * @param {number} image
     * @returns {{ width: number, height: number } | null}
     */
    const imageSize = image=>{
        if (image === 0)
        {
            return null;
        }
        const picture = host.picture?.(image) ?? null;
        return picture ?? host.draw?.bitmapShape?.(image) ?? null;
    };

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
                const image = state.image ?? 0;
                const picture = image !== 0 ? host.picture?.(image) ?? null : null;
                const shape = picture ?? (image !== 0 ? draw.bitmapShape?.(image) ?? null : null);
                const place = imagePlace(record, rect, shape);
                // A bitmap centred leaves the rest of the control its top-left
                // pixel's colour, as the static control fills it.
                if (place.centred && !picture && shape && 'corner' in shape)
                {
                    draw.fill(hdc, rect, shape.corner);
                }
                else
                {
                    background(hdc, rect, brush, COLOR_3DFACE);
                }
                const drawn = picture
                    ? draw.picture?.(hdc, place.x, place.y, picture, place.width, place.height)
                        === true
                    : draw.bitmap(hdc, place.x, place.y, image, place.width, place.height);
                if (image !== 0 && !drawn && !state.imageDivergenceSaid)
                {
                    state.imageDivergenceSaid = true;
                    host.divergence?.('Static',
                        `an SS_${kind === SS_ICON ? 'ICON' : 'BITMAP'} image without pixels this`
                        + ' build can draw is left blank');
                }
                return true;
            }
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
        drawText(hdc, record.title, inside, format, staticInk(record, hdc), staticOpaque(hdc));
        return true;
    };

    /**
     * @param {any} record @param {ControlMessage} message @param {unknown} [thread]
     */
    const staticProc = (record, message, thread)=>{
        const state = stateOf(record);
        switch (message.message){
            case WM_CREATE: {
                // An etched line or a sunken static is drawn by its edge:
                // Windows gives it WS_EX_STATICEDGE, and an etched line is the
                // edge alone - a horizontal one has no client height, a
                // vertical one no client width. A system class's procedure is
                // first told WM_CREATE, so the frame is laid again here.
                const type = record.style & SS_TYPEMASK;
                const etched = type === SS_ETCHEDHORZ || type === SS_ETCHEDVERT;
                if ((!etched && (record.style & SS_SUNKEN) === 0) || !host.move)
                {
                    return common(record, message, thread);
                }
                record.exStyle = (record.exStyle | WS_EX_STATICEDGE) >>> 0;
                const framed = host.move(record.hwnd, record.x, record.y, record.width,
                    record.height);
                return after(framed, ()=>{
                    if (!etched)
                    {
                        return common(record, message, thread);
                    }
                    const size = host.clientSize(record);
                    return after(host.move?.(record.hwnd, record.x, record.y,
                        type === SS_ETCHEDVERT ? record.width - size.width : record.width,
                        type === SS_ETCHEDHORZ ? record.height - size.height : record.height),
                    ()=>common(record, message, thread));
                });
            }
            case WM_PAINT:
                // An owner-drawn static is its parent's to draw, all of it:
                // asked for a colour first, as every static asks. The
                // context is clipped to the control while it paints, so the
                // parent answering WM_CTLCOLORSTATIC finds a clip selected.
                return painting(record, (hdc, rect)=>{
                    const saved = host.draw?.clipTo?.(hdc, clientRect(record)) ?? 0;
                    return after(after(controlColor(record, WM_CTLCOLORSTATIC, hdc, thread),
                        brush=>{
                            if ((record.style & SS_TYPEMASK) === SS_OWNERDRAW)
                            {
                                return drawItem(record, hdc, rect, { type: ODT_STATIC,
                                    action: ODA_DRAWENTIRE,
                                    state: disabled(record) ? ODS_DISABLED : 0 }, thread);
                            }
                            paintStatic(record, hdc, rect, brush);
                            return 0;
                        }), answer=>{
                        host.draw?.unclip?.(hdc, saved);
                        return answer;
                    });
                });
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
                // A static takes only the image its style shows - an icon or
                // a cursor for SS_ICON, a bitmap for SS_BITMAP, a metafile for
                // SS_ENHMETAFILE - and answers 0 for another, keeping none.
                const asked = message.message === STM_SETICON
                    ? IMAGE_ICON : message.wParam & 0xffff;
                const type = record.style & SS_TYPEMASK;
                const shows = type === SS_ICON ? asked === IMAGE_ICON || asked === IMAGE_CURSOR
                    : type === SS_BITMAP ? asked === IMAGE_BITMAP
                        : type === SS_ENHMETAFILE && asked === IMAGE_ENHMETAFILE;
                if (!shows)
                {
                    return 0;
                }
                const previous = state.image ?? 0;
                state.image = (message.message === STM_SETICON
                    ? message.wParam : message.lParam) >>> 0;
                state.imageType = asked === IMAGE_CURSOR ? IMAGE_ICON : asked;
                host.invalidate(record);
                // Neither centred nor stretched, the image is the control's
                // size: it ignores the size it was made with and takes the
                // image's, so what lies beside it in the template shows.
                const sized = (record.style & (SS_CENTERIMAGE | SS_REALSIZECONTROL)) === 0
                    ? imageSize(state.image) : null;
                const moved = sized && host.move
                    && (sized.width !== record.width || sized.height !== record.height)
                    ? host.move(record.hwnd, record.x, record.y, sized.width, sized.height) : 0;
                // Drawn at once, its parent asked for the colour again.
                return after(moved, ()=>after(host.update?.(record, thread) ?? 1, ()=>previous));
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
     * ES_AUTOHSCROLL, wraps where its text, in its font, reaches the client
     * width -- at the last space before that, or there when a word is wider
     * than the line. Measured on `hdc`, or on a context of the edit's own
     * when none is given; with nothing to measure on, at a count of
     * characters as wide as the cell.
     *
     * @param {any} record @param {number} [hdc]
     * @returns {{ text: string, start: number }[]}
     */
    const editLines = (record, hdc = 0)=>{
        const text = record.title;
        if (!multiline(record))
        {
            return [{ text, start: 0 }];
        }
        const own = hdc === 0 && host.draw ? host.contextOn(record).hdc : 0;
        const measuring = hdc !== 0 ? hdc : own;
        try
        {
            const draw = host.draw;
            /** @type {Map<string, number>} */
            const widths = new Map();
            /** @param {string} character */
            const advance = character=>{
                let width = widths.get(character);
                if (width === undefined)
                {
                    width = draw && measuring !== 0 ? draw.measure(measuring, character).width : 1;
                    widths.set(character, width);
                }
                return width;
            };
            const room = draw && measuring !== 0
                ? host.clientSize(record).width - 2 * EDIT_MARGIN : editGridColumns(record);
            return wrapEditText(text, (record.style & ES_AUTOHSCROLL) === 0 && room > 0,
                room, advance);
        }
        finally
        {
            if (own !== 0)
            {
                host.endPaint(record, own);
            }
        }
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
        // Whatever moved its lines since -- an insertion, a stream, a new
        // size or font -- the bar is drawn with what is drawn here.
        syncEditBar(record);
        const readOnly = (record.style & ES_READONLY) !== 0 || disabled(record);
        if (state.richBackground !== undefined)
        {
            draw.fill(hdc, rect, state.richBackground);
        }
        else
        {
            background(hdc, rect, brush, readOnly ? COLOR_3DFACE : COLOR_WINDOW);
        }
        const grid = editGrid(record, hdc);
        const lines = editLines(record, hdc);
        // The text colour the parent left in the context on WM_CTLCOLOREDIT --
        // white on the black brush of a game's name box -- as a static's; a
        // rich edit asks its parent for nothing and keeps the window text.
        const ink = state.richBackground !== undefined
            ? color(disabled(record) ? COLOR_GRAYTEXT : COLOR_WINDOWTEXT)
            : staticInk(record, hdc);
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
            // The caret, where there is no thread caret to take: a bar
            // before the character the selection ends at.
            const caret = state.selEnd - line.start - scrolled;
            if (!host.caret && focused && !readOnly && caret >= 0 && caret <= text.length
                && (state.selEnd < line.start + line.text.length || first + row === lines.length - 1
                    || state.selEnd === line.start + line.text.length))
            {
                draw.fill(hdc, { left: xOf(caret), top: y, right: xOf(caret) + 1,
                    bottom: y + grid.cellHeight }, ink);
            }
        }
        if (host.caret && focused)
        {
            const at = caretPoint(record, hdc, rect);
            host.caret.SetCaretPos.handler([at.x, at.y]);
        }
    };

    /**
     * Where an edit's caret goes: before the character its selection ends
     * at, on the line that character is on, measured as the text is drawn --
     * and outside the client area when that line is scrolled out of view,
     * where the caret is clipped away rather than moved to an edge.
     *
     * @param {any} record @param {number} hdc @param {Rect} rect
     * @returns {{ x: number, y: number, height: number }}
     */
    const caretPoint = (record, hdc, rect)=>{
        const draw = /** @type {Drawing} */ (host.draw);
        const state = editState(record);
        const grid = editGrid(record, hdc);
        const lines = editLines(record, hdc);
        const top = multiline(record)
            ? rect.top + EDIT_MARGIN
            : rect.top + Math.max(0, Math.floor((rect.bottom - rect.top - grid.cellHeight) / 2));
        const first = multiline(record) ? Math.min(state.firstLine, lines.length - 1) : 0;
        const scrolled = multiline(record) ? 0 : state.firstColumn ?? 0;
        const found = lines.findIndex(line=>state.selEnd >= line.start
            && state.selEnd <= line.start + line.text.length);
        const index = found === -1 ? lines.length - 1 : found;
        const line = lines[index];
        const text = shown(record, line.text);
        const column = Math.max(0, Math.min(text.length, state.selEnd - line.start));
        const x = rect.left + EDIT_MARGIN + (column >= scrolled
            ? draw.measure(hdc, text.slice(scrolled, column)).width
            : -draw.measure(hdc, text.slice(column, scrolled)).width);
        return { x, y: top + (index - first) * grid.cellHeight, height: grid.cellHeight };
    };

    /**
     * An edit gaining the focus takes the thread's caret, as the real one
     * does: a bar one pixel wide and a line high, placed and shown.
     *
     * @param {any} record
     */
    const takeCaret = record=>{
        const caret = host.caret;
        if (!caret || !host.draw)
        {
            return;
        }
        const { hdc, rect } = host.contextOn(record);
        if (hdc === 0)
        {
            host.endPaint(record, hdc);
            return;
        }
        const at = caretPoint(record, hdc, rect);
        host.endPaint(record, hdc);
        if (caret.CreateCaret.handler([record.hwnd, 0, 1, at.height]) !== 0)
        {
            caret.SetCaretPos.handler([at.x, at.y]);
            caret.ShowCaret.handler([record.hwnd]);
        }
    };

    /**
     * Replaces the selection with text, keeps within the limit, moves the
     * caret past what was inserted, and tells the parent: EN_UPDATE, EN_CHANGE,
     * and EN_MAXTEXT when the limit cut the text short.
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
     * Keeps what an edit held before a change, for WM_UNDO to put back: one
     * level, as the control keeps. A run of typing is one change, so the
     * first character of a run is what remembers; anything else ends the
     * run.
     *
     * @param {any} record @param {boolean} [typing]
     */
    const rememberUndo = (record, typing = false)=>{
        const state = editState(record);
        if (!typing || !state.typingRun)
        {
            state.undo = { text: record.title, selStart: state.selStart, selEnd: state.selEnd };
        }
        state.typingRun = typing;
    };

    /**
     * Swaps what an edit holds with what it held before its last change, so
     * that undoing twice is the change again.
     *
     * @param {any} record @param {unknown} [thread]
     */
    const undoEdit = (record, thread)=>{
        const state = editState(record);
        const before = state.undo;
        if (!before)
        {
            return 0;
        }
        state.undo = { text: record.title, selStart: state.selStart, selEnd: state.selEnd };
        state.typingRun = false;
        record.title = before.text;
        state.selStart = before.selStart;
        state.selEnd = before.selEnd;
        state.modified = true;
        host.invalidate(record);
        return after(notify(record, EN_UPDATE, thread),
            ()=>after(notify(record, EN_CHANGE, thread), ()=>1));
    };

    /** @param {any} record @returns {string} the text an edit has selected */
    const selectedText = record=>{
        const state = editState(record);
        return record.title.slice(Math.min(state.selStart, state.selEnd),
            Math.max(state.selStart, state.selEnd));
    };

    /**
     * Moves the caret, extending the selection when Shift is held.
     *
     * @param {any} record @param {number} to
     */
    const moveCaret = (record, to)=>{
        const state = editState(record);
        const clamped = Math.max(0, Math.min(record.title.length, to));
        state.typingRun = false;
        state.selEnd = clamped;
        if (!host.keyDown(VK_SHIFT))
        {
            state.selStart = clamped;
        }
        host.invalidate(record);
    };

    /**
     * Enter, Escape and Tab reaching a multi-line edit in a dialog, which
     * asked for every key: Enter without ES_WANTRETURN goes to the dialog's
     * default button (focus on it, then the key posted to it), Escape closes
     * the dialog, Tab moves to the next or previous control. Null for any
     * other key.
     *
     * @param {any} record @param {number} key @param {unknown} thread
     * @returns {number | Promise<number> | null}
     */
    const dialogKeyOfEdit = (record, key, thread)=>{
        const parent = record.parent;
        if (key === VK_ESCAPE)
        {
            host.post({ hwnd: parent, message: WM_CLOSE, wParam: 0, lParam: 0 });
            return 0;
        }
        if (key === VK_TAB)
        {
            return after(host.send(parent, WM_NEXTDLGCTL, host.keyDown(VK_SHIFT) ? 1 : 0, 0,
                thread), ()=>0);
        }
        if (key !== VK_RETURN || (record.style & ES_WANTRETURN) !== 0)
        {
            return null;
        }
        return after(host.send(parent, DM_GETDEFID, 0, 0, thread), answer=>{
            if ((answer >>> 16) !== DC_HASDEFID)
            {
                return 0;
            }
            const owner = host.live(parent);
            const button = owner ? host.children(owner)
                .find(child=>(child.id & 0xffff) === (answer & 0xffff)) : undefined;
            if (!button)
            {
                return 0;
            }
            return after(host.send(parent, WM_NEXTDLGCTL, button.hwnd, 1, thread), ()=>{
                host.post({ hwnd: button.hwnd, message: WM_KEYDOWN, wParam: VK_RETURN,
                    lParam: 0 });
                return 0;
            });
        });
    };

    /**
     * A character arriving at an edit. Backspace narrows or deletes the selection, a return
     * belongs to a multi-line edit that asked for one, control characters are
     * not text, and anything else replaces the selection.
     *
     * @param {any} record @param {number} character @param {unknown} thread
     * @param {boolean} readOnly
     */
    const editCharacter = (record, character, thread, readOnly)=>{
        if (readOnly || disabled(record))
        {
            return 0;
        }
        const state = editState(record);
        if (character === VK_BACK)
        {
            rememberUndo(record);
            if (state.selStart === state.selEnd && state.selEnd > 0)
            {
                state.selStart = state.selEnd - 1;
            }
            return replaceSelection(record, '', thread);
        }
        // Return and tab are text to a multi-line edit, whatever its
        // ES_WANTRETURN: that style says what the edit does with the key in a
        // dialog (WM_KEYDOWN), not with the character.
        // In a dialog the keys themselves did the work - moved the focus,
        // pressed the default button - and the character they translate to
        // is not typed.
        const inDialog = state.dialogMode === true;
        if (inDialog && multiline(record) && (character === VK_TAB
            || (character === VK_RETURN && (record.style & ES_WANTRETURN) === 0)))
        {
            return 0;
        }
        if ((character === VK_RETURN || character === VK_TAB) && multiline(record))
        {
            rememberUndo(record, true);
            return replaceSelection(record, character === VK_RETURN ? '\r\n' : '\t',
                thread);
        }
        if (character < VK_SPACE || character === VK_ESCAPE || character === 0x7f)
        {
            return 0;
        }
        rememberUndo(record, true);
        return replaceSelection(record, String.fromCharCode(character), thread);
    };

    /**
     * The selection both spellings set: EM_SETSEL for an edit, CB_SETEDITSEL
     * for the field of an editable combo box. A start of -1 deselects; an end
     * of -1 means to the end of the text.
     *
     * @param {any} record @param {number} start @param {number} end
     */
    const setSelection = (record, start, end)=>{
        const state = editState(record);
        state.typingRun = false;
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
    };

    /**
     * The character at a client point, for a click.
     *
     * @param {any} record @param {number} hdc @param {number} x @param {number} y
     */
    const charFromPoint = (record, hdc, x, y)=>{
        const state = editState(record);
        const grid = editGrid(record, hdc);
        const lines = editLines(record, hdc);
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
        const total = editLines(record).length;
        const rows = editGridRows(record);
        const ceiling = Math.max(0, total - rows);
        const wanted = Math.max(0, Math.min(ceiling, state.firstLine + lines));
        const moved = wanted - state.firstLine;
        state.firstLine = wanted;
        if (moved !== 0)
        {
            host.invalidate(record);
        }
        syncEditBar(record);
        return moved;
    };

    /**
     * A multi-line edit's own vertical scroll bar, kept as the edit keeps it:
     * its range the lines, its page the lines that show, its position the
     * first that does -- what GetScrollInfo answers about it, and where its
     * thumb is drawn. A licence page that enables "I accept" only once the
     * bar says the text is read to its end reads it there.
     *
     * @param {any} record
     */
    const syncEditBar = record=>{
        const state = editState(record);
        // The bars it was made with, which a rich edit shows and hides.
        state.bars ??= record.style & (WS_VSCROLL | WS_HSCROLL);
        if (!multiline(record) || (state.bars & WS_VSCROLL) === 0)
        {
            return;
        }
        if (state.rich && (record.style & ES_DISABLENOSCROLL) === 0 && showRichBars(record))
        {
            return;
        }
        if ((record.style & WS_VSCROLL) === 0)
        {
            return;
        }
        const total = editLines(record).length;
        const held = scrollOf(record, SB_VERT_BAR);
        const next = { min: 0, max: Math.max(0, total - 1), page: editGridRows(record),
            pos: state.firstLine };
        if (held.min === next.min && held.max === next.max && held.page === next.page
            && held.pos === next.pos)
        {
            return;
        }
        Object.assign(held, next, { trackPos: next.pos });
        host.frameChanged?.(record);
    };

    /**
     * A rich edit's bars without ES_DISABLENOSCROLL: the vertical one there
     * only while there are more lines than show, the horizontal one only
     * when lines run on rather than wrap -- as the rich edit hides a bar it
     * has no use for, where a plain edit keeps it, disabled. A setup's
     * welcome text that fits showed both bars, empty. Answers whether the
     * style changed, the frame redrawn and the bar set on the next paint.
     *
     * @param {any} record
     */
    const showRichBars = record=>{
        const state = editState(record);
        const total = editLines(record).length;
        const vertical = total > editGridRows(record) ? WS_VSCROLL : 0;
        const horizontal = (state.bars & WS_HSCROLL) !== 0
            && (record.style & ES_AUTOHSCROLL) !== 0 ? WS_HSCROLL : 0;
        const style = ((record.style & ~(WS_VSCROLL | WS_HSCROLL)) | vertical | horizontal) >>> 0;
        if (style === record.style)
        {
            return false;
        }
        record.style = style;
        host.frameChanged?.(record);
        host.invalidate(record);
        return true;
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
     * The text an edit holds in the buffer EM_GETHANDLE handed out or
     * EM_SETHANDLE gave it: the program may write it in place, so it is read
     * before every message and written after one that changed the text. An
     * ANSI window's buffer is ANSI, a Unicode one's UTF-16 (user32's edit;
     * Common Controls 6's is always UTF-16).
     *
     * @param {any} record
     */
    const pullEditBuffer = record=>{
        const state = editState(record);
        const block = host.block?.(state.handle);
        if (!block)
        {
            return;
        }
        const bytes = host.readMemory(state.handle, block.size);
        if (record.unicode === true)
        {
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
            record.title = text;
        }
        else
        {
            const end = bytes.indexOf(0);
            record.title = decodeAnsi(bytes.subarray(0, end < 0 ? bytes.length : end));
        }
    };
    /** @param {any} record @param {string} text @returns {Uint8Array} */
    const encodeEditBuffer = (record, text)=>{
        if (record.unicode !== true)
        {
            return encodeAnsi(`${text}\0`);
        }
        const bytes = new Uint8Array((text.length + 1) * 2);
        for (let at = 0; at < text.length; at++)
        {
            bytes[2 * at] = text.charCodeAt(at) & 0xff;
            bytes[2 * at + 1] = text.charCodeAt(at) >>> 8;
        }
        return bytes;
    };
    /**
     * Writes the text back into the buffer: in place while the block holds
     * it, else into a larger block that replaces it, as LocalReAlloc moves a
     * fixed block - the program asks EM_GETHANDLE again for where it went.
     *
     * @param {any} record
     */
    const pushEditBuffer = record=>{
        const state = editState(record);
        const bytes = encodeEditBuffer(record, record.title);
        const block = host.block?.(state.handle);
        if (block && bytes.length <= block.capacity)
        {
            host.writeMemory(state.handle, bytes);
            return;
        }
        const grown = host.allocate?.(bytes.length + EDIT_BUFFER_STEP) ?? 0;
        if (grown === 0)
        {
            host.divergence?.('Edit', 'no memory to grow the text buffer EM_GETHANDLE handed out');
            return;
        }
        host.writeMemory(grown, bytes);
        if (block)
        {
            host.release?.(state.handle);
        }
        state.handle = grown;
    };

    /**
     * An edit's messages, its text read from and written back to the
     * program's buffer around each where it has one (EM_GETHANDLE).
     *
     * @param {any} record @param {ControlMessage} message @param {unknown} [thread]
     */
    const editProc = (record, message, thread)=>{
        const state = editState(record);
        if (!state.handle)
        {
            return editMessage(record, message, thread);
        }
        pullEditBuffer(record);
        const before = record.title;
        return after(editMessage(record, message, thread), answer=>{
            if (state.handle && record.title !== before)
            {
                pushEditBuffer(record);
            }
            return answer;
        });
    };

    /**
     * @param {any} record @param {ControlMessage} message @param {unknown} [thread]
     */
    const editMessage = (record, message, thread)=>{
        const state = editState(record);
        const readOnly = ()=>(record.style & ES_READONLY) !== 0;
        switch (message.message){
            case WM_PAINT:
                // A rich edit paints in a background of its own and asks its
                // parent for none.
                return painting(record, (hdc, rect)=>after(state.richBackground !== undefined
                    ? 0 : controlColor(record, readOnly() || disabled(record)
                        ? WM_CTLCOLORSTATIC : WM_CTLCOLOREDIT, hdc, thread), brush=>{
                    paintEdit(record, hdc, rect, brush);
                    return 0;
                }));
            case WM_ERASEBKGND:
                return 1;
            case WM_GETDLGCODE:
                // Asked with the message the dialog manager is about to
                // handle, the edit knows it lives in a dialog, and a
                // multi-line one then answers Enter, Escape and Tab itself
                // (WM_KEYDOWN below). It wants every key whatever
                // ES_WANTRETURN says.
                if ((message.lParam >>> 0) !== 0)
                {
                    state.dialogMode = true;
                }
                // A combo box's edit wants Enter and Escape while the list is
                // dropped: they close it.
                return DLGC_WANTCHARS | DLGC_WANTARROWS | DLGC_HASSETSEL
                    | (multiline(record) || comboDropped(record) ? DLGC_WANTALLKEYS : 0);
            case WM_SETFOCUS:
                takeCaret(record);
                host.invalidate(record);
                return notify(record, EN_SETFOCUS, thread);
            case WM_KILLFOCUS:
                host.caret?.DestroyCaret.handler([]);
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
                    state.typingRun = false;
                }
                host.endPaint(record, hdc);
                host.invalidate(record);
                return after(host.setFocus(record.hwnd, thread), ()=>0);
            }
            case WM_CHAR: {
                // Ctrl+C, V, X and Z are the clipboard's and undo's, sent to the
                // edit as their own messages; every character answers 1.
                const character = message.wParam & 0xffff;
                const command = EDIT_CONTROL_CHARACTERS.get(character);
                if (command !== undefined)
                {
                    return after(host.send(record.hwnd, command, 0, 0, thread), ()=>1);
                }
                return after(editCharacter(record, character, thread, readOnly()),
                    ()=>1);
            }
            case WM_SYSKEYDOWN:
            case WM_KEYDOWN: {
                const key = message.wParam & 0xff;
                // A combo box's edit hands its combo box the keys that walk
                // and drop the list, and Enter and Escape while it is dropped.
                const combo = comboOfEdit(record);
                if (combo && (key === VK_UP || key === VK_DOWN
                    || (message.message === WM_KEYDOWN && (key === VK_F4
                        || ((key === VK_RETURN || key === VK_ESCAPE) && comboDropped(record))))))
                {
                    return host.send(combo.hwnd, message.message, message.wParam, message.lParam,
                        thread);
                }
                if (message.message === WM_SYSKEYDOWN)
                {
                    return common(record, message, thread);
                }
                const rows = editGridRows(record);
                if (state.dialogMode === true && multiline(record) && record.parent)
                {
                    const answered = dialogKeyOfEdit(record, key, thread);
                    if (answered !== null)
                    {
                        return answered;
                    }
                }
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
                        rememberUndo(record);
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
                const total = editLines(record).length;
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
                state.undo = null;
                state.typingRun = false;
                host.invalidate(record);
                syncEditBar(record);
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
            case EM_SETSEL:
                setSelection(record, message.wParam | 0, message.lParam | 0);
                return 0;
            case EM_REPLACESEL: {
                const address = message.lParam >>> 0;
                // wParam is fCanUndo: whether the replacement can be undone.
                if (message.wParam !== 0)
                {
                    rememberUndo(record);
                }
                else
                {
                    state.typingRun = false;
                }
                return replaceSelection(record,
                    address === 0 ? '' : host.readCString(address, MAX_TEXT), thread);
            }
            // The clipboard: a password is never copied out, and a read-only
            // edit gives nothing up and takes nothing in, though it copies.
            case WM_COPY:
                if ((record.style & ES_PASSWORD) === 0 && selectedText(record).length > 0)
                {
                    host.clipboard?.copy(selectedText(record));
                }
                return 0;
            case WM_CUT:
            case WM_CLEAR: {
                const selected = selectedText(record);
                if (readOnly() || selected.length === 0
                    || (message.message === WM_CUT && (record.style & ES_PASSWORD) !== 0))
                {
                    return 0;
                }
                if (message.message === WM_CUT)
                {
                    host.clipboard?.copy(selected);
                }
                rememberUndo(record);
                return after(replaceSelection(record, '', thread), ()=>0);
            }
            case WM_PASTE: {
                const pasted = readOnly() ? null : host.clipboard?.text() ?? null;
                if (pasted === null)
                {
                    return 0;
                }
                rememberUndo(record);
                // A single-line edit takes the first line and no more.
                const text = multiline(record) ? pasted : pasted.split(/[\r\n]/)[0];
                return after(replaceSelection(record, text, thread), ()=>0);
            }
            case WM_UNDO:
            case EM_UNDO:
                return undoEdit(record, thread);
            case EM_CANUNDO:
                return state.undo ? 1 : 0;
            case EM_EMPTYUNDOBUFFER:
                state.undo = null;
                state.typingRun = false;
                return 0;
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
                return Math.max(1, editLines(record).length);
            case EM_LINEINDEX: {
                const lines = editLines(record);
                const which = (message.wParam | 0) === -1
                    ? lineNumberOf(record, state.selEnd) : message.wParam | 0;
                return which >= 0 && which < lines.length ? lines[which].start : -1;
            }
            case EM_LINELENGTH: {
                const at = (message.wParam | 0) === -1 ? state.selEnd : message.wParam | 0;
                return lineEndOf(record, at) - lineStartOf(record, at);
            }
            case EM_GETLINE: {
                const lines = editLines(record);
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
                host.writeMemory(out, encodeAnsi(text));
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
            case EM_GETHANDLE: {
                // A single-line edit has no buffer to hand out. The block is
                // the process heap's, so LocalLock, LocalSize and LocalFree
                // know it.
                if (!multiline(record))
                {
                    return 0;
                }
                if (!state.handle)
                {
                    const bytes = encodeEditBuffer(record, record.title);
                    const at = host.allocate?.(bytes.length + EDIT_BUFFER_STEP) ?? 0;
                    if (at === 0)
                    {
                        return 0;
                    }
                    host.writeMemory(at, bytes);
                    state.handle = at;
                }
                return state.handle;
            }
            case EM_SETHANDLE: {
                // The program's buffer becomes the text; the one it replaces is
                // the program's to free (EM_GETHANDLE's documented contract),
                // and the edit frees the last one it holds when destroyed.
                if (!multiline(record) || (message.wParam >>> 0) === 0)
                {
                    return 0;
                }
                state.handle = message.wParam >>> 0;
                pullEditBuffer(record);
                state.selStart = state.selEnd = 0;
                state.firstLine = 0;
                state.modified = false;
                state.undo = null;
                host.invalidate(record);
                return 0;
            }
            case WM_NCDESTROY:
                if (state.handle && host.block?.(state.handle))
                {
                    host.release?.(state.handle);
                }
                state.handle = 0;
                return common(record, message, thread);
            case EM_GETRECT:
                if ((message.lParam >>> 0) !== 0)
                {
                    writeRect(message.lParam >>> 0, formatRect(record));
                }
                return 0;
            case EM_SETRECT:
            case EM_SETRECTNP: {
                // A rectangle no larger than the client area either way is
                // not taken (Windows 10 keeps the one it has); none at all
                // puts the default back. wParam 1 offsets the current one.
                if ((message.lParam >>> 0) === 0)
                {
                    state.setRect = null;
                }
                else
                {
                    const asked = readRect(wholeAddress(message.lParam));
                    const current = formatRect(record);
                    const margins = state.margins ?? { left: 0, right: 0 };
                    const rect = (message.wParam & 1) !== 0
                        ? { left: current.left - margins.left + asked.left,
                            top: current.top + asked.top,
                            right: current.right + margins.right + asked.right,
                            bottom: current.bottom + asked.bottom }
                        : asked;
                    const size = host.clientSize(record);
                    if (rect.right - rect.left > size.width && rect.bottom - rect.top > size.height)
                    {
                        state.setRect = rect;
                    }
                }
                if (message.message === EM_SETRECT)
                {
                    host.invalidate(record);
                }
                return 0;
            }
            case EM_SETMARGINS:
                setMargins(record, message.wParam, message.lParam & 0xffff,
                    message.lParam >>> 16 & 0xffff);
                host.invalidate(record);
                return 0;
            case EM_GETMARGINS: {
                const margins = state.margins ?? { left: 0, right: 0 };
                return ((margins.right & 0xffff) << 16 | margins.left & 0xffff) >>> 0;
            }
            case WM_SIZE:
                // Laid out again for a size it is restored or maximized to:
                // a rectangle EM_SETRECT gave goes. The size in lParam is not
                // read - the client area is asked.
                if (message.wParam === SIZE_RESTORED || message.wParam === SIZE_MAXIMIZED)
                {
                    state.setRect = null;
                }
                return common(record, message, thread);
            case WM_SETFONT:
                state.cell = null;
                return after(common(record, message, thread), answer=>{
                    setMargins(record, EC_LEFTMARGIN | EC_RIGHTMARGIN, EC_USEFONTINFO,
                        EC_USEFONTINFO);
                    return answer;
                });
            case EM_POSFROMCHAR:
            case EM_CHARFROMPOS:
                return -1;
            default:
                return common(record, message, thread);
        }
    };

    /** @param {any} record @param {number} at @returns {number} the line the character is on */
    const lineNumberOf = (record, at)=>{
        const lines = editLines(record);
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
        editLines(record)[lineNumberOf(record, at)].start;
    /** @param {any} record @param {number} at */
    const lineEndOf = (record, at)=>{
        const line = editLines(record)[lineNumberOf(record, at)];
        return line.start + line.text.length;
    };
    /** @param {any} record @param {number} at @param {number} by  Lines up or down. */
    const lineStepOf = (record, at, by)=>{
        const lines = editLines(record);
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
    const writeU32 = (address, value)=>host.writeMemory(wholeAddress(address), new Uint8Array([
        value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
    ]));

    /** @param {number} address @returns {Rect} */
    const readRect = address=>{
        const bytes = host.readMemory(wholeAddress(address), 16);
        const at = (/** @type {number} */ offset)=>(bytes[offset] | bytes[offset + 1] << 8
            | bytes[offset + 2] << 16 | bytes[offset + 3] << 24);
        return { left: at(0), top: at(4), right: at(8), bottom: at(12) };
    };
    /** @param {number} address @param {Rect} rect */
    const writeRect = (address, rect)=>{
        writeU32(address, rect.left);
        writeU32(address + 4, rect.top);
        writeU32(address + 8, rect.right);
        writeU32(address + 12, rect.bottom);
    };

    /**
     * How far inside its client area an edit lays its text out: a pixel for
     * WS_EX_CLIENTEDGE, a thin border and one for WS_BORDER, which Windows
     * draws inside the client area of an edit.
     *
     * @param {any} record
     */
    const editInset = record=>((record.exStyle & WS_EX_CLIENTEDGE) !== 0 ? 1
        : (record.style & WS_BORDER) !== 0 ? THIN_BORDER + 1 : 0);

    /**
     * The formatting rectangle EM_GETRECT reports and the text is laid out
     * in: the client area inside the edit's border and margins, or the
     * rectangle EM_SETRECT gave inside the margins. The border's inset is
     * kept vertically only where a line still fits between, as Windows
     * does; a single-line edit is one line high, cut by the client area,
     * and a multi-line one fills it (Windows 10's model, which Wine's test
     * measures against).
     *
     * @param {any} record @returns {Rect}
     */
    const formatRect = record=>{
        const state = editState(record);
        const margins = state.margins ?? { left: 0, right: 0 };
        if (state.setRect)
        {
            return { ...state.setRect, left: state.setRect.left + margins.left,
                right: state.setRect.right - margins.right };
        }
        const size = host.clientSize(record);
        const inset = editInset(record);
        const line = editCell(record).height;
        const down = size.height >= line + 2 * inset ? inset : 0;
        const top = down;
        const bottom = multiline(record) ? size.height - down
            : Math.min(top + line, size.height);
        return { left: inset + margins.left, top,
            right: size.width - inset - margins.right, bottom };
    };

    /**
     * The margins EC_USEFONTINFO asks for: half the font's average
     * character width a side, which the edit takes only when its client
     * area is at least that and two average characters wide - a narrower
     * edit keeps the margins it has, and an empty one is judged as
     * EMPTY_EDIT_WIDTH wide.
     *
     * @param {any} record @returns {{ left: number, right: number } | null}
     */
    const fontMargins = record=>{
        const draw = host.draw;
        if (!draw?.averageWidth)
        {
            return null;
        }
        const { hdc } = host.contextOn(record);
        const average = hdc !== 0 ? draw.averageWidth(hdc) : 0;
        host.endPaint(record, hdc);
        if (average <= 0)
        {
            return null;
        }
        const half = Math.floor(average / 2);
        const size = host.clientSize(record);
        const width = size.width <= 0 || size.height <= 0 ? EMPTY_EDIT_WIDTH : size.width;
        return width >= 2 * half + 2 * average ? { left: half, right: half } : null;
    };

    /**
     * EM_SETMARGINS' rule, which WM_SETFONT follows for both sides: a side
     * named takes its value, or the font's margin where the value is
     * EC_USEFONTINFO and the edit is wide enough for it.
     *
     * @param {any} record @param {number} sides @param {number} left @param {number} right
     */
    const setMargins = (record, sides, left, right)=>{
        const state = editState(record);
        const margins = { ...state.margins ?? { left: 0, right: 0 } };
        const font = left === EC_USEFONTINFO || right === EC_USEFONTINFO
            ? fontMargins(record) : null;
        if ((sides & EC_LEFTMARGIN) !== 0 && (left !== EC_USEFONTINFO || font))
        {
            margins.left = left === EC_USEFONTINFO ? /** @type {any} */ (font).left : left;
        }
        if ((sides & EC_RIGHTMARGIN) !== 0 && (right !== EC_USEFONTINFO || font))
        {
            margins.right = right === EC_USEFONTINFO ? /** @type {any} */ (font).right : right;
        }
        state.margins = margins;
    };

    /**
     * In the ANSI page, as the text was read.
     *
     * @param {number} address @param {string} text @returns {number} characters written
     */
    const writeString = (address, text)=>{
        host.writeMemory(wholeAddress(address), encodeAnsi(`${text}\0`));
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
     * @returns {{ items: ListItem[], current: number, caret: number, anchor: number,
     *     multi: boolean, top: number, itemHeight?: number,
     *     droppedHeight?: number, droppedWidth?: number, dropped?: number, hot?: number,
     *     fieldHeight?: number, fieldItem?: number, grab?: number, bars?: number }}
     */
    const listState = record=>{
        // A combo box's items are its list window's, as on Windows, where
        // the combo box hands its CB_ messages to that list box.
        const list = record.className === 'ComboBox'
            ? host.live(stateOf(record).listWindow ?? 0) : null;
        if (list)
        {
            return listState(list);
        }
        const state = stateOf(record);
        state.items ??= [];
        state.current ??= -1;
        // The item with the focus rectangle, and the end of a range a
        // shift-click or LB_SELITEMRANGE grows from: the first item, and
        // none, until something moves them.
        state.caret ??= 0;
        state.anchor ??= -1;
        // Whether it keeps a set of items selected: LBS_MULTIPLESEL or
        // LBS_EXTENDEDSEL, but not with LBS_NOSEL, which makes any list box
        // answer as a single-selection one; fixed when it is made, as a
        // later SetWindowLong of the style changes nothing (Wine's listbox
        // test, test_changing_selection_styles).
        // A combo box's style bits mean other things: its list is single.
        state.multi ??= String(record.className).toLowerCase() === 'listbox'
            && (record.style & (LBS_MULTIPLESEL | LBS_EXTENDEDSEL)) !== 0
            && (record.style & LBS_NOSEL) === 0;
        state.top ??= 0;
        return state;
    };

    /** Whether a list box keeps a set of items selected (`listState`). @param {any} record */
    const multiSelect = record=>listState(record).multi;

    /**
     * The current, caret and anchor indices after an item is put in at
     * `at` (`delta` 1) or taken out there (-1): each one past it follows its
     * item, and one on a removed item is gone.
     *
     * @param {ReturnType<typeof listState>} state @param {number} at @param {1 | -1} delta
     */
    const shiftIndices = (state, at, delta)=>{
        for (const key of /** @type {const} */ (['current', 'caret', 'anchor']))
        {
            if (delta < 0 && state[key] === at)
            {
                state[key] = key === 'caret' ? Math.max(0, Math.min(at, state.items.length - 1))
                    : -1;
            }
            else if (state[key] >= at && (delta > 0 || state[key] > at))
            {
                state[key] += delta;
            }
        }
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
        // The caret of an empty list stays on the first item.
        if (state.items.length > 1)
        {
            shiftIndices(state, index, 1);
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
     * Whether a list keeps strings: every list does but an owner-drawn one
     * made without LBS_HASSTRINGS (CBS_HASSTRINGS for a combo box), whose
     * items are the values handed to LB_ADDSTRING, which its owner draws.
     *
     * @param {any} record
     */
    const keepsStrings = record=>(record.className === 'ComboBox'
        ? (record.style & CBS_OWNERDRAW) === 0 || (record.style & CBS_HASSTRINGS) !== 0
        : (record.style & LBS_OWNERDRAW) === 0 || (record.style & LBS_HASSTRINGS) !== 0);

    /**
     * An item added to a list without strings: the value is its data, and
     * it goes at the end or where it was asked for -- the owner, not the
     * list, is what could compare two of them.
     *
     * @param {any} record @param {number} data @param {number} [at]
     */
    const addData = (record, data, at)=>{
        const index = addItem(record, false, '', at);
        listState(record).items[index].data = data >>> 0;
        return index;
    };

    /**
     * @param {any} record @param {number} index @param {number} data
     * @returns {number} the first item after `index` holding the value, wrapping, or -1
     */
    const findData = (record, index, data)=>{
        const items = listState(record).items;
        for (let step = 1; step <= items.length; step++)
        {
            const at = (index + step) % items.length;
            if (items[at].data === (data >>> 0))
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
        const strings = keepsStrings(record);
        const text = ()=>((message.lParam >>> 0) === 0
            ? '' : host.readCString(wholeAddress(message.lParam), MAX_TEXT));
        switch (message.message){
            case LB_ADDSTRING:
                return strings ? addItem(record, sorted, text()) : addData(record, message.lParam);
            case LB_DIR: {
                // The entries a directory holds, added as LB_ADDSTRING adds
                // them; the answer is the last one's index, or LB_ERR when
                // the search found nothing at all.
                const listed = host.files && strings
                    ? directoryItems(host.files, message.wParam, text())
                    : { found: false, items: [] };
                let last = listed.found ? 0 : LB_ERR;
                for (const item of listed.items)
                {
                    last = addItem(record, sorted, item);
                }
                return last;
            }
            case LB_INSERTSTRING: {
                const at = (message.wParam | 0) === -1 ? items.length : message.wParam | 0;
                return strings ? addItem(record, sorted, text(), at)
                    : addData(record, message.lParam, at);
            }
            case LB_DELETESTRING: {
                const at = message.wParam | 0;
                if (at < 0 || at >= items.length)
                {
                    return LB_ERR;
                }
                items.splice(at, 1);
                shiftIndices(state, at, -1);
                host.invalidate(record);
                return items.length;
            }
            case LB_RESETCONTENT:
                items.length = 0;
                state.current = -1;
                state.caret = 0;
                state.anchor = -1;
                state.top = 0;
                host.invalidate(record);
                return 0;
            case LB_GETCOUNT:
                return items.length;
            // A multiple-selection list box answers its caret: it has no one
            // current item.
            case LB_GETCURSEL:
                return multiSelect(record) ? state.caret : state.current;
            case LB_GETCARETINDEX:
                return state.caret;
            case LB_GETANCHORINDEX:
                return state.anchor;
            case LB_SETCARETINDEX:
            case LB_SETANCHORINDEX: {
                const at = message.wParam | 0;
                if (at < 0 || at >= items.length)
                {
                    return LB_ERR;
                }
                state[message.message === LB_SETCARETINDEX ? 'caret' : 'anchor'] = at;
                host.invalidate(record);
                return 0;
            }
            case LB_SETCURSEL:
            case LB_SELECTSTRING: {
                // LB_SELECTSTRING: the first item after wParam whose text
                // begins with the string, as LB_FINDSTRING finds it, selected.
                const at = message.message === LB_SETCURSEL ? message.wParam | 0
                    : strings ? findItem(record, message.wParam | 0, false, text())
                        : findData(record, message.wParam | 0, message.lParam);
                // LB_SETCURSEL is a single-selection list's alone.
                if (at < -1 || at >= items.length
                    || (at === -1 && message.message === LB_SELECTSTRING)
                    || (message.message === LB_SETCURSEL && state.multi))
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
                    state.caret = at;
                    state.anchor = at;
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
                if (!strings)
                {
                    writeU32(message.lParam, item.data);
                    return 4;
                }
                return writeString(message.lParam, item.text);
            }
            case LB_GETTEXTLEN: {
                const item = items[message.wParam | 0];
                return item ? (strings ? item.text.length : 4) : LB_ERR;
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
            case LB_FINDSTRINGEXACT:
                return strings
                    ? findItem(record, message.wParam | 0, message.message === LB_FINDSTRINGEXACT,
                        text())
                    : findData(record, message.wParam | 0, message.lParam);
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
        const state = listState(record);
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
     * @param {'click' | 'key'} [by]  A key moves a multiple-selection list's caret only.
     */
    const chooseItem = (record, index, code, always, thread, by = 'click')=>{
        const state = listState(record);
        if (index < 0 || index >= state.items.length)
        {
            return 0;
        }
        const multiple = multiSelect(record) && code === LBN_SELCHANGE;
        const extended = multiple && (record.style & LBS_EXTENDEDSEL) !== 0;
        if (multiple && !extended)
        {
            // LBS_MULTIPLESEL: a click toggles the item and anchors there; a
            // key only moves the caret.
            if (by === 'click')
            {
                state.items[index].selected = !state.items[index].selected;
                state.anchor = index;
            }
        }
        else
        {
            // One item selected: a single-selection list's, or an extended
            // one's without a modifier - the anchor moves with it.
            state.items.forEach(item=>{
                item.selected = false;
            });
            state.items[index].selected = true;
            state.anchor = index;
        }
        state.caret = index;
        state.current = index;
        host.invalidate(record);
        return always || (record.style & LBS_NOTIFY) !== 0 ? notify(record, code, thread) : 0;
    };

    /**
     * The rows a wheel's turn scrolls a list by: three a notch, up for a turn
     * away, and at least one for a turn smaller than a notch, which a
     * touchpad sends.
     *
     * @param {number} wParam
     */
    const wheelRows = wParam=>{
        const delta = (wParam >>> 16) << 16 >> 16;
        return -Math.sign(delta) * Math.max(1, Math.round(Math.abs(delta) * WHEEL_ITEMS / 120));
    };

    /** The rows a list box shows whole. @param {any} record */
    const listRows = record=>Math.max(1, Math.floor(host.clientSize(record).height
        / (listState(record).itemHeight ?? editCell(record).height)));

    /**
     * Scrolls a list box so its top item is `top`, as far as it goes.
     *
     * @param {any} record @param {number} top
     */
    const scrollList = (record, top)=>{
        const state = listState(record);
        const wanted = Math.max(0, Math.min(top, state.items.length - listRows(record)));
        if (wanted !== state.top)
        {
            state.top = wanted;
            host.invalidate(record);
        }
    };

    /**
     * A list box's own vertical bar, kept as the list box keeps it: shown
     * only while there are more items than rows -- or, with
     * LBS_DISABLENOSCROLL, always -- its range the items, its page the rows
     * and its position the top item.
     *
     * @param {any} record
     */
    const syncListBar = record=>{
        const state = listState(record);
        // The bar it was made with, which it then shows and hides.
        state.bars ??= record.style & WS_VSCROLL;
        if ((state.bars & WS_VSCROLL) === 0 || (record.style & LBS_MULTICOLUMN) !== 0
            || record.destroyed)
        {
            return;
        }
        const rows = listRows(record);
        const needed = state.items.length > rows || (record.style & LBS_DISABLENOSCROLL) !== 0;
        const style = ((record.style & ~WS_VSCROLL) | (needed ? WS_VSCROLL : 0)) >>> 0;
        const held = scrollOf(record, SB_VERT_BAR);
        const next = { min: 0, max: Math.max(0, state.items.length - 1), page: rows,
            pos: state.top };
        if (style === record.style && held.min === next.min && held.max === next.max
            && held.page === next.page && held.pos === next.pos)
        {
            return;
        }
        record.style = style;
        Object.assign(held, next, { trackPos: next.pos });
        host.frameChanged?.(record);
    };

    /**
     * @param {any} record @param {ControlMessage} message @param {unknown} [thread]
     */
    const listBoxProc = (record, message, thread)=>after(listBoxMessage(record, message, thread),
        answer=>{
            syncListBar(record);
            return answer;
        });

    /**
     * @param {any} record @param {ControlMessage} message @param {unknown} [thread]
     */
    const listBoxMessage = (record, message, thread)=>{
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
                const rows = listRows(record);
                const step = key === VK_UP ? -1 : key === VK_DOWN ? 1
                    : key === VK_PRIOR ? -rows : key === VK_NEXT ? rows
                        : key === VK_HOME ? -state.items.length
                            : key === VK_END ? state.items.length : 0;
                if (step === 0)
                {
                    return 0;
                }
                const from = multiSelect(record) ? state.caret : state.current;
                const index = Math.max(0, Math.min(state.items.length - 1,
                    from < 0 ? 0 : from + step));
                // The item chosen is scrolled into the rows that show.
                scrollList(record, index < state.top ? index
                    : index >= state.top + rows ? index - rows + 1 : state.top);
                return chooseItem(record, index, LBN_SELCHANGE, false, thread, 'key');
            }
            case WM_VSCROLL: {
                const code = message.wParam & 0xffff;
                const rows = listRows(record);
                scrollList(record, code === SB_LINEUP ? state.top - 1
                    : code === SB_LINEDOWN ? state.top + 1
                        : code === SB_PAGEUP ? state.top - rows
                            : code === SB_PAGEDOWN ? state.top + rows
                                : code === SB_TOP ? 0 : code === SB_BOTTOM ? state.items.length
                                    : code === SB_THUMBPOSITION || code === SB_THUMBTRACK
                                        ? message.wParam >>> 16 : state.top);
                return 0;
            }
            case WM_MOUSEWHEEL:
                scrollList(record, state.top + wheelRows(message.wParam));
                return 0;
            case LB_GETSEL: {
                const item = state.items[message.wParam | 0];
                return item ? (item.selected ? 1 : 0) : LB_ERR;
            }
            case LB_SELITEMRANGE:
            case LB_SELITEMRANGEEX: {
                // A range of a multiple-selection list box; a single one has none.
                if (!multiSelect(record))
                {
                    return LB_ERR;
                }
                const ex = message.message === LB_SELITEMRANGEEX;
                const first = ex ? message.wParam | 0 : message.lParam & 0xffff;
                const last = ex ? message.lParam | 0 : message.lParam >>> 16;
                // LB_SELITEMRANGEEX with the last before the first deselects.
                const on = ex ? first <= last : message.wParam !== 0;
                const low = Math.max(0, Math.min(first, last));
                const high = Math.min(state.items.length - 1, Math.max(first, last));
                for (let at = low; at <= high; at++)
                {
                    state.items[at].selected = on;
                }
                host.invalidate(record);
                return 0;
            }
            case LB_SETSEL: {
                if (!multiSelect(record))
                {
                    return LB_ERR;
                }
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
                    // The item set, either way, is where the caret and the
                    // anchor go.
                    state.anchor = at;
                    state.caret = at;
                }
                else
                {
                    return LB_ERR;
                }
                host.invalidate(record);
                return 0;
            }
            case LB_GETSELCOUNT:
                return !multiSelect(record)
                    ? LB_ERR : state.items.filter(item=>item.selected).length;
            case LB_GETSELITEMS: {
                if (!multiSelect(record))
                {
                    return LB_ERR;
                }
                const chosen = state.items.map((item, index)=>(item.selected ? index : -1))
                    .filter(index=>index >= 0).slice(0, message.wParam | 0);
                chosen.forEach((index, slot)=>writeU32(wholeAddress(message.lParam) + slot * 4,
                    index));
                return chosen.length;
            }
            case LB_GETITEMHEIGHT:
                return state.itemHeight ?? editCell(record).height;
            case LB_GETLISTBOXINFO: {
                // How many items a column holds: the rows of the client area,
                // at least one.
                const row = Math.max(1, state.itemHeight ?? editCell(record).height);
                return Math.max(1, Math.floor(host.clientSize(record).height / row));
            }
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
                    writeU32(wholeAddress(message.lParam) + slot * 4, value));
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
     * A combo box's parts, in its client area: the field at the top - all
     * of a drop-down one, as tall as a drop-down one's in a simple one - its
     * item inside the field's edge, where the edit or the selection is, the
     * drop button at the field's right, none in a simple one, and under the
     * field a simple one's list.
     *
     * @param {any} combo
     */
    const comboParts = combo=>{
        const size = host.clientSize(combo);
        const simple = (combo.style & CBS_TYPEMASK) === CBS_SIMPLE;
        const bottom = simple ? Math.min(size.height, listState(combo).fieldHeight ?? 21)
            : size.height;
        const button = simple ? { left: 0, top: 0, right: 0, bottom: 0 }
            : { left: size.width - 2 - COMBO_BUTTON, top: 2, right: size.width - 2,
                bottom: bottom - 2 };
        return { field: { left: 0, top: 0, right: size.width, bottom },
            item: { left: 3, top: 3, right: (simple ? size.width : button.left) - 2,
                bottom: bottom - 3 },
            button,
            list: { left: 0, top: bottom, right: size.width, bottom: size.height } };
    };

    /** A combo box's list window, live, or null. @param {any} combo */
    const listOf = combo=>host.live(stateOf(combo).listWindow ?? 0);

    /** An editable combo box's edit, live, or null. @param {any} combo */
    const editOf = combo=>host.live(stateOf(combo).editWindow ?? 0);

    /**
     * What GetComboBoxInfo says of a combo box: its item and its button, in
     * its client area, and its edit, zero for a drop-down list, and its list.
     *
     * @param {any} combo
     */
    const comboInfo = combo=>{
        const { item, button } = comboParts(combo);
        return { item, button, edit: editOf(combo)?.hwnd ?? 0, list: listOf(combo)?.hwnd ?? 0 };
    };

    /**
     * Puts a combo box's edit in its item and a simple one's list under its
     * field, in the rest of its client area.
     *
     * @param {any} combo
     */
    const placeComboChildren = combo=>{
        const parts = comboParts(combo);
        /** @param {any} child @param {Rect} rect */
        const place = (child, rect)=>(child && host.move
            ? host.move(child.hwnd, rect.left, rect.top, Math.max(0, rect.right - rect.left),
                Math.max(0, rect.bottom - rect.top))
            : 0);
        return after(place(editOf(combo), parts.item),
            ()=>((combo.style & CBS_TYPEMASK) === CBS_SIMPLE ? place(listOf(combo), parts.list)
                : 0));
    };

    /**
     * Makes an editable combo box's edit, a child in its field (id 1001)
     * with the edit styles the combo box's ask for. Its text is the combo
     * box's; it tells the combo box what happens to it, and hands it the
     * keys that walk or drop the list.
     *
     * @param {any} combo @param {unknown} [thread]
     */
    const makeComboEdit = (combo, thread)=>{
        if (!comboEditable(combo) || !host.popup)
        {
            return 0;
        }
        const style = (WS_CHILD | WS_VISIBLE | ES_NOHIDESEL
            | ((combo.style & CBS_AUTOHSCROLL) !== 0 ? ES_AUTOHSCROLL : 0)
            | ((combo.style & CBS_UPPERCASE) !== 0 ? ES_UPPERCASE : 0)
            | ((combo.style & CBS_LOWERCASE) !== 0 ? ES_LOWERCASE : 0)
            | ((combo.style & CBS_OEMCONVERT) !== 0 ? ES_OEMCONVERT : 0)
            | (combo.style & WS_DISABLED)) >>> 0;
        return after(host.popup('Edit', { x: 0, y: 0, width: 0, height: 0 }, combo.hwnd, 0, style,
            thread, COMBO_EDIT_ID), hwnd=>{
            const edit = hwnd !== 0 ? host.live(hwnd) : null;
            if (edit)
            {
                edit.font = combo.font;
                stateOf(combo).editWindow = hwnd;
            }
            return 0;
        });
    };

    /**
     * The combo box an edit is the field of, or null.
     *
     * @param {any} record
     */
    const comboOfEdit = record=>{
        const parent = record.parent ? host.live(record.parent) : null;
        return parent && parent.className === 'ComboBox'
            && stateOf(parent).editWindow === record.hwnd ? parent : null;
    };

    /** Whether an edit is a combo box's whose list is dropped. @param {any} record */
    const comboDropped = record=>{
        const combo = comboOfEdit(record);
        return combo !== null && (listState(combo).dropped ?? 0) !== 0;
    };

    /**
     * Shows an item in a combo box's field: its text in the edit, all of it
     * selected, or the field of a drop-down list. The edit is handed the
     * text as a program would hand it, and what it says of it the combo
     * box does not pass on: nobody typed.
     *
     * @param {any} combo @param {number} index @param {unknown} [thread]
     */
    const showItem = (combo, index, thread)=>{
        const text = listState(combo).items[index]?.text ?? '';
        const edit = editOf(combo);
        host.invalidate(combo);
        if (!edit)
        {
            combo.title = text;
            return 0;
        }
        const bytes = encodeAnsi(`${text}\0`);
        const at = host.allocate?.(bytes.length) ?? 0;
        if (at === 0)
        {
            host.divergence?.('ComboBox', 'no memory to hand its edit the item\'s text');
            return 0;
        }
        host.writeMemory(at, bytes);
        const state = stateOf(combo);
        state.quiet = true;
        return after(host.send(edit.hwnd, WM_SETTEXT, 0, at, thread), ()=>{
            state.quiet = false;
            host.release?.(at);
            return host.focus() === edit.hwnd ? host.send(edit.hwnd, EM_SETSEL, 0, -1, thread) : 0;
        });
    };

    /**
     * What a combo box makes of its edit's notifications: the focus coming
     * or going is the combo box's, its text selected whole as it comes and
     * the list closed as it goes, and an edit typed in is CBN_EDITUPDATE
     * then CBN_EDITCHANGE - but not a text the combo box put there itself.
     *
     * @param {any} combo @param {any} edit @param {number} code @param {unknown} [thread]
     */
    const editNotice = (combo, edit, code, thread)=>{
        switch (code){
            case EN_SETFOCUS:
                // Its text selected whole as the focus comes, and none of it
                // as it goes, the caret at the start (combo.c
                // test_editselection_focus: EM_SETSEL 0, INT_MAX and 0, 0).
                host.invalidate(combo);
                return after(host.send(edit.hwnd, EM_SETSEL, 0, 0x7fffffff, thread),
                    ()=>notify(combo, CBN_SETFOCUS, thread));
            case EN_KILLFOCUS:
                host.invalidate(combo);
                return after(closeList(combo, false, thread),
                    ()=>after(host.send(edit.hwnd, EM_SETSEL, 0, 0, thread),
                        ()=>notify(combo, CBN_KILLFOCUS, thread)));
            case EN_UPDATE:
                return stateOf(combo).quiet ? 0 : notify(combo, CBN_EDITUPDATE, thread);
            case EN_CHANGE:
                if (stateOf(combo).quiet)
                {
                    return 0;
                }
                if ((combo.style & CBS_TYPEMASK) === CBS_SIMPLE)
                {
                    followField(combo);
                }
                return notify(combo, CBN_EDITCHANGE, thread);
            default:
                return 0;
        }
    };

    /**
     * Makes a combo box's list window, which lives as long as the combo box:
     * a simple combo box's is a child under its field, shown, in a sunken
     * edge; a drop-down one's a child of the desktop with a border, hidden
     * until it drops, and put over every window then. Its style says what
     * the combo box's says of its items, LBS_COMBOBOX that it answers to the
     * combo box, and LBS_NOTIFY (combo.c test_listbox_styles, which reads
     * what Windows makes). The combo box's items are kept in it.
     *
     * @param {any} combo @param {unknown} [thread]
     */
    const makeComboList = (combo, thread)=>{
        if (!host.popup)
        {
            return 0;
        }
        const simple = (combo.style & CBS_TYPEMASK) === CBS_SIMPLE;
        const strings = (combo.style & CBS_HASSTRINGS) !== 0 || (combo.style & CBS_OWNERDRAW) === 0;
        const style = (WS_CHILD | WS_CLIPSIBLINGS | LBS_COMBOBOX | LBS_NOTIFY
            | ((combo.style & CBS_NOINTEGRALHEIGHT) !== 0 ? LBS_NOINTEGRALHEIGHT : 0)
            | ((combo.style & CBS_SORT) !== 0 ? LBS_SORT : 0)
            | (combo.style & CBS_OWNERDRAW)
            | (strings ? LBS_HASSTRINGS : 0)
            | (simple ? WS_VISIBLE : WS_BORDER)) >>> 0;
        const rect = { x: 0, y: 0, width: combo.width, height: 0 };
        return after(host.popup('ComboLBox', rect, simple ? combo.hwnd : 0,
            simple ? WS_EX_CLIENTEDGE : WS_EX_TOOLWINDOW, style, thread,
            simple ? COMBO_LIST_ID : 0), hwnd=>{
            const list = hwnd !== 0 ? host.live(hwnd) : null;
            if (list)
            {
                stateOf(list).combo = combo.hwnd;
                list.font = combo.font;
                stateOf(combo).listWindow = hwnd;
            }
            return 0;
        });
    };

    /**
     * The combo box's field: a sunken white box with, but for a simple combo
     * box, a drop button at the right. A drop-down list shows the current
     * item's text there, selected while it has the focus; an editable combo
     * box's edit and a simple one's list are windows of their own.
     *
     * @param {any} record @param {number} hdc
     */
    const paintCombo = (record, hdc)=>{
        const draw = /** @type {Drawing} */ (host.draw);
        const state = listState(record);
        const simple = (record.style & CBS_TYPEMASK) === CBS_SIMPLE;
        const { field: box, button } = comboParts(record);
        draw.fill(hdc, box, color(disabled(record) ? COLOR_3DFACE : COLOR_WINDOW));
        sunkenEdge(hdc, box);
        if (!simple)
        {
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
        }
        if (comboEditable(record))
        {
            return;
        }
        const text = state.items[state.current]?.text ?? '';
        const field = { left: box.left + 3, top: box.top + 2, right: button.left - 1,
            bottom: box.bottom - 2 };
        const selected = host.focus() === record.hwnd;
        if (selected)
        {
            draw.fill(hdc, field, color(COLOR_HIGHLIGHT));
        }
        const metrics = draw.measure(hdc, text);
        const top = field.top + Math.max(0,
            Math.floor((field.bottom - field.top - metrics.height) / 2));
        draw.text(hdc, field.left + 1, top, text, { color: color(selected ? COLOR_HIGHLIGHTTEXT
            : disabled(record) ? COLOR_GRAYTEXT : COLOR_WINDOWTEXT), clip: field });
    };

    /** A combo box message as the list box spells it, or null. @param {number} message */
    const comboAsList = message=>{
        switch (message){
            case CB_ADDSTRING: return LB_ADDSTRING;
            case CB_DIR: return LB_DIR;
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
            case CB_SELECTSTRING: return LB_SELECTSTRING;
            default: return null;
        }
    };

    /**
     * Whether a combo box has an editing field: every kind but the dropdown
     * list, whose field shows the selection and takes no text of its own.
     *
     * @param {any} record
     */
    const comboEditable = record=>(record.style & CBS_TYPEMASK) === CBS_DROPDOWN
        || (record.style & CBS_TYPEMASK) === CBS_SIMPLE;

    /**
     * A dropdown combo box is as tall as its field shows: its text and the
     * margin and edge round it. The height it was made with is the dropped
     * list's, and the scroll bars it was given are the list's too -- Windows
     * takes both off the window as the combo box is made, and fits the field
     * again to every font it is given.
     *
     * The field's item is its text's height and two rows more, or what
     * CB_SETITEMHEIGHT(-1) made it; the field is six rows taller.
     *
     * @param {any} record @param {boolean} creating
     */
    const fitComboField = (record, creating)=>{
        if (creating)
        {
            record.style = (record.style & ~(WS_VSCROLL | WS_HSCROLL)) >>> 0;
            listState(record).droppedHeight = record.height;
        }
        const rows = fontRows(record);
        // A simple combo box keeps its height: its list is under the field.
        if ((record.style & CBS_TYPEMASK) === CBS_SIMPLE)
        {
            listState(record).fieldHeight = (listState(record).fieldItem ?? rows + 2) + 6;
            host.invalidate(record);
            return placeComboChildren(record);
        }
        record.height = (listState(record).fieldItem ?? rows + 2) + 6;
        return placeComboChildren(record);
    };

    /**
     * How tall a window's font is: the system font's thirteen rows where
     * nothing can be measured.
     *
     * @param {any} record
     */
    const fontRows = record=>{
        if (!host.draw)
        {
            return 13;
        }
        const { hdc } = host.contextOn(record);
        const rows = (hdc !== 0 ? host.draw.measure(hdc, 'M')?.height : null) ?? 13;
        host.endPaint(record, hdc);
        return rows;
    };

    /**
     * Asks an owner-draw combo box's parent how tall an item is:
     * WM_MEASUREITEM with a MEASUREITEMSTRUCT that starts at the height the
     * combo box would give it, item -1 the field's. A build with no heap has
     * nowhere to put the structure, and that height stands.
     *
     * @param {any} combo @param {number} item @param {number} rows
     * @param {unknown} [thread]
     * @returns {number | Promise<number>}
     */
    const measureItem = (combo, item, rows, thread)=>{
        const size = (host.pointerSize ?? 4) === 8 ? 32 : 24;
        const at = combo.parent && host.allocate ? host.allocate(size) : 0;
        if (at === 0)
        {
            return rows;
        }
        const bytes = new Uint8Array(size);
        const view = new DataView(bytes.buffer);
        [ODT_COMBOBOX, combo.id, item, 0, rows].forEach((value, index)=>
            view.setUint32(index * 4, value >>> 0, true));
        host.writeMemory(at, bytes);
        return after(host.send(combo.parent, WM_MEASUREITEM, combo.id, at, thread), ()=>{
            const height = readU32(at + 16);
            host.release?.(at);
            return height;
        });
    };

    /**
     * An owner-draw combo box's heights, which its parent decides: its
     * field's, kept whatever font it is later given, and a fixed one's
     * list rows.
     *
     * @param {any} combo @param {unknown} [thread]
     */
    const measureCombo = (combo, thread)=>{
        if ((combo.style & CBS_OWNERDRAW) === 0)
        {
            return 0;
        }
        // The field is two rows taller than its text, a list row as tall.
        const rows = fontRows(combo);
        return after(measureItem(combo, -1, rows + 2, thread), field=>{
            listState(combo).fieldItem = field;
            return (combo.style & CBS_OWNERDRAW) === CBS_OWNERDRAWFIXED
                ? after(measureItem(combo, 0, rows, thread), row=>{
                    listState(combo).itemHeight = row;
                    return 0;
                }) : 0;
        });
    };

    /**
     * The rows a combo box's dropped list shows, and how tall each is: the
     * height the combo box was made with is its field and its list together,
     * and a list too short for one row shows none, its client area empty
     * (combo.c test_listbox_size).
     *
     * @param {any} combo
     */
    const droppedRows = combo=>{
        const state = listState(combo);
        const { hdc } = host.contextOn(combo);
        const row = hdc !== 0 ? itemHeight(combo, hdc) : 16;
        host.endPaint(combo, hdc);
        const fit = Math.floor(((state.droppedHeight ?? 0) - host.clientSize(combo).height - 2)
            / row);
        return { row, rows: Math.max(0, Math.min(Math.max(state.items.length, 1), fit)) };
    };

    /**
     * Drops a combo box's list: its list window, moved under the field and
     * shown over every window, which takes the mouse until it closes and
     * never the activation -- the dialog keeps it, and the combo box the
     * focus and the keys. CBN_DROPDOWN goes first, so a parent that fills
     * the list late fills it in time.
     *
     * @param {any} combo @param {unknown} [thread]
     */
    const dropList = (combo, thread)=>{
        const state = listState(combo);
        const list = listOf(combo);
        if ((state.dropped ?? 0) !== 0 || (combo.style & CBS_TYPEMASK) === CBS_SIMPLE
            || !list || !host.place || !host.clientOrigin || disabled(combo))
        {
            return 0;
        }
        return after(notify(combo, CBN_DROPDOWN, thread), ()=>{
            const { row, rows } = droppedRows(combo);
            const origin = /** @type {any} */ (host.clientOrigin)(combo);
            const size = host.clientSize(combo);
            state.hot = state.current;
            state.top = Math.max(0, Math.min(state.current, state.items.length - rows));
            state.dropped = list.hwnd;
            host.invalidate(combo);
            // Over every window, WS_EX_TOPMOST from then on (combo.c
            // test_listbox_styles), shown without taking the activation.
            return after(/** @type {any} */ (host.place)(list.hwnd, HWND_TOPMOST, origin.x,
                origin.y + size.height, Math.max(size.width, state.droppedWidth ?? 0),
                rows * row + 2, SWP_NOACTIVATE | SWP_SHOWWINDOW, thread), ()=>{
                host.setCapture(list.hwnd);
                return 0;
            });
        });
    };

    /**
     * Closes a combo box's dropped list, taking the item under the pointer
     * or the keys when `accept`: CBN_SELCHANGE for a new one, then
     * CBN_SELENDOK or CBN_SELENDCANCEL, then CBN_CLOSEUP (Wine's combo.c
     * CBRollUp).
     *
     * @param {any} combo @param {boolean} accept @param {unknown} [thread]
     */
    const closeList = (combo, accept, thread)=>{
        const state = listState(combo);
        const hwnd = state.dropped ?? 0;
        if (hwnd === 0)
        {
            return 0;
        }
        state.dropped = 0;
        if (host.capture() === hwnd)
        {
            host.releaseCapture();
        }
        const hot = state.hot ?? -1;
        return after(host.show?.(hwnd, SW_HIDE) ?? 0, ()=>{
            host.invalidate(combo);
            const changed = accept && hot >= 0 && hot < state.items.length && hot !== state.current;
            const chosen = changed ? after(showItem(combo, hot, thread),
                ()=>chooseItem(combo, hot, CBN_SELCHANGE, true, thread)) : 0;
            return after(chosen, ()=>after(notify(combo, accept ? CBN_SELENDOK : CBN_SELENDCANCEL,
                thread), ()=>notify(combo, CBN_CLOSEUP, thread)));
        });
    };

    /**
     * The dropped list's rows from its top one, the one under the pointer
     * or the keys highlighted -- a simple combo box's, the one chosen -- and
     * a scroll bar at the side when they do not all fit.
     *
     * @param {any} combo @param {number} hdc @param {Rect} rect
     * @param {number} [highlight]
     */
    const paintDropped = (combo, hdc, rect, highlight = listState(combo).hot)=>{
        const draw = /** @type {Drawing} */ (host.draw);
        const state = listState(combo);
        const row = itemHeight(combo, hdc);
        const visible = Math.max(1, Math.floor((rect.bottom - rect.top) / row));
        const bar = state.items.length > visible
            ? { left: rect.right - ARROW_LENGTH, top: rect.top, right: rect.right,
                bottom: rect.bottom }
            : null;
        const rows = bar ? { ...rect, right: bar.left } : rect;
        draw.fill(hdc, rows, color(COLOR_WINDOW));
        for (let index = state.top; index < state.items.length; index++)
        {
            const y = rows.top + (index - state.top) * row;
            if (y >= rows.bottom)
            {
                break;
            }
            const line = { left: rows.left, top: y, right: rows.right, bottom: y + row };
            const hot = index === highlight;
            if (hot)
            {
                draw.fill(hdc, line, color(COLOR_HIGHLIGHT));
            }
            draw.text(hdc, rows.left + 2, y, state.items[index].text,
                { color: color(hot ? COLOR_HIGHLIGHTTEXT : COLOR_WINDOWTEXT), clip: line });
        }
        if (bar)
        {
            paintScrollBar(hdc, bar, true, { min: 0, max: state.items.length - 1, page: visible,
                pos: state.top });
        }
    };

    /**
     * Scrolls a dropped list so its top item is `top`, as far as it goes.
     *
     * @param {any} combo @param {number} top @param {number} visible
     */
    const scrollDropped = (combo, top, visible)=>{
        const state = listState(combo);
        state.top = Math.max(0, Math.min(top, state.items.length - visible));
        host.invalidate(listOf(combo) ?? combo);
    };

    /**
     * The rows a simple combo box's list shows, how tall each is, and where
     * they are in its list window: all of its client area, inside the frame.
     *
     * @param {any} combo
     */
    const simpleRows = combo=>{
        const list = listOf(combo);
        if (!list)
        {
            return { row: 16, visible: 1, rows: { left: 0, top: 0, right: 0, bottom: 0 } };
        }
        const { hdc } = host.contextOn(list);
        const row = hdc !== 0 ? itemHeight(combo, hdc) : 16;
        host.endPaint(list, hdc);
        const size = host.clientSize(list);
        const rows = { left: 0, top: 0, right: size.width, bottom: size.height };
        return { row, visible: Math.max(1, Math.floor((rows.bottom - rows.top) / row)), rows };
    };

    /**
     * A simple combo box's list following its field as it is typed in: the
     * first item the text begins chosen and scrolled to the top, or none
     * (Wine's combo.c CBUpdateLBox). Nothing is said: the person chose no
     * item.
     *
     * @param {any} combo
     */
    const followField = combo=>{
        const state = listState(combo);
        const text = String((editOf(combo) ?? combo).title).toLowerCase();
        const index = text === '' ? -1
            : state.items.findIndex(item=>item.text.toLowerCase().startsWith(text));
        state.current = index;
        if (index >= 0)
        {
            scrollDropped(combo, index, simpleRows(combo).visible);
        }
        host.invalidate(combo);
    };

    /**
     * A press, a move with the thumb held, or a release in a simple combo
     * box's list: a row is chosen as the field's text and CBN_SELCHANGE
     * said, a double-click on one says CBN_DBLCLK, and the list's scroll bar
     * scrolls it -- by its arrows, its track, and its thumb dragged. The
     * point is in the list window.
     *
     * @param {any} combo @param {any} list @param {ControlMessage} message
     * @param {unknown} [thread]
     */
    const simpleListMouse = (combo, list, message, thread)=>{
        const state = listState(combo);
        const point = pointOf(message.lParam);
        const { row, visible, rows } = simpleRows(combo);
        const bar = { left: rows.right - ARROW_LENGTH, top: rows.top, right: rows.right,
            bottom: rows.bottom };
        const held = { min: 0, max: Math.max(0, state.items.length - 1), page: visible,
            pos: state.top };
        if (state.grab !== undefined)
        {
            scrollDropped(combo, thumbValue(bar, true, held, point.y - bar.top - state.grab),
                visible);
            if (message.message === WM_LBUTTONUP)
            {
                state.grab = undefined;
                host.releaseCapture();
            }
            return 0;
        }
        if (message.message !== WM_LBUTTONDOWN && message.message !== WM_LBUTTONDBLCLK
            || !contains(rows, point.x, point.y))
        {
            return 0;
        }
        if (state.items.length > visible && point.x >= bar.left)
        {
            const hit = scrollHit(bar, true, held, point.x, point.y);
            if (hit === SB_THUMBTRACK)
            {
                state.grab = point.y - bar.top - (thumbOf(bar, true, held).thumb?.start ?? 0);
                host.setCapture(list.hwnd);
                return 0;
            }
            scrollDropped(combo, state.top + (hit === SB_LINEUP ? -1 : hit === SB_LINEDOWN ? 1
                : hit === SB_PAGEUP ? -visible : hit === SB_PAGEDOWN ? visible : 0), visible);
            return 0;
        }
        const index = state.top + Math.floor((point.y - rows.top) / row);
        if (index >= state.items.length)
        {
            return 0;
        }
        if (message.message === WM_LBUTTONDBLCLK)
        {
            return notify(combo, CBN_DBLCLK, thread);
        }
        if (index === state.current)
        {
            return 0;
        }
        return after(showItem(combo, index, thread),
            ()=>chooseItem(combo, index, CBN_SELCHANGE, true, thread));
    };

    /**
     * The ComboLBox: a combo box's list window, a list box that holds its
     * items and answers the LB_ messages. A drop-down one holds the mouse
     * while it is open: the pointer over a row lights it, a press outside
     * closes it with nothing chosen, and a release on a row chooses that
     * row -- the press that dropped it may be held into the list and let go
     * there. A simple combo box's is always shown under its field.
     *
     * @param {any} record @param {ControlMessage} message @param {unknown} [thread]
     */
    const comboListProc = (record, message, thread)=>{
        const own = stateOf(record);
        const combo = host.live(own.combo ?? 0);
        if (message.message >= LB_ADDSTRING && message.message <= LB_LAST)
        {
            return after(listBoxMessage(record, message, thread), answer=>{
                if (combo)
                {
                    host.invalidate(combo);
                }
                return answer;
            });
        }
        if (!combo)
        {
            return common(record, message, thread);
        }
        const state = listState(combo);
        if ((combo.style & CBS_TYPEMASK) === CBS_SIMPLE)
        {
            switch (message.message){
                case WM_PAINT:
                    // Its sunken edge is its frame (WS_EX_CLIENTEDGE).
                    return painting(record, (hdc, rect)=>{
                        paintDropped(combo, hdc, rect, state.current);
                    });
                case WM_ERASEBKGND:
                    return 1;
                case WM_LBUTTONDOWN:
                case WM_LBUTTONDBLCLK:
                    return after(host.setFocus(combo.hwnd, thread),
                        ()=>simpleListMouse(combo, record, message, thread));
                case WM_MOUSEMOVE:
                case WM_LBUTTONUP:
                    return simpleListMouse(combo, record, message, thread);
                case WM_MOUSEWHEEL:
                    return host.send(combo.hwnd, message.message, message.wParam,
                        message.lParam, thread);
                default:
                    return common(record, message, thread);
            }
        }
        switch (message.message){
            case WM_MOUSEACTIVATE:
                return MA_NOACTIVATE;
            case WM_PAINT:
                return painting(record, (hdc, rect)=>{
                    paintDropped(combo, hdc, rect);
                });
            case WM_ERASEBKGND:
                return 1;
            case WM_MOUSEMOVE:
            case WM_LBUTTONDOWN:
            case WM_LBUTTONUP: {
                const point = pointOf(message.lParam);
                const size = host.clientSize(record);
                const { hdc } = host.contextOn(record);
                const row = hdc !== 0 ? itemHeight(combo, hdc) : 16;
                host.endPaint(record, hdc);
                const visible = Math.max(1, Math.floor(size.height / row));
                const bar = state.items.length > visible
                    ? { left: size.width - ARROW_LENGTH, top: 0, right: size.width,
                        bottom: size.height }
                    : null;
                const inside = point.x >= 0 && point.y >= 0 && point.x < size.width
                    && point.y < size.height;
                const onBar = bar !== null && inside && point.x >= bar.left;
                if (own.dragging)
                {
                    if (message.message === WM_LBUTTONUP)
                    {
                        own.dragging = false;
                        return 0;
                    }
                    const track = Math.max(1, size.height - 2 * ARROW_LENGTH);
                    scrollDropped(combo, Math.round((point.y - ARROW_LENGTH) / track
                        * (state.items.length - visible)), visible);
                    return 0;
                }
                if (message.message === WM_LBUTTONDOWN)
                {
                    if (!inside)
                    {
                        return closeList(combo, false, thread);
                    }
                    if (onBar && bar)
                    {
                        const hit = scrollHit(bar, true, { min: 0, max: state.items.length - 1,
                            page: visible, pos: state.top }, point.x, point.y);
                        const step = hit === SB_LINEUP ? -1 : hit === SB_LINEDOWN ? 1
                            : hit === SB_PAGEUP ? -visible : hit === SB_PAGEDOWN ? visible : 0;
                        if (step === 0)
                        {
                            own.dragging = true;
                        }
                        scrollDropped(combo, state.top + step, visible);
                        return 0;
                    }
                }
                if (!inside || onBar)
                {
                    return 0;
                }
                const index = state.top + Math.floor(point.y / row);
                if (index >= state.items.length)
                {
                    return 0;
                }
                if (index !== state.hot)
                {
                    state.hot = index;
                    host.invalidate(record);
                }
                return message.message === WM_LBUTTONUP ? closeList(combo, true, thread) : 0;
            }
            case WM_CAPTURECHANGED:
                return state.dropped === record.hwnd ? closeList(combo, false, thread) : 0;
            default:
                return common(record, message, thread);
        }
    };

    /**
     * @param {any} record @param {ControlMessage} message @param {unknown} [thread]
     */
    const comboBoxProc = (record, message, thread)=>{
        const state = listState(record);
        const sorted = (record.style & CBS_SORT) !== 0;
        const simple = (record.style & CBS_TYPEMASK) === CBS_SIMPLE;
        const edit = editOf(record);
        const asList = comboAsList(message.message);
        if (asList !== null)
        {
            const answer = listMessage(record, sorted, { ...message, message: asList });
            if (simple)
            {
                host.invalidate(listOf(record) ?? record);
            }
            // A selection set by the program shows in the field - none, an
            // empty one (CB_SETCURSEL -1) - and the field empties with the list.
            const showsItem = asList === LB_RESETCONTENT
                || (asList === LB_SETCURSEL && state.current === (message.wParam | 0))
                || (asList === LB_SELECTSTRING && answer !== LB_ERR);
            return after(showsItem ? showItem(record, state.current, thread) : 0,
                ()=>answer ?? CB_ERR);
        }
        if (message.message === WM_CTLCOLOR
            || message.message >= WM_CTLCOLORMSGBOX && message.message <= WM_CTLCOLORSTATIC)
        {
            // Its edit and its list ask the combo box for their colours; the
            // combo box asks its own parent, as Windows' does. One with no
            // parent answers as DefWindowProc does, but Common Controls 6's
            // answers none (user32's and comctl32's combo.c test_combo_ctlcolor).
            if (record.parent)
            {
                return host.send(record.parent, message.message, message.wParam, message.lParam,
                    thread);
            }
            return (record.controlsVersion ?? 5) >= 6 ? 0 : common(record, message, thread);
        }
        switch (message.message){
            case WM_CREATE:
                return after(makeComboList(record, thread), ()=>after(makeComboEdit(record, thread),
                    ()=>after(measureCombo(record, thread), ()=>after(fitComboField(record, true),
                        ()=>common(record, message, thread)))));
            case WM_SETFONT: {
                const list = listOf(record);
                if (list)
                {
                    list.font = message.wParam >>> 0;
                }
                // A new font sizes the field's item afresh, but for an owner
                // drawn one, whose parent measured it.
                if ((record.style & CBS_OWNERDRAW) === 0)
                {
                    listState(record).fieldItem = undefined;
                }
                return after(edit ? host.send(edit.hwnd, WM_SETFONT, message.wParam, 0, thread) : 0,
                    ()=>after(common(record, message, thread), answer=>after(
                        fitComboField(record, false), ()=>answer)));
            }
            case WM_SIZE:
                return after(placeComboChildren(record), ()=>common(record, message, thread));
            case WM_WINDOWPOSCHANGING: {
                // A drop-down combo box stays as tall as its field, whatever
                // height it is given; a taller one is how far it drops, and
                // one no taller than the field, a dialog laid out again,
                // leaves that as it was (Wine's combo test, test_changesize).
                const pos = message.lParam >>> 0;
                const pointer = host.pointerSize ?? 4;
                if (!simple && pos !== 0 && (readU32(pos + 2 * pointer + 16) & SWP_NOSIZE) === 0)
                {
                    const asked = readU32(pos + 2 * pointer + 12) | 0;
                    if (asked > record.height)
                    {
                        state.droppedHeight = asked;
                    }
                    writeU32(pos + 2 * pointer + 12, record.height);
                }
                return common(record, message, thread);
            }
            case WM_PAINT:
                return painting(record, hdc=>{
                    paintCombo(record, hdc);
                });
            case WM_ERASEBKGND:
                return 1;
            case WM_GETDLGCODE:
                // A dropped list keeps Enter and Escape from the dialog: they
                // choose and close it.
                return DLGC_WANTARROWS | DLGC_WANTCHARS
                    | ((state.dropped ?? 0) !== 0 ? DLGC_WANTALLKEYS : 0);
            case WM_SETFOCUS:
                // An editable combo box's focus is its edit's, which tells it
                // so (EN_SETFOCUS below).
                if (edit)
                {
                    return after(host.setFocus(edit.hwnd, thread), ()=>0);
                }
                host.invalidate(record);
                return notify(record, CBN_SETFOCUS, thread);
            case WM_KILLFOCUS:
                if (edit)
                {
                    return 0;
                }
                host.invalidate(record);
                return after(closeList(record, false, thread),
                    ()=>notify(record, CBN_KILLFOCUS, thread));
            case WM_COMMAND:
                return edit && (message.lParam >>> 0) === edit.hwnd
                    ? editNotice(record, edit, message.wParam >>> 16, thread)
                    : common(record, message, thread);
            case WM_SETTEXT:
            case WM_GETTEXT:
            case WM_GETTEXTLENGTH:
                // An editable combo box's text is its edit's.
                return edit ? host.send(edit.hwnd, message.message, message.wParam, message.lParam,
                    thread) : common(record, message, thread);
            case WM_DESTROY:
                // A simple combo box's list is its child and goes with it.
                return after(closeList(record, false, thread), ()=>after(
                    !simple && listOf(record) ? host.destroy?.(stateOf(record).listWindow) ?? 0 : 0,
                    ()=>common(record, message, thread)));
            case WM_MOUSEWHEEL: {
                if (simple)
                {
                    scrollDropped(record, state.top + wheelRows(message.wParam),
                        simpleRows(record).visible);
                    return 0;
                }
                if ((state.dropped ?? 0) === 0)
                {
                    return common(record, message, thread);
                }
                const { rows } = droppedRows(record);
                scrollDropped(record, state.top + wheelRows(message.wParam), rows);
                return 0;
            }
            case WM_SYSKEYDOWN: {
                const key = message.wParam & 0xff;
                if (key !== VK_DOWN && key !== VK_UP)
                {
                    return common(record, message, thread);
                }
                return (state.dropped ?? 0) !== 0 ? closeList(record, true, thread)
                    : dropList(record, thread);
            }
            case WM_LBUTTONDOWN:
            case WM_LBUTTONDBLCLK: {
                // The field of an editable combo box is its edit's; a click on
                // the drop button, or anywhere on a dropdown list, drops the
                // list, and a click on what is left of the field focuses it.
                // Either way the click is answered TRUE, as Windows' combo
                // box answers it (user32 combo.c test_selection, test_listbox_size).
                const point = pointOf(message.lParam);
                const { button } = comboParts(record);
                if (edit && (simple || point.x < button.left))
                {
                    return after(host.setFocus(record.hwnd, thread), ()=>1);
                }
                return after(host.setFocus(record.hwnd, thread), ()=>after((state.dropped ?? 0)
                    !== 0 ? closeList(record, false, thread) : dropList(record, thread), ()=>1));
            }
            case WM_LBUTTONUP:
                // The dropped list holds the mouse and takes the release itself.
                return 1;
            case WM_CHAR:
                // Typing is the edit's; a dropdown list takes none.
                return edit ? host.send(edit.hwnd, WM_CHAR, message.wParam, message.lParam, thread)
                    : 0;
            case WM_KEYDOWN: {
                const key = message.wParam & 0xff;
                if (key === VK_F4)
                {
                    return (state.dropped ?? 0) !== 0 ? closeList(record, true, thread)
                        : dropList(record, thread);
                }
                if ((state.dropped ?? 0) !== 0)
                {
                    // Open, the keys walk the list and Enter or Escape close it.
                    if (key === VK_RETURN || key === VK_ESCAPE)
                    {
                        return closeList(record, key === VK_RETURN, thread);
                    }
                    const { rows } = droppedRows(record);
                    const move = key === VK_UP ? -1 : key === VK_DOWN ? 1
                        : key === VK_PRIOR ? -rows : key === VK_NEXT ? rows : 0;
                    if (move !== 0 && state.items.length > 0)
                    {
                        state.hot = Math.max(0, Math.min(state.items.length - 1,
                            (state.hot ?? state.current) + move));
                        const top = state.hot < state.top ? state.hot
                            : state.hot >= state.top + rows ? state.hot - rows + 1 : state.top;
                        scrollDropped(record, top, rows);
                    }
                    return 0;
                }
                // Closed, up and down walk the list in every kind of combo
                // box; the edit hands them here.
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
                if (simple)
                {
                    // The item chosen is scrolled into the rows that show.
                    const { visible } = simpleRows(record);
                    scrollDropped(record, index < state.top ? index
                        : index >= state.top + visible ? index - visible + 1 : state.top, visible);
                }
                return after(showItem(record, index, thread),
                    ()=>chooseItem(record, index, CBN_SELCHANGE, true, thread));
            }
            case CB_SHOWDROPDOWN:
                return after((message.wParam >>> 0) !== 0 ? dropList(record, thread)
                    : closeList(record, false, thread), ()=>1);
            case CB_GETDROPPEDSTATE:
                return (state.dropped ?? 0) !== 0 ? 1 : 0;
            case CB_SETEXTENDEDUI:
                return 0;
            case CB_GETEXTENDEDUI:
                return 0;
            case CB_GETEDITSEL:
                return edit ? host.send(edit.hwnd, EM_GETSEL, message.wParam, message.lParam,
                    thread) : CB_ERR;
            case CB_SETEDITSEL:
                // The low word is where the selection starts, the high word
                // where it ends, each -1 as the edit takes it.
                return edit ? after(host.send(edit.hwnd, EM_SETSEL, message.lParam << 16 >> 16,
                    message.lParam >> 16, thread), ()=>1) : CB_ERR;
            case CB_LIMITTEXT:
                return after(edit ? host.send(edit.hwnd, EM_LIMITTEXT, message.wParam, 0, thread)
                    : 0, ()=>1);
            case CB_SETDROPPEDWIDTH:
                // A width wider than nothing is kept; the list is never
                // narrower than the combo box.
                if ((message.wParam | 0) > 0)
                {
                    state.droppedWidth = message.wParam | 0;
                }
                return Math.max(state.droppedWidth ?? 0, record.width);
            case CB_GETDROPPEDWIDTH:
                return Math.max(state.droppedWidth ?? 0, record.width);
            case CB_GETDROPPEDCONTROLRECT: {
                // Where the combo box is on the screen as it is dropped: its
                // field and its list under it.
                if ((message.lParam >>> 0) === 0 || !host.clientOrigin)
                {
                    return CB_ERR;
                }
                const origin = host.clientOrigin(record);
                const height = simple ? record.height
                    : Math.max(record.height, state.droppedHeight ?? 0);
                writeRect(message.lParam, { left: origin.x, top: origin.y,
                    right: origin.x + Math.max(state.droppedWidth ?? 0, record.width),
                    bottom: origin.y + height });
                return 1;
            }
            case CB_GETITEMHEIGHT:
                if ((message.wParam | 0) === -1)
                {
                    return host.clientSize(record).height - 6;
                }
                return listOf(record) ? host.send(stateOf(record).listWindow, LB_GETITEMHEIGHT,
                    message.wParam, 0, thread) : CB_ERR;
            case CB_SETITEMHEIGHT:
                if ((message.wParam | 0) === -1)
                {
                    const height = message.lParam & 0xffff;
                    if (height === 0 || height > 255)
                    {
                        return CB_ERR;
                    }
                    state.fieldItem = height;
                    return after(fitComboField(record, false), ()=>0);
                }
                return listOf(record) ? host.send(stateOf(record).listWindow, LB_SETITEMHEIGHT,
                    message.wParam, message.lParam, thread) : CB_ERR;
            case CB_GETCOMBOBOXINFO:
                return host.comboBoxInfo?.(record.hwnd, message.lParam) ?? 0;
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
        const { thumb: part } = thumbOf(rect, vertical, held);
        if (!part)
        {
            return;
        }
        const thumb = vertical
            ? { ...rect, top: rect.top + part.start, bottom: rect.top + part.start + part.length }
            : { ...rect, left: rect.left + part.start,
                right: rect.left + part.start + part.length };
        draw.fill(hdc, thumb, color(COLOR_3DFACE));
        buttonEdge(hdc, thumb, false);
    };

    /**
     * What a press on a scroll bar means: an arrow scrolls a line, the track
     * either side of the thumb scrolls a page, and the thumb is taken to be
     * dragged, SB_THUMBTRACK.
     *
     * @param {Rect} rect @param {boolean} vertical
     * @param {ScrollBarState} held
     * @param {number} x @param {number} y
     * @returns {number} an SB_ code, or SB_ENDSCROLL for a track with no thumb on it
     */
    const scrollHit = (rect, vertical, held, x, y)=>{
        const along = vertical ? y - rect.top : x - rect.left;
        const { arrow, length, thumb } = thumbOf(rect, vertical, held);
        if (along < arrow)
        {
            return SB_LINEUP;
        }
        if (along >= length - arrow)
        {
            return SB_LINEDOWN;
        }
        if (!thumb)
        {
            return SB_ENDSCROLL;
        }
        return along < thumb.start ? SB_PAGEUP
            : along >= thumb.start + thumb.length ? SB_PAGEDOWN : SB_THUMBTRACK;
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
                const rect = clientRect(record);
                const code = scrollHit(rect, vertical, held, point.x, point.y);
                if (code === SB_ENDSCROLL || !record.parent)
                {
                    return 0;
                }
                if (code === SB_THUMBTRACK)
                {
                    // Held by the thumb: the pointer's distance into it
                    // stays as the thumb follows the pointer.
                    const own = stateOf(record);
                    own.grab = (vertical ? point.y : point.x)
                        - (thumbOf(rect, vertical, held).thumb?.start ?? 0);
                    own.tracked = held.pos;
                    host.setCapture(record.hwnd);
                    return 0;
                }
                // The parent moves the position: the control only reports
                // which way, as the real one does.
                return host.send(record.parent, vertical ? WM_VSCROLL : WM_HSCROLL,
                    code, record.hwnd, thread);
            }
            case WM_MOUSEMOVE:
            case WM_LBUTTONUP: {
                const own = stateOf(record);
                if (own.grab === undefined || !record.parent)
                {
                    return 0;
                }
                // SB_THUMBTRACK as the thumb moves, SB_THUMBPOSITION and
                // SB_ENDSCROLL where it is let go; the parent sets the
                // position.
                const point = pointOf(message.lParam);
                const value = thumbValue(clientRect(record), vertical, held,
                    (vertical ? point.y : point.x) - own.grab);
                const scroll = vertical ? WM_VSCROLL : WM_HSCROLL;
                if (message.message === WM_MOUSEMOVE)
                {
                    if (value === own.tracked)
                    {
                        return 0;
                    }
                    own.tracked = value;
                    held.trackPos = value;
                    return host.send(record.parent, scroll, (SB_THUMBTRACK | value << 16) >>> 0,
                        record.hwnd, thread);
                }
                own.grab = undefined;
                host.releaseCapture();
                return after(host.send(record.parent, scroll,
                    (SB_THUMBPOSITION | value << 16) >>> 0, record.hwnd, thread),
                ()=>host.send(record.parent, scroll, SB_ENDSCROLL, record.hwnd, thread));
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
        const bytes = host.readMemory(wholeAddress(address), 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };

    // --- The dialog class ---------------------------------------------------

    /** @param {any} record  Whether it is a push button: one Enter can press. */
    const isPushButton = record=>record.className === 'Button'
        && PUSH_KINDS.has(record.style & BS_TYPEMASK);

    /** @param {any} button @param {number} kind  BS_PUSHBUTTON or BS_DEFPUSHBUTTON. */
    const restyle = (button, kind)=>{
        if ((button.style & BS_TYPEMASK) !== kind)
        {
            button.style = ((button.style & ~BS_TYPEMASK) | kind) >>> 0;
            host.invalidate(button);
        }
    };

    /**
     * Styles the push button Enter presses as the default, as the dialog
     * manager does each time it moves the focus: the one with the focus when
     * the focus is on a push button, the dialog's default id's otherwise.
     * The default id itself does not change.
     *
     * @param {any} dialog @param {number} focused
     */
    const markDefault = (dialog, focused)=>{
        const buttons = host.children(dialog).filter(isPushButton);
        const chosen = buttons.find(button=>button.hwnd === focused)
            ?? buttons.find(button=>button.id === dialog.defaultId);
        for (const button of buttons)
        {
            restyle(button, button === chosen ? BS_DEFPUSHBUTTON : BS_PUSHBUTTON);
        }
    };

    const tabWalk = createTabWalk({ children: host.children, recordOf: host.windowOf });

    /**
     * Gives a control of a dialog the focus as the dialog manager moves it:
     * an edit's text selected on the way in, as tabbing into one selects
     * it, and the push buttons restyled after.
     *
     * @param {any} dialog @param {any} control @param {unknown} [thread]
     */
    const giveFocus = (dialog, control, thread)=>after(
        host.send(control.hwnd, WM_GETDLGCODE, 0, 0, thread), code=>after(
            ((code >>> 0) & DLGC_HASSETSEL) !== 0
                ? host.send(control.hwnd, EM_SETSEL, 0, -1 >>> 0, thread) : 0,
            ()=>after(host.setFocus(control.hwnd, thread), ()=>{
                markDefault(dialog, control.hwnd);
                return 0;
            })));

    /** @param {any} dialog @param {any} control  Whether the control is inside the dialog. */
    const inside = (dialog, control)=>{
        for (let at = control; at && (at.style & WS_CHILD) !== 0; at = host.live(at.parent))
        {
            if (at.parent === dialog.hwnd)
            {
                return true;
            }
        }
        return false;
    };

    /** @param {any} dialog  A dialog losing the activation remembers its control with the focus. */
    const saveFocus = dialog=>{
        const focus = host.live(host.focus());
        if (focus && inside(dialog, focus))
        {
            dialog.savedFocus = focus.hwnd;
        }
    };

    /**
     * The focus given back to the control a dialog remembers. Only on
     * activation (`justActivated`) is nothing done when it remembers none;
     * otherwise its first tab stop takes it, or the dialog itself.
     *
     * @param {any} dialog @param {boolean} justActivated @param {unknown} thread
     */
    const restoreFocus = (dialog, justActivated, thread)=>{
        if ((dialog.style & WS_MINIMIZE) !== 0)
        {
            return 0;
        }
        const saved = host.live(dialog.savedFocus ?? 0);
        dialog.savedFocus = 0;
        if (saved && saved !== dialog && inside(dialog, saved))
        {
            return justActivated ? after(host.setFocus(saved.hwnd, thread), ()=>0)
                : giveFocus(dialog, saved, thread);
        }
        if (justActivated)
        {
            return 0;
        }
        const first = firstFocus(dialog);
        return first ? giveFocus(dialog, first, thread) : 0;
    };

    /**
     * Where a dialog's focus goes when nothing says otherwise: its first
     * visible, enabled control that stops the Tab key or, where none does,
     * its first visible, enabled control - a label (dialog.c test_focus).
     *
     * @param {any} dialog @returns {any | null}
     */
    const firstFocus = dialog=>{
        const reachable = host.children(dialog).filter(child=>
            (child.style & (WS_VISIBLE | WS_DISABLED)) === WS_VISIBLE);
        return reachable.find(child=>(child.style & WS_TABSTOP) !== 0) ?? reachable[0] ?? null;
    };

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
            // The dialog's face for its statics and buttons, the window
            // colour for an edit and a list box, as DefWindowProc answers.
            case WM_CTLCOLORDLG:
            case WM_CTLCOLORSTATIC:
            case WM_CTLCOLORBTN:
            case WM_CTLCOLORSCROLLBAR:
            case WM_CTLCOLOREDIT:
            case WM_CTLCOLORLISTBOX:
                return defaultControlColors(message.message, message.wParam >>> 0);
            // The default id is the template's default push button's until a
            // program names another; the dialog manager keeps it on the
            // dialog's record, where making the dialog sets it.
            case DM_GETDEFID:
                // A dialog starts with IDOK as its default id, push button or
                // none: Enter in a dialog with no default button is IDOK.
                return ((DC_HASDEFID << 16) | (record.defaultId ?? IDOK) & 0xffff) >>> 0;
            case DM_SETDEFID: {
                // The style moves with it: off the old default, onto the new
                // one if it is a push button.
                const buttons = host.children(record).filter(isPushButton);
                const old = buttons.find(button=>button.id === record.defaultId);
                if (old)
                {
                    restyle(old, BS_PUSHBUTTON);
                }
                record.defaultId = message.wParam & 0xffff;
                const chosen = buttons.find(button=>button.id === record.defaultId);
                if (chosen)
                {
                    restyle(chosen, BS_DEFPUSHBUTTON);
                }
                return 1;
            }
            case WM_SETFONT:
                record.font = message.wParam >>> 0;
                return 0;
            case WM_GETFONT:
                return record.font ?? 0;
            case WM_ACTIVATE:
                // Activated, a dialog gives the focus back to the control
                // that had it when it was deactivated, if one did; deactivated,
                // it remembers that control (win32u DEFDLG_RestoreFocus,
                // DEFDLG_SaveFocus).
                if ((message.wParam & 0xffff) !== 0)
                {
                    return restoreFocus(record, true, thread);
                }
                saveFocus(record);
                return 0;
            case WM_SHOWWINDOW:
                if (message.wParam === 0)
                {
                    saveFocus(record);
                }
                return host.defWindowProc(record, message, thread);
            case WM_SETFOCUS:
                // The dialog passes the focus on: to the control it remembers,
                // else to its first control that stops the Tab key.
                return restoreFocus(record, false, thread);
            case WM_NEXTDLGCTL: {
                // The control named when lParam's low word says so, else the
                // next or previous tab stop from the focus; the default id
                // stays, and only the buttons' look follows the focus.
                // A dialog inside another as a control parent (a property
                // sheet's page) walks the tab stops of the dialog it is in,
                // as the dialog manager searches through it.
                let walker = record;
                while ((walker.style & WS_CHILD) !== 0
                    && (walker.exStyle & WS_EX_CONTROLPARENT) !== 0 && host.live(walker.parent))
                {
                    walker = host.live(walker.parent);
                }
                const target = (message.lParam & 0xffff) !== 0 ? host.live(message.wParam)
                    : tabWalk.nextTabStop(walker, host.focus(), message.wParam === 0);
                return target ? giveFocus(walker, target, thread) : 0;
            }
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
     * DefDlgProc's own work, which reads the ANSI page: a wide message reaches
     * it converted, and a text it fills goes back wide.
     *
     * @param {any} record @param {ControlMessage & { unicode?: boolean }} message
     * @param {unknown} [thread]
     */
    const byDefault = (record, message, thread)=>(message.unicode === true
        ? translated(host, message, false, ansi=>defDlgProc(record, ansi, thread), record.style)
        : defDlgProc(record, message, thread));

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
            return byDefault(record, message, thread);
        }
        const state = stateOf(record);
        // A dialog procedure that sends its own window the same message it
        // is handling -- WM_CTLCOLORDLG from WM_ERASEBKGND -- must reach the
        // default, not itself again.
        const previous = state.inDlgProc;
        state.inDlgProc = message.message;
        // The dialog procedure hears the message as it came - in the
        // window's encoding through the window, in the caller's through
        // DefDlgProcA/W - whatever encoding it was set in: no text is
        // converted for it (dialog.c test_aw_conversion_dlgproc).
        const reads = message.unicode === true;
        return after(host.callProcedure(dlgProc, message, thread, reads), handled=>{
            state.inDlgProc = previous;
            if ((handled | 0) === 0)
            {
                return byDefault(record, message, thread);
            }
            if (message.message === WM_INITDIALOG)
            {
                // TRUE from WM_INITDIALOG means "give the focus to the
                // first tab stop" - as the procedure left the controls, so a
                // radio button it checked is the one - or, with none, to the
                // first control; an edit's text selected on the way in. A
                // DS_CONTROL page its template leaves hidden takes no focus
                // (dialog.c test_focus).
                if ((record.style & DS_CONTROL) !== 0 && record.templateVisible === false)
                {
                    return 1;
                }
                const target = firstFocus(record);
                return target ? after(giveFocus(record, target, thread), ()=>1) : 1;
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
            ComboLBox: comboListProc,
            ScrollBar: scrollBarProc,
            '#32770': dialogProc,
        },
        helpers: { dialogProc, markDefault, defaultControlColors, paintScrollBar, scrollHit,
            comboInfo },
        // The drawing and messaging the classes above share, handed out whole
        // so the common controls paint and tell their parent with the same
        // helpers: one look, and a change to it is one change.
        toolkit: {
            color, glyph, edge, buttonEdge, sunkenEdge, etchedFrame, drawText,
            clientRect, stateOf, notify, controlColor, background, painting,
            common, disabled, writeU32, writeString, scrollOf, itemHeight,
            paintScrollBar, scrollHit, shrink, contains, editProc,
        },
    };
}
