/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createDeadlines } from '../../../system/deadlines.js';

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
 * calling, so nothing of theirs needs the thread: the kernel's clock fires
 * them on the host at their tick (`clockTimer`), as it does a waitable
 * timer. Left to the thread, a tick waited for it to be given the processor,
 * behind a main thread's slice; a sound thread woken by them wrote 98 periods
 * of a hundred a second, and the speaker went short.
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
 * The same loop for an x86-64 process: the five arguments in its convention
 * (RCX, RDX, R8, R9 and the fifth above the callee's home space), the stack a
 * multiple of 16 at each call, every address below 4 GiB.
 *
 *           sub rsp, 0x38
 *     loop: call stub
 *           cmp eax, 0x1000
 *           jb loop
 *           mov ecx, [rax+4]       ; uTimerID
 *           mov edx, [rax+8]       ; uMsg
 *           mov r8d, [rax+12]      ; dwUser
 *           mov r9d, [rax+16]      ; dw1
 *           mov r10d, [rax+20]     ; dw2
 *           mov [rsp+0x20], r10
 *           mov eax, [rax]
 *           call rax
 *           jmp loop
 *
 * @param {number} stub
 * @param {number} at
 * @returns {Uint8Array}
 */
export function longTimerLoopCode(stub, at){
    const relative = (stub - (at + 9)) | 0;
    return new Uint8Array([
        0x48, 0x83, 0xec, 0x38,
        0xe8, relative & 0xff, relative >>> 8 & 0xff,
        relative >>> 16 & 0xff, relative >>> 24 & 0xff,
        ...CMP_LOWEST,
        0x72, 0xf4,
        0x8b, 0x48, 0x04,
        0x8b, 0x50, 0x08,
        0x44, 0x8b, 0x40, 0x0c,
        0x44, 0x8b, 0x48, 0x10,
        0x44, 0x8b, 0x50, 0x14,
        0x4c, 0x89, 0x54, 0x24, 0x20,
        0x8b, 0x00,
        0xff, 0xd0,
        0xeb, 0xd7,
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
 * @property {() => any} [clockTimer]  A timer the kernel's clock fires on the
 *           host (a waitable timer); with the two below, an event timer's.
 * @property {(timer: any, due: number, period: number,
 *             fired: (at: number) => void) => void} [armClockTimer]
 * @property {(timer: any) => void} [cancelClockTimer]
 * @property {(handle: number) => void} setEvent
 * @property {(handle: number) => void} pulseEvent
 * @property {boolean} [long]  The process is an x86-64 one: the loop in its convention.
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
     * @property {() => boolean} [when]  An event set only while this holds.
     * @property {number} slot  Its due time's id in `loop`, the loop's timers
     *     only; -1 for an event timer the kernel's clock fires.
     * @property {any} [clock]  The kernel's timer firing it, for an event timer.
     */
    /** @type {Map<number, Timer>} */
    const timers = new Map();
    /**
     * The due times of the timers the loop fires, by `slot`: a one-shot whose
     * routine is running is out of it, so the loop does not call it twice.
     */
    const loop = createDeadlines();
    /** @type {(Timer | undefined)[]} */
    const bySlot = [];

    /** A timer gone, from the table and the loop. @param {Timer} timer */
    const drop = timer=>{
        if (timers.get(timer.id) !== timer)
        {
            return;
        }
        timers.delete(timer.id);
        if (timer.slot >= 0)
        {
            loop.release(timer.slot);
            bySlot[timer.slot] = undefined;
        }
    };
    let nextId = 1;
    /** @type {any} */
    let thread = null;
    /** The thread while it is parked in the trap, with or without a deadline. */
    /** @type {any} */
    let waiting = null;
    let record = 0;
    let fired = 0;
    /** Periodic ticks passed over because the thread was behind (`advance`). */
    let skipped = 0;
    /**
     * The one-shot timer whose routine the loop is calling. It stays in the
     * table until the loop asks again, which is when the routine has
     * returned: a routine may kill its own timer, as winmm's timer tests do,
     * and is told TIMERR_NOERROR.
     *
     * @type {Timer | null}
     */
    let calling = null;
    /**
     * The kernel's timers of event timers gone, armed again by the next: the
     * kernel keeps every object it made.
     *
     * @type {any[]}
     */
    const spareClocks = [];

    /** @param {number} value */
    const dword = value=>new Uint8Array([
        value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff,
    ]);

    /**
     * How late each tick was fired past its due time, in guest ms, counted
     * under each bound and past the last, and the worst: a tick a whole period
     * late is a refill a sound thread woken by it never makes.
     */
    const late = { under1: 0, under2: 0, under5: 0, under10: 0, more: 0, worstMs: 0 };
    /** @param {number} ms */
    const noteLate = ms=>{
        const key = ms < 1 ? 'under1' : ms < 2 ? 'under2' : ms < 5 ? 'under5'
            : ms < 10 ? 'under10' : 'more';
        late[key]++;
        late.worstMs = Math.max(late.worstMs, Math.round(ms * 10) / 10);
    };

    /**
     * Settles one due timer: a one shot leaves the table, a periodic one is
     * moved on by its period from when it was due, not from now, so a late
     * wake does not stretch every period after it.
     * @param {Timer} timer
     */
    const advance = timer=>{
        fired++;
        noteLate(deps.now() - timer.due);
        if (timer.period > 0)
        {
            timer.due += timer.period;
            // Ticks already gone by are not fired back to back. A callback
            // slower than its period otherwise owed more ticks with every one,
            // and the time-critical thread then took the processor at every
            // turn: a 33 ms timer measured 2.3 s behind and still falling.
            // The next one is the first of the same grid still to come
            // (roadmap/decisions.md).
            const now = deps.now();
            if (timer.due <= now)
            {
                const missed = Math.floor((now - timer.due) / timer.period) + 1;
                timer.due += missed * timer.period;
                skipped += missed;
            }
            loop.move(timer.slot, timer.due);
        }
        else
        {
            drop(timer);
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
            drop(calling);
            calling = null;
        }
        for (;;)
        {
            const slot = loop.first();
            const timer = slot < 0 ? null : /** @type {Timer} */ (bySlot[slot]);
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
                if (!timer.when || timer.when())
                {
                    deps.setEvent(timer.target);
                }
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
                loop.remove(timer.slot);
                calling = timer;
            }
            return record;
        }
    };

    const start = ()=>{
        record = deps.allocate(RECORD.SIZE);
        const stub = deps.register('<mm-timers>', { argBytes: 0, handler: fetch });
        const code = deps.allocate(48);
        deps.writeMemory(code, (deps.long ? longTimerLoopCode : timerLoopCode)(stub, code));
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
         * @param {() => boolean} [when]  for an event the engine sets, the host's own
         *     timer (WASAPI's): the event is set at a tick only while this holds
         * @returns {number} the timer's id, or 0
         */
        set(delay, target, user, flags, when){
            if (delay < 1 || delay > MAX_PERIOD || target === 0 || timers.size >= MAX_TIMERS)
            {
                return 0;
            }
            const id = nextId++;
            /** @type {Timer} */
            const timer = {
                id, due: deps.now() + delay, period: (flags & TIME_PERIODIC) ? delay : 0,
                target, user, flags, when, slot: -1,
            };
            timers.set(id, timer);
            const kind = flags & CALLBACK_MASK;
            if (kind !== 0 && deps.clockTimer && deps.armClockTimer)
            {
                timer.clock = spareClocks.pop() ?? deps.clockTimer();
                deps.armClockTimer(timer.clock, timer.due, timer.period, at=>{
                    fired++;
                    noteLate(deps.now() - at);
                    if (timer.period === 0)
                    {
                        drop(timer);
                        spareClocks.push(timer.clock);
                    }
                    if (kind === TIME_CALLBACK_EVENT_PULSE)
                    {
                        deps.pulseEvent(target);
                    }
                    else if (!when || when())
                    {
                        deps.setEvent(target);
                    }
                });
                return id;
            }
            timer.slot = loop.claim();
            bySlot[timer.slot] = timer;
            loop.add(timer.due, timer.slot);
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
            const timer = timers.get(id);
            if (timer)
            {
                if (timer.clock)
                {
                    deps.cancelClockTimer?.(timer.clock);
                    spareClocks.push(timer.clock);
                }
                drop(timer);
                return 0;
            }
            return id > 0 && id < nextId ? TIMERR_NOCANDO : MMSYSERR_INVALPARAM;
        },

        diagnostics: ()=>({
            started: thread !== null,
            waiting: waiting !== null,
            armed: timers.size,
            fired,
            skipped,
            late: { ...late },
            // Each armed timer's period and how far its next due time lies
            // behind now: a periodic timer whose callbacks take longer than its
            // period falls further behind with every one.
            timers: [...timers.values()].map(timer=>({ id: timer.id, period: timer.period,
                behindMs: Math.round(deps.now() - timer.due) })),
        }),
    };
}
