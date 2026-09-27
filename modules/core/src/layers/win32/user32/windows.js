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

import { ANY_WINDOW, WM_PAINT, WM_QUIT, WM_TIMER } from './messages.js';
import { characterOf } from './keys.js';
import { encodeAnsi } from '../kernel32/locale.js';
import { createPaintFunctions } from './paint.js';
import { HOVER_SIZE, HOVER_TIME, SYS_COLORS, createSystemFunctions } from './system.js';
import { createObjectFunctions } from './objects.js';
import { createDialogFunctions } from './dialogs.js';
import { createRawInput } from './rawinput.js';
import {
    WS_CHILD, WS_DISABLED, contains, createGeometry, intersect, isEmpty,
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
    WNDCLASSA,
    WNDCLASSEXA,
    readMessage,
    readU32,
    readWindowClass,
    writeMessage,
    writeRect,
    writeU32s,
    writeWindowClassA,
} from './structs.js';

/** Messages this layer has an opinion about. */
const WM_DESTROY = 0x0002;
const WM_NCDESTROY = 0x0082;
const WM_MOVE = 0x0003;
const WM_SIZE = 0x0005;
/** WM_SIZE's wParam for a plain resize: not minimised, not maximised. */
const SIZE_RESTORED = 0;
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
const COLOR_ACTIVECAPTION = 2;
const COLOR_INACTIVECAPTION = 3;
const COLOR_MENU = 4;
const COLOR_CAPTIONTEXT = 9;
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

/** The one hook type this build calls, and the one event it calls it for. */
const WH_CBT = 5;
const HCBT_CREATEWND = 3;

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
const WS_MINIMIZE = 0x20000000;
const WS_POPUP = 0x80000000;
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
 * The kernel objects whose signal a poll reads the same for every thread:
 * a mutex is owned by one, a thread and a process are not polled at all.
 */
const POLLED_KINDS = new Set(['event', 'semaphore', 'timer']);

/** PeekMessage takes this where a window goes to mean "thread messages only". */
const HWND_THREAD_MESSAGES = 0xffffffff;

/** What PostThreadMessage reports for an identifier that names no thread. */
const ERROR_INVALID_THREAD_ID = 1444;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INVALID_WINDOW_HANDLE = 1400;

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
 */

/**
 * @typedef {Object} WindowService
 * @property {() => { hwnd: string, x: number, y: number, width: number, height: number,
 *            rect: { left: number, top: number, right: number, bottom: number },
 *            client: { left: number, top: number, right: number, bottom: number },
 *            visible: boolean, className: string, title: string, parent: string | null,
 *            child: boolean, id: number }[]} list
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
 * @property {() => void} refresh
 *           Repaints the desktop and every window shown on it.
 * @property {(event: import('./rawinput.js').RawInputEvent) => void} rawInput
 *           One event of the mouse or the keyboard as the device reported it,
 *           posted as WM_INPUT to whoever registered for that device.
 * @property {(hwnd: number, options: { thread: unknown,
 *     first?: import('./dialogs.js').ModalHook }) => number | Promise<number>} modalLoop
 *           Runs a dialog another library made as DialogBox runs one, on the
 *           thread named, each message offered to `first` before the dialog
 *           manager: what a property sheet's own loop is on Windows.
 */

/**
 * @typedef {Object} WindowHost
 * @property {{ width: number, height: number, bitsPerPixel: number }} [screen]
 *           The display every system metric is derived from.
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
 * @property {() => void} [present]
 *           Shows the desktop. Called once a paint pass has finished.
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
 *           buttons: { id: number, label: string }[], defaultButton: number,
 *           icon: string | null }) => number | Promise<number> | void} [messageBox]
 *           A message box the program put up, handed up whole with the buttons
 *           uType asks for. The answer is the id of the button pressed: a
 *           promise when a page will answer it, which the bridge parks the
 *           calling thread on, or a number when it is already known. Returning
 *           nothing means nobody is listening and the box's default is used.
 *           It is a program explaining in its own words why it is about to
 *           stop, which is the most useful sentence it will ever say, and a
 *           line in a log is where such a sentence goes to be missed.
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
    let nextAtom = FIRST_ATOM;

    /**
     * Resolves the argument every API takes where a class name is declared. It
     * is a pointer to a string, or -- because that is what registration handed
     * back -- an atom stuffed into the low word.
     *
     * @param {number} pointer
     * @returns {any | null}
     */
    const classOf = pointer=>{
        const value = pointer >>> 0;
        if (value === 0)
        {
            return null;
        }
        const name = value <= LAST_ATOM
            ? atoms.get(value)
            : host.readCString(value, MAX_CLASS_NAME);
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
     * @returns {number | Promise<number>}
     */
    const callProcedure = (address, message, thread)=>{
        host.trace?.(message);
        const procedure = procedures.get(address >>> 0);
        if (procedure)
        {
            // Named now, while the call that brought us here still holds the
            // processor: a procedure on this side that sends to guest code
            // and goes on afterwards is past an await by then.
            const on = thread ?? host.callerThread?.();
            const record = windows.get(message.hwnd >>> 0);
            return record ? watchDispatch(host, message, procedure(record, message, on)) : 0;
        }
        return watchDispatch(host, message, host.dispatch(address >>> 0, message, thread));
    };

    /**
     * SendMessage, to a live window: its procedure runs before this returns,
     * or the answer is a promise of when it will have.
     *
     * @param {number} hwnd @param {number} message @param {number} wParam @param {number} lParam
     * @param {unknown} [thread]
     * @returns {number | Promise<number>}
     */
    const send = (hwnd, message, wParam, lParam, thread)=>{
        const record = live(hwnd);
        if (!record || record.wndProc === 0)
        {
            return 0;
        }
        return callProcedure(record.wndProc, {
            hwnd: record.hwnd, message: message >>> 0, wParam: wParam >>> 0, lParam: lParam >>> 0,
        }, thread);
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
     */
    const findWindow = (parent, after, classPointer, namePointer)=>{
        const cls = classPointer === 0 ? null : classOf(classPointer);
        if (classPointer !== 0 && !cls)
        {
            return 0;
        }
        const title = namePointer === 0
            ? null
            : host.readCString(namePointer, MAX_WINDOW_TEXT).toLowerCase();
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
            if (cls !== null && record.className !== cls.name)
            {
                continue;
            }
            if (title !== null && record.title.toLowerCase() !== title)
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
                parent: 0, instance: 0, id: 0, wndProc: 0, menu: 0, x: 0, y: 0,
                width: 0, height: 0, userData: 0, extra: new DataView(new ArrayBuffer(0)),
                destroyed: false, updateRect: null, erase: false, ncDirty: false,
            };
            desktop.hwnd = host.handles.open('window', desktop);
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
        return record && !record.destroyed ? record : null;
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
     * popups GetLastActivePopup answers about. An owner is kept where a
     * child keeps its parent, and a chain a program looped with SetParent
     * ends where it comes round.
     *
     * @param {any} record
     */
    const rootOwnerOf = record=>{
        let at = topLevelOf(record);
        const seen = new Set([at]);
        for (let owner = live(at.parent); owner && !seen.has(topLevelOf(owner));
            owner = live(at.parent))
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
     * Every live window in the order it is painted and hit: top-level
     * windows from the bottom up, each followed by its descendants.
     *
     * @returns {any[]}
     */
    const paintOrder = ()=>{
        /** @type {any[]} */
        const listed = [];
        /** @param {any} record */
        const visit = record=>{
            listed.push(record);
            childrenOf(record).forEach(visit);
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
     * Puts a top-level window on top of the others: last in the order the
     * records are kept in, which is the order they are painted and hit in.
     *
     * @param {any} record
     */
    const raise = record=>{
        const top = topLevelOf(record);
        if (windows.get(top.hwnd) !== top || [...windows.keys()].at(-1) === top.hwnd)
        {
            return;
        }
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
        if (shown(top))
        {
            appear(top);
        }
    };

    /**
     * Moves a child within its siblings' stacking -- which for children is
     * the order the records are kept in, topmost first -- as SetWindowPos's
     * hWndInsertAfter says: HWND_BOTTOM below them all, a sibling's handle
     * just below that sibling, and the top for anything else.
     *
     * @param {any} record @param {number} after
     */
    const restack = (record, after)=>{
        const HWND_BOTTOM = 1;
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
        if (shown(record))
        {
            appear(record);
        }
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
    /** What WM_ACTIVATEAPP last told the application: false once it went. */
    let applicationActive = true;
    let deactivations = 0;
    const activeWindow = ()=>{
        if (active !== 0 && live(active))
        {
            return active;
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
     * @param {{ thread?: unknown, how?: number }} [options]
     *        `how` is WM_ACTIVATE's wParam for the window gaining it:
     *        WA_CLICKACTIVE when a click did it.
     * @returns {number | Promise<number>} once every procedure told has answered
     */
    const activate = (hwnd, { thread, how = WA_ACTIVE } = {})=>{
        const record = live(hwnd);
        const previous = active;
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
            focus = active;
        }
        if (active === previous)
        {
            return 0;
        }
        const gained = active;
        /** @type {[number, number, number, number][]} */
        const told = [];
        if (previous !== 0)
        {
            told.push([previous, WM_NCACTIVATE, 0, 0],
                [previous, WM_ACTIVATE, WA_INACTIVE, gained]);
        }
        // The program is the active application or stops being it when the
        // activation comes from, or goes to, nothing or the desktop -- the
        // one window here that is not the program's. lParam names the thread
        // on the other side: another program's, which here is none.
        /** @param {number} which */
        const programs = which=>which !== 0 && which !== desktop?.hwnd;
        if (programs(previous) !== programs(gained))
        {
            applicationActive = programs(gained);
            deactivations += applicationActive ? 0 : 1;
            for (const top of [...windows.values()]
                .filter(each=>!each.destroyed && !isChild(each)).reverse())
            {
                told.push([top.hwnd, WM_ACTIVATEAPP, programs(gained) ? 1 : 0, 0]);
            }
        }
        if (gained !== 0)
        {
            told.push([gained, WM_NCACTIVATE, 1, 0], [gained, WM_ACTIVATE, how, previous]);
        }
        if (moved)
        {
            if (current !== 0)
            {
                told.push([current, WM_KILLFOCUS, gained, 0]);
            }
            told.push([gained, WM_SETFOCUS, current, 0]);
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
        return tell(0);
    };

    /**
     * The window the keyboard goes to. Separate from the active window: the
     * active one is a top-level window, the focus is usually a control in
     * it, and both are asked for by name.
     */
    let focus = 0;
    const focusWindow = ()=>(focus !== 0 && live(focus) ? focus : 0);
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
        focus = target;
        // Activation is told first, then the focus: a window gaining both
        // hears WM_ACTIVATE before WM_SETFOCUS.
        const activated = target !== 0 ? activate(target, { thread }) : 0;
        return andThen(activated, ()=>
            andThen(previous !== 0 ? send(previous, WM_KILLFOCUS, target, 0, thread) : 0,
                ()=>andThen(target !== 0 ? send(target, WM_SETFOCUS, previous, 0, thread) : 0,
                    ()=>previous)));
    };

    /** The window that has the mouse, or zero. */
    let captured = 0;
    /** @param {number} hwnd */
    const setCapture = hwnd=>{
        const previous = captured;
        captured = live(hwnd) ? hwnd >>> 0 : 0;
        return previous;
    };
    const releaseCapture = ()=>{
        const previous = captured;
        captured = 0;
        if (previous !== 0 && live(previous))
        {
            host.queue.post({ hwnd: previous, message: WM_CAPTURECHANGED, wParam: 0, lParam: 0 });
        }
    };

    /**
     * @param {import('./structs.js').WindowClassFields} fields
     * @returns {number} the atom, or zero if the class cannot be registered
     */
    const register = fields=>{
        // A class is named by a string here: an atom is what registration
        // produces, never something it can be handed.
        if ((fields.className >>> 0) <= LAST_ATOM)
        {
            return 0;
        }
        const name = host.readCString(fields.className, MAX_CLASS_NAME);
        if (name.length === 0 || classes.has(name) || nextAtom > LAST_ATOM)
        {
            return 0;
        }
        const atom = nextAtom++;
        classes.set(name, { ...fields, name, atom });
        atoms.set(atom, name);
        return atom;
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
        const covered = shown(record) ? geometry.windowRect(record) : null;
        const on = thread ?? host.callerThread?.();
        /** @param {number} message @returns {number | Promise<number>} */
        const tell = message=>(told === 'all' || (told === 'ncdestroy' && message === WM_NCDESTROY)
            ? send(record.hwnd, message, 0, 0, on)
            : 0);
        return andThen(tell(WM_DESTROY), ()=>{
            const children = [...windows.values()]
                .filter(child=>child.parent === record.hwnd && !child.destroyed);
            /** @param {number} index @returns {number | Promise<number>} */
            const destroyChildren = index=>(index < children.length
                ? andThen(destroyWindow(children[index].hwnd, on, told),
                    ()=>destroyChildren(index + 1))
                : 1);
            return andThen(destroyChildren(0),
                ()=>andThen(tell(WM_NCDESTROY), ()=>{
                    record.destroyed = true;
                    // A dialog's font is the dialog manager's, made from its
                    // template, and goes with the dialog.
                    if (record.dialogFont)
                    {
                        draw?.deleteFont?.(record.dialogFont);
                    }
                    host.handles.close(record.hwnd);
                    if (active === record.hwnd)
                    {
                        active = 0;
                    }
                    if (focus === record.hwnd)
                    {
                        focus = 0;
                    }
                    if (captured === record.hwnd)
                    {
                        captured = 0;
                    }
                    if (tracking?.hwnd === record.hwnd)
                    {
                        stopTracking();
                    }
                    // Its menu goes with it, as DestroyWindow is documented
                    // to destroy it; one a program took back with SetMenu is
                    // its own again.
                    if ((record.menu ?? 0) !== 0)
                    {
                        table.DestroyMenu.handler([record.menu]);
                    }
                    if (covered)
                    {
                        uncover(covered);
                    }
                    return 1;
                }));
        });
    };

    /** @param {any} record @param {number} index */
    const readLong = (record, index)=>{
        switch (index | 0){
            case GWL_WNDPROC:
                return record.wndProc;
            case GWL_HINSTANCE:
                return record.instance;
            case GWL_HWNDPARENT:
                return record.parent;
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

    /** @param {any} record @param {number} index @param {number} value */
    const writeLong = (record, index, value)=>{
        switch (index | 0){
            case GWL_WNDPROC:
                record.wndProc = value >>> 0;
                return;
            case GWL_HWNDPARENT:
                record.parent = value >>> 0;
                return;
            case GWL_ID:
                record.id = value >>> 0;
                return;
            case GWL_STYLE:
                record.style = value >>> 0;
                return;
            case GWL_EXSTYLE:
                record.exStyle = value >>> 0;
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
            return table.DefWindowProcA.handler(
                [message.hwnd, message.message, message.wParam, message.lParam]);
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
     * ponytail: a hook's thread is recorded and not consulted -- every hook of
     * a type is called whichever thread creates the window. Per-thread
     * delivery when a program is seen to hook one thread and create on another.
     *
     * @type {{ handle: number, type: number, proc: number, thread: number }[]}
     */
    const hooks = [];

    /**
     * Calls the newest hook of a type, or the one older than `after`.
     *
     * @param {number} type @param {number | null} after  A hook handle, or null for the newest.
     * @param {number[]} args @param {unknown} thread
     * @returns {number | Promise<number>} what the hook answered; 0 with none to call.
     */
    const callHook = (type, after, args, thread)=>{
        let from = hooks.length - 1;
        if (after !== null)
        {
            from = hooks.findIndex(hook=>hook.handle === after) - 1;
        }
        for (let at = from; at >= 0; at--)
        {
            if (hooks[at].type === type && host.call)
            {
                return host.call(hooks[at].proc, args, thread);
            }
        }
        return 0;
    };

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
            menu: 0,
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            userData: 0,
            extra: new DataView(new ArrayBuffer(0)),
            destroyed: false,
            /** @type {{ left: number, top: number, right: number, bottom: number } | null} */
            updateRect: null,
            erase: false,
            ncDirty: false,
            ...fields,
        };
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
        record.hwnd = host.handles.open('window', record);
        windows.set(record.hwnd, record);
        if ((record.style & WS_VISIBLE) !== 0)
        {
            appear(record);
        }
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
     * CreateWindowExA, and CreateWindowA once its missing argument is filled in.
     *
     * @param {number[]} args  The extended style first, then the eleven that
     *                         both entry points share.
     */
    const createWindow = args=>{
        const [exStyle, className, windowName, style, x, y, width, height, parent, menu, instance]
            = args;
        const cls = classOf(className);
        if (!cls)
        {
            return 0;
        }
        const record = makeWindow({
            className: cls.name,
            title: (windowName >>> 0) === 0 ? '' : host.readCString(windowName, MAX_WINDOW_TEXT),
            style: style >>> 0,
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
            width: coordinate(width, DEFAULT_WIDTH),
            height: coordinate(height, DEFAULT_HEIGHT),
            extra: new DataView(new ArrayBuffer(Math.max(cls.windowExtra, 0))),
        });
        // Input has to land somewhere, and what a person is looking at is the
        // window that was made most recently until something says otherwise.
        // Telling the host here is the only way it can know a handle it never
        // saw created.
        host.created?.(record.hwnd);
        return announce(record, args);
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
     * @param {any} record @param {number[]} args
     */
    const announce = (record, args)=>{
        const [exStyle, className, windowName, style, x, y, width, height,
            parent, menu, instance, params] = args;
        // Named once, before anything is awaited: a call made after the hook
        // has answered is answering a call the bridge has already let go of.
        const thread = host.callerThread?.();
        /** The window, activated first when it was created visible. */
        const activated = ()=>andThen(activateCreated(record, thread), ()=>record.hwnd);
        // A procedure on this side reads nothing out of a CREATESTRUCT.
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
        const hooked = hooks.some(hook=>hook.type === WH_CBT);
        if (systemProcedure() && !hooked)
        {
            return onThisSide();
        }
        if (!host.allocate)
        {
            return activated();
        }
        // The CREATESTRUCT, and behind it the two words a CBT hook is handed
        // that point at it.
        const create = host.allocate(CREATESTRUCTA.SIZE + CBT_CREATEWNDA.SIZE);
        if (create === 0)
        {
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
        put(CREATESTRUCTA.dwExStyle, exStyle);
        put(CREATESTRUCTA.SIZE + CBT_CREATEWNDA.lpcs, create);
        put(CREATESTRUCTA.SIZE + CBT_CREATEWNDA.hwndInsertAfter, 0);
        host.writeMemory(create, bytes);
        void width;
        void height;
        void x;
        void y;

        /** @param {number} message */
        const tell = message=>callProcedure(record.wndProc, {
            hwnd: record.hwnd, message, wParam: 0, lParam: create,
        }, thread);
        /** @param {number} handle */
        const done = handle=>{
            host.release?.(create);
            return handle;
        };

        // The CBT hook first, before the window's own procedure has run: a
        // framework attaches its object to the window here and subclasses the
        // procedure, so the messages that follow reach the framework and not
        // the class. A hook that answers non-zero refuses the window.
        const cbt = callHook(WH_CBT, null,
            [HCBT_CREATEWND, record.hwnd, create + CREATESTRUCTA.SIZE], thread);
        /** @returns {number | Promise<number>} */
        const refuse = ()=>andThen(destroyWindow(record.hwnd, thread, 'ncdestroy'), ()=>done(0));
        return andThen(cbt, refused=>{
            if ((refused | 0) !== 0)
            {
                return andThen(destroyWindow(record.hwnd, thread, 'none'), ()=>done(0));
            }
            // Left with its own procedure by the hook: created as a system
            // window is.
            if (systemProcedure())
            {
                return andThen(onThisSide(), created=>done(created));
            }
            // WM_NCCREATE before WM_CREATE, with the same structure: a
            // procedure that keeps lpCreateParams takes it from the first.
            return andThen(tell(WM_NCCREATE), accepted=>((accepted | 0) === 0 ? refuse()
                : andThen(tell(WM_CREATE), created=>{
                    if ((created | 0) === -1)
                    {
                        return refuse();
                    }
                    // A window created visible hears its own size, its place
                    // and that it is shown inside this call, as the real
                    // CreateWindowEx sends them once WM_CREATE has been
                    // answered: a program that never calls ShowWindow
                    // measures the screen it lays itself out and rasterises
                    // its text for from the size it is told here. Then it
                    // is activated.
                    if ((style & WS_VISIBLE) === 0)
                    {
                        return done(record.hwnd);
                    }
                    const client = geometry.clientRect(record);
                    return andThen(send(record.hwnd, WM_SIZE, SIZE_RESTORED,
                        ((((client.bottom - client.top) & 0xffff) << 16)
                            | ((client.right - client.left) & 0xffff)) >>> 0, thread),
                    ()=>andThen(send(record.hwnd, WM_MOVE, 0,
                        (((y & 0xffff) << 16) | (x & 0xffff)) >>> 0, thread),
                    ()=>andThen(send(record.hwnd, WM_SHOWWINDOW, 1, 0, thread),
                        ()=>andThen(activateCreated(record, thread), ()=>done(record.hwnd)))));
                })));
        });
    };

    // --- Painting: the desktop, the frame, and who repaints after whom ---

    /** Whether something has been drawn since the desktop was last shown. */
    let presentPending = false;
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

    /** @param {number} index  A system colour, as a COLORREF. */
    const sysColor = index=>SYS_COLORS[index | 0] ?? 0;

    /**
     * The window manager's drawing, over gdi32's, with the system colours
     * added: the one description of the classic look a program can also
     * read, through GetSysColor.
     */
    const draw = host.draw
        ? Object.assign(Object.create(host.draw), { sysColor })
        : null;

    /**
     * Marks a window's whole client area, frame included, for repainting.
     *
     * @param {any} record
     */
    const repaint = record=>{
        const size = geometry.clientSize(record);
        record.ncDirty = true;
        paint.invalidate(record, { left: 0, top: 0, right: size.width, bottom: size.height },
            true);
    };

    /**
     * A window's update area grew: every window painted after it that
     * overlaps it on the screen has to repaint too, or the one below would
     * come out on top. The whole overlapping window is marked rather than
     * the overlap, which is the one-rectangle ceiling of the update area.
     *
     * @param {any} record
     */
    const invalidated = record=>{
        if (!shown(record) || !record.updateRect)
        {
            return;
        }
        host.queue.dirtied?.();
        const origin = geometry.clientRect(record);
        const dirty = {
            left: origin.left + record.updateRect.left,
            top: origin.top + record.updateRect.top,
            right: origin.left + record.updateRect.right,
            bottom: origin.top + record.updateRect.bottom,
        };
        const order = paintOrder();
        for (const other of order.slice(order.indexOf(record) + 1))
        {
            if (shown(other) && !isEmpty(intersect(dirty, geometry.windowRect(other))))
            {
                const size = geometry.clientSize(other);
                const whole = { left: 0, top: 0, right: size.width, bottom: size.height };
                if (!record.updateRect || !other.updateRect
                    || !sameRect(other.updateRect, whole))
                {
                    other.ncDirty = true;
                    other.updateRect = whole;
                    other.erase = true;
                }
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
        (draw?.fillBackground ?? draw?.fill)?.call(draw, hdc,
            { left: 0, top: 0, right: host.screen.width, bottom: host.screen.height },
            sysColor(COLOR_BACKGROUND));
        host.dc?.()?.release(0, hdc);
    };

    /**
     * A window appeared: it and everything inside it paint from scratch.
     *
     * @param {any} record
     */
    const appear = record=>{
        paintDesktop();
        for (const each of [record, ...descendantsOf(record)])
        {
            if (shown(each))
            {
                repaint(each);
            }
        }
    };

    /** @param {any} record @returns {any[]} every live descendant, in paint order */
    const descendantsOf = record=>childrenOf(record)
        .flatMap(child=>[child, ...descendantsOf(child)]);

    /**
     * A part of the screen has nothing on it any more: the desktop shows
     * through, and every window still under it repaints.
     *
     * @param {{ left: number, top: number, right: number, bottom: number }} rect
     */
    const uncover = rect=>{
        paintDesktop();
        const hdc = host.dc?.()?.get(0, null) ?? 0;
        if (hdc !== 0)
        {
            draw?.fill(hdc, rect, sysColor(COLOR_BACKGROUND));
            host.dc?.()?.release(0, hdc);
            painted();
        }
        for (const other of paintOrder())
        {
            if (shown(other) && !isEmpty(intersect(rect, geometry.windowRect(other))))
            {
                repaint(other);
            }
        }
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
        // The border, one ring per pixel of edge: raised for the outer
        // ring, face colour inside, as the classic frame is.
        for (let ring = 0; ring < frame.edge; ring++)
        {
            const outer = ring === 0;
            const topLeft = outer ? sysColor(COLOR_3DHILIGHT) : face;
            const bottomRight = outer ? sysColor(COLOR_3DDKSHADOW)
                : ring === 1 ? sysColor(COLOR_3DSHADOW) : face;
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
            const isActive = topLevelOf(record).hwnd === activeWindow();
            const bar = { left: frame.edge, top: frame.edge, right: width - frame.edge,
                bottom: frame.edge + frame.caption };
            draw.fill(hdc, bar, sysColor(isActive ? COLOR_ACTIVECAPTION : COLOR_INACTIVECAPTION));
            const box = closeBox(record);
            const metrics = draw.measure(hdc, 'M');
            draw.text(hdc, bar.left + 4, bar.top + Math.floor((frame.caption - metrics.height) / 2),
                record.title, {
                    color: sysColor(isActive ? COLOR_CAPTIONTEXT : COLOR_INACTIVECAPTIONTEXT),
                    clip: { ...bar, right: box.left - 2 },
                });
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
                draw.fill(hdc, { left: box.right - 5 - step, top: y, right: box.right - 3 - step,
                    bottom: y + 1 }, ink);
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

    /** The close box, in window coordinates. @param {any} record */
    const closeBox = record=>{
        const frame = geometry.frame(record);
        const size = Math.min(CLOSE_BOX, frame.caption - 2 * CLOSE_GAP);
        const top = frame.edge + Math.floor((frame.caption - size) / 2);
        return { left: record.width - frame.edge - CLOSE_GAP - size, top,
            right: record.width - frame.edge - CLOSE_GAP, bottom: top + size };
    };

    /**
     * What part of a window a screen point is on: the client area, the
     * caption, its close box, the border, or nowhere.
     *
     * @param {any} record @param {number} x @param {number} y
     */
    const hitTest = (record, x, y)=>{
        const rect = geometry.windowRect(record);
        if (!contains(rect, x, y))
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
            return contains(box, local.x, local.y) ? HTCLOSE : HTCAPTION;
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
                    || !contains(geometry.windowRect(record), x, y)
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
            for (const entry of host.queue.queued())
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
        const entry = host.queue.peek(filter);
        if (!entry)
        {
            return null;
        }
        return andThen(mouseActivate(entry, thread), (/** @type {boolean} */ keep)=>(keep
            ? andThen(askCursor(entry, thread), ()=>entry)
            : takeThrough(filter, thread)));
    });

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
            case WM_NCCALCSIZE:
                return 0;
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
                return andThen(destroyWindow(record.hwnd, thread), ()=>0);
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
                if ((message.wParam & 0xfff0) === SC_CLOSE)
                {
                    return send(record.hwnd, WM_CLOSE, 0, 0, thread);
                }
                return 0;
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
                if (geometry.frame(record).caption > 0 && shown(record))
                {
                    record.ncDirty = true;
                    paint.invalidate(record, { left: 0, top: 0, right: 0, bottom: 0 }, false);
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
            record.ncDirty = true;
            paintFrame(record);
            return 0;
        });
    };

    const paint = createPaintFunctions({
        // The drawing with the system colours on it, which FillRect needs
        // for a brush named as a colour index.
        host: Object.assign(Object.create(host), { draw }),
        live, WM_PAINT, geometry, send, invalidated, painted,
        descendants: (/** @type {any} */ record)=>descendantsOf(record),
    });

    /**
     * What TranslateMessage does: a key press becomes the character the
     * host's own keyboard layout made of it, posted after the press. That is
     * where a layout, a dead key and an input method live, and none of them
     * can be worked out from a virtual key here; for a host that composes
     * nothing -- a recorded session, a test -- the character is the one
     * layout table's (`keys.js`), under the modifiers held now: the same
     * answer ToUnicode gives for the same key state.
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
                shift: ((host.keyState?.(0x10) ?? 0) & 0x8000) !== 0,
                capsLock: ((host.keyState?.(0x14) ?? 0) & 0x0001) !== 0,
                control: ((host.keyState?.(0x11) ?? 0) & 0x8000) !== 0,
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
        divergence: host.divergence,
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
    host.queue.paintsFrom?.(filter=>{
        for (const record of paintOrder())
        {
            if (record.updateRect && shown(record)
                && (filter.hwnd === ANY_WINDOW || filter.hwnd === record.hwnd))
            {
                return record.hwnd;
            }
        }
        presentIfPainted();
        return 0;
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
        /** The window GetForegroundWindow answers with, or zero. */
        active: ()=>activeWindow(),
        deactivated: ()=>!applicationActive,
        deactivations: ()=>deactivations,

        modalLoop: (hwnd, { thread, first })=>(runModal
            ? runModal(hwnd >>> 0, thread, first) : 0),

        /**
         * One event of the mouse or the keyboard as the device reported it,
         * for WM_INPUT: what a program that registered for raw input reads,
         * beside the messages it has always had.
         */
        rawInput: rawInput.deliver,

        /**
         * The desktop and every window shown on it paint again: what the
         * screen needs when this process's picture comes back after a child
         * that ran beside it drew over the same canvas.
         */
        refresh(){
            desktopPainted = false;
            for (const record of windows.values())
            {
                if (!record.destroyed && !isChild(record) && shown(record))
                {
                    appear(record);
                }
            }
            paintDesktop();
        },

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
                visible: (record.style & WS_VISIBLE) !== 0,
                className: record.className,
                title: record.title,
                parent: record.parent ? `0x${record.parent.toString(16)}` : null,
                // Inside its parent, as against owned by it: a top-level
                // window with an owner is still over everything below it.
                child: isChild(record),
                id: record.id,
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
     */
    const showWindow = (record, cmdShow)=>{
        const wasVisible = (record.style & WS_VISIBLE) !== 0;
        const hide = cmdShow === SW_HIDE;
        const covered = wasVisible && hide && shown(record)
            ? geometry.windowRect(record) : null;
        // Matches Wine's dlls/user32/tests/msg.c WmShowNormal sequence: the
        // message is *sent* -- the procedure runs before this call returns --
        // and only when this call changes the visibility, because SW_SHOW on
        // an already-visible window says nothing happened and nothing did.
        // SW_SHOWNA is the exception, told whatever it found (WmSHOWNATopVisible).
        //
        // Sent, and then chained onto whatever follows it: a procedure the
        // bridge has to run answers with a promise, so returning this call's
        // own result before it has answered hands the host call back to the
        // guest while the guest's procedure is still pending -- and the guest
        // reuses its own stack under it.
        const greeting = wasVisible === hide || cmdShow === SW_SHOWNA
            ? send(record.hwnd, WM_SHOWWINDOW, hide ? 0 : 1, 0, host.callerThread?.())
            : 0;
        record.style = hide
            ? (record.style & ~WS_VISIBLE) >>> 0
            : (record.style | WS_VISIBLE) >>> 0;
        // Minimised is a state IsIconic reads back and a restore clears; the
        // window keeps its place in the picture, there being no taskbar to
        // shrink to.
        if (MINIMISING.has(cmdShow))
        {
            record.style = (record.style | WS_MINIMIZE) >>> 0;
        }
        else if (!hide)
        {
            record.style = (record.style & ~WS_MINIMIZE) >>> 0;
        }
        /** The sent messages so far, for the result to wait on. */
        let told = greeting;
        if (!hide && !SHOW_WITHOUT_ACTIVATING.has(cmdShow) && !isChild(record))
        {
            told = andThen(greeting, ()=>activate(record.hwnd,
                { thread: host.callerThread?.() }));
            raise(record);
        }
        if (!wasVisible && !hide)
        {
            appear(record);
            // A window that becomes visible hears its own size, as the real
            // ShowWindow sends it: the message a program lays itself out by
            // and rasterises every glyph of its text for. Without it a program
            // keeps whatever default it started with, and its text stays
            // scaled for that instead of for its window.
            // After the activation, not beside it: two guest calls started
            // from one host call would run over each other's stack.
            const client = geometry.clientRect(record);
            told = andThen(told, ()=>send(record.hwnd, WM_SIZE, SIZE_RESTORED,
                ((((client.bottom - client.top) & 0xffff) << 16)
                    | ((client.right - client.left) & 0xffff)) >>> 0,
                host.callerThread?.()));
        }
        if (covered)
        {
            uncover(covered);
        }
        // The answer waits for the procedures that were sent to: returning it
        // before they have run is the stack the guest reuses under itself.
        return andThen(told, ()=>wasVisible ? 1 : 0);
    };

    /**
     * The dialog manager's modal loop, once the dialog functions below have
     * made it.
     *
     * @type {((hwnd: number, thread: unknown, first?: import('./dialogs.js').ModalHook)
     *     => Promise<number>) | null}
     */
    let runModal = null;
    // Named, because a message for a window with no procedure of its own is
    // handed to the default procedure in this table by `deliver` above.
    const table = {
        ...paint.table,
        // The focus, the capture and the geometry live with the windows, so
        // the system half answers from them through a view of the host that
        // carries them.
        ...createSystemFunctions({
            host: Object.assign(Object.create(host), {
                focus: focusWindow, setFocus, active: activeWindow, activate,
                capture: ()=>captured, setCapture, releaseCapture,
                send, callProcedure, geometry, windowFromPoint, askedFromPoint, isChild, repaint,
                appear, uncover,
                shown, raise, restack, desktop: desktopWindow,
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
                    if (isChild(record) || live(record.parent))
                    {
                        return record.hwnd;
                    }
                    return live(record.lastActivePopup ?? 0)?.hwnd ?? record.hwnd;
                },
            }),
            live, windows, classes,
        }),
        ...createObjectFunctions({ host, live,
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
                focus: focusWindow, setFocus, send, callProcedure, geometry, children: childrenOf,
                defDlgProc: controls.helpers.dialogProc, markDefault: controls.helpers.markDefault,
                keyDown: (/** @type {number} */ key)=>
                    ((host.keyState?.(key) ?? 0) & 0x8000) !== 0,
                show: (/** @type {number} */ hwnd)=>{
                    const record = live(hwnd);
                    return record ? showWindow(record, SW_SHOW) : 0;
                },
                translate,
                take: (/** @type {unknown} */ thread)=>takeThrough(
                    { hwnd: ANY_WINDOW, first: 0, last: 0, remove: true }, thread),
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

        /** BOOL UnregisterClassA(LPCSTR lpClassName, HINSTANCE hInstance) */
        UnregisterClassA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([className])=>{
                const cls = classOf(className);
                if (!cls)
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
            },
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

        /** BOOL DestroyWindow(HWND hWnd) */
        DestroyWindow: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>destroyWindow(hwnd),
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

        /** BOOL IsWindow(HWND hWnd) */
        IsWindow: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>(live(hwnd) ? 1 : 0),
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

        /** BOOL MoveWindow(HWND, int X, int Y, int nWidth, int nHeight, BOOL bRepaint) */
        MoveWindow: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([hwnd, x, y, width, height])=>{
                const record = live(hwnd);
                if (!record)
                {
                    return 0;
                }
                const covered = shown(record) ? geometry.windowRect(record) : null;
                record.x = x | 0;
                record.y = y | 0;
                record.width = width | 0;
                record.height = height | 0;
                if (covered)
                {
                    uncover(covered);
                    appear(record);
                }
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
                // the message.
                const record = live(hwnd);
                if (!record)
                {
                    return 0;
                }
                return andThen(send(record.hwnd, WM_SETTEXT, 0, string >>> 0,
                    host.callerThread?.()), ()=>1);
            },
        },

        /**
         * BOOL SetWindowTextW(HWND hWnd, LPCWSTR lpString)
         *
         * Every window here is an ANSI one, so the text reaches it as a
         * wide caller's message reaches an ANSI window on Windows: converted
         * to the ANSI page, in guest memory for as long as WM_SETTEXT takes.
         */
        SetWindowTextW: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, string])=>asAnsi(string,
                text=>table.SetWindowTextA.handler([hwnd, text])),
        },

        /** BOOL SetDlgItemTextW(HWND hDlg, int nIDDlgItem, LPCWSTR lpString) */
        SetDlgItemTextW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([dialog, id, string])=>asAnsi(string,
                text=>table.SetDlgItemTextA.handler([dialog, id, text])),
        },

        /** int GetWindowTextA(HWND hWnd, LPSTR lpString, int nMaxCount) */
        GetWindowTextA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hwnd, out, maxCount])=>{
                const record = live(hwnd);
                const room = maxCount | 0;
                if (!record || room <= 0)
                {
                    return 0;
                }
                // nMaxCount counts the terminator, and the returned length does
                // not: the two numbers differ by one, which is the classic way
                // to lose the last character of a title.
                const text = record.title.slice(0, room - 1);
                writeString(out, text);
                return text.length;
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

        /**
         * HHOOK SetWindowsHookExA(int idHook, HOOKPROC lpfn, HINSTANCE hmod,
         *                         DWORD dwThreadId)
         *
         * Every type is accepted, because a program installs its hooks at
         * start-up and treats a refusal as fatal; only a CBT hook is ever
         * called, and the others say so once rather than failing silently.
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
                if (hook.type !== WH_CBT)
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

        /** BOOL PostMessageA(HWND hWnd, UINT Msg, WPARAM wParam, LPARAM lParam) */
        PostMessageA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([hwnd, message, wParam, lParam])=>{
                const target = hwnd >>> 0;
                // A message for a window that no longer exists has nowhere to be
                // delivered, and the guest is told so rather than finding out
                // when it dispatches.
                if (target !== 0 && !live(target))
                {
                    return 0;
                }
                host.queue.post({ hwnd: target, message, wParam, lParam });
                return 1;
            },
        },

        /**
         * BOOL SendNotifyMessageA(HWND hWnd, UINT Msg, WPARAM wParam, LPARAM lParam)
         *
         * Like SendMessage to another thread's window and like PostMessage to
         * one's own: it does not wait for the window procedure to answer. There
         * is one message loop here, so it posts and returns at once -- the
         * window sees the message when it next pumps, which is what a sender
         * that did not want to block asked for. Declared with its four
         * arguments so an installer that fires one off does not lose four bytes
         * of stack to it.
         */
        SendNotifyMessageA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([hwnd, message, wParam, lParam])=>{
                const target = hwnd >>> 0;
                if (target !== 0 && !live(target))
                {
                    return 0;
                }
                host.queue.post({ hwnd: target, message, wParam, lParam });
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
            handler: ([thread, message, wParam, lParam])=>{
                const id = thread >>> 0;
                const known = host.threadExists ? host.threadExists(id) : id !== 0;
                if (!known)
                {
                    host.setLastError?.(ERROR_INVALID_THREAD_ID);
                    return 0;
                }
                host.queue.post({ hwnd: 0, message, wParam, lParam });
                return 1;
            },
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
                const { inQueue, changed } = host.queue.status();
                return (((inQueue & mask) << 16) | (changed & mask)) >>> 0;
            },
        },

        /** VOID PostQuitMessage(int nExitCode) */
        PostQuitMessage: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([code])=>{
                host.queue.postQuit(code | 0);
                return 0; // void: the guest reads nothing back
            },
        },

        /** BOOL PeekMessageA(LPMSG, HWND, UINT wMsgFilterMin, UINT wMsgFilterMax, UINT wRemoveMsg) */
        PeekMessageA: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([out, hwnd, filterMin, filterMax, removeFlag])=>{
                const remove = (removeFlag & PM_REMOVE) !== 0;
                const filter = { hwnd: windowFilter(hwnd), first: filterMin >>> 0,
                    last: filterMax >>> 0, remove };
                const thread = host.callerThread?.();
                // Only a message taken activates: a look leaves the press,
                // and the activation, for the call that takes it.
                const entry = remove ? takeThrough(filter, thread)
                    : andThen(placeWaiting(filter, thread), ()=>host.queue.peek(filter));
                return andThen(entry, (/** @type {any} */ taken)=>{
                    if (!taken)
                    {
                        return 0;
                    }
                    writeMessage(host, out, taken);
                    return 1;
                });
            },
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
         * waitable timer. A thread, a process or a mutex, whose answer
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
                const input = ()=>((inputAvailable ? host.queue.waiting() : host.queue.news())
                    & mask) !== 0;
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
            handler: ([out, hwnd, filterMin, filterMax])=>{
                const filter = windowFilter(hwnd);
                if (filter !== ANY_WINDOW && filter !== 0 && !windows.has(filter))
                {
                    // The documented failure is -1, which is why a loop written
                    // as `while (GetMessage(...))` spins forever on it.
                    return -1;
                }
                const wanted = { hwnd: filter, first: filterMin >>> 0, last: filterMax >>> 0,
                    remove: true };
                const thread = host.callerThread?.();
                const next = ()=>takeThrough(wanted, thread);
                /** @param {any} entry */
                const answer = entry=>{
                    writeMessage(host, out, entry);
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
            },
        },

        /**
         * BOOL WaitMessage(void)
         *
         * Yields until the queue has something to retrieve -- a posted
         * message, a window to paint, a due timer, a quit -- and answers
         * without taking it. A pump written as peek-then-wait spins without
         * this, which from outside is a program at full speed doing nothing.
         */
        WaitMessage: {
            argBytes: 0,
            handler: ()=>{
                const look = ()=>host.queue.peek({
                    hwnd: ANY_WINDOW, first: 0, last: 0, remove: false,
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
                const listed = [...windows.values()]
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

        /** LRESULT DispatchMessageA(const MSG *lpMsg) */
        DispatchMessageA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([msg])=>deliver(readMessage(host, msg)),
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
    };
    return table;
}
