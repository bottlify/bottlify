/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The windows of a whole run, as the system half of user32 knows them.
 *
 * A window handle is the system's, not a process's: a program finds another
 * program's window by its class or title, asks which process made it, and
 * posts to it, and the handle it holds means the same window to every
 * process. So the numbers are handed out here, once per run, and every
 * question about a window another process made goes to that process, which
 * answers with values: what crosses is numbers and strings, never the
 * window's record, so the same calls can later be carried over a ring to a
 * process in a worker of its own.
 *
 * Window handles are numbers a kernel handle never is -- kernel handles are
 * multiples of four, these are two more than one -- so neither table can
 * hand out a number the other already did, in any process.
 */

import { WINDOW_CELLS, createWindowManager, windowCells } from './manager.js';

/**
 * The first number a name registered with RegisterWindowMessage or
 * RegisterClipboardFormat is given: the range Windows keeps for them.
 */
const REGISTERED_FIRST = 0xc000;

/** Where a message goes to every top-level window, of every process. */
export const HWND_BROADCAST = 0xffff;

/** The desktop, the one window every process shares. */
export const DESKTOP_WINDOW = 0x00010012;
const FIRST_WINDOW = DESKTOP_WINDOW + 4;
const WINDOW_STRIDE = 4;

/**
 * What a process answers about its own windows.
 *
 * @typedef {Object} WindowEndpoint
 * @property {(parent: number, after: number, className: string | null,
 *     title: string | null) => number} find
 *     The first of its windows under `parent`, after `after` (zero: from the
 *     first) in creation order, whose class and title match, compared
 *     without regard to case; null matches any. Zero for none.
 * @property {(hwnd: number) => WindowDescription | null} describe
 *     A live window of this process, or null.
 * @property {(hwnd: number, message: number, wParam: number, lParam: number) => boolean} post
 *     Posts into the queue of the thread that made the window.
 * @property {(hwnd: number, request: SentRequest) => number | null} send
 *     Puts a message sent from another process in front of the thread that
 *     made the window, as one sent from another thread of its own: a number
 *     to ask for the answer by, or null for a window that is not there.
 * @property {(id: number) => SentAnswer | null} answer
 *     Where a sent message stands; null once its window is gone unanswered.
 *     An answer is handed out once.
 * @property {(id: number) => void} withdraw
 *     A sender that stopped waiting: the message is not delivered if it has
 *     not been yet.
 * @property {(hwnd: number, fromHwnd: number, fromThread: number) => boolean} [activate]
 *     Another process made this one's window the foreground window: it is
 *     activated on the thread that made it, told which window and thread had
 *     the foreground. False for a window that is not there.
 * @property {(gained: number, thread: number, hadFocus: number) => void} [lostForeground]
 *     Another process's window, `gained`, of thread `thread`, is the run's
 *     foreground window now: this process's active window is told it is not.
 */

/**
 * A message another process sent, in values: what its pointers pointed at
 * travels as bytes, and the receiving process puts them in its own memory.
 *
 * @typedef {Object} SentRequest
 * @property {number} message
 * @property {number} wParam
 * @property {number} lParam
 * @property {boolean} unicode  Whether the text it carries is wide.
 * @property {boolean} wait     False for a notification, which nobody waits on.
 * @property {{ kind: 'copydata', data: number, bytes: Uint8Array }
 *     | { kind: 'text', bytes: Uint8Array }
 *     | { kind: 'room', bytes: number } | null} carried
 *     WM_COPYDATA's block; the text WM_SETTEXT and its kind carry, terminated;
 *     the buffer WM_GETTEXT and its kind fill, by its size.
 */

/**
 * @typedef {Object} SentAnswer
 * @property {boolean} replied
 * @property {number} [result]
 * @property {Uint8Array} [bytes]  What the procedure wrote into a buffer it was lent.
 */

/**
 * @typedef {Object} WindowDescription
 * @property {number} threadId
 * @property {string} className
 * @property {string} title
 */

/**
 * @param {Object} [options]
 * @param {Int32Array} [options.cells]  where the run's foreground window, focus
 *     and captured window are kept (`manager.js`), every process reading them
 */
export function createWindowDirectory({ cells = windowCells() } = {}){
    let next = FIRST_WINDOW;
    /** The run's windows as their processes tell them, and their order (`manager.js`). */
    const manager = createWindowManager({ cells });
    /** Each window's process, by handle. @type {Map<number, number>} */
    const owners = new Map();
    /** Each process that can have windows, in the order it started. @type {Map<number, WindowEndpoint>} */
    const endpoints = new Map();
    /** Processes that run nothing now, and so answer nothing. @type {Set<number>} */
    const held = new Set();
    /** Registered names, folded, and their numbers. @type {Map<string, number>} */
    const registered = new Map();
    /** Each registered number's name as it was first spelled. @type {Map<number, string>} */
    const spelled = new Map();

    /** @param {number} hwnd */
    const endpointOf = hwnd=>{
        const owner = owners.get(hwnd >>> 0);
        return owner === undefined ? null : { owner, endpoint: endpoints.get(owner) ?? null };
    };

    return {
        /**
         * A process's way of answering for its windows, until it ends.
         *
         * @param {number} processId @param {WindowEndpoint} endpoint
         */
        attach(processId, endpoint){
            endpoints.set(processId >>> 0, endpoint);
        },

        /**
         * A process that ended: its windows are gone with it, and their
         * handles name nothing.
         *
         * @param {number} processId
         */
        detach(processId){
            endpoints.delete(processId >>> 0);
            for (const [hwnd, owner] of owners)
            {
                if (owner === (processId >>> 0))
                {
                    owners.delete(hwnd);
                }
            }
            manager.removeProcess(processId >>> 0);
        },

        /**
         * A handle for a new window of a process.
         *
         * @param {number} processId @returns {number}
         */
        open(processId){
            const hwnd = next;
            next += WINDOW_STRIDE;
            owners.set(hwnd, processId >>> 0);
            return hwnd;
        },

        /** @param {number} hwnd */
        close(hwnd){
            owners.delete(hwnd >>> 0);
            manager.remove(hwnd >>> 0);
        },

        // What a process tells the run of its windows, and what only the run
        // knows of them (`manager.js`); a view reads `manager` itself.
        manager,
        /**
         * The run's foreground window, focus and captured window, as words a
         * process reads where they lie rather than a copy it keeps
         * (`WINDOW_CELLS`): handed to a process in a worker of its own.
         */
        cells,
        /** The window with the run's focus, or zero. */
        focus: ()=>Atomics.load(cells, WINDOW_CELLS.focus) >>> 0,
        /** @param {import('./manager.js').WindowState} state */
        publish: state=>manager.publish(state),
        /** @param {number} hwnd */
        raise: hwnd=>manager.raise(hwnd >>> 0),
        /** @param {number} hwnd */
        lower: hwnd=>manager.lower(hwnd >>> 0),
        /** @param {number} hwnd @param {number} after */
        insertAfter: (hwnd, after)=>manager.insertAfter(hwnd >>> 0, after >>> 0),
        /** @param {number} hwnd */
        stateOf: hwnd=>manager.get(hwnd >>> 0),
        topLevel: ()=>manager.topLevel(),
        /** @param {number} x @param {number} y */
        fromPoint: (x, y)=>manager.fromPoint(x, y),
        foreground: ()=>manager.foreground(),

        /**
         * A process's window took the keyboard focus, or the process let it
         * go: the focus is the run's, one for every program, and a window
         * taking it makes its top-level window the foreground one -- the
         * process whose window that was is told so, as `setForeground` tells
         * it. One process letting go does not take another's.
         *
         * @param {number} hwnd  the window, zero to let it go
         * @param {number} processId  the process it is told by
         */
        noteFocus(hwnd, processId){
            if (hwnd !== 0 && !manager.get(hwnd >>> 0))
            {
                // A window the run does not list -- the desktop -- holds no
                // focus: the program's goes, if it had it.
                this.noteFocus(0, processId);
                return;
            }
            if (hwnd !== 0)
            {
                this.setForeground(hwnd);
                manager.setFocus(hwnd >>> 0);
                return;
            }
            const holder = manager.focus();
            if (holder !== 0 && manager.get(holder)?.processId === processId)
            {
                manager.setFocus(0);
            }
        },

        /**
         * A process's window took the mouse, or the process let it go: one
         * process releasing its capture does not take another's.
         *
         * @param {number} hwnd  the window, zero for a release
         * @param {number} processId  the process it is told by
         */
        noteCapture(hwnd, processId){
            if (hwnd !== 0)
            {
                manager.setCapture(hwnd);
                return;
            }
            const holder = manager.capture();
            if (holder !== 0 && manager.get(holder)?.processId === processId)
            {
                manager.releaseCapture();
            }
        },
        /**
         * A process made another's window the foreground window: it is the
         * run's at once, and the process that owns it is asked to activate
         * it, told which window and thread had it.
         *
         * @param {number} hwnd @param {number} asking  the process that asked
         * @returns {boolean} whether the window is another process's that was asked
         */
        foregroundElsewhere(hwnd, asking){
            const owner = owners.get(hwnd >>> 0);
            const endpoint = owner === undefined || owner === (asking >>> 0)
                ? null : endpoints.get(owner);
            if (!endpoint?.activate)
            {
                return false;
            }
            const before = manager.foreground();
            const thread = manager.get(before)?.threadId ?? 0;
            this.setForeground(hwnd);
            return endpoint.activate(hwnd >>> 0, before, thread) !== false;
        },
        /**
         * A process activated one of its windows: it is the run's foreground
         * window, and the process whose window was is told it lost it -- to
         * which window, of which thread -- as Windows tells it.
         *
         * @param {number} hwnd
         */
        setForeground(hwnd){
            const before = manager.foreground();
            const hadFocus = manager.focus();
            manager.setForeground(hwnd >>> 0);
            const after = manager.foreground();
            // Told only when another process's window took it: a program
            // that gave it to the desktop knows already.
            const loser = before === 0 || after === 0 || before === after
                ? undefined : owners.get(before);
            if (loser !== undefined && loser !== owners.get(after))
            {
                endpoints.get(loser)?.lostForeground?.(after, manager.get(after)?.threadId ?? 0,
                    owners.get(hadFocus) === loser ? hadFocus : 0);
            }
        },

        /**
         * The process a window belongs to, or null for a handle that names
         * no window now.
         *
         * @param {number} hwnd @returns {number | null}
         */
        ownerOf: hwnd=>owners.get(hwnd >>> 0) ?? null,

        /**
         * A window of another process than `asking`, described by the process
         * that made it; null when none is.
         *
         * @param {number} hwnd @param {number} asking
         * @returns {(WindowDescription & { processId: number }) | null}
         */
        describe(hwnd, asking){
            const found = endpointOf(hwnd);
            if (!found || found.owner === (asking >>> 0) || !found.endpoint)
            {
                return null;
            }
            const description = found.endpoint.describe(hwnd >>> 0);
            return description ? { ...description, processId: found.owner } : null;
        },

        /**
         * The first window of another process than `asking` that matches, as
         * FindWindowEx walks them: the processes in the order they started,
         * each one's windows in creation order. `after` is a window
         * of another process to go on from, or zero.
         *
         * @param {number} asking @param {number} parent @param {number} after
         * @param {string | null} className @param {string | null} title
         * @returns {number}
         */
        find(asking, parent, after, className, title){
            const from = after === 0 ? null : endpointOf(after);
            if (after !== 0 && !from)
            {
                return 0;
            }
            let reached = from === null;
            for (const [owner, endpoint] of endpoints)
            {
                if (owner === (asking >>> 0))
                {
                    continue;
                }
                if (!reached)
                {
                    if (owner !== from?.owner)
                    {
                        continue;
                    }
                    reached = true;
                    const found = endpoint.find(parent, after, className, title);
                    if (found !== 0)
                    {
                        return found;
                    }
                    continue;
                }
                const found = endpoint.find(parent, 0, className, title);
                if (found !== 0)
                {
                    return found;
                }
            }
            return 0;
        },

        /**
         * The number a registered message or clipboard format has for the
         * run: the same name, in any case, is the same number in every
         * process, which is how two programs that never met agree on one.
         *
         * @param {string} name @returns {number}
         */
        register(name){
            const key = name.toLowerCase();
            let id = registered.get(key);
            if (id === undefined)
            {
                id = REGISTERED_FIRST + registered.size;
                registered.set(key, id);
                spelled.set(id, name);
            }
            return id;
        },

        /**
         * A registered number's name, as it was first spelled; null for a
         * number nobody registered.
         *
         * @param {number} id @returns {string | null}
         */
        registeredName: id=>spelled.get(id >>> 0) ?? null,

        /**
         * Whether a process is held: paused while another runs in its place
         * or beside it, where one process runs at a time. A message sent to
         * it would wait for ever, and is refused instead.
         *
         * @param {number} processId @param {boolean} holding
         */
        hold(processId, holding){
            if (holding)
            {
                held.add(processId >>> 0);
            }
            else
            {
                held.delete(processId >>> 0);
            }
        },

        /**
         * Sends to a window of another process than `asking`. Null when the
         * handle names none, or its process is held; otherwise what the
         * answer is asked for by.
         *
         * @param {number} asking @param {number} hwnd @param {SentRequest} request
         * @returns {{ owner: number, id: number } | null}
         */
        send(asking, hwnd, request){
            const found = endpointOf(hwnd);
            if (!found || found.owner === (asking >>> 0) || !found.endpoint
                || held.has(found.owner))
            {
                return null;
            }
            const id = found.endpoint.send(hwnd >>> 0, request);
            return id === null ? null : { owner: found.owner, id };
        },

        /**
         * @param {{ owner: number, id: number }} sent
         * @returns {SentAnswer | null} null once the window or its process is gone
         */
        answer(sent){
            return endpoints.get(sent.owner)?.answer(sent.id) ?? null;
        },

        /** @param {{ owner: number, id: number }} sent */
        withdraw(sent){
            endpoints.get(sent.owner)?.withdraw(sent.id);
        },

        /**
         * Posts to a window of another process than `asking`: false when the
         * handle names none, or that process's window is gone.
         *
         * @param {number} asking @param {number} hwnd
         * @param {number} message @param {number} wParam @param {number} lParam
         */
        post(asking, hwnd, message, wParam, lParam){
            const found = endpointOf(hwnd);
            if (!found || found.owner === (asking >>> 0) || !found.endpoint)
            {
                return false;
            }
            return found.endpoint.post(hwnd >>> 0, message >>> 0, wParam >>> 0, lParam >>> 0);
        },
    };
}
