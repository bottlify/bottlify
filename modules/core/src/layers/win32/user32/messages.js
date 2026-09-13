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
 * The classes GetQueueStatus answers about.
 *
 * QS_ALLPOSTMESSAGE is the same news as QS_POSTMESSAGE with the message range
 * of a waiting PeekMessage ignored, so anything that sets one sets both.
 */
export const QS_KEY = 0x0001;
export const QS_MOUSEMOVE = 0x0002;
export const QS_MOUSEBUTTON = 0x0004;
export const QS_POSTMESSAGE = 0x0008;
export const QS_TIMER = 0x0010;
export const QS_PAINT = 0x0020;
export const QS_HOTKEY = 0x0080;
export const QS_ALLPOSTMESSAGE = 0x0100;

/** The ends of the two input ranges, and the one message of its own class. */
const WM_KEYFIRST = 0x0100;
const WM_KEYLAST = 0x0108;
const WM_MOUSELAST = 0x020d;
const WM_HOTKEY = 0x0312;

/**
 * Which class a message belongs to, by its number.
 *
 * Windows decides this by where a message came from rather than what it is: a
 * click the hardware reported sets QS_MOUSEBUTTON, the same click a program
 * posted to itself sets QS_POSTMESSAGE. One queue here holds both and cannot
 * always tell them apart, so the number decides -- and that is the direction
 * to be wrong in. A loop watching QS_INPUT for the keypress that skips a
 * cinematic is the reason this call exists, and reporting real input as a mere
 * post would leave it watching for something that never comes; reporting a
 * program's own posted click as input at worst makes it look once too often.
 *
 * @param {number} message
 */
const classOf = message=>{
    if (message === WM_PAINT)
    {
        return QS_PAINT;
    }
    if (message === WM_TIMER)
    {
        return QS_TIMER;
    }
    if (message === WM_HOTKEY)
    {
        return QS_HOTKEY;
    }
    if (message >= WM_KEYFIRST && message <= WM_KEYLAST)
    {
        return QS_KEY;
    }
    if (message === WM_MOUSEMOVE)
    {
        return QS_MOUSEMOVE;
    }
    if (message > WM_MOUSEMOVE && message <= WM_MOUSELAST)
    {
        return QS_MOUSEBUTTON;
    }
    return QS_POSTMESSAGE | QS_ALLPOSTMESSAGE;
};

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
     * The classes that arrived since the queue was last looked at, which is the
     * half of GetQueueStatus that says what is *new*. Cleared by every look --
     * GetQueueStatus's own, and any retrieval -- because that is the window the
     * documentation defines it over.
     */
    let changed = 0;
    /**
     * The paint and the timer as the last status call saw them. Neither is a
     * queued message, so neither has an arrival to record: a condition that was
     * absent and is now present is the news, and this is what it is compared
     * against. Without it a window left dirty for a hundred frames would report
     * itself as news in every one of them.
     */
    let reportedSynthetic = 0;
    /**
     * The message most recently taken off the queue, for GetMessageTime and
     * GetMessagePos: both answer about it, whichever window it was for.
     *
     * @type {import('./structs.js').MessageFields | null}
     */
    let last = null;

    /**
     * What a program actually pumps, by message.
     *
     * A count of messages says how busy a loop is; which messages says what it
     * is doing, and those are different questions. A loop that spends a third
     * of every frame waiting is waiting for one particular thing, and without
     * this the only way to find out is to read the guest's own code.
     *
     * @type {Map<number, number>}
     */
    const pumped = new Map();

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
     * Its due time moves on only when the caller takes the message. A look that
     * does not remove leaves the tick where it is, because that is what Windows
     * does and because a pump written the ordinary way -- look first, retrieve
     * second -- otherwise loses every tick to its own look: the first call
     * consumes it, the second finds an empty queue, and the program settles
     * down to wait for a tick it has already been handed and thrown away.
     *
     * @param {MessageFilter} filter
     */
    /** How well a timer's ticks are delivered against what it asked for. */
    let timerTicks = 0;
    let timerLateTicks = 0;
    let timerLateMs = 0;
    let worstTimerLateMs = 0;

    /**
     * Where the windows that need painting are, when the window half has
     * said. WM_PAINT is made up at retrieval like WM_TIMER: Windows never
     * queues one, it hands one out when a program asks for a message, finds
     * nothing posted, and some window has an area still to paint. That is
     * why a hundred invalidations are one paint and why a program that only
     * ever peeks still repaints.
     *
     * @type {((filter: MessageFilter) => number) | null}
     */
    let dirtyWindow = null;

    /**
     * Where a message posted from outside goes, when the window half has
     * said: the input layer names the pointer's position and no window, and
     * which window is under the pointer is the window half's to know.
     *
     * @type {((message: PostedMessage) => PostedMessage | null) | null}
     */
    let router = null;

    /** @param {MessageFilter} filter */
    const takePaint = filter=>{
        const hwnd = dirtyWindow ? dirtyWindow(filter) : 0;
        if (hwnd === 0)
        {
            return null;
        }
        const paint = { hwnd, message: WM_PAINT, wParam: 0, lParam: 0, time: now(), x: 0, y: 0 };
        return accepts(paint, filter) ? paint : null;
    };

    /** @param {MessageFilter} filter */
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
            // A look that does not remove leaves the tick exactly where it is.
            if (!filter.remove)
            {
                return message;
            }
            // How late this tick was handed over. A program that paces itself
            // by a timer runs at the rate the timer is actually delivered at,
            // not the rate it asked for, and lateness here is a frame rate lost
            // somewhere nobody would think to look.
            const late = at - timer.due;
            if (late > 0)
            {
                timerLateMs += late;
                timerLateTicks++;
                worstTimerLateMs = Math.max(worstTimerLateMs, late);
            }
            timerTicks++;
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

        /** @param {PostedMessage} incoming */
        post(incoming){
            const message = router ? router(incoming) : incoming;
            if (!message)
            {
                return;
            }
            changed |= classOf(message.message >>> 0);
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
            changed |= QS_POSTMESSAGE | QS_ALLPOSTMESSAGE;
        },

        /**
         * What is waiting, by class, as GetQueueStatus reports it: `inQueue` is
         * everything there is, `changed` only what has arrived since the last
         * look. Both halves are needed because a program tests them for
         * different things -- "is there anything to pump" against "has anything
         * happened since I last asked".
         *
         * Looking counts as a look: the news is cleared here, the way it is
         * cleared by a retrieval.
         *
         * @returns {{ inQueue: number, changed: number }}
         */
        status(){
            let inQueue = 0;
            for (const entry of pending)
            {
                inQueue |= classOf(entry.message);
            }
            if (quitCode !== null)
            {
                inQueue |= QS_POSTMESSAGE | QS_ALLPOSTMESSAGE;
            }
            const filter = { hwnd: ANY_WINDOW, first: 0, last: 0, remove: false };
            if (dirtyWindow && dirtyWindow(filter) !== 0)
            {
                inQueue |= QS_PAINT;
            }
            const at = now();
            for (const timer of timers.values())
            {
                if (timer.due <= at)
                {
                    inQueue |= QS_TIMER;
                    break;
                }
            }
            const synthetic = inQueue & (QS_PAINT | QS_TIMER);
            // Only what is still there: the low word is defined as what arrived
            // *and has not been taken yet*, so a keystroke posted and retrieved
            // between two looks is no longer news.
            const news = (changed | (synthetic & ~reportedSynthetic)) & inQueue;
            changed = 0;
            reportedSynthetic = synthetic;
            return { inQueue, changed: news };
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
            // A look at the queue is a look however it is spelt: GetMessage and
            // PeekMessage clear the news GetQueueStatus reports just as
            // GetQueueStatus itself does.
            changed = 0;
            const index = pending.findIndex(entry=>accepts(entry, filter));
            if (index >= 0)
            {
                const entry = pending[index];
                if (filter.remove)
                {
                    pending.splice(index, 1);
                    retrieved++;
                    last = entry;
                    pumped.set(entry.message, (pumped.get(entry.message) ?? 0) + 1);
                }
                return entry;
            }
            // Nothing queued: a window with an area to paint is made up now,
            // then a due timer, then the quit -- the order Windows retrieves
            // in. Not removed, because retrieval does not paint: the area
            // stays until BeginPaint clears it, and the next look finds it
            // again exactly as Windows would.
            const paint = takePaint(filter);
            if (paint)
            {
                if (filter.remove)
                {
                    retrieved++;
                    pumped.set(WM_PAINT, (pumped.get(WM_PAINT) ?? 0) + 1);
                }
                return paint;
            }
            const due = takeTimer(filter);
            if (due)
            {
                if (filter.remove)
                {
                    last = due;
                    pumped.set(WM_TIMER, (pumped.get(WM_TIMER) ?? 0) + 1);
                }
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
                last = quit;
            }
            return quit;
        },

        /** The message most recently taken, or null before the first. */
        last: ()=>last,

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

        /**
         * Tells the queue how to find a window with an area to paint. The
         * windows are the window half's; the queue only asks.
         *
         * @param {(filter: MessageFilter) => number} source
         */
        paintsFrom(source){
            dirtyWindow = source;
        },

        /**
         * Tells the queue how to find the window a posted message is for.
         * The router may rewrite the message or drop it with null.
         *
         * @param {(message: PostedMessage) => PostedMessage | null} route
         */
        routeWith(route){
            router = route;
        },

        /** How many real messages are waiting; a pending quit is not one. */
        depth: ()=>pending.length,

        quitPending: ()=>quitCode !== null,

        diagnostics: ()=>({
            depth: pending.length,
            posted,
            retrieved,
            quitPending: quitCode !== null,
            // The dozen a program pumps most, by message, newest count first.
            // Written as hexadecimal because that is how every reference lists
            // a WM_.
            byMessage: Object.fromEntries([...pumped]
                .sort((one, two)=>two[1] - one[1])
                .slice(0, 12)
                .map(([message, count])=>[`0x${message.toString(16)}`, count])),
            timerDue: (()=>{
                let soonest = null;
                for (const timer of timers.values())
                {
                    if (soonest === null || timer.due < soonest)
                    {
                        soonest = timer.due;
                    }
                }
                return soonest;
            })(),
            timers: timers.size,
            // What each armed timer actually asked for, and when it is next
            // due. A machine that spends two fifths of every frame waiting for
            // a timer is waiting for one of these, and until now a report could
            // not say which or how often it wanted to fire.
            timerIntervals: [...timers.values()].map(timer=>timer.elapse),
            timerTicks,
            timerLateTicks,
            averageTimerLateMs: timerLateTicks === 0
                ? 0
                : Math.round(timerLateMs / timerLateTicks),
            worstTimerLateMs: Math.round(worstTimerLateMs),
        }),
    };
}
