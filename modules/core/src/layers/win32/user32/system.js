/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a program asks the system about itself: how big the screen is, what
 * colour a button is, where the cursor is, which display modes exist.
 *
 * Every one of these has a wrong answer that costs more than no answer. A
 * metric that contradicts the screen the build was configured for makes a game
 * centre its window off the edge of it. A display enumeration that never ends
 * hangs the loop that walks it. A key state that changes when nothing pressed a
 * key makes a program act on input that never happened. So the rule here is
 * that everything is derived from one configured screen, enumeration
 * terminates, and input reports nothing rather than something invented -- the
 * input layer is a stub in this build, and saying "no key is down" is true.
 */

import { formatToString, varargsSlots } from '../msvcrt/format.js';
import {
    ANSI_PAGE, LANGID_EN_US, OEM_PAGE, mapCaseAnsi, transcodeSingleByte,
} from '../kernel32/locale.js';
import { RT_GROUP_CURSOR, RT_GROUP_ICON, loadResourceObject } from './objects.js';
import { codeForScan, codeForVk, keyFor } from './keys.js';
import { REFRESH_HZ, displayModes } from './display.js';
import {
    BORDER, CAPTION_HEIGHT, SCROLLBAR, SIZE_FRAME, WS_CHILD, WS_VISIBLE, frameOf,
} from './frame.js';
import {
    DEVMODEA,
    DISPLAY_DEVICEA,
    DISPLAY_DEVICEW,
    DISPLAY_DEVICE_CHARS,
    DM_BITSPERPEL,
    DM_DISPLAYFREQUENCY,
    DM_PELSHEIGHT,
    DM_PELSWIDTH,
    MONITORINFO,
    WINDOWINFO,
    WINDOWPLACEMENT,
    readRect,
    writeRect,
    writeU16,
    writeU32s,
} from './structs.js';

/** GetSystemMetrics indices this build has a real answer for. */
/** How many argument slots a `va_list` is read for, since it carries no count. */
const VA_LIST_SLOTS = 64;

const SM_CXSCREEN = 0;
const SM_CYSCREEN = 1;
const SM_CXVSCROLL = 2;
const SM_CYHSCROLL = 3;
const SM_CYCAPTION = 4;
const SM_CXBORDER = 5;
const SM_CYBORDER = 6;
const SM_CXFIXEDFRAME = 7;
const SM_CYFIXEDFRAME = 8;
const SM_CYMENU = 15;
const SM_CXFULLSCREEN = 16;
const SM_CYFULLSCREEN = 17;
const SM_CXSIZEFRAME = 32;
const SM_CYSIZEFRAME = 33;
const SM_CMONITORS = 80;
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;

/** A menu bar's height; the rest of the frame is the window geometry's. */
const MENU_HEIGHT = 19;

/**
 * The system colours, as a program reads them: COLORREF, 0x00BBGGRR. The
 * classic scheme, and also what the window manager paints from, so a
 * program that reads them draws in the same colours as its frame.
 *
 * @type {Record<number, number>}
 */
export const SYS_COLORS = Object.freeze({
    0: 0x00c0c0c0,
    1: 0x00808080,
    2: 0x00800000,
    3: 0x00808080,
    4: 0x00c0c0c0,
    5: 0x00ffffff,
    6: 0x00000000,
    7: 0x00000000,
    8: 0x00000000,
    9: 0x00ffffff,
    10: 0x00c0c0c0,
    11: 0x00c0c0c0,
    12: 0x00808080,
    13: 0x00800000,
    14: 0x00ffffff,
    15: 0x00c0c0c0,
    16: 0x00808080,
    17: 0x00808080,
    18: 0x00000000,
    19: 0x00c0c0c0,
    20: 0x00ffffff,
    21: 0x00000000,
    22: 0x00c0c0c0,
    23: 0x00000000,
    24: 0x00e1ffff,
});

/** MonitorFromRect and friends answer with this, there being one display. */
const PRIMARY_MONITOR = 0x00010001;
const MONITORINFOF_PRIMARY = 1;

/**
 * EnumDisplayDevices' state bits: the device carries the desktop, it is the
 * one the desktop is carried on, and it is in use.
 */
const DISPLAY_DEVICE_ATTACHED_TO_DESKTOP = 0x00000001;
const DISPLAY_DEVICE_PRIMARY_DEVICE = 0x00000004;
const DISPLAY_DEVICE_ACTIVE = 0x20000000;

/**
 * The one adapter's name, spelled the way the drawing layer's adapter
 * identifier spells it too: a program told the name here and the name there
 * has to be told the same one twice, or the two halves of its display do not
 * meet.
 */
const DISPLAY_ADAPTER_NAME = '\\\\.\\DISPLAY1';

/**
 * The identity a monitor that never reported one is listed under: the class
 * every monitor belongs to and an instance of zero. It is longer than the
 * name field and shorter than the identity field, which is where it goes.
 */
const DEFAULT_MONITOR_ID = 'MONITOR\\DEFAULT\\{4d36e96e-e325-11ce-bfc1-08002be10318}\\0000';

/**
 * SendInput's contract: one INPUT per event, 28 bytes on 32-bit Windows --
 * a type, then the union of every event kind laid out at its widest.
 */
const INPUT_SIZE = 28;
const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;
const INPUT_HARDWARE = 2;
const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const MOUSEEVENTF_MIDDLEDOWN = 0x0020;
const MOUSEEVENTF_MIDDLEUP = 0x0040;
const MOUSEEVENTF_XDOWN = 0x0080;
const MOUSEEVENTF_XUP = 0x0100;
const MOUSEEVENTF_WHEEL = 0x0800;
const MOUSEEVENTF_ABSOLUTE = 0x8000;
/** KEYBDINPUT.dwFlags: what wVk/wScan mean and which half of a press this is. */
const KEYEVENTF_EXTENDEDKEY = 0x0001;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;
const KEYEVENTF_SCANCODE = 0x0008;
const ERROR_INVALID_PARAMETER = 87;

/**
 * The one input locale this build has: en-US, low word the language id, high
 * word the device handle -- equal to the language id for the default layout,
 * which is the only kind an engine with one keyboard layout ever has.
 */
const HKL_EN_US = (LANGID_EN_US << 16 | LANGID_EN_US) >>> 0;

/**
 * The character each key answers with, unshifted and shifted, for the one US
 * layout this build has. A letter key is not here: its case comes from
 * shift XOR caps lock rather than a fixed pair, computed where it is used.
 * A key absent from this table has no character, same as the real call
 * answers for one that does not produce one -- an arrow, a function key.
 *
 * @type {Readonly<Record<number, readonly [string, string]>>}
 */
const CHAR_TABLE = Object.freeze({
    0x30: ['0', ')'], 0x31: ['1', '!'], 0x32: ['2', '@'], 0x33: ['3', '#'],
    0x34: ['4', '$'], 0x35: ['5', '%'], 0x36: ['6', '^'], 0x37: ['7', '&'],
    0x38: ['8', '*'], 0x39: ['9', '('],
    0x20: [' ', ' '],
    0xbd: ['-', '_'], 0xbb: ['=', '+'],
    0xdb: ['[', '{'], 0xdd: [']', '}'], 0xdc: ['\\', '|'],
    0xba: [';', ':'], 0xde: ["'", '"'], 0xc0: ['`', '~'],
    0xbc: [',', '<'], 0xbe: ['.', '>'], 0xbf: ['/', '?'],
});

/**
 * A letter key's character, without a keyboard state: what MapVirtualKeyA's
 * MAPVK_VK_TO_CHAR answers, which never sees shift or caps lock and so has no
 * "unshifted" concept for a letter beyond the key's own code -- uppercase,
 * because a virtual key for a letter already is the uppercase ASCII value.
 *
 * @param {number} vk
 * @returns {string | null}
 */
function baseCharForVk(vk){
    if (vk >= 0x41 && vk <= 0x5a)
    {
        return String.fromCharCode(vk);
    }
    return CHAR_TABLE[vk]?.[0] ?? null;
}

/**
 * A key's character with a keyboard state applied: shift and caps lock flip a
 * letter's case (caps lock without shift still uppercases; both together
 * lowercase, same as a real keyboard), and shift alone picks a symbol key's
 * upper row -- what ToUnicode answers.
 *
 * @param {number} vk @param {boolean} shiftDown @param {boolean} capsLockOn
 * @returns {string | null}
 */
function charForKeyState(vk, shiftDown, capsLockOn){
    if (vk >= 0x41 && vk <= 0x5a)
    {
        return String.fromCharCode(shiftDown !== capsLockOn ? vk : vk + 0x20);
    }
    return CHAR_TABLE[vk]?.[shiftDown ? 1 : 0] ?? null;
}

const MAPVK_VK_TO_VSC = 0;
const MAPVK_VSC_TO_VK = 1;
const MAPVK_VK_TO_CHAR = 2;
const MAPVK_VSC_TO_VK_EX = 3;

/** @param {number} vk @returns {import('./keys.js').KeyMapping | null} */
function mappingForVk(vk){
    const physical = codeForVk(vk);
    return physical ? keyFor(physical) : null;
}

/** @param {number} scan @returns {import('./keys.js').KeyMapping | null} */
function mappingForScan(scan){
    const physical = codeForScan(scan, false);
    return physical ? keyFor(physical) : null;
}

/**
 * MapVirtualKeyA/MapVirtualKeyExA's four translations, over `keys.js`'s
 * physical-key table: never a second copy of what already maps a browser key
 * to a scan code and virtual key for `input`'s router.
 *
 * @param {number} code @param {number} mapType
 * @returns {number}
 */
function mapVirtualKey(code, mapType){
    switch (mapType)
    {
        case MAPVK_VK_TO_VSC: {
            const mapping = mappingForVk(code);
            return mapping ? mapping.scan : 0;
        }
        case MAPVK_VSC_TO_VK: {
            const mapping = mappingForScan(code & 0xff);
            return mapping ? mapping.vk : 0;
        }
        case MAPVK_VK_TO_CHAR: {
            const char = baseCharForVk(code);
            return char ? char.charCodeAt(0) : 0;
        }
        case MAPVK_VSC_TO_VK_EX: {
            const mapping = mappingForScan(code & 0xff);
            return mapping ? mapping.vkSide : 0;
        }
        default:
            return 0;
    }
}

/** GetWindow's relations. */
const GW_HWNDFIRST = 0;
const GW_HWNDLAST = 1;
const GW_HWNDNEXT = 2;
const GW_HWNDPREV = 3;
const GW_OWNER = 4;
const GW_CHILD = 5;

/**
 * GetClassLong / SetClassLong indices. They are negative for the same reason
 * the window ones are: a non-negative index addresses the class extra bytes,
 * and a named field has to sit somewhere no offset can reach.
 */
const GCL_MENUNAME = -8;
const GCL_HBRBACKGROUND = -10;
const GCL_HCURSOR = -12;
const GCL_HICON = -14;
const GCL_HMODULE = -16;
const GCL_CBWNDEXTRA = -18;
const GCL_CBCLSEXTRA = -20;
const GCL_WNDPROC = -24;
const GCL_STYLE = -26;
const GCW_ATOM = -32;
const GCL_HICONSM = -34;

/** The style bit EnableWindow sets, and the only one it touches. */
const WS_DISABLED = 0x08000000;
const WS_MINIMIZE = 0x20000000;

/** A class or window name is at most this long. */
const MAX_NAME = 256;

/** ChangeDisplaySettings' answers: switched, or no such mode. */
const DISP_CHANGE_SUCCESSFUL = 0;
const DISP_CHANGE_BADMODE = -2;
/** ChangeDisplaySettings' flag that asks whether a mode could be set, without setting it. */
const CDS_TEST = 0x2;

/** The refresh rate reported for the one mode this build offers. */

/** EnumDisplaySettings' named indices: the mode in effect, and the registry's. */
const ENUM_CURRENT_SETTINGS = -1;
const ENUM_REGISTRY_SETTINGS = -2;

/** DdeInitialize's answer when the exchange cannot be set up at all. */
const DMLERR_SYS_ERROR = 0x400f;
/** DdeGetLastError with no instance to report on: nothing has gone wrong in it. */
const DMLERR_NO_ERROR = 0;

/** Where RegisterWindowMessage numbers start: 0xc000 to 0xffff is theirs. */
const REGISTERED_MESSAGE_FIRST = 0xc000;

/** RegisterHotKey's failure codes, which a caller reads with GetLastError. */
const ERROR_HOTKEY_ALREADY_REGISTERED = 1409;
const ERROR_HOTKEY_NOT_REGISTERED = 1410;

/** The one deferred-placement batch there ever is, as the handle a caller holds. */
const DEFER_TOKEN = 0x4d50;

/** The button identifiers a message box answers with, as Windows numbers them. */
const IDOK = 1, IDCANCEL = 2, IDABORT = 3, IDRETRY = 4, IDIGNORE = 5;
const IDYES = 6, IDNO = 7, IDTRYAGAIN = 10, IDCONTINUE = 11;

/**
 * The buttons each message-box type asks for, by `uType & 0xf`, in the order
 * Windows lays them out -- which is also the order MB_DEFBUTTON counts in.
 * The seventh entry is MB_CANCELTRYCONTINUE, whose identifiers sit at 2, 10
 * and 11 rather than in a run.
 */
const MESSAGE_BOX_SETS = [
    [{ id: IDOK, label: 'OK' }],
    [{ id: IDOK, label: 'OK' }, { id: IDCANCEL, label: 'Cancel' }],
    [{ id: IDABORT, label: 'Abort' }, { id: IDRETRY, label: 'Retry' },
        { id: IDIGNORE, label: 'Ignore' }],
    [{ id: IDYES, label: 'Yes' }, { id: IDNO, label: 'No' },
        { id: IDCANCEL, label: 'Cancel' }],
    [{ id: IDYES, label: 'Yes' }, { id: IDNO, label: 'No' }],
    [{ id: IDRETRY, label: 'Retry' }, { id: IDCANCEL, label: 'Cancel' }],
    [{ id: IDCANCEL, label: 'Cancel' }, { id: IDTRYAGAIN, label: 'Try Again' },
        { id: IDCONTINUE, label: 'Continue' }],
];

/**
 * The icon a message-box type asks for, as a name the page can draw. The
 * four documented kinds share their low nibble with aliases -- 0x10 is an
 * error, a hand or a stop -- so the nibble is what identifies them.
 *
 * @param {number} type
 * @returns {string | null}
 */
const messageBoxIcon = type=>{
    switch (type & 0xf0)
    {
        case 0x10: return 'error';
        case 0x20: return 'question';
        case 0x30: return 'warning';
        case 0x40: return 'information';
        case 0x80: return 'user';
        default: return null;
    }
};

/**
 * The buttons a message box shows, as a fresh list the caller may keep: the
 * page is handed the same shape it would render, and the engine's own table
 * must not be a page's to write into.
 *
 * @param {number} type
 */
const messageBoxButtons = type=>(MESSAGE_BOX_SETS[type & 0xf] ?? MESSAGE_BOX_SETS[0])
    .map(button=>({ id: button.id, label: button.label }));

/**
 * The button a message box answers with when nobody is there to press one:
 * the default of the set its type asks for, which is the first button of the
 * set unless MB_DEFBUTTON2, 3 or 4 moves it along.
 *
 * The answer has to be a button the box shows. A value outside the set is one
 * the caller's own switch has no arm for, and a program that falls through
 * every case then waits for a click the answer said had already happened.
 *
 * @param {number} type  The uType of MessageBoxA.
 */
const messageBoxDefault = type=>{
    const buttons = MESSAGE_BOX_SETS[type & 0xf] ?? MESSAGE_BOX_SETS[0];
    return buttons[Math.min((type & 0x300) >> 8, buttons.length - 1)].id;
};

/**
 * Builds the system-query half of user32, over the window records the
 * bookkeeping half keeps.
 *
 * @param {Object} options
 * @param {any} options.host
 * @param {(hwnd: number) => any | null} options.live
 * @param {Map<number, any>} options.windows
 * @param {Map<string, any>} options.classes  Registered classes, by name.
 */
export function createSystemFunctions({ host, live, windows, classes }){
    // Ids handed to a timer with no window, kept clear of the small numbers a
    // program picks for its own.
    let nextTimerId = 0x1000;
    // Names a message box for as long as it is up, so the page can answer the
    // one it was shown rather than whichever box is standing now.
    let nextMessageBoxId = 1;
    /** The cursor SetCursor last set; nothing draws it, but it is read back. */
    let currentCursor = 0;
    /** ShowCursor's display count: the cursor is shown while it is not below zero. */
    let cursorShowCount = 0;
    /** Whether SetCursor named the null cursor, which hides it whatever the count says. */
    let cursorIsNull = false;
    /** The last picture handed up, so only a change is ever reported. */
    let cursorShown = true;

    /**
     * The cursor as the page should show it, derived from the two facts Windows
     * keeps it from: the display count and the current cursor. Reported only on
     * a change of that picture -- a program hides the cursor inside its frame
     * loop, and a per-call report buries the one event that arms the pointer
     * lock. The bitmap is not decoded, so a report carries no image: this is
     * what the Direct3D path sends when a device cursor was never given one.
     * Where both producers speak -- a title that draws a device cursor and also
     * calls ShowCursor -- the last report wins.
     */
    const reportCursor = ()=>{
        const shown = cursorShowCount >= 0 && !cursorIsNull;
        if (shown === cursorShown)
        {
            return;
        }
        cursorShown = shown;
        host.reportCursor?.({ shown });
    };

    /**
     * What SendMessage does, shared with the timed form.
     *
     * @param {number} hwnd @param {number} message @param {number} wParam
     * @param {number} lParam
     */
    const sendMessage = (hwnd, message, wParam, lParam)=>
        host.send(hwnd >>> 0, message >>> 0, wParam >>> 0, lParam >>> 0, host.callerThread?.());

    const screen = host.screen ?? { width: 640, height: 480, bitsPerPixel: 32 };

    /**
     * Messages registered by name, in the range Windows keeps for them. The
     * same name answers the same number for the life of the process, which is
     * how two windows that never met agree on a message; case does not matter,
     * as it does not for any other name the window manager keeps.
     *
     * @type {Map<string, number>}
     */
    const registeredMessages = new Map();

    /**
     * SetWindowPos, shared with the deferred form. The two flags that say
     * "ignore what I passed" are the whole of the behaviour worth having: a
     * program moves without resizing and resizes without moving by setting
     * them, and honouring the arguments anyway would put the window somewhere
     * it never asked for.
     *
     * @param {number[]} args  hWnd, hWndInsertAfter, X, Y, cx, cy, uFlags.
     */
    const setWindowPos = ([hwnd, after, x, y, cx, cy, flags])=>{
        const SWP_NOSIZE = 0x0001;
        const SWP_NOMOVE = 0x0002;
        const SWP_NOZORDER = 0x0004;
        const SWP_SHOWWINDOW = 0x0040;
        const SWP_HIDEWINDOW = 0x0080;
        const HWND_BOTTOM = 1;
        const record = live(hwnd);
        if (!record)
        {
            return 0;
        }
        const wasShown = host.shown(record);
        const covered = wasShown ? host.geometry.windowRect(record) : null;
        const moved = (flags & SWP_NOMOVE) === 0 && (record.x !== (x | 0) || record.y !== (y | 0));
        const sized = (flags & SWP_NOSIZE) === 0
            && (record.width !== (cx | 0) || record.height !== (cy | 0));
        if ((flags & SWP_NOMOVE) === 0)
        {
            record.x = x | 0;
            record.y = y | 0;
        }
        if ((flags & SWP_NOSIZE) === 0)
        {
            record.width = cx | 0;
            record.height = cy | 0;
        }
        if ((flags & SWP_SHOWWINDOW) !== 0)
        {
            record.style = (record.style | WS_VISIBLE) >>> 0;
        }
        else if ((flags & SWP_HIDEWINDOW) !== 0)
        {
            record.style = (record.style & ~WS_VISIBLE) >>> 0;
        }
        if ((flags & SWP_NOZORDER) === 0 && (after | 0) !== HWND_BOTTOM
            && (record.style & WS_CHILD) === 0)
        {
            host.raise(record);
        }
        const isShown = host.shown(record);
        if (covered && (!isShown || moved || sized))
        {
            host.uncover(covered);
        }
        if (isShown && (!wasShown || moved || sized))
        {
            host.appear(record);
        }
        return 1;
    };

    /** Windows in creation order, which is the only order this build has. */
    const ordered = ()=>[...windows.values()].filter(record=>!record.destroyed);

    /**
     * The bytes of a terminated string, terminator excluded, read a piece at
     * a time so a long one is not read whole and a short one is not read past.
     *
     * @param {number} address
     */
    const readStringBytes = address=>{
        const STEP = 64;
        const LIMIT = 0x10000;
        /** @type {Uint8Array[]} */
        const pieces = [];
        for (let at = 0; at < LIMIT; at += STEP)
        {
            const piece = host.readMemory(address + at, STEP);
            const end = piece.indexOf(0);
            if (end >= 0)
            {
                pieces.push(piece.subarray(0, end));
                break;
            }
            pieces.push(piece);
        }
        const bytes = new Uint8Array(pieces.reduce((sum, piece)=>sum + piece.length, 0));
        let at = 0;
        for (const piece of pieces)
        {
            bytes.set(piece, at);
            at += piece.length;
        }
        return bytes;
    };

    /** @param {boolean} upper */
    const caseOfString = upper=>({
        argBytes: 4,
        /** @param {number[]} args */
        handler: ([text])=>{
            const at = text >>> 0;
            if (at === 0)
            {
                return 0;
            }
            if ((at & 0xffff0000) === 0)
            {
                return mapCaseAnsi(new Uint8Array([at & 0xff]), upper)[0];
            }
            host.writeMemory(at, mapCaseAnsi(readStringBytes(at), upper));
            return at;
        },
    });

    /** @param {boolean} upper */
    const caseOfBuffer = upper=>({
        argBytes: 8,
        /** @param {number[]} args */
        handler: ([text, count])=>{
            const at = text >>> 0;
            const length = count >>> 0;
            if (at === 0 || length === 0)
            {
                return 0;
            }
            host.writeMemory(at, mapCaseAnsi(host.readMemory(at, length), upper));
            return length;
        },
    });

    /** @param {number} hwnd @returns {any | null} the class a window was made from */
    const classOfWindow = hwnd=>{
        const record = live(hwnd);
        return record ? classes.get(record.className) ?? null : null;
    };

    /** @param {any} cls @param {number} index */
    const readClassLong = (cls, index)=>{
        switch (index | 0){
            case GCL_STYLE:
                return cls.style;
            case GCL_WNDPROC:
                return cls.wndProc;
            case GCL_CBCLSEXTRA:
                return cls.classExtra;
            case GCL_CBWNDEXTRA:
                return cls.windowExtra;
            case GCL_HMODULE:
                return cls.instance;
            case GCL_HICON:
                return cls.icon;
            case GCL_HICONSM:
                return cls.iconSm;
            case GCL_HCURSOR:
                return cls.cursor;
            case GCL_HBRBACKGROUND:
                return cls.background;
            case GCL_MENUNAME:
                return cls.menuName;
            case GCW_ATOM:
                return cls.atom;
            default:
                break;
        }
        const at = index | 0;
        // Class extra bytes are storage the class asked for. Reading outside
        // them would be reading whatever happens to follow in our own record.
        cls.extra ??= new DataView(new ArrayBuffer(Math.max(cls.classExtra, 0)));
        return at >= 0 && at + 4 <= cls.extra.byteLength ? cls.extra.getUint32(at, true) : 0;
    };

    /** @param {any} cls @param {number} index @param {number} value */
    const writeClassLong = (cls, index, value)=>{
        switch (index | 0){
            case GCL_STYLE:
                cls.style = value >>> 0;
                return;
            case GCL_WNDPROC:
                cls.wndProc = value >>> 0;
                return;
            case GCL_HICON:
                cls.icon = value >>> 0;
                return;
            case GCL_HICONSM:
                cls.iconSm = value >>> 0;
                return;
            case GCL_HCURSOR:
                cls.cursor = value >>> 0;
                return;
            case GCL_HBRBACKGROUND:
                cls.background = value >>> 0;
                return;
            case GCL_MENUNAME:
                cls.menuName = value >>> 0;
                return;
            case GCL_HMODULE:
                cls.instance = value >>> 0;
                return;
            default:
                break;
        }
        const at = index | 0;
        cls.extra ??= new DataView(new ArrayBuffer(Math.max(cls.classExtra, 0)));
        if (at >= 0 && at + 4 <= cls.extra.byteLength)
        {
            cls.extra.setUint32(at, value >>> 0, true);
        }
    };

    /**
     * A terminated UTF-16 string, read a piece at a time like the byte one.
     *
     * @param {number} address
     */
    const readWideString = address=>{
        const STEP = 128;
        const LIMIT = 0x20000;
        let text = '';
        for (let at = 0; at < LIMIT; at += STEP)
        {
            const piece = host.readMemory(address + at, STEP);
            for (let i = 0; i + 1 < piece.length; i += 2)
            {
                const code = piece[i] | piece[i + 1] << 8;
                if (code === 0)
                {
                    return text;
                }
                text += String.fromCharCode(code);
            }
        }
        return text;
    };

    /** @param {number} address @param {string} text @param {number} limit */
    const writeWideString = (address, text, limit)=>{
        const clipped = limit > 0 ? text.slice(0, limit - 1) : '';
        const bytes = new Uint8Array((clipped.length + 1) * 2);
        for (let index = 0; index < clipped.length; index++)
        {
            const code = clipped.charCodeAt(index);
            bytes[index * 2] = code & 0xff;
            bytes[index * 2 + 1] = code >>> 8;
        }
        host.writeMemory(address, bytes);
        return clipped.length;
    };

    /** @param {number} address @param {string} text @param {number} limit */
    const writeString = (address, text, limit)=>{
        const clipped = limit > 0 ? text.slice(0, limit - 1) : '';
        const bytes = new Uint8Array(clipped.length + 1);
        for (let index = 0; index < clipped.length; index++)
        {
            bytes[index] = clipped.charCodeAt(index) & 0xff;
        }
        host.writeMemory(address, bytes);
        return clipped.length;
    };

    /**
     * Puts a message box up and answers with the button pressed.
     *
     * Windows keeps the calling thread inside MessageBox until a button is
     * pressed. Here the page is the only thing that can press one, so the
     * sentence goes up as an event carrying the buttons, the default and an
     * id, and what comes back is either the id of the button the page answered
     * with or -- when nothing is listening -- the box's own default. A promise
     * is what the engine hands back when a page is listening, and the bridge
     * parks the caller on it: the rest of the program keeps pumping while the
     * box is up, which is what a program that shows one and waits expects.
     *
     * The text is written to the log as well, because a message box is a
     * program explaining in its own words why it is about to stop -- the most
     * useful sentence it will ever say -- and a line in a log is where such a
     * sentence goes to be missed.
     *
     * @param {string} body @param {string} title @param {number} type @param {number} id
     */
    const showMessageBox = (body, title, type, id)=>{
        const answer = host.messageBox?.({
            id,
            text: body,
            caption: title,
            type,
            buttons: messageBoxButtons(type),
            defaultButton: messageBoxDefault(type),
            icon: messageBoxIcon(type),
        });
        host.say?.(title.length > 0 ? `${title}: ${body}` : body);
        return answer === undefined || answer === null ? messageBoxDefault(type) : answer;
    };

    /** @param {number} address */
    const readU32 = address=>{
        const bytes = host.readMemory(address, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };

    /** @param {number} address */
    const readU16 = address=>{
        const bytes = host.readMemory(address, 2);
        return (bytes[0] | bytes[1] << 8) >>> 0;
    };

    /** @param {number} address */
    const readI32 = address=>readU32(address) | 0;

    /**
     * One INPUT_MOUSE event, turned into the pointer events the input layer
     * takes.
     *
     * The flags are a bitmask, not a choice: a single event may carry a move
     * and a button at once, and every bit present is an event Windows inserts.
     * A relative move is pixels; an absolute one is the position normalised to
     * 0..65535 across the display, which is the only coordinate space the call
     * has, so it is scaled onto the screen here.
     *
     * @param {number} at  Where the INPUT begins.
     * @returns {boolean} whether anything was inserted.
     */
    const injectMouse = at=>{
        const flags = readU32(at + 16);
        const data = readU32(at + 12);
        let inserted = false;

        if ((flags & MOUSEEVENTF_MOVE) !== 0)
        {
            /** @type {{ kind: string, dx?: number, dy?: number,
             *           x?: number, y?: number }} */
            const move = { kind: 'pointerMove' };
            if ((flags & MOUSEEVENTF_ABSOLUTE) !== 0)
            {
                move.x = Math.round(readI32(at + 4) * (screen.width - 1) / 65535);
                move.y = Math.round(readI32(at + 8) * (screen.height - 1) / 65535);
            }
            else
            {
                move.dx = readI32(at + 4);
                move.dy = readI32(at + 8);
            }
            host.sendInput?.(move);
            inserted = true;
        }

        /** @type {[number, string, boolean][]} */
        const presses = [
            [MOUSEEVENTF_LEFTDOWN, 'left', true], [MOUSEEVENTF_LEFTUP, 'left', false],
            [MOUSEEVENTF_RIGHTDOWN, 'right', true], [MOUSEEVENTF_RIGHTUP, 'right', false],
            [MOUSEEVENTF_MIDDLEDOWN, 'middle', true], [MOUSEEVENTF_MIDDLEUP, 'middle', false],
        ];
        for (const [flag, button, down] of presses)
        {
            if ((flags & flag) !== 0)
            {
                host.sendInput?.({ kind: 'pointerButton', button, down });
                inserted = true;
            }
        }
        // The two extra buttons share a flag pair and name themselves in the
        // high word of mouseData, as the real struct does.
        const extra = data >>> 16;
        if ((flags & MOUSEEVENTF_XDOWN) !== 0)
        {
            host.sendInput?.({ kind: 'pointerButton',
                button: extra === 2 ? 'x2' : 'x1', down: true });
            inserted = true;
        }
        if ((flags & MOUSEEVENTF_XUP) !== 0)
        {
            host.sendInput?.({ kind: 'pointerButton',
                button: extra === 2 ? 'x2' : 'x1', down: false });
            inserted = true;
        }
        if ((flags & MOUSEEVENTF_WHEEL) !== 0)
        {
            // mouseData is the wheel delta itself, in WHEEL_DELTA (120) units,
            // which is what both the message and DirectInput carry.
            host.sendInput?.({ kind: 'wheel', delta: readI32(at + 12) });
            inserted = true;
        }
        return inserted;
    };

    /**
     * One INPUT_KEYBOARD event, turned into the same key press the input
     * router builds from a real one -- WM_KEYDOWN/WM_KEYUP, the key table
     * GetKeyState and GetAsyncKeyState read, and DirectInput's array.
     *
     * `wScan`/`KEYEVENTF_SCANCODE` and `wVk` are the two ways a caller names
     * the key; the router resolves either back to the physical key it names,
     * because that is where the table naming physical keys already lives.
     * `KEYEVENTF_UNICODE` names no physical key at all -- Windows synthesises
     * VK_PACKET and lets TranslateMessage alone turn it into WM_CHAR, so only
     * the down half of such a pair produces anything here.
     *
     * @param {number} at  Where the INPUT begins.
     * @returns {boolean} whether anything was inserted.
     */
    const injectKeyboard = at=>{
        const wVk = readU16(at + 4);
        const wScan = readU16(at + 6);
        const flags = readU32(at + 8);
        const up = (flags & KEYEVENTF_KEYUP) !== 0;

        if ((flags & KEYEVENTF_UNICODE) !== 0)
        {
            if (!up)
            {
                host.sendInput?.({ kind: 'text', text: String.fromCharCode(wScan) });
            }
            return true;
        }

        const extended = (flags & KEYEVENTF_EXTENDEDKEY) !== 0;
        const named = (flags & KEYEVENTF_SCANCODE) !== 0
            ? { scan: wScan, extended }
            : { vk: wVk };
        host.sendInput?.({ kind: 'key', ...named, down: !up });
        return true;
    };

    /**
     * The one implementation both ChangeDisplaySettings entry points call.
     *
     * Every mode EnumDisplaySettings lists can be set, and setting one moves
     * the screen: the metrics, the desktop rectangle and the modes a device
     * is offered all follow, as they do when a Direct3D device is created at
     * a size. A mode the list does not carry is refused, because a switch
     * reported and not made would have every later metric disagree with what
     * the program believes. A field the caller did not name keeps its value;
     * the refresh rate is accepted as asked, since a browser presents at its
     * own pace whatever the mode says.
     *
     * @param {number} devMode
     * @param {number} flags
     */
    const changeDisplaySettings = (devMode, flags)=>{
        const display = /** @type {{ displayWidth?: number, displayHeight?: number }} */ (screen);
        if ((devMode >>> 0) === 0)
        {
            // A null mode means "go back to what the registry says": the
            // display's own size, which is where the launch put the screen.
            if ((flags & CDS_TEST) === 0)
            {
                screen.width = display.displayWidth ?? screen.width;
                screen.height = display.displayHeight ?? screen.height;
            }
            return DISP_CHANGE_SUCCESSFUL;
        }
        const named = readU32(devMode + DEVMODEA.dmFields);
        const width = (named & DM_PELSWIDTH) !== 0
            ? readU32(devMode + DEVMODEA.dmPelsWidth) : screen.width;
        const height = (named & DM_PELSHEIGHT) !== 0
            ? readU32(devMode + DEVMODEA.dmPelsHeight) : screen.height;
        // The depth as well, when the caller named one. A program that walks
        // its own list of modes takes the first this accepts as the depth of
        // the display, and accepting a sixteen-bit request for a thirty-two-bit
        // screen makes every surface it creates after sixteen bits deep.
        const bits = (named & DM_BITSPERPEL) !== 0
            ? readU32(devMode + DEVMODEA.dmBitsPerPel) : screen.bitsPerPixel;
        const offered = displayModes(screen).some(mode=>
            mode.width === width && mode.height === height && mode.bitsPerPixel === bits);
        if (!offered)
        {
            return DISP_CHANGE_BADMODE;
        }
        if ((flags & CDS_TEST) === 0)
        {
            screen.width = width;
            screen.height = height;
        }
        return DISP_CHANGE_SUCCESSFUL;
    };

    /**
     * The one implementation both EnumDisplayDevices spellings call.
     *
     * There is one display: asked for the devices with no name, the adapter it
     * is on answers at index zero and nothing answers at any other index;
     * asked for what hangs off a name, only the adapter's own name answers,
     * with the monitor. The name given out is the one EnumDisplaySettings
     * takes -- the pair is how a program walks from "there is a display" to
     * the list of modes it offers, and a program refused the walk builds its
     * resolution menu from a table of its own that no display was ever asked
     * about.
     *
     * Every string field is written to its full length, zeros and all: the
     * buffer is the caller's own stack, and a field written only as far as its
     * text reaches leaves the rest as it was -- a program reading the state
     * word of a structure nobody filled reads an answer out of the stack.
     *
     * @param {string | null} device The adapter asked about, or null for the adapters.
     * @param {number} index Which device of the kind asked for.
     * @param {number} out Where the caller's DISPLAY_DEVICE is.
     * @param {boolean} wide Whether it is the wide structure.
     */
    const enumDisplayDevices = (device, index, out, wide)=>{
        const layout = wide ? DISPLAY_DEVICEW : DISPLAY_DEVICEA;
        if ((out >>> 0) === 0 || readU32(out + layout.cb) < layout.SIZE)
        {
            return 0;
        }
        const adapter = device === null;
        const named = device !== null && device.toUpperCase() === DISPLAY_ADAPTER_NAME;
        if ((index >>> 0) !== 0 || (!adapter && !named))
        {
            return 0;
        }
        const who = adapter
            ? { name: DISPLAY_ADAPTER_NAME, description: 'Browser display adapter',
                flags: DISPLAY_DEVICE_ATTACHED_TO_DESKTOP | DISPLAY_DEVICE_PRIMARY_DEVICE,
                id: '' }
            : { name: '', description: 'Default Monitor',
                flags: DISPLAY_DEVICE_ATTACHED_TO_DESKTOP | DISPLAY_DEVICE_ACTIVE,
                id: DEFAULT_MONITOR_ID };
        /** @param {number} at @param {string} text @param {number} chars */
        const writeField = (at, text, chars)=>{
            const unit = wide ? 2 : 1;
            const bytes = new Uint8Array(chars * unit);
            const kept = text.slice(0, chars - 1);
            for (let char = 0; char < kept.length; char++)
            {
                const code = kept.charCodeAt(char);
                bytes[char * unit] = code & 0xff;
                if (wide)
                {
                    bytes[char * unit + 1] = (code >>> 8) & 0xff;
                }
            }
            host.writeMemory(at, bytes);
        };
        writeField(out + layout.DeviceName, who.name, DISPLAY_DEVICE_CHARS.DeviceName);
        writeField(out + layout.DeviceString, who.description, DISPLAY_DEVICE_CHARS.DeviceString);
        writeU32s(host, out + layout.StateFlags, [who.flags]);
        writeField(out + layout.DeviceID, who.id, DISPLAY_DEVICE_CHARS.DeviceID);
        writeField(out + layout.DeviceKey, '', DISPLAY_DEVICE_CHARS.DeviceKey);
        return 1;
    };

    /**
     * The one implementation both AdjustWindowRect entry points call.
     *
     * Named rather than reached through `this` from inside the table below: an
     * object literal's methods can see each other at run time but nothing can
     * check that they do, and a renamed entry point would fail at the call
     * rather than at the rename.
     *
     * @param {number} rect @param {number} style @param {number} menu
     * @param {number} exStyle
     */
    const adjustWindowRect = (rect, style, menu, exStyle)=>{
        if ((rect >>> 0) === 0)
        {
            return 0;
        }
        const bounds = readRect(host, rect);
        // Scroll bars are not counted, as documented: the client rectangle
        // a program grows here is the one inside the frame alone.
        const frame = frameOf(style >>> 0, exStyle >>> 0);
        writeRect(host, rect, {
            left: bounds.left - frame.edge,
            top: bounds.top - frame.edge - frame.caption - ((menu >>> 0) !== 0 ? MENU_HEIGHT : 0),
            right: bounds.right + frame.edge,
            bottom: bounds.bottom + frame.edge,
        });
        return 1;
    };

    /** @param {number} index */
    const metric = index=>{
        switch (index | 0){
            case SM_CXSCREEN:
            case SM_CXFULLSCREEN:
            case SM_CXVIRTUALSCREEN:
                return screen.width;
            case SM_CYSCREEN:
            case SM_CYVIRTUALSCREEN:
                return screen.height;
            // The usable height is the screen less the frame a full-screen
            // window still carries, which is what a program subtracts for.
            case SM_CYFULLSCREEN:
                return screen.height - CAPTION_HEIGHT - 2 * BORDER;
            case SM_CXBORDER:
            case SM_CYBORDER:
                return BORDER;
            case SM_CYCAPTION:
                return CAPTION_HEIGHT;
            case SM_CXFIXEDFRAME:
            case SM_CYFIXEDFRAME:
                return BORDER;
            case SM_CXSIZEFRAME:
            case SM_CYSIZEFRAME:
                return SIZE_FRAME;
            case SM_CYMENU:
                return MENU_HEIGHT;
            case SM_CXVSCROLL:
            case SM_CYHSCROLL:
                return SCROLLBAR;
            case SM_CMONITORS:
                return 1;
            default:
                return 0;
        }
    };

    /** @param {any} value @param {(answer: any) => any} then */
    const andThen = (value, then)=>(typeof value?.then === 'function'
        ? value.then(then)
        : then(value));

    /**
     * ChildWindowFromPoint, both spellings: the last-created child whose
     * rectangle holds the point, the flags deciding which are passed over.
     *
     * @param {number} parent @param {number} x @param {number} y @param {number} flags
     */
    const childFromPoint = (parent, x, y, flags)=>{
        const CWP_SKIPINVISIBLE = 0x0001;
        const CWP_SKIPDISABLED = 0x0002;
        const CWP_SKIPTRANSPARENT = 0x0004;
        const record = live(parent);
        if (!record)
        {
            return 0;
        }
        const origin = host.geometry.clientOrigin(record);
        const screenX = origin.x + (x | 0);
        const screenY = origin.y + (y | 0);
        const children = ordered().filter(child=>child.parent === record.hwnd
            && (child.style & WS_CHILD) !== 0);
        for (let index = children.length - 1; index >= 0; index--)
        {
            const child = children[index];
            const rect = host.geometry.windowRect(child);
            if (screenX < rect.left || screenX >= rect.right || screenY < rect.top
                || screenY >= rect.bottom)
            {
                continue;
            }
            if ((flags & CWP_SKIPINVISIBLE) !== 0 && (child.style & WS_VISIBLE) === 0)
            {
                continue;
            }
            if ((flags & CWP_SKIPDISABLED) !== 0 && (child.style & WS_DISABLED) !== 0)
            {
                continue;
            }
            if ((flags & CWP_SKIPTRANSPARENT) !== 0
                && host.windowFromPoint(screenX, screenY, { disabled: false, transparent: true })
                    ?.record !== child)
            {
                continue;
            }
            return child.hwnd;
        }
        return record.hwnd;
    };

    return {
        /** int GetSystemMetrics(int nIndex) */
        GetSystemMetrics: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([index])=>metric(index),
        },

        /** DWORD GetSysColor(int nIndex) */
        GetSysColor: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([index])=>SYS_COLORS[index | 0] ?? 0,
        },

        /**
         * HBRUSH GetSysColorBrush(int nIndex)
         *
         * A brush GDI owns, the same one every time for a colour, which a
         * program may select and must not delete.
         */
        GetSysColorBrush: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([index])=>((index | 0) in SYS_COLORS
                ? host.sysColorBrush?.(index | 0) ?? 0
                : 0),
        },

        /**
         * BOOL SystemParametersInfoA(UINT uiAction, UINT uiParam, PVOID pvParam,
         *                            UINT fWinIni)
         *
         * Only the work area is answered, because it is the one a window uses to
         * place itself. Everything else reports failure rather than a default
         * that would contradict the screen above.
         */
        SystemParametersInfoA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([action, , value])=>{
                const SPI_GETWORKAREA = 0x0030;
                if ((action >>> 0) !== SPI_GETWORKAREA || (value >>> 0) === 0)
                {
                    return 0;
                }
                writeRect(host, value,
                    { left: 0, top: 0, right: screen.width, bottom: screen.height });
                return 1;
            },
        },

        /** HWND GetDesktopWindow(void) */
        GetDesktopWindow: {
            argBytes: 0,
            handler: ()=>0,
        },

        /** HMONITOR MonitorFromRect(LPCRECT lprc, DWORD dwFlags) */
        MonitorFromRect: {
            argBytes: 8,
            handler: ()=>PRIMARY_MONITOR,
        },

        /** HMONITOR MonitorFromWindow(HWND hwnd, DWORD dwFlags) */
        MonitorFromWindow: {
            argBytes: 8,
            handler: ()=>PRIMARY_MONITOR,
        },

        /**
         * BOOL GetMonitorInfoA(HMONITOR hMonitor, LPMONITORINFO lpmi)
         *
         * cbSize is the caller saying which structure it allocated; a size that
         * is neither of the two it may be is a caller bug, and answering FALSE is
         * how it finds out rather than by having its stack written past.
         */
        GetMonitorInfoA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([monitor, info])=>{
                if ((monitor >>> 0) !== PRIMARY_MONITOR || (info >>> 0) === 0)
                {
                    return 0;
                }
                const size = host.readMemory(info + MONITORINFO.cbSize, 4);
                const declared = (size[0] | size[1] << 8 | size[2] << 16 | size[3] << 24) >>> 0;
                if (declared < MONITORINFO.SIZE)
                {
                    return 0;
                }
                const whole = { left: 0, top: 0, right: screen.width, bottom: screen.height };
                writeRect(host, info + MONITORINFO.rcMonitor, whole);
                writeRect(host, info + MONITORINFO.rcWork, whole);
                writeU32s(host, info + MONITORINFO.dwFlags, [MONITORINFOF_PRIMARY]);
                return 1;
            },
        },

        /**
         * BOOL EnumDisplaySettingsA(LPCSTR lpszDeviceName, DWORD iModeNum,
         *                          DEVMODEA *lpDevMode)
         *
         * A caller walks the indices until one answers FALSE, and builds its
         * resolution menu from what it was given on the way; the two named
         * indices answer the mode in effect. An enumeration that never ends
         * is a hang, so the list is finite and the end is reported.
         *
         * The two named indices answer the same mode: the current settings are
         * the one mode there is, and so are the registry's. A program asks for
         * the current settings to learn the desktop's depth before it picks
         * its own, and one refused that answer settles for the shallowest
         * depth it knows -- sixteen bits, for every surface it makes after.
         */
        EnumDisplaySettingsA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([, mode, devMode])=>{
                const index = mode | 0;
                if ((devMode >>> 0) === 0)
                {
                    return 0;
                }
                const current = index === ENUM_CURRENT_SETTINGS || index === ENUM_REGISTRY_SETTINGS;
                const listed = current ? null : displayModes(screen)[index];
                if (!current && (index < 0 || !listed))
                {
                    return 0;
                }
                const answer = listed ?? { ...screen, refresh: REFRESH_HZ };
                writeU16(host, devMode + DEVMODEA.dmSize, DEVMODEA.SIZE);
                writeU16(host, devMode + DEVMODEA.dmDriverExtra, 0);
                writeU32s(host, devMode + DEVMODEA.dmFields,
                    [DM_BITSPERPEL | DM_PELSWIDTH | DM_PELSHEIGHT | DM_DISPLAYFREQUENCY]);
                writeU32s(host, devMode + DEVMODEA.dmBitsPerPel,
                    [answer.bitsPerPixel, answer.width, answer.height]);
                writeU32s(host, devMode + DEVMODEA.dmDisplayFrequency, [answer.refresh]);
                return 1;
            },
        },

        /**
         * BOOL EnumDisplayDevicesA(LPCSTR lpDevice, DWORD iDevNum,
         *                         PDISPLAY_DEVICEA lpDisplayDevice, DWORD dwFlags)
         *
         * The adapter's identity field stays empty: there is no plug-and-play
         * device behind a page, and a made-up PCI path would hand a program's
         * card database a vendor and model to key its choices by. Finding the
         * field empty, a program that wants the card's numbers asks Direct3D's
         * adapter identifier, which answers from the hardware that is there.
         */
        EnumDisplayDevicesA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([device, index, out])=>enumDisplayDevices(
                (device >>> 0) === 0 ? null : host.readCString(device >>> 0, 32),
                index >>> 0, out >>> 0, false),
        },

        /**
         * BOOL EnumDisplayDevicesW(LPCWSTR lpDevice, DWORD iDevNum,
         *                         PDISPLAY_DEVICEW lpDisplayDevice, DWORD dwFlags)
         *
         * The same enumeration with every string wide: twice the room, the
         * state word moved along with it, and the size the caller declares
         * saying which of the two structures it built.
         */
        EnumDisplayDevicesW: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([device, index, out])=>enumDisplayDevices(
                (device >>> 0) === 0 ? null : readWideString(device >>> 0),
                index >>> 0, out >>> 0, true),
        },

        /**
         * LONG ChangeDisplaySettingsExA(LPCSTR lpszDeviceName, DEVMODEA *lpDevMode,
         *                              HWND hwnd, DWORD dwflags, LPVOID lParam)
         *
         * Any listed mode can be set and the screen follows it; a mode the
         * list does not carry is refused, so a program walking its own list
         * takes the first the display actually offers.
         */
        ChangeDisplaySettingsExA: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([, devMode, , flags])=>changeDisplaySettings(devMode >>> 0, flags >>> 0),
        },

        /**
         * LONG ChangeDisplaySettingsA(DEVMODEA *lpDevMode, DWORD dwFlags)
         *
         * The older two-argument spelling of the same thing, and the one a
         * program of this era actually calls when it goes full screen. Missing
         * it is not a missing feature: an import nobody wrote gets a stub that
         * cleans up no arguments, so the caller returns with its stack eight
         * bytes adrift and dies later in a stack-cookie check, a long way from
         * anything that would explain it.
         */
        ChangeDisplaySettingsA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([devMode, flags])=>changeDisplaySettings(devMode >>> 0, flags >>> 0),
        },

        /**
         * BOOL AdjustWindowRectEx(LPRECT lpRect, DWORD dwStyle, BOOL bMenu,
         *                        DWORD dwExStyle)
         *
         * Grows a client rectangle into the window rectangle that contains it,
         * which is how a program asks for a client area of an exact size.
         */
        AdjustWindowRectEx: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([rect, style, menu, exStyle])=>
                adjustWindowRect(rect, style, menu, exStyle),
        },

        /** BOOL AdjustWindowRect(LPRECT lpRect, DWORD dwStyle, BOOL bMenu) */
        AdjustWindowRect: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([rect, style, menu])=>adjustWindowRect(rect, style, menu, 0),
        },

        /**
         * BOOL ClientToScreen(HWND hWnd, LPPOINT lpPoint)
         *
         * The client origin is inside the frame, and a child's is inside its
         * parent's: the geometry adds both up.
         */
        ClientToScreen: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, point])=>{
                const record = live(hwnd);
                if (!record || (point >>> 0) === 0)
                {
                    return 0;
                }
                const at = host.readMemory(point, 8);
                const x = (at[0] | at[1] << 8 | at[2] << 16 | at[3] << 24) | 0;
                const y = (at[4] | at[5] << 8 | at[6] << 16 | at[7] << 24) | 0;
                const origin = host.geometry.clientOrigin(record);
                writeU32s(host, point, [x + origin.x, y + origin.y]);
                return 1;
            },
        },

        /** BOOL ScreenToClient(HWND hWnd, LPPOINT lpPoint) */
        ScreenToClient: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, point])=>{
                const record = live(hwnd);
                if (!record || (point >>> 0) === 0)
                {
                    return 0;
                }
                const at = host.readMemory(point, 8);
                const x = (at[0] | at[1] << 8 | at[2] << 16 | at[3] << 24) | 0;
                const y = (at[4] | at[5] << 8 | at[6] << 16 | at[7] << 24) | 0;
                const origin = host.geometry.clientOrigin(record);
                writeU32s(host, point, [x - origin.x, y - origin.y]);
                return 1;
            },
        },

        /**
         * int MapWindowPoints(HWND hWndFrom, HWND hWndTo, LPPOINT lpPoints,
         *                    UINT cPoints)
         *
         * The return packs the offset applied: dx in the low word, dy in the
         * high one. A program uses that instead of the points when it only wants
         * the delta, so returning zero would be wrong even when the points are
         * right.
         */
        MapWindowPoints: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([from, to, points, count])=>{
                const source = live(from);
                const target = live(to);
                const fromOrigin = source ? host.geometry.clientOrigin(source) : { x: 0, y: 0 };
                const toOrigin = target ? host.geometry.clientOrigin(target) : { x: 0, y: 0 };
                const dx = fromOrigin.x - toOrigin.x;
                const dy = fromOrigin.y - toOrigin.y;
                for (let index = 0; index < (count >>> 0); index++)
                {
                    const at = points + index * 8;
                    const bytes = host.readMemory(at, 8);
                    const x = (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) | 0;
                    const y = (bytes[4] | bytes[5] << 8 | bytes[6] << 16 | bytes[7] << 24) | 0;
                    writeU32s(host, at, [x + dx, y + dy]);
                }
                return ((dy & 0xffff) << 16 | (dx & 0xffff)) >>> 0;
            },
        },

        /** HWND GetParent(HWND hWnd) */
        GetParent: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>live(hwnd)?.parent ?? 0,
        },

        /** HWND SetParent(HWND hWndChild, HWND hWndNewParent) */
        SetParent: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([child, parent])=>{
                const record = live(child);
                if (!record)
                {
                    return 0;
                }
                const previous = record.parent;
                record.parent = parent >>> 0;
                return previous;
            },
        },

        /** HWND GetWindow(HWND hWnd, UINT uCmd) */
        GetWindow: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, command])=>{
                const record = live(hwnd);
                if (!record)
                {
                    return 0;
                }
                const siblings = ordered().filter(other=>other.parent === record.parent);
                const at = siblings.indexOf(record);
                switch (command >>> 0){
                    case GW_HWNDFIRST:
                        return siblings[0]?.hwnd ?? 0;
                    case GW_HWNDLAST:
                        return siblings[siblings.length - 1]?.hwnd ?? 0;
                    case GW_HWNDNEXT:
                        return siblings[at + 1]?.hwnd ?? 0;
                    case GW_HWNDPREV:
                        return at > 0 ? siblings[at - 1].hwnd : 0;
                    case GW_CHILD:
                        return ordered().find(other=>other.parent === record.hwnd)?.hwnd ?? 0;
                    case GW_OWNER:
                        return record.parent;
                    default:
                        return 0;
                }
            },
        },

        /** BOOL GetWindowInfo(HWND hwnd, PWINDOWINFO pwi) */
        GetWindowInfo: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, info])=>{
                const record = live(hwnd);
                if (!record || (info >>> 0) === 0)
                {
                    return 0;
                }
                const frame = host.geometry.frame(record);
                writeRect(host, info + WINDOWINFO.rcWindow, host.geometry.windowRect(record));
                writeRect(host, info + WINDOWINFO.rcClient, host.geometry.clientRect(record));
                writeU32s(host, info + WINDOWINFO.dwStyle,
                    [record.style, record.exStyle, 0, frame.left, frame.top]);
                // Two WORDs share the last DWORD, so neither may be written as one.
                writeU16(host, info + WINDOWINFO.atomWindowType, 0);
                writeU16(host, info + WINDOWINFO.wCreatorVersion, 0x0400);
                return 1;
            },
        },

        /** BOOL GetWindowPlacement(HWND hWnd, WINDOWPLACEMENT *lpwndpl) */
        GetWindowPlacement: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, placement])=>{
                const record = live(hwnd);
                if (!record || (placement >>> 0) === 0)
                {
                    return 0;
                }
                const SW_SHOWNORMAL = 1;
                writeU32s(host, placement + WINDOWPLACEMENT.length,
                    [WINDOWPLACEMENT.SIZE, 0, SW_SHOWNORMAL]);
                writeU32s(host, placement + WINDOWPLACEMENT.ptMinPosition, [0, 0, 0, 0]);
                writeRect(host, placement + WINDOWPLACEMENT.rcNormalPosition, {
                    left: record.x,
                    top: record.y,
                    right: record.x + record.width,
                    bottom: record.y + record.height,
                });
                return 1;
            },
        },

        /** BOOL SetWindowPlacement(HWND hWnd, const WINDOWPLACEMENT *lpwndpl) */
        SetWindowPlacement: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, placement])=>{
                const record = live(hwnd);
                if (!record || (placement >>> 0) === 0)
                {
                    return 0;
                }
                const bounds = readRect(host, placement + WINDOWPLACEMENT.rcNormalPosition);
                record.x = bounds.left;
                record.y = bounds.top;
                record.width = bounds.right - bounds.left;
                record.height = bounds.bottom - bounds.top;
                return 1;
            },
        },

        /**
         * BOOL SetWindowPos(HWND hWnd, HWND hWndInsertAfter, int X, int Y,
         *                  int cx, int cy, UINT uFlags)
         *
         * The two flags that say "ignore what I passed" are the whole of the
         * behaviour worth having: a program moves without resizing and resizes
         * without moving by setting them, and honouring the arguments anyway
         * would put the window somewhere it never asked for.
         */
        SetWindowPos: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: args=>setWindowPos(args),
        },

        /** HWND BringWindowToTop(HWND hWnd) */
        BringWindowToTop: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>(live(hwnd) ? 1 : 0),
        },

        /** BOOL IsIconic(HWND hWnd) */
        IsIconic: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>{
                const record = live(hwnd);
                return record && (record.style & WS_MINIMIZE) !== 0 ? 1 : 0;
            },
        },

        /** BOOL IsZoomed(HWND hWnd) */
        IsZoomed: {
            argBytes: 4,
            handler: ()=>0,
        },

        /** BOOL IsWindowEnabled(HWND hWnd) */
        IsWindowEnabled: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>{
                const record = live(hwnd);
                return record && (record.style & WS_DISABLED) === 0 ? 1 : 0;
            },
        },

        /**
         * HWND WindowFromPoint(POINT Point)
         *
         * The point arrives by value, as two arguments. The window found is
         * the one the pointer would reach: shown, not disabled, and not one
         * that lets the pointer through.
         */
        WindowFromPoint: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([x, y])=>host.windowFromPoint(x | 0, y | 0)?.record.hwnd ?? 0,
        },

        /**
         * HWND ChildWindowFromPointEx(HWND hWndParent, POINT pt, UINT uFlags)
         *
         * The immediate child at a point in the parent's client area, or the
         * parent itself when no child is there. The flags choose which
         * children are passed over; CWP_ALL passes over none.
         */
        ChildWindowFromPointEx: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([parent, x, y, flags])=>childFromPoint(parent, x, y, flags),
        },

        /** HWND ChildWindowFromPoint(HWND hWndParent, POINT pt) */
        ChildWindowFromPoint: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([parent, x, y])=>childFromPoint(parent, x, y, 0),
        },

        /**
         * LPSTR CharNextA(LPCSTR lpsz)
         *
         * The next character of a string, which for the single-byte text this
         * build reads is the next byte -- except at the terminator, where the
         * answer is the terminator itself. A program walks a path with this
         * and stops when the pointer stops moving; a stub answering zero sends
         * it on to copy from address zero.
         */
        CharNextA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([text])=>{
                const at = text >>> 0;
                if (at === 0)
                {
                    return 0;
                }
                return host.readMemory(at, 1)[0] === 0 ? at : at + 1;
            },
        },

        /**
         * BOOL OemToCharBuffA(LPCSTR lpszSrc, LPSTR lpszDst, DWORD cchDstLength)
         *
         * A counted translation, not a string one: exactly cchDstLength bytes
         * are converted, terminators included, and the two buffers may be the
         * same. An archive's file names are OEM text, and this is how an
         * extractor turns them into names the file system will take.
         */
        OemToCharBuffA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([source, target, count])=>{
                host.writeMemory(target >>> 0, transcodeSingleByte(
                    host.readMemory(source >>> 0, count >>> 0), OEM_PAGE, ANSI_PAGE));
                return 1;
            },
        },

        /** BOOL CharToOemBuffA(LPCSTR lpszSrc, LPSTR lpszDst, DWORD cchDstLength) */
        CharToOemBuffA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([source, target, count])=>{
                host.writeMemory(target >>> 0, transcodeSingleByte(
                    host.readMemory(source >>> 0, count >>> 0), ANSI_PAGE, OEM_PAGE));
                return 1;
            },
        },

        /**
         * BOOL OemToCharA(LPCSTR lpszSrc, LPSTR lpszDst)
         *
         * The uncounted form: through the terminator, which travels with the
         * text. Null on either side is refused, as Windows refuses it.
         */
        OemToCharA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([source, target])=>{
                if ((source >>> 0) === 0 || (target >>> 0) === 0)
                {
                    return 0;
                }
                let length = 0;
                while (host.readMemory((source >>> 0) + length, 1)[0] !== 0)
                {
                    length++;
                }
                host.writeMemory(target >>> 0, transcodeSingleByte(
                    host.readMemory(source >>> 0, length + 1), OEM_PAGE, ANSI_PAGE));
                return 1;
            },
        },

        /**
         * LPSTR CharLowerA(LPSTR lpsz) / LPSTR CharUpperA(LPSTR lpsz)
         *
         * One argument with two meanings, told apart the way Windows tells
         * them apart: a value whose high word is zero is a single character,
         * converted and handed back as a value; anything else is a pointer to
         * a string converted in place, and the pointer is the answer.
         */
        CharLowerA: caseOfString(false),
        CharUpperA: caseOfString(true),

        /**
         * DWORD CharLowerBuffA(LPSTR lpsz, DWORD cchLength)
         * DWORD CharUpperBuffA(LPSTR lpsz, DWORD cchLength)
         *
         * A counted buffer rather than a terminated string: every one of the
         * cchLength bytes is converted, a NUL among them included, and the
         * count is the answer.
         */
        CharLowerBuffA: caseOfBuffer(false),
        CharUpperBuffA: caseOfBuffer(true),

        /**
         * LPSTR CharPrevA(LPCSTR lpszStart, LPCSTR lpszCurrent)
         *
         * The previous character, never before the start: at the start the
         * answer is the start, which is how a caller walking backwards knows
         * to stop.
         */
        CharPrevA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([start, current])=>(
                (current >>> 0) > (start >>> 0) ? (current >>> 0) - 1 : start >>> 0),
        },

        /**
         * int wsprintfA(LPSTR lpOut, LPCSTR lpFmt, ...)
         *
         * cdecl, which is the part that matters: the caller pops the arguments,
         * and the count is whatever it pushed. Declaring it stdcall would have
         * the stub pop a fixed number and leave the guest's stack wrong, with
         * the failure appearing somewhere else entirely.
         *
         * argBytes here says how many stack slots to *read*, not how many to
         * pop -- a cdecl callee pops none. It has to cover the widest format a
         * program might use, because a slot not read is a conversion that gets
         * nothing, and the format string is what decides how many are actually
         * consumed. Reading past what the caller pushed is safe for the same
         * reason: those slots are never looked at. The same over-declaration
         * under stdcall would corrupt the stack, which is why this one is
         * spelled out rather than left to look like a mistake.
         */
        wsprintfA: {
            convention: 'cdecl',
            argBytes: 8 + 4 * 32,
            /** @param {number[]} args */
            handler: args=>{
                const readString = (/** @type {number} */ address)=>
                    (address >>> 0) === 0 ? '(null)' : host.readCString(address, 0x10000);
                const text = formatToString(readString(args[1]), args.slice(2), readString);
                return writeString(args[0], text, text.length + 1);
            },
        },

        /**
         * int wsprintfW(LPWSTR lpOut, LPCWSTR lpFmt, ...)
         *
         * The wide form: the format and the output are UTF-16, `%s` takes a
         * wide string and `%S` a byte one, the reverse of the byte form.
         */
        wsprintfW: {
            convention: 'cdecl',
            argBytes: 8 + 4 * 32,
            /** @param {number[]} args */
            handler: args=>{
                const readString = (/** @type {number} */ address)=>
                    (address >>> 0) === 0 ? '(null)' : host.readCString(address, 0x10000);
                const readWide = (/** @type {number} */ address)=>
                    (address >>> 0) === 0 ? '(null)' : readWideString(address >>> 0);
                const text = formatToString(readWide(args[1]), args.slice(2), readString,
                    { readWideString: readWide, wide: true });
                return writeWideString(args[0], text, text.length + 1);
            },
        },

        /**
         * int wvsprintfA(LPSTR lpOut, LPCSTR lpFmt, va_list arglist)
         *
         * wsprintfA with its arguments already on the caller's stack and a
         * pointer to them: stdcall, because the count is fixed. The list
         * carries no length, so a window of it is read and the format decides
         * how much of that is meaningful -- and the window stops at the end of
         * its region, as `varargsSlots` explains.
         */
        wvsprintfA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([out, format, list])=>{
                const readString = (/** @type {number} */ address)=>
                    (address >>> 0) === 0 ? '(null)' : host.readCString(address, 0x10000);
                const varargs = varargsSlots(host.readMemory,
                    address=>host.regionAt?.(address) ?? null, list >>> 0, VA_LIST_SLOTS);
                const text = formatToString(readString(format), varargs, readString);
                return writeString(out, text, text.length + 1);
            },
        },

        /**
         * DWORD WaitForInputIdle(HANDLE hProcess, DWORD dwMilliseconds)
         *
         * Answers that the process is idle at once. Nothing here can tell
         * when a process it started has an empty queue, and a caller that
         * goes on to find that process's window looks for it and retries,
         * which is what it does on a machine where the wait returned early.
         */
        WaitForInputIdle: {
            argBytes: 8,
            handler: ()=>0,
        },

        /**
         * The entry points a windowing framework imports and this build has
         * nothing behind: accelerators out of resources, help, DDE packing,
         * the drawing of text this build does not draw, a session end. Each
         * pops what it was pushed and answers as the call does when the thing
         * asked for is not there; a stub popping nothing would walk the
         * caller's stack off by the width of its arguments.
         *
         * HACCEL LoadAcceleratorsA(HINSTANCE, LPCSTR)
         * BOOL UnpackDDElParam(UINT, LPARAM, PUINT_PTR, PUINT_PTR)
         * LPARAM ReuseDDElParam(LPARAM, UINT, UINT, UINT_PTR, UINT_PTR)
         * BOOL GrayStringA(HDC, HBRUSH, GRAYSTRINGPROC, LPARAM, int, int, int, int, int)
         * LONG TabbedTextOutA(HDC, int, int, LPCSTR, int, int, const INT *, int)
         * BOOL WinHelpA(HWND, LPCSTR, UINT, ULONG_PTR)
         * HWND GetNextDlgTabItem(HWND, HWND, BOOL)
         * BOOL ExitWindowsEx(UINT, DWORD)
         */
        LoadAcceleratorsA: { argBytes: 8, handler: ()=>0 },
        UnpackDDElParam: { argBytes: 16, handler: ()=>0 },
        ReuseDDElParam: { argBytes: 20, handler: ()=>0 },
        GrayStringA: { argBytes: 36, handler: ()=>0 },
        TabbedTextOutA: { argBytes: 32, handler: ()=>0 },
        WinHelpA: { argBytes: 16, handler: ()=>0 },
        GetNextDlgTabItem: { argBytes: 12, handler: ()=>0 },
        ExitWindowsEx: {
            argBytes: 8,
            handler: ()=>{
                host.divergence?.('ExitWindowsEx', 'there is no session to end');
                return 0;
            },
        },

        /**
         * The deferred window placement: a batch of SetWindowPos calls applied
         * at once. Nothing here is ever mid-paint, so each is applied as it
         * arrives and the batch handle is a token that says the batch is open.
         *
         * HDWP BeginDeferWindowPos(int nNumWindows)
         * HDWP DeferWindowPos(HDWP, HWND, HWND hWndInsertAfter, int x, int y,
         *                     int cx, int cy, UINT uFlags)
         * BOOL EndDeferWindowPos(HDWP)
         */
        BeginDeferWindowPos: { argBytes: 4, handler: ()=>DEFER_TOKEN },
        DeferWindowPos: {
            argBytes: 32,
            /** @param {number[]} args */
            handler: ([token, ...placement])=>{
                if ((token >>> 0) !== DEFER_TOKEN)
                {
                    return 0;
                }
                return setWindowPos(placement) ? DEFER_TOKEN : 0;
            },
        },
        EndDeferWindowPos: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([token])=>((token >>> 0) === DEFER_TOKEN ? 1 : 0),
        },

        /**
         * HWND GetLastActivePopup(HWND hWnd)
         *
         * The window itself when none of its popups was active last, which
         * with no popup tracking is always.
         */
        GetLastActivePopup: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>(live(hwnd) ? hwnd >>> 0 : 0),
        },

        /**
         * int SetWindowRgn(HWND hWnd, HRGN hRgn, BOOL bRedraw)
         *
         * A window shaped by a region. The shape is accepted and the region
         * becomes the system's, as documented, but nothing here clips the
         * window to it: it paints as the rectangle it always was, which is
         * reported once because a skinned setup window looks different for
         * it. Declared so the twelve bytes it was pushed are popped.
         */
        SetWindowRgn: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hwnd, hRgn])=>{
                if (!live(hwnd))
                {
                    return 0;
                }
                if ((hRgn >>> 0) !== 0)
                {
                    host.divergence?.('SetWindowRgn',
                        'a window region is accepted and the window is not clipped to it');
                }
                return 1;
            },
        },

        /** BOOL ShowOwnedPopups(HWND hWnd, BOOL fShow) */
        ShowOwnedPopups: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd])=>(live(hwnd) ? 1 : 0),
        },

        /** UINT RegisterWindowMessageA(LPCSTR lpString) */
        RegisterWindowMessageA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([name])=>{
                if ((name >>> 0) === 0)
                {
                    return 0;
                }
                const key = host.readCString(name >>> 0, MAX_NAME).toLowerCase();
                if (key.length === 0)
                {
                    return 0;
                }
                let id = registeredMessages.get(key);
                if (id === undefined)
                {
                    id = REGISTERED_MESSAGE_FIRST + registeredMessages.size;
                    registeredMessages.set(key, id);
                }
                return id;
            },
        },

        /** BOOL MessageBeep(UINT uType) */
        MessageBeep: {
            argBytes: 4,
            handler: ()=>1,
        },

        /**
         * int MessageBoxA(HWND hWnd, LPCSTR lpText, LPCSTR lpCaption, UINT uType)
         *
         * The box is modal and synchronous: this returns the identifier of the
         * button pressed and not before. The buttons, the default and the icon
         * come from uType; with nothing listening the box's own default is the
         * answer, which is what an unattended run keeps doing.
         */
        MessageBoxA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([, text, caption, type])=>{
                const body = (text >>> 0) === 0 ? '' : host.readCString(text, 0x10000);
                const title = (caption >>> 0) === 0 ? '' : host.readCString(caption, 0x1000);
                return showMessageBox(body, title, type >>> 0, nextMessageBoxId++);
            },
        },

        /**
         * int MessageBoxW(HWND hWnd, LPCWSTR lpText, LPCWSTR lpCaption, UINT uType)
         *
         * The same box with the text left as UTF-16, which is how a program
         * that compiled against the wide entry point hands it over. The two
         * differ only in how the strings are read.
         */
        MessageBoxW: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([, text, caption, type])=>
                showMessageBox(
                    (text >>> 0) === 0 ? '' : readWideString(text >>> 0),
                    (caption >>> 0) === 0 ? '' : readWideString(caption >>> 0),
                    type >>> 0, nextMessageBoxId++),
        },

        /**
         * int LoadStringA(HINSTANCE hInstance, UINT uID, LPSTR lpBuffer,
         *                int cchBufferMax)
         *
         * The string lives in the module's resource directory, in a bundle of
         * sixteen. What comes back from there is UTF-16; this is the ANSI entry
         * point, so it is narrowed here rather than anywhere further in -- the
         * wide entry point wants the same string untouched.
         *
         * A zero buffer is not an error: it asks for the string's address, and
         * a program that passes one is reading the resource in place. Nothing
         * here can give it one, so it gets a length of zero, which is what a
         * caller checks.
         */
        LoadStringA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([instance, id, buffer, size])=>{
                const text = host.loadString?.(instance >>> 0, id >>> 0) ?? null;
                if (text === null || (buffer >>> 0) === 0 || (size | 0) <= 0)
                {
                    if ((buffer >>> 0) !== 0 && (size | 0) > 0)
                    {
                        host.writeMemory(buffer, new Uint8Array(1));
                    }
                    return 0;
                }
                // The count includes the terminator, so the string itself gets
                // one fewer -- a caller sizing a buffer from the return value
                // and then reading it back would otherwise lose its last
                // character every time.
                const kept = text.slice(0, (size | 0) - 1);
                const bytes = new Uint8Array(kept.length + 1);
                for (let at = 0; at < kept.length; at++)
                {
                    bytes[at] = kept.charCodeAt(at) & 0xff;
                }
                host.writeMemory(buffer, bytes);
                return kept.length;
            },
        },

        /**
         * int LoadStringW(HINSTANCE hInstance, UINT uID, LPWSTR lpBuffer,
         *                int cchBufferMax)
         *
         * The same string, kept as the resource holds it. The count is in
         * characters in both forms, so the two differ only in how the text is
         * written out -- and a program calling this after narrowing its own
         * strings gets two bytes per character, which is what it will index by.
         */
        LoadStringW: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([instance, id, buffer, size])=>{
                const text = host.loadString?.(instance >>> 0, id >>> 0) ?? null;
                if (text === null || (buffer >>> 0) === 0 || (size | 0) <= 0)
                {
                    if ((buffer >>> 0) !== 0 && (size | 0) > 0)
                    {
                        host.writeMemory(buffer, new Uint8Array(2));
                    }
                    return 0;
                }
                const kept = text.slice(0, (size | 0) - 1);
                const bytes = new Uint8Array((kept.length + 1) * 2);
                for (let at = 0; at < kept.length; at++)
                {
                    const code = kept.charCodeAt(at);
                    bytes[at * 2] = code & 0xff;
                    bytes[at * 2 + 1] = code >> 8;
                }
                host.writeMemory(buffer, bytes);
                return kept.length;
            },
        },

        /**
         * HBITMAP LoadBitmapA(HINSTANCE hInstance, LPCSTR lpBitmapName)
         *
         * A bitmap needs the decoder LoadImage lacks too, so the answer is
         * the same null a program checks for -- declared here rather than
         * left to the missing-import stub, because that stub pops nothing
         * and this call pushes eight bytes: a program that paints its banner
         * from a bitmap was walking away with its stack eight bytes short on
         * every attempt.
         */
        LoadBitmapA: {
            argBytes: 8,
            handler: ()=>0,
        },

        /**
         * The Dynamic Data Exchange entry points an installer of the era uses
         * to talk to the program manager about its group and its icons. There
         * is no program manager to talk to: initialisation reports a system
         * error, which is the documented answer when DDE is not available, and
         * a program then skips what it would have said. Declared for the same
         * reason as LoadBitmapA: each pops what it was pushed.
         *
         * UINT DdeInitializeA(LPDWORD pidInst, PFNCALLBACK pfnCallback,
         *                     DWORD afCmd, DWORD ulRes)
         */
        DdeInitializeA: {
            argBytes: 16,
            handler: ()=>DMLERR_SYS_ERROR,
        },

        /** BOOL DdeUninitialize(DWORD idInst) */
        DdeUninitialize: {
            argBytes: 4,
            handler: ()=>1,
        },

        /** HSZ DdeCreateStringHandleA(DWORD idInst, LPCSTR psz, int iCodePage) */
        DdeCreateStringHandleA: {
            argBytes: 12,
            handler: ()=>0,
        },

        /** BOOL DdeFreeStringHandle(DWORD idInst, HSZ hsz) */
        DdeFreeStringHandle: {
            argBytes: 8,
            handler: ()=>0,
        },

        /** HDDEDATA DdeNameService(DWORD idInst, HSZ hsz1, HSZ hsz2, UINT afCmd) */
        DdeNameService: {
            argBytes: 16,
            handler: ()=>0,
        },

        /**
         * The client half: with no server to converse with, a conversation
         * never opens, a transaction yields no data, and a string handle --
         * of which none was ever created -- has no text. Each is the null
         * the documentation names for failure.
         *
         * HCONV DdeConnect(DWORD idInst, HSZ hszService, HSZ hszTopic,
         *                  PCONVCONTEXT pCC)
         */
        DdeConnect: {
            argBytes: 16,
            handler: ()=>0,
        },

        /** BOOL DdeDisconnect(HCONV hConv) */
        DdeDisconnect: {
            argBytes: 4,
            handler: ()=>0,
        },

        /**
         * HDDEDATA DdeClientTransaction(LPBYTE pData, DWORD cbData, HCONV hConv,
         *     HSZ hszItem, UINT wFmt, UINT wType, DWORD dwTimeout, LPDWORD pdwResult)
         */
        DdeClientTransaction: {
            argBytes: 32,
            handler: ()=>0,
        },

        /**
         * HDDEDATA DdeCreateDataHandle(DWORD idInst, LPBYTE pSrc, DWORD cb,
         *     DWORD cbOff, HSZ hszItem, UINT wFmt, UINT afCmd)
         */
        DdeCreateDataHandle: {
            argBytes: 28,
            handler: ()=>0,
        },

        /** DWORD DdeGetData(HDDEDATA hData, LPBYTE pDst, DWORD cbMax, DWORD cbOff) */
        DdeGetData: {
            argBytes: 16,
            handler: ()=>0,
        },

        /** DWORD DdeQueryStringA(DWORD idInst, HSZ hsz, LPSTR psz, DWORD cchMax, int iCodePage) */
        DdeQueryStringA: {
            argBytes: 20,
            handler: ()=>0,
        },

        /**
         * UINT DdeGetLastError(DWORD idInst)
         *
         * No instance was ever handed out, so there is none to have recorded
         * an error; a program that asks after a refused connect is told so
         * and gives up on the exchange rather than retrying.
         */
        DdeGetLastError: {
            argBytes: 4,
            handler: ()=>DMLERR_NO_ERROR,
        },

        /**
         * HANDLE LoadImageA(HINSTANCE hInst, LPCSTR name, UINT type, int cx,
         *                  int cy, UINT fuLoad)
         *
         * A cursor or an icon out of a module's resources, as LoadCursor and
         * LoadIcon load them; a bitmap needs a decoder that is not here, and
         * null is what a program checks for.
         */
        LoadImageA: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([instance, name, type])=>{
                const IMAGE_ICON = 1;
                const IMAGE_CURSOR = 2;
                switch (type >>> 0){
                    case IMAGE_ICON:
                        return loadResourceObject(host, 'icon', RT_GROUP_ICON, instance, name);
                    case IMAGE_CURSOR:
                        return loadResourceObject(host, 'cursor', RT_GROUP_CURSOR, instance, name);
                    default:
                        return 0;
                }
            },
        },

        /** HCURSOR LoadCursorA(HINSTANCE hInstance, LPCSTR lpCursorName) */
        LoadCursorA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([instance, name])=>
                loadResourceObject(host, 'cursor', RT_GROUP_CURSOR, instance, name),
        },

        /**
         * HCURSOR SetCursor(HCURSOR hCursor)
         *
         * The cursor set is the cursor GetCursor reports and the one the call
         * answers with next time: a program restores what it found. The null
         * cursor is the other half of the hide -- a title that sets it shows no
         * cursor at all, whatever the display count says -- so the picture the
         * page is shown is re-derived here as well as in ShowCursor.
         */
        SetCursor: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([cursor])=>{
                const previous = currentCursor;
                currentCursor = cursor >>> 0;
                cursorIsNull = currentCursor === 0;
                reportCursor();
                return previous;
            },
        },

        /** HCURSOR GetCursor(void) */
        GetCursor: {
            argBytes: 0,
            handler: ()=>currentCursor,
        },

        /**
         * int ShowCursor(BOOL bShow)
         *
         * A counter, not a flag: a program hides the cursor several times and
         * shows it as many, and reads the count to know where it stands. The
         * count is one of the two facts the page's cursor is derived from, so
         * every move of it re-derives the picture and reports it if it changed.
         */
        ShowCursor: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([show])=>{
                cursorShowCount += (show >>> 0) !== 0 ? 1 : -1;
                reportCursor();
                return cursorShowCount;
            },
        },

        /** BOOL GetCursorPos(LPPOINT lpPoint) */
        GetCursorPos: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([point])=>{
                if ((point >>> 0) === 0)
                {
                    return 0;
                }
                const at = host.cursor?.() ?? { x: 0, y: 0 };
                writeU32s(host, point, [at.x, at.y]);
                return 1;
            },
        },

        /**
         * BOOL SetCursorPos(int X, int Y)
         *
         * The cursor GetCursorPos then reports, and the point pointer motion
         * continues from: a mouse-look program reads the cursor, takes its
         * distance from the centre as the frame's motion and puts it back.
         */
        SetCursorPos: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([x, y])=>{
                host.placeCursor?.(x | 0, y | 0);
                return 1;
            },
        },

        /**
         * UINT SendInput(UINT cInputs, LPINPUT pInputs, int cbSize)
         *
         * The program puts events into the input stream itself -- most often a
         * mouse move, because a game that reads the pointer's travel and then
         * centres it needs the move to have happened for the next frame to see
         * it. The struct comes straight out of guest memory and each event is
         * handed to the input layer, which is what turns a move into a
         * WM_MOUSEMOVE and a DirectInput delta both, exactly as it does for a
         * real mouse.
         *
         * `cbSize` is checked rather than trusted: it is sizeof(INPUT) or the
         * caller is not describing one, and Windows refuses the whole call
         * with ERROR_INVALID_PARAMETER rather than read past what it was
         * given. `INPUT_HARDWARE` is a device model of its own -- a low-level
         * message replay nothing here reproduces -- and is counted without
         * being injected, exactly as this build's mouse and keyboard are
         * counted when they are.
         */
        SendInput: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([count, inputs, size])=>{
                if ((size | 0) !== INPUT_SIZE)
                {
                    host.setLastError?.(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                const events = count >>> 0;
                const at = inputs >>> 0;
                let inserted = 0;
                for (let index = 0; index < events; index++)
                {
                    const piece = at + index * INPUT_SIZE;
                    const type = readU32(piece);
                    if (type === INPUT_MOUSE)
                    {
                        inserted += injectMouse(piece) ? 1 : 0;
                    }
                    else if (type === INPUT_KEYBOARD)
                    {
                        inserted += injectKeyboard(piece) ? 1 : 0;
                    }
                    else if (type === INPUT_HARDWARE)
                    {
                        inserted++;
                    }
                    else
                    {
                        host.divergence?.('SendInput', `INPUT type ${type} is not injected`);
                    }
                }
                return inserted;
            },
        },

        /**
         * BOOL ClipCursor(const RECT *lpRect)
         *
         * A program confines the cursor to a rectangle, and for a game that
         * rectangle is the coordinate space it reckons the cursor in -- a menu
         * built for a smaller logical screen than the backbuffer clips to that
         * screen. The input layer is told, so it can scale pointer motion into
         * that space; a null rect releases the cursor to the whole viewport.
         */
        ClipCursor: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([rect])=>{
                host.clipCursor?.((rect >>> 0) === 0 ? null : readRect(host, rect >>> 0));
                return 1;
            },
        },

        /**
         * SHORT GetAsyncKeyState(int vKey) / SHORT GetKeyState(int nVirtKey)
         *
         * The high bit says the key is down; the low bit of GetAsyncKeyState
         * says it went down since the last time it was asked, and the low bit
         * of GetKeyState says a toggle is on. A program polls these instead
         * of reading messages when it wants the state now rather than in the
         * order it changed, and a game does both at once -- menus from
         * messages, movement from these.
         *
         * A build with nothing feeding it answers that nothing is pressed,
         * which is the one safe wrong answer: a state invented here would have
         * a program act on a press that never happened.
         */
        GetAsyncKeyState: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([key])=>host.asyncKeyState?.(key >>> 0) ?? 0,
        },

        /** SHORT GetKeyState(int nVirtKey) */
        GetKeyState: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([key])=>host.keyState?.(key >>> 0) ?? 0,
        },

        /**
         * BOOL GetKeyboardState(PBYTE lpKeyState)
         *
         * The synchronous state as a 256-byte table, one byte per virtual key:
         * the high bit of a byte says the key is down and the low bit the
         * toggle for CapsLock, NumLock and ScrollLock. The same source
         * GetKeyState reads one key at a time.
         */
        GetKeyboardState: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([state])=>{
                if ((state >>> 0) === 0)
                {
                    host.setLastError?.(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                host.writeMemory(state >>> 0, host.keyboardState?.() ?? new Uint8Array(256));
                return 1;
            },
        },

        /**
         * BOOL SetKeyboardState(const BYTE *lpKeyState)
         *
         * Makes the caller's table the synchronous state: the down bits and
         * the toggle bits in those 256 bytes become what GetKeyState and
         * GetKeyboardState answer from then on.
         */
        SetKeyboardState: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([state])=>{
                if ((state >>> 0) === 0)
                {
                    host.setLastError?.(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                host.setKeyboardState?.(host.readMemory(state >>> 0, 256));
                return 1;
            },
        },

        /**
         * int GetKeyboardType(int nTypeFlag)
         *
         * The enhanced 101/102-key keyboard every machine of this era reports:
         * type 4, subtype 0, twelve function keys. Anything else asked is no
         * keyboard property and answers zero, as the real call does.
         */
        GetKeyboardType: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([flag])=>[4, 0, 12][flag >>> 0] ?? 0,
        },

        /**
         * BOOL RegisterHotKey(HWND hWnd, int id, UINT fsModifiers, UINT vk)
         *
         * A keystroke a program wants for itself whatever window has the
         * focus -- Alt+Tab to keep it from the task switcher, Ctrl+Alt+Delete
         * where a program owns the screen. The claim lives with the message
         * queue, because that is where the press arrives and where it has to
         * be taken back out; a window with no queue for it to travel through
         * would otherwise be registered against nothing.
         *
         * A null hWnd belongs to the thread rather than to a window: the
         * WM_HOTKEY that comes of it is posted with no window, which is
         * exactly what a pump asking for every window retrieves and what one
         * naming a window never sees.
         */
        RegisterHotKey: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([hwnd, id, modifiers, vk])=>{
                if (!host.queue.registerHotKey(hwnd >>> 0, id | 0, modifiers >>> 0, vk >>> 0))
                {
                    host.setLastError?.(ERROR_HOTKEY_ALREADY_REGISTERED);
                    return 0;
                }
                return 1;
            },
        },

        /** BOOL UnregisterHotKey(HWND hWnd, int id) */
        UnregisterHotKey: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, id])=>{
                if (!host.queue.unregisterHotKey(hwnd >>> 0, id | 0))
                {
                    host.setLastError?.(ERROR_HOTKEY_NOT_REGISTERED);
                    return 0;
                }
                return 1;
            },
        },

        /**
         * UINT MapVirtualKeyA(UINT uCode, UINT uMapType)
         *
         * The four translations the one US layout answers for, over the same
         * physical-key table `input`'s router turns a browser key into: a
         * virtual key to its scan code and back, a scan code to the
         * side-specific virtual key, and a virtual key to the character it
         * produces with no keyboard state -- MapVirtualKeyExA is this with an
         * HKL argument this build has only one answer for.
         */
        MapVirtualKeyA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([code, mapType])=>mapVirtualKey(code >>> 0, mapType >>> 0),
        },

        /** UINT MapVirtualKeyExA(UINT uCode, UINT uMapType, HKL dwhkl) */
        MapVirtualKeyExA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([code, mapType])=>mapVirtualKey(code >>> 0, mapType >>> 0),
        },

        /**
         * HKL GetKeyboardLayout(DWORD idThread)
         *
         * The input locale of a thread -- always the same one, this build
         * having exactly one, whichever thread is asked about, 0 included.
         */
        GetKeyboardLayout: {
            argBytes: 4,
            handler: ()=>HKL_EN_US,
        },

        /**
         * int ToUnicode(UINT wVirtKey, UINT wScanCode, const BYTE *lpKeyState,
         *     LPWSTR pwszBuff, int cchBuff, UINT wFlags)
         *
         * The character a virtual key produces under a caller-supplied key
         * state, one UTF-16 code unit written to the buffer: 1 when there is
         * one, 0 when the key names none (an arrow, a function key) -- this
         * layout has no dead keys, so neither -1 nor a count above 1 is ever
         * answered. The scan code is not read: nothing this build maps needs
         * it to pick a character once the virtual key and the state are known.
         */
        ToUnicode: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([vk, , keyState, buffer, cchBuff])=>{
                const state = (keyState >>> 0) === 0 ? null : host.readMemory(keyState >>> 0, 256);
                const shiftDown = state ? (state[0x10] & 0x80) !== 0 : false;
                const capsLockOn = state ? (state[0x14] & 0x01) !== 0 : false;
                const char = charForKeyState(vk >>> 0, shiftDown, capsLockOn);
                if (!char || (cchBuff >>> 0) < 1)
                {
                    return 0;
                }
                const code = char.charCodeAt(0);
                host.writeMemory(buffer >>> 0, new Uint8Array([code & 0xff, code >>> 8]));
                return 1;
            },
        },

        /**
         * HWND SetCapture(HWND hWnd)
         *
         * The captured window lives beside ReleaseCapture rather than inside
         * this entry, because the two are a pair: a release that does not clear
         * what was set leaves a program believing it still has the mouse.
         */
        SetCapture: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>host.setCapture(hwnd >>> 0),
        },

        /** HWND GetCapture(void) */
        GetCapture: {
            argBytes: 0,
            handler: ()=>host.capture(),
        },

        /** BOOL ReleaseCapture(void) */
        ReleaseCapture: {
            argBytes: 0,
            handler: ()=>{
                host.releaseCapture();
                return 1;
            },
        },

        /**
         * UINT_PTR SetTimer(HWND hWnd, UINT_PTR nIDEvent, UINT uElapse,
         *                  TIMERPROC lpTimerFunc)
         *
         * A program of this era drives itself from here: its message loop
         * blocks in GetMessage and a timer is the only thing that wakes it.
         * Refusing to make one -- which this used to do -- leaves such a
         * program waiting for a message that cannot arrive, which from outside
         * is indistinguishable from a program with nothing to do.
         *
         * A timer with no window gets an id of our choosing, as Windows does;
         * one with a window keeps the id it asked for. The answer is success,
         * not the id: a window timer numbered zero is a legal timer, and a
         * program that reads zero back as failure sets it again on every
         * message and never gets past the window it was for.
         */
        SetTimer: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([hwnd, id, elapse, proc])=>{
                const window = hwnd >>> 0;
                const timerId = window === 0 ? nextTimerId++ : id >>> 0;
                host.queue.setTimer(window, timerId, elapse >>> 0, proc >>> 0);
                return timerId === 0 ? 1 : timerId;
            },
        },

        /** BOOL KillTimer(HWND hWnd, UINT_PTR uIDEvent) */
        KillTimer: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, id])=>(host.queue.killTimer(hwnd >>> 0, id >>> 0) ? 1 : 0),
        },

        /**
         * LRESULT SendMessageA(HWND hWnd, UINT Msg, WPARAM wParam, LPARAM lParam)
         *
         * Sending means running the window procedure before this returns, which
         * is the bridge's business. The dispatch service the bookkeeping half
         * already holds is exactly that, so this is the one place a message does
         * not go through the queue. A window of a system class has no procedure
         * here; what a control that ignored the message would answer is zero,
         * the same answer SendDlgItemMessage gives for the same control.
         */
        SendMessageA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([hwnd, message, wParam, lParam])=>sendMessage(hwnd, message, wParam, lParam),
        },

        /**
         * LRESULT SendMessageTimeoutA(HWND hWnd, UINT Msg, WPARAM wParam, LPARAM lParam,
         *   UINT fuFlags, UINT uTimeout, PDWORD_PTR lpdwResult)
         *
         * The timeout is for a window on another thread that does not answer.
         * Every window here is on the caller's thread, where the send runs
         * the procedure to completion, so the answer is always in time: the
         * result goes out through the pointer and the call reports success.
         */
        SendMessageTimeoutA: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([hwnd, message, wParam, lParam, , , result])=>{
                if (!live(hwnd))
                {
                    return 0;
                }
                /** @param {number} answer */
                const report = answer=>{
                    if ((result >>> 0) !== 0)
                    {
                        writeU32s(host, result >>> 0, [answer >>> 0]);
                    }
                    return 1;
                };
                const answer = sendMessage(hwnd, message, wParam, lParam);
                return typeof (/** @type {any} */ (answer))?.then === 'function'
                    ? /** @type {any} */ (answer).then(report)
                    : report(answer);
            },
        },

        /** BOOL IsWindowVisible(HWND hWnd) */
        IsWindowVisible: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>{
                const record = live(hwnd);
                return record && (record.style & WS_VISIBLE) !== 0 ? 1 : 0;
            },
        },

        /** HWND GetActiveWindow(void) */
        GetActiveWindow: {
            argBytes: 0,
            handler: ()=>host.active?.() ?? 0,
        },

        /** HWND GetForegroundWindow(void) */
        GetForegroundWindow: {
            argBytes: 0,
            handler: ()=>host.active?.() ?? 0,
        },

        /**
         * HWND GetFocus(void)
         *
         * The window the keyboard goes to, which is a control more often
         * than a top-level window -- and nothing at all until something
         * took it, which is a state a program checks for.
         */
        GetFocus: {
            argBytes: 0,
            handler: ()=>host.focus?.() ?? 0,
        },

        /**
         * DWORD GetClassLongA(HWND hWnd, int nIndex)
         *
         * Class data, not window data: every window of a class reads and writes
         * the same values, which is the whole reason a program reaches for this
         * instead of GetWindowLong.
         */
        GetClassLongA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, index])=>{
                const cls = classOfWindow(hwnd);
                return cls ? readClassLong(cls, index) : 0;
            },
        },

        /** DWORD SetClassLongA(HWND hWnd, int nIndex, LONG dwNewLong) */
        SetClassLongA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hwnd, index, value])=>{
                const cls = classOfWindow(hwnd);
                if (!cls)
                {
                    return 0;
                }
                const previous = readClassLong(cls, index);
                writeClassLong(cls, index, value);
                return previous;
            },
        },

        /** int GetClassNameA(HWND hWnd, LPSTR lpClassName, int nMaxCount) */
        GetClassNameA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hwnd, out, maxCount])=>{
                const record = live(hwnd);
                const room = maxCount | 0;
                if (!record || (out >>> 0) === 0 || room <= 0)
                {
                    return 0;
                }
                return writeString(out >>> 0, record.className, room);
            },
        },

        /**
         * BOOL EnableWindow(HWND hWnd, BOOL bEnable)
         *
         * The return is the state it *found*, and it is true when the window was
         * already disabled -- the opposite way round from what the argument
         * means, which is the classic way to read this backwards.
         */
        EnableWindow: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, enable])=>{
                const record = live(hwnd);
                if (!record)
                {
                    return 0;
                }
                const wasDisabled = (record.style & WS_DISABLED) !== 0;
                const disable = (enable >>> 0) === 0;
                record.style = disable
                    ? (record.style | WS_DISABLED) >>> 0
                    : (record.style & ~WS_DISABLED) >>> 0;
                if (wasDisabled === disable)
                {
                    return wasDisabled ? 1 : 0;
                }
                // A change is announced, as Windows announces it: a control
                // greys itself on WM_ENABLE, and a program watches for it.
                const WM_ENABLE = 0x000a;
                return andThen(sendMessage(hwnd, WM_ENABLE, disable ? 0 : 1, 0),
                    ()=>(wasDisabled ? 1 : 0));
            },
        },

        /** HWND SetActiveWindow(HWND hWnd) */
        SetActiveWindow: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>{
                const previous = host.active?.() ?? 0;
                if (!live(hwnd))
                {
                    return 0;
                }
                host.activate?.(hwnd >>> 0);
                return previous;
            },
        },

        /** BOOL SetForegroundWindow(HWND hWnd) */
        SetForegroundWindow: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>{
                const record = live(hwnd);
                if (!record)
                {
                    return 0;
                }
                host.activate?.(hwnd >>> 0);
                host.raise?.(record);
                return 1;
            },
        },

        /**
         * HWND FindWindowExA(HWND hWndParent, HWND hWndChildAfter,
         *                   LPCSTR lpszClass, LPCSTR lpszWindow)
         *
         * A null class or title matches anything, which is what makes this a
         * search rather than a lookup -- and hWndChildAfter is what lets a
         * caller walk every match instead of finding the first one for ever.
         */
        FindWindowExA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([parent, after, className, windowName])=>{
                const wanted = (className >>> 0) === 0
                    ? null
                    : host.readCString(className >>> 0, MAX_NAME);
                const title = (windowName >>> 0) === 0
                    ? null
                    : host.readCString(windowName >>> 0, MAX_NAME);
                const siblings = ordered().filter(record=>record.parent === (parent >>> 0));
                const start = (after >>> 0) === 0
                    ? 0
                    : siblings.findIndex(record=>record.hwnd === (after >>> 0)) + 1;
                for (let index = Math.max(start, 0); index < siblings.length; index++)
                {
                    const record = siblings[index];
                    if ((wanted === null || record.className === wanted)
                        && (title === null || record.title === title))
                    {
                        return record.hwnd;
                    }
                }
                return 0;
            },
        },

        /**
         * HWND GetTopWindow(HWND hWnd)
         *
         * A null window asks about the desktop's children, which are the
         * top-level windows -- the same thing GetWindow's GW_CHILD would answer
         * for a window that has no parent.
         */
        GetTopWindow: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>{
                if ((hwnd >>> 0) !== 0 && !live(hwnd))
                {
                    return 0;
                }
                return ordered().find(record=>record.parent === (hwnd >>> 0))?.hwnd ?? 0;
            },
        },

        /**
         * int GetWindowTextLengthA(HWND hWnd)
         *
         * Without the terminator, unlike the buffer size GetWindowTextA takes --
         * a caller allocates this plus one, and a length that included the
         * terminator would have it allocate one too many for ever.
         */
        GetWindowTextLengthA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>live(hwnd)?.title.length ?? 0,
        },

        /**
         * DWORD GetWindowThreadProcessId(HWND hWnd, LPDWORD lpdwProcessId)
         *
         * The process reported has to be the one GetCurrentProcessId reports,
         * or a program comparing the two decides its own window belongs to
         * somebody else. Which thread created a window is not recorded, so the
         * thread identifier is the one that is asking.
         */
        GetWindowThreadProcessId: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, out])=>{
                if (!live(hwnd))
                {
                    return 0;
                }
                if ((out >>> 0) !== 0)
                {
                    writeU32s(host, out >>> 0, [host.processId ?? 0x1000]);
                }
                return host.currentThread?.().id >>> 0 || 1;
            },
        },

        /**
         * The rectangle helpers: arithmetic over the caller's own memory, each
         * refusing a null pointer with FALSE rather than faulting inside.
         *
         * BOOL SetRect(LPRECT, int xLeft, int yTop, int xRight, int yBottom)
         * BOOL SetRectEmpty(LPRECT)
         * BOOL CopyRect(LPRECT lprcDst, const RECT *lprcSrc)
         * BOOL EqualRect(const RECT *, const RECT *)
         * BOOL OffsetRect(LPRECT, int dx, int dy)
         * BOOL InflateRect(LPRECT, int dx, int dy)
         * BOOL PtInRect(const RECT *, POINT pt)
         */
        SetRect: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([out, left, top, right, bottom])=>{
                if ((out >>> 0) === 0)
                {
                    return 0;
                }
                writeRect(host, out >>> 0, {
                    left: left | 0, top: top | 0, right: right | 0, bottom: bottom | 0,
                });
                return 1;
            },
        },

        SetRectEmpty: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([out])=>{
                if ((out >>> 0) === 0)
                {
                    return 0;
                }
                writeRect(host, out >>> 0, { left: 0, top: 0, right: 0, bottom: 0 });
                return 1;
            },
        },

        CopyRect: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([out, source])=>{
                if ((out >>> 0) === 0 || (source >>> 0) === 0)
                {
                    return 0;
                }
                writeRect(host, out >>> 0, readRect(host, source >>> 0));
                return 1;
            },
        },

        EqualRect: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([first, second])=>{
                if ((first >>> 0) === 0 || (second >>> 0) === 0)
                {
                    return 0;
                }
                const a = readRect(host, first >>> 0);
                const b = readRect(host, second >>> 0);
                return a.left === b.left && a.top === b.top
                    && a.right === b.right && a.bottom === b.bottom ? 1 : 0;
            },
        },

        OffsetRect: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([rect, dx, dy])=>{
                if ((rect >>> 0) === 0)
                {
                    return 0;
                }
                const r = readRect(host, rect >>> 0);
                writeRect(host, rect >>> 0, {
                    left: r.left + (dx | 0), top: r.top + (dy | 0),
                    right: r.right + (dx | 0), bottom: r.bottom + (dy | 0),
                });
                return 1;
            },
        },

        InflateRect: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([rect, dx, dy])=>{
                if ((rect >>> 0) === 0)
                {
                    return 0;
                }
                const r = readRect(host, rect >>> 0);
                writeRect(host, rect >>> 0, {
                    left: r.left - (dx | 0), top: r.top - (dy | 0),
                    right: r.right + (dx | 0), bottom: r.bottom + (dy | 0),
                });
                return 1;
            },
        },

        /** The POINT is passed by value: two words on the stack. */
        PtInRect: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([rect, x, y])=>{
                if ((rect >>> 0) === 0)
                {
                    return 0;
                }
                const r = readRect(host, rect >>> 0);
                const px = x | 0;
                const py = y | 0;
                return px >= r.left && px < r.right && py >= r.top && py < r.bottom ? 1 : 0;
            },
        },

        /**
         * LONG GetMessageTime(VOID) and DWORD GetMessagePos(VOID)
         *
         * About the message most recently taken off this thread's queue. A
         * framework reads both from inside a handler to date the event it is
         * handling; before the first message there is nothing to date.
         */
        GetMessageTime: {
            argBytes: 0,
            handler: ()=>host.queue.last?.()?.time ?? 0,
        },

        GetMessagePos: {
            argBytes: 0,
            handler: ()=>{
                const at = host.queue.last?.();
                return at ? (at.x & 0xffff) | (at.y & 0xffff) << 16 : 0;
            },
        },

        /**
         * BOOL IntersectRect(LPRECT lprcDst, const RECT *lprcSrc1,
         *                   const RECT *lprcSrc2)
         *
         * An empty intersection writes an empty rectangle as well as answering
         * FALSE: a caller that ignores the return and reads the destination
         * must not find one of the sources still in it.
         */
        IntersectRect: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([out, first, second])=>{
                if ((out >>> 0) === 0 || (first >>> 0) === 0 || (second >>> 0) === 0)
                {
                    return 0;
                }
                const a = readRect(host, first >>> 0);
                const b = readRect(host, second >>> 0);
                const meet = {
                    left: Math.max(a.left, b.left),
                    top: Math.max(a.top, b.top),
                    right: Math.min(a.right, b.right),
                    bottom: Math.min(a.bottom, b.bottom),
                };
                const empty = meet.right <= meet.left || meet.bottom <= meet.top;
                writeRect(host, out >>> 0,
                    empty ? { left: 0, top: 0, right: 0, bottom: 0 } : meet);
                return empty ? 0 : 1;
            },
        },

        /**
         * LRESULT CallWindowProcA(WNDPROC lpPrevWndFunc, HWND hWnd, UINT Msg,
         *                        WPARAM wParam, LPARAM lParam)
         *
         * Subclassing: a program has replaced a window procedure and calls the
         * one it replaced through this. It goes through the same dispatch every
         * other call into guest code goes through, so the bridge suspends this
         * call until the procedure returns.
         */
        CallWindowProcA: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([previous, hwnd, message, wParam, lParam])=>{
                if ((previous >>> 0) === 0)
                {
                    return 0;
                }
                // A system class's procedure lives on this side, and a program
                // that subclassed one calls it through here with its address.
                return host.callProcedure(previous >>> 0, {
                    hwnd: hwnd >>> 0,
                    message: message >>> 0,
                    wParam: wParam >>> 0,
                    lParam: lParam >>> 0,
                }, host.callerThread?.());
            },
        },

        /**
         * HWND SetFocus(HWND hWnd)
         *
         * The window that loses the focus and the one that gains it are
         * both told, which means running their procedures before this
         * returns; the answer is the window that had it.
         */
        SetFocus: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>{
                if ((hwnd >>> 0) !== 0 && !live(hwnd))
                {
                    return 0;
                }
                return host.setFocus(hwnd >>> 0, host.callerThread?.());
            },
        },
    };
}
