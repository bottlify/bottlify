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
import { createPaintFunctions } from './paint.js';
import { createSystemFunctions } from './system.js';
import { createObjectFunctions } from './objects.js';
import { createDialogFunctions } from './dialogs.js';
import {
    WNDCLASSA,
    WNDCLASSEXA,
    readMessage,
    readU32,
    readWindowClass,
    writeMessage,
    writeRect,
    writeWindowClassA,
} from './structs.js';

/** Messages this layer has an opinion about. */
const WM_DESTROY = 0x0002;
const WM_NCCREATE = 0x0081;
const WM_CREATE = 0x0001;
const WM_CLOSE = 0x0010;
const WM_KEYDOWN = 0x0100;
const WM_KEYUP = 0x0101;
const WM_CHAR = 0x0102;
const WM_SYSKEYDOWN = 0x0104;
const WM_SYSKEYUP = 0x0105;
const WM_SYSCHAR = 0x0106;

/** TranslateMessage answers for exactly these, translated or not. */
const KEY_MESSAGES = new Set([WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP]);

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

/** PeekMessage takes this where a window goes to mean "thread messages only". */
const HWND_THREAD_MESSAGES = 0xffffffff;

/** Class atoms come from the range Windows reserves for dynamic atoms. */
const FIRST_ATOM = 0xc000;
const LAST_ATOM = 0xffff;

/** Windows caps a class name here, and a name is the only thing we scan for. */
const MAX_CLASS_NAME = 256;

/** Nothing bounds a window title, so something has to. */
const MAX_WINDOW_TEXT = 1 << 16;

/**
 * Virtual keys whose code is the character they produce. The control keys
 * inherited their VK numbers from ASCII, so the mapping is the identity rather
 * than a table.
 */
const SELF_ENCODING_KEYS = new Set([0x08, 0x09, 0x0d, 0x1b, 0x20]);

/**
 * The character an unmodified key press produces.
 *
 * There is no keyboard state to consult: shift, caps lock and the layout belong
 * to the input layer. So a letter key yields its lowercase form, which is what
 * pressing it alone does, and anything that needs a modifier yields nothing.
 *
 * @param {number} key  A virtual-key code.
 * @returns {number | null}
 */
function characterFor(key){
    if (key >= 0x41 && key <= 0x5a)
    {
        return key + 0x20;
    }
    if (key >= 0x30 && key <= 0x39)
    {
        return key;
    }
    return SELF_ENCODING_KEYS.has(key) ? key : null;
}

/**
 * @typedef {Object} DispatchedMessage
 * @property {number} hwnd
 * @property {number} message
 * @property {number} wParam
 * @property {number} lParam
 */

/**
 * @typedef {Object} WindowHost
 * @property {{ width: number, height: number, bitsPerPixel: number }} [screen]
 *           The display every system metric is derived from.
 * @property {() => any} [dc]
 *           The device-context service painting takes its DCs from.
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {{ open: (type: string, object: any) => number,
 *              close: (handle: number) => any }} handles
 * @property {ReturnType<typeof import('./messages.js').createMessageQueue>} queue
 *           Where messages come from, including the ones the input layer posts.
 * @property {(wndProc: number, message: DispatchedMessage) => number} dispatch
 *           Runs a window procedure. One line from being the bridge's callback.
 * @property {() => any} park   Stops the caller; returns the parked token.
 * @property {(instance: number, id: number) => string | null} [loadString]
 *           A string out of a module's resources. Absent in a build with no
 *           loader behind it, which answers as a module with no string table.
 * @property {(hwnd: number) => void} [created]
 *           A window now exists. Whoever delivers input needs to know.
 * @property {(bytes: number) => number} [allocate]
 *           Guest memory for a CREATESTRUCT. Absent in a build with no heap,
 *           and then a window is made without telling its procedure -- which
 *           is what this used to do always.
 * @property {(address: number) => void} [release]
 * @property {() => Promise<void>} idle
 * @property {() => { x: number, y: number }} [cursor]
 *           Where the pointer is. Absent in a build with no input, and then
 *           the answer is the origin.
 * @property {(key: number) => number} [keyState]
 *           Whether a virtual key is down, as GetAsyncKeyState reports it:
 *           the high bit set while it is held. Absent means nothing is
 *           pressed, which is the one safe wrong answer.
 *           Resolves when the machine has taken another turn, so a call that is
 *           waiting for something to arrive can look again.
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
        return name === undefined ? null : classes.get(name) ?? null;
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

    /** @param {number} hwnd @returns {any | null} */
    const live = hwnd=>{
        const record = windows.get(hwnd >>> 0);
        return record && !record.destroyed ? record : null;
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

    /** @param {number} address  Where a NUL-terminated string goes. @param {string} text */
    const writeString = (address, text)=>{
        const bytes = new Uint8Array(text.length + 1);
        for (let index = 0; index < text.length; index++)
        {
            bytes[index] = text.charCodeAt(index) & 0xff;
        }
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
     * @param {number} hwnd
     * @returns {number} 1 when there was a window to destroy
     */
    const destroyWindow = hwnd=>{
        const record = live(hwnd);
        if (!record)
        {
            return 0;
        }
        host.queue.purge(record.hwnd);
        // Its timers go with it. Windows destroys them, and one left behind
        // would go on making WM_TIMER for a window that no longer exists.
        host.queue.killTimersFor?.(record.hwnd);
        // Windows *sends* WM_DESTROY, which means running the window procedure
        // before this call returns, and that road goes through the bridge.
        // Queuing it preserves the order the program observes and keeps the
        // procedure reachable, which is why the record outlives the handle.
        host.queue.post({ hwnd: record.hwnd, message: WM_DESTROY, wParam: 0, lParam: 0 });
        record.destroyed = true;
        host.handles.close(record.hwnd);

        for (const child of windows.values())
        {
            if (child.parent === record.hwnd && !child.destroyed)
            {
                destroyWindow(child.hwnd);
            }
        }
        return 1;
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
            ...fields,
        };
        record.hwnd = host.handles.open('window', record);
        windows.set(record.hwnd, record);
        return record;
    };

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
            parent: parent >>> 0,
            instance: instance >>> 0,
            // For a child window hMenu is its control id; for a top-level one it
            // is a menu handle, which the menu bookkeeping hangs on to.
            id: parent === 0 ? 0 : menu >>> 0,
            menu: parent === 0 ? menu >>> 0 : 0,
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
        if (!host.allocate || record.wndProc === 0)
        {
            return record.hwnd;
        }
        const create = host.allocate(CREATESTRUCTA.SIZE);
        if (create === 0)
        {
            return record.hwnd;
        }
        const bytes = new Uint8Array(CREATESTRUCTA.SIZE);
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
        host.writeMemory(create, bytes);
        void width;
        void height;
        void x;
        void y;

        /** @param {number} message */
        const send = message=>host.dispatch(record.wndProc, {
            hwnd: record.hwnd, message, wParam: 0, lParam: create,
        });
        /** @param {any} value @param {(answer: number) => any} then */
        const after = (value, then)=>(typeof value?.then === 'function'
            ? value.then(then)
            : then(value));
        /** @param {number} handle */
        const done = handle=>{
            host.release?.(create);
            return handle;
        };

        // Only WM_CREATE, and deliberately: sending is running guest code, and
        // running it twice in a row from one host call means the second starts
        // while the first is still unwinding. WM_NCCREATE is the message a
        // procedure is least likely to need -- its default answer is TRUE and
        // the structure it carries arrives again a moment later with
        // WM_CREATE -- so it is the one to leave out until a program is seen to
        // want it and the bridge can send two.
        return after(send(WM_CREATE), created=>{
            if ((created | 0) === -1)
            {
                destroyWindow(record.hwnd);
                return done(0);
            }
            return done(record.hwnd);
        });
    };

    // user32 is one table to the guest and five files only because the subjects
    // are: windows and classes here, painting and its device contexts next
    // door, what a program asks the system about itself after that, the things
    // a window owns, and dialogs. They share the window records rather than
    // each keeping a copy, which is why they are built here.
    return {
        ...createPaintFunctions({ host, live, queue: host.queue, WM_PAINT }),
        ...createSystemFunctions({ host, live, windows, classes }),
        ...createObjectFunctions({ host, live }),
        ...createDialogFunctions({ host, live, windows, makeWindow, destroyWindow }),

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
         * lpParam is what WM_NCCREATE and WM_CREATE carry, and both of those are
         * calls into the window procedure, so it goes nowhere yet.
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
                if (!record)
                {
                    return 0;
                }
                const wasVisible = (record.style & WS_VISIBLE) !== 0;
                record.style = (cmdShow | 0) === SW_HIDE
                    ? (record.style & ~WS_VISIBLE) >>> 0
                    : (record.style | WS_VISIBLE) >>> 0;
                // The documented answer is the state it found, not the one it
                // set: code that toggles a window reads this back.
                return wasVisible ? 1 : 0;
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
                // No non-client frame is modelled, so the client area is the
                // whole window. Borders and captions arrive with the metrics
                // that decide how wide they are.
                writeRect(host, out, {
                    left: 0, top: 0, right: record.width, bottom: record.height,
                });
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
                writeRect(host, out, {
                    left: record.x,
                    top: record.y,
                    right: record.x + record.width,
                    bottom: record.y + record.height,
                });
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
                record.x = x | 0;
                record.y = y | 0;
                record.width = width | 0;
                record.height = height | 0;
                return 1;
            },
        },

        /** BOOL SetWindowTextA(HWND hWnd, LPCSTR lpString) */
        SetWindowTextA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, string])=>{
                const record = live(hwnd);
                if (!record)
                {
                    return 0;
                }
                record.title = (string >>> 0) === 0
                    ? ''
                    : host.readCString(string, MAX_WINDOW_TEXT);
                return 1;
            },
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
                const entry = host.queue.peek({
                    hwnd: windowFilter(hwnd),
                    first: filterMin >>> 0,
                    last: filterMax >>> 0,
                    remove: (removeFlag & PM_REMOVE) !== 0,
                });
                if (!entry)
                {
                    return 0;
                }
                writeMessage(host, out, entry);
                return 1;
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
                const take = ()=>host.queue.peek({
                    hwnd: filter,
                    first: filterMin >>> 0,
                    last: filterMax >>> 0,
                    remove: true,
                });

                let entry = take();
                if (!entry)
                {
                    // GetMessage waits; it does not report an empty queue. The
                    // wait is the host's to hold, so the answer is a promise and
                    // the bridge suspends the caller until something arrives.
                    return (async()=>{
                        while (!entry)
                        {
                            await host.idle();
                            entry = take();
                        }
                        writeMessage(host, out, entry);
                        return entry.message === WM_QUIT ? 0 : 1;
                    })();
                }
                writeMessage(host, out, entry);
                return entry.message === WM_QUIT ? 0 : 1;
            },
        },

        /** BOOL TranslateMessage(const MSG *lpMsg) */
        TranslateMessage: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([msg])=>{
                const message = readMessage(host, msg);
                if (!KEY_MESSAGES.has(message.message))
                {
                    return 0;
                }
                const isDown = message.message === WM_KEYDOWN
                    || message.message === WM_SYSKEYDOWN;
                const character = isDown ? characterFor(message.wParam) : null;
                if (character !== null)
                {
                    host.queue.post({
                        hwnd: message.hwnd,
                        message: message.message === WM_SYSKEYDOWN ? WM_SYSCHAR : WM_CHAR,
                        wParam: character,
                        lParam: message.lParam,
                    });
                }
                // Documented as nonzero for any of the four key messages,
                // whether or not a character came of it.
                return 1;
            },
        },

        /** LRESULT DispatchMessageA(const MSG *lpMsg) */
        DispatchMessageA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([msg])=>{
                const message = readMessage(host, msg);
                // A timer that named a TIMERPROC is called instead of the
                // window procedure, and that is the whole reason a timer may
                // have no window at all: the procedure is where it goes.
                if (message.message === WM_TIMER && message.lParam !== 0)
                {
                    return host.dispatch(message.lParam >>> 0, {
                        ...message,
                        // A TIMERPROC takes the tick count where a window
                        // procedure takes the lParam.
                        lParam: /** @type {any} */ (message).time ?? 0,
                    });
                }
                // Not `live`: a WM_DESTROY still has to reach the procedure of
                // the window it is telling about its own end.
                const record = windows.get(message.hwnd);
                if (!record)
                {
                    return 0;
                }
                // Whatever the host gives back is the answer, including a
                // promise: running a window procedure means running guest code,
                // and the bridge suspends this call until it returns.
                return host.dispatch(record.wndProc, message);
            },
        },

        /** LRESULT DefWindowProcA(HWND hWnd, UINT Msg, WPARAM wParam, LPARAM lParam) */
        DefWindowProcA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([hwnd, message])=>{
                switch (message >>> 0){
                    // TRUE, and it has to be: a procedure that does not handle
                    // WM_NCCREATE passes it here, and answering FALSE would
                    // refuse every window such a program tries to make.
                    case WM_NCCREATE:
                        return 1;
                    case WM_CLOSE:
                        destroyWindow(hwnd);
                        return 0;
                    // WM_DESTROY is deliberately not handled, and that is the
                    // whole of it: Windows' default procedure does nothing with
                    // it. Ending the message loop is the program's own
                    // decision, made by calling PostQuitMessage from the window
                    // procedure of the one window it considers its main one.
                    //
                    // Posting a quit here instead looks harmless and is not. A
                    // program of any size destroys windows all the time -- a
                    // dialog, a tooltip, a splash screen -- and passes their
                    // WM_DESTROY to the default procedure because it has
                    // nothing to add. Every one of those then ends the process:
                    // a real title was measured closing an auxiliary window
                    // after loading its textures, and shutting itself down
                    // cleanly and inexplicably a moment later.
                    default:
                        return 0;
                }
            },
        },
    };
}
