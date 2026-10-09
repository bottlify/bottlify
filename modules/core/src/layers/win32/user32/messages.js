/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The threads' message queues.
 *
 * It is its own thing rather than a field of the window table because it is the
 * seam the outside world posts through: a keystroke and a mouse move come from
 * the input layer, not from a window operation, and both arrive here as
 * ordinary posts.
 *
 * Every thread has a queue of its own, as on Windows: a message posted to a
 * window waits for the thread that created the window, one posted to a thread
 * for that thread, and a retrieval sees its own thread's alone. They are kept
 * as one list, each entry naming its thread, because the order messages were
 * posted in is what a retrieval walks, and the input layer's posts name no
 * window until they are routed.
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
 * The identifier of a thread the bridge named, or null for one that carries
 * none: a build with no scheduler, whose one caller is then every thread.
 *
 * @param {unknown} thread
 * @returns {number | null}
 */
export const threadIdOf = thread=>{
    const id = /** @type {{ id?: unknown } | null | undefined} */ (thread)?.id;
    return typeof id === 'number' ? id >>> 0 : null;
};

/**
 * @typedef {Object} PostedMessage
 * @property {number} hwnd        Zero for a message that belongs to the thread.
 * @property {number} message
 * @property {number} wParam
 * @property {number} lParam
 * @property {number} [time]      Tick count at the moment it was posted.
 * @property {number} [x]         Cursor position, for messages that carry one.
 * @property {number} [y]
 * @property {boolean} [unicode]  Posted by a wide caller, so a character is a UTF-16 unit.
 * @property {number | null} [thread]  The thread whose queue it goes to, for a
 *     message with no window; null for whichever thread looks first. Left out,
 *     a window's message goes to the thread that created the window.
 */

/**
 * @typedef {Object} MessageFilter
 * @property {number | null} hwnd  A window handle, or ANY_WINDOW.
 * @property {number} first        Lowest message accepted; 0 with `last` means all.
 * @property {number} last
 * @property {boolean} remove      Whether retrieving it takes it out of the queue.
 * @property {number | null} [thread]  Whose queue is looked in; null for every
 *     thread's. Left out, the queue of the thread running.
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
export const QS_SENDMESSAGE = 0x0040;
export const QS_HOTKEY = 0x0080;
export const QS_ALLPOSTMESSAGE = 0x0100;
export const QS_RAWINPUT = 0x0400;

/** Raw input's one message, a class of its own. */
const WM_INPUT = 0x00ff;

/** The ends of the two input ranges, and the one message of its own class. */
const WM_KEYFIRST = 0x0100;
const WM_KEYLAST = 0x0108;
const WM_MOUSELAST = 0x020d;
const WM_HOTKEY = 0x0312;

/** The two presses a hot key can be registered on; a release never fires one. */
const WM_KEYDOWN = 0x0100;
const WM_SYSKEYDOWN = 0x0104;
const WM_KEYUP = 0x0101;
const WM_SYSKEYUP = 0x0105;

/** RegisterHotKey's modifier bits. */
const MOD_ALT = 0x0001;
const MOD_CONTROL = 0x0002;
const MOD_SHIFT = 0x0004;
const MOD_WIN = 0x0008;
/** Not a modifier held with the key but a rule about repeats, hence masked
 *  out of the combination when two registrations are compared. */
const MOD_NOREPEAT = 0x4000;
/** The bits that *are* the combination: the keys held while it fires. */
const MOD_HELD = MOD_ALT | MOD_CONTROL | MOD_SHIFT | MOD_WIN;

/** The virtual keys the held-modifier state is read from. */
const VK_SHIFT = 0x10;
const VK_CONTROL = 0x11;
const VK_MENU = 0x12;
const VK_LWIN = 0x5b;
const VK_RWIN = 0x5c;

/** The key-up/previous-state bit of a key message's lParam. */
const PREVIOUS_KEY_STATE = 0x40000000;

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
    if (message === WM_INPUT)
    {
        return QS_RAWINPUT;
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
 * @param {(key: number) => number} [options.keyState]
 *        Which keys are down, in GetKeyState's form. A hot key is registered
 *        with a combination and fires on the key alone, so the modifiers have
 *        to be read at the moment the press arrives -- from the input layer,
 *        which is above this one and is handed down as a thunk.
 * @param {() => any} [options.currentThread]
 *        The thread asking. A timer set with no window belongs to the thread
 *        that set it: only that thread's pump is handed its ticks, and when the
 *        thread is gone the timer is too.
 */
export function createMessageQueue(options = {}){
    const { now = ()=>0, keyState = ()=>0, currentThread = ()=>null } = options;
    /** @type {(import('./structs.js').MessageFields & { unicode?: boolean })[]} */
    const pending = [];
    /**
     * The thread each queued message waits for, kept beside the message so a
     * retrieval hands back only what was posted.
     *
     * @type {WeakMap<object, number | null>}
     */
    const threadOf = new WeakMap();
    /**
     * PostQuitMessage's code, by the thread that posted it: WM_QUIT ends that
     * thread's loop and no other.
     *
     * @type {Map<number | null, number>}
     */
    const quits = new Map();
    let posted = 0;
    let retrieved = 0;
    // The keys held as of the last key message taken, which is what
    // TranslateMessage reads the modifiers from: the input layer may have let
    // go of Control (a paste's chord is pressed and released at once) before
    // the program gets to the V it was held for.
    const keysAsTaken = new Uint8Array(256);
    let heldKnown = false;

    /**
     * What a thread's last look at its queue saw.
     *
     * `changed` is the classes that arrived since, the half of GetQueueStatus
     * that says what is *new*: cleared by every look -- GetQueueStatus's own,
     * and any retrieval -- because that is the window the documentation
     * defines it over. `synthetic` is the paint and the timer as the last
     * status call saw them: neither is a queued message, so neither has an
     * arrival to record, and a condition that was absent and is now present is
     * the news -- without it a window left dirty for a hundred frames would
     * report itself as news in every one of them. `at` is when, on the guest
     * clock: a timer that came due after it is news to a wait, one already due
     * then is not.
     *
     * @typedef {{ changed: number, synthetic: number, at: number }} Look
     * @type {Map<number | null, Look>}
     */
    const looks = new Map();
    /** @param {number | null} thread @returns {Look} */
    const lookOf = thread=>{
        let look = looks.get(thread);
        if (!look)
        {
            look = { changed: 0, synthetic: 0, at: -Infinity };
            looks.set(thread, look);
        }
        return look;
    };
    /**
     * News of a class for a thread. A message whichever thread looks first
     * may take is news to every thread.
     *
     * @param {number | null} thread @param {number} classes
     */
    const arrived = (thread, classes)=>{
        if (thread === null)
        {
            lookOf(null).changed |= classes;
            for (const look of looks.values())
            {
                look.changed |= classes;
            }
            return;
        }
        lookOf(thread).changed |= classes;
    };

    /** The thread running, as a queue is keyed. */
    const running = ()=>threadIdOf(currentThread());
    /**
     * Whose queue a call means: the one it names, or the running thread's.
     *
     * @param {number | null | undefined} thread
     */
    const whose = thread=>(thread === undefined ? running() : thread);
    /**
     * Whether a message belongs to a thread's queue. One for no thread in
     * particular is anyone's, and a caller naming no thread sees them all.
     *
     * @param {object} entry @param {number | null} thread
     */
    const belongs = (entry, thread)=>{
        const waiter = threadOf.get(entry) ?? null;
        return waiter === null || thread === null || waiter === thread;
    };

    /**
     * The thread that created a window, when the window half has said how
     * to find it, or null for a window it does not know.
     *
     * @type {((hwnd: number) => number | null) | null}
     */
    let ownerOf = null;
    /**
     * Whether another thread has sent a thread something it has not taken,
     * when the window half has said: sent messages are the window half's,
     * and only their presence is a class of this queue's.
     *
     * @type {((thread: number) => boolean) | null}
     */
    let sentTo = null;
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
     * Hot keys, keyed by the `hwnd:id` pair RegisterHotKey identifies a
     * registration by. They are matched on the way in rather than at
     * retrieval, because the point of a hot key is that the keystroke it
     * claims never reaches the window that would otherwise have received it.
     *
     * @type {Map<string, { hwnd: number, id: number, modifiers: number,
     *     vk: number }>}
     */
    const hotKeys = new Map();

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
     *                      proc: number, due: number, thread: any }>}
     */
    const timers = new Map();

    /**
     * Whether a thread's pump may be handed this timer's tick. A window's
     * timer goes to the thread that created the window; a thread's own goes
     * only to that thread. One whose thread has ended is dropped on sight:
     * nothing is left that could ever retrieve it, and Windows destroys it
     * with the thread.
     *
     * @param {string} key
     * @param {{ hwnd: number, thread: any }} timer
     * @param {number | null} asking  The thread looking, null for any.
     */
    const deliverable = (key, timer, asking)=>{
        if (timer.thread?.state === 'terminated')
        {
            timers.delete(key);
            return false;
        }
        const owner = timer.hwnd !== 0 ? ownerOf?.(timer.hwnd) ?? null : threadIdOf(timer.thread);
        return asking === null || owner === null || owner === asking;
    };

    /**
     * Every timer something could still be handed, dropping those whose
     * thread has ended: a wait that woke for one of those would wake for ever.
     */
    const livingTimers = ()=>{
        for (const [key, timer] of timers)
        {
            if (timer.thread?.state === 'terminated')
            {
                timers.delete(key);
            }
        }
        return timers.values();
    };

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
     * The entries the input layer posted -- the ones that name the pointer's
     * position -- as against a program's own posts of the same messages: the
     * system answers the mouse's own messages in ways it does not answer a
     * program's.
     *
     * @type {WeakSet<object>}
     */
    const input = new WeakSet();

    /**
     * Where a message posted from outside goes, when the window half has
     * said: the input layer names the pointer's position and no window, and
     * which window is under the pointer is the window half's to know.
     *
     * @type {((message: PostedMessage) => PostedMessage | null) | null}
     */
    let router = null;

    /**
     * Messages the window half asked to have posted once a moment has come,
     * by a key a second request replaces the first under. The message is made
     * at that moment, not when asked for: a hover reports where the pointer
     * is when it comes due, and a request whose reason has gone makes none.
     *
     * @type {Map<string, { due: number, make: () => PostedMessage | null }>}
     */
    const later = new Map();

    /** Posts every message asked for later whose moment has come. */
    const releaseLater = ()=>{
        if (later.size === 0)
        {
            return;
        }
        const at = now();
        for (const [key, entry] of later)
        {
            if (entry.due > at)
            {
                continue;
            }
            later.delete(key);
            const message = entry.make();
            if (message)
            {
                postMessage(message);
            }
        }
    };

    /**
     * When the soonest timer or message asked for later comes due, or null:
     * both are what a thread waiting on an empty queue can be woken by.
     */
    const soonestDue = ()=>{
        let soonest = null;
        for (const timer of livingTimers())
        {
            if (soonest === null || timer.due < soonest)
            {
                soonest = timer.due;
            }
        }
        for (const entry of later.values())
        {
            if (soonest === null || entry.due < soonest)
            {
                soonest = entry.due;
            }
        }
        return soonest;
    };

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
        for (const [key, timer] of timers)
        {
            if (timer.due > at || !deliverable(key, timer, filter.thread ?? null))
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

    /** Which modifiers are held right now, in RegisterHotKey's bits. */
    const heldModifiers = ()=>{
        /** @param {number} vk */
        const down = vk=>(keyState(vk) & 0x8000) !== 0;
        let bits = 0;
        if (down(VK_MENU))
        {
            bits |= MOD_ALT;
        }
        if (down(VK_CONTROL))
        {
            bits |= MOD_CONTROL;
        }
        if (down(VK_SHIFT))
        {
            bits |= MOD_SHIFT;
        }
        if (down(VK_LWIN) || down(VK_RWIN))
        {
            bits |= MOD_WIN;
        }
        return bits;
    };

    /**
     * The registration that claims this keystroke, or null.
     *
     * Only presses the input layer reports are claimable: a WM_KEYDOWN a
     * program posted to itself names no position -- the same test the router
     * uses to tell its own traffic from the hardware's -- and firing a hot
     * key for a key nobody pressed would have the window act on input that
     * never happened.
     *
     * @param {PostedMessage} message
     */
    const hotKeyFor = message=>{
        const kind = message.message >>> 0;
        if ((kind !== WM_KEYDOWN && kind !== WM_SYSKEYDOWN) || message.x === undefined)
        {
            return null;
        }
        const vk = message.wParam >>> 0;
        const held = heldModifiers();
        for (const entry of hotKeys.values())
        {
            if (entry.vk === vk && (entry.modifiers & MOD_HELD) === held)
            {
                return entry;
            }
        }
        return null;
    };

    /**
     * The quit a thread's loop would be handed, and whose it is: its own, or
     * one posted where no thread was known.
     *
     * @param {number | null} thread
     * @returns {[number | null, number] | null}
     */
    const quitFor = thread=>{
        for (const key of [thread, null])
        {
            const code = quits.get(key);
            if (code !== undefined)
            {
                return [key, code];
            }
        }
        const first = thread === null ? quits.entries().next() : null;
        return first && !first.done ? first.value : null;
    };

    /**
     * Every class waiting to be retrieved now, the synthesised ones included.
     *
     * @param {number | null} [thread]  Whose queue; the running thread's if left out.
     */
    const waiting = thread=>{
        const asking = whose(thread);
        releaseLater();
        let inQueue = 0;
        for (const entry of pending)
        {
            if (belongs(entry, asking))
            {
                inQueue |= classOf(entry.message);
            }
        }
        if (quitFor(asking))
        {
            inQueue |= QS_POSTMESSAGE | QS_ALLPOSTMESSAGE;
        }
        if (asking !== null && sentTo?.(asking))
        {
            inQueue |= QS_SENDMESSAGE;
        }
        const filter = { hwnd: ANY_WINDOW, first: 0, last: 0, remove: false, thread: asking };
        if (dirtyWindow && dirtyWindow(filter) !== 0)
        {
            inQueue |= QS_PAINT;
        }
        const at = now();
        for (const [key, timer] of timers)
        {
            if (timer.due <= at && deliverable(key, timer, asking))
            {
                inQueue |= QS_TIMER;
                break;
            }
        }
        return inQueue;
    };

    /**
     * The one path in: the input layer posts through here like everything
     * else, because a keystroke and a program's own post are the same
     * operation on a queue once the hot keys have had their claim.
     *
     * @param {PostedMessage} incoming
     */
    const postMessage = incoming=>{
        const claimed = hotKeyFor(incoming);
        if (claimed)
        {
            // The key is consumed either way -- the combination belongs to
            // the system, not to the window that would have had it -- but a
            // registration that asked for no repeats keeps silent while the
            // keyboard repeats the press on its own.
            const repeated = (incoming.lParam & PREVIOUS_KEY_STATE) !== 0;
            if (!repeated || (claimed.modifiers & MOD_NOREPEAT) === 0)
            {
                postMessage({
                    hwnd: claimed.hwnd,
                    message: WM_HOTKEY,
                    wParam: claimed.id >>> 0,
                    // MAKELONG(fsModifiers, vk), without the repeat rule a
                    // handler was not asked to know about.
                    lParam: ((claimed.vk & 0xffff) << 16
                        | (claimed.modifiers & MOD_HELD)) >>> 0,
                    time: now() >>> 0,
                });
            }
            return;
        }
        const message = router ? router(incoming) : incoming;
        if (!message)
        {
            return;
        }
        // A window's message waits for the thread that made the window. One
        // with no window is the thread's it names, or the poster's own; the
        // input layer's, when nothing claimed it, is whoever looks first.
        const hwnd = message.hwnd >>> 0;
        const thread = message.thread !== undefined ? message.thread
            : hwnd !== 0 ? ownerOf?.(hwnd) ?? null
                : message.x !== undefined ? null : running();
        arrived(thread, classOf(message.message >>> 0));
        if ((message.message >>> 0) === WM_MOUSEMOVE)
        {
            // Replaced in place rather than dropped and re-appended: a move
            // that overtook the keystroke before it would report the button
            // as pressed somewhere the pointer had already left.
            const held = pending.find(entry=>entry.message === WM_MOUSEMOVE
                && entry.hwnd === hwnd && (threadOf.get(entry) ?? null) === thread);
            if (held)
            {
                held.wParam = message.wParam >>> 0;
                held.lParam = message.lParam >>> 0;
                held.time = (message.time ?? 0) >>> 0;
                held.x = (message.x ?? 0) | 0;
                held.y = (message.y ?? 0) | 0;
                if (message.x !== undefined)
                {
                    input.add(held);
                }
                posted++;
                return;
            }
        }
        const entry = {
            hwnd,
            message: message.message >>> 0,
            wParam: message.wParam >>> 0,
            lParam: message.lParam >>> 0,
            time: (message.time ?? 0) >>> 0,
            x: (message.x ?? 0) | 0,
            y: (message.y ?? 0) | 0,
            // Posted by a wide caller: a character in it is a UTF-16 unit.
            ...message.unicode ? { unicode: true } : {},
        };
        if (message.x !== undefined)
        {
            input.add(entry);
        }
        threadOf.set(entry, thread);
        pending.push(entry);
        posted++;
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
        post: postMessage,

        /**
         * Whether a message taken from the queue came from the input layer
         * rather than from a program's post.
         *
         * @param {object} entry
         */
        fromInput: entry=>input.has(entry),

        /**
         * The messages posted and not yet taken, oldest first: what a
         * retrieval looks through before its filter, to settle where a
         * mouse message goes. A copy, so settling one does not move the
         * walk under itself.
         *
         * @param {number | null} [thread]  Whose; the running thread's if left out.
         */
        queued: thread=>{
            const asking = whose(thread);
            return pending.filter(entry=>belongs(entry, asking));
        },

        /** Whether a retrieval's filter takes a message. */
        accepts,

        /**
         * Registers a hot key, or replaces the registration this `hwnd` and
         * `id` already had.
         *
         * The combination -- the virtual key and the modifiers held with it --
         * may belong to one registration only: a second claim on it, even by
         * the same window under another id, is what Windows refuses, and with
         * the error the caller reads back. MOD_NOREPEAT is not part of the
         * combination, which is why two registrations differing only in it
         * collide rather than coexist.
         *
         * @param {number} hwnd  Zero for a hot key belonging to the thread.
         * @param {number} id
         * @param {number} modifiers
         * @param {number} vk
         * @returns {boolean} false when another registration holds the combination
         */
        registerHotKey(hwnd, id, modifiers, vk){
            const key = `${hwnd >>> 0}:${id | 0}`;
            for (const [other, entry] of hotKeys)
            {
                if (other !== key && entry.vk === (vk >>> 0)
                    && (entry.modifiers & MOD_HELD) === (modifiers & MOD_HELD))
                {
                    return false;
                }
            }
            hotKeys.set(key, {
                hwnd: hwnd >>> 0, id: id | 0,
                modifiers: modifiers >>> 0, vk: vk >>> 0,
            });
            return true;
        },

        /**
         * @param {number} hwnd @param {number} id
         * @returns {boolean} false when nothing carried that pair
         */
        unregisterHotKey(hwnd, id){
            return hotKeys.delete(`${hwnd >>> 0}:${id | 0}`);
        },

        /**
         * Drops every hot key a destroyed window registered. Left behind, one
         * would keep swallowing the keystroke for a window nobody can deliver
         * to, taking the key away from whatever is focused now.
         *
         * @param {number} hwnd
         */
        unregisterHotKeysFor(hwnd){
            for (const [key, entry] of hotKeys)
            {
                if (entry.hwnd === (hwnd >>> 0))
                {
                    hotKeys.delete(key);
                }
            }
        },

        /**
         * When the soonest timer comes due, in guest time, or null for none.
         *
         * A thread waiting on an empty queue is waiting for exactly two things:
         * something posted from outside, and a timer of its own -- or a
         * message the window half asked for later, which comes due the same
         * way. The first nobody can predict; the second is written down right
         * here, and without it whoever drives the machine has to keep looking
         * to find out -- on a timeout a browser clamps, several thousand times
         * a run.
         *
         * @returns {number | null}
         */
        nextTimerDue: soonestDue,

        /**
         * @param {number} code  The value the thread's loop ends with.
         * @param {number | null} [thread]  Whose loop; the running thread's if left out.
         */
        postQuit(code, thread){
            const poster = whose(thread);
            quits.set(poster, code | 0);
            arrived(poster, QS_POSTMESSAGE | QS_ALLPOSTMESSAGE);
        },

        /**
         * What is waiting, by class, as GetQueueStatus reports it: `inQueue` is
         * everything there is, `changed` only what has arrived since the last
         * look. Both halves are needed because a program tests them for
         * different things -- "is there anything to pump" against "has anything
         * happened since I last asked".
         *
         * Looking counts as a look: the news of the classes asked about is
         * cleared here, the way a retrieval clears all of it; news of a class
         * not asked about is still news to the next look.
         *
         * @param {number | null} [thread]  Whose queue; the running thread's if left out.
         * @param {number} [asked]  The classes asked about; every one if left out.
         * @returns {{ inQueue: number, changed: number }}
         */
        status(thread, asked = ~0){
            const asking = whose(thread);
            const inQueue = waiting(asking);
            const synthetic = inQueue & (QS_PAINT | QS_TIMER);
            const look = lookOf(asking);
            // Only what is still there: the low word is defined as what arrived
            // *and has not been taken yet*, so a keystroke posted and retrieved
            // between two looks is no longer news.
            const news = (look.changed | (synthetic & ~look.synthetic)) & inQueue;
            look.changed &= ~asked;
            look.at = now();
            look.synthetic = (look.synthetic & ~asked) | (synthetic & asked);
            return { inQueue, changed: news };
        },

        /**
         * The classes waiting now, as GetQueueStatus's high word reports
         * them, without the look that clears the news.
         */
        waiting,

        /**
         * The classes that arrived since the queue was last looked at: what
         * MsgWaitForMultipleObjects wakes for. Asking is not a look -- a
         * wait that ends on news leaves it for the pump that follows -- and a
         * message a look has already seen is no longer news, whether or not
         * it was taken.
         *
         * @param {number | null} [thread]  Whose queue; the running thread's if left out.
         */
        news(thread){
            const asking = whose(thread);
            releaseLater();
            const look = lookOf(asking);
            let fresh = look.changed;
            const at = now();
            for (const [key, timer] of timers)
            {
                if (timer.due > look.at && timer.due <= at && deliverable(key, timer, asking))
                {
                    fresh |= QS_TIMER;
                    break;
                }
            }
            return fresh;
        },

        /**
         * A window has an area to paint where it had none: news of a paint,
         * for the thread that made it.
         *
         * @param {number | null} [thread]
         */
        dirtied(thread = null){
            arrived(thread, QS_PAINT);
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
                thread: (hwnd >>> 0) === 0 ? currentThread() : null,
            });
        },

        /**
         * Whether a timer of this window and id is set -- for a thread
         * timer, one set by the thread asking.
         *
         * @param {number} hwnd @param {number} id
         */
        hasTimer(hwnd, id){
            const key = `${hwnd >>> 0}:${id >>> 0}`;
            const timer = timers.get(key);
            return timer !== undefined && deliverable(key, timer, running());
        },

        /**
         * Whether `proc` is the TIMERPROC of a timer set for this window and
         * id. DispatchMessage asks before calling what a WM_TIMER's lParam
         * names, because a WM_TIMER can be posted by anyone with any lParam,
         * and calling it would run whatever address the poster chose.
         *
         * @param {number} hwnd @param {number} id @param {number} proc
         */
        isTimerProc(hwnd, id, proc){
            const timer = timers.get(`${hwnd >>> 0}:${id >>> 0}`);
            return timer !== undefined && timer.proc !== 0 && timer.proc === (proc >>> 0);
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
         * When the earliest timer, or message asked for later, is due, or
         * null. Whoever is idling the process reads this so that a thread
         * waiting for a message wakes at the right moment rather than at
         * whatever else happens to happen.
         */
        nextDue: soonestDue,

        /**
         * Posts what `make` answers once `delay` milliseconds of guest time
         * have passed, replacing whatever was asked for under `key`. It is
         * posted when the queue is next looked at or waited on from then.
         *
         * @param {string} key @param {number} delay
         * @param {() => PostedMessage | null} make
         */
        postLater(key, delay, make){
            later.set(key, { due: now() + delay, make });
        },

        /** Forgets what was asked for under `key`. @param {string} key */
        cancelLater(key){
            return later.delete(key);
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
            releaseLater();
            const asking = whose(filter.thread);
            const scoped = { ...filter, thread: asking };
            const look = lookOf(asking);
            look.changed = 0;
            look.at = now();
            const index = pending.findIndex(entry=>belongs(entry, asking)
                && accepts(entry, filter));
            if (index >= 0)
            {
                const entry = pending[index];
                if (filter.remove)
                {
                    pending.splice(index, 1);
                    retrieved++;
                    last = entry;
                    if (entry.message === WM_KEYDOWN || entry.message === WM_SYSKEYDOWN
                        || entry.message === WM_KEYUP || entry.message === WM_SYSKEYUP)
                    {
                        keysAsTaken[entry.wParam & 0xff] = entry.message === WM_KEYDOWN
                            || entry.message === WM_SYSKEYDOWN ? 1 : 0;
                        heldKnown = true;
                    }
                    pumped.set(entry.message, (pumped.get(entry.message) ?? 0) + 1);
                }
                return entry;
            }
            // Nothing posted: the quit, which is one of the posted messages
            // as GetQueueStatus counts them (QS_POSTMESSAGE, msg.c
            // test_queue_status), and so comes before what is made up only
            // when nothing else waits -- a window's paint, then a due timer.
            // A window that never validates itself would otherwise keep its
            // program from ever seeing the quit.
            const quitting = quitFor(asking);
            if (quitting !== null)
            {
                const quit = {
                    hwnd: 0,
                    message: WM_QUIT,
                    wParam: quitting[1] >>> 0,
                    lParam: 0,
                    time: 0,
                    x: 0,
                    y: 0,
                };
                if (accepts(quit, filter))
                {
                    if (filter.remove)
                    {
                        quits.delete(quitting[0]);
                        retrieved++;
                        last = quit;
                    }
                    return quit;
                }
            }
            // A window with an area to paint is made up now, then a due
            // timer. Not removed, because retrieval does not paint: the area
            // stays until BeginPaint clears it, and the next look finds it
            // again exactly as Windows would.
            const paint = takePaint(scoped);
            if (paint)
            {
                if (filter.remove)
                {
                    retrieved++;
                    pumped.set(WM_PAINT, (pumped.get(WM_PAINT) ?? 0) + 1);
                }
                return paint;
            }
            const due = takeTimer(scoped);
            if (due && filter.remove)
            {
                last = due;
                pumped.set(WM_TIMER, (pumped.get(WM_TIMER) ?? 0) + 1);
            }
            return due ?? null;
        },

        /** The message most recently taken, or null before the first. */
        last: ()=>last,

        /**
         * Whether a key was down as of the last key message taken, or null
         * before the first: the synchronous state, which moves as the thread
         * takes its key messages rather than as the keys move.
         *
         * @param {number} vk
         */
        heldAsOfMessage: vk=>(heldKnown ? keysAsTaken[vk & 0xff] === 1 : null),

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

        /**
         * Another thread has sent this thread something: news of a sent message.
         *
         * @param {number} thread
         */
        sent(thread){
            arrived(thread, QS_SENDMESSAGE);
        },

        /**
         * Tells the queue how to find whether a thread has been sent a message
         * it has not taken.
         *
         * @param {(thread: number) => boolean} source
         */
        sendsFrom(source){
            sentTo = source;
        },

        /**
         * Tells the queue how to find the thread that created a window, whose
         * queue the window's messages wait in.
         *
         * @param {(hwnd: number) => number | null} owner
         */
        ownersFrom(owner){
            ownerOf = owner;
        },

        /** How many real messages are waiting; a pending quit is not one. */
        depth: ()=>pending.length,

        quitPending: ()=>quits.size > 0,

        diagnostics: ()=>({
            depth: pending.length,
            posted,
            retrieved,
            quitPending: quits.size > 0,
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
            hotKeys: hotKeys.size,
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
