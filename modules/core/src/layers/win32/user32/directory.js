/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The windows of a whole run, as the system half of user32 knows them
 * (roadmap/v2, stage 1, the Win32 split).
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
 */

/**
 * @typedef {Object} WindowDescription
 * @property {number} threadId
 * @property {string} className
 * @property {string} title
 */

export function createWindowDirectory(){
    let next = FIRST_WINDOW;
    /** Each window's process, by handle. @type {Map<number, number>} */
    const owners = new Map();
    /** Each process that can have windows, in the order it started. @type {Map<number, WindowEndpoint>} */
    const endpoints = new Map();

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
