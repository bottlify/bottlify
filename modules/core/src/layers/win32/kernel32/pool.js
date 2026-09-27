/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The thread pool: callbacks a program asks the system to run for it, on
 * threads it never made -- a timer queue's timers, first of all.
 *
 * Windows runs each on a pool thread of its own, and a program is written
 * against that: a timer's callback that sleeps holds up no other timer, and a
 * deletion asked to wait for callbacks waits for the ones running elsewhere.
 * So the pool keeps threads, grows when every one of them is busy, and hands
 * each callback to an idle one.
 *
 * A pool thread is the wave notice thread's shape (`winmm/thread.js`): a loop
 * of a few guest instructions asks the host for the next callback, calls it,
 * asks again, and asking with nothing to do blocks the thread until a callback
 * is handed to it. The callback is an ordinary call from an ordinary thread,
 * on its own stack, and the loop keeps the record it is handed on that stack
 * too, so each thread has one and nothing is shared between them.
 */

/** A pool this size runs more callbacks at once than a program has reason to ask for. */
const MAX_THREADS = 32;

/** What the asking trap answers when the record holds a callback to run. */
const RUN = 0x10000;
/** What the loop hands the trap after a callback returned, and the first time it asks. */
const RAN = 0x20000;

/** The record a callback is handed through: the routine, then four arguments. */
const RECORD = {
    ENTRY: 0,
    ARGS: 4,
    SIZE: 20,
};

/** CompletionEvent's value for "wait here until the callbacks have finished". */
const INVALID_HANDLE_VALUE = 0xffffffff;

/** Flags of CreateTimerQueueTimer: a timer that fires once whatever its period. */
const WT_EXECUTEONLYONCE = 0x00000008;

/** Codes this surface reports. */
const ERROR_INVALID_HANDLE = 6;
const ERROR_NOT_ENOUGH_MEMORY = 8;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_IO_PENDING = 997;

/**
 * The loop, as x86. `fetch` is the trap and `at` is where these bytes will be,
 * because the call to the trap is relative.
 *
 *            sub esp, 20            ; the record, on this thread's own stack
 *            mov eax, RAN
 *     loop:  push eax               ; what the last call answered
 *            lea ecx, [esp+4]
 *            push ecx               ; where the host writes the next callback
 *            call fetch             ; stdcall: EAX = RUN when the record is filled
 *            cmp eax, RUN
 *            jne loop
 *            mov ebx, esp
 *            push dword [ebx+16]
 *            push dword [ebx+12]
 *            push dword [ebx+8]
 *            push dword [ebx+4]
 *            call dword [ebx]
 *            mov esp, ebx           ; however many of the four the routine took
 *            mov eax, RAN
 *            jmp loop
 *
 * The stack pointer is put back from EBX, which a routine keeps, because the
 * callbacks differ in how many arguments they take and who removes them.
 *
 * @param {number} fetch
 * @param {number} at
 * @returns {Uint8Array}
 */
export function poolLoopCode(fetch, at){
    const relative = (fetch - (at + 19)) | 0;
    /** @param {number} value */
    const dword = value=>
        [value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];
    return new Uint8Array([
        0x83, 0xec, RECORD.SIZE,
        0xb8, ...dword(RAN),
        0x50,
        0x8d, 0x4c, 0x24, 0x04,
        0x51,
        0xe8, ...dword(relative),
        0x3d, ...dword(RUN),
        0x75, 0xee,
        0x89, 0xe3,
        0xff, 0x73, 0x10,
        0xff, 0x73, 0x0c,
        0xff, 0x73, 0x08,
        0xff, 0x73, 0x04,
        0xff, 0x13,
        0x89, 0xdc,
        0xb8, ...dword(RAN),
        0xeb, 0xd5,
    ]);
}

/**
 * @typedef {Object} ThreadPoolHost
 * @property {any} kernel  `createThread`, `block`, `wake`, `currentThread`, the
 *           timers (`createTimer`, `armTimer`, `cancelTimer`), `setEvent`,
 *           `handles` and the guest clock.
 * @property {(name: string, fn: { argBytes: number, handler: Function }) => number} register
 *           Puts a host function behind a guest address: the loop's trap.
 * @property {(bytes: number) => number} allocate
 *           Guest memory for what a program is handed as a handle, which on
 *           Windows is an address too, and 0 when there is none.
 * @property {(bytes: number) => number} [allocateCode]
 *           Pages of their own for the loop (`code-arena.js`).
 * @property {(address: number) => void} [free]
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(thread: any) => void} [threadBlock]
 *           Gives a pool thread its environment block, as CreateThread's are.
 * @property {(thread: any) => any} park  Stops a thread inside a trap.
 * @property {(code: number) => void} setLastError
 */

/**
 * A callback handed to the pool, and whatever counts it as outstanding until
 * it has returned.
 *
 * @typedef {Object} Job
 * @property {number} entry
 * @property {number[]} args
 * @property {Owner} owner
 */

/**
 * @typedef {Object} Waiter
 * @property {any} [thread]  blocked in a deletion that waits
 * @property {any} [event]   a kernel event to set
 * @property {number} until  finished once no more than this many are outstanding
 */

/**
 * Anything whose callbacks a deletion can wait for.
 *
 * @typedef {Object} Owner
 * @property {number} outstanding  handed to the pool and not yet returned
 * @property {Waiter[]} waiters
 * @property {() => void} [settled]  told each time one returns
 */

/**
 * @typedef {Owner & {
 *     handle: number, queue: Queue, callback: number, parameter: number,
 *     period: number, spent: boolean, cancelled: boolean, clock: any }} Timer
 */

/**
 * @typedef {Owner & { handle: number, timers: Set<Timer>, deleting: boolean }} Queue
 */

/**
 * @param {ThreadPoolHost} host
 */
export function createThreadPool(host){
    const { kernel } = host;

    /**
     * @typedef {Object} Worker
     * @property {any} thread
     * @property {number} record
     * @property {Job | null} job
     */

    /** @type {Map<any, Worker>} */
    const workers = new Map();
    /** @type {Worker[]} */
    const idle = [];
    /** @type {Job[]} */
    const backlog = [];
    /** Threads made and not yet at their first question. */
    let starting = 0;
    let loop = 0;
    let ran = 0;

    /** @param {number} value */
    const dword = value=>new Uint8Array([
        value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff,
    ]);

    /** @param {Worker} worker @param {Job} job */
    const give = (worker, job)=>{
        worker.job = job;
        host.writeMemory(worker.record + RECORD.ENTRY, dword(job.entry));
        for (let index = 0; index < 4; index++)
        {
            host.writeMemory(worker.record + RECORD.ARGS + index * 4,
                dword(job.args[index] ?? 0));
        }
    };

    /** @param {Waiter[]} waiters @param {number} outstanding */
    const release = (waiters, outstanding)=>{
        for (const waiter of waiters.filter(each=>outstanding <= each.until))
        {
            waiters.splice(waiters.indexOf(waiter), 1);
            if (waiter.thread)
            {
                kernel.wake(waiter.thread, 1);
            }
            if (waiter.event)
            {
                kernel.setEvent(waiter.event);
            }
        }
    };

    /** @param {Job} job */
    const settle = job=>{
        const { owner } = job;
        owner.outstanding--;
        release(owner.waiters, owner.outstanding);
        owner.settled?.();
    };

    /**
     * The loop's trap: records what the thread just finished, then hands it
     * the next callback or blocks it until there is one.
     *
     * @param {number[]} args
     */
    const fetch = ([record])=>{
        const thread = kernel.currentThread();
        let worker = workers.get(thread);
        if (!worker)
        {
            worker = { thread, record: record >>> 0, job: null };
            workers.set(thread, worker);
            starting = Math.max(0, starting - 1);
        }
        if (worker.job)
        {
            const done = worker.job;
            worker.job = null;
            ran++;
            settle(done);
        }
        const next = backlog.shift();
        if (next)
        {
            give(worker, next);
            return RUN;
        }
        idle.push(worker);
        kernel.block(thread, 'a thread pool callback');
        return host.park(thread);
    };

    const spawn = ()=>{
        if (workers.size + starting >= MAX_THREADS)
        {
            return;
        }
        if (loop === 0)
        {
            const trap = host.register('<thread-pool>', { argBytes: 8, handler: fetch });
            const size = poolLoopCode(0, 0).length;
            const at = (host.allocateCode ?? host.allocate)(size);
            if (at === 0)
            {
                return;
            }
            host.writeMemory(at, poolLoopCode(trap, at));
            loop = at;
        }
        const thread = kernel.createThread({ entry: loop, name: 'thread pool' });
        if (!thread)
        {
            return;
        }
        host.threadBlock?.(thread);
        starting++;
    };

    /**
     * Hands a callback to an idle thread, or to the next one to ask, making
     * one when every thread there is is busy.
     *
     * @param {Job} job
     */
    const dispatch = job=>{
        job.owner.outstanding++;
        const worker = idle.pop();
        if (worker)
        {
            give(worker, job);
            kernel.wake(worker.thread, RUN);
            return;
        }
        backlog.push(job);
        if (backlog.length > starting)
        {
            spawn();
        }
    };

    /**
     * Finishes a deletion as its CompletionEvent asks: INVALID_HANDLE_VALUE
     * waits here for the callbacks, NULL answers at once -- ERROR_IO_PENDING
     * while any is outstanding -- and an event is set once they have all
     * returned. A callback deleting what it belongs to does not wait for
     * itself.
     *
     * @param {Owner} owner @param {number} event @param {number} own
     *     the caller's own callback, when it is one of the owner's
     * @returns {number | any}
     */
    const complete = (owner, event, own)=>{
        const handle = event >>> 0;
        if (handle === INVALID_HANDLE_VALUE)
        {
            if (owner.outstanding <= own)
            {
                return 1;
            }
            const thread = kernel.currentThread();
            owner.waiters.push({ thread, until: own });
            kernel.block(thread, 'a thread pool deletion');
            return host.park(thread);
        }
        if (owner.outstanding === 0)
        {
            if (handle !== 0)
            {
                const signal = eventOf(handle);
                if (signal)
                {
                    kernel.setEvent(signal);
                }
            }
            return 1;
        }
        if (handle !== 0)
        {
            const signal = eventOf(handle);
            if (signal)
            {
                owner.waiters.push({ event: signal, until: 0 });
            }
        }
        host.setLastError(ERROR_IO_PENDING);
        return 0;
    };

    /** @param {number} handle */
    const eventOf = handle=>{
        try
        {
            return kernel.handles.resolve(handle, 'event');
        }
        catch (e){
            void e;
            return null;
        }
    };

    /** The job the calling thread is running, when it is a pool thread. */
    const running = ()=>workers.get(kernel.currentThread())?.job ?? null;

    /** @param {number} code */
    const fail = code=>{
        host.setLastError(code);
        return 0;
    };

    /** @type {Map<number, Queue>} */
    const queues = new Map();
    /** @type {Map<number, Timer>} */
    const timers = new Map();
    /** @type {Queue | null} */
    let defaultQueue = null;
    let fired = 0;

    /** @param {number} handle */
    const makeQueue = handle=>{
        /** @type {Queue} */
        const queue = { handle, timers: new Set(), deleting: false, outstanding: 0, waiters: [] };
        return queue;
    };

    /**
     * What a queue still owes: the callbacks of every timer in it, deleted or
     * not, that have not returned.
     *
     * @param {Queue} queue
     */
    const queueOutstanding = queue=>[...queue.timers]
        .reduce((sum, timer)=>sum + timer.outstanding, 0);

    /** @param {Queue} queue */
    const recount = queue=>{
        queue.outstanding = queueOutstanding(queue);
        release(queue.waiters, queue.outstanding);
        if (queue.deleting && queue.outstanding === 0 && queue.waiters.length === 0
            && queue.handle !== 0)
        {
            host.free?.(queue.handle);
            queue.handle = 0;
        }
    };

    /** @param {Timer} timer */
    const fire = timer=>{
        if (timer.cancelled)
        {
            return;
        }
        if (timer.period === 0)
        {
            timer.spent = true;
        }
        fired++;
        dispatch({ entry: timer.callback, args: [timer.parameter, 1], owner: timer });
    };

    /**
     * Sets when a timer next fires. A due time of zero is now, so the callback
     * is handed over before the call returns: a deletion straight after finds
     * it outstanding, and it still runs, as Windows runs it.
     *
     * @param {Timer} timer @param {number} due @param {number} period
     */
    const arm = (timer, due, period)=>{
        kernel.cancelTimer(timer.clock);
        timer.period = period;
        timer.spent = false;
        const now = kernel.clock.virtualTime();
        if (due === 0)
        {
            fire(timer);
            if (period > 0)
            {
                kernel.armTimer(timer.clock, now + period, period, ()=>fire(timer));
            }
            return;
        }
        kernel.armTimer(timer.clock, now + due, period, ()=>fire(timer));
    };

    /**
     * A timer deleted or its queue: it fires no more, and leaves its queue
     * once its last callback has returned.
     *
     * @param {Timer} timer
     */
    const cancel = timer=>{
        timer.cancelled = true;
        timers.delete(timer.handle);
        kernel.cancelTimer(timer.clock);
        if (timer.outstanding === 0)
        {
            timer.queue.timers.delete(timer);
            host.free?.(timer.handle);
        }
        recount(timer.queue);
    };

    /**
     * @param {number} queueHandle @param {number} callback @param {number} parameter
     * @param {number} due @param {number} period @param {number} flags
     * @returns {Timer | number}  the timer, or the error that refused it
     */
    const createTimer = (queueHandle, callback, parameter, due, period, flags)=>{
        const queue = (queueHandle >>> 0) === 0
            ? defaultQueue ??= makeQueue(0)
            : queues.get(queueHandle >>> 0);
        if (!queue || queue.deleting)
        {
            return ERROR_INVALID_HANDLE;
        }
        if ((callback >>> 0) === 0)
        {
            return ERROR_INVALID_PARAMETER;
        }
        const handle = host.allocate(4);
        if (handle === 0)
        {
            return ERROR_NOT_ENOUGH_MEMORY;
        }
        /** @type {Timer} */
        const timer = {
            handle, queue, callback: callback >>> 0, parameter: parameter >>> 0,
            period: 0, spent: false, cancelled: false, outstanding: 0, waiters: [],
            clock: kernel.createTimer({ name: 'timer queue timer' }),
        };
        timer.settled = ()=>{
            if (timer.cancelled && timer.outstanding === 0 && timer.queue.timers.has(timer))
            {
                timer.queue.timers.delete(timer);
                host.free?.(timer.handle);
            }
            recount(timer.queue);
        };
        timers.set(handle, timer);
        queue.timers.add(timer);
        arm(timer, due >>> 0, (flags & WT_EXECUTEONLYONCE) !== 0 ? 0 : period >>> 0);
        return timer;
    };

    /** @param {number} timerHandle @param {number} event */
    const deleteTimer = (timerHandle, event)=>{
        const timer = timers.get(timerHandle >>> 0);
        if (!timer)
        {
            return fail(ERROR_INVALID_PARAMETER);
        }
        const own = running()?.owner === timer ? 1 : 0;
        cancel(timer);
        return complete(timer, event, own);
    };

    /** @param {number} queueHandle @param {number} event */
    const deleteQueue = (queueHandle, event)=>{
        const queue = queues.get(queueHandle >>> 0);
        if (!queue)
        {
            return fail(ERROR_INVALID_HANDLE);
        }
        queues.delete(queue.handle);
        queue.deleting = true;
        const mine = running()?.owner;
        const own = [...queue.timers].some(timer=>timer === mine) ? 1 : 0;
        for (const timer of [...queue.timers])
        {
            if (!timer.cancelled)
            {
                cancel(timer);
            }
        }
        recount(queue);
        const answer = complete(queue, event, own);
        recount(queue);
        return answer;
    };

    return {
        diagnostics: ()=>({
            threads: workers.size,
            idle: idle.length,
            backlog: backlog.length,
            ran,
            queues: queues.size,
            timers: timers.size,
            fired,
        }),

        table: {
            /** HANDLE CreateTimerQueue(void) */
            CreateTimerQueue: {
                argBytes: 0,
                handler: ()=>{
                    const handle = host.allocate(4);
                    if (handle === 0)
                    {
                        return fail(ERROR_NOT_ENOUGH_MEMORY);
                    }
                    queues.set(handle, makeQueue(handle));
                    return handle;
                },
            },

            /**
             * BOOL CreateTimerQueueTimer(PHANDLE phNewTimer, HANDLE TimerQueue,
             *     WAITORTIMERCALLBACK Callback, PVOID Parameter, DWORD DueTime,
             *     DWORD Period, ULONG Flags)
             *
             * The callback is handed its parameter and TRUE, on a pool thread,
             * DueTime milliseconds from now and then every Period (never again
             * for a period of zero or WT_EXECUTEONLYONCE). No queue is the
             * process's default one. The flags that choose a kind of thread
             * choose nothing here: every callback runs on the pool's.
             */
            CreateTimerQueueTimer: {
                argBytes: 28,
                /** @param {number[]} args */
                handler: ([out, queue, callback, parameter, due, period, flags])=>{
                    if ((out >>> 0) === 0)
                    {
                        return fail(ERROR_INVALID_PARAMETER);
                    }
                    const made = createTimer(queue, callback, parameter, due, period, flags);
                    if (typeof made === 'number')
                    {
                        return fail(made);
                    }
                    host.writeMemory(out >>> 0, dword(made.handle));
                    return 1;
                },
            },

            /**
             * HANDLE SetTimerQueueTimer(HANDLE TimerQueue, WAITORTIMERCALLBACK Callback,
             *     PVOID Parameter, DWORD DueTime, DWORD Period, BOOL PreferIo)
             *
             * The call CreateTimerQueueTimer replaced, answering the timer.
             */
            SetTimerQueueTimer: {
                argBytes: 24,
                /** @param {number[]} args */
                handler: ([queue, callback, parameter, due, period])=>{
                    const made = createTimer(queue, callback, parameter, due, period, 0);
                    return typeof made === 'number' ? fail(made) : made.handle;
                },
            },

            /**
             * BOOL ChangeTimerQueueTimer(HANDLE TimerQueue, HANDLE Timer, ULONG DueTime,
             *     ULONG Period)
             *
             * Re-arms a timer from now. A timer that fires once and has fired is
             * spent: the change is accepted and it stays silent, which is what
             * kernel32's sync tests see of a callback changing its own one-shot.
             * The queue named is not consulted; the timer knows its own.
             */
            ChangeTimerQueueTimer: {
                argBytes: 16,
                /** @param {number[]} args */
                handler: ([, timerHandle, due, period])=>{
                    const timer = timers.get(timerHandle >>> 0);
                    if (!timer)
                    {
                        return fail(ERROR_INVALID_PARAMETER);
                    }
                    if (!timer.spent)
                    {
                        arm(timer, due >>> 0, period >>> 0);
                    }
                    return 1;
                },
            },

            /**
             * BOOL DeleteTimerQueueTimer(HANDLE TimerQueue, HANDLE Timer,
             *     HANDLE CompletionEvent)
             *
             * The timer fires no more. A callback already handed over still
             * runs, and the event says how the caller learns it has returned
             * (`complete`).
             */
            DeleteTimerQueueTimer: {
                argBytes: 12,
                /** @param {number[]} args */
                handler: ([, timerHandle, event])=>deleteTimer(timerHandle, event),
            },

            /** BOOL CancelTimerQueueTimer(HANDLE TimerQueue, HANDLE Timer) */
            CancelTimerQueueTimer: {
                argBytes: 8,
                /** @param {number[]} args */
                handler: ([, timerHandle])=>deleteTimer(timerHandle, 0),
            },

            /**
             * BOOL DeleteTimerQueueEx(HANDLE TimerQueue, HANDLE CompletionEvent)
             *
             * Every timer in the queue, as DeleteTimerQueueTimer deletes one.
             * The default queue is not a queue a program may delete.
             */
            DeleteTimerQueueEx: {
                argBytes: 8,
                /** @param {number[]} args */
                handler: ([queue, event])=>deleteQueue(queue, event),
            },

            /** BOOL DeleteTimerQueue(HANDLE TimerQueue) */
            DeleteTimerQueue: {
                argBytes: 4,
                /** @param {number[]} args */
                handler: ([queue])=>deleteQueue(queue, 0),
            },
        },
    };
}
