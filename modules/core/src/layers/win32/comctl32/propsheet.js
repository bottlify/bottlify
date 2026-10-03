/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Property sheets: PropertySheet, CreatePropertySheetPage and
 * DestroyPropertySheetPage.
 *
 * A property sheet is a dialog like any other, and it is built here the way
 * a program would build one: a template in memory -- a tab control over OK,
 * Cancel, Apply and Help, or for a wizard Back, Next, Finish, Cancel and a
 * rule -- made into a dialog by user32, with this file's dialog procedure.
 * Each page is the program's own template and procedure, made a child of the
 * sheet the first time it is shown, and told what happens to it through
 * WM_NOTIFY: PSN_KILLACTIVE and PSN_SETACTIVE as the person moves from one
 * page to another, PSN_APPLY when the changes are to be kept and PSN_RESET
 * when they are not. What a page answers is what its procedure left in
 * DWLP_MSGRESULT, as SendMessage hands it back.
 *
 * Everything goes through user32's own calls, looked up when used: that is
 * the only way comctl32 reaches a window on Windows too. The one thing it
 * needs besides is an address for its dialog procedure, which the host makes.
 *
 * Every window is made through the ANSI calls, which are what user32 has here.
 * A wide sheet's strings are read as UTF-16 and an ANSI one's in the ANSI page,
 * and its templates are the same bytes either way; its caption and titles
 * reach the windows as UTF-16 where a template or a tab carries them, and in
 * the ANSI page where SetWindowText does, as a wide call's text reaches an
 * ANSI window.
 */

import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';
import { after } from '../user32/controls.js';

/** The handle a page description is copied under can never be this small. */
const MAX_INTRESOURCE = 0x10000;
const RT_DIALOG = 5;

/**
 * PROPSHEETPAGE: the same shape in both spellings. The header's title and
 * subtitle are the two members the second version adds.
 */
export const PSP = Object.freeze({
    dwSize: 0, dwFlags: 4, hInstance: 8, pszTemplate: 12, hIcon: 16, pszTitle: 20,
    pfnDlgProc: 24, lParam: 28, pfnCallback: 32, pcRefParent: 36, V1_SIZE: 40,
    pszHeaderTitle: 40, pszHeaderSubTitle: 44, V2_SIZE: 48,
});
export const PSP_DLGINDIRECT = 0x0001;
export const PSP_USETITLE = 0x0008;
export const PSP_HASHELP = 0x0020;
export const PSP_USECALLBACK = 0x0080;
export const PSP_PREMATURE = 0x0400;
export const PSP_HIDEHEADER = 0x0800;
export const PSP_USEHEADERTITLE = 0x1000;
export const PSP_USEHEADERSUBTITLE = 0x2000;
export const PSPCB_ADDREF = 0;
export const PSPCB_RELEASE = 1;
export const PSPCB_CREATE = 2;

/** PROPSHEETHEADER, likewise. */
export const PSH = Object.freeze({
    dwSize: 0, dwFlags: 4, hwndParent: 8, hInstance: 12, hIcon: 16, pszCaption: 20,
    nPages: 24, nStartPage: 28, phpage: 32, pfnCallback: 36, V1_SIZE: 40,
});
export const PSH_PROPTITLE = 0x0001;
export const PSH_PROPSHEETPAGE = 0x0008;
export const PSH_WIZARDHASFINISH = 0x0010;
export const PSH_WIZARD = 0x0020;
export const PSH_USEPSTARTPAGE = 0x0040;
export const PSH_NOAPPLYNOW = 0x0080;
export const PSH_USECALLBACK = 0x0100;
export const PSH_HASHELP = 0x0200;
export const PSH_MODELESS = 0x0400;
/** Wizard97, under the value the older headers gave it and the newer. */
export const PSH_WIZARD97_OLD = 0x00002000;
export const PSH_WIZARD_LITE = 0x00400000;
export const PSH_WIZARD97 = 0x01000000;
export const PSCB_INITIALIZED = 1;
export const PSCB_PRECREATE = 2;

/** The notifications a page is sent, PSN_FIRST down. */
export const PSN_SETACTIVE = -200;
export const PSN_KILLACTIVE = -201;
export const PSN_APPLY = -202;
export const PSN_RESET = -203;
export const PSN_HELP = -205;
export const PSN_WIZBACK = -206;
export const PSN_WIZNEXT = -207;
export const PSN_WIZFINISH = -208;
export const PSN_QUERYCANCEL = -209;
export const PSN_QUERYINITIALFOCUS = -213;
export const PSNRET_INVALID = 1;
export const PSNRET_INVALID_NOCHANGEPAGE = 2;

/** The messages a sheet answers, WM_USER + 101 on. */
export const PSM_SETCURSEL = 0x0465;
export const PSM_REMOVEPAGE = 0x0466;
export const PSM_ADDPAGE = 0x0467;
export const PSM_CHANGED = 0x0468;
export const PSM_RESTARTWINDOWS = 0x0469;
export const PSM_REBOOTSYSTEM = 0x046a;
export const PSM_CANCELTOCLOSE = 0x046b;
export const PSM_QUERYSIBLINGS = 0x046c;
export const PSM_UNCHANGED = 0x046d;
export const PSM_APPLY = 0x046e;
export const PSM_SETTITLEA = 0x046f;
export const PSM_SETWIZBUTTONS = 0x0470;
export const PSM_PRESSBUTTON = 0x0471;
export const PSM_SETCURSELID = 0x0472;
export const PSM_SETFINISHTEXTA = 0x0473;
export const PSM_GETTABCONTROL = 0x0474;
export const PSM_ISDIALOGMESSAGE = 0x0475;
export const PSM_GETCURRENTPAGEHWND = 0x0476;
export const PSM_INSERTPAGE = 0x0477;
export const PSM_SETTITLEW = 0x0478;
export const PSM_SETFINISHTEXTW = 0x0479;
export const PSM_SETHEADERTITLEA = 0x047d;
export const PSM_SETHEADERTITLEW = 0x047e;
export const PSM_SETHEADERSUBTITLEA = 0x047f;
export const PSM_SETHEADERSUBTITLEW = 0x0480;
export const PSM_HWNDTOINDEX = 0x0481;
export const PSM_INDEXTOHWND = 0x0482;
export const PSM_PAGETOINDEX = 0x0483;
export const PSM_INDEXTOPAGE = 0x0484;
export const PSM_IDTOINDEX = 0x0485;
export const PSM_INDEXTOID = 0x0486;
export const PSM_GETRESULT = 0x0487;
export const PSM_RECALCPAGESIZES = 0x0488;
export const PSWIZB_BACK = 0x1;
export const PSWIZB_NEXT = 0x2;
export const PSWIZB_FINISH = 0x4;
export const PSWIZB_DISABLEDFINISH = 0x8;
export const PSBTN_BACK = 0;
export const PSBTN_NEXT = 1;
export const PSBTN_FINISH = 2;
export const PSBTN_OK = 3;
export const PSBTN_APPLYNOW = 4;
export const PSBTN_CANCEL = 5;
export const PSBTN_HELP = 6;
export const ID_PSRESTARTWINDOWS = 0x2;
export const ID_PSREBOOTSYSTEM = 0x3;

/** The controls of the sheet's own template, by the ids programs look them up by. */
export const IDOK = 1;
export const IDCANCEL = 2;
export const IDHELP = 9;
export const IDC_TABCONTROL = 12320;
export const IDC_APPLY_BUTTON = 12321;
export const IDC_BACK_BUTTON = 12323;
export const IDC_NEXT_BUTTON = 12324;
export const IDC_FINISH_BUTTON = 12325;
export const IDC_SUNKEN_LINE = 12326;
export const IDC_SUNKEN_LINEHEADER = 12327;
/** A Wizard97 header's own controls: the band, and the title and subtitle on it. */
export const IDC_HEADER_BAND = 12328;
export const IDC_HEADER_TITLE = 12329;
export const IDC_HEADER_SUBTITLE = 12330;

/** Which button each PSBTN_ presses. */
const PRESSED = Object.freeze([IDC_BACK_BUTTON, IDC_NEXT_BUTTON, IDC_FINISH_BUTTON, IDOK,
    IDC_APPLY_BUTTON, IDCANCEL, IDHELP]);

const WM_NCDESTROY = 0x0082;
const WM_GETDLGCODE = 0x0087;
const WM_KEYDOWN = 0x0100;
const WM_NOTIFY = 0x004e;
const WM_INITDIALOG = 0x0110;
const WM_COMMAND = 0x0111;
const WM_CTLCOLORSTATIC = 0x0138;
const DM_GETDEFID = 0x0400;
const DM_SETDEFID = 0x0401;
const DWLP_MSGRESULT = 0;
const BN_CLICKED = 0;
const DLGC_WANTMESSAGE = 0x0004;
const VK_TAB = 0x09;
const VK_SHIFT = 0x10;
const VK_CONTROL = 0x11;
const VK_PRIOR = 0x21;
const VK_NEXT = 0x22;
const TCM_DELETEITEM = 0x1308;
const TCM_GETCURSEL = 0x130b;
const TCM_SETCURSEL = 0x130c;
const TCM_ADJUSTRECT = 0x1328;
const TCM_INSERTITEMW = 0x133e;
const TCIF_TEXT = 0x0001;
const TCN_SELCHANGE = -551;
const TCN_SELCHANGING = -552;
const SW_HIDE = 0;
const SW_SHOW = 5;
const SWP_NOSIZE = 0x0001;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SM_CXSCREEN = 0;
const SM_CYSCREEN = 1;

const WS_POPUP = 0x80000000;
const WS_CHILD = 0x40000000;
const WS_VISIBLE = 0x10000000;
const WS_DISABLED = 0x08000000;
const WS_CLIPSIBLINGS = 0x04000000;
const WS_CAPTION = 0x00c00000;
const WS_SYSMENU = 0x00080000;
const WS_THICKFRAME = 0x00040000;
const WS_GROUP = 0x00020000;
const WS_TABSTOP = 0x00010000;
const WS_EX_CONTROLPARENT = 0x00010000;
const DS_3DLOOK = 0x0004;
const DS_SETFONT = 0x0040;
const DS_MODALFRAME = 0x0080;
const DS_CONTROL = 0x0400;
const DS_CENTER = 0x0800;
const DS_CONTEXTHELP = 0x2000;
const BS_PUSHBUTTON = 0x0;
const BS_DEFPUSHBUTTON = 0x1;
const SS_ETCHEDHORZ = 0x10;
const SS_NOPREFIX = 0x80;
const COLOR_WINDOW = 5;

/**
 * The sheet's own window: what the style is read back as, which programs
 * compare, and a page's, made a control of the sheet whatever its template
 * said: a child with no frame, shown only when chosen, walked into by Tab.
 */
const SHEET_STYLE = (WS_POPUP | WS_CLIPSIBLINGS | WS_CAPTION | WS_SYSMENU | DS_CONTEXTHELP
    | DS_MODALFRAME | DS_SETFONT | DS_3DLOOK) >>> 0;
const PAGE_STYLE_CLEARED = (WS_POPUP | WS_CAPTION | WS_SYSMENU | WS_THICKFRAME | DS_MODALFRAME
    | DS_CENTER | WS_VISIBLE | WS_DISABLED) >>> 0;
const PAGE_STYLE_SET = (WS_CHILD | DS_CONTROL | DS_3DLOOK) >>> 0;

/** The sheet's layout in dialog units: margins, a button and the gap between two. */
const MARGIN = 7;
const BUTTON = Object.freeze({ width: 50, height: 14 });
const GAP = 4;
const SHEET_FONT = Object.freeze({ points: 8, face: 'MS Shell Dlg' });
/**
 * How far down a Wizard97 interior page sits: the documented templates are
 * 317x143 units inside and 317x193 outside, the header taking the rest.
 * The band ends a margin above the page, and its title and subtitle stand
 * in it as the Wizard97 pictures show them.
 */
const HEADER = 50;
const HEADER_TITLE = Object.freeze({ x: 2 * MARGIN, y: MARGIN, height: 10 });
const HEADER_SUBTITLE = Object.freeze({ x: 3 * MARGIN, y: MARGIN + 12, height: 20 });

/** A MSG: the window, the message, its two parameters, the time and the point. */
const MSG_SIZE = 28;
/** NMHDR and the lParam PSHNOTIFY adds to it. */
const PSHNOTIFY_SIZE = 16;
/** Guest memory each sheet keeps for the structures it hands user32. */
const SCRATCH = 64;

/**
 * Whether a sheet's flags make it a wizard: the plain one, the lite one or
 * Wizard97, each alone.
 *
 * @param {number} flags
 */
const wizardFlags = flags=>(flags & (PSH_WIZARD | PSH_WIZARD_LITE | PSH_WIZARD97
    | PSH_WIZARD97_OLD)) !== 0;

/**
 * What a property sheet needs from the rest of the system; fields of the
 * comctl32 host. Without user32, a heap and a way to give its procedure an
 * address, PropertySheet reports failure rather than a sheet it cannot make.
 *
 * @typedef {Object} SheetHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(name: string) => ({ handler: (args: number[]) => any } | undefined)} [user32]
 *           user32's exports by name, looked up when a sheet needs one.
 * @property {(bytes: number) => number} [allocate]
 * @property {(address: number) => void} [release]
 * @property {(entry: number, args: number[], thread?: unknown) => number | Promise<number>} [call]
 *           Calls a program's callback, stdcall.
 * @property {() => unknown} [callerThread]
 * @property {(name: string, handler: (args: number[]) => number | Promise<number>) => number}
 *     [procedure]  An address the dialog manager can call a procedure on this side at.
 * @property {(instance: number, type: number, name: number | string)
 *     => ({ rva: number } | null)} [findResource]
 * @property {(instance: number) => number} [moduleBase]
 * @property {(instance: number, id: number) => string | null} [loadString]
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {(hwnd: number, options: { thread: unknown,
 *     first?: import('../user32/dialogs.js').ModalHook }) => number | Promise<number>} [modal]
 *     user32's modal loop for a dialog made modeless, run on the thread named
 *     with each message offered to `first` before the dialog manager.
 *     Absent, a modal sheet is a DialogBox and hears its keys only as one.
 */

/**
 * @typedef {Object} Page
 * @property {number} handle  The address of the copy of the description.
 * @property {boolean} wide
 * @property {number} titleCopy  The copy of the title, or zero.
 *
 * @typedef {Object} Entry
 * @property {Page} page
 * @property {number} hwnd  Zero until the page's dialog is made.
 * @property {string} headerTitle  What a Wizard97 header shows over it.
 * @property {string} headerSubtitle
 *
 * @typedef {Object} Sheet
 * @property {number} hwnd
 * @property {boolean} wide
 * @property {number} flags
 * @property {number} instance
 * @property {number} owner
 * @property {number} callback
 * @property {Entry[]} entries
 * @property {number} current
 * @property {number} start
 * @property {Set<number>} changed  The pages PSM_CHANGED named and nothing has applied.
 * @property {boolean} applied  Whether a page's changes were saved.
 * @property {number} restart  ID_PSRESTARTWINDOWS or ID_PSREBOOTSYSTEM once a page asked, or 0.
 * @property {number} result  What the sheet answers once it has ended.
 * @property {boolean} ended
 * @property {number} template
 * @property {number} scratch
 * @property {number} tab
 * @property {{ x: number, y: number }} origin  Where a page sits in the sheet.
 * @property {number} header  How much lower a Wizard97 interior page sits, in pixels.
 */

/**
 * @param {SheetHost} host
 */
export function createPropertySheetFunctions(host){
    /** @type {Map<number, Page>} */
    const pages = new Map();
    /** @type {Map<number, Sheet>} */
    const sheets = new Map();
    /** Sheets on their way to WM_INITDIALOG, by the parameter they are made with. */
    /** @type {Map<number, Sheet>} */
    const pending = new Map();
    let nextKey = 1;
    let sheetProcedure = 0;

    /** @param {string} name @param {number[]} args @returns {any} */
    const api = (name, args)=>host.user32?.(name)?.handler(args) ?? 0;

    /**
     * Runs each step once the one before has been answered, and answers
     * with the last. A call that sends a message may be answered by the
     * program -- a page's procedure is the program's, the sheet's own is
     * reached the way the program would reach it, and a control may be
     * subclassed -- and the thread goes into the program for one call at a
     * time. Sent to a second before it has begun the first, it never runs
     * the first, and a later answer goes to that call instead of the one
     * it belongs to: the dialog manager's WM_INITDIALOG is never answered.
     *
     * @param {(() => any)[]} steps @returns {any}
     */
    const inTurn = (...steps)=>steps.reduce((done, step)=>after(done, step),
        /** @type {any} */ (0));

    /** @param {number} address */
    const u32 = address=>{
        const bytes = host.readMemory(address >>> 0, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    /** @param {number} address */
    const u16 = address=>{
        const bytes = host.readMemory(address >>> 0, 2);
        return bytes[0] | bytes[1] << 8;
    };
    /** @param {number} address @param {number} value */
    const putU32 = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address >>> 0, bytes);
    };
    /** @param {number} address @param {boolean} wide */
    const readText = (address, wide)=>{
        let text = '';
        /** @type {number[]} */
        const bytes = [];
        for (let at = address >>> 0, count = 0; count < 1024; count++)
        {
            const unit = wide ? u16(at) : host.readMemory(at, 1)[0];
            if (unit === 0)
            {
                break;
            }
            if (wide)
            {
                text += String.fromCharCode(unit);
            }
            else
            {
                bytes.push(unit);
            }
            at += wide ? 2 : 1;
        }
        return wide ? text : decodeAnsi(Uint8Array.from(bytes));
    };
    /** Terminated, as UTF-16 or in the ANSI page. @param {string} text @param {boolean} wide */
    const encode = (text, wide)=>{
        const bytes = new Uint8Array((text.length + 1) * (wide ? 2 : 1));
        if (!wide)
        {
            bytes.set(encodeAnsi(text));
            return bytes;
        }
        for (let index = 0; index < text.length; index++)
        {
            const unit = text.charCodeAt(index);
            bytes[index * 2] = unit & 0xff;
            bytes[index * 2 + 1] = unit >>> 8;
        }
        return bytes;
    };
    /** Guest memory holding some bytes, or zero. @param {Uint8Array} bytes */
    const place = bytes=>{
        const address = host.allocate?.(bytes.length) ?? 0;
        if (address !== 0)
        {
            host.writeMemory(address, bytes);
        }
        return address;
    };
    /** @param {number} address */
    const free = address=>{
        if (address !== 0)
        {
            host.release?.(address);
        }
    };

    /**
     * A string a structure names: text, or a resource id the instance's
     * string table answers for.
     *
     * @param {number} value @param {number} instance @param {boolean} wide
     */
    const stringOf = (value, instance, wide)=>{
        if (value === 0)
        {
            return '';
        }
        return value < MAX_INTRESOURCE ? host.loadString?.(instance, value) ?? ''
            : readText(value, wide);
    };

    /**
     * What a dialog template says of itself, walked the way the dialog
     * manager reads one: its styles, its size in dialog units, its caption,
     * and how many bytes it takes, which is what copying it needs.
     *
     * @param {number} base
     */
    const describe = base=>{
        let at = 0;
        const skip = ()=>{
            const first = u16(base + at);
            if (first === 0xffff)
            {
                at += 4;
                return '';
            }
            let text = '';
            for (let unit = first; unit !== 0; unit = u16(base + at))
            {
                text += String.fromCharCode(unit);
                at += 2;
            }
            at += 2;
            return text;
        };
        const extended = u16(base) === 1 && u16(base + 2) === 0xffff;
        const style = u32(base + (extended ? 12 : 0));
        const count = u16(base + (extended ? 16 : 8));
        const cx = u16(base + (extended ? 22 : 14)) << 16 >> 16;
        const cy = u16(base + (extended ? 24 : 16)) << 16 >> 16;
        at = extended ? 26 : 18;
        skip();
        skip();
        const title = skip();
        if ((style & DS_SETFONT) !== 0)
        {
            at += extended ? 6 : 2;
            skip();
        }
        for (let index = 0; index < count; index++)
        {
            at = (at + 3) & ~3;
            at += extended ? 24 : 18;
            skip();
            skip();
            const extra = u16(base + at);
            at += extended ? 2 + extra : (extra === 0 ? 2 : extra);
        }
        return { extended, style, cx, cy, title, size: at };
    };

    /** The template a page's dialog is made from, where it is, or zero. @param {Page} page */
    const templateOf = page=>{
        const flags = u32(page.handle + PSP.dwFlags);
        const named = u32(page.handle + PSP.pszTemplate);
        if ((flags & PSP_DLGINDIRECT) !== 0)
        {
            return named;
        }
        const instance = u32(page.handle + PSP.hInstance);
        const key = named < MAX_INTRESOURCE ? named : readText(named, page.wide);
        const found = host.findResource?.(instance, RT_DIALOG, key) ?? null;
        const base = host.moduleBase?.(instance) ?? 0;
        return found && base !== 0 ? base + found.rva : 0;
    };

    /** A page's title: its own, or its template's caption. @param {Page} page */
    const titleOf = page=>{
        const flags = u32(page.handle + PSP.dwFlags);
        if ((flags & PSP_USETITLE) !== 0)
        {
            return stringOf(u32(page.handle + PSP.pszTitle), u32(page.handle + PSP.hInstance),
                page.wide);
        }
        const template = templateOf(page);
        return template !== 0 ? describe(template).title : '';
    };

    /**
     * Calls a page's callback, if it asked for one: never with a window,
     * always with the copy of its description.
     *
     * @param {Page} page @param {number} message @param {unknown} thread
     * @returns {number | Promise<number>} what it answered, or 1 without one
     */
    const pageCallback = (page, message, thread)=>{
        const flags = u32(page.handle + PSP.dwFlags);
        const callback = u32(page.handle + PSP.pfnCallback);
        if ((flags & PSP_USECALLBACK) === 0 || callback === 0 || !host.call)
        {
            return 1;
        }
        return host.call(callback, [0, message, page.handle], thread);
    };

    /**
     * A page from its description: the description is copied, whole and
     * with whatever the program keeps after it, and the copy's address is
     * the handle; a title the page names is copied with it, since the
     * program's buffer need not outlive the call. A description older than
     * the first one's size is refused, and one newer than it is added a
     * reference to through its callback.
     *
     * @param {number} address @param {boolean} wide @param {unknown} thread
     * @returns {number | Promise<number>}
     */
    const createPage = (address, wide, thread)=>{
        if ((address >>> 0) === 0)
        {
            return 0;
        }
        const size = u32(address);
        if (size < PSP.V1_SIZE || size > 0x10000)
        {
            return 0;
        }
        const handle = place(host.readMemory(address >>> 0, size));
        if (handle === 0)
        {
            return 0;
        }
        /** @type {Page} */
        const page = { handle, wide, titleCopy: 0 };
        const flags = u32(handle + PSP.dwFlags);
        const title = u32(handle + PSP.pszTitle);
        if ((flags & PSP_USETITLE) !== 0 && title >= MAX_INTRESOURCE)
        {
            page.titleCopy = place(encode(readText(title, wide), wide));
            putU32(handle + PSP.pszTitle, page.titleCopy);
        }
        pages.set(handle, page);
        if (size > PSP.V1_SIZE)
        {
            return after(pageCallback(page, PSPCB_ADDREF, thread), ()=>handle);
        }
        return handle;
    };

    /**
     * Gives a page up: its callback is told, once, and its copies freed.
     *
     * @param {number} handle @param {unknown} thread
     * @returns {number | Promise<number>}
     */
    const destroyPage = (handle, thread)=>{
        const page = pages.get(handle >>> 0);
        if (!page)
        {
            return 0;
        }
        pages.delete(page.handle);
        return after(pageCallback(page, PSPCB_RELEASE, thread), ()=>{
            free(page.titleCopy);
            free(page.handle);
            return 1;
        });
    };

    /**
     * Tells the sheet's callback, if it asked for one.
     *
     * @param {Sheet} sheet @param {number} hwnd @param {number} message
     * @param {number} lParam @param {unknown} thread
     */
    const sheetCallback = (sheet, hwnd, message, lParam, thread)=>(
        (sheet.flags & PSH_USECALLBACK) !== 0 && sheet.callback !== 0 && host.call
            ? host.call(sheet.callback, [hwnd, message, lParam], thread)
            : 0);

    /** @param {Sheet} sheet */
    const wizard = sheet=>wizardFlags(sheet.flags);
    /** @param {Sheet} sheet */
    const wizard97 = sheet=>(sheet.flags & (PSH_WIZARD97 | PSH_WIZARD97_OLD)) !== 0;

    /**
     * The entry of a page in a sheet, with the header a Wizard97 interior
     * page shows: a string or a resource id of the sheet's instance, read
     * from a description of the second version or later.
     *
     * @param {Sheet} sheet @param {Page} page @returns {Entry}
     */
    const entryFor = (sheet, page)=>{
        const flags = u32(page.handle + PSP.dwFlags);
        const recent = u32(page.handle + PSP.dwSize) >= PSP.V2_SIZE;
        /** @param {number} flag @param {number} at */
        const text = (flag, at)=>(recent && (flags & flag) !== 0
            ? stringOf(u32(page.handle + at), sheet.instance, page.wide) : '');
        return { page, hwnd: 0,
            headerTitle: text(PSP_USEHEADERTITLE, PSP.pszHeaderTitle),
            headerSubtitle: text(PSP_USEHEADERSUBTITLE, PSP.pszHeaderSubTitle) };
    };

    /** @param {Entry} entry  Whether it is a Wizard97 page without the header. */
    const exterior = entry=>(u32(entry.page.handle + PSP.dwFlags) & PSP_HIDEHEADER) !== 0;

    /**
     * Where a page sits in the sheet: a Wizard97 interior page under the
     * header, every other at the sheet's origin.
     *
     * @param {Sheet} sheet @param {Entry} entry
     */
    const originOf = (sheet, entry)=>({ x: sheet.origin.x,
        y: sheet.origin.y + (wizard97(sheet) && !exterior(entry) ? sheet.header : 0) });

    /** @param {Sheet} sheet @param {number} id */
    const item = (sheet, id)=>api('GetDlgItem', [sheet.hwnd, id]) >>> 0;

    /**
     * The sheet's template: the caption, and its controls where the sheet
     * will lay them out once it knows its pages.
     *
     * @param {number} flags @param {string} caption
     */
    const sheetTemplate = (flags, caption)=>{
        /** @type {number[]} */
        const words = [];
        const word = (/** @type {number} */ value)=>words.push(value & 0xffff);
        const dword = (/** @type {number} */ value)=>{
            word(value);
            word(value >>> 16);
        };
        const text = (/** @type {string} */ value)=>{
            for (let index = 0; index < value.length; index++)
            {
                word(value.charCodeAt(index));
            }
            word(0);
        };
        const align = ()=>{
            if (words.length % 2 !== 0)
            {
                word(0);
            }
        };
        const shown = (/** @type {boolean} */ on)=>(on ? WS_VISIBLE : 0);
        // A Wizard97 header, shown for the pages that have one: the band,
        // its title and subtitle, and the line under it.
        /** @type {[number, string | number, string, number][]} */
        const header = (flags & (PSH_WIZARD97 | PSH_WIZARD97_OLD)) !== 0
            ? [
                [IDC_HEADER_BAND, 0x82, '', SS_NOPREFIX],
                [IDC_HEADER_TITLE, 0x82, '', SS_NOPREFIX],
                [IDC_HEADER_SUBTITLE, 0x82, '', SS_NOPREFIX],
                [IDC_SUNKEN_LINEHEADER, 0x82, '', SS_ETCHEDHORZ],
            ]
            : [];
        /** @type {[number, string | number, string, number][]} id, class, text, style */
        const controls = wizardFlags(flags)
            ? [
                ...header,
                [IDC_TABCONTROL, 'SysTabControl32', '', WS_CLIPSIBLINGS],
                [IDC_BACK_BUTTON, 0x80, '< &Back', WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON],
                [IDC_NEXT_BUTTON, 0x80, '&Next >', WS_VISIBLE | WS_TABSTOP | BS_DEFPUSHBUTTON],
                [IDC_FINISH_BUTTON, 0x80, 'Finish',
                    shown((flags & PSH_WIZARDHASFINISH) !== 0) | WS_TABSTOP | BS_PUSHBUTTON],
                [IDCANCEL, 0x80, 'Cancel', WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON],
                [IDHELP, 0x80, '&Help',
                    shown((flags & PSH_HASHELP) !== 0) | WS_TABSTOP | BS_PUSHBUTTON],
                [IDC_SUNKEN_LINE, 0x82, '', WS_VISIBLE | SS_ETCHEDHORZ],
            ]
            : [
                [IDC_TABCONTROL, 'SysTabControl32', '',
                    WS_VISIBLE | WS_CLIPSIBLINGS | WS_TABSTOP | WS_GROUP],
                [IDOK, 0x80, 'OK', WS_VISIBLE | WS_TABSTOP | WS_GROUP | BS_DEFPUSHBUTTON],
                [IDCANCEL, 0x80, 'Cancel', WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON],
                [IDC_APPLY_BUTTON, 0x80, '&Apply', shown((flags & PSH_NOAPPLYNOW) === 0)
                    | WS_DISABLED | WS_TABSTOP | BS_PUSHBUTTON],
                [IDHELP, 0x80, '&Help',
                    shown((flags & PSH_HASHELP) !== 0) | WS_TABSTOP | BS_PUSHBUTTON],
            ];
        const style = (flags & PSH_MODELESS) !== 0 ? SHEET_STYLE | WS_VISIBLE : SHEET_STYLE;
        dword(style);
        dword(0);
        word(controls.length);
        [0, 0, 212, 188].forEach(word);
        word(0);
        word(0);
        text(caption);
        word(SHEET_FONT.points);
        text(SHEET_FONT.face);
        for (const [id, cls, label, controlStyle] of controls)
        {
            align();
            dword((WS_CHILD | controlStyle) >>> 0);
            dword(0);
            [0, 0, BUTTON.width, BUTTON.height, id].forEach(word);
            if (typeof cls === 'number')
            {
                word(0xffff);
                word(cls);
            }
            else
            {
                text(cls);
            }
            text(label);
            word(0);
        }
        const bytes = new Uint8Array(words.length * 2);
        words.forEach((value, index)=>{
            bytes[index * 2] = value & 0xff;
            bytes[index * 2 + 1] = value >>> 8;
        });
        return bytes;
    };

    /**
     * A copy of a page's template made a control of the sheet: a child with
     * no frame and hidden, and a parent Tab walks into.
     *
     * @param {number} template
     */
    const pageTemplate = template=>{
        const shape = describe(template);
        const bytes = host.readMemory(template, shape.size);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const styleAt = shape.extended ? 12 : 0;
        const exStyleAt = shape.extended ? 8 : 4;
        view.setUint32(styleAt,
            (view.getUint32(styleAt, true) & ~PAGE_STYLE_CLEARED | PAGE_STYLE_SET) >>> 0, true);
        view.setUint32(exStyleAt, (view.getUint32(exStyleAt, true) | WS_EX_CONTROLPARENT) >>> 0,
            true);
        return place(bytes);
    };

    /** Reads the RECT at a sheet's scratch memory. @param {Sheet} sheet */
    const readRect = sheet=>({
        left: u32(sheet.scratch) | 0, top: u32(sheet.scratch + 4) | 0,
        right: u32(sheet.scratch + 8) | 0, bottom: u32(sheet.scratch + 12) | 0,
    });
    /** @param {Sheet} sheet @param {number[]} values */
    const writeRect = (sheet, values)=>values.forEach((value, index)=>
        putU32(sheet.scratch + index * 4, value));

    /** Dialog units in the sheet's font, as pixels. @param {Sheet} sheet */
    const units = (sheet, /** @type {number} */ x, /** @type {number} */ y)=>{
        writeRect(sheet, [0, 0, x, y]);
        api('MapDialogRect', [sheet.hwnd, sheet.scratch]);
        const rect = readRect(sheet);
        return { x: rect.right, y: rect.bottom };
    };

    /**
     * Sizes the sheet to its largest page and places its controls: the tab
     * control around the page, the buttons in a row under it from the
     * right; a wizard's page over a rule and its buttons, and a Wizard97
     * one from the sheet's edges, an interior page under the header. The
     * sheet is then centred on its owner, or on the screen.
     *
     * @param {Sheet} sheet @returns {any}
     */
    const layout = sheet=>{
        const margin = units(sheet, MARGIN, MARGIN);
        const button = units(sheet, BUTTON.width, BUTTON.height);
        const gap = units(sheet, GAP, GAP);
        sheet.header = wizard97(sheet) ? units(sheet, 0, HEADER).y : 0;
        let width = 0;
        let height = 0;
        for (const entry of sheet.entries)
        {
            const template = templateOf(entry.page);
            if (template !== 0)
            {
                const shape = describe(template);
                const size = units(sheet, shape.cx, shape.cy);
                width = Math.max(width, size.x);
                height = Math.max(height, size.y + (exterior(entry) ? 0 : sheet.header));
            }
        }
        /** @type {(() => any)[]} */
        const moves = [];
        /** @param {number} id @param {number} x @param {number} y @param {number} w @param {number} h */
        const move = (id, x, y, w, h)=>moves.push(()=>api('MoveWindow',
            [item(sheet, id), x, y, w, h, 0]));
        /** @param {number[]} ids @param {number} right @param {number} y */
        const row = (ids, right, y)=>ids.forEach((id, index)=>move(id,
            right - (ids.length - index) * button.x - (ids.length - 1 - index) * gap.x,
            y, button.x, button.y));
        if (wizard(sheet))
        {
            const inset = wizard97(sheet) ? { x: 0, y: 0 } : margin;
            sheet.origin = { x: inset.x, y: inset.y };
            const line = inset.y + height + (wizard97(sheet) ? 0 : gap.y);
            const buttons = line + 2 + gap.y;
            const alongside = (sheet.flags & PSH_WIZARDHASFINISH) !== 0;
            const lead = alongside ? [IDC_BACK_BUTTON, IDC_NEXT_BUTTON, IDC_FINISH_BUTTON]
                : [IDC_BACK_BUTTON, IDC_NEXT_BUTTON];
            const trailing = (sheet.flags & PSH_HASHELP) !== 0 ? [IDCANCEL, IDHELP] : [IDCANCEL];
            const across = (lead.length + trailing.length) * (button.x + gap.x);
            const client = { x: Math.max(width + 2 * inset.x, across + 2 * margin.x),
                y: buttons + button.y + margin.y };
            move(IDC_TABCONTROL, inset.x, inset.y, width, height);
            move(IDC_SUNKEN_LINE, inset.x, line, client.x - 2 * inset.x, 2);
            if (wizard97(sheet))
            {
                const band = sheet.header - margin.y;
                const title = units(sheet, HEADER_TITLE.x, HEADER_TITLE.y);
                const subtitle = units(sheet, HEADER_SUBTITLE.x, HEADER_SUBTITLE.y);
                move(IDC_HEADER_BAND, 0, 0, client.x, band);
                move(IDC_SUNKEN_LINEHEADER, 0, band, client.x, 2);
                move(IDC_HEADER_TITLE, title.x, title.y, client.x - title.x - margin.x,
                    units(sheet, 0, HEADER_TITLE.height).y);
                move(IDC_HEADER_SUBTITLE, subtitle.x, subtitle.y,
                    client.x - subtitle.x - margin.x, units(sheet, 0, HEADER_SUBTITLE.height).y);
            }
            const right = client.x - margin.x;
            row(trailing, right, buttons);
            // The two groups stand a gap further apart than their buttons,
            // and Finish, unless it has a place of its own, stands in Next's.
            const leadRight = right - trailing.length * (button.x + gap.x) - gap.x;
            row(lead, leadRight, buttons);
            if (!alongside)
            {
                move(IDC_FINISH_BUTTON, leadRight - button.x, buttons, button.x, button.y);
            }
            return inTurn(...moves, ()=>centre(sheet, client));
        }
        const tab = sheet.tab;
        writeRect(sheet, [0, 0, width, height]);
        return after(api('SendMessageA', [tab, TCM_ADJUSTRECT, 1, sheet.scratch]), ()=>{
            const around = readRect(sheet);
            const tabSize = { x: around.right - around.left, y: around.bottom - around.top };
            return inTurn(()=>api('MoveWindow', [tab, margin.x, margin.y, tabSize.x, tabSize.y, 0]),
                ()=>{
                    writeRect(sheet,
                        [margin.x, margin.y, margin.x + tabSize.x, margin.y + tabSize.y]);
                    return api('SendMessageA', [tab, TCM_ADJUSTRECT, 0, sheet.scratch]);
                },
                ()=>{
                    const pane = readRect(sheet);
                    sheet.origin = { x: pane.left, y: pane.top };
                    const buttons = margin.y + tabSize.y + gap.y;
                    // The row keeps its order whichever buttons show: the ones
                    // that do end at the right margin, and a hidden one sits
                    // past them.
                    const visible = [IDOK, IDCANCEL];
                    if ((sheet.flags & PSH_NOAPPLYNOW) === 0)
                    {
                        visible.push(IDC_APPLY_BUTTON);
                    }
                    if ((sheet.flags & PSH_HASHELP) !== 0)
                    {
                        visible.push(IDHELP);
                    }
                    const across = visible.length * button.x + (visible.length - 1) * gap.x;
                    const client = { x: Math.max(tabSize.x + 2 * margin.x, across + 2 * margin.x),
                        y: buttons + button.y + margin.y };
                    row(visible, client.x - margin.x, buttons);
                    const hidden = [IDOK, IDCANCEL, IDC_APPLY_BUTTON, IDHELP]
                        .filter(id=>!visible.includes(id));
                    row(hidden, client.x - margin.x + hidden.length * (button.x + gap.x),
                        buttons);
                    return inTurn(...moves, ()=>centre(sheet, client));
                });
        });
    };

    /**
     * Sizes the sheet around a client area and centres it on its owner, or
     * on the screen.
     *
     * @param {Sheet} sheet @param {{ x: number, y: number }} client
     */
    const centre = (sheet, client)=>{
        // The frame is what the window is beyond its client area.
        api('GetWindowRect', [sheet.hwnd, sheet.scratch]);
        const outer = readRect(sheet);
        api('GetClientRect', [sheet.hwnd, sheet.scratch]);
        const inner = readRect(sheet);
        const size = {
            x: client.x + (outer.right - outer.left) - (inner.right - inner.left),
            y: client.y + (outer.bottom - outer.top) - (inner.bottom - inner.top),
        };
        let over = { left: 0, top: 0,
            right: api('GetSystemMetrics', [SM_CXSCREEN]) | 0,
            bottom: api('GetSystemMetrics', [SM_CYSCREEN]) | 0 };
        if (sheet.owner !== 0 && api('IsWindow', [sheet.owner]) !== 0
            && api('GetWindowRect', [sheet.owner, sheet.scratch]) !== 0)
        {
            over = readRect(sheet);
        }
        const x = Math.max(0, over.left + ((over.right - over.left - size.x) >> 1));
        const y = Math.max(0, over.top + ((over.bottom - over.top - size.y) >> 1));
        return api('SetWindowPos', [sheet.hwnd, 0, x, y, size.x, size.y,
            SWP_NOZORDER | SWP_NOACTIVATE]);
    };

    /**
     * Sends a page a notification: WM_NOTIFY with a PSHNOTIFY from the
     * sheet, and the answer its procedure left in DWLP_MSGRESULT.
     *
     * @param {Sheet} sheet @param {number} index @param {number} code @param {number} lParam
     * @returns {number | Promise<number>}
     */
    const notifyPage = (sheet, index, code, lParam)=>{
        const entry = sheet.entries[index];
        if (!entry || entry.hwnd === 0)
        {
            return 0;
        }
        const bytes = new Uint8Array(PSHNOTIFY_SIZE);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, sheet.hwnd, true);
        view.setInt32(8, code, true);
        view.setUint32(12, lParam >>> 0, true);
        const address = place(bytes);
        if (address === 0)
        {
            return 0;
        }
        return after(api('SendMessageA', [entry.hwnd, WM_NOTIFY, 0, address]), answer=>{
            free(address);
            return answer | 0;
        });
    };

    /**
     * Makes a page's dialog, the first time it is wanted: its callback may
     * refuse, and a template that cannot be found or made leaves none.
     *
     * @param {Sheet} sheet @param {number} index @param {unknown} thread
     * @returns {number | Promise<number>} the page's window, or zero
     */
    const ensureCreated = (sheet, index, thread)=>{
        const entry = sheet.entries[index];
        if (!entry)
        {
            return 0;
        }
        if (entry.hwnd !== 0)
        {
            return entry.hwnd;
        }
        const page = entry.page;
        return after(pageCallback(page, PSPCB_CREATE, thread), allowed=>{
            const template = (allowed | 0) !== 0 ? templateOf(page) : 0;
            const copy = template !== 0 ? pageTemplate(template) : 0;
            if (copy === 0)
            {
                return 0;
            }
            return after(api('CreateDialogIndirectParamA', [u32(page.handle + PSP.hInstance),
                copy, sheet.hwnd, u32(page.handle + PSP.pfnDlgProc), page.handle]), made=>{
                free(copy);
                const hwnd = made >>> 0;
                if (hwnd === 0)
                {
                    return 0;
                }
                entry.hwnd = hwnd;
                const origin = originOf(sheet, entry);
                return after(api('SetWindowPos', [hwnd, 0, origin.x, origin.y, 0, 0,
                    SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE]), ()=>hwnd);
            });
        });
    };

    /**
     * Takes a page out of the sheet: its tab, its window, and the page
     * itself. The page on show stays on show; removing it shows the one
     * that took its place, or none.
     *
     * @param {Sheet} sheet @param {number} index @param {unknown} thread
     */
    const removePage = (sheet, index, thread)=>{
        const [entry] = sheet.entries.splice(index, 1);
        if (!entry)
        {
            return 0;
        }
        sheet.changed.delete(entry.hwnd);
        const wasCurrent = sheet.current === index;
        if (wasCurrent)
        {
            sheet.current = -1;
        }
        else if (sheet.current > index)
        {
            sheet.current--;
        }
        return inTurn(()=>api('SendMessageA', [sheet.tab, TCM_DELETEITEM, index, 0]),
            ()=>(entry.hwnd !== 0 ? api('DestroyWindow', [entry.hwnd]) : 0),
            ()=>destroyPage(entry.page.handle, thread),
            ()=>{
                if (sheet.current >= 0)
                {
                    return after(api('SendMessageA', [sheet.tab, TCM_SETCURSEL, sheet.current,
                        0]), ()=>1);
                }
                return wasCurrent && sheet.entries.length > 0
                    ? after(select(sheet, Math.min(index, sheet.entries.length - 1), thread,
                        { killed: true }), ()=>1)
                    : 1;
            });
    };

    /**
     * The focus a page starts with: what it answers PSN_QUERYINITIALFOCUS
     * with, else its first tab stop, else the tab control -- or on a
     * wizard page, the default button.
     *
     * @param {Sheet} sheet
     */
    const initialFocus = sheet=>{
        const entry = sheet.entries[sheet.current];
        if (!entry || entry.hwnd === 0)
        {
            return 0;
        }
        const first = api('GetNextDlgTabItem', [entry.hwnd, 0, 0]) >>> 0;
        return after(notifyPage(sheet, sheet.current, PSN_QUERYINITIALFOCUS, first), asked=>{
            const target = (asked >>> 0) || first;
            const chosen = target === 0 && wizard(sheet)
                ? after(api('SendMessageA', [sheet.hwnd, DM_GETDEFID, 0, 0]), id=>
                    item(sheet, id & 0xffff))
                : target;
            return after(chosen, focus=>api('SetFocus', [focus || sheet.tab]));
        });
    };

    /**
     * Moves the sheet to a page: the page on show is asked to let go with
     * PSN_KILLACTIVE -- unless it already was -- the new one made if it has
     * not been and told PSN_SETACTIVE, and the focus placed in it. A wizard
     * page that answers -1 is passed over in the direction of travel, and
     * one that answers a page's resource id sends the sheet there instead.
     *
     * @param {Sheet} sheet @param {number} index @param {unknown} thread
     * @param {{ killed?: boolean, direction?: number }} [how]
     * @returns {boolean | Promise<boolean>} false when the move was refused
     */
    const select = (sheet, index, thread, how = {})=>{
        if (index < 0 || index >= sheet.entries.length)
        {
            return false;
        }
        const previous = sheet.current;
        const leave = previous >= 0 && previous !== index && !how.killed
            ? notifyPage(sheet, previous, PSN_KILLACTIVE, 0) : 0;
        return after(leave, refused=>{
            if ((refused | 0) !== 0)
            {
                return false;
            }
            return after(ensureCreated(sheet, index, thread), hwnd=>{
                if ((hwnd >>> 0) === 0)
                {
                    // A page that cannot be made is dropped, and the sheet
                    // stays where it was. With nothing on show yet the page
                    // that took its place is tried, and a modal sheet left
                    // with none to show ends.
                    return after(removePage(sheet, index, thread), ()=>{
                        if (sheet.current >= 0)
                        {
                            return true;
                        }
                        if (sheet.entries.length > 0)
                        {
                            return select(sheet, Math.min(index, sheet.entries.length - 1),
                                thread, how);
                        }
                        return after((sheet.flags & PSH_MODELESS) === 0 ? finish(sheet) : 0,
                            ()=>true);
                    });
                }
                return after(notifyPage(sheet, index, PSN_SETACTIVE, 0), answer=>{
                    if ((answer | 0) !== 0 && wizard(sheet))
                    {
                        const direction = how.direction || 1;
                        const target = (answer | 0) === -1 ? index + direction
                            : indexOfId(sheet, answer >>> 0);
                        return target !== index
                            ? select(sheet, target, thread, { killed: true, direction })
                            : false;
                    }
                    const leaving = sheet.entries[previous];
                    return inTurn(()=>(leaving && previous !== index && leaving.hwnd !== 0
                        ? api('ShowWindow', [leaving.hwnd, SW_HIDE]) : 0),
                    ()=>{
                        sheet.current = index;
                        return api('SendMessageA', [sheet.tab, TCM_SETCURSEL, index, 0]);
                    },
                    ()=>showHeader(sheet),
                    ()=>api('ShowWindow', [hwnd, SW_SHOW]),
                    ()=>initialFocus(sheet),
                    ()=>true);
                });
            });
        });
    };

    /**
     * A Wizard97 sheet's header for the page on show: the band with the
     * page's title and subtitle for an interior page, nothing for an
     * exterior one; and the caption the page's template names, as a
     * Wizard97 wizard shows in place of its own.
     *
     * @param {Sheet} sheet @returns {any}
     */
    const showHeader = sheet=>{
        const entry = sheet.entries[sheet.current];
        if (!entry || !wizard97(sheet))
        {
            return 0;
        }
        const on = exterior(entry) ? SW_HIDE : SW_SHOW;
        const template = templateOf(entry.page);
        const caption = template !== 0 ? describe(template).title : '';
        return inTurn(...[IDC_HEADER_BAND, IDC_HEADER_TITLE, IDC_HEADER_SUBTITLE,
            IDC_SUNKEN_LINEHEADER].map(id=>()=>api('ShowWindow', [item(sheet, id), on])),
        ()=>setText(item(sheet, IDC_HEADER_TITLE), entry.headerTitle),
        ()=>setText(item(sheet, IDC_HEADER_SUBTITLE), entry.headerSubtitle),
        ()=>(caption !== '' ? setText(sheet.hwnd, caption) : 0));
    };

    /** A page's index by the resource id its template was named by, or -1. */
    const indexOfId = (/** @type {Sheet} */ sheet, /** @type {number} */ id)=>sheet.entries
        .findIndex(entry=>u32(entry.page.handle + PSP.pszTemplate) === id);

    /**
     * Inserts a page's tab and entry, a description taken for a page if it
     * is not one: refused when its template cannot be found, and when a page
     * made at once cannot be made.
     *
     * @param {Sheet} sheet @param {number} index @param {number} value @param {unknown} thread
     * @returns {number | Promise<number>}
     */
    const insertPage = (sheet, index, value, thread)=>{
        if ((value >>> 0) === 0)
        {
            return 0;
        }
        const given = pages.has(value >>> 0);
        const made = given ? value >>> 0 : createPage(value, sheet.wide, thread);
        return after(made, handle=>{
            const page = pages.get(handle >>> 0);
            if (!page || templateOf(page) === 0)
            {
                return page && !given ? after(destroyPage(page.handle, thread), ()=>0) : 0;
            }
            const at = Math.max(0, Math.min(index, sheet.entries.length));
            sheet.entries.splice(at, 0, entryFor(sheet, page));
            if (sheet.current >= at)
            {
                sheet.current++;
            }
            return after(addTab(sheet, at, titleOf(page)), ()=>{
                if ((u32(page.handle + PSP.dwFlags) & PSP_PREMATURE) === 0)
                {
                    return 1;
                }
                return after(ensureCreated(sheet, at, thread), hwnd=>{
                    if ((hwnd >>> 0) !== 0)
                    {
                        return 1;
                    }
                    sheet.entries.splice(at, 1);
                    if (sheet.current > at)
                    {
                        sheet.current--;
                    }
                    return after(api('SendMessageA', [sheet.tab, TCM_DELETEITEM, at, 0]), ()=>0);
                });
            });
        });
    };

    /**
     * @param {Sheet} sheet @param {number} index @param {string} title
     * @returns {any}
     */
    const addTab = (sheet, index, title)=>{
        const text = place(encode(title, true));
        const tcitem = new Uint8Array(28);
        const view = new DataView(tcitem.buffer);
        view.setUint32(0, TCIF_TEXT, true);
        view.setUint32(12, text, true);
        const address = place(tcitem);
        return after(address !== 0 ? api('SendMessageA', [sheet.tab, TCM_INSERTITEMW, index,
            address]) : 0, ()=>{
            free(address);
            free(text);
        });
    };

    /**
     * Applies every page that was made, PSN_APPLY in order, once the page
     * on show has let go. A page that answers PSNRET_INVALID is shown and
     * stops it; PSNRET_INVALID_NOCHANGEPAGE stops it where it is.
     *
     * @param {Sheet} sheet @param {boolean} closing  Whether OK asked, rather than Apply.
     * @param {unknown} thread
     * @returns {boolean | Promise<boolean>}
     */
    const apply = (sheet, closing, thread)=>after(
        sheet.current >= 0 ? notifyPage(sheet, sheet.current, PSN_KILLACTIVE, 0) : 0, refused=>{
            if ((refused | 0) !== 0)
            {
                return false;
            }
            /** @param {number} index @returns {any} */
            const each = index=>{
                if (index >= sheet.entries.length)
                {
                    return true;
                }
                return after(notifyPage(sheet, index, PSN_APPLY, closing ? 1 : 0), answer=>{
                    if ((answer | 0) === PSNRET_INVALID)
                    {
                        return after(select(sheet, index, thread, { killed: true }), ()=>false);
                    }
                    return (answer | 0) === PSNRET_INVALID_NOCHANGEPAGE ? false : each(index + 1);
                });
            };
            return after(each(0), (/** @type {boolean} */ applied)=>{
                if (!applied)
                {
                    return false;
                }
                sheet.applied = true;
                sheet.changed.clear();
                return after(api('EnableWindow', [item(sheet, IDC_APPLY_BUTTON), 0]), ()=>true);
            });
        });

    /**
     * The sheet is done: a modal one ends its dialog with the result, a
     * modeless one says so by having no page on show, and its program
     * destroys it. The result is 1 when a page's changes were saved and 0
     * when none were, and the restart a page asked for only when OK or
     * Finish closed the sheet.
     *
     * @param {Sheet} sheet @param {boolean} [confirmed]  Whether OK or Finish closed it.
     */
    const finish = (sheet, confirmed = false)=>{
        sheet.ended = true;
        sheet.result = confirmed && sheet.restart !== 0 ? sheet.restart
            : sheet.applied ? 1 : 0;
        if ((sheet.flags & PSH_MODELESS) === 0)
        {
            return api('EndDialog', [sheet.hwnd, sheet.result]);
        }
        return 0;
    };

    /**
     * Back or Next: the page is asked first, and what it answers says where
     * to go -- 0 the page beside it, -1 nowhere, anything else the page
     * with that resource id. The button pressed becomes the default.
     *
     * @param {Sheet} sheet @param {number} direction @param {number} code
     * @param {number} id @param {unknown} thread
     */
    const step = (sheet, direction, code, id, thread)=>after(
        notifyPage(sheet, sheet.current, code, 0), answer=>{
            if ((answer | 0) === -1)
            {
                return 0;
            }
            const target = (answer | 0) !== 0 ? indexOfId(sheet, answer >>> 0)
                : sheet.current + direction;
            return after(select(sheet, target, thread, { direction }), moved=>{
                if (moved && api('IsWindowEnabled', [item(sheet, id)]) !== 0)
                {
                    return api('SendMessageA', [sheet.hwnd, DM_SETDEFID, id, 0]);
                }
                return 0;
            });
        });

    /**
     * What a button of the sheet does.
     *
     * @param {Sheet} sheet @param {number} id @param {unknown} thread
     * @returns {any} null when the id is not one of the sheet's buttons
     */
    const press = (sheet, id, thread)=>{
        switch (id){
            case IDOK:
                return after(apply(sheet, true, thread), applied=>(applied
                    ? finish(sheet, true) : 0));
            case IDCANCEL:
                return after(notifyPage(sheet, sheet.current, PSN_QUERYCANCEL, 0), refused=>{
                    if ((refused | 0) !== 0)
                    {
                        return 0;
                    }
                    /** @param {number} index @returns {any} */
                    const reset = index=>(index >= sheet.entries.length ? finish(sheet)
                        : after(notifyPage(sheet, index, PSN_RESET, 0), ()=>reset(index + 1)));
                    return reset(0);
                });
            case IDC_APPLY_BUTTON:
                return after(apply(sheet, false, thread), applied=>(applied
                    ? initialFocus(sheet) : 0));
            case IDHELP:
                return notifyPage(sheet, sheet.current, PSN_HELP, 0);
            case IDC_BACK_BUTTON:
                return step(sheet, -1, PSN_WIZBACK, IDC_BACK_BUTTON, thread);
            case IDC_NEXT_BUTTON:
                return step(sheet, 1, PSN_WIZNEXT, IDC_NEXT_BUTTON, thread);
            case IDC_FINISH_BUTTON:
                return after(notifyPage(sheet, sheet.current, PSN_WIZFINISH, 0), refused=>{
                    if ((refused | 0) !== 0)
                    {
                        return 0;
                    }
                    sheet.applied = true;
                    return finish(sheet, true);
                });
            default:
                return null;
        }
    };

    /**
     * WM_INITDIALOG: the sheet's window exists, its caption and controls
     * with it. The callback hears first, as it may change the window; then
     * the tabs, the size, the pages made at once, and the start page.
     *
     * @param {Sheet} sheet @param {unknown} thread
     */
    const initialise = (sheet, thread)=>{
        sheet.tab = item(sheet, IDC_TABCONTROL);
        sheet.scratch = host.allocate?.(SCRATCH) ?? 0;
        return after(sheetCallback(sheet, sheet.hwnd, PSCB_INITIALIZED, 0, thread), ()=>{
            /** @param {number} index @returns {any} */
            const premature = index=>{
                if (index >= sheet.entries.length)
                {
                    return 0;
                }
                const flags = u32(sheet.entries[index].page.handle + PSP.dwFlags);
                return (flags & PSP_PREMATURE) !== 0
                    ? after(ensureCreated(sheet, index, thread), ()=>premature(index + 1))
                    : premature(index + 1);
            };
            return inTurn(...sheet.entries.map((entry, index)=>()=>
                addTab(sheet, index, titleOf(entry.page))),
            ()=>layout(sheet),
            ()=>premature(0),
            ()=>select(sheet, sheet.start, thread, { killed: true }),
            ()=>0);
        });
    };

    /** Answers a message through DWLP_MSGRESULT, as a dialog procedure does. */
    const answer = (/** @type {Sheet} */ sheet, /** @type {number} */ value)=>{
        api('SetWindowLongA', [sheet.hwnd, DWLP_MSGRESULT, value >>> 0]);
        return 1;
    };

    /** @param {Sheet} sheet @param {number} hwnd */
    const indexOfWindow = (sheet, hwnd)=>(hwnd === 0 ? -1
        : sheet.entries.findIndex(entry=>entry.hwnd === hwnd));

    /**
     * The keys the sheet itself answers in a message loop: with Ctrl held,
     * PgDn and Tab turn to the next page and PgUp and Shift+Tab to the one
     * before, round from either end, the page on show asked to let go as a
     * click on a tab asks it. A control that asks for every key keeps them.
     *
     * @param {Sheet} sheet @param {number} msg  The MSG's address.
     * @param {(hwnd: number, message: number, wParam: number, lParam: number)
     *     => number | Promise<number>} send  Sends on the loop's thread.
     * @param {(index: number, direction: number) => unknown} turnTo
     * @returns {boolean | Promise<boolean>} whether the key was the sheet's
     */
    const pageKey = (sheet, msg, send, turnTo)=>{
        const target = u32(msg);
        const key = u32(msg + 8);
        const held = (/** @type {number} */ vk)=>(api('GetKeyState', [vk]) & 0x8000) !== 0;
        const turn = key === VK_NEXT ? 1 : key === VK_PRIOR ? -1
            : key === VK_TAB ? (held(VK_SHIFT) ? -1 : 1) : 0;
        if (u32(msg + 4) !== WM_KEYDOWN || turn === 0 || !held(VK_CONTROL)
            || (target !== sheet.hwnd && api('IsChild', [sheet.hwnd, target]) === 0))
        {
            return false;
        }
        return after(send(target, WM_GETDLGCODE, key, msg), wants=>{
            const count = sheet.entries.length;
            if (((wants >>> 0) & DLGC_WANTMESSAGE) !== 0)
            {
                return false;
            }
            // With no page on show, the first or the last is the one turned to.
            const from = sheet.current >= 0 ? sheet.current : turn > 0 ? -1 : count;
            return count === 0 ? true
                : after(turnTo((from + turn + count) % count, turn), ()=>true);
        });
    };

    /**
     * A modal sheet's loop, run by the dialog manager on the thread that
     * called PropertySheet: each message is the sheet's to look at first, as
     * PSM_ISDIALOGMESSAGE looks at it in a modeless sheet's loop. The page
     * is turned by PSM_SETCURSEL, sent on that thread.
     *
     * @param {Sheet} sheet @param {unknown} thread
     * @returns {number | Promise<number>}
     */
    const runSheet = (sheet, thread)=>{
        const msg = place(new Uint8Array(MSG_SIZE));
        return after(/** @type {NonNullable<SheetHost['modal']>} */ (host.modal)(sheet.hwnd, {
            thread,
            first: (message, send)=>{
                if (msg === 0)
                {
                    return false;
                }
                const bytes = new Uint8Array(MSG_SIZE);
                const view = new DataView(bytes.buffer);
                [message.hwnd, message.message, message.wParam, message.lParam,
                    message.time ?? 0, message.x ?? 0, message.y ?? 0].forEach((value, index)=>
                    view.setUint32(index * 4, value >>> 0, true));
                host.writeMemory(msg, bytes);
                return pageKey(sheet, msg, send, index=>send(sheet.hwnd, PSM_SETCURSEL, index, 0));
            },
        }), result=>{
            free(msg);
            // Left by a WM_QUIT rather than ended, the sheet answers whether a
            // page's changes were saved, as it would have.
            return sheet.ended ? result : sheet.applied ? 1 : 0;
        });
    };

    /**
     * The sheet's dialog procedure.
     *
     * @param {number[]} args
     * @returns {number | Promise<number>}
     */
    const sheetProc = ([hwnd, message, wParam, lParam])=>{
        const thread = host.callerThread?.();
        if ((message >>> 0) === WM_INITDIALOG)
        {
            const made = pending.get(lParam >>> 0);
            if (!made)
            {
                return 0;
            }
            pending.delete(lParam >>> 0);
            made.hwnd = hwnd >>> 0;
            sheets.set(made.hwnd, made);
            return initialise(made, thread);
        }
        const sheet = sheets.get(hwnd >>> 0);
        if (!sheet)
        {
            return 0;
        }
        const index = wParam | 0;
        const handle = lParam >>> 0;
        switch (message >>> 0){
            case WM_COMMAND: {
                const done = (wParam >>> 16) === BN_CLICKED ? press(sheet, wParam & 0xffff, thread)
                    : null;
                return done === null ? 0 : after(done, ()=>1);
            }
            case WM_NOTIFY: {
                if ((u32(handle + 4) & 0xffff) !== IDC_TABCONTROL)
                {
                    return 0;
                }
                const code = u32(handle + 8) | 0;
                if (code === TCN_SELCHANGING)
                {
                    return after(notifyPage(sheet, sheet.current, PSN_KILLACTIVE, 0), refused=>
                        answer(sheet, (refused | 0) !== 0 ? 1 : 0));
                }
                if (code === TCN_SELCHANGE)
                {
                    return after(api('SendMessageA', [sheet.tab, TCM_GETCURSEL, 0, 0]), chosen=>
                        after(select(sheet, chosen | 0, thread, { killed: true }), ()=>
                            answer(sheet, 0)));
                }
                return 0;
            }
            case WM_NCDESTROY: {
                // The last message the sheet hears, after its pages have
                // gone: the pages it was given go with it.
                sheets.delete(sheet.hwnd);
                /** @param {number} at @returns {any} */
                const release = at=>(at >= sheet.entries.length ? 0
                    : after(destroyPage(sheet.entries[at].page.handle, thread),
                        ()=>release(at + 1)));
                return after(release(0), ()=>{
                    free(sheet.template);
                    free(sheet.scratch);
                    return 0;
                });
            }
            case PSM_SETCURSEL: {
                const chosen = pages.has(handle) ? sheet.entries.findIndex(entry=>
                    entry.page.handle === handle) : index;
                return after(select(sheet, chosen, thread), moved=>answer(sheet, moved ? 1 : 0));
            }
            case PSM_SETCURSELID:
                return after(select(sheet, indexOfId(sheet, handle), thread), moved=>
                    answer(sheet, moved ? 1 : 0));
            case PSM_REMOVEPAGE: {
                const gone = pages.has(handle) ? sheet.entries.findIndex(entry=>
                    entry.page.handle === handle) : index;
                return gone >= 0 && gone < sheet.entries.length
                    ? after(removePage(sheet, gone, thread), ()=>answer(sheet, 0))
                    : answer(sheet, 0);
            }
            case PSM_ADDPAGE:
                return after(insertPage(sheet, sheet.entries.length, handle, thread), added=>
                    answer(sheet, added));
            case PSM_INSERTPAGE: {
                const where = wParam >>> 0;
                const at = where < MAX_INTRESOURCE ? where
                    : sheet.entries.findIndex(entry=>entry.page.handle === where) + 1;
                return at === 0 && where >= MAX_INTRESOURCE ? answer(sheet, 0)
                    : after(insertPage(sheet, at, handle, thread), added=>answer(sheet, added));
            }
            case PSM_CHANGED:
                sheet.changed.add(wParam >>> 0);
                return after(api('EnableWindow', [item(sheet, IDC_APPLY_BUTTON), 1]), ()=>
                    answer(sheet, 0));
            case PSM_UNCHANGED:
                sheet.changed.delete(wParam >>> 0);
                return after(sheet.changed.size === 0
                    ? api('EnableWindow', [item(sheet, IDC_APPLY_BUTTON), 0]) : 0, ()=>
                    answer(sheet, 0));
            case PSM_CANCELTOCLOSE:
                return inTurn(()=>api('EnableWindow', [item(sheet, IDCANCEL), 0]),
                    ()=>setText(item(sheet, IDOK), 'Close'),
                    ()=>answer(sheet, 0));
            case PSM_QUERYSIBLINGS: {
                /** @param {number} at @returns {any} */
                const ask = at=>{
                    const entry = sheet.entries[at];
                    if (!entry)
                    {
                        return 0;
                    }
                    return entry.hwnd === 0 ? ask(at + 1)
                        : after(api('SendMessageA', [entry.hwnd, PSM_QUERYSIBLINGS, wParam,
                            lParam]), said=>((said | 0) !== 0 ? said : ask(at + 1)));
                };
                return after(ask(0), said=>answer(sheet, said));
            }
            case PSM_APPLY:
                return after(apply(sheet, false, thread), applied=>answer(sheet, applied ? 1 : 0));
            case PSM_SETTITLEA:
            case PSM_SETTITLEW: {
                const text = stringOf(handle, sheet.instance, (message >>> 0) === PSM_SETTITLEW);
                return after(setText(sheet.hwnd, (wParam & PSH_PROPTITLE) !== 0
                    ? `Properties for ${text}` : text), ()=>answer(sheet, 0));
            }
            case PSM_SETWIZBUTTONS: {
                const flags = lParam >>> 0;
                const finishing = (flags & (PSWIZB_FINISH | PSWIZB_DISABLEDFINISH)) !== 0;
                /** @param {number} id @param {number} bit */
                const enable = (id, bit)=>()=>api('EnableWindow',
                    [item(sheet, id), (flags & bit) !== 0 ? 1 : 0]);
                const swap = (sheet.flags & PSH_WIZARDHASFINISH) === 0;
                /** @param {number} id @param {boolean} on */
                const show = (id, on)=>()=>(swap
                    ? api('ShowWindow', [item(sheet, id), on ? SW_SHOW : SW_HIDE]) : 0);
                const standing = finishing ? IDC_FINISH_BUTTON : IDC_NEXT_BUTTON;
                return inTurn(enable(IDC_BACK_BUTTON, PSWIZB_BACK),
                    enable(IDC_NEXT_BUTTON, PSWIZB_NEXT),
                    enable(IDC_FINISH_BUTTON, PSWIZB_FINISH),
                    show(IDC_NEXT_BUTTON, !finishing),
                    show(IDC_FINISH_BUTTON, finishing),
                    ()=>(api('IsWindowEnabled', [item(sheet, standing)]) !== 0
                        ? api('SendMessageA', [sheet.hwnd, DM_SETDEFID, standing, 0]) : 0),
                    ()=>answer(sheet, 0));
            }
            case PSM_SETFINISHTEXTA:
            case PSM_SETFINISHTEXTW: {
                const finishButton = item(sheet, IDC_FINISH_BUTTON);
                return inTurn(()=>setText(finishButton, stringOf(handle, sheet.instance,
                    (message >>> 0) === PSM_SETFINISHTEXTW)),
                ()=>api('ShowWindow', [item(sheet, IDC_BACK_BUTTON), SW_HIDE]),
                ()=>api('ShowWindow', [item(sheet, IDC_NEXT_BUTTON), SW_HIDE]),
                ()=>api('EnableWindow', [finishButton, 1]),
                ()=>api('ShowWindow', [finishButton, SW_SHOW]),
                ()=>api('SendMessageA', [sheet.hwnd, DM_SETDEFID, IDC_FINISH_BUTTON, 0]),
                ()=>answer(sheet, 0));
            }
            case PSM_PRESSBUTTON: {
                const id = PRESSED[index];
                const done = id === undefined ? null : press(sheet, id, thread);
                return done === null ? answer(sheet, 0) : after(done, ()=>answer(sheet, 0));
            }
            case PSM_GETTABCONTROL:
                return answer(sheet, sheet.tab);
            case PSM_ISDIALOGMESSAGE:
                return after(pageKey(sheet, handle, (...args)=>api('SendMessageA', args),
                    (to, direction)=>select(sheet, to, thread, { direction })), turned=>(turned
                    ? answer(sheet, 1)
                    : after(api('IsDialogMessageA', [sheet.hwnd, handle]), taken=>
                        answer(sheet, taken))));
            case PSM_GETCURRENTPAGEHWND:
                return answer(sheet, sheet.ended ? 0 : sheet.entries[sheet.current]?.hwnd ?? 0);
            case PSM_HWNDTOINDEX:
                return answer(sheet, indexOfWindow(sheet, wParam >>> 0));
            case PSM_INDEXTOHWND:
                return answer(sheet, sheet.entries[index]?.hwnd ?? 0);
            case PSM_PAGETOINDEX:
                return answer(sheet, sheet.entries.findIndex(entry=>entry.page.handle === handle));
            case PSM_INDEXTOPAGE:
                return answer(sheet, sheet.entries[index]?.page.handle ?? 0);
            case PSM_IDTOINDEX:
                return answer(sheet, indexOfId(sheet, handle));
            case PSM_INDEXTOID: {
                const entry = sheet.entries[index];
                return answer(sheet, entry ? u32(entry.page.handle + PSP.pszTemplate) : 0);
            }
            case PSM_GETRESULT:
                return answer(sheet, sheet.ended ? sheet.result : -1);
            case PSM_RESTARTWINDOWS:
                // A reboot asked for already stands over a restart.
                sheet.restart ||= ID_PSRESTARTWINDOWS;
                return answer(sheet, 0);
            case PSM_REBOOTSYSTEM:
                sheet.restart = ID_PSREBOOTSYSTEM;
                return answer(sheet, 0);
            case PSM_RECALCPAGESIZES:
                return answer(sheet, 1);
            case PSM_SETHEADERTITLEA:
            case PSM_SETHEADERTITLEW:
            case PSM_SETHEADERSUBTITLEA:
            case PSM_SETHEADERSUBTITLEW: {
                const entry = sheet.entries[index];
                const kind = message >>> 0;
                if (!entry)
                {
                    return answer(sheet, 0);
                }
                const text = stringOf(handle, sheet.instance,
                    kind === PSM_SETHEADERTITLEW || kind === PSM_SETHEADERSUBTITLEW);
                if (kind === PSM_SETHEADERTITLEA || kind === PSM_SETHEADERTITLEW)
                {
                    entry.headerTitle = text;
                }
                else
                {
                    entry.headerSubtitle = text;
                }
                return after(index === sheet.current ? showHeader(sheet) : 0, ()=>
                    answer(sheet, 0));
            }
            case WM_CTLCOLORSTATIC:
                // The header is drawn in the window colour, not the face.
                return [IDC_HEADER_BAND, IDC_HEADER_TITLE, IDC_HEADER_SUBTITLE].some(id=>
                    item(sheet, id) === handle) ? api('GetSysColorBrush', [COLOR_WINDOW]) : 0;
            default:
                return 0;
        }
    };

    /**
     * A window's text, through SetWindowTextA and so in the ANSI page. The
     * copy is kept until the window has answered: a procedure of the
     * program's reads it when it is run, which may be later.
     *
     * @param {number} hwnd @param {string} text @returns {any}
     */
    const setText = (hwnd, text)=>{
        const address = place(encode(text, false));
        return address === 0 ? 0 : after(api('SetWindowTextA', [hwnd, address]), done=>{
            free(address);
            return done;
        });
    };

    /**
     * PropertySheet: the pages collected -- made from their descriptions,
     * or taken as handles, where a value this library did not hand out is
     * read as a description -- the template built and shown to the
     * callback, and the sheet made. A modeless sheet is its window; a modal
     * one disables its owner and answers once it has ended, with the
     * result `finish` gave it.
     *
     * @param {number} header @param {boolean} wide
     * @returns {number | Promise<number>}
     */
    const propertySheet = (header, wide)=>{
        const thread = host.callerThread?.();
        if (!host.user32 || !host.allocate || !host.procedure)
        {
            host.divergence?.('PropertySheet', 'no window manager to make a sheet with');
            return -1;
        }
        if ((header >>> 0) === 0 || u32(header) < PSH.V1_SIZE)
        {
            return -1;
        }
        const flags = u32(header + PSH.dwFlags);
        const count = u32(header + PSH.nPages);
        const list = u32(header + PSH.phpage);
        /** @type {Sheet} */
        const sheet = {
            hwnd: 0, wide, flags, instance: u32(header + PSH.hInstance),
            owner: u32(header + PSH.hwndParent), callback: u32(header + PSH.pfnCallback),
            entries: [], current: -1, start: 0, changed: new Set(), applied: false, restart: 0,
            result: 0, ended: false,
            template: 0, scratch: 0, tab: 0, origin: { x: 0, y: 0 }, header: 0,
        };
        let cursor = list;
        /** @param {number} index @returns {any} */
        const collect = index=>{
            if (index >= count || count > 0x1000)
            {
                return 0;
            }
            let made;
            if ((flags & PSH_PROPSHEETPAGE) !== 0)
            {
                made = createPage(cursor, wide, thread);
                cursor += Math.max(PSP.V1_SIZE, u32(cursor));
            }
            else
            {
                const value = u32(list + index * 4);
                made = pages.has(value) ? value : createPage(value, wide, thread);
            }
            return after(made, handle=>{
                const page = pages.get(handle >>> 0);
                if (page)
                {
                    sheet.entries.push(entryFor(sheet, page));
                }
                return collect(index + 1);
            });
        };
        return after(collect(0), ()=>{
            const start = u32(header + PSH.nStartPage);
            sheet.start = (flags & PSH_USEPSTARTPAGE) !== 0
                ? Math.max(0, sheet.entries.findIndex(entry=>titleOf(entry.page)
                    === stringOf(start, sheet.instance, wide)))
                : start < sheet.entries.length ? start : 0;
            const named = stringOf(u32(header + PSH.pszCaption), sheet.instance, wide);
            const caption = (flags & PSH_PROPTITLE) !== 0 ? `Properties for ${named}` : named;
            sheet.template = place(sheetTemplate(flags, caption));
            if (sheet.template === 0)
            {
                return -1;
            }
            sheetProcedure ||= /** @type {NonNullable<SheetHost['procedure']>} */ (
                host.procedure)('PropertySheetProc', sheetProc);
            return after(sheetCallback(sheet, 0, PSCB_PRECREATE, sheet.template, thread), ()=>{
                const key = nextKey++;
                pending.set(key, sheet);
                const args = [sheet.instance, sheet.template, sheet.owner, sheetProcedure, key];
                if ((flags & PSH_MODELESS) !== 0)
                {
                    return after(api('CreateDialogIndirectParamA', args), hwnd=>{
                        pending.delete(key);
                        return hwnd >>> 0;
                    });
                }
                // The owner is disabled before the sheet exists: its
                // callback and its pages are told of a sheet already modal.
                const owner = sheet.owner !== 0 && api('IsWindowEnabled', [sheet.owner]) !== 0
                    ? sheet.owner : 0;
                /** @param {number} result */
                const ended = result=>{
                    pending.delete(key);
                    return after(owner !== 0 ? api('EnableWindow', [owner, 1]) : 0, ()=>
                        result | 0);
                };
                return after(owner !== 0 ? api('EnableWindow', [owner, 0]) : 0, ()=>{
                    // The sheet runs its own loop, as it does on Windows,
                    // where user32 lends one; a DialogBox's otherwise.
                    if (!host.modal)
                    {
                        return after(api('DialogBoxIndirectParamA', args), ended);
                    }
                    return after(api('CreateDialogIndirectParamA', args), made=>((made >>> 0)
                        === 0 ? ended(-1) : after(runSheet(sheet, thread), ended)));
                });
            });
        });
    };

    return {
        /** HPROPSHEETPAGE CreatePropertySheetPageA(LPCPROPSHEETPAGEA constPropSheetPagePointer) */
        CreatePropertySheetPageA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([description])=>createPage(description, false, host.callerThread?.()),
        },

        /** HPROPSHEETPAGE CreatePropertySheetPageW(LPCPROPSHEETPAGEW constPropSheetPagePointer) */
        CreatePropertySheetPageW: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([description])=>createPage(description, true, host.callerThread?.()),
        },

        /** BOOL DestroyPropertySheetPage(HPROPSHEETPAGE) */
        DestroyPropertySheetPage: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>destroyPage(handle, host.callerThread?.()),
        },

        /** INT_PTR PropertySheetA(LPCPROPSHEETHEADERA) */
        PropertySheetA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([header])=>propertySheet(header, false),
        },

        /** INT_PTR PropertySheetW(LPCPROPSHEETHEADERW) */
        PropertySheetW: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([header])=>propertySheet(header, true),
        },
    };
}
