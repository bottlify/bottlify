/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
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
export const WM_PAINT = 0x000f;
export const WM_QUIT = 0x0012;

/**
 * Pointer motion, which is not queued the way everything else is.
 *
 * Windows keeps the cursor's position in the queue's own state and builds one
 * WM_MOUSEMOVE from it when the program asks, so however fast the hardware
 * reports, at most one move is ever waiting. Queuing each one instead makes a
 * backlog no program can drain: a browser reports motion at the display's rate,
 * and a guest that pumps its loop slower than that falls further behind with
 * every frame, working through positions the pointer left long ago. From the
 * outside the game stops responding to the mouse entirely.
 */
export const WM_MOUSEMOVE = 0x0200;

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

/** WM_TIMER, which is synthesised rather than queued -- see `timers` below. */
export const WM_TIMER = 0x0113;

/**
 * @param {Object} [options]
 * @param {() => number} [options.now]
 *        The guest's clock, in milliseconds. A timer is due against the clock
 *        the program itself reads, never the host's.
 */
export function createMessageQueue({ now = ()=>0 } = {}){
    /** @type {import('./structs.js').MessageFields[]} */
    const pending = [];
    /** @type {number | null} */
    let quitCode = null;
    let posted = 0;
    let retrieved = 0;

    /**
     * Characters the host composed, waiting for the TranslateMessage that turns
     * one into a WM_CHAR.
     *
     * @type {{ character: number, lParam: number }[]}
     */
    const composed = [];
    const COMPOSED_LIMIT = 16;

    /**
     * Timers, which are not queued messages.
     *
     * Windows never puts WM_TIMER in the queue: it makes one up when a program
     * asks for a message, finds nothing else, and a timer is due. That is why a
     * slow handler does not build a backlog of ticks -- there is no backlog to
     * build, only a due time that has passed. Modelling it as a posted message
     * gets that wrong in the direction that hurts: a program whose frame takes
     * longer than its timer would find the queue full of stale ticks and never
     * reach anything else.
     *
     * @type {Map<string, { hwnd: number, id: number, elapse: number,
     *                      proc: number, due: number }>}
     */
    const timers = new Map();

    /**
     * The timer that is due, as the message it becomes.
     *
     * Its due time moves on whether or not the caller removes it, because a
     * peek that left it due would hand the same tick out for ever and a program
     * that peeks in a loop would see nothing else.
     *
     * @param {MessageFilter} filter
     */
    const takeTimer = filter=>{
        const at = now();
        for (const timer of timers.values())
        {
            if (timer.due > at)
            {
                continue;
            }
            const message = {
                hwnd: timer.hwnd,
                message: WM_TIMER,
                wParam: timer.id,
                // A TIMERPROC travels in lParam, and DispatchMessage calls it
                // instead of the window procedure. That is the contract, not a
                // convenience: a timer with no window has nowhere else to go.
                lParam: timer.proc,
                time: at >>> 0,
                x: 0,
                y: 0,
            };
            if (!accepts(message, filter))
            {
                continue;
            }
            // Against the moment it came due rather than against now, so a
            // handler that runs long does not make the timer drift later and
            // later. Skipped forward when it has fallen a whole period behind,
            // because catching up on missed ticks is a backlog nobody wants.
            timer.due = Math.max(at, timer.due) + timer.elapse;
            return message;
        }
        return null;
    };

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
        /**
         * A character the host's keyboard layout made out of a key press.
         *
         * Windows composes a character inside TranslateMessage, from the layout
         * and the state of the modifiers -- so a program that never calls
         * TranslateMessage never sees a WM_CHAR at all, and one that does sees
         * exactly one. Only the host knows the layout, so the host composes;
         * only TranslateMessage may deliver, or the program is told twice.
         *
         * Kept against the key press it came from, because a modifier goes
         * down without producing anything and would otherwise take the next
         * character in the queue as its own.
         *
         * @param {number} character  A UTF-16 code unit.
         * @param {number} lParam     The key press it was composed from.
         */
        compose(character, lParam){
            composed.push({ character: character & 0xffff, lParam: lParam >>> 0 });
            // A press whose TranslateMessage never came is not worth keeping:
            // a program that translates nothing would otherwise accumulate one
            // of these per keystroke for the length of the run.
            if (composed.length > COMPOSED_LIMIT)
            {
                composed.shift();
            }
        },

        /**
         * The character composed for this key press, if the host made one.
         *
         * @param {number} lParam
         * @returns {number | null}
         */
        takeComposed(lParam){
            const at = composed.findIndex(entry=>entry.lParam === (lParam >>> 0));
            if (at === -1)
            {
                return null;
            }
            // Everything before it belonged to a press nobody translated.
            const [taken] = composed.splice(at, 1);
            composed.splice(0, at);
            return taken.character;
        },

        /** @param {PostedMessage} message */
        post(message){
            if ((message.message >>> 0) === WM_MOUSEMOVE)
            {
                // Replaced in place rather than dropped and re-appended: a move
                // that overtook the keystroke before it would report the button
                // as pressed somewhere the pointer had already left.
                const held = pending.find(entry=>entry.message === WM_MOUSEMOVE
                    && entry.hwnd === (message.hwnd >>> 0));
                if (held)
                {
                    held.wParam = message.wParam >>> 0;
                    held.lParam = message.lParam >>> 0;
                    held.time = (message.time ?? 0) >>> 0;
                    held.x = (message.x ?? 0) | 0;
                    held.y = (message.y ?? 0) | 0;
                    posted++;
                    return;
                }
            }
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

        /**
         * When the soonest timer comes due, in guest time, or null for none.
         *
         * A thread waiting on an empty queue is waiting for exactly two things:
         * something posted from outside, and a timer of its own. The first
         * nobody can predict; the second is written down right here, and
         * without it whoever drives the machine has to keep looking to find out
         * -- on a timeout a browser clamps, several thousand times a run.
         *
         * @returns {number | null}
         */
        nextTimerDue(){
            let soonest = null;
            for (const timer of timers.values())
            {
                if (soonest === null || timer.due < soonest)
                {
                    soonest = timer.due;
                }
            }
            return soonest;
        },

        /** @param {number} code  The value the program exits with. */
        postQuit(code){
            quitCode = code | 0;
        },

        /**
         * Starts or restarts a timer. Setting one that exists changes its
         * period rather than making a second, which is what a program relies on
         * when it retunes a timer it already owns.
         *
         * @param {number} hwnd @param {number} id @param {number} elapse
         * @param {number} proc  A TIMERPROC, or zero for a queued WM_TIMER.
         */
        setTimer(hwnd, id, elapse, proc){
            // Windows clamps to its own resolution rather than firing a zero
            // period continuously, and a program that asks for zero means "as
            // often as you can".
            const period = Math.max(10, elapse >>> 0);
            timers.set(`${hwnd >>> 0}:${id >>> 0}`, {
                hwnd: hwnd >>> 0, id: id >>> 0, elapse: period, proc: proc >>> 0,
                due: now() + period,
            });
        },

        /** @param {number} hwnd @param {number} id */
        killTimer(hwnd, id){
            return timers.delete(`${hwnd >>> 0}:${id >>> 0}`);
        },

        /** Every timer belonging to a window that has gone. @param {number} hwnd */
        killTimersFor(hwnd){
            for (const [key, timer] of timers)
            {
                if (timer.hwnd === (hwnd >>> 0))
                {
                    timers.delete(key);
                }
            }
        },

        /**
         * When the earliest timer is due, or null. Whoever is idling the
         * process reads this so that a thread waiting for a message wakes at
         * the right moment rather than at whatever else happens to happen.
         */
        nextDue(){
            let earliest = null;
            for (const timer of timers.values())
            {
                if (earliest === null || timer.due < earliest)
                {
                    earliest = timer.due;
                }
            }
            return earliest;
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
            // Nothing queued: a due timer is made up now. After the queue and
            // before the quit, which is the order Windows retrieves in.
            const due = takeTimer(filter);
            if (due)
            {
                return due;
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
