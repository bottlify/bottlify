/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The run's window manager (roadmap/v2/windows.md): every window of every
 * process, as its process's user32 tells it, and what only the run can know
 * of them -- the order of top-level windows across processes, the foreground
 * window, the window that has the mouse captured.
 *
 * A process keeps its windows as it always has; it tells the manager what a
 * window is now from the places where it changes one. Whatever shows the
 * windows -- the compositor, the input router, a view of them as the page's
 * own elements -- reads them here and subscribes to their changes, and never
 * reaches into a process.
 *
 * Everything here is values: a state crosses a link as it is.
 */

/**
 * @typedef {{ left: number, top: number, right: number, bottom: number }} Rect
 */

/**
 * What the run knows of a window.
 *
 * @typedef {Object} WindowState
 * @property {number} hwnd
 * @property {number} processId
 * @property {number} threadId
 * @property {number} parent     The window it is inside of (WS_CHILD), or zero.
 * @property {number} owner      The window it is owned by, or zero.
 * @property {string} className
 * @property {string} title
 * @property {number} style
 * @property {number} exStyle
 * @property {Rect} rect         The window, in screen coordinates.
 * @property {Rect} client       Its client area, in screen coordinates.
 * @property {boolean} visible   It and every ancestor have WS_VISIBLE.
 * @property {boolean} enabled
 * @property {boolean} minimized
 * @property {boolean} maximized
 * @property {boolean} topmost   WS_EX_TOPMOST: the band it is ordered in.
 * @property {Rect | null} region  Its window region's bounds, in window coordinates.
 */

/**
 * A change, as a subscriber is told it: what happened, to which window, the
 * window as it now is (none once it is gone), and the revision it made.
 *
 * @typedef {{ kind: 'created' | 'changed' | 'removed' | 'stacked' | 'foreground' | 'focus'
 *     | 'capture', hwnd: number, state: WindowState | null, revision: number }} WindowEvent
 */

/** How many of the last top-level windows made the manager keeps for its report. */
const MADE_KEPT = 32;

/** The fields whose change is a change of the window, in the order they are compared. */
const FIELDS = /** @type {const} */ (['processId', 'threadId', 'parent', 'owner', 'className',
    'title', 'style', 'exStyle', 'rect', 'client', 'visible', 'enabled', 'minimized', 'maximized',
    'topmost', 'region']);

/** @param {Rect | null} a @param {Rect | null} b */
const sameRect = (a, b)=>(a === b || (a !== null && b !== null && a.left === b.left
    && a.top === b.top && a.right === b.right && a.bottom === b.bottom));

/** @param {WindowState} a @param {WindowState} b */
const sameState = (a, b)=>FIELDS.every(field=>(field === 'rect' || field === 'client'
    || field === 'region'
    ? sameRect(/** @type {any} */ (a[field]), /** @type {any} */ (b[field]))
    : a[field] === b[field]));

/** @param {WindowState} state @returns {WindowState} */
const frozen = state=>Object.freeze({
    ...state,
    rect: Object.freeze({ ...state.rect }),
    client: Object.freeze({ ...state.client }),
    region: state.region ? Object.freeze({ ...state.region }) : null,
});

/**
 * Where the run's foreground window, focus and captured window are kept: one
 * word each, in memory every process can read where the run has shared
 * memory. A window is the foreground one, has the focus or holds the mouse
 * when the word says it -- no process keeps a copy to go stale.
 */
export const WINDOW_CELLS = Object.freeze({ foreground: 0, focus: 1, capture: 2, length: 3 });

/**
 * The words of `WINDOW_CELLS`, where the run keeps them: shared, so a process
 * in a worker of its own reads them, where there is shared memory.
 *
 * @returns {Int32Array}
 */
export function windowCells(){
    const bytes = WINDOW_CELLS.length * 4;
    return new Int32Array(typeof SharedArrayBuffer === 'function'
        ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes));
}

/**
 * @param {Object} [options]
 * @param {Int32Array} [options.cells]  where the foreground window, the focus
 *     and the captured window are kept (`windowCells`)
 */
export function createWindowManager({ cells = windowCells() } = {}){
    /** @type {Map<number, WindowState>} */
    const windows = new Map();
    /** The top-level windows, bottom to top. @type {number[]} */
    let order = [];
    /** @param {number} at @returns {number} */
    const cell = at=>Atomics.load(cells, at) >>> 0;
    /** @param {number} at @param {number} hwnd */
    const put = (at, hwnd)=>{
        Atomics.store(cells, at, hwnd | 0);
    };
    // The window the keyboard goes to -- the foreground window or one inside
    // it, or none -- is one for the run, as Windows has one: a window that
    // takes it takes it from every other.
    /** Where the page's pointer was last, on the screen. */
    const pointer = { x: 0, y: 0 };
    let revision = 0;
    /** @type {Set<(event: WindowEvent) => void>} */
    const listeners = new Set();
    /**
     * The last top-level windows made, oldest first (`MADE_KEPT`): which
     * process made which, for a report that comes after they are gone.
     *
     * @type {{ hwnd: number, process: number, className: string }[]}
     */
    const made = [];

    /**
     * @param {WindowEvent['kind']} kind @param {number} hwnd
     */
    const emit = (kind, hwnd)=>{
        revision++;
        const event = Object.freeze({ kind, hwnd, state: windows.get(hwnd) ?? null, revision });
        for (const listener of listeners)
        {
            listener(event);
        }
    };

    /** The top-level window a window is in. @param {number} hwnd */
    const topLevelOf = hwnd=>{
        let state = windows.get(hwnd);
        while (state && state.parent !== 0)
        {
            state = windows.get(state.parent);
        }
        return state?.hwnd ?? 0;
    };

    /**
     * Puts the order in its bands and its owners right: topmost windows above
     * the rest, and an owned window above its owner, everything else as it
     * stood. Windows does the same after any move in the order. A window
     * owned by a topmost one is in the topmost band with it, as SetWindowPos
     * says of a window made topmost: "all of its owned windows are also made
     * topmost" -- a modal dialog of a topmost window is above it, not under.
     */
    const settle = ()=>{
        /** @param {number} hwnd @returns {number} */
        const band = hwnd=>{
            for (let at = windows.get(hwnd), depth = 0; at && depth < 64; depth++)
            {
                if (at.topmost)
                {
                    return 1;
                }
                at = at.owner ? windows.get(at.owner) : undefined;
            }
            return 0;
        };
        const banded = [...order.filter(hwnd=>band(hwnd) === 0),
            ...order.filter(hwnd=>band(hwnd) === 1)];
        // An owned window below its owner goes to just above it -- its own
        // owned windows with it, as they follow it.
        for (let moved = true, rounds = 0; moved && rounds < banded.length; rounds++)
        {
            moved = false;
            for (let i = 0; i < banded.length; i++)
            {
                const owner = windows.get(banded[i])?.owner ?? 0;
                const at = owner === 0 ? -1 : banded.indexOf(owner);
                if (at > i && band(owner) === band(banded[i]))
                {
                    const [hwnd] = banded.splice(i, 1);
                    banded.splice(at, 0, hwnd);
                    moved = true;
                    break;
                }
            }
        }
        order = banded;
    };

    /** A window's owned windows, the ones they own after them. @param {number} hwnd */
    const ownedBy = hwnd=>{
        /** @type {number[]} */
        const found = [];
        for (const each of order)
        {
            if (windows.get(each)?.owner === hwnd)
            {
                found.push(each, ...ownedBy(each));
            }
        }
        return found;
    };

    /**
     * Moves a top-level window, and what it owns, to `index` in the order of
     * the others.
     *
     * @param {number} hwnd @param {(rest: number[]) => number} where
     */
    const move = (hwnd, where)=>{
        const top = topLevelOf(hwnd);
        if (top === 0)
        {
            return;
        }
        const group = [top, ...ownedBy(top).filter(each=>each !== top)];
        const rest = order.filter(each=>!group.includes(each));
        const at = Math.max(0, Math.min(rest.length, where(rest)));
        const before = order.join();
        order = [...rest.slice(0, at), ...group, ...rest.slice(at)];
        settle();
        if (order.join() !== before)
        {
            emit('stacked', top);
        }
    };

    /** @param {Rect} rect @param {number} x @param {number} y */
    const inside = (rect, x, y)=>x >= rect.left && x < rect.right && y >= rect.top
        && y < rect.bottom;

    const manager = {
        /**
         * What a process tells of one of its windows. A window not known
         * before comes in at the top of the order, as a new window does.
         *
         * @param {WindowState} state
         */
        publish(state){
            const had = windows.get(state.hwnd);
            if (had && sameState(had, state))
            {
                return;
            }
            windows.set(state.hwnd, frozen(state));
            const listed = order.includes(state.hwnd);
            if (state.parent === 0 && !listed)
            {
                order.push(state.hwnd);
            }
            if (!had && state.parent === 0)
            {
                made.push({ hwnd: state.hwnd, process: state.processId,
                    className: state.className });
                if (made.length > MADE_KEPT)
                {
                    made.shift();
                }
            }
            else if (state.parent !== 0 && listed)
            {
                order = order.filter(each=>each !== state.hwnd);
            }
            settle();
            emit(had ? 'changed' : 'created', state.hwnd);
        },

        /** A window that is gone. @param {number} hwnd */
        remove(hwnd){
            if (!windows.has(hwnd))
            {
                return;
            }
            windows.delete(hwnd);
            order = order.filter(each=>each !== hwnd);
            if (cell(WINDOW_CELLS.foreground) === hwnd)
            {
                put(WINDOW_CELLS.foreground, 0);
            }
            const focus = cell(WINDOW_CELLS.focus);
            if (focus === hwnd || (focus !== 0 && topLevelOf(focus) === 0))
            {
                put(WINDOW_CELLS.focus, 0);
            }
            if (cell(WINDOW_CELLS.capture) === hwnd)
            {
                put(WINDOW_CELLS.capture, 0);
            }
            emit('removed', hwnd);
        },

        /** Every window of a process that is gone. @param {number} processId */
        removeProcess(processId){
            for (const [hwnd, state] of [...windows])
            {
                if (state.processId === processId)
                {
                    manager.remove(hwnd);
                }
            }
        },

        /** To the top of its band. @param {number} hwnd */
        raise: (/** @type {number} */ hwnd)=>move(hwnd, rest=>rest.length),
        /** To the bottom of its band. @param {number} hwnd */
        lower: (/** @type {number} */ hwnd)=>move(hwnd, ()=>0),
        /**
         * Just below `after`, as SetWindowPos's hWndInsertAfter places it.
         *
         * @param {number} hwnd @param {number} after
         */
        insertAfter: (hwnd, after)=>move(hwnd, rest=>{
            const at = rest.indexOf(topLevelOf(after));
            return at < 0 ? rest.length : at;
        }),

        /**
         * A window is made the foreground one: one that was not comes to the
         * top of its band, as an activated window does, and a focus in
         * another window goes -- the new one's process places it in its
         * window.
         *
         * @param {number} hwnd
         */
        setForeground(hwnd){
            const top = hwnd === 0 ? 0 : topLevelOf(hwnd);
            if (top !== 0 && top !== cell(WINDOW_CELLS.foreground))
            {
                manager.raise(top);
            }
            const focus = cell(WINDOW_CELLS.focus);
            if (focus !== 0 && topLevelOf(focus) !== top)
            {
                put(WINDOW_CELLS.focus, 0);
                emit('focus', 0);
            }
            if (top !== cell(WINDOW_CELLS.foreground))
            {
                put(WINDOW_CELLS.foreground, top);
                emit('foreground', top);
            }
        },
        foreground: ()=>cell(WINDOW_CELLS.foreground),

        /**
         * A window takes the keyboard: its top-level window becomes the
         * foreground one -- coming up, if it was not -- and every other
         * window has lost it.
         * Zero takes it from every window, the foreground one staying so.
         *
         * @param {number} hwnd
         */
        setFocus(hwnd){
            if (hwnd !== 0 && !windows.has(hwnd))
            {
                return;
            }
            if (hwnd !== 0)
            {
                manager.setForeground(hwnd);
            }
            if (hwnd !== cell(WINDOW_CELLS.focus))
            {
                put(WINDOW_CELLS.focus, hwnd);
                emit('focus', hwnd);
            }
        },
        focus: ()=>cell(WINDOW_CELLS.focus),

        /** @param {number} hwnd */
        setCapture(hwnd){
            if (hwnd !== cell(WINDOW_CELLS.capture))
            {
                put(WINDOW_CELLS.capture, windows.has(hwnd) ? hwnd : 0);
                emit('capture', cell(WINDOW_CELLS.capture));
            }
        },
        releaseCapture: ()=>manager.setCapture(0),
        capture: ()=>cell(WINDOW_CELLS.capture),

        /** @param {number} hwnd @returns {WindowState | null} */
        get: hwnd=>windows.get(hwnd) ?? null,

        /** The top-level windows of the run, the topmost first. @returns {WindowState[]} */
        topLevel: ()=>order.slice().reverse()
            .map(hwnd=>/** @type {WindowState} */ (windows.get(hwnd))),

        /**
         * A window's children, in the order they were made.
         *
         * @param {number} hwnd @returns {WindowState[]}
         */
        children: hwnd=>[...windows.values()].filter(state=>state.parent === hwnd),

        /**
         * The window under a point: the topmost visible top-level window there,
         * then the deepest visible child of it there.
         *
         * @param {number} x @param {number} y @returns {number}
         */
        fromPoint(x, y){
            const top = manager.topLevel().find(state=>state.visible
                && inside(state.rect, x, y));
            let at = top?.hwnd ?? 0;
            for (let deeper = at; deeper !== 0;)
            {
                const child = manager.children(deeper).reverse()
                    .find(state=>state.visible && inside(state.rect, x, y));
                deeper = child?.hwnd ?? 0;
                at = deeper || at;
            }
            return at;
        },

        /**
         * The process an input event of the page goes to, as Windows sends
         * it: a pointer's to the window that captured the mouse, else the one
         * under it; the keyboard's, and anything else, to the window with the
         * focus, else the foreground one. Null where no window has it -- the
         * desktop under the pointer, no window in the foreground -- and then,
         * as on Windows, no program is sent it. The pointer's last place is
         * the run's, as the cursor is one for the whole desktop: a button or a
         * wheel with no place of its own happens where the pointer last was.
         *
         * @param {{ kind: string, x?: number, y?: number }} event
         * @returns {number | null}
         */
        inputTarget(event){
            const pointed = event.kind === 'pointerMove' || event.kind === 'pointerButton'
                || event.kind === 'wheel';
            if (pointed && typeof event.x === 'number' && typeof event.y === 'number')
            {
                pointer.x = event.x;
                pointer.y = event.y;
            }
            const hwnd = !pointed ? cell(WINDOW_CELLS.focus) || cell(WINDOW_CELLS.foreground)
                : cell(WINDOW_CELLS.capture) || manager.fromPoint(pointer.x, pointer.y);
            return hwnd !== 0 ? windows.get(hwnd)?.processId ?? null : null;
        },

        revision: ()=>revision,

        /**
         * Every change from now on, in order. Answers how to stop.
         *
         * @param {(event: WindowEvent) => void} listener
         */
        subscribe(listener){
            listeners.add(listener);
            return ()=>{
                listeners.delete(listener);
            };
        },

        diagnostics: ()=>({
            windows: windows.size,
            revision,
            foreground: `0x${cell(WINDOW_CELLS.foreground).toString(16)}`,
            focus: `0x${cell(WINDOW_CELLS.focus).toString(16)}`,
            capture: `0x${cell(WINDOW_CELLS.capture).toString(16)}`,
            topLevel: manager.topLevel().map(state=>({
                hwnd: `0x${state.hwnd.toString(16)}`, process: state.processId,
                title: state.title, className: state.className, visible: state.visible,
                topmost: state.topmost,
                rect: [state.rect.left, state.rect.top, state.rect.right, state.rect.bottom],
            })),
            made: made.map(({ hwnd, process, className })=>({ hwnd: `0x${hwnd.toString(16)}`,
                process, className })),
        }),
    };
    return manager;
}
