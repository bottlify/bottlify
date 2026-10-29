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
 * It grows by one thread at a time: while callbacks wait, one more thread is
 * starting, and the next once that one has taken its first. Callbacks that
 * return at once are run by the threads already there, as Windows' pool adds
 * threads only while its own stay busy; a thread for every callback queued at
 * once took a stack each and kept it, and a hundred work items left no room
 * for the next thread a program made.
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
/** A wait with no time-out. */
const INFINITE = 0xffffffff;
/** Milliseconds between 1601 and 1970, what a FILETIME counts from. */
const FILETIME_EPOCH_MS = 11644473600000;

/** Flags of CreateTimerQueueTimer: a timer that fires once whatever its period. */
const WT_EXECUTEONLYONCE = 0x00000008;
/** A registered wait's callback runs on the wait thread rather than the pool's. */
const WT_EXECUTEINWAITTHREAD = 0x00000004;

/** What a wait answers: the object signalled, abandoned, or the time out. */
const WAIT_OBJECT_0 = 0;
const WAIT_ABANDONED = 0x80;
const WAIT_TIMEOUT = 0x102;

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
 * The loop of a registered wait's thread, as x86: the wait handle is the
 * thread's parameter, kept in EBX across the two traps.
 *
 *            mov ebx, [esp+4]
 *     loop:  push ebx
 *            call wait              ; stdcall: the wait on the object, its answer in EAX
 *            push eax
 *            push ebx
 *            call after             ; stdcall: the callback handed to the pool; 0 to stop
 *            test eax, eax
 *            jnz loop
 *            ret 4
 *
 * @param {number} wait @param {number} after @param {number} at
 * @returns {Uint8Array}
 */
export function waitLoopCode(wait, after, at){
    /** @param {number} value */
    const dword = value=>
        [value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];
    return new Uint8Array([
        0x8b, 0x5c, 0x24, 0x04,
        0x53,
        0xe8, ...dword((wait - (at + 10)) | 0),
        0x50,
        0x53,
        0xe8, ...dword((after - (at + 17)) | 0),
        0x85, 0xc0,
        0x75, 0xef,
        0xc2, 0x04, 0x00,
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
 * @property {(address: number, length: number) => Uint8Array} [readMemory]
 *           Where a thread pool timer's or wait's FILETIME is read from;
 *           absent, a due time named is taken for now.
 * @property {() => number} [wallClock]  Milliseconds since 1970, which an
 *           absolute due time is counted against; absent, the guest's clock.
 * @property {(thread: any) => void} [threadBlock]
 *           Gives a pool thread its environment block, as CreateThread's are.
 * @property {(thread: any) => any} park  Stops a thread inside a trap.
 * @property {(code: number) => void} setLastError
 * @property {(handle: number, milliseconds: number) => any} [waitFor]
 *           WaitForSingleObject, from inside a trap: its answer, or the park
 *           that answers it later. Absent, no wait can be registered.
 * @property {() => number} [threadReturn]  Where a thread that returns ends.
 * @property {() => number} [threadStart]
 *           Where a pool thread begins, as CreateThread's do: the libraries
 *           told of it, then its loop. Zero, or absent, and it begins in its loop.
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
 * @typedef {Owner & { handle: number, object: number, callback: number, context: number,
 *     timeout: number, once: boolean, inWaitThread: boolean, cancelled: boolean,
 *     left: boolean, owner?: Owner, argsFor?: (result: number) => number[] }} Wait
 *     `left`: its thread is out of its loop, and asks for it by its handle no more.
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
     * @property {Lane} lane
     */

    /**
     * Threads that take callbacks from one backlog: the pool's, and the wait
     * thread's, which runs a WT_EXECUTEINWAITTHREAD callback where Windows
     * runs it -- on the one thread its waits share, one callback after the
     * other.
     *
     * @typedef {Object} Lane
     * @property {string} name
     * @property {number} max  threads at most
     * @property {number} threads  made, started or not
     * @property {Worker[]} idle
     * @property {Job[]} backlog
     * @property {number} starting  made and not yet at their first question
     */

    /** @param {string} name @param {number} max @returns {Lane} */
    const makeLane = (name, max)=>({ name, max, threads: 0, idle: [], backlog: [], starting: 0 });
    const poolLane = makeLane('thread pool', MAX_THREADS);
    const waitLane = makeLane('wait thread', 1);

    /** @type {Map<any, Worker>} */
    const workers = new Map();
    /** The lane of each thread made and not yet at its first question. */
    /** @type {Map<any, Lane>} */
    const lanes = new Map();
    let loop = 0;

    /**
     * A thread of the pool's, begun as every thread is: the libraries are
     * told of it before its loop runs.
     *
     * @param {{ entry: number, parameter?: number, name: string, returnTo?: number }} options
     */
    const makeThread = options=>{
        const begin = host.threadStart?.() ?? 0;
        return kernel.createThread(begin === 0
            ? options
            : { ...options, entry: begin, start: options.entry });
    };
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
            const lane = lanes.get(thread) ?? poolLane;
            lanes.delete(thread);
            worker = { thread, record: record >>> 0, job: null, lane };
            workers.set(thread, worker);
            lane.starting = Math.max(0, lane.starting - 1);
        }
        const { lane } = worker;
        if (worker.job)
        {
            const done = worker.job;
            worker.job = null;
            ran++;
            settle(done);
        }
        const next = lane.backlog.shift();
        if (next)
        {
            give(worker, next);
            grow(lane);
            return RUN;
        }
        lane.idle.push(worker);
        kernel.block(thread, 'a thread pool callback');
        return host.park(thread);
    };

    /** @param {Lane} lane */
    const spawn = lane=>{
        if (lane.threads >= lane.max)
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
        const thread = makeThread({ entry: loop, name: lane.name });
        if (!thread)
        {
            return;
        }
        host.threadBlock?.(thread);
        lanes.set(thread, lane);
        lane.threads++;
        lane.starting++;
    };

    /**
     * One more thread, while callbacks wait and none is on its way to them.
     *
     * @param {Lane} lane
     */
    const grow = lane=>{
        if (lane.backlog.length > 0 && lane.starting === 0)
        {
            spawn(lane);
        }
    };

    /**
     * Hands a callback to an idle thread of its lane, or to the next one to
     * ask, making one when every thread there is is busy.
     *
     * @param {Job} job @param {Lane} [lane]
     */
    const dispatch = (job, lane = poolLane)=>{
        job.owner.outstanding++;
        const worker = lane.idle.pop();
        if (worker)
        {
            give(worker, job);
            kernel.wake(worker.thread, RUN);
            return;
        }
        lane.backlog.push(job);
        grow(lane);
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

    /** A closed work object with nothing outstanding is given back. @param {number} handle */
    const forgetWork = handle=>{
        const work = works.get(handle);
        if (work && work.closed && work.outstanding === 0)
        {
            works.delete(handle);
            host.free?.(handle);
        }
    };

    /** The instance a simple callback is handed, one for all of them. */
    let simple = 0;
    const simpleInstance = ()=>(simple ||= host.allocate(4));

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
    /** What QueueUserWorkItem's callbacks count against: nothing waits for them. */
    /** @type {Owner} */
    const workItems = { outstanding: 0, waiters: [] };

    /**
     * The work objects of the thread pool API (CreateThreadpoolWork), each
     * its own owner: a wait for its callbacks waits for its own alone.
     *
     * @type {Map<number, Owner & { callback: number, context: number, instance: number,
     *     closed: boolean }>}
     */
    const works = new Map();

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

    /** @type {Map<number, Wait>} */
    const waits = new Map();
    let waitLoop = 0;

    /**
     * A wait unregistered is let go once its callbacks have returned and its
     * thread has left its loop. Its handle is an address, which the next
     * registration may be given: freed while the thread still waited, the
     * thread woke into the new wait and ran its callback as its own.
     *
     * @param {Wait} wait
     */
    const forget = wait=>{
        if (wait.cancelled && wait.left && wait.outstanding === 0
            && waits.get(wait.handle) === wait)
        {
            waits.delete(wait.handle);
            host.free?.(wait.handle);
        }
    };

    /** The wait's thread asks: the wait on its object, or abandoned once unregistered. */
    const waitStep = (/** @type {number[]} */ [handle])=>{
        const wait = waits.get(handle >>> 0);
        return wait && !wait.cancelled
            ? /** @type {NonNullable<ThreadPoolHost['waitFor']>} */ (host.waitFor)(
                wait.object, wait.timeout)
            : WAIT_ABANDONED;
    };

    /**
     * The wait answered: the callback handed to the pool -- the object
     * signalled or abandoned FALSE, the time out TRUE, as its TimerOrWaitFired
     * says -- and whether to wait again.
     */
    const waitDone = (/** @type {number[]} */ [handle, answer])=>{
        const wait = waits.get(handle >>> 0);
        const result = answer >>> 0;
        if (!wait)
        {
            return 0;
        }
        if (wait.cancelled || result !== WAIT_OBJECT_0 && result !== WAIT_ABANDONED
            && result !== WAIT_TIMEOUT)
        {
            wait.left = true;
            forget(wait);
            return 0;
        }
        dispatch({ entry: wait.callback,
            args: wait.argsFor?.(result) ?? [wait.context, result === WAIT_TIMEOUT ? 1 : 0],
            owner: wait.owner ?? wait },
        wait.inWaitThread ? waitLane : poolLane);
        wait.left = wait.once;
        return wait.once ? 0 : 1;
    };

    /**
     * A wait with a thread of its own, its callback run on the pool's.
     *
     * @param {number} object @param {number} callback @param {number} context
     * @param {number} timeout @param {number} flags
     * @returns {Wait | number}  the wait, or the error that refused it
     */
    const registerWait = (object, callback, context, timeout, flags)=>{
        if (!host.waitFor || (callback >>> 0) === 0)
        {
            return ERROR_INVALID_PARAMETER;
        }
        if (waitLoop === 0)
        {
            const step = host.register('<registered-wait>', { argBytes: 4, handler: waitStep });
            const done = host.register('<registered-wait-done>',
                { argBytes: 8, handler: waitDone });
            const size = waitLoopCode(0, 0, 0).length;
            const at = (host.allocateCode ?? host.allocate)(size);
            if (at === 0)
            {
                return ERROR_NOT_ENOUGH_MEMORY;
            }
            host.writeMemory(at, waitLoopCode(step, done, at));
            waitLoop = at;
        }
        const handle = host.allocate(4);
        if (handle === 0)
        {
            return ERROR_NOT_ENOUGH_MEMORY;
        }
        /** @type {Wait} */
        const wait = { handle, object: object >>> 0, callback: callback >>> 0,
            context: context >>> 0, timeout: timeout >>> 0,
            once: (flags & WT_EXECUTEONLYONCE) !== 0,
            inWaitThread: (flags & WT_EXECUTEINWAITTHREAD) !== 0, cancelled: false, left: false,
            outstanding: 0, waiters: [] };
        wait.settled = ()=>forget(wait);
        const thread = makeThread({ entry: waitLoop, parameter: handle,
            name: 'registered wait', returnTo: host.threadReturn?.() });
        if (!thread)
        {
            host.free?.(handle);
            return ERROR_NOT_ENOUGH_MEMORY;
        }
        host.threadBlock?.(thread);
        waits.set(handle, wait);
        return wait;
    };

    /**
     * No more callbacks: the wait's thread stops at its next answer.
     * ponytail: one blocked on an object never signalled stays blocked; wake
     * it once the kernel can withdraw a thread from a wait.
     *
     * @param {number} waitHandle @param {number} event
     */
    const unregisterWait = (waitHandle, event)=>{
        const wait = waits.get(waitHandle >>> 0);
        if (!wait || wait.cancelled)
        {
            return fail(ERROR_INVALID_HANDLE);
        }
        wait.cancelled = true;
        const own = running()?.owner === wait ? 1 : 0;
        // Its own callback on the wait thread is the only one of it that can
        // be running there, so nothing is left pending (Wine's kernel32
        // test_RegisterWaitForSingleObject); one on the pool's is pending, as
        // a timer's own callback deleting it is.
        const answer = own === 1 && wait.inWaitThread && (event >>> 0) === 0 ? 1
            : complete(wait, event, own);
        forget(wait);
        return answer;
    };

    /**
     * A due time or time-out a thread pool timer or wait is handed, in
     * milliseconds from now: a FILETIME below zero is relative, in 100 ns
     * units; zero is now; above zero, a moment of the wall clock.
     *
     * @param {number} pointer
     */
    const dueIn = pointer=>{
        if (!host.readMemory)
        {
            return 0;
        }
        const bytes = host.readMemory(pointer, 8);
        const value = new DataView(bytes.buffer, bytes.byteOffset, 8).getBigInt64(0, true);
        if (value <= 0n)
        {
            return Number(-value / 10000n);
        }
        const now = host.wallClock?.() ?? kernel.clock.wallClock?.() ?? 0;
        return Math.max(0, Number(value / 10000n) - FILETIME_EPOCH_MS - now);
    };

    /**
     * The thread pool API's timers (CreateThreadpoolTimer): a callback handed
     * its instance, its context and the timer, each its own owner.
     *
     * @type {Map<number, Owner & { callback: number, context: number, instance: number,
     *     closed: boolean, armed: boolean, clock: any }>}
     */
    const poolTimers = new Map();
    /**
     * The thread pool API's waits (CreateThreadpoolWait): each set is a
     * registered wait of its own that fires once.
     *
     * @type {Map<number, Owner & { callback: number, context: number, instance: number,
     *     closed: boolean, registered: Wait | null }>}
     */
    const poolWaits = new Map();

    /** A closed timer or wait with nothing outstanding is given back. */
    const forgetPooled = (/** @type {Map<number, any>} */ table, /** @type {number} */ handle)=>{
        const owner = table.get(handle);
        if (owner && owner.closed && owner.outstanding === 0)
        {
            table.delete(handle);
            host.free?.(handle);
        }
    };

    /** @param {number} handle */
    const stopTimer = handle=>{
        const timer = poolTimers.get(handle);
        if (timer)
        {
            kernel.cancelTimer(timer.clock);
            timer.armed = false;
        }
        return timer;
    };

    /** @param {number} handle */
    const stopWait = handle=>{
        const wait = poolWaits.get(handle);
        const registered = wait?.registered;
        if (registered && !registered.cancelled)
        {
            registered.cancelled = true;
            forget(registered);
        }
        if (wait)
        {
            wait.registered = null;
        }
        return wait;
    };

    /**
     * The calls a pending callback of an owner is dropped from the backlog
     * by, then the owner's callbacks waited for, as WaitForThreadpoolWork-
     * Callbacks does.
     *
     * @param {Owner | undefined} owner @param {number} dropPending
     */
    const waitForOwner = (owner, dropPending)=>{
        if (!owner)
        {
            return 0;
        }
        if (dropPending !== 0)
        {
            const kept = poolLane.backlog.filter(job=>job.owner !== owner);
            owner.outstanding -= poolLane.backlog.length - kept.length;
            poolLane.backlog.splice(0, poolLane.backlog.length, ...kept);
        }
        const own = running()?.owner === owner ? 1 : 0;
        const done = complete(owner, INVALID_HANDLE_VALUE, own);
        return done === 1 ? 0 : done;
    };

    return {
        diagnostics: ()=>({
            threads: workers.size,
            idle: poolLane.idle.length + waitLane.idle.length,
            backlog: poolLane.backlog.length + waitLane.backlog.length,
            ran,
            queues: queues.size,
            timers: timers.size,
            waits: waits.size,
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

            /**
             * BOOL RegisterWaitForSingleObject(PHANDLE phNewWaitObject, HANDLE hObject,
             *     WAITORTIMERCALLBACK Callback, PVOID Context, ULONG dwMilliseconds,
             *     ULONG dwFlags)
             *
             * The callback is handed its context and whether the time ran out,
             * on a pool thread, each time the object is signalled or the time
             * runs out -- once only with WT_EXECUTEONLYONCE. With
             * WT_EXECUTEINWAITTHREAD it runs on the wait thread, which every
             * such wait shares, so their callbacks run one after another. The
             * other flags that choose a kind of thread choose nothing here.
             */
            RegisterWaitForSingleObject: {
                argBytes: 24,
                /** @param {number[]} args */
                handler: ([out, object, callback, context, timeout, flags])=>{
                    if ((out >>> 0) === 0)
                    {
                        return fail(ERROR_INVALID_PARAMETER);
                    }
                    const made = registerWait(object, callback, context, timeout, flags);
                    if (typeof made === 'number')
                    {
                        return fail(made);
                    }
                    host.writeMemory(out >>> 0, dword(made.handle));
                    return 1;
                },
            },

            /**
             * HANDLE RegisterWaitForSingleObjectEx(HANDLE hObject, WAITORTIMERCALLBACK
             *     Callback, PVOID Context, ULONG dwMilliseconds, ULONG dwFlags)
             *
             * The same, answering the wait's handle, NULL when refused.
             */
            RegisterWaitForSingleObjectEx: {
                argBytes: 20,
                /** @param {number[]} args */
                handler: ([object, callback, context, timeout, flags])=>{
                    const made = registerWait(object, callback, context, timeout, flags);
                    return typeof made === 'number' ? fail(made) : made.handle;
                },
            },

            /**
             * BOOL UnregisterWaitEx(HANDLE WaitHandle, HANDLE CompletionEvent)
             *
             * No callback is handed over after it; one already handed over
             * still runs, and the event says how the caller learns it has
             * returned (`complete`).
             */
            UnregisterWaitEx: {
                argBytes: 8,
                /** @param {number[]} args */
                handler: ([waitHandle, event])=>unregisterWait(waitHandle, event),
            },

            /** BOOL UnregisterWait(HANDLE WaitHandle): ERROR_IO_PENDING while a callback runs. */
            UnregisterWait: {
                argBytes: 4,
                /** @param {number[]} args */
                handler: ([waitHandle])=>unregisterWait(waitHandle, 0),
            },

            /**
             * BOOL QueueUserWorkItem(LPTHREAD_START_ROUTINE Function, PVOID Context,
             *     ULONG Flags)
             *
             * The routine is handed its context on a pool thread, as a timer's
             * callback is. The flags that choose a kind of thread choose
             * nothing here: every work item runs on the pool's.
             */
            /**
             * PTP_POOL CreateThreadpool(PVOID reserved) and
             * VOID CloseThreadpool(PTP_POOL): a pool of its own is the
             * process's here, whose threads every callback shares.
             */
            CreateThreadpool: {
                argBytes: 4,
                handler: ()=>{
                    const pool = host.allocate(4);
                    return pool === 0 ? fail(ERROR_NOT_ENOUGH_MEMORY) : pool;
                },
            },
            CloseThreadpool: {
                argBytes: 4,
                /** @param {number[]} args */
                handler: ([pool])=>{
                    host.free?.(pool >>> 0);
                    return 0;
                },
            },

            /**
             * PTP_WORK CreateThreadpoolWork(PTP_WORK_CALLBACK, PVOID, PTP_CALLBACK_ENVIRON)
             *
             * A callback each submission runs once on a pool thread, handed
             * its instance, its context and the work.
             */
            CreateThreadpoolWork: {
                argBytes: 12,
                /** @param {number[]} args */
                handler: ([callback, context])=>{
                    if ((callback >>> 0) === 0)
                    {
                        return fail(ERROR_INVALID_PARAMETER);
                    }
                    const handle = host.allocate(8);
                    if (handle === 0)
                    {
                        return fail(ERROR_NOT_ENOUGH_MEMORY);
                    }
                    works.set(handle, { callback: callback >>> 0, context: context >>> 0,
                        instance: handle + 4, closed: false, outstanding: 0, waiters: [],
                        settled: ()=>forgetWork(handle) });
                    return handle;
                },
            },

            /** VOID SubmitThreadpoolWork(PTP_WORK) */
            SubmitThreadpoolWork: {
                argBytes: 4,
                /** @param {number[]} args */
                handler: ([handle])=>{
                    const work = works.get(handle >>> 0);
                    if (work && !work.closed)
                    {
                        dispatch({ entry: work.callback, args: [work.instance, work.context,
                            handle >>> 0], owner: work });
                    }
                    return 0;
                },
            },

            /**
             * VOID WaitForThreadpoolWorkCallbacks(PTP_WORK, BOOL fCancelPendingCallbacks)
             *
             * Returns once every submission has run; those not yet started
             * are dropped first where asked. One of its own callbacks asking
             * does not wait for itself.
             */
            WaitForThreadpoolWorkCallbacks: {
                argBytes: 8,
                /** @param {number[]} args */
                handler: ([handle, dropPending])=>{
                    const work = works.get(handle >>> 0);
                    if (!work)
                    {
                        return 0;
                    }
                    if (dropPending !== 0)
                    {
                        const kept = poolLane.backlog.filter(job=>job.owner !== work);
                        work.outstanding -= poolLane.backlog.length - kept.length;
                        poolLane.backlog.splice(0, poolLane.backlog.length, ...kept);
                    }
                    const own = running()?.owner === work ? 1 : 0;
                    const done = complete(work, INVALID_HANDLE_VALUE, own);
                    return done === 1 ? 0 : done;
                },
            },

            /** VOID CloseThreadpoolWork(PTP_WORK): gone once its callbacks have run. */
            CloseThreadpoolWork: {
                argBytes: 4,
                /** @param {number[]} args */
                handler: ([handle])=>{
                    const work = works.get(handle >>> 0);
                    if (work)
                    {
                        work.closed = true;
                        forgetWork(handle >>> 0);
                    }
                    return 0;
                },
            },

            /**
             * BOOL TrySubmitThreadpoolCallback(PTP_SIMPLE_CALLBACK, PVOID,
             *     PTP_CALLBACK_ENVIRON): one callback, handed its instance and
             * its context.
             */
            TrySubmitThreadpoolCallback: {
                argBytes: 12,
                /** @param {number[]} args */
                handler: ([callback, context])=>{
                    if ((callback >>> 0) === 0)
                    {
                        return fail(ERROR_INVALID_PARAMETER);
                    }
                    dispatch({ entry: callback >>> 0, args: [simpleInstance(), context >>> 0],
                        owner: workItems });
                    return 1;
                },
            },

            /**
             * PTP_TIMER CreateThreadpoolTimer(PTP_TIMER_CALLBACK pfnti, PVOID pv,
             *     PTP_CALLBACK_ENVIRON pcbe)
             */
            CreateThreadpoolTimer: {
                argBytes: 12,
                /** @param {number[]} args */
                handler: ([callback, context])=>{
                    if ((callback >>> 0) === 0)
                    {
                        return fail(ERROR_INVALID_PARAMETER);
                    }
                    const handle = host.allocate(8);
                    if (handle === 0)
                    {
                        return fail(ERROR_NOT_ENOUGH_MEMORY);
                    }
                    poolTimers.set(handle, { callback: callback >>> 0, context: context >>> 0,
                        instance: handle + 4, closed: false, armed: false, outstanding: 0,
                        waiters: [], settled: ()=>forgetPooled(poolTimers, handle),
                        clock: kernel.createTimer({ name: 'thread pool timer' }) });
                    return handle;
                },
            },

            /**
             * VOID SetThreadpoolTimer(PTP_TIMER pti, PFILETIME pftDueTime, DWORD msPeriod,
             *     DWORD msWindowLength)
             *
             * Sets the timer anew, or with no due time stops it; a callback
             * already handed over still runs. The window a callback may be
             * put off by is the timer's to use and is not used.
             */
            SetThreadpoolTimer: {
                argBytes: 16,
                /** @param {number[]} args */
                handler: ([handle, due, period])=>{
                    const timer = stopTimer(handle >>> 0);
                    if (!timer || timer.closed || (due >>> 0) === 0)
                    {
                        return 0;
                    }
                    const expire = ()=>{
                        timer.armed = (period >>> 0) !== 0;
                        dispatch({ entry: timer.callback,
                            args: [timer.instance, timer.context, handle >>> 0], owner: timer });
                    };
                    const wait = dueIn(due >>> 0);
                    timer.armed = true;
                    kernel.armTimer(timer.clock, kernel.clock.virtualTime() + wait,
                        period >>> 0, expire);
                    return 0;
                },
            },

            /** BOOL IsThreadpoolTimerSet(PTP_TIMER pti) */
            IsThreadpoolTimerSet: {
                argBytes: 4,
                /** @param {number[]} args */
                handler: ([handle])=>(poolTimers.get(handle >>> 0)?.armed ? 1 : 0),
            },

            /** VOID WaitForThreadpoolTimerCallbacks(PTP_TIMER, BOOL fCancelPendingCallbacks) */
            WaitForThreadpoolTimerCallbacks: {
                argBytes: 8,
                /** @param {number[]} args */
                handler: ([handle, dropPending])=>
                    waitForOwner(poolTimers.get(handle >>> 0), dropPending),
            },

            /** VOID CloseThreadpoolTimer(PTP_TIMER): stopped, gone once its callbacks ran. */
            CloseThreadpoolTimer: {
                argBytes: 4,
                /** @param {number[]} args */
                handler: ([handle])=>{
                    const timer = stopTimer(handle >>> 0);
                    if (timer)
                    {
                        timer.closed = true;
                        forgetPooled(poolTimers, handle >>> 0);
                    }
                    return 0;
                },
            },

            /**
             * PTP_WAIT CreateThreadpoolWait(PTP_WAIT_CALLBACK pfnwa, PVOID pv,
             *     PTP_CALLBACK_ENVIRON pcbe)
             */
            CreateThreadpoolWait: {
                argBytes: 12,
                /** @param {number[]} args */
                handler: ([callback, context])=>{
                    if ((callback >>> 0) === 0)
                    {
                        return fail(ERROR_INVALID_PARAMETER);
                    }
                    const handle = host.allocate(8);
                    if (handle === 0)
                    {
                        return fail(ERROR_NOT_ENOUGH_MEMORY);
                    }
                    poolWaits.set(handle, { callback: callback >>> 0, context: context >>> 0,
                        instance: handle + 4, closed: false, registered: null, outstanding: 0,
                        waiters: [], settled: ()=>forgetPooled(poolWaits, handle) });
                    return handle;
                },
            },

            /**
             * VOID SetThreadpoolWait(PTP_WAIT pwa, HANDLE h, PFILETIME pftTimeout)
             *
             * One wait on the object: the callback is handed its instance,
             * its context, the wait and WAIT_OBJECT_0, WAIT_ABANDONED_0 or
             * WAIT_TIMEOUT, once. No object stops the wait; no time-out
             * waits for ever.
             */
            SetThreadpoolWait: {
                argBytes: 12,
                /** @param {number[]} args */
                handler: ([handle, object, timeout])=>{
                    const wait = stopWait(handle >>> 0);
                    if (!wait || wait.closed || (object >>> 0) === 0)
                    {
                        return 0;
                    }
                    const made = registerWait(object, wait.callback, wait.context,
                        (timeout >>> 0) === 0 ? INFINITE : dueIn(timeout >>> 0),
                        WT_EXECUTEONLYONCE);
                    if (typeof made === 'number')
                    {
                        return 0;
                    }
                    made.owner = wait;
                    made.argsFor = result=>[wait.instance, wait.context, handle >>> 0, result];
                    wait.registered = made;
                    return 0;
                },
            },

            /** VOID WaitForThreadpoolWaitCallbacks(PTP_WAIT, BOOL fCancelPendingCallbacks) */
            WaitForThreadpoolWaitCallbacks: {
                argBytes: 8,
                /** @param {number[]} args */
                handler: ([handle, dropPending])=>
                    waitForOwner(poolWaits.get(handle >>> 0), dropPending),
            },

            /** VOID CloseThreadpoolWait(PTP_WAIT): stopped, gone once its callbacks ran. */
            CloseThreadpoolWait: {
                argBytes: 4,
                /** @param {number[]} args */
                handler: ([handle])=>{
                    const wait = stopWait(handle >>> 0);
                    if (wait)
                    {
                        wait.closed = true;
                        forgetPooled(poolWaits, handle >>> 0);
                    }
                    return 0;
                },
            },

            /**
             * VOID FreeLibraryWhenCallbackReturns(PTP_CALLBACK_INSTANCE pci, HMODULE mod)
             *
             * The library stays loaded: a module here is never taken out of
             * the address space while its process runs, so the reference
             * the callback gives up leaves nothing to unload.
             */
            FreeLibraryWhenCallbackReturns: {
                argBytes: 8,
                handler: ()=>0,
            },

            QueueUserWorkItem: {
                argBytes: 12,
                /** @param {number[]} args */
                handler: ([routine, context])=>{
                    if ((routine >>> 0) === 0)
                    {
                        return fail(ERROR_INVALID_PARAMETER);
                    }
                    dispatch({ entry: routine >>> 0, args: [context >>> 0], owner: workItems });
                    return 1;
                },
            },
        },
    };
}
