/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/** SetThreadPriority's relative value for the highest priority there is. */
const THREAD_PRIORITY_TIME_CRITICAL = 15;

/**
 * Multimedia timers: `timeSetEvent`'s callbacks, on a thread of their own.
 *
 * Windows fires a multimedia timer's routine from a timer thread, at the
 * requested period, whatever the program's own threads are doing -- audio
 * middleware builds its mixing on exactly that. The shape is the wave notice
 * thread's (`thread.js`): a loop of a few guest instructions asks the host for
 * the next routine to call, calls it, asks again. The difference is what the
 * asking trap does with nothing due: it blocks the thread with a deadline, the
 * earliest due time, and the kernel's clock wakes it there. A wake carries a
 * small number, not a record, so the loop tests what it got and asks again.
 *
 * The event forms (`TIME_CALLBACK_EVENT_SET`/`_PULSE`) signal instead of
 * calling; they are settled on the host and the loop only asks again.
 */

/** Guest-side layout of one delivery: the routine, then its five arguments. */
const RECORD = {
    ENTRY: 0,
    ARGS: 4,
    SIZE: 24,
};

/** fuEvent bits: one shot or periodic, and how the timer is reported. */
const TIME_PERIODIC = 0x0001;
const TIME_CALLBACK_EVENT_SET = 0x0010;
const TIME_CALLBACK_EVENT_PULSE = 0x0020;
const CALLBACK_MASK = 0x0030;
/** Below this, what the trap answered was a wake, not a record's address. */
const LOWEST_RECORD = 0x1000;
/** `cmp eax, imm32` with `LOWEST_RECORD`, as the loop's bytes carry it. */
const CMP_LOWEST = [0x3d, LOWEST_RECORD & 0xff, LOWEST_RECORD >>> 8 & 0xff,
    LOWEST_RECORD >>> 16 & 0xff, LOWEST_RECORD >>> 24 & 0xff];
/** MMSYSERR_INVALPARAM: no such timer was ever made. */
const MMSYSERR_INVALPARAM = 11;
/** TIMERR_NOCANDO: the timer was made and is gone -- a one shot that has fired. */
const TIMERR_NOCANDO = 97;
/**
 * How many timers may be armed at once. winmm's timer tests make twenty and
 * expect the last four refused.
 */
const MAX_TIMERS = 16;
/** The longest delay `timeSetEvent` takes, in milliseconds; the shortest is one. */
export const MAX_PERIOD = 1000000;

/**
 * The loop, as x86. `stub` is where the trap lives and `at` is where these
 * bytes will be, because the call to the stub is relative.
 *
 *     loop: call stub              ; EAX = a record, or a wake's own number
 *           cmp eax, 0x1000
 *           jb loop                ; nothing to call: ask again
 *           push dword [eax+20]    ; dw2
 *           push dword [eax+16]    ; dw1
 *           push dword [eax+12]    ; dwUser
 *           push dword [eax+8]     ; uMsg
 *           push dword [eax+4]     ; uTimerID
 *           call dword [eax]       ; stdcall: the routine pops its own arguments
 *           jmp loop
 *
 * @param {number} stub
 * @param {number} at
 * @returns {Uint8Array}
 */
export function timerLoopCode(stub, at){
    const relative = (stub - (at + 5)) | 0;
    return new Uint8Array([
        0xe8, relative & 0xff, relative >>> 8 & 0xff,
        relative >>> 16 & 0xff, relative >>> 24 & 0xff,
        ...CMP_LOWEST,
        0x72, 0xf4,
        0xff, 0x70, 0x14,
        0xff, 0x70, 0x10,
        0xff, 0x70, 0x0c,
        0xff, 0x70, 0x08,
        0xff, 0x70, 0x04,
        0xff, 0x10,
        0xeb, 0xe1,
    ]);
}

/**
 * @typedef {Object} TimerDeps
 * @property {(bytes: number) => number} allocate
 *           Guest memory the processor may execute and the host may write.
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(name: string, fn: { argBytes: number, handler: () => any }) => number} register
 *           Binds the loop's trap; answers the stub's guest address.
 * @property {(options: { entry: number, name: string }) => any} createThread
 * @property {() => any} currentThread
 * @property {(thread: any, reason: string,
 *             timed?: { deadline: number, result: number }) => void} block
 *           Without `timed`, until woken; with it, until the clock reaches
 *           the deadline, when the thread resumes with `result`.
 * @property {(thread: any, result: number) => boolean} wake
 * @property {(thread: any) => any} park
 * @property {() => number} now  Guest milliseconds.
 * @property {(handle: number) => void} setEvent
 * @property {(handle: number) => void} pulseEvent
 */

/**
 * @param {TimerDeps} deps
 */
export function createTimerService(deps){
    /**
     * @typedef {Object} Timer
     * @property {number} id
     * @property {number} due   guest ms
     * @property {number} period  0 for one shot
     * @property {number} target  the routine, or the event handle
     * @property {number} user
     * @property {number} flags
     * @property {boolean} [firing]  A one shot whose routine is running now.
     */
    /** @type {Map<number, Timer>} */
    const timers = new Map();
    let nextId = 1;
    /** @type {any} */
    let thread = null;
    /** The thread while it is parked in the trap, with or without a deadline. */
    /** @type {any} */
    let waiting = null;
    let record = 0;
    let fired = 0;
    /**
     * The one-shot timer whose routine the loop is calling. It stays in the
     * table until the loop asks again, which is when the routine has
     * returned: a routine may kill its own timer, as winmm's timer tests do,
     * and is told TIMERR_NOERROR.
     *
     * @type {Timer | null}
     */
    let calling = null;

    /** @param {number} value */
    const dword = value=>new Uint8Array([
        value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff,
    ]);

    /** The timer due soonest, or null. */
    const earliest = ()=>{
        /** @type {Timer | null} */
        let found = null;
        for (const timer of timers.values())
        {
            if (timer.firing)
            {
                continue;
            }
            if (found === null || timer.due < found.due)
            {
                found = timer;
            }
        }
        return found;
    };

    /**
     * Settles one due timer: a one shot leaves the table, a periodic one is
     * moved on by its period from when it was due, not from now, so a late
     * wake does not stretch every period after it.
     * @param {Timer} timer
     */
    const advance = timer=>{
        fired++;
        if (timer.period > 0)
        {
            timer.due += timer.period;
        }
        else
        {
            timers.delete(timer.id);
        }
    };

    /**
     * What the loop's trap answers: a record to call, or a wake once something
     * is due (the loop asks again), or the parked token meanwhile.
     */
    const fetch = ()=>{
        const me = deps.currentThread();
        if (calling !== null)
        {
            timers.delete(calling.id);
            calling = null;
        }
        for (;;)
        {
            const timer = earliest();
            if (timer === null)
            {
                waiting = me;
                deps.block(me, 'a multimedia timer');
                return deps.park(me);
            }
            const now = deps.now();
            if (timer.due > now)
            {
                waiting = me;
                deps.block(me, 'a multimedia timer', { deadline: timer.due, result: 0 });
                return deps.park(me);
            }
            const kind = timer.flags & CALLBACK_MASK;
            if (kind === TIME_CALLBACK_EVENT_SET)
            {
                deps.setEvent(timer.target);
                advance(timer);
                continue;
            }
            if (kind === TIME_CALLBACK_EVENT_PULSE)
            {
                deps.pulseEvent(timer.target);
                advance(timer);
                continue;
            }
            deps.writeMemory(record + RECORD.ENTRY, dword(timer.target));
            [timer.id, 0, timer.user, 0, 0].forEach((value, index)=>
                deps.writeMemory(record + RECORD.ARGS + index * 4, dword(value)));
            if (timer.period > 0)
            {
                advance(timer);
            }
            else
            {
                fired++;
                timer.firing = true;
                calling = timer;
            }
            return record;
        }
    };

    const start = ()=>{
        record = deps.allocate(RECORD.SIZE);
        const stub = deps.register('<mm-timers>', { argBytes: 0, handler: fetch });
        const code = deps.allocate(31);
        deps.writeMemory(code, timerLoopCode(stub, code));
        thread = deps.createThread({ entry: code, name: 'winmm-timer' });
        // Windows runs the multimedia timer thread time-critical: a callback
        // that refills a sound buffer is due at its tick, not after whatever
        // else is running.
        if (thread)
        {
            thread.priority = THREAD_PRIORITY_TIME_CRITICAL;
        }
    };

    return {
        /**
         * MMRESULT timeSetEvent(UINT uDelay, UINT uResolution, LPTIMECALLBACK lpTimeProc,
         *                       DWORD_PTR dwUser, UINT fuEvent)
         *
         * @param {number} delay @param {number} target @param {number} user
         * @param {number} flags
         * @returns {number} the timer's id, or 0
         */
        set(delay, target, user, flags){
            if (delay < 1 || delay > MAX_PERIOD || target === 0 || timers.size >= MAX_TIMERS)
            {
                return 0;
            }
            const id = nextId++;
            timers.set(id, {
                id, due: deps.now() + delay, period: (flags & TIME_PERIODIC) ? delay : 0,
                target, user, flags,
            });
            if (thread === null)
            {
                start();
            }
            else if (waiting !== null)
            {
                // Parked for a later deadline, or for nothing: either way the
                // thread must look at the table again.
                const woken = waiting;
                waiting = null;
                deps.wake(woken, 0);
            }
            return id;
        },

        /** MMRESULT timeKillEvent(UINT uTimerID) @param {number} id */
        kill(id){
            if (timers.delete(id))
            {
                return 0;
            }
            return id > 0 && id < nextId ? TIMERR_NOCANDO : MMSYSERR_INVALPARAM;
        },

        diagnostics: ()=>({
            started: thread !== null,
            waiting: waiting !== null,
            armed: timers.size,
            fired,
        }),
    };
}
