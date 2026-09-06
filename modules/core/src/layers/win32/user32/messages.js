/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * The thread's message queue.
 *
 * It is its own thing rather than a field of the window table because it is the
 * seam the outside world posts through: a keystroke and a mouse move come from
 * the input layer, not from a window operation, and both arrive here as
 * ordinary posts.
 *
 * WM_QUIT is deliberately not a queued message. PostQuitMessage sets a flag,
 * and the flag only becomes a message once the queue has nothing else to give,
 * which is what lets a program finish the work it already had before it exits.
 */

/** The message that ends a message loop. */
export const WM_QUIT = 0x0012;

/** A filter that accepts messages for any window, and thread messages besides. */
export const ANY_WINDOW = null;

/**
 * @typedef {Object} PostedMessage
 * @property {number} hwnd        Zero for a message that belongs to the thread.
 * @property {number} message
 * @property {number} wParam
 * @property {number} lParam
 * @property {number} [time]      Tick count at the moment it was posted.
 * @property {number} [x]         Cursor position, for messages that carry one.
 * @property {number} [y]
 */

/**
 * @typedef {Object} MessageFilter
 * @property {number | null} hwnd  A window handle, or ANY_WINDOW.
 * @property {number} first        Lowest message accepted; 0 with `last` means all.
 * @property {number} last
 * @property {boolean} remove      Whether retrieving it takes it out of the queue.
 */

export function createMessageQueue(){
    /** @type {import('./structs.js').MessageFields[]} */
    const pending = [];
    /** @type {number | null} */
    let quitCode = null;
    let posted = 0;
    let retrieved = 0;

    /**
     * @param {import('./structs.js').MessageFields} entry
     * @param {MessageFilter} filter
     */
    const accepts = (entry, filter)=>{
        if (filter.hwnd !== ANY_WINDOW && entry.hwnd !== filter.hwnd)
        {
            return false;
        }
        // A range of 0..0 is how a program says it wants everything; any other
        // pair is inclusive at both ends.
        if (filter.first === 0 && filter.last === 0)
        {
            return true;
        }
        return entry.message >= filter.first && entry.message <= filter.last;
    };

    return {
        /** @param {PostedMessage} message */
        post(message){
            pending.push({
                hwnd: message.hwnd >>> 0,
                message: message.message >>> 0,
                wParam: message.wParam >>> 0,
                lParam: message.lParam >>> 0,
                time: (message.time ?? 0) >>> 0,
                x: (message.x ?? 0) | 0,
                y: (message.y ?? 0) | 0,
            });
            posted++;
        },

        /** @param {number} code  The value the program exits with. */
        postQuit(code){
            quitCode = code | 0;
        },

        /**
         * The one retrieval path: PeekMessage and GetMessage differ in what they
         * do with the answer, never in how they find it.
         *
         * @param {MessageFilter} filter
         * @returns {import('./structs.js').MessageFields | null}
         */
        peek(filter){
            const index = pending.findIndex(entry=>accepts(entry, filter));
            if (index >= 0)
            {
                const entry = pending[index];
                if (filter.remove)
                {
                    pending.splice(index, 1);
                    retrieved++;
                }
                return entry;
            }
            if (quitCode === null)
            {
                return null;
            }
            const quit = {
                hwnd: 0,
                message: WM_QUIT,
                wParam: quitCode >>> 0,
                lParam: 0,
                time: 0,
                x: 0,
                y: 0,
            };
            if (!accepts(quit, filter))
            {
                return null;
            }
            if (filter.remove)
            {
                quitCode = null;
                retrieved++;
            }
            return quit;
        },

        /**
         * Drops everything queued for a window. A destroyed window's pending
         * messages name a window that no longer exists, and delivering them
         * would hand the guest a stale handle.
         *
         * @param {number} hwnd
         */
        purge(hwnd){
            for (let index = pending.length - 1; index >= 0; index--)
            {
                if (pending[index].hwnd === (hwnd >>> 0))
                {
                    pending.splice(index, 1);
                }
            }
        },

        /** How many real messages are waiting; a pending quit is not one. */
        depth: ()=>pending.length,

        quitPending: ()=>quitCode !== null,

        diagnostics: ()=>({
            depth: pending.length,
            posted,
            retrieved,
            quitPending: quitCode !== null,
        }),
    };
}
