/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The user32 surface a windowed program is built around: its classes, its
 * windows, and the loop that pulls messages out of the queue.
 *
 * This is the bookkeeping half. Nothing here calls the program's own window
 * procedure -- running guest code from inside a host call is the bridge's job,
 * and until that is wired, DispatchMessageA reports what it would have called
 * through `host.dispatch` instead. Everything else is real: a class remembers
 * the procedure address it registered, a window remembers the extra bytes its
 * class asked for, and the queue behaves the way a message loop expects.
 */

import { ANY_WINDOW, WM_PAINT, WM_QUIT, WM_TIMER, threadIdOf } from './messages.js';
import { characterOf } from './keys.js';
import { encodeAnsi } from '../kernel32/locale.js';
import {
    createPaintFunctions, intersectAreas, layoutText, offsetArea, subtractAreas,
} from './paint.js';
import { createMessageBoxFunctions } from './msgbox.js';
import { HOVER_SIZE, HOVER_TIME, createSystemColors, createSystemFunctions } from './system.js';
import { createObjectFunctions } from './objects.js';
import { createDialogFunctions } from './dialogs.js';
import { createDesktopFunctions } from './desktops.js';
import { createRawInput } from './rawinput.js';
import { createCaret } from './caret.js';
import { createDirectoryListFunctions } from './dlgdir.js';
import { createMdi } from './mdi.js';
import {
    WS_CHILD, WS_CLIPSIBLINGS, WS_DISABLED, contains, createGeometry, createdStyles, edgeFor,
    frameRings, intersect, isEmpty,
} from './frame.js';
import {
    COLOR_3DDKSHADOW, COLOR_3DFACE, COLOR_3DHILIGHT, COLOR_3DSHADOW, COLOR_BTNTEXT,
    DLGWINDOWEXTRA, HTCLIENT, HTNOWHERE, HTTRANSPARENT, SB_LINEDOWN, SB_ENDSCROLL, SB_LINEUP,
    SB_PAGEDOWN, SB_PAGEUP, WM_CTLCOLORBTN, WM_CTLCOLORDLG, WM_CTLCOLOREDIT, WM_CTLCOLORLISTBOX,
    WM_CTLCOLORSCROLLBAR, WM_CTLCOLORSTATIC, WM_ERASEBKGND, WM_GETTEXT,
    WM_GETTEXTLENGTH, WM_HSCROLL, WM_KILLFOCUS, WM_LBUTTONDOWN, WM_MOUSEMOVE, WM_MOUSEWHEEL,
    WM_NCHITTEST, WM_SETFOCUS, WM_SETTEXT, WM_SHOWWINDOW, WM_SYSCOMMAND, WM_VSCROLL,
    createControlProcedures, pointOf,
} from './controls.js';
import {
    MSG,
    WNDCLASSA,
    WNDCLASSEXA,
    readMessage,
    readRect,
    readU32,
    readWindowClass,
    writeMessage,
    writeRect,
    writeU32s,
    writeWindowClassA,
} from './structs.js';
import { convertCharacter, readText, translated, writeText } from './unicode.js';
import { DESKTOP_WINDOW, HWND_BROADCAST, createWindowDirectory } from './directory.js';
import { boundsOf, subtractFromArea } from '../gdi32/rects.js';
import { areaOf } from '../gdi32/regions.js';

/** @typedef {import('../gdi32/rects.js').Rect} Rect */

/** The messages whose wParam is a character code, in the encoding of the procedure. */
const CHARACTER_MESSAGES = new Set([0x0102, 0x0103, 0x0106, 0x0107]);

/** Messages this layer has an opinion about. */
const WM_DESTROY = 0x0002;
const WM_NCDESTROY = 0x0082;
const WM_MOVE = 0x0003;
const WM_SIZE = 0x0005;
/** WM_SIZE's wParam for a plain resize: not minimised, not maximised. */
const SIZE_RESTORED = 0;
const SIZE_MINIMIZED = 1;
const SIZE_MAXIMIZED = 2;
const WM_WINDOWPOSCHANGED = 0x0047;
/** In WM_WINDOWPOSCHANGED's flags: the client area kept its size, its place. */
const SWP_NOCLIENTSIZE = 0x0800;
const SWP_NOCLIENTMOVE = 0x1000;
const WM_NCCREATE = 0x0081;
const WM_CREATE = 0x0001;
const WM_CLOSE = 0x0010;
const WM_KEYDOWN = 0x0100;
const WM_KEYUP = 0x0101;
const WM_CHAR = 0x0102;
const WM_SYSKEYDOWN = 0x0104;
const WM_SYSKEYUP = 0x0105;
const WM_SYSCHAR = 0x0106;

/** The rest of what DefWindowProc and the frame answer. */
const WM_ACTIVATE = 0x0006;
/** To every top-level window of a program that becomes, or stops being, the active one. */
const WM_ACTIVATEAPP = 0x001c;
const WM_MOUSEACTIVATE = 0x0021;
/** WM_ACTIVATE's wParam: who is being told, and why. */
const WA_INACTIVE = 0;
const WA_ACTIVE = 1;
const WA_CLICKACTIVE = 2;
const WM_NCCALCSIZE = 0x0083;
const WM_NCPAINT = 0x0085;
/**
 * Sent before WM_ACTIVATE, to the same two windows in the same order: the
 * frame is told to draw itself inactive or active -- the caption's colour,
 * mainly -- before the client is told activation changed at all. wParam is
 * the same TRUE/FALSE a caller of DefWindowProc reads; lParam is unused.
 */
const WM_NCACTIVATE = 0x0086;
const WM_NCMOUSEMOVE = 0x00a0;
/** WM_NCXBUTTONDBLCLK, the last of the frame's mouse messages. */
const WM_NCMOUSELAST = 0x00ad;
const WM_NCLBUTTONDOWN = 0x00a1;
const WM_RBUTTONDOWN = 0x0204;
const WM_MBUTTONDOWN = 0x0207;
const WM_MOUSELAST = 0x020d;
const WM_KEYFIRST = 0x0100;
const WM_KEYLAST = 0x0108;
const WM_CAPTURECHANGED = 0x0215;
/** Hit-test answers for the frame. */
const HTCAPTION = 2;
const HTMENU = 5;
const HTBORDER = 18;
const HTCLOSE = 20;
const HTVSCROLL = 7;
const HTHSCROLL = 6;
/** WM_MOUSEACTIVATE's answers: whether to activate, and whether the click still goes. */
const MA_ACTIVATE = 1;
const MA_ACTIVATEANDEAT = 2;
const MA_NOACTIVATE = 3;
const MA_NOACTIVATEANDEAT = 4;
/** The presses, client and non-client, that activate the window they land in. */
const PRESSES = new Set([WM_LBUTTONDOWN, WM_RBUTTONDOWN, WM_MBUTTONDOWN, 0x020b,
    WM_NCLBUTTONDOWN, 0x00a4, 0x00a7, 0x00ab]);
/** SC_CLOSE: what the close box asks for. */
const SC_CLOSE = 0xf060;
/** System colours the frame is painted from. */
const COLOR_BACKGROUND = 1;

/**
 * How long after a window leaves part of the screen the desktop paints it, in
 * milliseconds of the guest's clock: longer than a program takes to put the
 * next window where the last one was, shorter than a person notices.
 */
const DESKTOP_REPAINT_MS = 100;
/** The queue's name for that repaint, which a second departure joins. */
const DESKTOP_REPAINT_KEY = 'desktop-repaint';

/**
 * How long, by the guest's clock, a window waiting to paint holds back the
 * desktop's being shown after a draw: a pass a program pumps through takes a
 * few milliseconds, one it never pumps through takes for ever.
 */
const PAINT_HOLD_MS = 250;
const COLOR_ACTIVECAPTION = 2;
const COLOR_INACTIVECAPTION = 3;
const COLOR_MENU = 4;
const COLOR_CAPTIONTEXT = 9;
const COLOR_APPWORKSPACE = 12;
const COLOR_INACTIVECAPTIONTEXT = 19;
/** A system colour plus one, as a class background names it. */
const SYS_COLOR_BRUSH_LIMIT = 31;
/** The close box in a caption: its size and the gap around it. */
const CLOSE_BOX = 14;
const CLOSE_GAP = 2;

/**
 * The system classes, with their atoms as Windows numbers them, so that
 * `#128` in a dialog template and the atom in a CreateWindowEx both name the
 * same class. The dialog class carries the extra bytes a dialog keeps its
 * procedure and result in.
 */
const SYSTEM_CLASSES = Object.freeze([
    { name: 'Button', atom: 0x0080, windowExtra: 0, background: 0 },
    { name: 'Edit', atom: 0x0081, windowExtra: 0, background: 0, cursor: 32513 },
    { name: 'Static', atom: 0x0082, windowExtra: 0, background: 0 },
    { name: 'ListBox', atom: 0x0083, windowExtra: 0, background: 0 },
    { name: 'ScrollBar', atom: 0x0084, windowExtra: 0, background: 0 },
    { name: 'ComboBox', atom: 0x0085, windowExtra: 0, background: 0 },
    { name: '#32770', atom: 0x8002, windowExtra: DLGWINDOWEXTRA, background: COLOR_3DFACE + 1 },
]);

/**
 * The standard arrow, as LoadCursor(NULL, IDC_ARROW) names it: the cursor of
 * every system class but the edit's, which is the I-beam above.
 */
const IDC_ARROW = 32512;

/** The hit-test codes of a sizing border, which a child keeps from its parent. */
const HTSIZEFIRST = 10;
const HTSIZELAST = 17;

const WM_SETCURSOR = 0x0020;

/**
 * Where a host procedure's address is when there is no bridge to hand one
 * out: a range no module is mapped at, spaced by the class atom, so a
 * program that calls it by hand faults where a test can see rather than
 * running somebody's code.
 */
const HOST_PROCEDURE_BASE = 0x7ff00000;
/** DrawText's flags a message box's text is measured with. */
const DT_WORDBREAK = 0x0010;
const DT_NOPREFIX = 0x0800;

/** The one hook type this build calls, and the one event it calls it for. */
const WH_CBT = 5;
const WH_KEYBOARD = 2;
/** A keyboard hook's codes: the message is being taken, or only looked at. */
const HC_ACTION = 0;
const HC_NOREMOVE = 3;
/** The CBT hook's codes: what is about to happen, which it may forbid. */
const HCBT_MINMAX = 1;
const HCBT_CREATEWND = 3;
const HCBT_DESTROYWND = 4;
const HCBT_ACTIVATE = 5;
const HCBT_SYSCOMMAND = 8;
const HCBT_SETFOCUS = 9;

/** CBT_CREATEWNDA: what a CBT hook is handed for HCBT_CREATEWND. */
const CBT_CREATEWNDA = Object.freeze({ lpcs: 0, hwndInsertAfter: 4, SIZE: 8 });

/** TranslateMessage answers for exactly these, translated or not. */
const KEY_MESSAGES = new Set([WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP]);

/**
 * Notes what a window procedure has been handed, until it gives it back.
 *
 * A procedure that never returns stops the thread pumping the queue, and with
 * it everything the program does -- and it does so invisibly. The call log
 * writes a call when it answers, so the one call holding the machine is the one
 * call missing from it; the report of a stall names the thread and the function
 * but not the message, which is the only part that says what the program was
 * asked to do.
 *
 * @template T
 * @param {Pick<WindowHost, 'dispatching'>} host
 * @param {{ hwnd: number, message: number }} message
 * @param {T} answer   What the procedure gave back: a promise, or a value.
 * @returns {T}
 */
export function watchDispatch(host, message, answer){
    const open = host.dispatching;
    if (!open)
    {
        return answer;
    }
    const handed = {
        hwnd: message.hwnd >>> 0, message: message.message >>> 0,
        at: import.meta.BOTTLIFY_DIAGNOSTICS !== false ? Date.now() : 0,
    };
    open.push(handed);
    const done = ()=>{
        const at = open.indexOf(handed);
        if (at !== -1)
        {
            open.splice(at, 1);
        }
    };
    // A procedure that answered without suspending has already returned; only a
    // promise leaves the call open.
    if (typeof (/** @type {any} */ (answer))?.then === 'function')
    {
        /** @type {any} */ (answer).then(done, done);
    }
    else
    {
        done();
    }
    return answer;
}

/**
 * CREATESTRUCTA, which is what WM_NCCREATE and WM_CREATE carry.
 *
 * A program reads `lpCreateParams` out of it to find whatever it passed to
 * CreateWindowEx, and that is routinely the object the window belongs to --
 * so a procedure that gets the message without the structure is worse off
 * than one that gets no message at all.
 */
const CREATESTRUCTA = Object.freeze({
    lpCreateParams: 0x00,
    hInstance: 0x04,
    hMenu: 0x08,
    hwndParent: 0x0c,
    cy: 0x10,
    cx: 0x14,
    y: 0x18,
    x: 0x1c,
    style: 0x20,
    lpszName: 0x24,
    lpszClass: 0x28,
    dwExStyle: 0x2c,
    SIZE: 0x30,
});

/** The one style bit that changes what a window is rather than how it looks. */
const WS_VISIBLE = 0x10000000;

/** Every ShowWindow command shows the window; this one alone hides it. */
const SW_HIDE = 0;
const SW_SHOW = 5;
const SW_MINIMIZE = 6;
const SW_SHOWNA = 8;
/** The show commands that leave the window minimised. */
const MINIMISING = new Set([2, SW_MINIMIZE, 7]);
/** The show commands that bring a minimised window back: SW_SHOWNORMAL, SW_RESTORE, SW_SHOWDEFAULT. */
const RESTORING = new Set([1, 9, 10]);
/**
 * The commands that bring a minimised window back: those, and showing it
 * maximised or without activating it. SW_SHOW and SW_SHOWNA leave it as it
 * is (msg.c test_ShowWindow).
 */
const RESTORED_BY = new Set([...RESTORING, 3, 4, 0xcc]);
const WS_MINIMIZE = 0x20000000;
const WS_MAXIMIZE = 0x01000000;
const WS_EX_TOPMOST = 0x00000008;

/**
 * The fields of a window's record its state on the screen is read from
 * (`stateOf`): a change to any of them is told to the run.
 */
const TRACKED_FIELDS = ['x', 'y', 'width', 'height', 'style', 'exStyle', 'parent', 'owner',
    'title', 'frameless', 'regionBox', 'menu'];
const WS_POPUP = 0x80000000;
const WS_EX_MDICHILD = 0x00000040;
const ERROR_INVALID_MENU_HANDLE = 1401;
/** What a call answering with a region says of it. */
const REGION_ERROR = 0;
const NULLREGION = 1;
const SIMPLEREGION = 2;
const COMPLEXREGION = 3;
/** MDICREATESTRUCT: the class, title, owner, place, size, style and lParam, a dword each. */
const MDICREATESTRUCT_SIZE = 36;
/** Painted only once the siblings beneath it have been: a label over a picture. */
const WS_EX_TRANSPARENT = 0x20;
/** A floating toolbar: never handed the activation another window gave up. */
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_CLIPCHILDREN = 0x02000000;
/** A layered window is one only once CreateWindowEx has shown the CBT hook the window. */
const WS_EX_LAYERED = 0x00080000;
/** The ShowWindow commands that leave activation where it is. */
const SHOW_WITHOUT_ACTIVATING = new Set([SW_HIDE, 4, 6, 7, 8]);

/** The coordinate that asks the system to choose one. */
const CW_USEDEFAULT = 0x80000000;

/**
 * Where a window whose position the system chose ends up. Windows cascades
 * these across the desktop; there is no desktop to cascade across yet, so they
 * are fixed and will move to whatever owns screen metrics.
 */
const DEFAULT_ORIGIN = 0;
const DEFAULT_WIDTH = 640;
const DEFAULT_HEIGHT = 480;

/** The desktop's style: shown, and clipping what is drawn on it to itself. */
const DESKTOP_STYLE = 0x96000000;

/** GetWindowLong / SetWindowLong indices: negative ones name a field. */
const GWL_WNDPROC = -4;
const GWL_HINSTANCE = -6;
const GWL_HWNDPARENT = -8;
const GWL_ID = -12;
const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const GWL_USERDATA = -21;

/** PeekMessage's wRemoveMsg is a flag word; PM_NOREMOVE is the absence of this. */
const PM_REMOVE = 1;

/** What MsgWaitForMultipleObjects answers, in kernel32's terms. */
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 0x102;
const WAIT_FAILED = 0xffffffff;
const INFINITE = 0xffffffff;

/**
 * The kernel objects whose signal a poll reads the same for every thread -- a
 * thread's is having ended -- where a mutex is owned by one, and a wait on a
 * process hands the machine to it.
 */
const POLLED_KINDS = new Set(['event', 'semaphore', 'timer', 'thread']);

/** The parent a message-only window is made with. */
const HWND_MESSAGE = 0xfffffffd;


/** PeekMessage takes this where a window goes to mean "thread messages only". */
const HWND_THREAD_MESSAGES = 0xffffffff;

/** What PostThreadMessage reports for an identifier that names no thread. */
const ERROR_INVALID_THREAD_ID = 1444;
const ERROR_INVALID_PARAMETER = 87;
/** A pointer the call was to write through, and could not. */
const ERROR_NOACCESS = 998;
/** Another thread's window, which only its own may destroy. */
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_WINDOW_HANDLE = 1400;
const ERROR_TLW_WITH_WSCHILD = 1406;

/**
 * InSendMessageEx's answer: how the message being handled was sent from
 * another thread, and whether ReplyMessage has answered it yet.
 */
const ISMEX_NOSEND = 0;
const ISMEX_SEND = 1;
const ISMEX_NOTIFY = 2;
const ISMEX_CALLBACK = 4;
const ISMEX_REPLIED = 8;

/**
 * The message whose block a sender in another process lends the receiver:
 * COPYDATASTRUCT's three words, then the bytes it points at.
 */
const WM_COPYDATA = 0x004a;
const COPYDATASTRUCT_SIZE = 12;
/** The longest text a message carries to another process, in characters. */
const MAX_CARRIED_TEXT = 0x10000;

/** TrackMouseEvent's request, its flags, and the messages its tracking posts. */
const TRACKMOUSEEVENT_SIZE = 16;
const TME_HOVER = 0x00000001;
const TME_LEAVE = 0x00000002;
const TME_NONCLIENT = 0x00000010;
const TME_QUERY = 0x40000000;
const TME_CANCEL = 0x80000000;
const HOVER_DEFAULT = 0xffffffff;
const WM_NCMOUSEHOVER = 0x02a0;
const WM_MOUSEHOVER = 0x02a1;
const WM_NCMOUSELEAVE = 0x02a2;
const WM_MOUSELEAVE = 0x02a3;
/** The queue's key for the hover asked for later: there is one tracking. */
const HOVER_KEY = 'TrackMouseEvent';
/** The MK_ bits of a mouse message's wParam, by the virtual key each reads. */
const MOUSE_KEYS = Object.freeze([[0x01, 0x0001], [0x02, 0x0002], [0x10, 0x0004],
    [0x11, 0x0008], [0x04, 0x0010], [0x05, 0x0020], [0x06, 0x0040]]);

/** Class atoms come from the range Windows reserves for dynamic atoms. */
const FIRST_ATOM = 0xc000;
const LAST_ATOM = 0xffff;

/** Windows caps a class name here, and a name is the only thing we scan for. */
const MAX_CLASS_NAME = 256;

/** Nothing bounds a window title, so something has to. */
const MAX_WINDOW_TEXT = 1 << 16;

/**
 * @typedef {Object} DispatchedMessage
 * @property {number} hwnd
 * @property {number} message
 * @property {number} wParam
 * @property {number} lParam
 * @property {boolean} [unicode]  whether its text is wide (`unicode.js`)
 */

/**
 * @typedef {Object} WindowService
 * @property {(hdc: number) => void} refreshContext
 *           Brings a device context a program holds up to where its window
 *           now is, and what of it now shows, before it draws.
 * @property {() => { hwnd: string, x: number, y: number, width: number, height: number,
 *            rect: { left: number, top: number, right: number, bottom: number },
 *            client: { left: number, top: number, right: number, bottom: number },
 *            visible: boolean, className: string, title: string, parent: string | null,
 *            child: boolean, id: number, style: string, exStyle: string }[]} list
 *           Every live window, children included: a dialog is its controls, and
 *           a report that shows the frame and not the button under the pointer
 *           says nothing about what a click would reach.
 * @property {(hwnd: number) => { left: number, top: number, right: number,
 *     bottom: number } | null} clientRect
 *           One window's client rectangle on the screen, or null for a handle
 *           that names none: GetClientRect's size at ClientToScreen's origin,
 *           for the callers outside this layer that must answer a size a
 *           program asked for as zero -- a back buffer's, which means exactly
 *           this rectangle -- or place a picture inside a window.
 * @property {(hwnd: number, x: number, y: number, width: number, height: number,
 *     how?: { announce?: boolean }) => boolean} place
 * @property {() => number} active
 *           The active top-level window -- what GetForegroundWindow answers --
 *           or zero while there is none.
 * @property {() => boolean} deactivated
 *           Whether the application was last told WM_ACTIVATEAPP(0): from
 *           then until WM_ACTIVATEAPP(1) it is not the active application,
 *           whichever of its windows the program activates meanwhile.
 * @property {() => number} deactivations
 *           How many times the application has been told WM_ACTIVATEAPP(0),
 *           for a caller that looks only now and then and must still learn
 *           of a deactivation that came and went in between.
 * @property {(event: import('./rawinput.js').RawInputEvent) => void} rawInput
 *           One event of the mouse or the keyboard as the device reported it,
 *           posted as WM_INPUT to whoever registered for that device.
 * @property {(hwnd: number, options: { thread: unknown,
 *     first?: import('./dialogs.js').ModalHook }) => number | Promise<number>} modalLoop
 *           Runs a dialog another library made as DialogBox runs one, on the
 *           thread named, each message offered to `first` before the dialog
 *           manager: what a property sheet's own loop is on Windows.
 * @property {() => boolean} painting
 *           Whether a window on the screen is still to paint what it was asked
 *           to: the screen is half drawn, and the window manager shows it once
 *           the pass is over rather than now.
 */

/**
 * @typedef {Object} WindowHost
 * @property {number} [processId]  The running process's identifier, which
 *           GetWindowThreadProcessId reports for this process's windows.
 * @property {ReturnType<typeof createWindowDirectory>} [directory]
 *           The run's windows (`directory.js`): where a window handle comes
 *           from, and how a window of another process is found, described and
 *           posted to. A host with no other process gets one of its own.
 * @property {{ width: number, height: number, bitsPerPixel: number }} [screen]
 *           The display every system metric is derived from.
 * @property {{ width: number, height: number, bits: Uint8Array } | null} [desktopPicture]
 *           What the desktop shows where no window is, in place of its colour:
 *           32 bits a pixel, top row first, scaled to the screen.
 * @property {() => any} [dc]
 *           The device-context service painting takes its DCs from.
 * @property {any} [draw]
 *           The window manager's own drawing over a device context: fills,
 *           text, the selected font's measure. Absent with `dc`.
 * @property {(region: number) => ({ left: number, top: number, right: number,
 *           bottom: number } | null)} [regionBox]
 *           The rectangle a GDI region holds, for the calls that name an area
 *           by a region.
 * @property {(region: number, rect: any) => boolean} [setRegion]
 *           Makes a GDI region hold a rectangle, for GetUpdateRgn.
 * @property {(region: number) => void} [deleteRegion]
 *           Deletes a GDI region the system took from GetDCEx.
 * @property {() => void} [present]
 *           Shows the desktop. Called once a paint pass has finished.
 * @property {(delay: number, fire: () => void) => boolean} [later]
 *           Runs `fire` once `delay` milliseconds of the guest's clock have
 *           passed, whatever the program's threads are doing; false when
 *           there is no such clock.
 * @property {(name: string, handler: (message: DispatchedMessage) => number | Promise<number>)
 *     => number} [registerProcedure]
 *           An address a program can call a host-side window procedure
 *           through. Absent in a build with no bridge, and then the address
 *           is one nothing in the guest can reach.
 * @property {(controlHost: any, toolkit: any,
 *     register: (definition: { name: string, procedure: any,
 *         windowExtra?: number, background?: number }) => void) => void} [registerControls]
 *           Where the common controls put their classes, as built-in as the
 *           ones here: handed the host and the drawing helpers the system
 *           classes paint with, and the function that files a class under its
 *           name. Absent in a build with no common controls, and then a
 *           program that makes one gets no window for it.
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, length: number) => boolean} [canWrite]
 *           Whether the guest may write there; without it every address is
 *           taken to be writable.
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number) => { base: number, size: number } | null} [regionAt]
 *           The region an address sits in, from the memory layer's map: the
 *           `va_list` window wvsprintfA reads stops at its end.
 * @property {{ open: (type: string, object: any) => number,
 *              close: (handle: number) => any,
 *              typeOf?: (handle: number) => string | null,
 *              resolve?: (handle: number, type: string) => any }} handles
 *           typeOf names the kind of object a handle is, which decides how a
 *           wait that also watches the queue can hold it; resolve hands back
 *           the object, and throws for a handle of another kind.
 * @property {ReturnType<typeof import('./messages.js').createMessageQueue>} queue
 *           Where messages come from, including the ones the input layer posts.
 * @property {{ hwnd: number, message: number, at: number }[]} [dispatching]
 *           Where a window procedure that has not returned is noted, for
 *           whoever is measuring. Absent in a build that is not.
 * @property {(message: DispatchedMessage) => void} [trace]
 *           Told every message a window procedure is about to receive,
 *           whoever sends it: the queue, a SendMessage, this layer itself.
 *           What a program does on a message is decided in its procedure,
 *           and its calls into this library say what it asked, never what
 *           it was told.
 * @property {(wndProc: number, message: DispatchedMessage, thread?: unknown) => number} dispatch
 *           Runs a window procedure. One line from being the bridge's callback.
 *           A caller that has awaited names the thread whose call it answers.
 * @property {(entry: number, args: number[], thread?: unknown) => number} [call]
 *           Runs any guest routine with the arguments it declares -- a hook
 *           procedure. Absent in a build with no bridge, and then no hook is
 *           ever called.
 * @property {() => unknown} [callerThread]
 *           Whose call is being handled, read before an await for `dispatch`
 *           afterwards. Absent in a build with no bridge, and then unnamed.
 * @property {<T>(thread: unknown, fn: () => T) => T} [answering]
 *           Runs `fn` as the call of `thread`: what it reads as its caller,
 *           and what it calls back into the guest, are that thread's.
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {boolean} [unattended]
 *           Nobody is at the screen: a modal dialog waiting for input is
 *           answered by `answer`, or with its default button.
 * @property {(dialog: import('./dialogs.js').UnattendedDialog)
 *     => number | Promise<number>} [answer]
 * @property {(id: number) => boolean} [threadExists]
 *           Whether a thread identifier names a thread of this process, which
 *           is the whole of what PostThreadMessage validates. Absent in a build
 *           with no scheduler behind it, which then only refuses zero.
 * @property {(id: number) => boolean} [processExists]
 *           Whether a process identifier names a running process, which
 *           AllowSetForegroundWindow validates. Absent, every id is taken.
 * @property {(code: number) => void} [setLastError]
 *           Where a refusal leaves its reason, for the caller that asks why.
 * @property {() => any} park   Stops the caller; returns the parked token.
 * @property {(instance: number, id: number) => string | null} [loadString]
 *           A string out of a module's resources. Absent in a build with no
 *           loader behind it, which answers as a module with no string table.
 * @property {(instance: number, type: number, name: number | string) => unknown} [findResource]
 *           Whether a module carries a resource of that type and name: what
 *           decides if a cursor or icon a program loads out of its own image
 *           exists. Absent for the same reason, and then none does.
 * @property {(instance: number) => number} [moduleBase]
 *           Where a module is mapped, which with a resource's own offset is
 *           the address of its bytes -- a dialog template is read in place.
 * @property {(info: number, bits: number) => number} [bitmapFromDib]
 *           A bitmap for the display made from a packed DIB in guest memory
 *           (its header and colours at `info`, its pixels at `bits`), as
 *           CreateDIBitmap on a screen context makes one; zero when it cannot.
 * @property {(handle: number) => { width: number, height: number } | null} [bitmapSize]
 *           A GDI bitmap's size, or null for a handle that is no bitmap: the
 *           size a bitmap caret and an icon made from bitmaps take.
 * @property {(handle: number) => { width: number, height: number,
 *     bgra: Uint8Array } | null} [bitmapPixels]
 *           A GDI bitmap's pixels, top row first, four bytes each in blue,
 *           green, red and a fourth byte: what CreateIconIndirect copies.
 *           Absent, an icon made from bitmaps has its size and no picture.
 * @property {import('../kernel32/files.js').FileSystem} [files]
 *           The volume every file call uses, which an image loaded from a
 *           file is read from. Absent, no file is there to load.
 * @property {{ text: string | null, version: number }} [pasteboard]
 *           What the host last pasted, with a version that rises on every
 *           paste: the clipboard's contents until a program empties it.
 * @property {(hwnd: number) => void} [created]
 *           A window now exists. Whoever delivers input needs to know.
 * @property {(bytes: number) => number} [allocate]
 *           Guest memory for a CREATESTRUCT. Absent in a build with no heap,
 *           and then a window is made without telling its procedure -- which
 *           is what this used to do always.
 * @property {(address: number) => void} [release]
 * @property {() => Promise<void>} idle
 * @property {(args: number[]) => number | Promise<number>} [waitForObjects]
 *           kernel32's WaitForMultipleObjects, by its own arguments. What a
 *           wait that also watches the queue defers the handles to; absent, a
 *           wait on handles fails and a wait on the queue alone still works.
 * @property {() => number} [now]
 *           The guest's clock in milliseconds, for a wait with a deadline.
 * @property {(service: WindowService) => void} [windowService]
 *     Handed the two things the rest of the machine needs from the windows:
 *     a reader of every top-level window's rectangle, for a diagnostic -- the
 *     window is the space a program declares its cursor in, and a cursor that
 *     lands short of where it was aimed is that rectangle disagreeing with the
 *     picture -- and a way to place a window as the system would, which a
 *     fullscreen device has to do to the window it presents into.
 * @property {() => { x: number, y: number }} [cursor]
 *           Where the pointer is. Absent in a build with no input, and then
 *           the answer is the origin.
 * @property {(key: number) => number} [keyState]
 *           Whether a virtual key is down, as GetKeyState reports it: the
 *           high bit set while it is held. Absent means nothing is pressed,
 *           which is the one safe wrong answer.
 * @property {(key: number) => number} [asyncKeyState]
 *           Whether a virtual key is down and whether it has gone down since
 *           the last call, as GetAsyncKeyState reports it: the high bit held,
 *           the low bit pressed since the previous read, which the read
 *           clears. Absent means nothing is pressed.
 * @property {() => Uint8Array | null} [keyboardState]
 *           256 bytes, one per virtual key, as GetKeyboardState fills its
 *           caller's array: the high bit down and the low bit the toggle for
 *           CapsLock, NumLock and ScrollLock. Absent means no keyboard, and
 *           then the caller's array is zeroed.
 * @property {(bytes: Uint8Array) => void} [setKeyboardState]
 *           Makes the table GetKeyboardState would read: the down bits and
 *           the toggle bits in those 256 bytes become the synchronous state.
 *           Absent leaves the state untouched.
 * @property {(rect: { left: number, top: number, right: number,
 *           bottom: number } | null) => void} [clipCursor]
 *           The cursor space a program declares with ClipCursor, forwarded to
 *           the input layer so it can scale pointer motion into it. Null
 *           releases the cursor to the whole viewport. Absent in a build with
 *           no input, and then the declaration is simply not acted on.
 * @property {(x: number, y: number) => void} [placeCursor]
 *           Where a program puts the cursor with SetCursorPos, in the same
 *           space, forwarded to the input layer so the cursor it reports and
 *           the motion it derives start from there. Absent in a build with no
 *           input, and then the cursor stays where the pointer is.
 * @property {(event: { kind: string, dx?: number, dy?: number, x?: number,
 *           y?: number, button?: string, down?: boolean, delta?: number,
 *           vk?: number, scan?: number, extended?: boolean, text?: string })
 *           => void} [sendInput]
 *           Where SendInput's events go: the input layer's own stream, so a
 *           move becomes a message and a DirectInput delta both, as a real
 *           mouse's would, and a key named by virtual key or scan code takes
 *           the same path a real key press does. Absent in a build with no
 *           input, and then the call injects nothing.
 * @property {(picture: { shown: boolean, width?: number, height?: number,
 *           hotSpot?: { x: number, y: number }, bgra?: Uint8Array }) => void} [reportCursor]
 *           The page's cursor, as user32's own state changed it: shown while
 *           ShowCursor's count is not below zero and SetCursor has not named the
 *           null cursor, with the bitmap -- four bytes a pixel, top row first --
 *           and the hot spot of a cursor the program made or loaded, and none
 *           for a standard cursor, which the page shows as its own. Handed up
 *           only on a change, through the same event the Direct3D device
 *           methods use. Absent in a build with nothing showing a cursor, and
 *           then the derived picture is kept to ourselves.
 * @property {(notice: { id: number, text: string, caption: string, type: number,
 *           buttons: { id: number, label: string }[], defaultButton: number })
 *           => number | Promise<number> | null | undefined} [messageBox]
 *           Who answers a message box when nobody is at the screen
 *           (`unattended`): the id of the button chosen, or nothing for the
 *           box's own default. With somebody there the box is a dialog on the
 *           program's desktop and this is not asked.
 * @property {(text: string) => void} [clipboard]
 *           The text a program copied, handed up when it closes the clipboard.
 *           A copy that stays inside the guest is one the person cannot paste
 *           anywhere they would want to.
 * @property {(text: string) => void} [say]  Where a program's own words go.
 */

/**
 * Builds the function table: name -> { argBytes, handler }.
 *
 * `argBytes` is the size of the argument list the guest compiled against. All
 * of user32 is stdcall, the bridge's default, so none of them says so.
 *
 * @param {WindowHost} host
 */
export function createWindowFunctions(host){
    /** @type {Map<string, any>} */
    const classes = new Map();
    /** @type {Map<number, string>} */
    const atoms = new Map();
    /**
     * Windows are kept here after they are destroyed, so that a WM_DESTROY
     * already in the queue still finds the procedure it has to reach. The handle
     * itself is closed at that moment, which is what makes the window stop
     * existing as far as the guest is concerned.
     *
     * @type {Map<number, any>}
     */
    const windows = new Map();
    /**
     * Moves on with every change that can change what part of the screen a
     * window's device context reaches: a window made, gone or restacked --
     * the map's order is the stacking -- and any field its place, size,
     * style or parent is read from. A context handed out under an older
     * one has its origin and visible region worked out again before it
     * draws (`paint.refreshContext`).
     */
    let layoutRevision = 0;
    for (const change of /** @type {const} */ (['set', 'delete', 'clear']))
    {
        const plain = windows[change].bind(windows);
        windows[change] = /** @type {any} */ ((/** @type {any[]} */ ...args)=>{
            layoutRevision++;
            return /** @type {any} */ (plain)(...args);
        });
    }
    let nextAtom = FIRST_ATOM;
    const processId = host.processId ?? 0x1000;
    const directory = host.directory ?? createWindowDirectory();

    /**
     * Resolves the argument every API takes where a class name is declared. It
     * is a pointer to a string, or -- because that is what registration handed
     * back -- an atom stuffed into the low word.
     *
     * @param {number} pointer
     * @param {boolean} [unicode]  whether the name is a wide string
     * @returns {any | null}
     */
    const classOf = (pointer, unicode = false)=>{
        const value = pointer >>> 0;
        if (value === 0)
        {
            return null;
        }
        const name = value <= LAST_ATOM
            ? atoms.get(value)
            : readText(host, value, unicode, MAX_CLASS_NAME);
        return name === undefined ? null : classNamed(name);
    };

    /**
     * A class by name: the program's own first, then a system one. Names
     * compare without regard to case, and a system class also answers to
     * its atom spelled out -- `#128` is Button in a dialog template.
     *
     * @param {string} name
     * @returns {any | null}
     */
    const classNamed = name=>{
        const own = classes.get(name);
        if (own)
        {
            return own;
        }
        const folded = name.toLowerCase();
        for (const cls of classes.values())
        {
            if (cls.name.toLowerCase() === folded)
            {
                return cls;
            }
        }
        const system = systemClasses.get(folded);
        if (system && system.wndProc === 0)
        {
            // The address is made when the class is first wanted rather than
            // when the tables are built: a stub the bridge hands out needs
            // the machine to be up, and a build that never makes a control
            // never needs one.
            system.wndProc = host.registerProcedure
                ? host.registerProcedure(`<${system.name}>`,
                    message=>callProcedure(system.wndProc, message, host.callerThread?.()))
                : HOST_PROCEDURE_BASE + system.atom * 16;
            procedures.set(system.wndProc, controlProcedures[system.name]);
        }
        return system ?? null;
    };

    /**
     * The window procedures that live on this side, by address, and the
     * classes they belong to.
     *
     * @type {Map<number, (record: any, message: DispatchedMessage, thread?: unknown)
     *     => number | Promise<number>>}
     */
    const procedures = new Map();
    /** @type {Map<string, any>} lower-case name or atom spelling -> class */
    const systemClasses = new Map();
    /**
     * The procedure of each built-in class by name: the seven user32 ones and
     * whatever the common controls file beside them. Kept apart from the
     * address map because a class is looked up by name long before it has an
     * address, and registering a class only adds a name.
     *
     * @type {Record<string, (record: any, message: DispatchedMessage,
     *     thread?: unknown) => number | Promise<number>>}
     */
    const controlProcedures = {};

    /**
     * Runs a window procedure by address: a host one directly, a guest one
     * through the bridge. Every message a window receives goes through here,
     * so that a system class, a subclassed one and a program's own are one
     * case to the callers.
     *
     * @param {number} address @param {DispatchedMessage} message @param {unknown} [thread]
     * @param {boolean} [unicode]  The encoding a program's procedure reads, when
     *     the caller knows it -- a dialog's procedure is of its dialog's kind.
     * @returns {number | Promise<number>}
     */
    const callProcedure = (address, message, thread, unicode = undefined)=>{
        host.trace?.(message);
        const procedure = procedures.get(address >>> 0);
        const record = windows.get(message.hwnd >>> 0);
        if (procedure)
        {
            // Named now, while the call that brought us here still holds the
            // processor: a procedure on this side that sends to guest code
            // and goes on afterwards is past an await by then.
            const on = thread ?? host.callerThread?.();
            // The procedures on this side read the ANSI page.
            return record ? translated(host, message, false,
                ansi=>watchDispatch(host, ansi, procedure(record, ansi, on)), record.style) : 0;
        }
        // A window's own procedure reads text in the encoding it was set in; a
        // procedure named by its address, as CallWindowProc names one, is
        // handed the message as it came.
        const reads = unicode ?? (record && (address >>> 0) === record.wndProc
            ? record.unicode === true : message.unicode === true);
        return translated(host, message, reads,
            text=>watchDispatch(host, text, host.dispatch(address >>> 0, text, thread)),
            record?.style);
    };

    /**
     * Whether a window is another thread's than the caller's: GetWindowText
     * reads such a window's caption rather than wait on its thread, and says
     * so once.
     *
     * @param {any} record
     */
    const ownedElsewhere = record=>{
        const owner = creatorOf(record);
        const asking = threadIdOf(host.callerThread?.());
        if (owner === null || asking === null || owner === asking)
        {
            return false;
        }
        if (!toldCaption)
        {
            toldCaption = true;
            host.divergence?.('GetWindowText', 'another thread\'s window is read from its caption,'
                + ' not sent WM_GETTEXT');
        }
        return true;
    };
    let toldCaption = false;

    /**
     * SendMessage, to a live window: its procedure runs before this returns,
     * or the answer is a promise of when it will have.
     *
     * @param {number} hwnd @param {number} message @param {number} wParam @param {number} lParam
     * @param {unknown} [thread]
     * @param {boolean} [unicode]  whether the text the message carries is wide
     * @returns {number | Promise<number>}
     */
    const send = (hwnd, message, wParam, lParam, thread, unicode = false)=>{
        const record = live(hwnd);
        if (!record || record.wndProc === 0)
        {
            return 0;
        }
        // What the window manager sends itself -- activation, destruction,
        // the messages a call it answers makes -- runs the procedure on the
        // thread that caused it, even for another thread's window, where
        // Windows hands it to that thread as a program's SendMessage is.
        const owner = creatorOf(record);
        const sender = threadIdOf(thread);
        if (owner !== null && sender !== null && owner !== sender)
        {
            host.divergence?.('SendMessage', 'a message the window manager sends to another '
                + 'thread\'s window runs on the thread that sent it');
        }
        return callProcedure(record.wndProc, {
            hwnd: record.hwnd, message: message >>> 0, wParam: wParam >>> 0, lParam: lParam >>> 0,
            ...unicode ? { unicode } : {},
        }, thread);
    };

    /**
     * A message sent to a window of another thread: it waits for that thread
     * to look at its queue, which runs the window's procedure on its own
     * thread and hands the answer back to the sender.
     *
     * @typedef {{ hwnd: number, message: number, wParam: number, lParam: number,
     *     unicode: boolean, kind: number, replied: boolean, result: number,
     *     from: number | null, callback: number, data: number,
     *     elsewhere?: number }} SentMessage
     *     `elsewhere`: the number another process asks for its answer by.
     */

    /**
     * What other threads have sent to each thread's windows, oldest first,
     * and the answers a thread that sent with SendMessageCallback is still
     * to be told of -- both waiting for the thread's next look at its queue.
     *
     * @type {Map<number, SentMessage[]>}
     */
    const inbox = new Map();
    /** @type {Map<number, SentMessage[]>} */
    const answered = new Map();
    /**
     * The threads that have a message queue: made a window, or looked at
     * their queue. A thread's queue is made the first time it needs one.
     *
     * @type {Set<number>}
     */
    const queueing = new Set();
    /** @param {unknown} thread */
    const hasQueue = thread=>{
        const id = threadIdOf(thread);
        if (id !== null)
        {
            queueing.add(id);
        }
    };
    /**
     * The sent messages a thread's procedures are inside, innermost last:
     * what InSendMessage and ReplyMessage answer about.
     *
     * @type {Map<number, SentMessage[]>}
     */
    const handling = new Map();

    /** @param {Map<number, SentMessage[]>} map @param {number} thread */
    const listOf = (map, thread)=>{
        let list = map.get(thread);
        if (!list)
        {
            list = [];
            map.set(thread, list);
        }
        return list;
    };

    /**
     * Answers a sent message, once: an answer ReplyMessage gave early is the
     * one the sender reads, whatever the procedure returns after it.
     *
     * @param {SentMessage} sent @param {number} result
     */
    const reply = (sent, result)=>{
        if (sent.replied)
        {
            return;
        }
        sent.replied = true;
        sent.result = result;
        // A notification from another process: nobody asks for its answer,
        // and what it lent is given back now.
        if (sent.elsewhere !== undefined && sent.kind === ISMEX_NOTIFY)
        {
            settleElsewhere(sent.elsewhere);
        }
        if (sent.kind === ISMEX_CALLBACK && sent.from !== null)
        {
            listOf(answered, sent.from).push(sent);
            host.queue.sent?.(sent.from);
        }
    };

    /**
     * Runs what other threads sent to this thread's windows, and the
     * callbacks its own SendMessageCallback is owed: what every look at a
     * thread's queue does before it looks for a posted message, and what a
     * thread waiting on a send of its own keeps doing, or two threads
     * sending to each other would each wait for ever.
     *
     * @param {unknown} thread
     * @returns {number | Promise<number>}
     */
    const receiveSent = thread=>{
        const id = threadIdOf(thread);
        if (id === null)
        {
            return 0;
        }
        const owed = answered.get(id)?.shift();
        if (owed)
        {
            return andThen(host.call?.(owed.callback,
                [owed.hwnd, owed.message, owed.data, owed.result], thread) ?? 0,
            ()=>receiveSent(thread));
        }
        const sent = inbox.get(id)?.shift();
        if (!sent)
        {
            return 0;
        }
        // Work another process asked of this thread, done on it.
        if (/** @type {any} */ (sent).run)
        {
            return andThen(/** @type {any} */ (sent).run(thread), ()=>receiveSent(thread));
        }
        const inside = listOf(handling, id);
        inside.push(sent);
        return andThen(send(sent.hwnd, sent.message, sent.wParam, sent.lParam, thread,
            sent.unicode), result=>{
            inside.splice(inside.lastIndexOf(sent), 1);
            reply(sent, result);
            return receiveSent(thread);
        });
    };

    /**
     * SendMessage and its relatives as a program calls them: to a window of
     * the caller's own thread the procedure runs now; to another thread's
     * the message waits for that thread to take it, and SendMessage waits
     * for the answer -- a notification and a message sent with a callback do
     * not. A window whose thread is not known is its caller's.
     *
     * @param {number} hwnd @param {number} message @param {number} wParam
     * @param {number} lParam @param {unknown} thread
     * @param {boolean} [unicode]
     * @param {{ kind?: number, timeout?: number, callback?: number, data?: number }} [how]
     *     `timeout` in milliseconds, for SendMessageTimeout.
     * @returns {number | null | Promise<number | null>} the answer; null when
     *     the timeout passed first
     */
    const sendAcross = (hwnd, message, wParam, lParam, thread, unicode = false, how = {})=>{
        if ((hwnd >>> 0) === HWND_BROADCAST)
        {
            return broadcastSend(message, wParam, lParam, thread, unicode, how);
        }
        const record = live(hwnd);
        if (!record && directory.describe(hwnd, processId))
        {
            return sendElsewhere(hwnd, message, wParam, lParam, thread, unicode, how);
        }
        const owner = record ? creatorOf(record) : null;
        const self = threadIdOf(thread);
        if (!record || owner === null || self === null || owner === self)
        {
            return send(hwnd, message, wParam, lParam, thread, unicode);
        }
        /** @type {SentMessage} */
        const sent = {
            hwnd: record.hwnd, message: message >>> 0, wParam: wParam >>> 0,
            lParam: lParam >>> 0, unicode, kind: how.kind ?? ISMEX_SEND, replied: false,
            result: 0, from: self, callback: how.callback ?? 0, data: how.data ?? 0,
        };
        listOf(inbox, owner).push(sent);
        host.queue.sent?.(owner);
        if (sent.kind !== ISMEX_SEND)
        {
            return 1;
        }
        const clock = host.now ?? (()=>0);
        const deadline = how.timeout === undefined ? Infinity : clock() + how.timeout;
        return (async()=>{
            while (!sent.replied)
            {
                // A window destroyed, or whose thread ended, answers nothing.
                if (!live(sent.hwnd) || clock() >= deadline)
                {
                    const waiting = inbox.get(owner) ?? [];
                    if (waiting.includes(sent))
                    {
                        waiting.splice(waiting.indexOf(sent), 1);
                    }
                    return live(sent.hwnd) ? null : 0;
                }
                await host.idle();
                await receiveSent(thread);
            }
            return sent.result;
        })();
    };

    /**
     * Every top-level window a broadcast reaches: this process's, in the
     * order they were made, then every other process's. A message-only window
     * is not top-level, and a child is not reached.
     */
    const broadcastTargets = ()=>{
        const targets = [...windows.values()]
            .filter(record=>!record.destroyed && record.parent === 0 && live(record.hwnd))
            .map(record=>record.hwnd);
        for (let at = directory.find(processId, 0, 0, null, null); at !== 0;
            at = directory.find(processId, 0, at, null, null))
        {
            targets.push(at);
        }
        return targets;
    };

    /**
     * SendMessage to HWND_BROADCAST: to each top-level window in turn, each
     * answer waited for as a send to it alone is -- a process that runs
     * nothing now is passed over -- and TRUE once all have been asked.
     *
     * @param {number} message @param {number} wParam @param {number} lParam
     * @param {unknown} thread @param {boolean} unicode
     * @param {{ kind?: number, timeout?: number }} how
     * @returns {number | Promise<number>}
     */
    const broadcastSend = (message, wParam, lParam, thread, unicode, how)=>{
        const targets = broadcastTargets();
        /** @param {number} at @returns {number | Promise<number>} */
        const next = at=>(at >= targets.length ? 1
            : andThen(sendAcross(targets[at], message, wParam, lParam, thread, unicode, how),
                ()=>next(at + 1)));
        return next(0);
    };

    /**
     * The bytes a terminated string occupies, terminator included.
     *
     * @param {number} address @param {boolean} wide
     */
    const terminatedBytes = (address, wide)=>{
        const width = wide ? 2 : 1;
        /** @type {number[]} */
        const bytes = [];
        for (let at = address; bytes.length < MAX_CARRIED_TEXT * width; at += 256)
        {
            const piece = host.readMemory(at, 256);
            for (let i = 0; i + width <= piece.length; i += width)
            {
                const unit = wide ? piece[i] | piece[i + 1] << 8 : piece[i];
                bytes.push(...piece.subarray(i, i + width));
                if (unit === 0)
                {
                    return Uint8Array.from(bytes);
                }
            }
            if (piece.length < 256)
            {
                break;
            }
        }
        return Uint8Array.from([...bytes, ...new Array(width).fill(0)]);
    };

    /**
     * What a message's pointers point at, as the bytes another process is
     * handed: the messages Windows itself carries between processes. Any
     * other is sent as its four words, as Windows sends it.
     *
     * @param {number} message @param {number} wParam @param {number} lParam
     * @param {boolean} unicode
     * @returns {import('./directory.js').SentRequest['carried']}
     */
    const carriedOf = (message, wParam, lParam, unicode)=>{
        if (message === WM_COPYDATA && lParam !== 0)
        {
            const [data, count, at] = [0, 4, 8].map(offset=>readU32(host, lParam + offset));
            const bytes = count > 0 && at !== 0 ? host.readMemory(at, count).slice()
                : new Uint8Array();
            return { kind: 'copydata', data, bytes };
        }
        if (message === WM_SETTEXT && lParam !== 0)
        {
            return { kind: 'text', bytes: terminatedBytes(lParam, unicode) };
        }
        if (message === WM_GETTEXT && lParam !== 0 && wParam !== 0)
        {
            return { kind: 'room',
                bytes: Math.min(wParam, MAX_CARRIED_TEXT) * (unicode ? 2 : 1) };
        }
        return null;
    };

    /**
     * SendMessage to another process's window: the message crosses as values,
     * and the caller waits for the answer the way it waits for another
     * thread's -- taking what is sent to its own windows meanwhile, or two
     * processes sending to each other would wait for ever.
     *
     * @param {number} hwnd @param {number} message @param {number} wParam
     * @param {number} lParam @param {unknown} thread @param {boolean} unicode
     * @param {{ kind?: number, timeout?: number }} how
     * @returns {number | null | Promise<number | null>} null when the timeout passed first
     */
    const sendElsewhere = (hwnd, message, wParam, lParam, thread, unicode, how)=>{
        const wait = (how.kind ?? ISMEX_SEND) === ISMEX_SEND;
        const sent = directory.send(processId, hwnd, {
            message: message >>> 0, wParam: wParam >>> 0, lParam: lParam >>> 0, unicode, wait,
            carried: carriedOf(message >>> 0, wParam >>> 0, lParam >>> 0, unicode),
        });
        if (!sent)
        {
            // A process that runs nothing now answers nothing: as a window
            // that does not answer in time.
            return how.timeout === undefined ? 0 : null;
        }
        if (!wait)
        {
            return 1;
        }
        const clock = host.now ?? (()=>0);
        const deadline = how.timeout === undefined ? Infinity : clock() + how.timeout;
        return (async()=>{
            for (;;)
            {
                const answer = directory.answer(sent);
                if (!answer)
                {
                    return 0;
                }
                if (answer.replied)
                {
                    if (answer.bytes)
                    {
                        host.writeMemory(lParam >>> 0, answer.bytes);
                    }
                    return answer.result ?? 0;
                }
                if (clock() >= deadline)
                {
                    directory.withdraw(sent);
                    return null;
                }
                await host.idle();
                await receiveSent(thread);
            }
        })();
    };

    /**
     * Messages other processes sent to this one's windows, by the number
     * each sender asks for its answer by, with the memory lent to carry what
     * their pointers pointed at.
     *
     * @type {Map<number, { sent: SentMessage, owner: number, lent: number,
     *     carried: import('./directory.js').SentRequest['carried'] }>}
     */
    const sentFromElsewhere = new Map();
    let nextElsewhere = 1;

    /**
     * A message from another process done with: what was lent for it goes
     * back to the heap.
     *
     * @param {number} id
     */
    const settleElsewhere = id=>{
        const entry = sentFromElsewhere.get(id);
        if (!entry)
        {
            return;
        }
        sentFromElsewhere.delete(id);
        const waiting = inbox.get(entry.owner) ?? [];
        if (waiting.includes(entry.sent))
        {
            waiting.splice(waiting.indexOf(entry.sent), 1);
        }
        if (entry.lent !== 0)
        {
            host.release?.(entry.lent);
        }
    };

    /**
     * Takes a message another process sent, as a thread of this one sends
     * one: into the inbox of the thread that made the window, with what it
     * carries put where the procedure can read it.
     *
     * @param {number} hwnd @param {import('./directory.js').SentRequest} request
     * @returns {number | null}
     */
    const receiveElsewhere = (hwnd, request)=>{
        const record = live(hwnd);
        const owner = record ? creatorOf(record) : null;
        if (!record || owner === null)
        {
            return null;
        }
        const carried = request.carried;
        let lParam = request.lParam;
        let lent = 0;
        if (carried)
        {
            const size = carried.kind === 'copydata'
                ? COPYDATASTRUCT_SIZE + carried.bytes.length
                : carried.kind === 'text' ? carried.bytes.length : carried.bytes;
            lent = host.allocate?.(Math.max(size, 1)) ?? 0;
            if (lent === 0)
            {
                return null;
            }
            if (carried.kind === 'copydata')
            {
                writeU32s(host, lent, [carried.data, carried.bytes.length,
                    carried.bytes.length > 0 ? lent + COPYDATASTRUCT_SIZE : 0]);
                host.writeMemory(lent + COPYDATASTRUCT_SIZE, carried.bytes);
            }
            else if (carried.kind === 'text')
            {
                host.writeMemory(lent, carried.bytes);
            }
            else
            {
                host.writeMemory(lent, new Uint8Array(carried.bytes));
            }
            lParam = lent;
        }
        const id = nextElsewhere++;
        /** @type {SentMessage} */
        const sent = {
            hwnd: record.hwnd, message: request.message, wParam: request.wParam, lParam,
            unicode: request.unicode, kind: request.wait ? ISMEX_SEND : ISMEX_NOTIFY,
            replied: false, result: 0, from: null, callback: 0, data: 0, elsewhere: id,
        };
        sentFromElsewhere.set(id, { sent, owner, lent, carried });
        listOf(inbox, owner).push(sent);
        host.queue.sent?.(owner);
        return id;
    };

    /**
     * Where a message from another process stands; its answer, once, and
     * with it what the procedure wrote into a buffer it was lent.
     *
     * @param {number} id
     * @returns {import('./directory.js').SentAnswer | null}
     */
    const answerElsewhere = id=>{
        const entry = sentFromElsewhere.get(id);
        if (!entry)
        {
            return null;
        }
        if (!entry.sent.replied)
        {
            if (live(entry.sent.hwnd))
            {
                return { replied: false };
            }
            settleElsewhere(id);
            return null;
        }
        const bytes = entry.carried?.kind === 'room'
            ? host.readMemory(entry.lent, entry.carried.bytes).slice() : undefined;
        settleElsewhere(id);
        return { replied: true, result: entry.sent.result, ...bytes ? { bytes } : {} };
    };

    /** @param {any} value @param {(answer: any) => any} then */
    const andThen = (value, then)=>(typeof value?.then === 'function'
        ? value.then(then)
        : then(value));

    /**
     * Runs `use` with a wide string turned into the ANSI page, in guest
     * memory the process heap lends for as long as the call takes; a null
     * pointer is handed on as null. Without a heap there is nowhere to put
     * the text, and the call fails.
     *
     * @param {number} wide
     * @param {(ansi: number) => number | Promise<number>} use
     */
    const asAnsi = (wide, use)=>{
        if ((wide >>> 0) === 0)
        {
            return use(0);
        }
        if (!host.allocate)
        {
            return 0;
        }
        let text = '';
        for (let at = wide >>> 0; text.length < 0x8000; at += 256)
        {
            const piece = host.readMemory(at, 256);
            let end = -1;
            for (let i = 0; i + 1 < piece.length; i += 2)
            {
                const unit = piece[i] | piece[i + 1] << 8;
                if (unit === 0)
                {
                    end = i;
                    break;
                }
                text += String.fromCharCode(unit);
            }
            if (end >= 0 || piece.length < 256)
            {
                break;
            }
        }
        const bytes = new Uint8Array(text.length + 1);
        bytes.set(encodeAnsi(text));
        const ansi = host.allocate(bytes.length);
        if (ansi === 0)
        {
            return 0;
        }
        host.writeMemory(ansi, bytes);
        return andThen(use(ansi), result=>{
            host.release?.(ansi);
            return result;
        });
    };

    /**
     * Whether every handle a wait names is one a poll can answer for whichever
     * thread asks, which is what a wait held across turns asks it from.
     *
     * @param {number} array  The guest's array of handles. @param {number} total
     */
    const pollable = (array, total)=>{
        const typeOf = host.handles.typeOf;
        if (!typeOf || array === 0)
        {
            return false;
        }
        for (let at = 0; at < total; at++)
        {
            if (!POLLED_KINDS.has(typeOf(readU32(host, array + at * 4)) ?? ''))
            {
                return false;
            }
        }
        return true;
    };

    /**
     * The window a FindWindow of either spelling answers with, or zero.
     *
     * Windows compares both names without regard to case, and searches in
     * creation order, which is the order the records are kept in.
     *
     * @param {number} parent  Zero for the top-level windows.
     * @param {number} after   Resume after this one, for a caller walking them.
     * @param {number} classPointer  A name or an atom; zero matches any class.
     * @param {number} namePointer   Zero matches any title.
     * @param {boolean} [unicode]     Whether the two names are wide strings.
     */
    const findWindow = (parent, after, classPointer, namePointer, unicode = false)=>{
        const cls = classPointer === 0 ? null : classOf(classPointer, unicode);
        // A class this process never registered can still be another's, named
        // by its string; an atom is only ever this process's to spell out.
        const className = classPointer === 0 ? null
            : cls?.name ?? ((classPointer >>> 0) > LAST_ATOM
                ? readText(host, classPointer >>> 0, unicode, MAX_CLASS_NAME) : null);
        if (classPointer !== 0 && className === null)
        {
            return 0;
        }
        const title = namePointer === 0
            ? null
            : readText(host, namePointer, unicode, MAX_WINDOW_TEXT);
        // This process's windows first, then every other process's: a walk
        // that has gone past the last of its own goes on in the next process.
        if (after !== 0 && !windows.has(after))
        {
            return directory.find(processId, parent, after, className, title);
        }
        const own = cls || classPointer === 0 ? findOwn(parent, after, className, title) : 0;
        return own !== 0 ? own : directory.find(processId, parent, 0, className, title);
    };

    /**
     * The first of this process's windows under `parent` and after `after`, in
     * creation order, whose class and title match without regard to case.
     *
     * @param {number} parent @param {number} after
     * @param {string | null} className  Null matches any class.
     * @param {string | null} title      Null matches any title.
     */
    const findOwn = (parent, after, className, title)=>{
        const cls = className?.toLowerCase() ?? null;
        const text = title?.toLowerCase() ?? null;
        let reached = after === 0;
        for (const record of windows.values())
        {
            if (!reached)
            {
                reached = record.hwnd === after;
                continue;
            }
            if (record.destroyed || record.parent !== parent)
            {
                continue;
            }
            if (cls !== null && String(record.className).toLowerCase() !== cls)
            {
                continue;
            }
            if (text !== null && record.title.toLowerCase() !== text)
            {
                continue;
            }
            return record.hwnd;
        }
        return 0;
    };

    /**
     * The desktop: the window every top-level window sits on, as
     * GetDesktopWindow names it. Made when a program first asks for it, and
     * kept out of the table the other windows are walked in: it is behind
     * all of them, never painted over them or found before them.
     *
     * @type {any}
     */
    let desktop = null;
    const desktopWindow = ()=>{
        if (!desktop)
        {
            desktop = {
                hwnd: 0, className: '#32769', title: '', style: DESKTOP_STYLE, exStyle: 0,
                parent: 0, owner: 0, instance: 0, id: 0, wndProc: 0, menu: 0, x: 0, y: 0,
                width: 0, height: 0, userData: 0, extra: new DataView(new ArrayBuffer(0)),
                destroyed: false, updateArea: null, updateRect: null, erase: false, ncDirty: false,
            };
            desktop.hwnd = DESKTOP_WINDOW;
        }
        return desktop;
    };

    /** @param {number} hwnd @returns {any | null} */
    const live = hwnd=>{
        if (desktop !== null && (hwnd >>> 0) === desktop.hwnd)
        {
            // The screen, whatever mode it was last switched to, and nothing
            // a program placed it at instead.
            desktop.x = 0;
            desktop.y = 0;
            desktop.width = host.screen?.width ?? DEFAULT_WIDTH;
            desktop.height = host.screen?.height ?? DEFAULT_HEIGHT;
            return desktop;
        }
        const record = windows.get(hwnd >>> 0);
        if (!record || record.destroyed)
        {
            return null;
        }
        if (record.thread?.state === 'terminated')
        {
            reap(record);
            return null;
        }
        return record;
    };

    /**
     * The thread that created a window, whose queue its messages wait in and
     * whose loop its procedure runs on; null when the bridge named none.
     *
     * @param {any} record
     * @returns {number | null}
     */
    const creatorOf = record=>threadIdOf(record.thread);

    /**
     * Takes down a window whose thread has ended, as Windows destroys a
     * thread's windows with it, and its children with it. No procedure is
     * told: the thread that would have run it is gone.
     *
     * @param {any} record
     */
    const reap = record=>{
        for (const child of [...windows.values()])
        {
            if (!child.destroyed && child.parent === record.hwnd && isChild(child))
            {
                reap(child);
            }
        }
        const watched = beforeChange(record);
        forget(record);
        afterChange(watched);
    };

    /** @param {any} record  Whether it is placed inside another window. */
    const isChild = record=>(record.style & WS_CHILD) !== 0;

    /** @param {any} record @returns {any} the top-level window it is inside */
    const topLevelOf = record=>{
        let at = record;
        while (isChild(at) && windows.get(at.parent))
        {
            at = windows.get(at.parent);
        }
        return at;
    };

    /**
     * The top-level window at the end of a window's owner chain: the one whose
     * popups GetLastActivePopup answers about. A chain a program looped with
     * SetWindowLong ends where it comes round.
     *
     * @param {any} record
     */
    const rootOwnerOf = record=>{
        let at = topLevelOf(record);
        const seen = new Set([at]);
        for (let owner = live(at.owner ?? 0); owner && !seen.has(topLevelOf(owner));
            owner = live(at.owner ?? 0))
        {
            at = topLevelOf(owner);
            seen.add(at);
        }
        return at;
    };

    /** @param {any} record @returns {any[]} its live children, in creation order */
    const childrenOf = record=>[...windows.values()]
        .filter(child=>!child.destroyed && child.parent === record.hwnd && isChild(child));

    /**
     * A window's children in the order their WM_PAINT comes: from the top of
     * their stacking down, except that a WS_EX_TRANSPARENT one waits for the
     * siblings beneath it, as its style promises -- so that a label over a
     * picture is drawn over the picture, and not first and then painted over.
     * Taken one window at a time the rule is "the first transparent window
     * gives way to the first opaque one beneath it"; applied until nothing is
     * left, that is every opaque sibling in its order, then every transparent
     * one in its order.
     *
     * @param {any} record
     */
    const paintedChildrenOf = record=>{
        const children = childrenOf(record);
        const transparent = (/** @type {any} */ child)=>(child.exStyle & WS_EX_TRANSPARENT) !== 0;
        return [...children.filter(child=>!transparent(child)), ...children.filter(transparent)];
    };

    /**
     * A window's descendants in the order they paint, each followed by its
     * own: what RDW_ALLCHILDREN sends WM_PAINT to after the window.
     *
     * @param {any} record
     * @returns {any[]}
     */
    const paintedDescendantsOf = record=>paintedChildrenOf(record)
        .flatMap(child=>[child, ...paintedDescendantsOf(child)]);

    /**
     * Every live window in the order it is painted: top-level windows from
     * the bottom up, each followed by its descendants in their painting
     * order.
     *
     * @returns {any[]}
     */
    const paintOrder = ()=>{
        // Every window's children gathered in one pass, in creation order, as
        // childrenOf finds them: a pass of every window for each window grew
        // with the square of every window a program ever made, which is what
        // a destroyed one stays among.
        /** @type {Map<number, any[]>} */
        const byParent = new Map();
        for (const record of windows.values())
        {
            if (!record.destroyed && isChild(record))
            {
                const siblings = byParent.get(record.parent);
                if (siblings)
                {
                    siblings.push(record);
                }
                else
                {
                    byParent.set(record.parent, [record]);
                }
            }
        }
        /** @type {any[]} */
        const listed = [];
        /** @param {any} record */
        const visit = record=>{
            listed.push(record);
            const children = byParent.get(record.hwnd);
            if (!children)
            {
                return;
            }
            // Opaque siblings first, then the transparent ones, as
            // paintedChildrenOf orders them.
            for (const child of children)
            {
                if ((child.exStyle & WS_EX_TRANSPARENT) === 0)
                {
                    visit(child);
                }
            }
            for (const child of children)
            {
                if ((child.exStyle & WS_EX_TRANSPARENT) !== 0)
                {
                    visit(child);
                }
            }
        };
        for (const record of windows.values())
        {
            if (!record.destroyed && !isChild(record))
            {
                visit(record);
            }
        }
        return listed;
    };

    /**
     * Whether paintOrder lists a window: it and every window it is placed
     * inside still standing, up to a top-level one.
     *
     * @param {any} record
     */
    const inPaintOrder = record=>{
        // Bounded: children a program looped into each other with SetParent
        // reach no top-level window, and paintOrder lists none of them.
        let steps = windows.size;
        for (let at = record; steps-- >= 0; at = windows.get(at.parent))
        {
            if (!at || at.destroyed)
            {
                return false;
            }
            if (!isChild(at))
            {
                return true;
            }
        }
        return false;
    };

    /**
     * The rectangles, in screen coordinates, of the windows over a window:
     * every shown top-level window stacked above its own; each shown sibling
     * above it, or above an ancestor, that clips its siblings -- as every
     * top-level window does; and with WS_CLIPCHILDREN its own shown
     * children. What its visible region leaves out, so that a window
     * repainting itself does not draw over the dialog in front of it. A
     * transparent window paints after what is beneath it and covers nothing.
     *
     * @param {any} record
     * @param {boolean} [withChildren]  Whether its own children count; a move
     *        that takes them along leaves them out.
     * @returns {import('../gdi32/rects.js').Rect[]}
     */
    const coveringOf = (record, withChildren = true)=>{
        /** @type {import('../gdi32/rects.js').Rect[]} */
        const covers = [];
        /** @param {any} each */
        const covering = each=>shown(each) && (each.exStyle & WS_EX_TRANSPARENT) === 0;
        const top = topLevelOf(record);
        let above = false;
        for (const each of windows.values())
        {
            if (each === top)
            {
                above = true;
            }
            else if (above && !each.destroyed && !isChild(each) && covering(each))
            {
                covers.push(...geometry.shapeRects(each));
            }
        }
        // What a window region leaves out of it and its ancestors: nothing of
        // it is shown there, and what is beneath shows instead.
        for (let at = record; at; at = isChild(at) ? windows.get(at.parent) : null)
        {
            covers.push(...geometry.holesOf(at));
        }
        for (let at = record; at && isChild(at); at = windows.get(at.parent))
        {
            if ((at.style & WS_CLIPSIBLINGS) === 0)
            {
                continue;
            }
            // Siblings are kept topmost first: those before it are over it.
            for (const sibling of childrenOf({ hwnd: at.parent }))
            {
                if (sibling === at)
                {
                    break;
                }
                if (covering(sibling))
                {
                    covers.push(...geometry.shapeRects(sibling));
                }
            }
        }
        if (withChildren && (record.style & WS_CLIPCHILDREN) !== 0)
        {
            for (const child of childrenOf(record))
            {
                if (shown(child))
                {
                    covers.push(...geometry.shapeRects(child));
                }
            }
        }
        return covers;
    };

    /**
     * Puts a top-level window on top of the others: last in the order the
     * records are kept in, which is the order they are painted and hit in.
     * What it now shows that the windows over it hid is marked to paint;
     * the rest of it still shows its pixels.
     *
     * @param {any} record
     * @param {boolean} [marks]  False when the caller marks what changed itself,
     *        as SetWindowPos does for the move it restacks with.
     */
    const raise = (record, marks = true)=>{
        const top = topLevelOf(record);
        if (windows.get(top.hwnd) !== top || [...windows.keys()].at(-1) === top.hwnd)
        {
            return;
        }
        const watched = marks && shown(top) ? beforeChange(top) : null;
        // Its descendants follow it, so that a walk in record order still
        // meets a parent before its children.
        const moved = [top, ...descendantsOf(top)];
        for (const each of moved)
        {
            windows.delete(each.hwnd);
        }
        for (const each of moved)
        {
            windows.set(each.hwnd, each);
        }
        directory.raise?.(top.hwnd);
        if (watched)
        {
            afterChange(watched);
        }
        tell(top);
        adoptOrder();
    };

    /**
     * Moves a child within its siblings' stacking -- which for children is
     * the order the records are kept in, topmost first -- as SetWindowPos's
     * hWndInsertAfter says: HWND_BOTTOM below them all, a sibling's handle
     * just below that sibling, and the top for anything else.
     *
     * What it now shows is marked to paint, and what it now hides of itself
     * shows what is beneath, which paints there.
     *
     * @param {any} record @param {number} after
     * @param {boolean} [marks]  As `raise`.
     */
    const restack = (record, after, marks = true)=>{
        const HWND_BOTTOM = 1;
        const watched = marks && shown(record) ? beforeChange(record) : null;
        const others = childrenOf({ hwnd: record.parent }).filter(each=>each !== record);
        const sibling = others.findIndex(each=>each.hwnd === (after >>> 0));
        const at = (after >>> 0) === HWND_BOTTOM ? others.length : sibling + 1;
        const order = [...others.slice(0, at), record, ...others.slice(at)];
        const moved = new Set(order);
        /** @type {any[]} */
        const kept = [];
        let placed = false;
        for (const each of windows.values())
        {
            if (!moved.has(each))
            {
                kept.push(each);
            }
            else if (!placed)
            {
                kept.push(...order);
                placed = true;
            }
        }
        windows.clear();
        for (const each of kept)
        {
            windows.set(each.hwnd, each);
        }
        if (watched)
        {
            afterChange(watched);
        }
        tell(record);
    };

    /** @param {any} record  Whether it and every ancestor is shown. */
    const shown = record=>{
        for (let at = record; at; at = isChild(at) ? windows.get(at.parent) : null)
        {
            if ((at.style & WS_VISIBLE) === 0)
            {
                return false;
            }
        }
        return true;
    };

    const geometry = createGeometry(hwnd=>windows.get(hwnd >>> 0) ?? null);

    /**
     * The window the program is active through.
     *
     * There is one process on this machine and its windows are the only ones
     * there are, so the foreground window is whichever of them was last shown
     * or given the focus -- and never nothing while a visible top-level window
     * exists. A program told that no window is in the foreground concludes it
     * has been put behind another, and one of this era then re-activates
     * itself every frame: it brings its window to the top, clips the cursor
     * again, and restarts whatever it plays when it comes back -- the menu
     * sliding in, the camera settling -- so the picture never stops arriving.
     */
    let active = 0;
    /**
     * Whether the run's foreground window is another process's: this one's
     * windows were told they lost it, and none of them is active until one is
     * activated again.
     */
    let foreignForeground = false;
    /** What WM_ACTIVATEAPP last told the application: false once it went. */
    let applicationActive = true;
    let deactivations = 0;
    const activeWindow = ()=>{
        if (active !== 0 && live(active))
        {
            return active;
        }
        if (foreignForeground)
        {
            return 0;
        }
        let candidate = 0;
        for (const record of windows.values())
        {
            if (!record.destroyed && (record.style & WS_VISIBLE) !== 0 && !isChild(record))
            {
                candidate = record.hwnd;
            }
        }
        return candidate;
    };
    /**
     * Makes a top-level window the active one, telling the window that loses
     * activation and the one that gains it, and moving the focus into it.
     *
     * Everything is sent, before the call that caused it returns -- SetFocus,
     * ShowWindow, CreateWindowEx with WS_VISIBLE, a click taken from the
     * queue -- in the order user32's message tests pin: WM_NCACTIVATE(0) and
     * WM_ACTIVATE(WA_INACTIVE) to the window losing it, WM_NCACTIVATE(1) and
     * WM_ACTIVATE to the one gaining it, then WM_KILLFOCUS and WM_SETFOCUS as
     * the focus follows (SetActiveWindowSeq2). When nothing of the program was
     * active the program itself becomes the active application, and each of
     * its top-level windows hears WM_ACTIVATEAPP(1) first (WmCreatePopupSeq).
     *
     * @param {number} hwnd
     * @param {{ thread?: unknown, how?: number,
     *     from?: { hwnd: number, thread: number } | null }} [options]
     *        `how` is WM_ACTIVATE's wParam for the window gaining it:
     *        WA_CLICKACTIVE when a click did it.
     * @returns {number | Promise<number>} once every procedure told has answered
     */
    const activate = (hwnd, options = {})=>{
        const record = live(hwnd);
        const target = record ? topLevelOf(record).hwnd : 0;
        if (target === 0 || target === active)
        {
            return activateNow(hwnd, options);
        }
        // A CBT hook hears first, while the window losing activation is
        // still the active one, and may forbid it.
        return andThen(askActivate(target, options.how ?? WA_ACTIVE,
            options.thread ?? host.callerThread?.()),
        refused=>((refused | 0) !== 0 ? 0 : activateNow(hwnd, options)));
    };

    /**
     * HCBT_ACTIVATE, whose lParam is a CBTACTIVATESTRUCT: whether a click
     * did it, and the window active until now.
     *
     * @param {number} target @param {number} how @param {unknown} thread
     * @returns {number | Promise<number>}
     */
    const askActivate = (target, how, thread)=>{
        if (chainOf(WH_CBT, thread).length === 0)
        {
            return 0;
        }
        const at = host.allocate?.(8) ?? 0;
        if (at !== 0)
        {
            writeU32s(host, at, [how === WA_CLICKACTIVE ? 1 : 0, active]);
        }
        return andThen(callHook(WH_CBT, null, [HCBT_ACTIVATE, target, at], thread), answer=>{
            if (at !== 0)
            {
                host.release?.(at);
            }
            return answer;
        });
    };

    /**
     * The activation itself, once nothing has forbidden it.
     *
     * @param {number} hwnd
     * @param {{ thread?: unknown, how?: number,
     *     from?: { hwnd: number, thread: number } | null }} options
     *     `from`: the window and thread of another program that had the
     *     foreground, when that program made this window the foreground one
     * @returns {number | Promise<number>}
     */
    const activateNow = (hwnd, { thread, how = WA_ACTIVE, from = null })=>{
        const record = live(hwnd);
        const previous = active;
        // The run's foreground window as it was, before the focus moving
        // into this one makes this one the run's.
        const runBefore = directory.foreground?.() ?? 0;
        active = record ? topLevelOf(record).hwnd : 0;
        if (record)
        {
            rootOwnerOf(record).lastActivePopup = active;
        }
        // The keyboard follows activation: a focus outside the window that
        // became active is moved to it, as DefWindowProc's WM_ACTIVATE moves
        // it. A caller that placed the focus itself -- SetFocus -- tells it.
        const current = focusWindow();
        const moved = active !== 0
            && (current === 0 || topLevelOf(live(current)).hwnd !== active);
        if (moved)
        {
            holdFocus(active);
        }
        if (active === previous)
        {
            return 0;
        }
        const gained = active;
        // A window of the program's is the run's foreground window now; the
        // one before it, another program's, is named to it below.
        let foreign = 0;
        let foreignThread = 0;
        if (gained !== 0 && gained !== desktop?.hwnd)
        {
            // Another program activated this window and moved the run's
            // foreground to it already, saying whose it had been.
            const prior = from ? from.hwnd : runBefore;
            if (prior !== 0 && directory.ownerOf(prior) !== processId)
            {
                foreign = prior;
                foreignThread = from ? from.thread : directory.stateOf?.(prior)?.threadId ?? 0;
            }
            foreignForeground = false;
            directory.setForeground?.(gained);
            // Made the foreground window, it came to the top of its band.
            adoptOrder();
        }
        else
        {
            // The desktop, or nothing: the run's foreground window, when it
            // was this program's, is no window now.
            const prior = directory.foreground?.() ?? 0;
            if (prior !== 0 && directory.ownerOf(prior) === processId)
            {
                directory.setForeground?.(0);
            }
        }
        /** @type {[number, number, number, number][]} */
        const told = [];
        if (previous !== 0)
        {
            told.push([previous, WM_NCACTIVATE, 0, 0],
                [previous, WM_ACTIVATE, WA_INACTIVE, gained]);
        }
        // The program is the active application or stops being it when the
        // activation comes from, or goes to, nothing or the desktop -- the
        // one window here that is not the program's -- or another program's
        // window. lParam names the thread on the other side: that program's.
        /** @param {number} which */
        const programs = which=>which !== 0 && which !== desktop?.hwnd;
        if (programs(previous) !== programs(gained))
        {
            applicationActive = programs(gained);
            deactivations += applicationActive ? 0 : 1;
            for (const top of [...windows.values()]
                .filter(each=>!each.destroyed && !isChild(each)).reverse())
            {
                told.push([top.hwnd, WM_ACTIVATEAPP, programs(gained) ? 1 : 0, foreignThread]);
            }
        }
        if (gained !== 0)
        {
            told.push([gained, WM_NCACTIVATE, 1, 0],
                [gained, WM_ACTIVATE, how, previous !== 0 ? previous : foreign]);
        }
        /** @param {number} index @returns {number | Promise<number>} */
        const tell = index=>{
            if (index >= told.length)
            {
                return 0;
            }
            const [target, message, wParam, lParam] = told[index];
            return andThen(live(target) ? send(target, message, wParam, lParam, thread) : 0,
                ()=>tell(index + 1));
        };
        if (!moved)
        {
            return tell(0);
        }
        // The focus follows as SetFocus moves it, a CBT hook first: one that
        // forbids it leaves the focus where it was.
        return andThen(tell(0), ()=>andThen(askCbt(HCBT_SETFOCUS, gained, current,
            thread ?? host.callerThread?.()), refused=>{
            if ((refused | 0) !== 0)
            {
                holdFocus(current);
                return 0;
            }
            return andThen(current !== 0 && live(current)
                ? send(current, WM_KILLFOCUS, gained, 0, thread) : 0,
            ()=>(live(gained) ? send(gained, WM_SETFOCUS, current, 0, thread) : 0));
        }));
    };

    /**
     * The window the keyboard goes to. Separate from the active window: the
     * active one is a top-level window, the focus is usually a control in
     * it, and both are asked for by name.
     */
    //
    // There is one focus for every program, and it is the run's: this program
    // keeps no copy of it, and reads where the run keeps it (`manager.js`'s
    // cells). One of its windows has the focus when that word names it.
    const focusWindow = ()=>{
        const held = directory.focus?.() ?? 0;
        return held !== 0 && live(held) ? held : 0;
    };
    /**
     * A window of this program takes the focus, from every window of every
     * program (`manager.setFocus`), or this program lets it go. The run lists
     * the window first, if it has not yet, as one taking the focus while it
     * is being made does.
     *
     * @param {number} hwnd
     */
    const holdFocus = hwnd=>{
        const record = live(hwnd);
        if (record)
        {
            tell(record);
        }
        directory.noteFocus?.(hwnd, processId);
    };
    /**
     * Moves the focus, telling the window that loses it and the one that
     * gains it -- in that order, as Windows sends them -- and activating the
     * new one's top-level window.
     *
     * @param {number} hwnd  Zero takes the focus from everything.
     * @param {unknown} [thread]
     * @returns {number | Promise<number>} the window that had it
     */
    const setFocus = (hwnd, thread)=>{
        const previous = focusWindow();
        const target = hwnd >>> 0;
        if (target !== 0 && !live(target))
        {
            return 0;
        }
        if (previous === target)
        {
            return previous;
        }
        const on = thread ?? host.callerThread?.();
        // A CBT hook hears first, and may forbid it: then nothing moves.
        return andThen(askCbt(HCBT_SETFOCUS, target, previous, on), refused=>{
            if ((refused | 0) !== 0)
            {
                return 0;
            }
            holdFocus(target);
            // Activation is told first, then the focus: a window gaining both
            // hears WM_ACTIVATE before WM_SETFOCUS.
            const activated = target !== 0 ? activate(target, { thread: on }) : 0;
            return andThen(activated, ()=>
                andThen(previous !== 0 ? send(previous, WM_KILLFOCUS, target, 0, on) : 0,
                    ()=>andThen(target !== 0 ? send(target, WM_SETFOCUS, previous, 0, on) : 0,
                        ()=>previous)));
        });
    };

    /** The window that has the mouse, or zero. */
    let captured = 0;
    /** @param {number} hwnd */
    const setCapture = hwnd=>{
        const previous = captured;
        captured = live(hwnd) ? hwnd >>> 0 : 0;
        // The run routes the page's pointer to the window holding it.
        directory.noteCapture?.(captured, processId);
        if (dragged && !insideOf(live(captured), dragged.record))
        {
            endDrag();
        }
        return previous;
    };
    const releaseCapture = ()=>{
        const previous = captured;
        captured = 0;
        directory.noteCapture?.(0, processId);
        endDrag();
        if (previous !== 0 && live(previous))
        {
            host.queue.post({ hwnd: previous, message: WM_CAPTURECHANGED, wParam: 0, lParam: 0 });
        }
    };

    /**
     * @param {import('./structs.js').WindowClassFields} fields
     * @param {boolean} [unicode]  registered through the wide form, so its
     *     procedure reads wide text
     * @returns {number} the atom, or zero if the class cannot be registered
     */
    const register = (fields, unicode = false)=>{
        // A class is named by a string here: an atom is what registration
        // produces, never something it can be handed.
        if ((fields.className >>> 0) <= LAST_ATOM)
        {
            return 0;
        }
        const name = readText(host, fields.className, unicode, MAX_CLASS_NAME);
        if (name.length === 0 || classes.has(name) || nextAtom > LAST_ATOM)
        {
            return 0;
        }
        const atom = nextAtom++;
        classes.set(name, { ...fields, name, atom, unicode });
        atoms.set(atom, name);
        return atom;
    };

    /**
     * Forgets a class, which only a class with no window left may be.
     *
     * @param {number} className  A name or an atom.
     * @param {boolean} unicode   Whether the name is a wide string.
     */
    const unregister = (className, unicode)=>{
        const cls = classOf(className, unicode);
        if (!cls || !classes.has(cls.name))
        {
            return 0;
        }
        for (const record of windows.values())
        {
            if (record.className === cls.name && !record.destroyed)
            {
                return 0;
            }
        }
        classes.delete(cls.name);
        atoms.delete(cls.atom);
        return 1;
    };

    /**
     * A window's text back into the program's memory, NUL-terminated, in the
     * ANSI page it was read in: a caption holds the euro sign where the
     * program wrote 0x80, and 0x80 is what it reads back.
     *
     * @param {number} address @param {string} text
     */
    const writeString = (address, text)=>{
        const bytes = new Uint8Array(text.length + 1);
        bytes.set(encodeAnsi(text));
        host.writeMemory(address, bytes);
    };

    /**
     * @param {number} value
     * @param {number} fallback  Used when the guest asked the system to choose.
     */
    const coordinate = (value, fallback)=>
        (value >>> 0) === CW_USEDEFAULT ? fallback : (value | 0);

    /**
     * Destroys a window and everything that hangs off it. A child outliving its
     * parent is a handle nobody is left to close.
     *
     * WM_DESTROY is *sent*: the window procedure runs before this returns,
     * while whatever the program keeps behind the window still exists. A
     * program that destroys its window and then frees the object the
     * procedure reads through GWL_USERDATA is entitled to that order, and
     * one handed the message later, from its queue, called into freed
     * memory. Then the children go, then WM_NCDESTROY, the last message a
     * window sees, and only then does the handle stop resolving.
     *
     * A window whose creation failed part way is taken down with less: one
     * refused by the CBT hook never existed to its procedure and hears
     * nothing; one whose WM_CREATE answered -1 hears WM_NCDESTROY alone.
     *
     * @param {number} hwnd @param {unknown} [thread]
     * @param {'all' | 'ncdestroy' | 'none'} [told]  Which of the two it hears.
     * @returns {number | Promise<number>} 1 when there was a window to destroy
     */
    const destroyWindow = (hwnd, thread, told = 'all')=>{
        const record = live(hwnd);
        if (!record || record === desktop)
        {
            return 0;
        }
        host.queue.purge(record.hwnd);
        // Its timers go with it. Windows destroys them, and one left behind
        // would go on making WM_TIMER for a window that no longer exists.
        host.queue.killTimersFor?.(record.hwnd);
        // So do its hot keys: one left registered would keep eating the
        // keystroke for a window that can no longer be delivered to.
        host.queue.unregisterHotKeysFor?.(record.hwnd);
        const on = thread ?? host.callerThread?.();
        /** @param {number} message @returns {number | Promise<number>} */
        const tell = message=>(told === 'all' || (told === 'ncdestroy' && message === WM_NCDESTROY)
            ? send(record.hwnd, message, 0, 0, on)
            : 0);
        return andThen(tell(WM_DESTROY), ()=>{
            // Its children and the windows it owns go with it.
            const children = [...windows.values()].filter(child=>child !== record
                && !child.destroyed
                && (child.parent === record.hwnd || child.owner === record.hwnd));
            /** @param {number} index @returns {number | Promise<number>} */
            const destroyChildren = index=>(index < children.length
                ? andThen(destroyWindow(children[index].hwnd, on, told),
                    ()=>destroyChildren(index + 1))
                : 1);
            return andThen(destroyChildren(0),
                ()=>andThen(tell(WM_NCDESTROY), ()=>{
                    // What it shows is read as it goes: its children went
                    // before it, and what they left is its own now.
                    const watched = beforeChange(record);
                    forget(record);
                    if (!watched.wasShown)
                    {
                        return 1;
                    }
                    afterChange(watched);
                    return andThen(eraseShown(on), ()=>1);
                }));
        });
    };

    /**
     * DestroyWindow as a program calls it: only the thread that made the
     * window may, another is refused with ERROR_ACCESS_DENIED (msg.c
     * test_interthread_messages); a CBT hook hears first, and one that
     * answers non-zero keeps the window.
     *
     * @param {number} hwnd @param {unknown} [thread]
     * @returns {number | Promise<number>}
     */
    const destroyAsked = (hwnd, thread)=>{
        const record = live(hwnd);
        if (!record || record === desktop)
        {
            host.setLastError?.(ERROR_INVALID_WINDOW_HANDLE);
            return 0;
        }
        const on = thread ?? host.callerThread?.();
        const maker = creatorOf(record);
        const asking = threadIdOf(on);
        if (maker !== null && asking !== null && maker !== asking)
        {
            host.setLastError?.(ERROR_ACCESS_DENIED);
            return 0;
        }
        return andThen(askCbt(HCBT_DESTROYWND, record.hwnd, 0, on),
            refused=>((refused | 0) !== 0 ? 0 : destroyWindow(record.hwnd, on)));
    };

    /**
     * The end of a window, once its procedure has heard the last it will:
     * the handle stops resolving, and nothing it held is left behind.
     *
     * @param {any} record
     */
    const forget = record=>{
        host.queue.purge(record.hwnd);
        host.queue.killTimersFor?.(record.hwnd);
        host.queue.unregisterHotKeysFor?.(record.hwnd);
        record.destroyed = true;
        layoutRevision++;
        // A dialog's font is the dialog manager's, made from its template,
        // and goes with the dialog.
        if (record.dialogFont)
        {
            draw?.deleteFont?.(record.dialogFont);
        }
        directory.close(record.hwnd);
        toldRun.delete(record.hwnd);
        paint.forgetContexts(record);
        if (active === record.hwnd)
        {
            active = 0;
        }
        if ((directory.focus?.() ?? 0) === record.hwnd)
        {
            holdFocus(0);
        }
        if (captured === record.hwnd)
        {
            captured = 0;
        }
        if (tracking?.hwnd === record.hwnd)
        {
            stopTracking();
        }
        // Its menu goes with it, as DestroyWindow is documented to destroy
        // it; one a program took back with SetMenu is its own again.
        if ((record.menu ?? 0) !== 0)
        {
            table.DestroyMenu.handler([record.menu]);
        }
    };

    /** @param {any} record @param {number} index */
    const readLong = (record, index)=>{
        switch (index | 0){
            case GWL_WNDPROC:
                return record.wndProc;
            case GWL_HINSTANCE:
                return record.instance;
            case GWL_HWNDPARENT:
                // The parent, or for a window on the desktop its owner.
                return record.parent !== 0 ? record.parent : record.owner ?? 0;
            case GWL_ID:
                return record.id;
            case GWL_STYLE:
                return record.style;
            case GWL_EXSTYLE:
                return record.exStyle;
            case GWL_USERDATA:
                return record.userData;
            default:
                break;
        }
        const at = index | 0;
        // Anything outside the extra bytes the class asked for is not this
        // window's storage, and reading it would be reading somebody else's.
        return at >= 0 && at + 4 <= record.extra.byteLength ? record.extra.getUint32(at, true) : 0;
    };

    /**
     * @param {any} record @param {number} index @param {number} value
     * @param {boolean} [unicode]  Set through SetWindowLongW: a procedure set
     *     so reads wide text, and one set through the ANSI form reads bytes.
     */
    const writeLong = (record, index, value, unicode = false)=>{
        switch (index | 0){
            case GWL_WNDPROC:
                record.wndProc = value >>> 0;
                record.unicode = unicode;
                return;
            case GWL_HWNDPARENT:
                // A window on the desktop is given an owner this way; any
                // other is moved to another parent.
                if (record.parent === 0)
                {
                    record.owner = value >>> 0;
                }
                else
                {
                    record.parent = value >>> 0;
                }
                tell(record);
                return;
            case GWL_ID:
                record.id = value >>> 0;
                return;
            case GWL_STYLE:
                // A top-level window clips its siblings whatever it is given,
                // and the window edge follows the frame it now has.
                record.style = (record.parent === 0 ? value | WS_CLIPSIBLINGS : value) >>> 0;
                record.exStyle = edgeFor(record.style, record.exStyle);
                tell(record);
                return;
            case GWL_EXSTYLE:
                record.exStyle = edgeFor(record.style, value);
                tell(record);
                return;
            case GWL_USERDATA:
                record.userData = value >>> 0;
                return;
            case GWL_HINSTANCE:
                record.instance = value >>> 0;
                return;
            default:
                break;
        }
        const at = index | 0;
        if (at >= 0 && at + 4 <= record.extra.byteLength)
        {
            record.extra.setUint32(at, value >>> 0, true);
        }
    };

    /**
     * A retrieved message as the retrieving call's encoding reads it: a
     * character posted by one kind of caller, or made by TranslateMessage out
     * of a key, reaches the other kind as its own code for the character.
     *
     * @param {any} entry @param {boolean} unicode  The retrieving call's.
     */
    const retrieved = (entry, unicode)=>(CHARACTER_MESSAGES.has(entry.message >>> 0)
        && (entry.unicode === true) !== unicode
        ? { ...entry, wParam: convertCharacter(entry.wParam, unicode), unicode }
        : entry);

    /**
     * @param {number} hwnd  The window filter PeekMessage and GetMessage take.
     * @returns {number | null}
     */
    const windowFilter = hwnd=>{
        const value = hwnd >>> 0;
        if (value === 0)
        {
            return ANY_WINDOW;
        }
        return value === HWND_THREAD_MESSAGES ? 0 : value;
    };

    /**
     * Delivers a retrieved message to the procedure it is for: what
     * DispatchMessage does, and what a modal loop does in its own pump.
     *
     * @param {DispatchedMessage & { time?: number }} message
     * @param {unknown} [thread]  Whose call this answers, when the caller has awaited.
     * @returns {number | Promise<number>}
     */
    const deliver = (message, thread)=>{
        // A timer that named a TIMERPROC is called instead of the window
        // procedure, and that is the whole reason a timer may have no window
        // at all: the procedure is where it goes.
        if (message.message === WM_TIMER && message.lParam !== 0)
        {
            // Only a procedure a live timer registered: anyone can post a
            // WM_TIMER, and its lParam is otherwise an address to call that
            // the poster chose. Windows drops such a message undispatched.
            if (host.queue.isTimerProc
                && !host.queue.isTimerProc(message.hwnd, message.wParam, message.lParam))
            {
                return 0;
            }
            return host.dispatch(message.lParam >>> 0, {
                ...message,
                // A TIMERPROC takes the tick count where a window procedure
                // takes the lParam.
                lParam: message.time ?? 0,
            }, thread);
        }
        // Not `live`: a WM_DESTROY still has to reach the procedure of the
        // window it is telling about its own end.
        const record = windows.get(message.hwnd);
        if (!record)
        {
            return 0;
        }
        if (record.wndProc === 0)
        {
            // A window of a class nobody supplied a procedure for: the
            // message goes where a procedure would have sent it anyway, to
            // the default one, which is what keeps a WM_PAINT for such a
            // window from being retrieved for ever.
            return translated(host, message, false, ansi=>table.DefWindowProcA.handler(
                [ansi.hwnd, ansi.message, ansi.wParam, ansi.lParam]));
        }
        // Whatever comes back is the answer, including a promise: running a
        // window procedure means running guest code, and the bridge suspends
        // this call until it returns.
        return callProcedure(record.wndProc, message, thread);
    };

    /**
     * Hooks, in the order they were installed: the newest is called first and
     * reaches the older ones through CallNextHookEx. Only a CBT hook is ever
     * called, and only for a window being created, which is what a framework
     * installs one for -- to attach its own object to the window before the
     * window's procedure runs.
     *
     * A hook set for one thread hears what happens on that thread alone; one
     * set for none -- a global hook -- hears every thread of the process. A
     * chain on a thread is its own hooks, newest first, and after them the
     * global ones, newest first: the last of a thread's own passes on to the
     * newest global hook.
     *
     * @type {{ handle: number, type: number, proc: number, thread: number }[]}
     */
    const hooks = [];

    /**
     * Whether a hook hears what a thread does. A caller the bridge names
     * without an identifier is a build with no scheduler, and its one
     * thread is every thread.
     *
     * @param {{ thread: number }} hook @param {unknown} thread
     */
    const hears = (hook, thread)=>{
        const id = threadIdOf(thread);
        return hook.thread === 0 || id === null || hook.thread === id;
    };

    /**
     * A thread's chain of hooks of a type, in the order they are called.
     *
     * @param {number} type @param {unknown} thread
     */
    const chainOf = (type, thread)=>{
        const heard = hooks.filter(hook=>hook.type === type && hears(hook, thread)).reverse();
        return [...heard.filter(hook=>hook.thread !== 0), ...heard.filter(hook=>hook.thread === 0)];
    };

    /**
     * Calls the first hook of a thread's chain of a type, or the one after `after`.
     *
     * @param {number} type @param {number | null} after  A hook handle, or null for the first.
     * @param {number[]} args @param {unknown} thread
     * @returns {number | Promise<number>} what the hook answered; 0 with none to call.
     */
    const callHook = (type, after, args, thread)=>{
        const chain = chainOf(type, thread);
        // A hook not in this thread's chain has nothing after it here.
        const next = after === null ? chain[0] : chain.findIndex(hook=>hook.handle === after) < 0
            ? undefined : chain[chain.findIndex(hook=>hook.handle === after) + 1];
        return next && host.call ? host.call(next.proc, args, thread) : 0;
    };

    /**
     * Asks a thread's CBT hooks about what is about to happen to a window;
     * an answer other than zero forbids it. A thread with no CBT hook is
     * asked nothing, and nothing waits.
     *
     * @param {number} code @param {number} wParam @param {number} lParam
     * @param {unknown} thread
     * @returns {number | Promise<number>}
     */
    const askCbt = (code, wParam, lParam, thread)=>(chainOf(WH_CBT, thread).length === 0 ? 0
        : callHook(WH_CBT, null, [code, wParam >>> 0, lParam >>> 0], thread));

    /**
     * A window record and the handle that names it, with everything a window
     * has defaulted.
     *
     * Separate from CreateWindowExA because not every window comes from that
     * call: a dialog's controls are windows of system classes this build does
     * not register, and they still need real handles that DestroyWindow,
     * GetWindowTextA and the message queue all work on.
     *
     * @param {any} fields
     */
    const makeWindow = fields=>{
        const record = {
            hwnd: 0,
            className: '',
            title: '',
            style: 0,
            exStyle: 0,
            parent: 0,
            instance: 0,
            id: 0,
            wndProc: 0,
            // Whether the procedure reads wide text: IsWindowUnicode.
            unicode: false,
            menu: 0,
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            userData: 0,
            extra: new DataView(new ArrayBuffer(0)),
            destroyed: false,
            // The update region, its rectangles and the one around them
            // (paint.js `setUpdate`).
            /** @type {{ left: number, top: number, right: number, bottom: number }[] | null} */
            updateArea: null,
            /** @type {{ left: number, top: number, right: number, bottom: number } | null} */
            updateRect: null,
            erase: false,
            ncDirty: false,
            // The thread whose call made it: its messages wait in that
            // thread's queue, and it ends with that thread.
            thread: host.callerThread?.() ?? null,
            ...fields,
        };
        // hWndParent names the parent of a child window and the owner of any
        // other, which sits on the desktop: the top-level window of what it
        // names, since only a top-level window owns another. A message-only
        // window keeps the parent that makes it one.
        if (record.owner === undefined)
        {
            record.owner = 0;
            if ((record.style & (WS_CHILD | WS_POPUP)) !== WS_CHILD && record.parent !== 0
                && record.parent !== HWND_MESSAGE)
            {
                const named = windows.get(record.parent);
                record.owner = named && !named.destroyed ? topLevelOf(named).hwnd : 0;
                record.parent = 0;
            }
        }
        // A system class supplies the procedure and the name a program reads
        // back: `#128` in a template is the Button class.
        const system = systemClasses.has(String(record.className).toLowerCase())
            ? classNamed(String(record.className)) : null;
        if (system && record.wndProc === 0)
        {
            record.className = system.name;
            record.wndProc = system.wndProc;
            if (record.extra.byteLength < system.windowExtra)
            {
                record.extra = new DataView(new ArrayBuffer(system.windowExtra));
            }
        }
        record.hwnd = directory.open(processId);
        windows.set(record.hwnd, watchFields(record));
        hasQueue(record.thread);
        if ((record.style & WS_VISIBLE) !== 0)
        {
            appear(record);
        }
        tell(record);
        return record;
    };

    /**
     * A top-level window created visible is activated once it has been told
     * it is shown, as CreateWindowEx activates it (WmCreatePopupSeq); a child,
     * or a window refused on the way, is not.
     *
     * @param {any} record @param {unknown} thread
     * @returns {number | Promise<number>}
     */
    const activateCreated = (record, thread)=>((record.style & WS_VISIBLE) !== 0
        && !isChild(record) && live(record.hwnd) ? activate(record.hwnd, { thread }) : 0);

    /**
     * CreateWindowExA and CreateWindowExW, and the forms without the extended
     * style once its missing argument is filled in.
     *
     * A window of a program's class reads text in the encoding its class was
     * registered in; one of a system class, whose procedure takes both, in the
     * encoding of the call that created it -- which is what IsWindowUnicode
     * then answers.
     *
     * @param {number[]} args  The extended style first, then the eleven that
     *                         both entry points share.
     * @param {boolean} [unicode]  Whether the two names are wide strings.
     * @param {unknown} [caller]  The thread whose call this answers, named by
     *     a caller that is past an await.
     */
    const createWindow = (args, unicode = false, caller = undefined)=>{
        const child = mdi.childOf(args);
        if (child?.refused || (!child && (args[0] & WS_EX_MDICHILD) !== 0))
        {
            // WS_EX_MDICHILD names a child of an MDI client: anywhere else, or
            // a popup under MDIS_ALLCHILDSTYLES, it is no window at all.
            return 0;
        }
        return child ? createMdiChild(child, args, unicode, caller)
            : makeWindowFor(args, unicode, caller);
    };

    /**
     * Empties a text buffer the program handed over, answering whether it
     * could: zero, or an address nothing is mapped at, cannot be written.
     *
     * @param {number} out @param {number} width  Of a character, in bytes.
     */
    const emptied = (out, width)=>{
        if ((out >>> 0) === 0)
        {
            return false;
        }
        try
        {
            host.writeMemory(out >>> 0, new Uint8Array(width));
            return true;
        }
        catch {
            return false;
        }
    };

    /**
     * WM_NCCALCSIZE: the procedure is handed where the window goes, in its
     * parent's client coordinates, and answers where its client area is in
     * it -- in an NCCALCSIZE_PARAMS, with the old rectangles and the
     * WINDOWPOS, when SetWindowPos asks. DefWindowProc answers the style's
     * frame; a procedure that answers otherwise has its client area where it
     * said (msg.c WmCreateOverlappedSeq; MSDN WM_NCCALCSIZE).
     *
     * @param {any} record
     * @param {{ x: number, y: number, width: number, height: number }} placed
     * @param {unknown} thread
     * @param {number} [pos]  the WINDOWPOS SetWindowPos places it with
     * @returns {number | Promise<number>}
     */
    const calcClient = (record, placed, thread, pos = 0)=>{
        const NCCALCSIZE_PARAMS_SIZE = 52;
        const at = host.allocate?.(pos !== 0 ? NCCALCSIZE_PARAMS_SIZE : 16) ?? 0;
        if (at === 0)
        {
            return 0;
        }
        const window = { left: placed.x, top: placed.y, right: placed.x + placed.width,
            bottom: placed.y + placed.height };
        const words = [window.left, window.top, window.right, window.bottom];
        if (pos !== 0)
        {
            const edges = geometry.frame(record);
            const old = [record.x, record.y, record.x + record.width, record.y + record.height];
            words.push(...old, old[0] + edges.left, old[1] + edges.top, old[2] - edges.right,
                old[3] - edges.bottom, pos);
        }
        writeU32s(host, at, words);
        return andThen(send(record.hwnd, WM_NCCALCSIZE, pos !== 0 ? 1 : 0, at, thread), ()=>{
            const view = new DataView(host.readMemory(at, 16).slice().buffer);
            const [left, top, right, bottom] = [0, 4, 8, 12]
                .map(offset=>view.getInt32(offset, true));
            host.release?.(at);
            const style = geometry.styleFrame(record);
            const inset = { left: left - window.left, top: top - window.top,
                right: window.right - right, bottom: window.bottom - bottom };
            record.ncFrame = inset.left === style.left && inset.top === style.top
                && inset.right === style.right && inset.bottom === style.bottom ? null
                : { left: Math.max(0, inset.left), top: Math.max(0, inset.top),
                    right: Math.max(0, inset.right), bottom: Math.max(0, inset.bottom) };
            return 0;
        });
    };

    /**
     * What a scroll leaves to be painted, worked out on regions rather than
     * the strip along one edge. Only the pixels inside `clip` move, and
     * only there do they land: of the part of `scroll` that changes -- in
     * `clip` and in what the context shows -- what the moved pixels cover
     * is good; the rest is not: the strip moved away from, what would have
     * come in from outside `clip`, and where the pixels came from a part
     * that does not show, as under a sibling over the window (win.c
     * test_scrollvalidate, dce.c test_scroll_window; MSDN ScrollWindowEx).
     *
     * @param {Rect[]} visible  What the context draws in.
     * @param {Rect} scroll @param {Rect} clip
     * @param {number} dx @param {number} dy
     * @returns {{ changed: Rect[], uncovered: Rect[] }}
     */
    const scrollAreas = (visible, scroll, clip, dx, dy)=>{
        const changed = intersectAreas(intersectAreas(visible, [scroll]), [clip]);
        const moved = intersectAreas(intersectAreas(offsetArea(changed, dx, dy), [clip]), visible);
        return { changed, uncovered: subtractAreas(changed, moved) };
    };

    /**
     * Moves the pixels of a scroll within the context, and answers what it
     * leaves to be painted.
     *
     * @param {number} hdc @param {Rect[]} visible
     * @param {Rect} scroll @param {Rect} clip
     * @param {number} dx @param {number} dy
     */
    const scrollPixels = (hdc, visible, scroll, clip, dx, dy)=>{
        if (dx === 0 && dy === 0)
        {
            return { changed: [], uncovered: [] };
        }
        const areas = scrollAreas(visible, scroll, clip, dx, dy);
        if (hdc !== 0 && areas.changed.length > 0)
        {
            // The context is clipped to what it shows already; a pixel moved
            // from a part that does not show lands in the update area.
            draw?.scroll?.(hdc, intersect(scroll, clip), dx, dy, clip);
        }
        return areas;
    };

    /**
     * Hands a scroll's update area back -- into the region and the rectangle
     * a caller gave -- and answers its kind of region.
     *
     * @param {Rect[]} update @param {number} region @param {number} updateRect
     */
    const handScrollBack = (update, region, updateRect)=>{
        const area = areaOf(update);
        const bounds = boundsOf(area);
        if ((updateRect >>> 0) !== 0)
        {
            writeU32s(host, updateRect >>> 0, [bounds.left, bounds.top, bounds.right,
                bounds.bottom]);
        }
        if ((region >>> 0) !== 0)
        {
            host.setRegion?.(region >>> 0, area);
        }
        return area.length === 0 ? NULLREGION : area.length === 1 ? SIMPLEREGION : COMPLEXREGION;
    };

    /**
     * An MDI child, however it was asked for: made with the style, place,
     * size and id its client gives it, its WM_CREATE handed an MDICREATESTRUCT
     * of what was asked -- in guest memory for as long as the window is being
     * made -- and then the client's, activated when it is shown.
     *
     * @param {{ client: number, args: number[], asked: number[] }} child
     * @param {number[]} args @param {boolean} unicode @param {unknown} [caller]
     */
    const createMdiChild = (child, args, unicode, caller)=>{
        const thread = caller ?? host.callerThread?.();
        const asked = host.allocate?.(MDICREATESTRUCT_SIZE) ?? 0;
        if (asked !== 0)
        {
            host.writeMemory(asked, new Uint8Array(new Uint32Array(child.asked
                .map(value=>value >>> 0)).buffer));
        }
        const params = asked !== 0 ? asked : args[11] ?? 0;
        return andThen(makeWindowFor([...child.args.slice(0, 11), params], unicode, thread),
            made=>{
                if (asked !== 0)
                {
                    host.release?.(asked);
                }
                return (made >>> 0) === 0 ? 0
                    : andThen(mdi.adopt(child.client, made >>> 0, thread), ()=>made);
            });
    };

    /**
     * @param {number[]} args @param {boolean} unicode @param {unknown} [caller]
     */
    const makeWindowFor = (args, unicode = false, caller = undefined)=>{
        const [exStyle, className, windowName, style, x, y, width, height, parent, menu, instance]
            = args;
        const cls = classOf(className, unicode);
        if (!cls)
        {
            return 0;
        }
        // A child needs something to be inside.
        if ((style & (WS_CHILD | WS_POPUP)) === WS_CHILD && (parent >>> 0) === 0)
        {
            host.setLastError?.(ERROR_TLW_WITH_WSCHILD);
            return 0;
        }
        // A child that leaves its place and size to the system is given none:
        // CW_USEDEFAULT means something only for a top-level window.
        const isChildStyle = (style & (WS_CHILD | WS_POPUP)) === WS_CHILD;
        // Any other window's hMenu is a menu, and one that is not makes no window.
        if (!isChildStyle && (menu >>> 0) !== 0
            && !(/** @type {any} */ (table)).IsMenu.handler([menu >>> 0]))
        {
            host.setLastError?.(ERROR_INVALID_MENU_HANDLE);
            return 0;
        }
        const record = makeWindow({
            className: cls.name,
            title: (windowName >>> 0) === 0
                ? '' : readText(host, windowName, unicode, MAX_WINDOW_TEXT),
            unicode: procedures.has(cls.wndProc) || cls.wndProc === 0
                ? unicode : cls.unicode === true,
            // Not yet visible while it is being made: CreateWindowEx shows it
            // once WM_CREATE has been answered (announce), and a CBT hook or
            // the window's own procedure reads it hidden until then.
            style: (style & ~WS_VISIBLE) >>> 0,
            exStyle: exStyle >>> 0,
            // A window made on the desktop is a top-level window, which is
            // what a parent of zero already says.
            parent: desktop !== null && (parent >>> 0) === desktop.hwnd ? 0 : parent >>> 0,
            instance: instance >>> 0,
            // For a child window hMenu is its control id; for any other --
            // an owned popup included, and WS_CHILD | WS_POPUP, which is a
            // popup -- it is a menu handle, which the menu bookkeeping hangs
            // on to, the frame makes room for and DestroyWindow destroys.
            id: (style & (WS_CHILD | WS_POPUP)) === WS_CHILD ? menu >>> 0 : 0,
            menu: (style & (WS_CHILD | WS_POPUP)) === WS_CHILD ? 0 : menu >>> 0,
            wndProc: cls.wndProc,
            x: coordinate(x, DEFAULT_ORIGIN),
            y: coordinate(y, DEFAULT_ORIGIN),
            width: coordinate(width, isChildStyle ? 0 : DEFAULT_WIDTH),
            height: coordinate(height, isChildStyle ? 0 : DEFAULT_HEIGHT),
            extra: new DataView(new ArrayBuffer(Math.max(cls.windowExtra, 0))),
        });
        // Input has to land somewhere, and what a person is looking at is the
        // window that was made most recently until something says otherwise.
        // Telling the host here is the only way it can know a handle it never
        // saw created.
        host.created?.(record.hwnd);
        return announce(record, args, unicode, caller);
    };

    /**
     * Tells a new window's procedure that it exists.
     *
     * This is not a courtesy. A window procedure does its setup in WM_CREATE --
     * it builds the object the window stands for, starts its timers, and hangs
     * that object off the window. A program whose procedure never receives it
     * gets a window that looks real from every angle and does nothing, and what
     * that looks like from outside is a program waiting patiently for something
     * it was supposed to have started itself.
     *
     * Both messages are *sent*, which means running guest code and answering
     * with a promise the bridge parks the caller on. WM_NCCREATE answering
     * FALSE and WM_CREATE answering -1 each mean the window must not exist, and
     * both are how a program refuses a window it cannot set up.
     *
     * The CREATESTRUCT holds the caller's own name pointers, so it is in the
     * encoding of the call, and reaches the procedure converted to its own.
     *
     * @param {any} record @param {number[]} args
     * @param {boolean} [unicode]  Whether the call's names are wide strings.
     * @param {unknown} [caller]  Whose call this answers, when the caller has
     *     awaited before making the window.
     */
    const announce = (record, args, unicode = false, caller = undefined)=>{
        const [exStyle, className, windowName, style, x, y, width, height,
            parent, menu, instance, params] = args;
        // Named once, before anything is awaited: a call made after the hook
        // has answered is answering a call the bridge has already let go of.
        const thread = caller ?? host.callerThread?.();
        // Kept for a procedure on this side that reads it (the MDI client's
        // CLIENTCREATESTRUCT), which is handed no CREATESTRUCT.
        record.createParams = (params ?? 0) >>> 0;
        // The CBT hook sees the styles asked for, the window edge already
        // following the frame; the procedure, from WM_NCCREATE on, sees the
        // window as the window manager has settled it.
        const asked = edgeFor(style, exStyle);
        record.exStyle = (asked & ~WS_EX_LAYERED) >>> 0;
        const settle = ()=>{
            const created = createdStyles(record.style, record.exStyle | (asked & WS_EX_LAYERED));
            record.style = created.style;
            record.exStyle = created.exStyle;
        };
        /** Visible now, when it was asked to be: the last thing CreateWindowEx does. */
        const reveal = ()=>{
            if ((style & WS_VISIBLE) !== 0 && (record.style & WS_VISIBLE) === 0
                && live(record.hwnd))
            {
                record.style = (record.style | WS_VISIBLE) >>> 0;
                appear(record);
            }
        };
        /**
         * The window, shown and then activated when it was created visible.
         * Made without being told its size, it is told when first shown.
         */
        const activated = ()=>{
            record.needsSize = (style & WS_VISIBLE) === 0;
            reveal();
            return andThen(activateCreated(record, thread),
                ()=>andThen(eraseShown(thread), ()=>record.hwnd));
        };
        // A procedure on this side reads no CREATESTRUCT: what it needs of one
        // is on the record.
        const onThisSide = ()=>(record.wndProc === 0 ? activated()
            : andThen(callProcedure(record.wndProc, {
                hwnd: record.hwnd, message: WM_CREATE, wParam: 0, lParam: 0,
            }, thread), created=>{
                if ((created | 0) === -1)
                {
                    return andThen(destroyWindow(record.hwnd, undefined, 'ncdestroy'), ()=>0);
                }
                return activated();
            }));
        /** Whether the window's procedure is still one this side runs. */
        const systemProcedure = ()=>record.wndProc === 0 || procedures.has(record.wndProc);
        // A CBT hook hears of every window, a system class's too: a framework
        // subclasses a dialog there, and the messages that follow go to it.
        const hooked = hooks.some(hook=>hook.type === WH_CBT && hears(hook, thread));
        if (!hooked)
        {
            settle();
        }
        if (systemProcedure() && !hooked)
        {
            return onThisSide();
        }
        if (!host.allocate)
        {
            settle();
            return activated();
        }
        // The CREATESTRUCT, and behind it the two words a CBT hook is handed
        // that point at it.
        const create = host.allocate(CREATESTRUCTA.SIZE + CBT_CREATEWNDA.SIZE);
        if (create === 0)
        {
            settle();
            return activated();
        }
        const bytes = new Uint8Array(CREATESTRUCTA.SIZE + CBT_CREATEWNDA.SIZE);
        const view = new DataView(bytes.buffer);
        /** @param {number} at @param {number} value */
        const put = (at, value)=>view.setUint32(at, value >>> 0, true);
        put(CREATESTRUCTA.lpCreateParams, params ?? 0);
        put(CREATESTRUCTA.hInstance, instance);
        put(CREATESTRUCTA.hMenu, menu);
        put(CREATESTRUCTA.hwndParent, parent);
        put(CREATESTRUCTA.cy, record.height);
        put(CREATESTRUCTA.cx, record.width);
        put(CREATESTRUCTA.y, record.y);
        put(CREATESTRUCTA.x, record.x);
        put(CREATESTRUCTA.style, style);
        put(CREATESTRUCTA.lpszName, windowName);
        put(CREATESTRUCTA.lpszClass, className);
        put(CREATESTRUCTA.dwExStyle, asked);
        put(CREATESTRUCTA.SIZE + CBT_CREATEWNDA.lpcs, create);
        put(CREATESTRUCTA.SIZE + CBT_CREATEWNDA.hwndInsertAfter, 0);
        host.writeMemory(create, bytes);
        void width;
        void height;
        void x;
        void y;

        /** @param {number} message */
        const tell = message=>callProcedure(record.wndProc, {
            hwnd: record.hwnd, message, wParam: 0, lParam: create, unicode,
        }, thread);
        // Between the two, WM_NCCALCSIZE: where the client area is in it
        // (msg.c WmCreateOverlappedSeq).
        const placedThenCreated = ()=>andThen(calcClient(record, record, thread),
            ()=>tell(WM_CREATE));
        /** @param {number} handle */
        const done = handle=>{
            host.release?.(create);
            return handle;
        };

        // The CBT hook first, before the window's own procedure has run: a
        // framework attaches its object to the window here and subclasses the
        // procedure, so the messages that follow reach the framework and not
        // the class. A hook that answers non-zero refuses the window.
        // Not yet among its siblings while the hook decides whether it may be.
        record.unlinked = true;
        const cbt = andThen(callHook(WH_CBT, null,
            [HCBT_CREATEWND, record.hwnd, create + CREATESTRUCTA.SIZE], thread), answer=>{
            delete record.unlinked;
            return answer;
        });
        /** @returns {number | Promise<number>} */
        const refuse = ()=>andThen(destroyWindow(record.hwnd, thread, 'ncdestroy'), ()=>done(0));
        return andThen(cbt, refused=>{
            if ((refused | 0) !== 0)
            {
                return andThen(destroyWindow(record.hwnd, thread, 'none'), ()=>done(0));
            }
            settle();
            // Left with its own procedure by the hook: created as a system
            // window is.
            if (systemProcedure())
            {
                return andThen(onThisSide(), created=>done(created));
            }
            // WM_NCCREATE before WM_CREATE, with the same structure: a
            // procedure that keeps lpCreateParams takes it from the first.
            return andThen(tell(WM_NCCREATE), accepted=>((accepted | 0) === 0 ? refuse()
                : andThen(placedThenCreated(), created=>{
                    if ((created | 0) === -1)
                    {
                        return refuse();
                    }
                    // A child or a popup hears its own size and its place
                    // once WM_CREATE has been answered, shown or not, as the
                    // real CreateWindowEx sends them: a framework lays out
                    // the controls inside a window when it is told its size,
                    // and a page made hidden inside a notebook is sized then
                    // or never. An overlapped window hears them when it is
                    // first shown. A window created visible is then told it
                    // is shown -- a program that never calls ShowWindow
                    // measures the screen it lays itself out and rasterises
                    // its text for from the size it is told here -- and is
                    // activated.
                    const visible = (style & WS_VISIBLE) !== 0;
                    if (!visible && (record.style & (WS_CHILD | WS_POPUP)) === 0)
                    {
                        record.needsSize = true;
                        return done(record.hwnd);
                    }
                    const client = geometry.clientRect(record);
                    return andThen(send(record.hwnd, WM_SIZE, SIZE_RESTORED,
                        ((((client.bottom - client.top) & 0xffff) << 16)
                            | ((client.right - client.left) & 0xffff)) >>> 0, thread),
                    ()=>andThen(send(record.hwnd, WM_MOVE, 0,
                        (((y & 0xffff) << 16) | (x & 0xffff)) >>> 0, thread),
                    ()=>(!visible ? done(record.hwnd)
                        : andThen(send(record.hwnd, WM_SHOWWINDOW, 1, 0, thread), ()=>{
                            reveal();
                            return andThen(activateCreated(record, thread),
                                ()=>andThen(eraseShown(thread), ()=>done(record.hwnd)));
                        }))));
                })));
        });
    };

    // --- Painting: the desktop, the frame, and who repaints after whom ---

    /** Whether something has been drawn since the desktop was last shown. */
    let presentPending = false;
    /**
     * When the windows on the screen last started to have something to
     * paint, by the guest's clock; null while none has.
     *
     * @type {number | null}
     */
    let paintingSince = null;
    const painted = ()=>{
        presentPending = true;
    };

    /**
     * Shows the desktop once nothing is left to paint. Called when the queue
     * finds no window with an update area -- which is the end of a paint
     * pass, and also the next pump after a program drew outside one.
     */
    const presentIfPainted = ()=>{
        if (presentPending)
        {
            presentPending = false;
            host.present?.();
        }
    };

    /** The colours GetSysColor answers and SetSysColors changes. */
    const systemColors = createSystemColors();

    /** @param {number} index  A system colour, as a COLORREF. */
    const sysColor = index=>systemColors.get(index);

    /**
     * The window manager's drawing, over gdi32's, with the system colours
     * added: the one description of the classic look a program can also
     * read, through GetSysColor.
     */
    const draw = host.draw
        ? Object.assign(Object.create(host.draw), { sysColor })
        : null;

    /**
     * Marks a window's whole client area, frame included, for repainting --
     * the window alone: its children have their own to mark.
     *
     * @param {any} record
     */
    const repaint = record=>{
        const size = geometry.clientSize(record);
        record.ncDirty = true;
        paint.invalidate(record, { left: 0, top: 0, right: size.width, bottom: size.height },
            true, 'none');
        host.queue.dirtied?.(creatorOf(record));
    };

    /**
     * A window's update area grew: its thread has a WM_PAINT to find. The
     * windows over it are left out of its context, so its paint cannot reach
     * them, and its parent is not its to repaint. A WS_EX_TRANSPARENT sibling
     * over it is the exception: it clips nothing beneath it, and shows only
     * because it is painted after its siblings beneath have been ("the bits of
     * underlying sibling windows have already been painted"), so it paints
     * again where they do.
     *
     * @param {any} record
     */
    const invalidated = record=>{
        if (!shown(record))
        {
            return;
        }
        host.queue.dirtied?.(creatorOf(record));
        if (!isChild(record) || !record.updateArea)
        {
            return;
        }
        const client = geometry.clientRect(record);
        const dirty = offsetArea(record.updateArea, client.left, client.top);
        // Siblings are kept topmost first: those before it are over it.
        for (const sibling of childrenOf({ hwnd: record.parent }))
        {
            if (sibling === record)
            {
                break;
            }
            if ((sibling.exStyle & WS_EX_TRANSPARENT) === 0 || !shown(sibling))
            {
                continue;
            }
            const over = geometry.clientRect(sibling);
            const area = offsetArea(intersectAreas(dirty, [over]), -over.left, -over.top);
            if (area.length > 0 && subtractAreas(area, sibling.updateArea ?? []).length > 0)
            {
                paint.invalidate(sibling, area, true, 'none');
            }
        }
    };

    /** @param {any} a @param {any} b */
    const sameRect = (a, b)=>a.left === b.left && a.top === b.top && a.right === b.right
        && a.bottom === b.bottom;

    /**
     * The desktop itself, painted once in the desktop colour before the
     * first window goes on it. Nothing else ever paints the whole screen.
     *
     * It is painted and **not presented**: the desktop colour is the window
     * manager's own background, not a picture the program drew, and the first
     * frame a display is handed is what a launcher hides its loading screen
     * on. Presenting this one showed a blank coloured screen as if it were
     * the program's first frame, before the program had presented anything.
     * What the program draws still reaches the screen -- a GDI draw presents
     * the desktop itself, and a window's frame or the uncovering of one marks
     * it painted below -- so nothing legitimate is lost.
     */
    let desktopPainted = false;

    /**
     * The desktop's own background over `area`: its picture when the host
     * gave it one, else the desktop colour.
     *
     * @param {number} hdc
     * @param {{ left: number, top: number, right: number, bottom: number }[]} area
     * @param {boolean} seen  Whether this is a repaint the screen should see.
     */
    const desktopBackground = (hdc, area, seen)=>{
        if (host.desktopPicture && host.screen
            && draw?.wallpaper?.(hdc, area, host.desktopPicture, host.screen))
        {
            return;
        }
        for (const piece of area)
        {
            (seen ? draw?.fill : draw?.fillBackground ?? draw?.fill)?.call(draw, hdc, piece,
                sysColor(COLOR_BACKGROUND));
        }
    };

    const paintDesktop = ()=>{
        if (desktopPainted || !host.screen)
        {
            return;
        }
        const hdc = host.dc?.()?.get(0, null) ?? 0;
        if (hdc === 0)
        {
            return;
        }
        desktopPainted = true;
        desktopBackground(hdc,
            [{ left: 0, top: 0, right: host.screen.width, bottom: host.screen.height }], false);
        host.dc?.()?.release(0, hdc);
    };

    /**
     * A window appeared: it and everything inside it paint from scratch.
     *
     * @param {any} record
     */
    const appear = record=>{
        tell(record);
        paintDesktop();
        underParent(record, sightOf(record, false));
        for (const each of [record, ...descendantsOf(record)])
        {
            if (shown(each))
            {
                repaint(each);
                unerased.add(each);
            }
        }
    };

    /**
     * A child now shows where it did not: a parent that does not clip its
     * children repaints under it, and the child paints after it (msg.c
     * test_swp_paint_region_on_show and _on_extend_zerosize: the parent's
     * update region is the child's new rectangle). One that clips them never
     * draws there, and is left alone.
     *
     * @param {any} record
     * @param {import('../gdi32/rects.js').Rect[]} area  Screen coordinates.
     */
    const underParent = (record, area)=>{
        const parent = isChild(record) ? live(record.parent) : null;
        if (!parent || area.length === 0 || !shown(parent)
            || (parent.style & WS_CLIPCHILDREN) !== 0)
        {
            return;
        }
        const client = geometry.clientRect(parent);
        paint.invalidate(parent, offsetArea(area, -client.left, -client.top), true, 'none');
        host.queue.dirtied?.(creatorOf(parent));
        unerased.add(parent);
    };

    /**
     * Windows that appeared since their frames and backgrounds were last
     * painted at once, parents before their children.
     *
     * @type {Set<any>}
     */
    const unerased = new Set();

    /**
     * The frames and backgrounds of the windows that appeared, painted now --
     * WM_NCPAINT and WM_ERASEBKGND sent, parents first -- as Windows XP's
     * SetWindowPos paints a window it shows before it returns; the client
     * waits for its WM_PAINT, as it does there. Asked for by the calls that
     * show a window. Only the calling thread's windows: another thread's are
     * its own to paint when it next looks at its queue.
     *
     * @param {unknown} thread
     * @returns {number | Promise<number>}
     */
    const eraseShown = thread=>{
        const asking = threadIdOf(thread);
        /** @returns {number | Promise<number>} */
        const next = ()=>{
            const first = unerased.values().next();
            if (first.done)
            {
                return 1;
            }
            const record = first.value;
            unerased.delete(record);
            const owner = threadIdOf(record.thread);
            return live(record.hwnd) && shown(record)
                && (owner === null || asking === null || owner === asking)
                ? andThen(paint.eraseNow(record, thread), next) : next();
        };
        return next();
    };

    /** @param {any} record @returns {any[]} every live descendant, in paint order */
    const descendantsOf = record=>childrenOf(record)
        .flatMap(child=>[child, ...descendantsOf(child)]);

    /** @param {{ left: number, top: number, right: number, bottom: number }} rect */
    const rectOf = rect=>({ left: rect.left, top: rect.top, right: rect.right,
        bottom: rect.bottom });

    /**
     * What the run knows of a window (`manager.js`), as its record has it.
     *
     * @param {any} record @returns {import('./manager.js').WindowState}
     */
    const stateOf = record=>({
        hwnd: record.hwnd >>> 0,
        processId,
        threadId: creatorOf(record) ?? 0,
        parent: isChild(record) ? record.parent >>> 0 : 0,
        owner: (record.owner ?? 0) >>> 0,
        className: String(record.className),
        title: String(record.title),
        style: record.style >>> 0,
        exStyle: record.exStyle >>> 0,
        rect: rectOf(geometry.windowRect(record)),
        client: rectOf(geometry.clientRect(record)),
        visible: shown(record),
        enabled: (record.style & WS_DISABLED) === 0,
        minimized: (record.style & WS_MINIMIZE) !== 0,
        maximized: (record.style & WS_MAXIMIZE) !== 0,
        topmost: (record.exStyle & WS_EX_TOPMOST) !== 0,
        region: record.regionBox ? rectOf(record.regionBox) : null,
    });

    /** What the run was last told of each window, as it compares. @type {Map<number, string>} */
    const toldRun = new Map();

    /** Windows changed since the run was last told of them. @type {Set<any>} */
    const unsaid = new Set();

    /**
     * Makes the fields a window's state is read from tell the run when they
     * change: whichever of user32's calls assigns one, the run hears of the
     * window once that call is over, in a microtask.
     *
     * @param {any} record
     */
    const watchFields = record=>{
        for (const field of TRACKED_FIELDS)
        {
            let value = record[field];
            Object.defineProperty(record, field, {
                enumerable: true,
                get: ()=>value,
                set: changed=>{
                    if (changed !== value)
                    {
                        value = changed;
                        layoutRevision++;
                        if (unsaid.size === 0)
                        {
                            queueMicrotask(()=>{
                                const pending = [...unsaid];
                                unsaid.clear();
                                for (const each of pending)
                                {
                                    tell(each);
                                }
                            });
                        }
                        unsaid.add(record);
                    }
                },
            });
        }
        return record;
    };

    /**
     * Tells the run what a window is now, and the windows inside its
     * top-level one: a parent that moved moved them on the screen. Only a
     * window that changed since it was last told crosses.
     *
     * @param {any} record
     */
    const tell = record=>{
        if (!record || record.destroyed || record.hwnd === 0 || record === desktop
            || windows.get(record.hwnd) !== record)
        {
            return;
        }
        const top = topLevelOf(record);
        if (top.parent === HWND_MESSAGE)
        {
            return;
        }
        let reordered = false;
        for (const each of [top, ...descendantsOf(top)])
        {
            const state = stateOf(each);
            const said = JSON.stringify(state);
            const before = toldRun.get(state.hwnd);
            if (before !== said)
            {
                toldRun.set(state.hwnd, said);
                directory.publish?.(state);
                // A new top-level window, or one whose band or owner changed,
                // may have moved in the run's order.
                const was = before === undefined ? null : JSON.parse(before);
                reordered ||= state.parent === 0 && (was === null || was.parent !== 0
                    || was.topmost !== state.topmost || was.owner !== state.owner);
            }
        }
        if (reordered)
        {
            adoptOrder();
        }
    };

    /**
     * Takes the order of this process's top-level windows from the run's,
     * which keeps Windows' rules for it -- the topmost band above the rest,
     * an owned window above its owner -- and is the order across processes
     * too. A window's descendants follow it; a window that came up is shown
     * again where it now overlaps another.
     */
    const adoptOrder = ()=>{
        const run = directory.topLevel?.();
        if (!run)
        {
            return;
        }
        const wanted = run.filter(state=>state.processId === processId)
            .map(state=>state.hwnd).reverse();
        const placed = new Set(wanted);
        const current = [...windows.values()]
            .filter(each=>!each.destroyed && !isChild(each) && placed.has(each.hwnd))
            .map(each=>each.hwnd);
        if (current.join() === wanted.join())
        {
            return;
        }
        /** @type {Map<number, any[]>} */
        const groups = new Map(wanted.map(hwnd=>[hwnd, []]));
        /** @type {any[]} */
        const rest = [];
        for (const each of windows.values())
        {
            const top = each.destroyed ? each : topLevelOf(each);
            (groups.get(top.hwnd) ?? rest).push(each);
        }
        windows.clear();
        for (const each of [...rest, ...wanted.flatMap(hwnd=>groups.get(hwnd) ?? [])])
        {
            windows.set(each.hwnd, each);
        }
        for (const [index, hwnd] of wanted.entries())
        {
            const record = windows.get(hwnd);
            if (index !== current.indexOf(hwnd) && record && shown(record))
            {
                appear(record);
            }
        }
    };

    /**
     * The parts of the screen windows have left that the desktop has not
     * painted over yet.
     *
     * @type {{ left: number, top: number, right: number, bottom: number }[]}
     */
    let exposed = [];

    /**
     * The desktop paints what windows left of the screen, where no window is
     * now: what its own thread does on Windows, a moment after the window
     * went rather than inside the call that took it away.
     */
    const repaintDesktop = ()=>{
        let bare = exposed;
        exposed = [];
        for (const record of windows.values())
        {
            if (!record.destroyed && !isChild(record) && shown(record))
            {
                for (const piece of geometry.shapeRects(record))
                {
                    bare = subtractFromArea(bare, piece);
                }
            }
        }
        const hdc = bare.length > 0 ? host.dc?.()?.get(0, null) ?? 0 : 0;
        if (hdc !== 0)
        {
            desktopBackground(hdc, bare, true);
            host.dc?.()?.release(0, hdc);
            painted();
        }
    };

    /**
     * What of the screen a window shows, in screen coordinates: its shape,
     * inside every ancestor's client area, less what is over it -- the
     * windows above, the siblings it clips, and with `own` and
     * WS_CLIPCHILDREN its children. Held while dragged too: this is where it
     * is, not where it may draw.
     *
     * @param {any} record @param {boolean} [own]
     * @returns {import('../gdi32/rects.js').Rect[]}
     */
    const sightOf = (record, own = true)=>{
        if (record.destroyed || !shown(record))
        {
            return [];
        }
        const visible = geometry.visibleWindowRect(record);
        return isEmpty(visible) ? []
            : subtractAreas([visible], coveringOf(record, own));
    };

    /**
     * Part of the screen a window now shows that it did not: added to its
     * update region and marked to erase, its frame marked where the part
     * reaches past the client area; erased before the call that showed it
     * returns, when that is the window's own thread (`eraseShown`).
     *
     * @param {any} record
     * @param {import('../gdi32/rects.js').Rect[]} area  Screen coordinates.
     */
    const exposeIn = (record, area)=>{
        if (area.length === 0)
        {
            return;
        }
        const client = geometry.clientRect(record);
        const inside = intersectAreas(area, [client]);
        if (subtractAreas(area, [client]).length > 0)
        {
            record.ncDirty = true;
        }
        paint.invalidate(record, offsetArea(inside, -client.left, -client.top), true, 'none');
        host.queue.dirtied?.(creatorOf(record));
        unerased.add(record);
    };

    /**
     * A window left part of the screen -- moved, shrank, was hidden, lowered
     * or destroyed: each window now seen there has what it shows of it added
     * to its update region, to erase, and nothing else is touched. Neither
     * the windows over it, which never stopped showing, nor the rest of the
     * windows beneath, whose pixels are still there (msg.c
     * test_swp_paint_regions: the parent's update region is the old
     * rectangle less the new one). The window that left, and what is inside
     * it, are not counted.
     *
     * Where no window is now, the desktop paints; DESKTOP_REPAINT_MS later for
     * a window that went rather than moved. A wizard that replaces its window
     * between two pages destroys one and shows the next in the same place a
     * few milliseconds apart, pumping messages in between; painted at once,
     * the desktop was shown in that gap, the whole window gone for a frame at
     * every page. A move leaves no such gap, and its trail is painted at once.
     *
     * @param {import('../gdi32/rects.js').Rect[]} area  Screen coordinates.
     * @param {any} leaving  The window that left it.
     * @param {boolean} [moved]  Whether it is still on the screen.
     * @param {boolean} [quiet]  The desktop's part only: the program asked
     *        for no painting of its own windows (SWP_NOREDRAW). The desktop
     *        is no window of the program's to invalidate, and a trail of a
     *        window left on it would stay there.
     */
    const expose = (area, leaving, moved = false, quiet = false)=>{
        if (area.length === 0)
        {
            return;
        }
        paintDesktop();
        if (!isChild(leaving))
        {
            const waiting = !moved && (exposed.length > 0 || scheduleDesktop());
            exposed.push(...area);
            if (!waiting)
            {
                repaintDesktop();
            }
        }
        if (quiet)
        {
            return;
        }
        const box = boundsOf(area);
        for (const other of paintOrder())
        {
            if (shown(other) && !insideOf(other, leaving)
                && !isEmpty(intersect(box, geometry.shapedRect(other))))
            {
                exposeIn(other, intersectAreas(sightOf(other), area));
            }
        }
    };

    /**
     * What a window and its descendants show before it is moved, sized,
     * restacked, shown or hidden, for `afterChange` to compare with afterwards.
     *
     * @param {any} record
     * @param {boolean} [held]  Being dragged: what it shows of itself is not
     *        asked afterwards, and is not read -- a drag moves it at every
     *        mouse move.
     */
    const beforeChange = (record, held = false)=>({
        record,
        wasShown: shown(record),
        occupied: sightOf(record, false),
        sights: new Map(held ? [] : [record, ...descendantsOf(record)].filter(each=>shown(each))
            .map(each=>[each, { sight: sightOf(each), client: geometry.clientRect(each) }])),
    });

    /**
     * After a change `beforeChange` saw the start of: what the window left is
     * exposed beneath it (`expose`), and the window and its descendants are
     * marked where they now show what they did not. A window whose pixels
     * came along with it (`shift`, the distance moveBits copied them, or none
     * for a window that did not move) is marked only there; one whose client
     * area went anywhere else, or that has just appeared, is marked whole.
     *
     * @param {ReturnType<typeof beforeChange>} watched
     * @param {{ shift?: { dx: number, dy: number }, moved?: boolean, sized?: boolean,
     *     held?: boolean, redraw?: boolean, quiet?: boolean }} [how]
     *        `held`: the window is being dragged and paints nothing of its own;
     *        `redraw`: its class asks for the whole of it on this size change;
     *        `quiet`: SWP_NOREDRAW, nothing of the program's is marked.
     */
    const afterChange = (watched, how = {})=>{
        const { record } = watched;
        const isShown = shown(record) && !record.destroyed;
        const now = isShown ? sightOf(record, false) : [];
        expose(subtractAreas(watched.occupied, now), record, how.moved === true,
            how.quiet === true);
        if (!isShown || how.held || how.quiet)
        {
            return;
        }
        if (!watched.wasShown)
        {
            appear(record);
            return;
        }
        const dx = how.shift?.dx ?? 0;
        const dy = how.shift?.dy ?? 0;
        for (const each of [record, ...descendantsOf(record)])
        {
            if (!shown(each))
            {
                continue;
            }
            const before = watched.sights.get(each);
            const client = geometry.clientRect(each);
            if (!before || client.left !== before.client.left + dx
                || client.top !== before.client.top + dy || (each === record && how.redraw))
            {
                repaint(each);
                unerased.add(each);
                continue;
            }
            if (each === record)
            {
                underParent(record, subtractAreas(sightOf(record, false),
                    offsetArea(watched.occupied, dx, dy)));
            }
            if (each === record && how.sized)
            {
                // Its frame is drawn where its edges now are.
                record.ncDirty = true;
                host.queue.dirtied?.(creatorOf(record));
                unerased.add(record);
            }
            exposeIn(each, subtractAreas(sightOf(each), offsetArea(before.sight, dx, dy)));
        }
    };

    /** Whether a window is `outer` or inside it. @param {any} record @param {any} outer */
    const insideOf = (record, outer)=>{
        if (!outer)
        {
            return false;
        }
        for (let at = record; at; at = isChild(at) ? live(at.parent) : null)
        {
            if (at === outer)
            {
                return true;
            }
        }
        return false;
    };

    /**
     * Whether all of a window is on the screen and under no other: then its
     * pixels there are its own, and a move can take them along.
     *
     * @param {any} record
     */
    const wholeOnScreen = record=>{
        const rect = geometry.shapedRect(record);
        const screen = host.screen;
        return Boolean(screen) && !isEmpty(rect) && rect.left >= 0 && rect.top >= 0
            && rect.right <= (screen?.width ?? 0) && rect.bottom <= (screen?.height ?? 0)
            && sameRect(geometry.visibleWindowRect(record), rect)
            && coveringOf(record, false).every(cover=>isEmpty(intersect(cover, rect)));
    };

    /**
     * The window a program is dragging -- moving it while it, or a window in
     * it, holds the mouse -- held as it is until the mouse is let go, with
     * its picture, which is all that moves: it paints nothing and is handed
     * nothing to paint meanwhile, and only what it leaves is rendered, by
     * what is under it. Painting itself at every step of a drag, it showed
     * half-drawn frames for nothing.
     *
     * @type {{ record: any, shot: any } | null}
     */
    let dragged = null;

    /** Whether a window is the dragged one or inside it. @param {any} record */
    const frozen = record=>dragged !== null && insideOf(record, dragged.record);

    /**
     * Asked before a window moves: whether it is being dragged, its picture
     * taken where it still is the first time.
     *
     * @param {any} record
     */
    const dragging = record=>{
        if (dragged?.record === record)
        {
            return true;
        }
        const holder = live(captured);
        if (!holder || !insideOf(holder, record) || !shown(record) || !draw?.snapshot)
        {
            return false;
        }
        const hdc = host.dc?.()?.get(0, null) ?? 0;
        const shot = hdc !== 0 ? draw.snapshot(hdc, geometry.shapedRect(record)) : null;
        host.dc?.()?.release(0, hdc);
        if (!shot)
        {
            return false;
        }
        endDrag();
        dragged = { record, shot };
        return true;
    };

    /**
     * A dragged window moved: its picture drawn where it now is and seen.
     * What it left is the caller's to expose (`afterChange`).
     *
     * @param {any} record
     */
    const dragMove = record=>{
        const hdc = dragged ? host.dc?.()?.get(0, null) ?? 0 : 0;
        if (hdc === 0 || !dragged)
        {
            return;
        }
        const after = geometry.shapedRect(record);
        draw.clip?.(hdc, coveringOf(record, false).reduce(
            (area, cover)=>subtractFromArea(area, cover), [geometry.visibleWindowRect(record)]));
        draw.paste(hdc, dragged.shot, after.left, after.top);
        host.dc?.()?.release(0, hdc);
        painted();
    };

    /** The mouse let go: the dragged window is itself again, and paints where it now is. */
    const endDrag = ()=>{
        if (!dragged)
        {
            return;
        }
        const { record, shot } = dragged;
        dragged = null;
        draw?.drop?.(shot);
        if (live(record.hwnd) && shown(record))
        {
            appear(record);
        }
    };

    /**
     * A window moved, its size the same: its pixels go with it, as Windows'
     * SetWindowPos copies a window's bits, and only what it left of the
     * screen is painted -- by the windows under it and the desktop, which is
     * what a move renders. Repainted instead, the window and every control
     * in it ran the program's painting again at every step of a drag. Asked
     * only for a window that was all on the screen and under no other
     * (`wholeOnScreen`), whose pixels were all its own. Answers whether they
     * moved.
     *
     * @param {any} record
     * @param {{ left: number, top: number, right: number, bottom: number }} before
     *        Its rectangle on the screen before the move.
     */
    const moveBits = (record, before)=>{
        const hdc = draw?.scroll ? host.dc?.()?.get(0, null) ?? 0 : 0;
        if (hdc === 0)
        {
            return false;
        }
        const after = geometry.shapedRect(record);
        // Drawn only where it is seen now: inside its parents, under no window above.
        draw.clip?.(hdc, coveringOf(record, false).reduce(
            (area, cover)=>subtractFromArea(area, cover), [geometry.visibleWindowRect(record)]));
        draw.scroll(hdc, before, after.left - before.left, after.top - before.top, after);
        host.dc?.()?.release(0, hdc);
        painted();
        return true;
    };

    /**
     * Has the desktop paint what windows left DESKTOP_REPAINT_MS from now: on
     * the system's own clock when the host has one -- the desktop is no
     * thread of the program's, and on Windows its own thread paints whatever
     * the program's are doing -- else when the queue is next looked at.
     * False when nothing can wait.
     */
    const scheduleDesktop = ()=>{
        if (host.later?.(DESKTOP_REPAINT_MS, repaintDesktop))
        {
            return true;
        }
        if (!host.queue.postLater)
        {
            return false;
        }
        host.queue.postLater(DESKTOP_REPAINT_KEY, DESKTOP_REPAINT_MS, ()=>{
            repaintDesktop();
            return null;
        });
        return true;
    };

    /**
     * Paints a window's frame: the border, the caption with the title and
     * the close box, and the scroll bars its styles give it. What
     * DefWindowProc does with WM_NCPAINT.
     *
     * @param {any} record
     */
    const paintFrame = record=>{
        const frame = geometry.frame(record);
        if (!draw || (frame.left === 0 && frame.top === 0 && frame.right === 0
            && frame.bottom === 0))
        {
            return;
        }
        const hdc = paint.contextOn(record, true);
        if (hdc === 0)
        {
            return;
        }
        const width = record.width;
        const height = record.height;
        const face = sysColor(COLOR_3DFACE);
        // FlashWindow's inverted caption lasts until the activation it
        // inverted changes, as the flag WM_NCACTIVATE sets does.
        const activeNow = topLevelOf(record).hwnd === activeWindow();
        const isActive = record.flash?.active === activeNow ? record.flash.shown : activeNow;
        // The edge, one ring per pixel, each in the colours its part of the
        // frame is drawn in: raised, banded, bordered or sunken.
        const rings = frameRings(record.style, record.exStyle, isActive);
        for (let ring = 0; ring < frame.edge; ring++)
        {
            const colours = rings[ring] ?? { topLeft: COLOR_3DFACE, bottomRight: COLOR_3DFACE };
            const topLeft = sysColor(colours.topLeft);
            const bottomRight = sysColor(colours.bottomRight);
            draw.fill(hdc, { left: ring, top: ring, right: width - ring - 1, bottom: ring + 1 },
                topLeft);
            draw.fill(hdc, { left: ring, top: ring, right: ring + 1, bottom: height - ring - 1 },
                topLeft);
            draw.fill(hdc, { left: ring, top: height - ring - 1, right: width - ring,
                bottom: height - ring }, bottomRight);
            draw.fill(hdc, { left: width - ring - 1, top: ring, right: width - ring,
                bottom: height - ring }, bottomRight);
        }
        if (frame.caption > 0)
        {
            const bar = { left: frame.edge, top: frame.edge, right: width - frame.edge,
                bottom: frame.edge + frame.caption };
            draw.fill(hdc, bar, sysColor(isActive ? COLOR_ACTIVECAPTION : COLOR_INACTIVECAPTION));
            const box = closeBox(record);
            const metrics = draw.measure(hdc, 'M');
            draw.text(hdc, bar.left + 4, bar.top + Math.floor((frame.caption - metrics.height) / 2),
                record.title, {
                    color: sysColor(isActive ? COLOR_CAPTIONTEXT : COLOR_INACTIVECAPTIONTEXT),
                    clip: { ...bar, right: box ? box.left - 2 : bar.right },
                });
            if (box)
            {
                draw.fill(hdc, box, face);
                draw.fill(hdc, { ...box, right: box.right - 1, bottom: box.top + 1 },
                    sysColor(COLOR_3DHILIGHT));
                draw.fill(hdc, { ...box, right: box.left + 1, bottom: box.bottom - 1 },
                    sysColor(COLOR_3DHILIGHT));
                draw.fill(hdc, { ...box, top: box.bottom - 1 }, sysColor(COLOR_3DDKSHADOW));
                draw.fill(hdc, { ...box, left: box.right - 1 }, sysColor(COLOR_3DDKSHADOW));
                draw.fill(hdc, { left: box.left + 1, top: box.bottom - 2, right: box.right - 1,
                    bottom: box.bottom - 1 }, sysColor(COLOR_3DSHADOW));
                draw.fill(hdc, { left: box.right - 2, top: box.top + 1, right: box.right - 1,
                    bottom: box.bottom - 1 }, sysColor(COLOR_3DSHADOW));
                // The cross: two diagonals, two pixels wide, drawn a pixel at a time.
                const ink = sysColor(COLOR_BTNTEXT);
                for (let step = 0; step < 7; step++)
                {
                    const x = box.left + 3 + step;
                    const y = box.top + 3 + step;
                    draw.fill(hdc, { left: x, top: y, right: x + 2, bottom: y + 1 }, ink);
                    draw.fill(hdc, { left: box.right - 5 - step, top: y,
                        right: box.right - 3 - step, bottom: y + 1 }, ink);
                }
            }
        }
        if (frame.menu > 0)
        {
            // The bar's room, in the menu colour: nothing lays its items out.
            draw.fill(hdc, { left: frame.edge, top: frame.edge + frame.caption,
                right: width - frame.edge, bottom: frame.edge + frame.caption + frame.menu },
            sysColor(COLOR_MENU));
        }
        if (frame.right > frame.edge)
        {
            const bar = scrollBarRect(record, true);
            controls.helpers.paintScrollBar(hdc, bar, true, scrollOf(record, SB_VERT));
        }
        if (frame.bottom > frame.edge)
        {
            const bar = scrollBarRect(record, false);
            controls.helpers.paintScrollBar(hdc, bar, false, scrollOf(record, SB_HORZ));
        }
        host.dc?.()?.release(record.hwnd, hdc);
        painted();
    };

    /** SetScrollInfo's bars for a window's own. */
    const SB_HORZ = 0;
    const SB_VERT = 1;
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
     * Where a window's own scroll bar is, in window coordinates.
     *
     * @param {any} record @param {boolean} vertical
     */
    const scrollBarRect = (record, vertical)=>{
        const frame = geometry.frame(record);
        return vertical
            ? { left: record.width - frame.right, top: frame.top,
                right: record.width - frame.edge, bottom: record.height - frame.bottom }
            : { left: frame.left, top: record.height - frame.bottom,
                right: record.width - frame.right, bottom: record.height - frame.edge };
    };

    /** WS_SYSMENU: the caption's buttons, the close box among them. */
    const WS_SYSMENU_STYLE = 0x00080000;

    /** The close box, in window coordinates. @param {any} record */
    const closeBox = record=>{
        // Only a window with a system menu has caption buttons.
        if ((record.style & WS_SYSMENU_STYLE) === 0)
        {
            return null;
        }
        const frame = geometry.frame(record);
        const size = Math.min(CLOSE_BOX, frame.caption - 2 * CLOSE_GAP);
        const top = frame.edge + Math.floor((frame.caption - size) / 2);
        return { left: record.width - frame.edge - CLOSE_GAP - size, top,
            right: record.width - frame.edge - CLOSE_GAP, bottom: top + size };
    };

    /**
     * Whether a screen point is in a window's shape: its rectangle, or the
     * rectangles of its window region.
     *
     * @param {any} record @param {number} x @param {number} y
     */
    const inShape = (record, x, y)=>geometry.shapeRects(record)
        .some((/** @type {any} */ piece)=>contains(piece, x, y));

    /**
     * What part of a window a screen point is on: the client area, the
     * caption, its close box, the border, or nowhere.
     *
     * @param {any} record @param {number} x @param {number} y
     */
    const hitTest = (record, x, y)=>{
        const rect = geometry.windowRect(record);
        if (!inShape(record, x, y))
        {
            return HTNOWHERE;
        }
        if (contains(geometry.clientRect(record), x, y))
        {
            return HTCLIENT;
        }
        const frame = geometry.frame(record);
        const local = { x: x - rect.left, y: y - rect.top };
        if (frame.caption > 0 && local.y >= frame.edge && local.y < frame.edge + frame.caption
            && local.x >= frame.edge && local.x < record.width - frame.edge)
        {
            const box = closeBox(record);
            return box && contains(box, local.x, local.y) ? HTCLOSE : HTCAPTION;
        }
        const barTop = frame.edge + frame.caption;
        if (frame.menu > 0 && local.y >= barTop && local.y < barTop + frame.menu
            && local.x >= frame.edge && local.x < record.width - frame.edge)
        {
            return HTMENU;
        }
        if (frame.right > frame.edge && contains(scrollBarRect(record, true), local.x, local.y))
        {
            return HTVSCROLL;
        }
        if (frame.bottom > frame.edge && contains(scrollBarRect(record, false), local.x, local.y))
        {
            return HTHSCROLL;
        }
        return HTBORDER;
    };

    /**
     * Every window under a screen point that could take the pointer, in the
     * order they are offered it: from the top, a window's children at the
     * point before the window itself, deepest first. A hidden window is
     * never among them, nor, unless asked for, a disabled one.
     *
     * @param {number} x @param {number} y @param {boolean} [disabledToo]
     * @returns {any[]}
     */
    const windowsAt = (x, y, disabledToo = false)=>{
        /** @type {any[]} */
        const found = [];
        /** @param {any[]} candidates  Topmost first. */
        const visit = candidates=>{
            for (const record of candidates)
            {
                if ((record.style & WS_VISIBLE) === 0
                    || !inShape(record, x, y)
                    || (!disabledToo && (record.style & WS_DISABLED) !== 0))
                {
                    continue;
                }
                if (hitTest(record, x, y) === HTCLIENT)
                {
                    visit(childrenOf(record));
                }
                found.push(record);
            }
        };
        // Top-level windows are kept bottom-up and children top-down: the
        // stacking GetWindow walks, and the one that decides who is hit.
        visit([...windows.values()].filter(record=>!record.destroyed
            && !isChild(record)).reverse());
        return found;
    };

    /**
     * The window under a screen point: the first of `windowsAt` that does
     * not say the point passes through it. Only the procedures on this side
     * are asked, as this answers without running the program -- routing
     * the input layer's messages as they arrive -- and `askedFromPoint`
     * asks the program's own.
     *
     * @param {number} x @param {number} y
     * @param {{ disabled?: boolean, transparent?: boolean }} [skip]
     *        Whether a disabled or a transparent window is passed over,
     *        which ChildWindowFromPointEx lets a caller choose.
     * @returns {{ record: any, hit: number } | null}
     */
    const windowFromPoint = (x, y, skip = { disabled: true, transparent: true })=>{
        for (const record of windowsAt(x, y, !skip.disabled))
        {
            if (!(skip.transparent && transparentAt(record)))
            {
                return { record, hit: hitTest(record, x, y) };
            }
        }
        return null;
    };

    /**
     * Whether a window lets the pointer through, asked of a procedure on
     * this side that answers without the program: what it answers
     * WM_NCHITTEST with. One that would run the program is not asked.
     *
     * @param {any} record
     */
    const transparentAt = record=>{
        const procedure = procedures.get(record.wndProc);
        if (!procedure || reachesProgram(record))
        {
            return false;
        }
        const answer = procedure(record, {
            hwnd: record.hwnd, message: WM_NCHITTEST, wParam: 0, lParam: 0,
        });
        return typeof answer === 'number' && (answer | 0) === HTTRANSPARENT;
    };

    /**
     * Whether a message to a window can run the program's code: its
     * procedure is the program's own, or the dialog class's, which hands
     * every message to the program's dialog procedure first.
     *
     * @param {any} record
     */
    const reachesProgram = record=>record.wndProc !== 0
        && (!procedures.has(record.wndProc)
            || procedures.get(record.wndProc) === controlProcedures['#32770']);

    /**
     * The window under a screen point as the program would find it, asked
     * from its own thread: each window in turn is sent WM_NCHITTEST -- a
     * program's own procedure run -- and the first that does not answer
     * HTTRANSPARENT is the one, with the hit it answered.
     *
     * @param {number} x @param {number} y @param {unknown} thread
     * @returns {{ record: any, hit: number } | null
     *     | Promise<{ record: any, hit: number } | null>}
     */
    const askedFromPoint = (x, y, thread)=>{
        const candidates = windowsAt(x, y);
        /** @param {number} index @returns {any} */
        const next = index=>{
            const record = candidates[index];
            if (!record)
            {
                return null;
            }
            if (!reachesProgram(record))
            {
                return transparentAt(record) ? next(index + 1)
                    : { record, hit: hitTest(record, x, y) };
            }
            return andThen(send(record.hwnd, WM_NCHITTEST, 0,
                ((y & 0xffff) << 16 | x & 0xffff) >>> 0, thread), answer=>((answer | 0)
                === HTTRANSPARENT ? next(index + 1) : { record, hit: answer | 0 }));
        };
        return next(0);
    };

    /** The buttons and keys held, as a client mouse message's wParam reports them. */
    const mouseKeys = ()=>{
        let keys = 0;
        for (const [vk, bit] of MOUSE_KEYS)
        {
            keys |= ((host.keyState?.(vk) ?? 0) & 0x8000) !== 0 ? bit : 0;
        }
        return keys;
    };

    /**
     * What TrackMouseEvent was asked to report: of which window, its hover or
     * its leaving or both, of its client area or, with TME_NONCLIENT, its
     * frame, and where the pointer was when the hover time last started.
     *
     * @type {{ hwnd: number, flags: number, hoverTime: number, x: number,
     *     y: number } | null}
     */
    let tracking = null;

    /**
     * Whether the point is over this window's client area, or its frame: a
     * child over it is not, since the pointer is then over the child.
     *
     * @param {number} x @param {number} y @param {number} hwnd @param {boolean} frame
     */
    const pointerIn = (x, y, hwnd, frame)=>{
        const found = windowFromPoint(x, y);
        return found !== null && found.record.hwnd === hwnd && (found.hit !== HTCLIENT) === frame;
    };

    const stopTracking = ()=>{
        tracking = null;
        host.queue.cancelLater(HOVER_KEY);
    };

    /** @param {number} hwnd @param {number} flags */
    const postLeave = (hwnd, flags)=>host.queue.post({ hwnd,
        message: (flags & TME_NONCLIENT) !== 0 ? WM_NCMOUSELEAVE : WM_MOUSELEAVE,
        wParam: 0, lParam: 0 });

    /**
     * The hover, made when its time has come: where the pointer is then, in
     * client coordinates with the buttons and keys held, or on the frame with
     * the hit and the screen point. Posting it ends the hover tracking.
     *
     * @returns {import('./messages.js').PostedMessage | null}
     */
    const hoverMessage = ()=>{
        const track = tracking;
        const record = track ? live(track.hwnd) : null;
        if (!track || !record || (track.flags & TME_HOVER) === 0)
        {
            return null;
        }
        track.flags &= ~TME_HOVER;
        if ((track.flags & TME_LEAVE) === 0)
        {
            tracking = null;
        }
        const at = host.cursor?.() ?? { x: 0, y: 0 };
        if ((track.flags & TME_NONCLIENT) !== 0)
        {
            return { hwnd: record.hwnd, message: WM_NCMOUSEHOVER,
                wParam: hitTest(record, at.x, at.y) >>> 0,
                lParam: ((at.y & 0xffff) << 16 | at.x & 0xffff) >>> 0 };
        }
        const origin = geometry.clientOrigin(record);
        return { hwnd: record.hwnd, message: WM_MOUSEHOVER, wParam: mouseKeys(),
            lParam: (((at.y - origin.y) & 0xffff) << 16 | (at.x - origin.x) & 0xffff) >>> 0 };
    };

    /** @param {number} x @param {number} y */
    const armHover = (x, y)=>{
        if (tracking)
        {
            tracking.x = x;
            tracking.y = y;
            host.queue.postLater(HOVER_KEY, tracking.hoverTime, hoverMessage);
        }
    };

    /**
     * The tracking, told where the pointer has gone: out of the area tracked
     * ends it with the leave if one was asked for, and out of the hover
     * rectangle starts the hover time again from there.
     *
     * @param {number} x @param {number} y
     */
    const followPointer = (x, y)=>{
        const track = tracking;
        if (!track)
        {
            return;
        }
        if (!pointerIn(x, y, track.hwnd, (track.flags & TME_NONCLIENT) !== 0))
        {
            stopTracking();
            if ((track.flags & TME_LEAVE) !== 0 && live(track.hwnd))
            {
                postLeave(track.hwnd, track.flags);
            }
            return;
        }
        if ((track.flags & TME_HOVER) !== 0 && (Math.abs(x - track.x) > HOVER_SIZE / 2
            || Math.abs(y - track.y) > HOVER_SIZE / 2))
        {
            armHover(x, y);
        }
    };

    /**
     * TrackMouseEvent's request, read from guest memory: a query filled in,
     * a cancellation of what it names, or tracking of the window the pointer
     * is over -- and for one it is not over, a leave posted at once.
     *
     * @param {number} request
     */
    const trackMouseEvent = request=>{
        const at = request >>> 0;
        if (at === 0 || readU32(host, at) !== TRACKMOUSEEVENT_SIZE)
        {
            host.setLastError?.(ERROR_INVALID_PARAMETER);
            return 0;
        }
        const flags = readU32(host, at + 4);
        if ((flags & TME_QUERY) !== 0)
        {
            const track = tracking && live(tracking.hwnd) ? tracking : null;
            writeU32s(host, at + 4, track ? [track.flags, track.hwnd, track.hoverTime] : [0, 0, 0]);
            return 1;
        }
        const record = live(readU32(host, at + 8));
        if (!record || record === desktop)
        {
            host.setLastError?.(ERROR_INVALID_WINDOW_HANDLE);
            return 0;
        }
        const asked = flags & (TME_HOVER | TME_LEAVE);
        const area = flags & TME_NONCLIENT;
        if ((flags & TME_CANCEL) !== 0)
        {
            if (tracking && tracking.hwnd === record.hwnd
                && (tracking.flags & TME_NONCLIENT) === area)
            {
                tracking.flags &= ~asked;
                if ((tracking.flags & TME_HOVER) === 0)
                {
                    host.queue.cancelLater(HOVER_KEY);
                }
                if ((tracking.flags & (TME_HOVER | TME_LEAVE)) === 0)
                {
                    stopTracking();
                }
            }
            return 1;
        }
        const pointer = host.cursor?.() ?? { x: 0, y: 0 };
        // Whatever was tracked is brought up to where the pointer is first,
        // so a window it has left hears so before another is tracked.
        followPointer(pointer.x, pointer.y);
        if (!pointerIn(pointer.x, pointer.y, record.hwnd, area !== 0))
        {
            if ((flags & TME_LEAVE) !== 0)
            {
                postLeave(record.hwnd, area);
            }
            return 1;
        }
        if (asked === 0)
        {
            return 1;
        }
        if (!tracking || tracking.hwnd !== record.hwnd
            || (tracking.flags & TME_NONCLIENT) !== area)
        {
            stopTracking();
            tracking = { hwnd: record.hwnd, flags: area, hoverTime: HOVER_TIME,
                x: pointer.x, y: pointer.y };
        }
        tracking.flags |= asked;
        if ((flags & TME_HOVER) !== 0)
        {
            const time = readU32(host, at + 12);
            tracking.hoverTime = time === 0 || time === HOVER_DEFAULT ? HOVER_TIME : time;
            armHover(pointer.x, pointer.y);
        }
        return 1;
    };

    /**
     * Where a message from the input layer goes. A mouse message carries the
     * pointer's position on the screen; it goes to the window that has the
     * mouse, or the one under the point, with the position made relative to
     * that window's client area -- or, on the frame, as a non-client message
     * with the hit code. A key goes to the window with the focus.
     *
     * @param {import('./messages.js').PostedMessage} message
     * @returns {import('./messages.js').PostedMessage | null} null to drop it
     */
    const route = message=>{
        // Only what the input layer posts names a position; a message a
        // program posts to a window of its choosing is left to it.
        if (message.x === undefined || message.y === undefined)
        {
            return message;
        }
        const kind = message.message >>> 0;
        if (kind >= WM_KEYFIRST && kind <= WM_KEYLAST)
        {
            const target = focusWindow() || activeWindow();
            return target === 0 ? message : { ...message, hwnd: target };
        }
        if (kind < WM_MOUSEMOVE || kind > WM_MOUSELAST)
        {
            return message;
        }
        const x = message.x | 0;
        const y = message.y | 0;
        followPointer(x, y);
        if (kind === WM_MOUSEWHEEL)
        {
            const target = focusWindow() || activeWindow();
            return target === 0 ? message : { ...message, hwnd: target };
        }
        if (captured !== 0 && live(captured))
        {
            const origin = geometry.clientOrigin(windows.get(captured));
            return { ...message, hwnd: captured,
                lParam: (((y - origin.y) & 0xffff) << 16 | (x - origin.x) & 0xffff) >>> 0 };
        }
        const found = windowFromPoint(x, y);
        if (!found)
        {
            return null;
        }
        // A press activates the window it lands in when the program takes
        // it from the queue -- `mouseActivate` -- not here, where nothing of
        // the program is running to be told.
        if (found.hit !== HTCLIENT)
        {
            return { ...message, hwnd: found.record.hwnd,
                message: kind + WM_NCMOUSEMOVE - WM_MOUSEMOVE,
                wParam: found.hit >>> 0, lParam: ((y & 0xffff) << 16 | x & 0xffff) >>> 0 };
        }
        const origin = geometry.clientOrigin(found.record);
        return { ...message, hwnd: found.record.hwnd,
            lParam: (((y - origin.y) & 0xffff) << 16 | (x - origin.x) & 0xffff) >>> 0 };
    };
    host.queue.routeWith?.(route);

    /**
     * What a press does as the program takes it from the queue: the window
     * it landed in is asked with WM_MOUSEACTIVATE whether to activate --
     * sent from the thread taking it, before the press reaches the window --
     * and its top-level window is activated and raised unless it says not
     * to. An answer that eats the click means the press is not delivered.
     *
     * @param {any} entry @param {unknown} thread
     * @returns {boolean | Promise<boolean>} whether the press is still delivered
     */
    const mouseActivate = (entry, thread)=>{
        const record = PRESSES.has(entry.message >>> 0) ? live(entry.hwnd) : null;
        if (!record)
        {
            return true;
        }
        const top = topLevelOf(record);
        if (top.hwnd === activeWindow())
        {
            return true;
        }
        const hit = (entry.message >>> 0) >= WM_MOUSEMOVE ? HTCLIENT : entry.wParam & 0xffff;
        return andThen(send(record.hwnd, WM_MOUSEACTIVATE, top.hwnd,
            ((entry.message & 0xffff) << 16 | hit) >>> 0, thread), answer=>{
            const how = answer >>> 0;
            const eaten = how === MA_ACTIVATEANDEAT || how === MA_NOACTIVATEANDEAT;
            if (how === MA_NOACTIVATE || how === MA_NOACTIVATEANDEAT)
            {
                return !eaten;
            }
            raise(top);
            return andThen(activate(top.hwnd, { thread, how: WA_CLICKACTIVE }),
                ()=>!eaten);
        });
    };

    /**
     * WM_SETCURSOR, sent as a message of the mouse's own is taken, to the
     * window the pointer is over -- its hit, and the client form of the mouse
     * message, in lParam -- as Windows sends it whenever the cursor moves in
     * a window with the mouse not captured. Sent from the thread taking the
     * message, like WM_MOUSEACTIVATE; the wheel moves no cursor, and a
     * message a program posted itself is no move of it.
     *
     * @param {any} entry @param {unknown} thread
     * @returns {number | Promise<number>}
     */
    const askCursor = (entry, thread)=>{
        const kind = entry.message >>> 0;
        const client = kind >= WM_MOUSEMOVE && kind <= WM_MOUSELAST && kind !== WM_MOUSEWHEEL;
        const frame = kind >= WM_NCMOUSEMOVE && kind <= WM_NCMOUSELAST;
        const record = client || frame ? live(entry.hwnd) : null;
        if (!record || captured !== 0 || !host.queue.fromInput(entry))
        {
            return 0;
        }
        const hit = client ? HTCLIENT : entry.wParam & 0xffff;
        const mouse = client ? kind : kind - WM_NCMOUSEMOVE + WM_MOUSEMOVE;
        return send(record.hwnd, WM_SETCURSOR, record.hwnd, ((mouse & 0xffff) << 16 | hit) >>> 0,
            thread);
    };

    /**
     * The mouse's own message, sent where the program's procedures say the
     * pointer is: it was routed as it arrived by what this side can answer
     * alone, and a window whose messages run the program's code -- its own
     * procedure, or a dialog's -- is asked WM_NCHITTEST as the message is
     * taken: one that answers HTTRANSPARENT passes it to the window beneath,
     * and the hit answered decides whether it is the client or the frame
     * form of the message.
     *
     * @param {any} entry @param {unknown} thread
     * @returns {any} the entry, placed
     */
    const rehit = (entry, thread)=>{
        if (!askable(entry))
        {
            return entry;
        }
        const kind = entry.message >>> 0;
        const client = kind >= WM_MOUSEMOVE && kind <= WM_MOUSELAST;
        const x = entry.x | 0;
        const y = entry.y | 0;
        return andThen(askedFromPoint(x, y, thread), found=>{
            if (!found)
            {
                return entry;
            }
            const clientKind = client ? kind : kind - WM_NCMOUSEMOVE + WM_MOUSEMOVE;
            // An XBUTTON's number rides in the high word of either form.
            const high = entry.wParam & 0xffff0000;
            entry.hwnd = found.record.hwnd;
            if (found.hit === HTCLIENT)
            {
                const origin = geometry.clientOrigin(found.record);
                entry.message = clientKind;
                entry.wParam = (high | (client ? entry.wParam & 0xffff : mouseKeys())) >>> 0;
                entry.lParam = (((y - origin.y) & 0xffff) << 16 | (x - origin.x) & 0xffff) >>> 0;
            }
            else
            {
                entry.message = clientKind + WM_NCMOUSEMOVE - WM_MOUSEMOVE;
                entry.wParam = (high | found.hit & 0xffff) >>> 0;
                entry.lParam = ((y & 0xffff) << 16 | x & 0xffff) >>> 0;
            }
            return entry;
        });
    };

    /**
     * Whether `rehit` asks the program's procedures where a message goes: a
     * mouse message from the input layer, for a window whose messages run
     * the program's code, while nothing holds the capture.
     *
     * @param {any} entry
     */
    const askable = entry=>{
        const kind = entry.message >>> 0;
        const client = kind >= WM_MOUSEMOVE && kind <= WM_MOUSELAST && kind !== WM_MOUSEWHEEL;
        const frame = kind >= WM_NCMOUSEMOVE && kind <= WM_NCMOUSELAST;
        const target = client || frame ? live(entry.hwnd) : null;
        return target !== null && reachesProgram(target) && captured === 0
            && host.queue.fromInput(entry);
    };

    /**
     * Places the mouse messages a retrieval could take before its filter
     * looks at them, oldest first, up to the first the filter takes: the
     * range and the window a program asks for are those of the message as
     * its procedures place it, not as it arrived. Only a message the range
     * could take in either form is asked about.
     *
     * @param {import('./messages.js').MessageFilter} filter @param {unknown} thread
     * @returns {null | Promise<null>}
     */
    const placeWaiting = (filter, thread)=>{
        const asked = new Set();
        /** @param {number} kind */
        const inRange = kind=>(filter.first === 0 && filter.last === 0)
            || (kind >= filter.first && kind <= filter.last);
        /** @returns {any} */
        const walk = ()=>{
            for (const entry of host.queue.queued(filter.thread ?? threadIdOf(thread)))
            {
                const kind = entry.message >>> 0;
                const client = kind >= WM_MOUSEMOVE ? kind : kind - WM_NCMOUSEMOVE + WM_MOUSEMOVE;
                if (!asked.has(entry) && askable(entry)
                    && (inRange(client) || inRange(client + WM_NCMOUSEMOVE - WM_MOUSEMOVE)))
                {
                    asked.add(entry);
                    return andThen(rehit(entry, thread), walk);
                }
                if (host.queue.accepts(entry, filter))
                {
                    return null;
                }
            }
            return null;
        };
        return walk();
    };

    /**
     * The next message a retrieval takes, placed where the program's
     * procedures say the pointer is, a press having activated its window
     * first and the window under the pointer asked for its cursor; a press
     * its window ate is passed over for the one after.
     *
     * @param {import('./messages.js').MessageFilter} filter @param {unknown} thread
     * @returns {any}
     */
    const takeThrough = (filter, thread)=>andThen(placeWaiting(filter, thread), ()=>{
        const entry = host.queue.peek(filter.thread === undefined
            ? { ...filter, thread: threadIdOf(thread) } : filter);
        if (!entry)
        {
            return null;
        }
        return andThen(mouseActivate(entry, thread), (/** @type {boolean} */ keep)=>(keep
            ? andThen(askCursor(entry, thread), ()=>andThen(
                askKeyboardHooks(entry, HC_ACTION, thread),
                (/** @type {number} */ refused)=>((refused | 0) !== 0
                    ? takeThrough(filter, thread) : entry)))
            : takeThrough(filter, thread)));
    });

    /**
     * A key message being retrieved, shown to the thread's WH_KEYBOARD hooks
     * first, as Windows shows it: the virtual key and the message's lParam,
     * HC_ACTION when it is taken and HC_NOREMOVE when it is only looked at.
     * A hook that answers nonzero on HC_ACTION discards the message. A
     * program that keeps its key state in such a hook hears no key at all
     * without it.
     *
     * @param {any} entry @param {number} code @param {unknown} thread
     * @returns {number | Promise<number>}
     */
    const askKeyboardHooks = (entry, code, thread)=>(!KEY_MESSAGES.has(entry.message >>> 0)
        || chainOf(WH_KEYBOARD, thread).length === 0 ? 0
        : callHook(WH_KEYBOARD, null, [code, entry.wParam >>> 0, entry.lParam >>> 0], thread));

    /**
     * The default window procedure, as every window procedure falls back on
     * it. The frame, the background, the hit test, the text, activation and
     * the close box live here; what a program's procedure does not handle,
     * this does.
     *
     * @param {any} record @param {DispatchedMessage} message @param {unknown} [thread]
     * @returns {number | Promise<number>}
     */
    const defWindowProc = (record, message, thread)=>{
        switch (message.message >>> 0){
            // TRUE, and it has to be: a procedure that does not handle
            // WM_NCCREATE passes it here, and answering FALSE would refuse
            // every window such a program tries to make.
            case WM_NCCREATE:
                return 1;
            case WM_NCCALCSIZE: {
                // The client area inside the frame the style describes.
                const at = message.lParam >>> 0;
                if (at !== 0)
                {
                    const view = new DataView(host.readMemory(at, 16).slice().buffer);
                    const edges = geometry.styleFrame(record);
                    writeU32s(host, at, [view.getInt32(0, true) + edges.left,
                        view.getInt32(4, true) + edges.top, view.getInt32(8, true) - edges.right,
                        view.getInt32(12, true) - edges.bottom]);
                }
                return 0;
            }
            case WM_WINDOWPOSCHANGED: {
                // What SetWindowPos did, told as the two messages a program
                // lays itself out by: the client area's corner -- on the
                // screen, or in the parent's client area for a child -- if it
                // moved, and its size if that changed.
                const word = (message.lParam >>> 0) === 0 ? null
                    : host.readMemory((message.lParam >>> 0) + 24, 4);
                const flags = word ? (word[0] | word[1] << 8 | word[2] << 16 | word[3] << 24) : 0;
                const client = geometry.clientRect(record);
                const parent = isChild(record) ? live(record.parent) : null;
                const base = parent ? geometry.clientRect(parent) : { left: 0, top: 0 };
                const x = client.left - base.left;
                const y = client.top - base.top;
                const moved = (flags & SWP_NOCLIENTMOVE) !== 0 ? 0 : send(record.hwnd, WM_MOVE, 0,
                    ((y & 0xffff) << 16 | x & 0xffff) >>> 0, thread);
                return andThen(moved, ()=>andThen((flags & SWP_NOCLIENTSIZE) !== 0 ? 0
                    : send(record.hwnd, WM_SIZE, (record.style & WS_MINIMIZE) !== 0 ? SIZE_MINIMIZED
                        : (record.style & WS_MAXIMIZE) !== 0 ? SIZE_MAXIMIZED : SIZE_RESTORED,
                    (((client.bottom - client.top) & 0xffff) << 16
                        | (client.right - client.left) & 0xffff) >>> 0, thread), ()=>0));
            }
            case WM_NCPAINT:
                paintFrame(record);
                return 0;
            case WM_ERASEBKGND: {
                // The class background: a brush the program made, or a
                // system colour plus one. No brush means no erasing, which
                // the program is told by the zero.
                const cls = classNamed(record.className);
                const brush = (cls?.background ?? 0) >>> 0;
                if (brush === 0 || !draw)
                {
                    return 0;
                }
                const size = geometry.clientSize(record);
                const area = { left: 0, top: 0, right: size.width, bottom: size.height };
                if (brush <= SYS_COLOR_BRUSH_LIMIT)
                {
                    draw.fill(message.wParam, area, sysColor(brush - 1));
                }
                else
                {
                    draw.fillWith(message.wParam, area, brush);
                }
                return 1;
            }
            case WM_CLOSE:
                return andThen(destroyAsked(record.hwnd, thread), ()=>0);
            // Validates the window: a procedure that hands WM_PAINT here has
            // nothing to draw, and the area has to be cleared or the same
            // paint is retrieved for ever. The frame and background still
            // go out, which is what BeginPaint does.
            case WM_PAINT:
                return andThen(paint.beginPaint(record), ({ hdc })=>{
                    paint.endPaint(record, hdc);
                    return 0;
                });
            case WM_NCHITTEST: {
                const point = pointOf(message.lParam);
                return hitTest(record, point.x, point.y) >>> 0;
            }
            case WM_NCLBUTTONDOWN: {
                const hit = message.wParam | 0;
                if (hit === HTCLOSE)
                {
                    return send(record.hwnd, WM_SYSCOMMAND, SC_CLOSE, message.lParam, thread);
                }
                if (hit === HTVSCROLL || hit === HTHSCROLL)
                {
                    const point = pointOf(message.lParam);
                    return clickScrollBar(record, hit, point.x, point.y, thread);
                }
                return 0;
            }
            case WM_SYSCOMMAND:
                // A CBT hook hears the command before it is carried out.
                return andThen(askCbt(HCBT_SYSCOMMAND, message.wParam, message.lParam,
                    thread ?? host.callerThread?.()), refused=>{
                    if ((refused | 0) === 0 && (message.wParam & 0xfff0) === SC_CLOSE)
                    {
                        return send(record.hwnd, WM_CLOSE, 0, 0, thread);
                    }
                    return 0;
                });
            case WM_SETCURSOR: {
                // The parent decides first -- a dialog chooses for its
                // controls -- except on a sizing border, which is the
                // window's own. What a parent passes on names the window
                // under the cursor in wParam, and that window's class cursor
                // is the one set.
                const hit = (message.lParam << 16) >> 16;
                const parent = isChild(record) && (hit < HTSIZEFIRST || hit > HTSIZELAST)
                    ? live(record.parent) : null;
                return andThen(parent ? send(parent.hwnd, WM_SETCURSOR, message.wParam,
                    message.lParam, thread) : 0, handled=>((handled >>> 0) !== 0
                    ? 1 : setCursorOver(windows.get(message.wParam >>> 0) ?? record, hit)));
            }
            case WM_MOUSEACTIVATE:
                // A child asks its parent first, as the default procedure
                // does: a dialog decides for the controls in it.
                if (isChild(record) && live(record.parent))
                {
                    return andThen(send(record.parent, WM_MOUSEACTIVATE, message.wParam,
                        message.lParam, thread),
                    answer=>((answer >>> 0) !== 0 ? answer : MA_ACTIVATE));
                }
                return MA_ACTIVATE;
            case WM_SETTEXT: {
                const address = message.lParam >>> 0;
                record.title = address === 0 ? '' : host.readCString(address, MAX_WINDOW_TEXT);
                tell(record);
                // The caption is drawn again now, and no WM_PAINT is owed for it.
                if (geometry.frame(record).caption > 0 && shown(record))
                {
                    paintFrame(record);
                }
                return 1;
            }
            case WM_GETTEXT: {
                const room = message.wParam >>> 0;
                const out = message.lParam >>> 0;
                if (room === 0 || out === 0)
                {
                    return 0;
                }
                const text = record.title.slice(0, room - 1);
                writeString(out, text);
                return text.length;
            }
            case WM_GETTEXTLENGTH:
                return record.title.length;
            // The system's colours are set in the context as well as the
            // brush answered: the window text, on the 3D face or on the
            // window colour for an edit or a list box.
            case WM_CTLCOLORSTATIC:
            case WM_CTLCOLORBTN:
            case WM_CTLCOLORDLG:
            case WM_CTLCOLORSCROLLBAR:
                controls.helpers.defaultControlColors(message.message, message.wParam >>> 0);
                return draw ? draw.solidBrush(sysColor(COLOR_3DFACE)) : 0;
            case WM_CTLCOLOREDIT:
            case WM_CTLCOLORLISTBOX:
                controls.helpers.defaultControlColors(message.message, message.wParam >>> 0);
                return 0;
            case WM_VSCROLL:
            case WM_HSCROLL:
                return scrollWindowBar(record, message);
            case WM_ACTIVATE:
            case WM_NCACTIVATE:
            case WM_SHOWWINDOW:
            default:
                return 0;
        }
    };

    /**
     * The cursor the default procedure sets for a hit test on a window: its
     * class cursor over the client area, answering FALSE for a class that has
     * none, and the arrow anywhere else, answering what SetCursor answers.
     *
     * @param {any} record @param {number} hit
     */
    const setCursorOver = (record, hit)=>{
        if (hit !== HTCLIENT)
        {
            return table.SetCursor.handler([IDC_ARROW]);
        }
        const cursor = (classNamed(record.className)?.cursor ?? 0) >>> 0;
        if (cursor === 0)
        {
            return 0;
        }
        table.SetCursor.handler([cursor]);
        return 1;
    };

    /**
     * A window's own scroll bar was clicked and the program's procedure left
     * it to the default, which moves the position and repaints the bar. The
     * program that wanted to scroll its contents would have handled it.
     *
     * @param {any} record @param {DispatchedMessage} message
     */
    const scrollWindowBar = (record, message)=>{
        const vertical = message.message === WM_VSCROLL;
        const held = scrollOf(record, vertical ? SB_VERT : SB_HORZ);
        const code = message.wParam & 0xffff;
        const page = Math.max(1, held.page);
        const by = code === SB_LINEUP ? -1 : code === SB_LINEDOWN ? 1
            : code === SB_PAGEUP ? -page : code === SB_PAGEDOWN ? page : 0;
        const ceiling = Math.max(held.min, held.max - Math.max(held.page - 1, 0));
        held.pos = Math.min(Math.max(held.pos + by, held.min), ceiling);
        return 0;
    };

    /**
     * What the frame's own hit test does with a click on a scroll bar: the
     * WM_VSCROLL or WM_HSCROLL the bar would send, sent to the window.
     *
     * @param {any} record @param {number} hit @param {number} x @param {number} y
     * @param {unknown} [thread]
     */
    const clickScrollBar = (record, hit, x, y, thread)=>{
        const vertical = hit === HTVSCROLL;
        const rect = geometry.windowRect(record);
        const bar = scrollBarRect(record, vertical);
        const code = controls.helpers.scrollHit(bar, vertical,
            scrollOf(record, vertical ? SB_VERT : SB_HORZ), x - rect.left, y - rect.top);
        if (code === SB_ENDSCROLL)
        {
            return 0;
        }
        return andThen(send(record.hwnd, vertical ? WM_VSCROLL : WM_HSCROLL, code, 0, thread), ()=>{
            paintFrame(record);
            return 0;
        });
    };

    /**
     * The picture an icon or cursor handle stands for, for what draws one --
     * DrawIcon, a static showing an icon. system.js decodes it, and hands
     * over how once it is made (`pictures` below).
     *
     * @type {(handle: number) => import('./cursors.js').CursorPicture | null}
     */
    let pictureOf = ()=>null;
    /** SetWindowPos as system.js places a window, for a caller on this side naming its thread.
     * @type {(args: number[], thread?: unknown) => any} */
    let placeWindow = ()=>0;

    // The thread's caret, drawn into its window's client area and taken off
    // while the window paints.
    // Threads by their ids where the bridge gives them one: the same
    // thread may reach here as more than one object.
    const caret = createCaret({
        live,
        caller: ()=>{
            const thread = host.callerThread?.();
            return threadIdOf(thread) ?? thread;
        },
        threadOf: record=>threadIdOf(record.thread) ?? record.thread,
        contextOn: record=>paint.contextOn(record),
        release: (record, hdc)=>host.dc?.()?.release(record.hwnd, hdc),
        draw,
        painted,
        bitmapSize: host.bitmapSize,
        writeMemory: host.writeMemory,
        setLastError: host.setLastError,
        divergence: host.divergence,
    });

    const paint = createPaintFunctions({
        // The drawing with the system colours on it, which FillRect needs
        // for a brush named as a colour index.
        host: Object.assign(Object.create(host), {
            draw,
            picture: (/** @type {number} */ handle)=>pictureOf(handle),
        }),
        live, WM_PAINT, geometry, send, invalidated, painted, shown,
        descendants: (/** @type {any} */ record)=>paintedDescendantsOf(record),
        children: (/** @type {any} */ record)=>childrenOf(record),
        parentOf: (/** @type {any} */ record)=>(isChild(record) ? live(record.parent) : null),
        frozen: (/** @type {any} */ record)=>frozen(record),
        desktop: ()=>desktopWindow().hwnd,
        covering: coveringOf,
        layoutRevision: ()=>layoutRevision,
        classOf: (/** @type {any} */ record)=>classes.get(record.className) ?? null,
        isWindow: (/** @type {number} */ hwnd)=>Boolean(live(hwnd)
            || directory.describe(hwnd, processId)),
        caret,
    });

    // A modifier as of the message being translated, as Windows reads the
    // thread's synchronous state; the live state before any key was taken.
    /** @param {number} vk */
    const heldAsOfMessage = vk=>host.queue.heldAsOfMessage?.(vk)
        ?? ((host.keyState?.(vk) ?? 0) & 0x8000) !== 0;

    /**
     * What TranslateMessage does: a key press becomes the character the
     * host's own keyboard layout made of it, posted after the press. That is
     * where a layout, a dead key and an input method live, and none of them
     * can be worked out from a virtual key here; for a host that composes
     * nothing -- a recorded session, a test -- the character is the one
     * layout table's (`keys.js`), under the modifiers held as of the message:
     * the same answer ToUnicode gives for the same key state.
     *
     * @param {{ hwnd: number, message: number, wParam: number, lParam: number }} message
     * @returns {number} nonzero for any of the four key messages, whether or
     *     not a character came of it, as documented.
     */
    const translate = message=>{
        if (!KEY_MESSAGES.has(message.message))
        {
            return 0;
        }
        const isDown = message.message === WM_KEYDOWN || message.message === WM_SYSKEYDOWN;
        const character = isDown
            ? host.queue.takeComposed?.(message.lParam) ?? characterOf(message.wParam & 0xff, {
                shift: heldAsOfMessage(0x10),
                capsLock: ((host.keyState?.(0x14) ?? 0) & 0x0001) !== 0,
                control: heldAsOfMessage(0x11),
            })
            : null;
        if (character !== null)
        {
            host.queue.post({
                hwnd: message.hwnd,
                message: message.message === WM_SYSKEYDOWN ? WM_SYSCHAR : WM_CHAR,
                wParam: character,
                lParam: message.lParam,
            });
        }
        return 1;
    };

    /** @param {any} record @param {number} hdc */
    const inFont = (record, hdc)=>{
        if (hdc !== 0 && record.font)
        {
            draw?.selectFont?.(hdc, record.font);
        }
    };

    /**
     * The clipboard the object half keeps, once it has been built beside the
     * controls that copy to it and paste from it.
     *
     * @type {import('./objects.js').ClipboardService | null}
     */
    let clipboardAccess = null;

    // The host the system classes and the common controls share: what a
    // procedure needs of the window manager around it, in one object, so a
    // control in comctl32 paints and tells its parent exactly as one here does.
    /** @type {import('./controls.js').ControlHost} */
    const controlHost = {
        clipboard: {
            text: ()=>clipboardAccess?.text() ?? null,
            copy: text=>clipboardAccess?.copy(text) ?? false,
        },
        readCString: host.readCString,
        writeMemory: host.writeMemory,
        readMemory: host.readMemory,
        draw,
        picture: (/** @type {number} */ handle)=>pictureOf(handle),
        live,
        windowOf: hwnd=>windows.get(hwnd >>> 0) ?? null,
        clientSize: record=>geometry.clientSize(record),
        children: childrenOf,
        send,
        callProcedure,
        post: message=>host.queue.post(message),
        defWindowProc,
        // A control paints and measures in the font it was given, as the
        // real ones select it before drawing; a fresh context carries the
        // system font, which is only right for a control given none.
        beginPaint: record=>andThen(paint.beginPaint(record), painting=>{
            inFont(record, painting.hdc);
            return painting;
        }),
        contextOn: record=>{
            const hdc = paint.contextOn(record);
            inFont(record, hdc);
            return { hdc, rect: paint.clientArea(record) };
        },
        endPaint: (record, hdc)=>paint.endPaint(record, hdc),
        invalidate: record=>{
            const size = geometry.clientSize(record);
            paint.invalidate(record, { left: 0, top: 0, right: size.width, bottom: size.height },
                true);
        },
        // A control repainting itself as it handles a message -- its new
        // text, its new position -- is the control alone: Windows sends its
        // parent WM_CTLCOLOR* then (user32's WmSetTextButtonSeq), never
        // WM_PAINT. What the change left the parent to paint waits for the
        // parent's next look at its queue.
        update: (record, thread)=>(shown(record)
            ? paint.updateNow(record, true, thread) : 1),
        // A control's own scroll bar moved: its frame, where the bar is drawn.
        // Drawn now when shown; a hidden one is framed whole when it appears.
        frameChanged: record=>{
            if (shown(record))
            {
                paintFrame(record);
            }
        },
        move: (hwnd, x, y, width, height)=>/** @type {any} */ (table).MoveWindow
            .handler([hwnd, x, y, width, height, 1]),
        setFocus,
        focus: focusWindow,
        setCapture: hwnd=>{
            setCapture(hwnd);
        },
        capture: ()=>captured,
        releaseCapture,
        sysColor,
        keyDown: key=>((host.keyState?.(key) ?? 0) & 0x8000) !== 0,
        allocate: host.allocate,
        release: host.release,
        call: host.call,
        divergence: host.divergence,
        caret: caret.table,
        files: host.files,
    };
    const controls = createControlProcedures(controlHost);
    Object.assign(controlProcedures, controls.procedures);

    /**
     * Files a common-control class beside the user32 ones: a name a program
     * creates it by, a procedure on this side, and what a window of it
     * carries. The atom is only spacing for the address a build without a
     * bridge hands out; a program names these classes by string, never by
     * `#number`, so it is not registered as a spelling of the name.
     *
     * @param {{ name: string, procedure: any, atom?: number, windowExtra?: number,
     *     background?: number }} definition
     */
    const registerSystemClass = definition=>{
        systemClasses.set(definition.name.toLowerCase(), {
            name: definition.name,
            atom: definition.atom ?? 0,
            style: 0,
            wndProc: 0,
            classExtra: 0,
            windowExtra: definition.windowExtra ?? 0,
            instance: 0,
            icon: 0,
            cursor: IDC_ARROW,
            background: definition.background ?? 0,
            menuName: 0,
            className: 0,
            iconSm: 0,
        });
        controlProcedures[definition.name] = definition.procedure;
    };
    host.registerControls?.(controlHost, controls.toolkit, registerSystemClass);

    // The MDI client: a built-in class whose procedure keeps a frame's document
    // windows, through the window manager's own calls (mdi.js).
    /**
     * DefWindowProc for a message, run on the thread a caller past an await
     * names; a wide message reaches it converted, as DefWindowProcW's does.
     *
     * @param {number[]} args  hwnd, message, wParam, lParam
     * @param {boolean} wide @param {unknown} thread
     * @returns {number | Promise<number>}
     */
    const defaultFor = ([hwnd, message, wParam, lParam], wide, thread)=>{
        const record = windows.get(hwnd >>> 0);
        if (!record)
        {
            return (message >>> 0) === WM_NCCREATE ? 1 : 0;
        }
        return translated(host, {
            hwnd: hwnd >>> 0, message: message >>> 0, wParam: wParam >>> 0,
            lParam: lParam >>> 0, ...wide ? { unicode: true } : {},
        }, false, ansi=>defWindowProc(record, ansi, thread));
    };

    const mdi = createMdi({
        host,
        call: (name, args)=>/** @type {any} */ (table)[name].handler(args),
        position: (args, thread)=>placeWindow(args, thread),
        send,
        create: (args, thread, unicode)=>createWindow(args, unicode === true, thread),
        show: (hwnd, cmdShow, thread)=>{
            const record = live(hwnd);
            return record ? showWindow(record, cmdShow, thread) : 0;
        },
        focus: setFocus,
        destroy: (hwnd, thread)=>destroyWindow(hwnd, thread),
        defWindowProc,
        sizeOf: hwnd=>{
            const record = live(hwnd);
            return record ? geometry.clientSize(record) : { width: 0, height: 0 };
        },
    });
    registerSystemClass({ name: 'MDIClient', procedure: mdi.procedure,
        background: COLOR_APPWORKSPACE + 1 });

    // The system classes: known under their names and their atoms, each
    // with a procedure on this side and, once wanted, an address a program
    // can hold.
    SYSTEM_CLASSES.forEach(definition=>{
        const cls = {
            name: definition.name,
            atom: definition.atom,
            style: 0,
            wndProc: 0,
            classExtra: 0,
            windowExtra: definition.windowExtra,
            instance: 0,
            icon: 0,
            cursor: definition.cursor ?? IDC_ARROW,
            background: definition.background,
            menuName: 0,
            className: 0,
            iconSm: 0,
        };
        systemClasses.set(definition.name.toLowerCase(), cls);
        systemClasses.set(`#${definition.atom}`, cls);
        atoms.set(definition.atom, definition.name);
    });

    // user32 is one table to the guest and five files only because the subjects
    // are: windows and classes here, painting and its device contexts next
    // door, what a program asks the system about itself after that, the things
    // a window owns, and dialogs. They share the window records rather than
    // each keeping a copy, which is why they are built here.
    // Where WM_PAINT comes from: a visible window with an area still to
    // paint, the one the filter names or the first found in paint order, so
    // a window is painted before what lies over it. Made up by the queue at
    // retrieval rather than posted, because that is what keeps a hundred
    // invalidations one paint. Nothing left to paint is the end of a pass,
    // and the moment the desktop is shown.
    host.queue.sendsFrom?.(thread=>(inbox.get(thread)?.length ?? 0) > 0
        || (answered.get(thread)?.length ?? 0) > 0);

    host.queue.ownersFrom?.(hwnd=>{
        const record = live(hwnd);
        return record ? creatorOf(record) : null;
    });

    host.queue.paintsFrom?.(filter=>{
        const asking = filter.thread ?? null;
        // Asked at every look into a queue -- a game's loop looks a hundred
        // thousand times a second -- and mostly no window this look may be
        // given owes a paint, though one may: a hidden window's controls
        // keep theirs for as long as it stays hidden. The order is only
        // worked out when it has two windows to choose between.
        let waiting = false;
        /** @type {any[]} */
        const due = [];
        for (const record of windows.values())
        {
            if (!paint.owesPaint(record) || record.destroyed)
            {
                continue;
            }
            waiting = true;
            if (inPaintOrder(record) && shown(record) && !frozen(record)
                && (filter.hwnd === ANY_WINDOW || filter.hwnd === record.hwnd)
                && (asking === null || creatorOf(record) === null || creatorOf(record) === asking))
            {
                due.push(record);
            }
        }
        if (due.length === 1)
        {
            return due[0].hwnd;
        }
        if (due.length > 1)
        {
            const choosable = new Set(due);
            const first = paintOrder().find(record=>choosable.has(record));
            if (first)
            {
                return first.hwnd;
            }
        }
        if (!waiting)
        {
            paintingSince = null;
        }
        presentIfPainted();
        return 0;
    }, hwnd=>{
        // An internal paint is handed out once (MSDN WM_PAINT).
        const record = live(hwnd);
        if (record)
        {
            record.internalPaint = false;
        }
    });

    const rawInput = createRawInput({
        host,
        isWindow: hwnd=>live(hwnd) !== null,
        focus: ()=>focusWindow() || activeWindow(),
        foreground: hwnd=>{
            const record = live(hwnd);
            return record !== null && topLevelOf(record).hwnd === activeWindow();
        },
    });

    host.windowService?.({
        /**
         * Brings a device context a program holds up to where its window now
         * is and what of it now shows, before it draws.
         *
         * @param {number} hdc
         */
        refreshContext: hdc=>paint.refreshContext(hdc),

        /** The window GetForegroundWindow answers with, or zero. */
        active: ()=>activeWindow(),
        deactivated: ()=>!applicationActive,
        deactivations: ()=>deactivations,

        modalLoop: (hwnd, { thread, first })=>(runModal
            ? runModal(hwnd >>> 0, thread, first) : 0),

        /**
         * A window on the screen has an area to paint, and has had one for
         * less than PAINT_HOLD_MS: a draw then is the middle of a pass -- a
         * frame painted before the window inside it, a page's controls before
         * the page -- and the desktop is shown when the pass ends. A window
         * nobody paints for longer holds nothing back: a program drawing
         * through GetDC every frame and never pumping its messages still has
         * its frames seen.
         */
        painting(){
            for (const record of windows.values())
            {
                if (paint.owesPaint(record) && !record.destroyed && shown(record)
                    && !frozen(record))
                {
                    const at = host.now?.() ?? 0;
                    paintingSince ??= at;
                    return at - paintingSince < PAINT_HOLD_MS;
                }
            }
            paintingSince = null;
            return false;
        },

        /**
         * One event of the mouse or the keyboard as the device reported it,
         * for WM_INPUT: what a program that registered for raw input reads,
         * beside the messages it has always had.
         */
        rawInput: rawInput.deliver,

        /**
         * One window's client rectangle on the screen, or null for a handle
         * that names no window. Read by whoever has to answer a size a
         * program asked for as zero -- a back buffer's, which means exactly
         * this rectangle -- or place a picture inside the window.
         *
         * @param {number} hwnd
         */
        clientRect: hwnd=>{
            const record = live(hwnd);
            return record ? geometry.clientRect(record) : null;
        },
        list: ()=>[...windows.values()]
            .filter(record=>!record.destroyed)
            .map(record=>({
                hwnd: `0x${record.hwnd.toString(16)}`,
                x: record.x, y: record.y, width: record.width, height: record.height,
                // On the screen, frame and client apart: where a click lands.
                rect: geometry.windowRect(record),
                client: geometry.clientRect(record),
                // In window coordinates: the part of it on the screen at all.
                region: record.regionBox ?? null,
                visible: (record.style & WS_VISIBLE) !== 0,
                className: record.className,
                title: record.title,
                parent: record.parent || record.owner
                    ? `0x${(record.parent || record.owner).toString(16)}` : null,
                // Inside its parent, as against owned by it: a top-level
                // window with an owner is still over everything below it.
                child: isChild(record),
                id: record.id,
                // The styles that decide how it paints beside its siblings.
                style: `0x${(record.style >>> 0).toString(16)}`,
                exStyle: `0x${(record.exStyle >>> 0).toString(16)}`,
            })),
        /**
         * Places a window the way SetWindowPos does, and tells the program the
         * way DefWindowProc would: a move when it moved and a size when its
         * size changed, and nothing for a placement that changed neither. A
         * program of this era re-reads its rectangle on WM_SIZE and clips its
         * cursor to it, which is exactly what has to happen once the picture
         * is another size -- and one that resets its device on WM_SIZE would
         * be reset by the size its own reset placed it at, without end, if
         * the message came whether or not anything changed.
         *
         * `announce` says the size whether or not it changed: what a mode
         * switch does to the window it lands in, which the program hears
         * once its device exists and not before.
         *
         * @param {number} hwnd @param {number} x @param {number} y
         * @param {number} width @param {number} height
         * @param {{ announce?: boolean }} [how]
         */
        place: (hwnd, x, y, width, height, how = {})=>{
            const record = live(hwnd);
            if (!record)
            {
                return false;
            }
            const before = geometry.clientRect(record);
            const moved = record.x !== (x | 0) || record.y !== (y | 0);
            record.x = x | 0;
            record.y = y | 0;
            record.width = width | 0;
            record.height = height | 0;
            // A window a device presents into covers the display: the frame
            // its style describes takes no room, so the client area is the
            // whole mode and a program's cursor arithmetic sees the picture.
            record.frameless = true;
            tell(record);
            const after = geometry.clientRect(record);
            if (moved)
            {
                host.queue.post({ hwnd: record.hwnd, message: WM_MOVE, wParam: 0,
                    lParam: ((y & 0xffff) << 16 | x & 0xffff) >>> 0 });
            }
            if (how.announce === true
                || after.right - after.left !== before.right - before.left
                || after.bottom - after.top !== before.bottom - before.top)
            {
                host.queue.post({ hwnd: record.hwnd, message: WM_SIZE, wParam: SIZE_RESTORED,
                    lParam: ((height & 0xffff) << 16 | width & 0xffff) >>> 0 });
            }
            return true;
        },
    });

    /**
     * Shows or hides a window as ShowWindow does, and answers what
     * ShowWindow answers: the state it found, not the one it set, because
     * code that toggles a window reads this back.
     *
     * @param {any} record @param {number} cmdShow
     * @param {unknown} [caller]  The thread whose call this answers, named by
     *     a caller that is past an await.
     */
    const showWindow = (record, cmdShow, caller = undefined)=>{
        // Named once, before anything is awaited: past the first message a
        // procedure answers, the thread on the processor is somebody else.
        const thread = caller ?? host.callerThread?.();
        const minimised = (record.style & WS_MINIMIZE) !== 0;
        // Every minimising command is the hook's to hear, the window
        // minimised already or not (msg.c WmMinMax_1, _3, _4), and every
        // restoring one of a minimised window.
        if (MINIMISING.has(cmdShow) || (RESTORED_BY.has(cmdShow) && minimised))
        {
            // Minimising and restoring are a CBT hook's to forbid; the window
            // is still shown as asked, in the state it had.
            return andThen(askCbt(HCBT_MINMAX, record.hwnd, cmdShow, thread),
                refused=>showNow(record, cmdShow, (refused | 0) !== 0, thread));
        }
        return showNow(record, cmdShow, false, thread);
    };

    /**
     * What ShowWindow asks SetWindowPos for, by command: shown or hidden,
     * where it is and at its size, activated unless the command says not to
     * -- a child never is -- and the active window hidden handing the
     * activation on (msg.c test_ShowWindow, WmShowChildSeq, WmHideChildSeq).
     *
     * @param {any} record @param {number} cmdShow
     */
    const showFlags = (record, cmdShow)=>{
        const SWP_NOSIZE = 0x0001;
        const SWP_NOMOVE = 0x0002;
        const SWP_NOZORDER = 0x0004;
        const SWP_NOACTIVATE = 0x0010;
        const SWP_SHOWWINDOW = 0x0040;
        const SWP_HIDEWINDOW = 0x0080;
        const SW_SHOWMINIMIZED = 2;
        const placed = SWP_NOSIZE | SWP_NOMOVE;
        const child = isChild(record) ? SWP_NOACTIVATE : 0;
        if (cmdShow === SW_HIDE)
        {
            return SWP_HIDEWINDOW | placed | child
                | (activeWindow() === record.hwnd ? 0 : SWP_NOACTIVATE | SWP_NOZORDER);
        }
        if (MINIMISING.has(cmdShow))
        {
            return SWP_SHOWWINDOW | placed | child
                | (cmdShow === SW_SHOWMINIMIZED ? 0 : SWP_NOACTIVATE | SWP_NOZORDER);
        }
        return SWP_SHOWWINDOW | placed | child
            | (SHOW_WITHOUT_ACTIVATING.has(cmdShow) ? SWP_NOACTIVATE : 0);
    };

    /**
     * The window next in line for the activation when the active one is
     * hidden: its owner, when that shows and takes input, else the topmost
     * other top-level window that does; none at all otherwise, and the
     * program is no longer the active one.
     *
     * @param {any} record @param {unknown} thread
     * @returns {number | Promise<number>}
     */
    const activateOther = (record, thread)=>{
        /** @param {any} each */
        const takes = each=>each && each !== record && !each.destroyed && !isChild(each)
            && shown(each) && (each.style & WS_DISABLED) === 0
            && (each.exStyle & WS_EX_TOOLWINDOW) === 0;
        const owner = live(record.owner ?? 0);
        const next = takes(owner) ? owner
            : [...windows.values()].reverse().find(takes) ?? null;
        return activate(next ? next.hwnd : 0, { thread });
    };

    /**
     * ShowWindow past the hook: WM_SHOWWINDOW when the visibility changes,
     * then SetWindowPos with the command's flags -- which paints, activates
     * and tells WM_WINDOWPOSCHANGING and WM_WINDOWPOSCHANGED -- and, the
     * first time an overlapped window shows, the size and place it was not
     * told when it was made (msg.c WmShowOverlappedSeq). SW_SHOW on a window
     * already shown does nothing at all.
     *
     * @param {any} record @param {number} cmdShow
     * @param {boolean} keepState  Whether a hook forbade minimising or restoring.
     * @param {unknown} thread  The thread whose call this answers.
     * @returns {number | Promise<number>}
     */
    const showNow = (record, cmdShow, keepState, thread)=>{
        const wasVisible = (record.style & WS_VISIBLE) !== 0;
        const hide = cmdShow === SW_HIDE;
        const minimised = (record.style & WS_MINIMIZE) !== 0;
        const stateChanges = !keepState && (MINIMISING.has(cmdShow) ? !minimised
            : RESTORED_BY.has(cmdShow) && minimised);
        // A command that finds the window as it asks does nothing at all, a
        // shown window not activated either; SW_SHOWNA places it whatever
        // it finds (msg.c test_ShowWindow, WmEmptySeq, WmShowNA_2).
        if (wasVisible === !hide && !stateChanges && cmdShow !== SW_SHOWNA)
        {
            return wasVisible ? 1 : 0;
        }
        const flags = showFlags(record, cmdShow);
        // Sent, and then chained onto whatever follows it: a procedure the
        // bridge has to run answers with a promise, so returning this call's
        // own result before it has answered hands the host call back to the
        // guest while the guest's procedure is still pending -- and the guest
        // reuses its own stack under it. SW_SHOWNA tells it whatever it
        // found (WmSHOWNATopVisible).
        const greeting = wasVisible === hide || cmdShow === SW_SHOWNA
            ? send(record.hwnd, WM_SHOWWINDOW, hide ? 0 : 1, 0, thread)
            : 0;
        let told = andThen(greeting, ()=>{
            // Minimised is a state IsIconic reads back and a restore clears;
            // the window keeps its place in the picture, there being no
            // taskbar to shrink to.
            if (!keepState && MINIMISING.has(cmdShow))
            {
                record.style = (record.style | WS_MINIMIZE) >>> 0;
            }
            else if (!keepState && RESTORED_BY.has(cmdShow))
            {
                record.style = (record.style & ~WS_MINIMIZE) >>> 0;
            }
            return placeWindow([record.hwnd, 0, 0, 0, 0, 0, flags], thread);
        });
        if (hide && isChild(record))
        {
            // A child hidden with the focus in it hands it to its parent.
            told = andThen(told, ()=>{
                const focus = live(focusWindow());
                return focus && insideOf(focus, record) ? setFocus(record.parent, thread) : 0;
            });
        }
        if (!hide && record.needsSize)
        {
            record.needsSize = false;
            told = andThen(told, ()=>{
                const client = geometry.clientRect(record);
                return andThen(send(record.hwnd, WM_SIZE, SIZE_RESTORED,
                    ((((client.bottom - client.top) & 0xffff) << 16)
                        | ((client.right - client.left) & 0xffff)) >>> 0, thread),
                ()=>send(record.hwnd, WM_MOVE, 0,
                    (((client.top & 0xffff) << 16) | (client.left & 0xffff)) >>> 0, thread));
            });
        }
        // The answer waits for the procedures that were sent to: returning it
        // before they have run is the stack the guest reuses under itself.
        return andThen(told, ()=>(wasVisible ? 1 : 0));
    };

    /**
     * The dialog manager's modal loop, once the dialog functions below have
     * made it.
     *
     * @type {((hwnd: number, thread: unknown, first?: import('./dialogs.js').ModalHook)
     *     => Promise<number>) | null}
     */
    let runModal = null;

    /**
     * BroadcastSystemMessage in either encoding: sent to each recipient in
     * turn, or posted to all; under BSF_QUERY the first that answers
     * BROADCAST_QUERY_DENY stops it and the answer is zero. Any answer else
     * is positive.
     *
     * @param {number[]} args @param {boolean} unicode
     * @returns {number | Promise<number>}
     */
    const broadcastSystem = ([flags, recipients, message, wParam, lParam], unicode)=>{
        const BSF_QUERY = 0x0001;
        const BSF_IGNORECURRENTTASK = 0x0002;
        const BSF_POSTMESSAGE = 0x0010;
        const BSF_SENDNOTIFYMESSAGE = 0x0100;
        const BSM_APPLICATIONS = 0x0008;
        const BSM_ALLDESKTOPS = 0x0010;
        const BROADCAST_QUERY_DENY = 0x424d5144;
        if ((flags & BSF_QUERY) !== 0 && (flags & (BSF_POSTMESSAGE | BSF_SENDNOTIFYMESSAGE)) !== 0)
        {
            // A query is answered one recipient at a time; one that is not
            // waited for cannot answer it.
            host.setLastError?.(ERROR_INVALID_PARAMETER);
            return 0;
        }
        let asked = 0;
        if ((recipients >>> 0) !== 0)
        {
            const bytes = host.readMemory(recipients >>> 0, 4);
            asked = (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
            const reached = asked === 0 ? BSM_APPLICATIONS
                : asked & (BSM_APPLICATIONS | BSM_ALLDESKTOPS);
            host.writeMemory(recipients >>> 0, Uint8Array.of(reached & 0xff, reached >>> 8 & 0xff,
                reached >>> 16 & 0xff, reached >>> 24 & 0xff));
        }
        if (asked !== 0 && (asked & (BSM_APPLICATIONS | BSM_ALLDESKTOPS)) === 0)
        {
            return 1;
        }
        const ours = (flags & BSF_IGNORECURRENTTASK) !== 0;
        const targets = broadcastTargets().filter(hwnd=>!ours || !live(hwnd));
        if ((flags & (BSF_POSTMESSAGE | BSF_SENDNOTIFYMESSAGE)) !== 0)
        {
            for (const hwnd of targets)
            {
                postTo([hwnd, message, wParam, lParam], unicode);
            }
            return 1;
        }
        const thread = host.callerThread?.();
        /** @param {number} at @returns {number | Promise<number>} */
        const next = at=>(at >= targets.length ? 1
            : andThen(sendAcross(targets[at], message, wParam, lParam, thread, unicode),
                answer=>((flags & BSF_QUERY) !== 0 && (answer >>> 0) === BROADCAST_QUERY_DENY
                    ? 0 : next(at + 1))));
        return next(0);
    };

    /**
     * PostMessage and SendNotifyMessage, in either encoding.
     *
     * @param {number[]} args  hWnd, Msg, wParam, lParam.
     * @param {boolean} unicode
     */
    const postTo = ([hwnd, message, wParam, lParam], unicode)=>{
        const target = hwnd >>> 0;
        if (target === HWND_BROADCAST)
        {
            for (const each of broadcastTargets())
            {
                if (live(each))
                {
                    host.queue.post({ hwnd: each, message, wParam, lParam,
                        ...unicode ? { unicode } : {} });
                }
                else
                {
                    directory.post(processId, each, message, wParam, lParam);
                }
            }
            return 1;
        }
        // A message for a window that no longer exists has nowhere to be
        // delivered, and the guest is told so rather than finding out
        // when it dispatches.
        if (target !== 0 && !live(target))
        {
            // Or it is another process's, which takes it into the queue of
            // the thread that made it.
            return directory.post(processId, target, message, wParam, lParam) ? 1 : 0;
        }
        // No window is a message for the poster's own thread, as
        // PostThreadMessage to itself would post it.
        host.queue.post({ hwnd: target, message, wParam, lParam, ...unicode ? { unicode } : {},
            ...target === 0 ? { thread: threadIdOf(host.callerThread?.()) } : {} });
        return 1;
    };

    /**
     * Another program's window became the run's foreground window: this
     * program's active window is told it is not active, the program that it
     * is not the active application, and the focus that it went -- each a
     * notification, delivered on the thread that made the window as a message
     * another process sends is, and waited on by nobody.
     *
     * @param {number} gained @param {number} gainedThread
     * @param {number} hadFocus  the window of this program that had the focus,
     *     which the run has moved already
     */
    const lostForeground = (gained, gainedThread, hadFocus)=>{
        const previous = activeWindow();
        const had = live(hadFocus) ? hadFocus : 0;
        foreignForeground = true;
        active = 0;
        /** @param {number} hwnd @param {number} message @param {number} wParam @param {number} lParam */
        const notify = (hwnd, message, wParam, lParam)=>{
            if (live(hwnd))
            {
                receiveElsewhere(hwnd, { message, wParam, lParam, unicode: false, wait: false,
                    carried: null });
            }
        };
        if (previous !== 0)
        {
            notify(previous, WM_NCACTIVATE, 0, 0);
            notify(previous, WM_ACTIVATE, WA_INACTIVE, gained);
        }
        if (applicationActive)
        {
            applicationActive = false;
            deactivations++;
            for (const top of [...windows.values()]
                .filter(each=>!each.destroyed && !isChild(each)).reverse())
            {
                notify(top.hwnd, WM_ACTIVATEAPP, 0, gainedThread);
            }
        }
        if (had !== 0)
        {
            notify(had, WM_KILLFOCUS, gained, 0);
        }
    };

    // What this process answers about its windows to every other one, in
    // values: their windows are theirs to find, describe and post to.
    directory.attach(processId, {
        lostForeground,
        /**
         * Another program made one of this program's windows the foreground
         * window: activated on the thread that made it, as that thread
         * looks at its queue, raised first.
         *
         * @param {number} hwnd @param {number} fromHwnd @param {number} fromThread
         */
        activate: (hwnd, fromHwnd, fromThread)=>{
            const record = live(hwnd);
            const owner = record ? creatorOf(record) : null;
            if (!record || owner === null)
            {
                return false;
            }
            listOf(inbox, owner).push(/** @type {any} */ ({ run: (/** @type {unknown} */ thread)=>{
                if (!live(hwnd))
                {
                    return 0;
                }
                raise(record);
                return activate(hwnd, { thread, from: { hwnd: fromHwnd, thread: fromThread } });
            } }));
            host.queue.sent?.(owner);
            return true;
        },
        find: findOwn,
        describe: hwnd=>{
            const record = live(hwnd);
            return record ? { threadId: creatorOf(record) ?? 0,
                className: String(record.className), title: record.title } : null;
        },
        post: (hwnd, message, wParam, lParam)=>{
            if (!live(hwnd))
            {
                return false;
            }
            host.queue.post({ hwnd, message, wParam, lParam });
            return true;
        },
        send: receiveElsewhere,
        answer: answerElsewhere,
        withdraw: settleElsewhere,
    });

    /**
     * SendNotifyMessage, in either encoding.
     *
     * @param {number[]} args  hWnd, Msg, wParam, lParam.
     * @param {boolean} unicode
     */
    const notify = ([hwnd, message, wParam, lParam], unicode)=>{
        if ((hwnd >>> 0) !== HWND_BROADCAST && !live(hwnd)
            && !directory.describe(hwnd, processId))
        {
            host.setLastError?.(ERROR_INVALID_WINDOW_HANDLE);
            return 0;
        }
        return andThen(sendAcross(hwnd, message, wParam, lParam, host.callerThread?.(), unicode,
            { kind: ISMEX_NOTIFY }), ()=>1);
    };

    /**
     * SendMessageCallback, in either encoding.
     *
     * @param {number[]} args  hWnd, Msg, wParam, lParam, lpResultCallBack, dwData.
     * @param {boolean} unicode
     */
    const sendWithCallback = ([hwnd, message, wParam, lParam, callback, data], unicode)=>{
        const record = live(hwnd);
        if (!record)
        {
            host.setLastError?.(ERROR_INVALID_WINDOW_HANDLE);
            return 0;
        }
        const thread = host.callerThread?.();
        const owner = creatorOf(record);
        const self = threadIdOf(thread);
        if (owner !== null && self !== null && owner !== self)
        {
            return sendAcross(hwnd, message, wParam, lParam, thread, unicode,
                { kind: ISMEX_CALLBACK, callback: callback >>> 0, data: data >>> 0 });
        }
        return andThen(send(hwnd, message, wParam, lParam, thread, unicode), result=>
            andThen((callback >>> 0) !== 0 && host.call
                ? host.call(callback >>> 0, [record.hwnd, message >>> 0, data >>> 0, result],
                    thread)
                : 0, ()=>1));
    };

    /** The sent message the caller's procedure is handling, innermost, or null. */
    const inSend = ()=>{
        const id = threadIdOf(host.callerThread?.());
        return id === null ? null : handling.get(id)?.at(-1) ?? null;
    };

    /**
     * PostThreadMessage, in either encoding.
     *
     * @param {number[]} args  idThread, Msg, wParam, lParam.
     * @param {boolean} unicode
     */
    const postToThread = ([thread, message, wParam, lParam], unicode)=>{
        const id = thread >>> 0;
        const known = host.threadExists ? host.threadExists(id) : id !== 0;
        if (!known)
        {
            host.setLastError?.(ERROR_INVALID_THREAD_ID);
            return 0;
        }
        host.queue.post({ hwnd: 0, message, wParam, lParam, thread: id,
            ...unicode ? { unicode } : {} });
        return 1;
    };

    /**
     * PeekMessage, in either encoding.
     *
     * @param {number[]} args  lpMsg, hWnd, wMsgFilterMin, wMsgFilterMax, wRemoveMsg.
     * @param {boolean} unicode
     */
    const peekMessage = ([out, hwnd, filterMin, filterMax, removeFlag], unicode)=>{
        const remove = (removeFlag & PM_REMOVE) !== 0;
        const thread = host.callerThread?.();
        hasQueue(thread);
        const filter = { hwnd: windowFilter(hwnd), first: filterMin >>> 0,
            last: filterMax >>> 0, remove, thread: threadIdOf(thread) };
        // Only a message taken activates: a look leaves the press,
        // and the activation, for the call that takes it.
        // What other threads sent is handled before anything posted is looked for.
        const entry = andThen(receiveSent(thread), ()=>(remove ? takeThrough(filter, thread)
            : andThen(placeWaiting(filter, thread), ()=>{
                const seen = host.queue.peek(filter);
                return seen ? andThen(askKeyboardHooks(seen, HC_NOREMOVE, thread), ()=>seen) : seen;
            })));
        return andThen(entry, (/** @type {any} */ taken)=>{
            if (!taken)
            {
                return 0;
            }
            // Taken all the same, with nowhere to put it (msg.c: "PeekMessage
            // (NULL) fails, but still removes the message").
            if (host.canWrite?.(out >>> 0, MSG.SIZE) === false)
            {
                host.setLastError?.(ERROR_NOACCESS);
                return 0;
            }
            writeMessage(host, out, retrieved(taken, unicode));
            return 1;
        });
    };

    /**
     * GetMessage, in either encoding.
     *
     * @param {number[]} args  lpMsg, hWnd, wMsgFilterMin, wMsgFilterMax.
     * @param {boolean} unicode
     */
    const getMessage = ([out, hwnd, filterMin, filterMax], unicode)=>{
        const filter = windowFilter(hwnd);
        // A window already destroyed counts as none: its record is kept for
        // a WM_DESTROY still queued, and waiting on a window that can never
        // receive another message is waiting for ever.
        if (filter !== ANY_WINDOW && filter !== 0 && !live(filter))
        {
            // The documented failure is -1, which is why a loop written
            // as `while (GetMessage(...))` spins forever on it.
            host.setLastError?.(ERROR_INVALID_WINDOW_HANDLE);
            return -1;
        }
        const thread = host.callerThread?.();
        hasQueue(thread);
        const wanted = { hwnd: filter, first: filterMin >>> 0, last: filterMax >>> 0,
            remove: true, thread: threadIdOf(thread) };
        const next = ()=>andThen(receiveSent(thread), ()=>takeThrough(wanted, thread));
        /** @param {any} entry */
        const answer = entry=>{
            writeMessage(host, out, retrieved(entry, unicode));
            return entry.message === WM_QUIT ? 0 : 1;
        };
        return andThen(next(), (/** @type {any} */ first)=>{
            if (first)
            {
                return answer(first);
            }
            // GetMessage waits; it does not report an empty queue. The
            // wait is the host's to hold, so the answer is a promise and
            // the bridge suspends the caller until something arrives.
            return (async()=>{
                let entry = null;
                while (!entry)
                {
                    await host.idle();
                    entry = await next();
                }
                return answer(entry);
            })();
        });
    };

    // Named, because a message for a window with no procedure of its own is
    // handed to the default procedure in this table by `deliver` above.
    const table = {
        ...paint.table,
        ...caret.table,
        // The focus, the capture and the geometry live with the windows, so
        // the system half answers from them through a view of the host that
        // carries them.
        ...createSystemFunctions({
            host: Object.assign(Object.create(host), {
                focus: focusWindow, setFocus, active: activeWindow, activate,
                capture: ()=>captured, setCapture, releaseCapture, colors: systemColors,
                send, sendAcross, callProcedure, geometry, windowFromPoint, askedFromPoint,
                isChild, repaint,
                appear, beforeChange, afterChange, eraseShown, wholeOnScreen, moveBits, dragging,
                dragMove,
                /** @param {(handle: number) => any} decode */
                pictures: decode=>{
                    pictureOf = decode;
                },
                /** @param {(args: number[], thread?: unknown) => any} place */
                positions: place=>{
                    placeWindow = place;
                },
                activateOther,
                calcClient,
                shown, raise, restack, tell, desktop: desktopWindow, showWindow,
                // What the run answers for every process's windows.
                runForeground: ()=>directory.foreground?.() ?? 0,
                /**
                 * SetForegroundWindow of another program's window: the run's
                 * foreground moves now, and that program activates it.
                 *
                 * @param {number} hwnd
                 */
                foregroundElsewhere: hwnd=>directory.foregroundElsewhere?.(hwnd >>> 0, processId)
                    ?? false,
                /** @param {number} x @param {number} y */
                foreignAt: (x, y)=>{
                    const hwnd = directory.fromPoint?.(x, y) ?? 0;
                    return hwnd !== 0 && directory.ownerOf(hwnd) !== processId ? hwnd : 0;
                },
                isDesktop: (/** @type {any} */ record)=>record !== null && record === desktop,
                sysColorBrush: (/** @type {number} */ index)=>(draw
                    ? draw.solidBrush(sysColor(index)) : 0),
                /**
                 * The window of a top-level window's owner chain that was
                 * active last, or the window itself: for one that is owned or
                 * is a child, and for a chain none of whose popups has been.
                 *
                 * @param {any} record
                 */
                lastActivePopup: record=>{
                    if (isChild(record) || live(record.owner ?? 0))
                    {
                        return record.hwnd;
                    }
                    return live(record.lastActivePopup ?? 0)?.hwnd ?? record.hwnd;
                },
            }),
            live, windows, classes,
            elsewhere: (/** @type {number} */ hwnd)=>directory.describe(hwnd, processId),
            names: directory,
        }),
        ...createDesktopFunctions({ host,
            topLevel: ()=>[...windows.values()]
                .filter(record=>!record.destroyed && !isChild(record))
                .reverse()
                .map(record=>record.hwnd),
            windowOf: hwnd=>live(hwnd),
            toBottom: hwnd=>{
                const HWND_BOTTOM = 1;
                (/** @type {any} */ (table)).SetWindowPos.handler([hwnd, HWND_BOTTOM, 0, 0, 0, 0,
                    0x0001 | 0x0002 | 0x0010]);
            } }),
        ...createObjectFunctions({ host, live, send,
            clipboardService: service=>{
                clipboardAccess = service;
            },
            // A menu bar that comes or goes moves the client area, and the
            // window hears its new size as it would from the frame change.
            menuChanged: (record, previous)=>{
                const now = record.menu;
                record.menu = previous;
                const before = geometry.clientSize(record);
                record.menu = now;
                const after = geometry.clientSize(record);
                if (shown(record))
                {
                    appear(record);
                }
                if (after.width === before.width && after.height === before.height)
                {
                    return 1;
                }
                return andThen(send(record.hwnd, WM_SIZE, SIZE_RESTORED,
                    ((after.height & 0xffff) << 16 | after.width & 0xffff) >>> 0,
                    host.callerThread?.()), ()=>1);
            },
        }),
        ...createDialogFunctions({
            host: Object.assign(Object.create(host), {
                focus: focusWindow, setFocus, send, sendAcross, callProcedure, geometry,
                children: childrenOf,
                defDlgProc: controls.helpers.dialogProc, markDefault: controls.helpers.markDefault,
                keyDown: (/** @type {number} */ key)=>
                    ((host.keyState?.(key) ?? 0) & 0x8000) !== 0,
                show: (/** @type {number} */ hwnd, /** @type {unknown} */ thread)=>{
                    const record = live(hwnd);
                    return record ? showWindow(record, SW_SHOW, thread) : 0;
                },
                hide: (/** @type {number} */ hwnd, /** @type {unknown} */ thread)=>{
                    const record = live(hwnd);
                    return record ? showWindow(record, SW_HIDE, thread) : 0;
                },
                /** @param {number} hwnd @param {boolean} on @param {unknown} thread */
                enable: (hwnd, on, thread)=>{
                    const enable = ()=>(/** @type {any} */ (table)).EnableWindow.handler(
                        [hwnd, on ? 1 : 0]);
                    return thread !== undefined && host.answering
                        ? host.answering(thread, enable) : enable();
                },
                loadImage: (/** @type {number} */ instance, /** @type {number} */ name,
                    /** @type {number} */ type)=>table.LoadImageW.handler([instance, name, type,
                    0, 0, 0]),
                translate,
                // GetMessage, as the dialog manager's loop is: what other
                // threads sent is handled first, or a thread waiting on its
                // modal dialog never answers another thread's SendMessage --
                // a worker telling its progress bar, a box's button telling
                // the box -- and both threads wait for ever.
                take: (/** @type {unknown} */ thread)=>andThen(receiveSent(thread),
                    ()=>takeThrough({ hwnd: ANY_WINDOW, first: 0, last: 0, remove: true },
                        thread)),
            }),
            live, windows, makeWindow, destroyWindow, deliver, announce,
            // A class the program registered, by the name a template spells it.
            classNamed: name=>(classes.has(name) || [...classes.values()].some(
                cls=>cls.name.toLowerCase() === name.toLowerCase())
                ? classNamed(name) : null),
            classKnown: name=>classNamed(/^#\d+$/.test(name)
                ? atoms.get(Number(name.slice(1))) ?? name : name) !== null,
            modalLoop: run=>{
                runModal = run;
            },
        }),
        ...rawInput.table,

        /** ATOM RegisterClassA(const WNDCLASSA *lpWndClass) */
        RegisterClassA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([wndClass])=>register(readWindowClass(host, wndClass, WNDCLASSA)),
        },

        /** ATOM RegisterClassExA(const WNDCLASSEXA *lpWndClass) */
        RegisterClassExA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([wndClassEx])=>{
                // cbSize is the only thing that says which structure the guest
                // actually compiled; a mismatch means every offset below is wrong.
                const declared = readU32(host, wndClassEx + WNDCLASSEXA.cbSize);
                if (declared !== WNDCLASSEXA.SIZE)
                {
                    return 0;
                }
                return register(readWindowClass(host, wndClassEx, WNDCLASSEXA));
            },
        },

        /**
         * ATOM RegisterClassW(const WNDCLASSW *lpWndClass)
         *
         * The same structure with wide strings in it, and a class whose
         * procedure reads wide text: every window of it is a Unicode one.
         */
        RegisterClassW: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([wndClass])=>register(readWindowClass(host, wndClass, WNDCLASSA), true),
        },

        /** ATOM RegisterClassExW(const WNDCLASSEXW *lpWndClass) */
        RegisterClassExW: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([wndClassEx])=>{
                if (readU32(host, wndClassEx + WNDCLASSEXA.cbSize) !== WNDCLASSEXA.SIZE)
                {
                    return 0;
                }
                return register(readWindowClass(host, wndClassEx, WNDCLASSEXA), true);
            },
        },

        /** BOOL UnregisterClassA(LPCSTR lpClassName, HINSTANCE hInstance) */
        UnregisterClassA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([className])=>unregister(className, false),
        },

        /** BOOL UnregisterClassW(LPCWSTR lpClassName, HINSTANCE hInstance) */
        UnregisterClassW: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([className])=>unregister(className, true),
        },

        /** BOOL GetClassInfoA(HINSTANCE, LPCSTR lpClassName, LPWNDCLASSA lpWndClass) */
        GetClassInfoA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([, className, out])=>{
                const cls = classOf(className);
                if (!cls)
                {
                    return 0;
                }
                writeWindowClassA(host, out, cls);
                return 1;
            },
        },

        /**
         * BOOL GetClassInfoW(HINSTANCE, LPCWSTR lpClassName, LPWNDCLASSW lpWndClass)
         *
         * The name reported back is the one asked by: the class may have been
         * registered through the ANSI form, and its own pointer then names
         * bytes where the caller reads a wide string.
         */
        GetClassInfoW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([, className, out])=>{
                const cls = classOf(className, true);
                if (!cls)
                {
                    return 0;
                }
                writeWindowClassA(host, out, { ...cls, className: className >>> 0 });
                return 1;
            },
        },

        /** BOOL GetClassInfoExW(HINSTANCE, LPCWSTR lpClassName, LPWNDCLASSEXW) */
        GetClassInfoExW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([, className, out])=>{
                const cls = classOf(className, true);
                if (!cls || (out >>> 0) === 0)
                {
                    return 0;
                }
                writeWindowClassA(host, (out >>> 0) + WNDCLASSEXA.style,
                    { ...cls, className: className >>> 0 });
                writeU32s(host, (out >>> 0) + WNDCLASSEXA.hIconSm, [cls.iconSm ?? 0]);
                return 1;
            },
        },

        /**
         * BOOL GetClassInfoExA(HINSTANCE, LPCSTR lpClassName, LPWNDCLASSEXA)
         *
         * The extended form: the same fields four bytes further along, behind
         * cbSize, with the small icon after them. cbSize is the caller's and
         * is left as it was.
         */
        GetClassInfoExA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([, className, out])=>{
                const cls = classOf(className);
                if (!cls || (out >>> 0) === 0)
                {
                    return 0;
                }
                writeWindowClassA(host, (out >>> 0) + WNDCLASSEXA.style, cls);
                writeU32s(host, (out >>> 0) + WNDCLASSEXA.hIconSm, [cls.iconSm ?? 0]);
                return 1;
            },
        },

        /**
         * HWND FindWindowExA(HWND hWndParent, HWND hWndChildAfter,
         *                   LPCSTR lpszClass, LPCSTR lpszWindow)
         *
         * Both names are optional and a null one matches anything, so all four
         * combinations are askable and the one with no names at all means "the
         * first window there is".
         *
         * The answer that matters most is the empty one. This is how a program
         * discovers a copy of itself already running and how an installer
         * refuses to run while what it installs is open, and both read "not
         * found" as permission to continue -- so a window that is not the one
         * asked for is a worse answer than no window at all. A class nobody
         * registered names nothing, which is the same reasoning.
         */
        FindWindowExA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([parent, after, className, windowName])=>
                findWindow(parent >>> 0, after >>> 0, className >>> 0, windowName >>> 0),
        },

        /**
         * HWND FindWindowA(LPCSTR lpClassName, LPCSTR lpWindowName)
         *
         * The same search over top-level windows, which is the spelling a
         * program of this era actually calls.
         */
        FindWindowA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([className, windowName])=>
                findWindow(0, 0, className >>> 0, windowName >>> 0),
        },

        /** HWND FindWindowW(LPCWSTR lpClassName, LPCWSTR lpWindowName) */
        FindWindowW: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([className, windowName])=>
                findWindow(0, 0, className >>> 0, windowName >>> 0, true),
        },

        /** HWND FindWindowExW(HWND, HWND, LPCWSTR lpszClass, LPCWSTR lpszWindow) */
        FindWindowExW: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([parent, after, className, windowName])=>
                findWindow(parent >>> 0, after >>> 0, className >>> 0, windowName >>> 0, true),
        },

        /**
         * HWND CreateWindowExA(DWORD dwExStyle, LPCSTR lpClassName, LPCSTR lpWindowName,
         *   DWORD dwStyle, int X, int Y, int nWidth, int nHeight, HWND hWndParent,
         *   HMENU hMenu, HINSTANCE hInstance, LPVOID lpParam)
         *
         * lpParam reaches the window procedure as the CREATESTRUCT's
         * lpCreateParams, with WM_NCCREATE and again with WM_CREATE.
         */
        CreateWindowExA: {
            argBytes: 48,
            /** @param {number[]} args */
            handler: args=>createWindow(args),
        },

        /**
         * HWND CreateWindowA(...) -- the same call without the extended style.
         *
         * The SDK makes this a macro over CreateWindowExA rather than an export,
         * so an import table will not name it; it costs one line to answer if
         * something does.
         */
        CreateWindowA: {
            argBytes: 44,
            /** @param {number[]} args */
            handler: args=>createWindow([0, ...args]),
        },

        /**
         * HWND CreateWindowExW(DWORD dwExStyle, LPCWSTR lpClassName,
         *   LPCWSTR lpWindowName, ...) -- the same call with wide names, whose
         *   WM_NCCREATE and WM_CREATE carry a CREATESTRUCTW.
         */
        CreateWindowExW: {
            argBytes: 48,
            /** @param {number[]} args */
            handler: args=>createWindow(args, true),
        },

        /**
         * HWND CreateMDIWindowA/W(LPCSTR lpClassName, LPCSTR lpWindowName,
         *     DWORD dwStyle, int X, int Y, int nWidth, int nHeight,
         *     HWND hWndParent, HINSTANCE hInstance, LPARAM lParam)
         *
         * An MDI child of the client named, made as CreateWindowEx makes one
         * with WS_EX_MDICHILD.
         */
        CreateMDIWindowA: {
            argBytes: 40,
            /** @param {number[]} args */
            handler: ([className, title, style, x, y, width, height, parent, instance, lParam])=>
                createWindow([WS_EX_MDICHILD, className, title, style, x, y, width, height,
                    parent, 0, instance, lParam]),
        },

        CreateMDIWindowW: {
            argBytes: 40,
            /** @param {number[]} args */
            handler: ([className, title, style, x, y, width, height, parent, instance, lParam])=>
                createWindow([WS_EX_MDICHILD, className, title, style, x, y, width, height,
                    parent, 0, instance, lParam], true),
        },

        /** HWND CreateWindowW(...), without the extended style. */
        CreateWindowW: {
            argBytes: 44,
            /** @param {number[]} args */
            handler: args=>createWindow([0, ...args], true),
        },

        /** BOOL IsWindowUnicode(HWND hWnd) */
        IsWindowUnicode: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>(live(hwnd)?.unicode ? 1 : 0),
        },

        /** BOOL DestroyWindow(HWND hWnd) */
        DestroyWindow: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>destroyAsked(hwnd),
        },

        /** BOOL ShowWindow(HWND hWnd, int nCmdShow) */
        ShowWindow: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, cmdShow])=>{
                const record = live(hwnd);
                return record ? showWindow(record, cmdShow | 0) : 0;
            },
        },

        /**
         * BOOL CloseWindow(HWND hWnd)
         *
         * Minimises, despite its name; a program that means to be rid of a
         * window destroys it.
         */
        CloseWindow: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>{
                const record = live(hwnd);
                if (!record)
                {
                    return 0;
                }
                showWindow(record, SW_MINIMIZE);
                return 1;
            },
        },

        /**
         * BOOL OpenIcon(HWND hWnd)
         *
         * A minimised window restored and activated, as SW_SHOWNORMAL does;
         * FALSE for one that is not minimised.
         */
        OpenIcon: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>{
                const SW_SHOWNORMAL = 1;
                const record = live(hwnd);
                if (!record || (record.style & WS_MINIMIZE) === 0)
                {
                    return 0;
                }
                return andThen(showWindow(record, SW_SHOWNORMAL), ()=>1);
            },
        },

        /**
         * BOOL FlashWindow(HWND hWnd, BOOL bInvert)
         *
         * The caption drawn the other way about -- active as inactive, or
         * back -- to catch the eye; FALSE puts it back as the activation
         * has it. Answers whether it was drawn active before the call. The
         * taskbar button a flash also lights is the host's, and not here.
         */
        FlashWindow: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, invert])=>{
                const record = live(hwnd);
                if (!record || record === desktop)
                {
                    host.setLastError?.(ERROR_INVALID_WINDOW_HANDLE);
                    return 0;
                }
                const activeNow = topLevelOf(record).hwnd === activeWindow();
                const before = record.flash?.active === activeNow ? record.flash.shown : activeNow;
                record.flash = (invert >>> 0) !== 0 ? { active: activeNow, shown: !before } : null;
                const drawn = record.flash ? record.flash.shown : activeNow;
                if (drawn !== before && shown(record))
                {
                    paintFrame(record);
                    painted();
                }
                return before ? 1 : 0;
            },
        },

        /** BOOL IsWindow(HWND hWnd) */
        IsWindow: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>(live(hwnd) || directory.describe(hwnd, processId) ? 1 : 0),
        },

        /** BOOL GetClientRect(HWND hWnd, LPRECT lpRect) */
        GetClientRect: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, out])=>{
                const record = live(hwnd);
                if (!record)
                {
                    return 0;
                }
                const size = geometry.clientSize(record);
                writeRect(host, out, { left: 0, top: 0, right: size.width, bottom: size.height });
                return 1;
            },
        },

        /** BOOL GetWindowRect(HWND hWnd, LPRECT lpRect) */
        GetWindowRect: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, out])=>{
                const record = live(hwnd);
                if (!record)
                {
                    return 0;
                }
                writeRect(host, out, geometry.windowRect(record));
                return 1;
            },
        },

        /** BOOL SetWindowTextA(HWND hWnd, LPCSTR lpString) */
        SetWindowTextA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, string])=>{
                // Sent, as Windows sends it: a control keeps its text through
                // its own procedure, and a program that subclassed one sees
                // the message -- on the thread that made the window, which
                // is where a skin keeps what it paints with.
                const record = live(hwnd);
                if (!record)
                {
                    return 0;
                }
                return andThen(sendAcross(record.hwnd, WM_SETTEXT, 0, string >>> 0,
                    host.callerThread?.()), ()=>1);
            },
        },

        /**
         * BOOL SetWindowTextW(HWND hWnd, LPCWSTR lpString)
         *
         * A wide WM_SETTEXT, which reaches an ANSI procedure converted to the
         * ANSI page, as SendMessageW's would; the answer is the message's, so
         * a text that could not be converted is a failure.
         */
        SetWindowTextW: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, string])=>{
                const record = live(hwnd);
                if (!record)
                {
                    return 0;
                }
                return andThen(sendAcross(record.hwnd, WM_SETTEXT, 0, string >>> 0,
                    host.callerThread?.(), true), (/** @type {number | null} */ set)=>(set ? 1 : 0));
            },
        },

        /** BOOL SetDlgItemTextW(HWND hDlg, int nIDDlgItem, LPCWSTR lpString) */
        SetDlgItemTextW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([dialog, id, string])=>asAnsi(string,
                text=>table.SetDlgItemTextA.handler([dialog, id, text])),
        },

        /**
         * int GetWindowTextA(HWND hWnd, LPSTR lpString, int nMaxCount)
         *
         * WM_GETTEXT, as Windows sends it to a window of the calling process:
         * a procedure that keeps its own text answers with it, and what the
         * procedure answers is the length, terminated or not. The buffer is
         * emptied first, for a procedure that writes nothing; one that cannot
         * be written is no text, not a fault. A window of another thread is
         * read from its caption instead, and said: the message would wait for
         * that thread to look at its queue, and a thread that is waiting on
         * this one never does.
         */
        GetWindowTextA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hwnd, out, maxCount])=>{
                const record = live(hwnd);
                const room = maxCount | 0;
                const elsewhere = record ? null : directory.describe(hwnd, processId);
                // No buffer is no text, whatever count comes with it.
                if (!(record || elsewhere) || room <= 0 || !emptied(out, 1))
                {
                    return 0;
                }
                // Another process's window is read from its caption, as
                // Windows reads one without sending it anything.
                if (elsewhere)
                {
                    return writeText(host, out, elsewhere.title, room, false);
                }
                if (ownedElsewhere(record))
                {
                    return writeText(host, out, record.title, room, false);
                }
                return (/** @type {any} */ (table)).SendMessageA.handler([record.hwnd, WM_GETTEXT,
                    room, out >>> 0]);
            },
        },

        /** int GetWindowTextW(HWND hWnd, LPWSTR lpString, int nMaxCount) */
        GetWindowTextW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hwnd, out, maxCount])=>{
                const record = live(hwnd);
                const room = maxCount | 0;
                const elsewhere = record ? null : directory.describe(hwnd, processId);
                if (!(record || elsewhere) || room <= 0 || !emptied(out, 2))
                {
                    return 0;
                }
                if (elsewhere)
                {
                    return writeText(host, out, elsewhere.title, room, true);
                }
                if (ownedElsewhere(record))
                {
                    return writeText(host, out, record.title, room, true);
                }
                return (/** @type {any} */ (table)).SendMessageW.handler([record.hwnd, WM_GETTEXT,
                    room, out >>> 0]);
            },
        },

        /**
         * int InternalGetWindowText(HWND hWnd, LPWSTR pString, int cchMaxCount)
         *
         * The text the window manager keeps for the window, read without a
         * message.
         */
        InternalGetWindowText: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hwnd, out, maxCount])=>{
                const record = live(hwnd);
                const room = maxCount | 0;
                if (!record || room <= 0 || (out >>> 0) === 0)
                {
                    return 0;
                }
                return writeText(host, out, record.title, room, true);
            },
        },

        /** LONG GetWindowLongA(HWND hWnd, int nIndex) */
        GetWindowLongA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, index])=>{
                const record = live(hwnd);
                return record ? readLong(record, index) : 0;
            },
        },

        /** LONG SetWindowLongA(HWND hWnd, int nIndex, LONG dwNewLong) */
        SetWindowLongA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hwnd, index, value])=>{
                const record = live(hwnd);
                if (!record)
                {
                    return 0;
                }
                const previous = readLong(record, index);
                writeLong(record, index, value);
                return previous;
            },
        },

        /** LONG GetWindowLongW(HWND hWnd, int nIndex) */
        GetWindowLongW: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: args=>table.GetWindowLongA.handler(args),
        },

        /** LONG SetWindowLongW(HWND hWnd, int nIndex, LONG dwNewLong) */
        SetWindowLongW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hwnd, index, value])=>{
                const record = live(hwnd);
                if (!record)
                {
                    return 0;
                }
                const previous = readLong(record, index);
                writeLong(record, index, value, true);
                return previous;
            },
        },

        /**
         * BOOL SetLayeredWindowAttributes(HWND hwnd, COLORREF crKey, BYTE bAlpha,
         *     DWORD dwFlags)
         * BOOL GetLayeredWindowAttributes(HWND hwnd, COLORREF *pcrKey, BYTE *pbAlpha,
         *     DWORD *pdwFlags)
         *
         * The attributes are recorded on the window and handed back whole:
         * nothing renders a layered window any differently here, so the value
         * only has to round-trip. LWA_COLORKEY and LWA_ALPHA name which of the
         * two the caller set, and the getter answers what the setter stored.
         */
        SetLayeredWindowAttributes: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([hwnd, key, alpha, flags])=>{
                const record = live(hwnd);
                if (!record)
                {
                    return 0;
                }
                record.layered = { key: key >>> 0, alpha: alpha & 0xff, flags: flags >>> 0 };
                return 1;
            },
        },

        GetLayeredWindowAttributes: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([hwnd, key, alpha, flags])=>{
                const record = live(hwnd);
                if (!record)
                {
                    return 0;
                }
                const layered = record.layered;
                if ((key >>> 0) !== 0)
                {
                    const bytes = new Uint8Array(4);
                    new DataView(bytes.buffer).setUint32(0, layered?.key ?? 0, true);
                    host.writeMemory(key >>> 0, bytes);
                }
                if ((alpha >>> 0) !== 0)
                {
                    host.writeMemory(alpha >>> 0, new Uint8Array([(layered?.alpha ?? 0) & 0xff]));
                }
                if ((flags >>> 0) !== 0)
                {
                    const bytes = new Uint8Array(4);
                    new DataView(bytes.buffer).setUint32(0, layered?.flags ?? 0, true);
                    host.writeMemory(flags >>> 0, bytes);
                }
                return 1;
            },
        },

        /**
         * WORD GetWindowWord(HWND hWnd, int nIndex)
         * WORD SetWindowWord(HWND hWnd, int nIndex, WORD wNewWord)
         *
         * The 16-bit view of the same extra bytes. A control written for
         * Windows 3.x keeps its state this way, and there is no word-sized
         * built-in field: the documented ones are all longs.
         */
        GetWindowWord: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, index])=>{
                const record = live(hwnd);
                const at = index | 0;
                return record && at >= 0 && at + 2 <= record.extra.byteLength
                    ? record.extra.getUint16(at, true)
                    : 0;
            },
        },

        SetWindowWord: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hwnd, index, value])=>{
                const record = live(hwnd);
                const at = index | 0;
                if (!record || at < 0 || at + 2 > record.extra.byteLength)
                {
                    return 0;
                }
                const previous = record.extra.getUint16(at, true);
                record.extra.setUint16(at, value & 0xffff, true);
                return previous;
            },
        },

        /** HHOOK SetWindowsHookExW(...), as the ANSI form. */
        SetWindowsHookExW: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: args=>table.SetWindowsHookExA.handler(args),
        },

        /**
         * HHOOK SetWindowsHookExA(int idHook, HOOKPROC lpfn, HINSTANCE hmod,
         *                         DWORD dwThreadId)
         *
         * Every type is accepted, because a program installs its hooks at
         * start-up and treats a refusal as fatal; a CBT and a keyboard hook
         * are called, and the others say so once rather than failing silently.
         */
        SetWindowsHookExA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([type, proc, , thread])=>{
                if ((proc >>> 0) === 0)
                {
                    return 0;
                }
                const hook = { handle: 0, type: type | 0, proc: proc >>> 0, thread: thread >>> 0 };
                hook.handle = host.handles.open('hook', hook);
                hooks.push(hook);
                if (hook.type !== WH_CBT && hook.type !== WH_KEYBOARD)
                {
                    host.divergence?.('SetWindowsHookExA',
                        `hook type ${hook.type} is installed but never called`);
                }
                return hook.handle;
            },
        },

        /** BOOL UnhookWindowsHookEx(HHOOK hhk) */
        UnhookWindowsHookEx: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const at = hooks.findIndex(hook=>hook.handle === (handle >>> 0));
                if (at < 0)
                {
                    return 0;
                }
                hooks.splice(at, 1);
                host.handles.close(handle >>> 0);
                return 1;
            },
        },

        /**
         * LRESULT CallNextHookEx(HHOOK hhk, int nCode, WPARAM wParam, LPARAM lParam)
         *
         * The hook older than the one calling, of the same type; the last in
         * the chain gets zero, which is "nothing objected".
         */
        CallNextHookEx: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, code, wParam, lParam])=>{
                const hook = hooks.find(each=>each.handle === (handle >>> 0));
                if (!hook)
                {
                    return 0;
                }
                return callHook(hook.type, hook.handle, [code, wParam, lParam],
                    host.callerThread?.());
            },
        },

        /**
         * BOOL AttachThreadInput(DWORD idAttach, DWORD idAttachTo, BOOL fAttach)
         *
         * Joins two threads' input state, or parts them. The focus, the active
         * window and the capture are one for the whole process here, which is
         * every thread already attached to every other, so what is left is
         * the refusal: a thread attached to itself, one that does not exist,
         * or one that has no message queue yet -- no window made, no look at
         * a queue -- is ERROR_INVALID_PARAMETER.
         */
        AttachThreadInput: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([from, to])=>{
                const one = from >>> 0;
                const other = to >>> 0;
                const exists = (/** @type {number} */ id)=>(host.threadExists
                    ? host.threadExists(id) : id !== 0);
                if (one === other || !exists(one) || !exists(other)
                    || !queueing.has(one) || !queueing.has(other))
                {
                    host.setLastError?.(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                return 1;
            },
        },

        /** BOOL PostMessageA(HWND hWnd, UINT Msg, WPARAM wParam, LPARAM lParam) */
        PostMessageA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: args=>postTo(args, false),
        },

        /**
         * long BroadcastSystemMessageA(DWORD flags, LPDWORD lpdwRecipients, UINT uiMessage,
         *                              WPARAM wParam, LPARAM lParam)
         *
         * A message to every top-level window, this process's and the
         * others'. Only applications are here to receive it: drivers and
         * network drivers asked for alone receive nothing, and the
         * recipients written back say who did.
         */
        BroadcastSystemMessageA: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: args=>broadcastSystem(args, false),
        },
        BroadcastSystemMessage: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: args=>broadcastSystem(args, false),
        },
        BroadcastSystemMessageW: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: args=>broadcastSystem(args, true),
        },

        /**
         * BOOL PostMessageW(HWND hWnd, UINT Msg, WPARAM wParam, LPARAM lParam)
         *
         * A posted character is kept with the encoding it was posted in, and
         * the retrieving call converts it to its own.
         */
        PostMessageW: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: args=>postTo(args, true),
        },

        /**
         * BOOL SendNotifyMessageA(HWND hWnd, UINT Msg, WPARAM wParam, LPARAM lParam)
         *
         * SendMessage to a window of the caller's own thread, whose procedure
         * has answered by the time this returns; to another thread's, a sent
         * message that thread takes on its next look at its queue, without
         * the caller waiting for the answer.
         */
        SendNotifyMessageA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: args=>notify(args, false),
        },

        /** BOOL SendNotifyMessageW(HWND hWnd, UINT Msg, WPARAM wParam, LPARAM lParam) */
        SendNotifyMessageW: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: args=>notify(args, true),
        },

        /**
         * BOOL SendMessageCallbackA(HWND hWnd, UINT Msg, WPARAM wParam, LPARAM lParam,
         *     SENDASYNCPROC lpResultCallBack, ULONG_PTR dwData)
         *
         * A send that does not wait: the callback is handed the answer --
         * at once for a window of the caller's own thread, and for another
         * thread's once it has answered and the caller next looks at its
         * own queue.
         */
        SendMessageCallbackA: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: args=>sendWithCallback(args, false),
        },

        /** BOOL SendMessageCallbackW(...), with wide text in the message. */
        SendMessageCallbackW: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: args=>sendWithCallback(args, true),
        },

        /**
         * BOOL InSendMessage(void)
         *
         * Whether the procedure running is handling a message another thread
         * sent, as against one this thread sent itself or took from its
         * queue.
         */
        InSendMessage: {
            argBytes: 0,
            handler: ()=>(inSend() ? 1 : 0),
        },

        /**
         * DWORD InSendMessageEx(LPVOID lpReserved)
         *
         * How that message was sent -- ISMEX_SEND, ISMEX_NOTIFY or
         * ISMEX_CALLBACK, with ISMEX_REPLIED once ReplyMessage has answered
         * it -- or ISMEX_NOSEND.
         */
        InSendMessageEx: {
            argBytes: 4,
            handler: ()=>{
                const sent = inSend();
                if (!sent)
                {
                    return ISMEX_NOSEND;
                }
                return sent.kind | (sent.replied && sent.kind !== ISMEX_NOTIFY ? ISMEX_REPLIED : 0);
            },
        },

        /**
         * BOOL ReplyMessage(LRESULT lResult)
         *
         * Answers a message another thread sent before its procedure has
         * finished, so the sender goes on. FALSE when the procedure is not
         * handling one; a notification has nobody waiting, and is not marked
         * as answered.
         */
        ReplyMessage: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([result])=>{
                const sent = inSend();
                if (!sent)
                {
                    return 0;
                }
                if (sent.kind !== ISMEX_NOTIFY)
                {
                    reply(sent, result);
                }
                return 1;
            },
        },

        /**
         * BOOL PostThreadMessageA(DWORD idThread, UINT Msg, WPARAM wParam,
         *                         LPARAM lParam)
         *
         * A message with no window, which only the thread's own GetMessage or
         * PeekMessage can take -- and only when it asked for every window,
         * because a retrieval naming one skips thread messages. That is how a
         * program breaks its own modal loop out of a wait from another thread.
         *
         * There is one queue here and it belongs to whichever thread is
         * pumping, so the identifier is checked for naming a live thread and
         * otherwise ignored: posting to a thread that never pumps would leave
         * the message where nobody looks, and reporting failure for a thread
         * that does not exist is the answer a caller can act on.
         */
        PostThreadMessageA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: args=>postToThread(args, false),
        },

        /** BOOL PostThreadMessageW(DWORD idThread, UINT Msg, WPARAM wParam, LPARAM lParam) */
        PostThreadMessageW: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: args=>postToThread(args, true),
        },

        /**
         * DWORD GetQueueStatus(UINT flags)
         *
         * Two answers in one word, and a program relies on both: the high half
         * is every class of message waiting now, the low half only what has
         * arrived since the last look. A playback loop asks this to find out
         * whether the player has pressed anything without pumping the queue
         * first, and a loop that is told "nothing" plays the film to its end
         * whatever the player does.
         *
         * Both halves are masked by what was asked for, so a caller that asked
         * about input alone is never told about a timer.
         */
        GetQueueStatus: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([flags])=>{
                const mask = flags >>> 0;
                hasQueue(host.callerThread?.());
                const { inQueue, changed } = host.queue.status(
                    threadIdOf(host.callerThread?.()), mask);
                return (((inQueue & mask) << 16) | (changed & mask)) >>> 0;
            },
        },

        /** VOID PostQuitMessage(int nExitCode) */
        PostQuitMessage: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([code])=>{
                host.queue.postQuit(code | 0, threadIdOf(host.callerThread?.()));
                return 0; // void: the guest reads nothing back
            },
        },

        /** BOOL PeekMessageA(LPMSG, HWND, UINT wMsgFilterMin, UINT wMsgFilterMax, UINT wRemoveMsg) */
        PeekMessageA: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: args=>peekMessage(args, false),
        },

        /** BOOL PeekMessageW(LPMSG, HWND, UINT wMsgFilterMin, UINT wMsgFilterMax, UINT wRemoveMsg) */
        PeekMessageW: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: args=>peekMessage(args, true),
        },

        /**
         * BOOL TrackMouseEvent(LPTRACKMOUSEEVENT lpEventTrack)
         *
         * One window's hover or leaving, or both, reported by message:
         * WM_MOUSEHOVER once the pointer has rested in a small square for the
         * hover time, WM_MOUSELEAVE once it leaves the client area -- the NC
         * pair for the frame with TME_NONCLIENT. Each message ends what it
         * reports; a TME_QUERY answers what is still being tracked.
         */
        TrackMouseEvent: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([request])=>trackMouseEvent(request),
        },

        /**
         * DWORD MsgWaitForMultipleObjects(DWORD nCount, const HANDLE *pHandles,
         *   BOOL fWaitAll, DWORD dwMilliseconds, DWORD dwWakeMask)
         *
         * A wait on handles that also ends when input of the kinds the wake
         * mask names arrives, answered with the count of handles when it is
         * the input that ended it. Input is what arrived since the queue was
         * last looked at: a message a PeekMessage has already seen does not
         * end the wait, whether or not it was taken. With fWaitAll, the
         * handles and the input together end it, and the handles are taken
         * only then.
         *
         * The handles are kernel32's business and are asked of it; the queue
         * is looked at here, and the two are asked in that order because a
         * handle and input both ready is answered with the handle. A wait
         * that has to be held is a poll of both on every turn the host
         * gives, as a wait on the queue alone always was -- but only for
         * handles a poll can answer for any thread: an event, a semaphore, a
         * waitable timer, a thread. A process or a mutex, whose answer
         * depends on who is waiting or whose wait hands the machine to
         * another process, is kernel32's to hold, and a message arriving
         * while it holds one does not end the wait.
         *
         * A sixth and a seventh element, which no program's call carries, are
         * MsgWaitForMultipleObjectsEx's flags: MWMO_INPUTAVAILABLE, input
         * already waiting ending the wait too, seen or not; and
         * MWMO_ALERTABLE, which leaves a wait on handles to kernel32, whose
         * wait an APC can end.
         */
        MsgWaitForMultipleObjects: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([count, handles, waitAll, timeout, wakeMask, inputAvailable, alertable])=>{
                const total = count >>> 0;
                const wait = timeout >>> 0;
                const mask = wakeMask >>> 0;
                const waiter = threadIdOf(host.callerThread?.());
                hasQueue(host.callerThread?.());
                const input = ()=>((inputAvailable
                    ? host.queue.waiting(waiter) : host.queue.news(waiter)) & mask) !== 0;
                /** @param {number} milliseconds */
                const askHandles = milliseconds=>{
                    if (total === 0)
                    {
                        return WAIT_TIMEOUT;
                    }
                    return host.waitForObjects
                        ? host.waitForObjects([total, handles, waitAll, milliseconds])
                        : WAIT_FAILED;
                };
                /** @returns {any} what the wait answers now, or null while it goes on */
                const settle = ()=>{
                    if (waitAll !== 0 && total > 0)
                    {
                        if (!input())
                        {
                            return null;
                        }
                        const all = askHandles(0);
                        return all === WAIT_TIMEOUT ? null : all;
                    }
                    const polled = askHandles(0);
                    if (polled !== WAIT_TIMEOUT)
                    {
                        return polled;
                    }
                    return input() ? WAIT_OBJECT_0 + total : null;
                };

                const settled = settle();
                if (settled !== null)
                {
                    return settled;
                }
                if (wait === 0)
                {
                    return WAIT_TIMEOUT;
                }
                if (total > 0 && (alertable || !pollable(handles >>> 0, total)))
                {
                    return askHandles(wait);
                }
                const deadline = wait === INFINITE ? null : (host.now?.() ?? 0) + wait;
                return (async()=>{
                    for (;;)
                    {
                        if (deadline !== null && (host.now?.() ?? 0) >= deadline)
                        {
                            return WAIT_TIMEOUT;
                        }
                        await host.idle();
                        const answer = settle();
                        if (answer !== null)
                        {
                            return answer;
                        }
                    }
                })();
            },
        },

        /** BOOL GetMessageA(LPMSG, HWND, UINT wMsgFilterMin, UINT wMsgFilterMax) */
        GetMessageA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: args=>getMessage(args, false),
        },

        /** BOOL GetMessageW(LPMSG, HWND, UINT wMsgFilterMin, UINT wMsgFilterMax) */
        GetMessageW: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: args=>getMessage(args, true),
        },

        /**
         * BOOL WaitMessage(void)
         *
         * Yields until the queue has something to retrieve -- a posted
         * message, a window to paint, a due timer, a quit, a message another
         * thread sent -- and answers without taking it. A pump written as
         * peek-then-wait spins without this, which from outside is a program
         * at full speed doing nothing.
         */
        WaitMessage: {
            argBytes: 0,
            handler: ()=>{
                const waiter = threadIdOf(host.callerThread?.());
                hasQueue(host.callerThread?.());
                const look = ()=>(waiter !== null && (inbox.get(waiter)?.length ?? 0) > 0)
                    || host.queue.peek({
                        hwnd: ANY_WINDOW, first: 0, last: 0, remove: false, thread: waiter,
                    });
                if (look())
                {
                    return 1;
                }
                return (async()=>{
                    while (!look())
                    {
                        await host.idle();
                    }
                    return 1;
                })();
            },
        },

        /** BOOL TranslateMessage(const MSG *lpMsg) */
        TranslateMessage: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([msg])=>translate(readMessage(host, msg)),
        },

        /**
         * BOOL EnumChildWindows(HWND hWndParent, WNDENUMPROC lpEnumFunc, LPARAM lParam)
         *
         * Every descendant, not only the immediate children -- that is what
         * the documentation says and what a program setting a font on every
         * control of a dialog relies on -- each handed to the callback until
         * one answers FALSE. The list is taken first, so a callback that
         * destroys or creates windows does not move the walk under itself.
         * The thread is read before the first await, because after it the
         * processor belongs to whoever the scheduler chose.
         */
        EnumChildWindows: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([parent, callback, lParam])=>{
                const call = host.call;
                if (!call || (callback >>> 0) === 0)
                {
                    return 0;
                }
                const thread = host.callerThread?.();
                /** @param {number} of @returns {number[]} */
                const descendants = of=>[...windows.values()]
                    .filter(record=>!record.destroyed && record.parent === of)
                    .flatMap(record=>[record.hwnd, ...descendants(record.hwnd)]);
                const listed = descendants(parent >>> 0);
                return (async()=>{
                    for (const hwnd of listed)
                    {
                        if ((await call(callback >>> 0, [hwnd, lParam >>> 0], thread) | 0) === 0)
                        {
                            break;
                        }
                    }
                    return 1;
                })();
            },
        },

        /**
         * BOOL EnumWindows(WNDENUMPROC lpEnumFunc, LPARAM lParam)
         *
         * Every top-level window, hidden ones too, topmost first -- the
         * order they are kept in, reversed -- each handed to the callback
         * until one answers FALSE, which the call then answers too. The list
         * is taken first, as EnumChildWindows takes its own.
         */
        EnumWindows: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([callback, lParam])=>{
                const call = host.call;
                if (!call || (callback >>> 0) === 0)
                {
                    host.setLastError?.(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                const thread = host.callerThread?.();
                // Every process's, in the run's order, where the run keeps one.
                const listed = directory.topLevel?.().map(state=>state.hwnd)
                    ?? [...windows.values()]
                        .filter(record=>!record.destroyed && !isChild(record))
                        .reverse()
                        .map(record=>record.hwnd);
                return (async()=>{
                    for (const hwnd of listed)
                    {
                        if ((await call(callback >>> 0, [hwnd, lParam >>> 0], thread) | 0) === 0)
                        {
                            return 0;
                        }
                    }
                    return 1;
                })();
            },
        },

        /**
         * int ScrollWindowEx(HWND hWnd, int dx, int dy, const RECT *prcScroll,
         *     const RECT *prcClip, HRGN hrgnUpdate, LPRECT prcUpdate, UINT flags)
         *
         * The client area's pixels within prcScroll -- the whole client by
         * default -- moved by dx, dy, only what lands inside prcClip, the
         * whole client by default, changing. What they leave is the update
         * area; a part of it waiting to be painted moves with them and is
         * still owed where it was. Both are handed back in the region and
         * the rectangle and, with SW_INVALIDATE, left to be painted (erased
         * first with SW_ERASE). SW_SCROLLCHILDREN takes the children along,
         * their pixels with them: the move goes over them as if the window
         * did not clip them (win.c test_scrollvalidate). Answers what kind
         * of region the update area is.
         */
        ScrollWindowEx: {
            argBytes: 32,
            /** @param {number[]} args */
            handler: ([hwnd, dx, dy, scrollRect, clipRect, region, updateRect, flags])=>{
                const SW_SCROLLCHILDREN = 0x0001;
                const SW_INVALIDATE = 0x0002;
                const SW_ERASE = 0x0004;
                const record = live(hwnd);
                if (!record)
                {
                    return REGION_ERROR;
                }
                const children = (flags & SW_SCROLLCHILDREN) !== 0;
                const size = geometry.clientSize(record);
                const client = { left: 0, top: 0, right: size.width, bottom: size.height };
                const scroll = (scrollRect >>> 0) === 0 ? client : readRect(host, scrollRect);
                const clip = (clipRect >>> 0) === 0 ? client : readRect(host, clipRect);
                const origin = geometry.clientRect(record);
                const shownPart = geometry.visibleClientRect(record);
                const visible = !shown(record) || frozen(record) || isEmpty(shownPart) ? []
                    : offsetArea(subtractAreas([shownPart], coveringOf(record, !children)),
                        -origin.left, -origin.top);
                // The cache's context, whatever the class keeps: what the
                // scroll does to its clip is not the program's.
                const DCX_CACHE = 0x2;
                const hdc = paint.contextOn(record, false, DCX_CACHE);
                if (hdc !== 0 && children)
                {
                    draw?.clip?.(hdc, visible);
                }
                const { changed, uncovered } = scrollPixels(hdc, visible, scroll, clip,
                    dx | 0, dy | 0);
                paint.endPaint(record, hdc);
                const owed = intersectAreas(paint.updateOf(record), changed);
                const carried = intersectAreas(offsetArea(owed, dx | 0, dy | 0), [clip]);
                if (carried.length > 0)
                {
                    paint.invalidate(record, carried, record.erase === true, 'none');
                }
                const thread = host.callerThread?.();
                const taken = children ? childrenOf(record).filter(child=>child.x < scroll.right
                    && child.x + child.width > scroll.left && child.y < scroll.bottom
                    && child.y + child.height > scroll.top) : [];
                // One at a time, each move answered before the next starts:
                // a child's procedure hears WM_WINDOWPOSCHANGING, and two guest
                // calls started from one host call would run over each
                // other's stack. Its pixels moved with the window's; nothing
                // of it is to be redrawn but what the scroll left.
                /** @param {number} at @returns {number | Promise<number>} */
                const move = at=>(at >= taken.length ? 0
                    : andThen(placeWindow([taken[at].hwnd, 0, taken[at].x + (dx | 0),
                        taken[at].y + (dy | 0), 0, 0, 0x0001 | 0x0004 | 0x0008 | 0x0010 | 0x0100],
                    thread), ()=>move(at + 1)));
                return andThen(move(0), ()=>{
                    if ((flags & SW_INVALIDATE) !== 0 && uncovered.length > 0)
                    {
                        paint.invalidate(record, uncovered, (flags & SW_ERASE) !== 0,
                            children ? 'all' : 'auto');
                    }
                    return handScrollBack([...uncovered, ...owed, ...carried], region, updateRect);
                });
            },
        },

        /**
         * BOOL ScrollWindow(HWND hWnd, int XAmount, int YAmount,
         *     const RECT *lpRect, const RECT *lpClipRect)
         *
         * ScrollWindowEx invalidating and erasing what is uncovered, and
         * taking the children along when the whole client area scrolls.
         */
        ScrollWindow: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([hwnd, dx, dy, scrollRect, clipRect])=>
                andThen((/** @type {any} */ (table)).ScrollWindowEx.handler([hwnd, dx, dy,
                    scrollRect, clipRect, 0, 0,
                    0x0002 | 0x0004 | ((scrollRect >>> 0) === 0 ? 0x0001 : 0)]),
                (/** @type {number} */ kind)=>(kind !== REGION_ERROR ? 1 : 0)),
        },

        /**
         * BOOL ScrollDC(HDC hDC, int dx, int dy, const RECT *lprcScroll,
         *     const RECT *lprcClip, HRGN hrgnUpdate, LPRECT lprcUpdate)
         *
         * The same move on a context the caller holds, within what it draws
         * in -- its window's visible part and the clip selected into it --
         * the scroll and the clip each all of that when not given. The
         * update area is handed back and nothing is invalidated.
         */
        ScrollDC: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([hdc, dx, dy, scrollRect, clipRect, region, updateRect])=>{
                if ((hdc >>> 0) === 0)
                {
                    return 0;
                }
                const visible = draw?.area?.(hdc >>> 0) ?? [];
                const all = boundsOf(visible);
                const scroll = (scrollRect >>> 0) === 0 ? all : readRect(host, scrollRect);
                const clip = (clipRect >>> 0) === 0 ? all : readRect(host, clipRect);
                const { uncovered } = scrollPixels(hdc >>> 0, visible, scroll, clip,
                    dx | 0, dy | 0);
                handScrollBack(uncovered, region, updateRect);
                return 1;
            },
        },

        /**
         * BOOL EnumThreadWindows(DWORD dwThreadId, WNDENUMPROC lpfn, LPARAM lParam)
         *
         * The top-level windows the thread made, topmost first, each handed to
         * the callback until one answers FALSE, which the call then answers;
         * TRUE otherwise, a thread with none included. A window made where no
         * thread was named belongs to the one asking, as
         * GetWindowThreadProcessId says.
         */
        EnumThreadWindows: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([threadId, callback, lParam])=>{
                const call = host.call;
                if (!call || (callback >>> 0) === 0)
                {
                    host.setLastError?.(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                const thread = host.callerThread?.();
                const asking = threadIdOf(thread) ?? 1;
                const listed = [...windows.values()]
                    .filter(record=>!record.destroyed && !isChild(record)
                        && (threadIdOf(record.thread) ?? asking) === (threadId >>> 0))
                    .reverse()
                    .map(record=>record.hwnd);
                return (async()=>{
                    for (const hwnd of listed)
                    {
                        if ((await call(callback >>> 0, [hwnd, lParam >>> 0], thread) | 0) === 0)
                        {
                            return 0;
                        }
                    }
                    return 1;
                })();
            },
        },

        /**
         * HICON InternalGetWindowIcon(HWND hwnd, UINT iconType)
         *
         * A copy of the icon the window's class shows -- the small one for
         * ICON_SMALL and ICON_SMALL2, the big one standing in when it has
         * none -- for the caller to destroy; with none at all, the system's
         * application icon.
         */
        InternalGetWindowIcon: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, type])=>{
                const ICON_BIG = 1;
                const IMAGE_ICON = 1;
                const IDI_APPLICATION = 32512;
                const record = live(hwnd);
                if (!record)
                {
                    return 0;
                }
                const cls = classNamed(String(record.className));
                const icon = ((type >>> 0) === ICON_BIG ? cls?.icon
                    : cls?.iconSm || cls?.icon) ?? 0;
                const copy = icon !== 0
                    ? (/** @type {any} */ (table)).CopyImage.handler([icon, IMAGE_ICON, 0, 0, 0]) : 0;
                return copy !== 0 ? copy
                    : (/** @type {any} */ (table)).LoadIconA.handler([0, IDI_APPLICATION]);
            },
        },

        /** LRESULT DispatchMessageA(const MSG *lpMsg) */
        DispatchMessageA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([msg])=>deliver(readMessage(host, msg)),
        },

        /**
         * LRESULT DispatchMessageW(const MSG *lpMsg)
         *
         * The message as a wide caller retrieved it: a character in it is a
         * UTF-16 unit, and reaches an ANSI procedure as the page's byte.
         */
        DispatchMessageW: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([msg])=>deliver({ ...readMessage(host, msg), unicode: true }),
        },

        /**
         * LRESULT DefWindowProcA(HWND hWnd, UINT Msg, WPARAM wParam, LPARAM lParam)
         *
         * WM_DESTROY is deliberately not handled, and that is the whole of
         * it: Windows' default procedure does nothing with it. Ending the
         * message loop is the program's own decision, made by calling
         * PostQuitMessage from the window procedure of the one window it
         * considers its main one.
         *
         * Posting a quit here instead looks harmless and is not. A program of
         * any size destroys windows all the time -- a dialog, a tooltip, a
         * splash screen -- and passes their WM_DESTROY to the default
         * procedure because it has nothing to add. Every one of those then
         * ends the process: a real title was measured closing an auxiliary
         * window after loading its textures, and shutting itself down cleanly
         * and inexplicably a moment later.
         */
        DefWindowProcA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([hwnd, message, wParam, lParam])=>{
                const record = windows.get(hwnd >>> 0);
                if (!record)
                {
                    return (message >>> 0) === WM_NCCREATE ? 1 : 0;
                }
                return defWindowProc(record, {
                    hwnd: hwnd >>> 0, message: message >>> 0,
                    wParam: wParam >>> 0, lParam: lParam >>> 0,
                }, host.callerThread?.());
            },
        },

        /**
         * LRESULT DefWindowProcW(HWND hWnd, UINT Msg, WPARAM wParam, LPARAM lParam)
         *
         * The default procedure reads the ANSI page, so a wide message reaches
         * it converted and what it writes back -- WM_GETTEXT's text -- comes
         * back wide.
         */
        DefWindowProcW: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([hwnd, message, wParam, lParam])=>translated(host, {
                hwnd: hwnd >>> 0, message: message >>> 0, wParam: wParam >>> 0,
                lParam: lParam >>> 0, unicode: true,
            }, false, ansi=>table.DefWindowProcA.handler(
                [ansi.hwnd, ansi.message, ansi.wParam, ansi.lParam])),
        },

        /**
         * LRESULT DefFrameProcA/W(HWND hWnd, HWND hWndMDIClient, UINT uMsg,
         *     WPARAM wParam, LPARAM lParam)
         *
         * The default procedure of an MDI frame: what concerns its client --
         * a child chosen from the Window menu, a new size, the focus -- the
         * client answers (mdi.js), the rest DefWindowProc.
         */
        DefFrameProcA: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: args=>mdi.defFrame(args, host.callerThread?.())
                ?? table.DefWindowProcA.handler([args[0], args[2], args[3], args[4]]),
        },

        DefFrameProcW: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: args=>mdi.defFrame(args, host.callerThread?.())
                ?? table.DefWindowProcW.handler([args[0], args[2], args[3], args[4]]),
        },

        /**
         * LRESULT DefMDIChildProcA/W(HWND hWnd, UINT uMsg, WPARAM wParam,
         *     LPARAM lParam)
         *
         * The default procedure of an MDI child: activation, the focus,
         * closing and the system menu's commands go to its client (mdi.js),
         * the rest to DefWindowProc.
         */
        DefMDIChildProcA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: args=>{
                // DefWindowProc may run past the client's answer, on this thread.
                const thread = host.callerThread?.();
                return andThen(mdi.defChild(args, thread), answer=>answer
                    ?? defaultFor(args, false, thread));
            },
        },

        DefMDIChildProcW: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: args=>{
                const thread = host.callerThread?.();
                return andThen(mdi.defChild(args, thread), answer=>answer
                    ?? defaultFor(args, true, thread));
            },
        },

        /** BOOL TranslateMDISysAccel(HWND hWndClient, LPMSG lpMsg) */
        TranslateMDISysAccel: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([client, msg])=>mdi.translateAccelerator(client, msg,
                host.callerThread?.()),
        },
    };
    /**
     * One of the table's own calls, made as a program makes it: from
     * `thread` when named, since past an await the thread on the processor
     * is another.
     *
     * @param {string} name @param {number[]} args @param {unknown} [thread]
     */
    const callOwn = (name, args, thread)=>{
        const run = ()=>/** @type {any} */ (table)[name].handler(args);
        return thread !== undefined && host.answering ? host.answering(thread, run) : run();
    };
    // The directory list a dialog fills is made of the list box's messages.
    Object.assign(table, createDirectoryListFunctions({ host, call: callOwn }));
    // A message box is a dialog user32 makes out of its own calls, so it is
    // built over the finished table.
    let messageBoxProcedures = 0;
    return Object.assign(table, createMessageBoxFunctions({
        host,
        call: callOwn,
        procedure: (name, handler)=>{
            messageBoxProcedures++;
            /** @type {number} */
            const address = host.registerProcedure
                ? host.registerProcedure(`<${name}>`,
                    message=>callProcedure(address, message, host.callerThread?.()))
                : HOST_PROCEDURE_BASE - messageBoxProcedures * 16;
            procedures.set(address, handler);
            return address;
        },
        measure: (hwnd, text, width)=>{
            const record = live(hwnd);
            if (!record)
            {
                return { width: 0, height: 0 };
            }
            const hdc = paint.contextOn(record);
            inFont(record, hdc);
            const cell = paint.cellOf(hdc);
            const widthOf = cell.width
                ?? ((/** @type {string} */ piece)=>piece.length * cell.cellWidth);
            const lines = layoutText(text, { left: 0, top: 0, right: width, bottom: 0x7fff },
                DT_WORDBREAK | DT_NOPREFIX, cell);
            if (hdc !== 0)
            {
                paint.table.ReleaseDC.handler([hwnd, hdc]);
            }
            return {
                width: lines.reduce((most, line)=>Math.max(most, widthOf(line.text)), 0),
                height: Math.max(lines.length, 1) * cell.cellHeight,
            };
        },
        frame: hwnd=>{
            const record = live(hwnd);
            if (!record)
            {
                return { width: 0, height: 0 };
            }
            const outer = geometry.windowRect(record);
            const inner = geometry.clientSize(record);
            return { width: outer.right - outer.left - inner.width,
                height: outer.bottom - outer.top - inner.height };
        },
    }));
}
