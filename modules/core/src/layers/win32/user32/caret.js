/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The caret: the flashing mark where typing goes, one per thread.
 *
 * A thread has at most one, owned by one of its windows; CreateCaret
 * replaces it, DestroyCaret ends it, and the window's destruction ends it
 * too. It starts hidden, and hiding counts: five HideCarets want five
 * ShowCarets. The thread's caret position outlives the caret, as the
 * queue's does on Windows: GetCaretPos with no caret answers where the last
 * one was.
 *
 * It is drawn by inverting its rectangle in its window's client area, so
 * drawing it twice takes it away again and nothing has to be kept of what
 * was under it. That makes the bookkeeping the whole of it: whether the
 * pixels are inverted right now. A paint of the window would paint over an
 * inverted caret and leave the next inversion drawing a stray one, so a
 * paint takes the caret off first and puts it back after (`paintStarts`,
 * `paintEnds`), as BeginPaint and EndPaint do on Windows.
 *
 * It does not blink. A blink is a redraw of the window twice a second for
 * as long as the program waits for a key, and a display that counts frames
 * would read every one as the program drawing; a caret that stays shown is
 * where typing goes all the same. GetCaretBlinkTime answers the period a
 * program asks after.
 *
 * The edit control takes this caret as the real one does -- created when
 * it gains the focus, placed where its selection ends, destroyed when it
 * loses the focus -- so a program that asks where the caret is, or hides it
 * while it draws over an edit, finds the one the edit shows.
 */

const ERROR_ACCESS_DENIED = 5;
const ERROR_NOACCESS = 998;
const ERROR_INVALID_WINDOW_HANDLE = 1400;

/** CreateCaret's bitmap that is not one: the caret drawn in grey. */
const GRAY_CARET = 1;

/**
 * @typedef {Object} Caret
 * @property {number} hwnd
 * @property {number} width
 * @property {number} height
 * @property {boolean} gray
 * @property {number} hidden     How many HideCarets are outstanding.
 * @property {boolean} on        Whether its rectangle is inverted on the screen now.
 * @property {boolean} suspended Taken off for a paint of its window.
 */

/**
 * @typedef {Object} CaretHost
 * @property {(hwnd: number) => any | null} live  A window that exists, or null.
 * @property {() => unknown} caller  The thread whose call this is.
 * @property {(record: any) => unknown} [threadOf]  The thread a window belongs to.
 * @property {(record: any) => number} contextOn  A context on the client area, or 0.
 * @property {(record: any, hdc: number) => void} release
 * @property {{ invert?: (hdc: number, rect: { left: number, top: number, right: number,
 *     bottom: number }, halftone?: boolean) => boolean } | null | undefined} draw
 * @property {() => void} [painted]  Told the screen changed outside a paint.
 * @property {(handle: number) => { width: number, height: number } | null} [bitmapSize]
 * @property {(index: number) => number} [metric]  GetSystemMetrics.
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(code: number) => void} [setLastError]
 * @property {(api: string, detail: string) => void} [divergence]
 */

/**
 * @param {CaretHost} host
 */
export function createCaret(host){
    /**
     * Each thread's caret and the position its queue keeps, by thread.
     *
     * @type {Map<unknown, { caret: Caret | null, x: number, y: number }>}
     */
    const threads = new Map();
    let bitmapSaid = false;

    /** @param {unknown} thread */
    const stateOf = thread=>{
        let state = threads.get(thread);
        if (!state)
        {
            state = { caret: null, x: 0, y: 0 };
            threads.set(thread, state);
        }
        return state;
    };

    /**
     * The calling thread's state, its caret dropped first if the window
     * that owned it is gone: DestroyWindow takes the caret with it.
     */
    const mine = ()=>{
        const state = stateOf(host.caller());
        if (state.caret && !host.live(state.caret.hwnd))
        {
            state.caret = null;
        }
        return state;
    };

    /**
     * Inverts the caret's rectangle, which draws it or takes it away.
     *
     * @param {Caret} caret @param {{ x: number, y: number }} at
     */
    const invert = (caret, at)=>{
        const record = host.live(caret.hwnd);
        const hdc = record && host.draw?.invert ? host.contextOn(record) : 0;
        if (hdc === 0)
        {
            return;
        }
        try
        {
            host.draw?.invert?.(hdc, { left: at.x, top: at.y, right: at.x + caret.width,
                bottom: at.y + caret.height }, caret.gray);
        }
        finally
        {
            host.release(record, hdc);
        }
        host.painted?.();
    };

    /** @param {Caret} caret @param {{ x: number, y: number }} at */
    const takeOff = (caret, at)=>{
        if (caret.on)
        {
            caret.on = false;
            invert(caret, at);
        }
    };

    /** @param {Caret} caret @param {{ x: number, y: number }} at */
    const putOn = (caret, at)=>{
        if (!caret.on && caret.hidden === 0 && !caret.suspended)
        {
            caret.on = true;
            invert(caret, at);
        }
    };

    /**
     * The caller's caret, when `hwnd` is null or the window that owns it;
     * otherwise refused as Windows refuses a window not holding the caret.
     *
     * @param {number} hwnd
     */
    const owned = hwnd=>{
        const state = mine();
        if (!state.caret || ((hwnd >>> 0) !== 0 && (hwnd >>> 0) !== state.caret.hwnd))
        {
            host.setLastError?.(ERROR_ACCESS_DENIED);
            return null;
        }
        return state;
    };

    /**
     * @param {number} hwnd
     * @param {(caret: Caret, at: { x: number, y: number }) => void} change
     */
    const eachOn = (hwnd, change)=>{
        for (const state of threads.values())
        {
            if (state.caret && state.caret.hwnd === (hwnd >>> 0))
            {
                change(state.caret, state);
            }
        }
    };

    const table = {
        /**
         * BOOL CreateCaret(HWND hWnd, HBITMAP hBitmap, int nWidth, int nHeight)
         *
         * The thread's new caret, hidden, at the window's corner; the old one
         * goes. A bitmap gives the shape and its own size; (HBITMAP)1 is the
         * grey caret; a width or height of zero is the window border's.
         */
        CreateCaret: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([hwnd, bitmap, width, height])=>{
                const record = host.live(hwnd);
                if (!record)
                {
                    host.setLastError?.(ERROR_INVALID_WINDOW_HANDLE);
                    return 0;
                }
                // The caret is the thread's, so only a window of the thread
                // may hold it.
                const thread = host.caller();
                const owner = host.threadOf?.(record);
                if (owner !== undefined && owner !== null && thread !== undefined
                    && owner !== thread)
                {
                    host.setLastError?.(ERROR_ACCESS_DENIED);
                    return 0;
                }
                const state = mine();
                if (state.caret)
                {
                    takeOff(state.caret, state);
                }
                const SM_CXBORDER = 5;
                const SM_CYBORDER = 6;
                let across = width | 0;
                let down = height | 0;
                const handle = bitmap >>> 0;
                if (handle > GRAY_CARET)
                {
                    const size = host.bitmapSize?.(handle) ?? null;
                    if (size)
                    {
                        across = size.width;
                        down = size.height;
                    }
                    if (!bitmapSaid)
                    {
                        bitmapSaid = true;
                        host.divergence?.('CreateCaret',
                            'a bitmap caret is drawn as its inverted rectangle');
                    }
                }
                state.caret = {
                    hwnd: record.hwnd >>> 0,
                    width: across > 0 ? across : host.metric?.(SM_CXBORDER) ?? 1,
                    height: down > 0 ? down : host.metric?.(SM_CYBORDER) ?? 1,
                    gray: handle === GRAY_CARET,
                    hidden: 1,
                    on: false,
                    suspended: false,
                };
                state.x = 0;
                state.y = 0;
                return 1;
            },
        },

        /** BOOL DestroyCaret(void): the thread's caret, which has to exist. */
        DestroyCaret: {
            argBytes: 0,
            handler: ()=>{
                const state = mine();
                if (!state.caret)
                {
                    return 0;
                }
                takeOff(state.caret, state);
                state.caret = null;
                return 1;
            },
        },

        /** BOOL HideCaret(HWND hWnd): one more hide outstanding. */
        HideCaret: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>{
                const state = owned(hwnd);
                if (!state?.caret)
                {
                    return 0;
                }
                state.caret.hidden++;
                takeOff(state.caret, state);
                return 1;
            },
        },

        /**
         * BOOL ShowCaret(HWND hWnd): one hide fewer, the caret drawn when
         * none is left. A caret not hidden stays as it is, and the call
         * still succeeds.
         */
        ShowCaret: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>{
                const state = owned(hwnd);
                if (!state?.caret)
                {
                    return 0;
                }
                if (state.caret.hidden > 0)
                {
                    state.caret.hidden--;
                }
                putOn(state.caret, state);
                return 1;
            },
        },

        /** BOOL SetCaretPos(int X, int Y): in the owning window's client coordinates. */
        SetCaretPos: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([x, y])=>{
                const state = mine();
                if (!state.caret)
                {
                    return 0;
                }
                if (state.x === (x | 0) && state.y === (y | 0))
                {
                    return 1;
                }
                const wasOn = state.caret.on;
                takeOff(state.caret, state);
                state.x = x | 0;
                state.y = y | 0;
                if (wasOn)
                {
                    putOn(state.caret, state);
                }
                return 1;
            },
        },

        /** BOOL GetCaretPos(LPPOINT lpPoint): where the thread's caret is, or last was. */
        GetCaretPos: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([point])=>{
                if ((point >>> 0) === 0)
                {
                    host.setLastError?.(ERROR_NOACCESS);
                    return 0;
                }
                const state = mine();
                const bytes = new Uint8Array(8);
                const view = new DataView(bytes.buffer);
                view.setInt32(0, state.x, true);
                view.setInt32(4, state.y, true);
                host.writeMemory(point >>> 0, bytes);
                return 1;
            },
        },
    };

    return {
        table,

        /**
         * A paint of `record` begins: a caret shown in it comes off first,
         * or the paint covers it and the next inversion draws a stray one.
         *
         * @param {any} record
         */
        paintStarts: record=>eachOn(record.hwnd, (caret, at)=>{
            takeOff(caret, at);
            caret.suspended = true;
        }),

        /** The paint is over: the caret goes back on if nothing else hides it. @param {any} record */
        paintEnds: record=>eachOn(record.hwnd, (caret, at)=>{
            if (caret.suspended)
            {
                caret.suspended = false;
                putOn(caret, at);
            }
        }),
    };
}
