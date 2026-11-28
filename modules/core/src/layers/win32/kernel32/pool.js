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

import { createThreadpoolApi } from './threadpool-api.js';
import { wholeAddress } from '../common/pointers.js';
import { createDeadlines } from '../../../system/deadlines.js';
import { imm32 } from '../../../system/x86.js';

/** A pool this size runs more callbacks at once than a program has reason to ask for. */
const MAX_THREADS = 32;

/** What the asking trap answers when the record holds a callback to run. */
const RUN = 0x10000;
/** What the loop hands the trap after a callback returned, and the first time it asks. */
const RAN = 0x20000;

/**
 * The record a callback is handed through: the routine, then six arguments,
 * as many as the widest callback takes (a thread pool I/O's).
 */
const RECORD = {
    ENTRY: 0,
    ARGS: 4,
    COUNT: 6,
    SIZE: 28,
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

/** The same answers as ntdll's statuses. */
const STATUS_SUCCESS = 0;
const STATUS_PENDING = 0x103;
const STATUS_INVALID_HANDLE = 0xc0000008;
const STATUS_INVALID_PARAMETER = 0xc000000d;

/** What an alertable wait answers when routines queued to its thread ended it. */
const WAIT_IO_COMPLETION = 0xc0;
/** The most objects one wait for any of them takes. */
const MAXIMUM_WAIT_OBJECTS = 64;
/** The pseudo-handles of the process and the thread, always there to wait on. */
const CURRENT_PROCESS = 0xffffffff;
const CURRENT_THREAD = 0xfffffffe;

/**
 * The loop, as x86. `fetch` is the trap and `at` is where these bytes will be,
 * because the call to the trap is relative.
 *
 *            sub esp, 28            ; the record, on this thread's own stack
 *            mov eax, RAN
 *     loop:  push eax               ; what the last call answered
 *            lea ecx, [esp+4]
 *            push ecx               ; where the host writes the next callback
 *            call fetch             ; stdcall: EAX = RUN when the record is filled
 *            test eax, eax
 *            jz exit                ; 0: the thread is done
 *            cmp eax, RUN
 *            jne loop
 *            mov ebx, esp
 *            push dword [ebx+24]    ; the six arguments, last first
 *            ...
 *            push dword [ebx+4]
 *            call dword [ebx]
 *            mov esp, ebx           ; however many of the six the routine took
 *            mov eax, RAN
 *            jmp loop
 *     exit:  add esp, 28
 *            ret 4                  ; to where a thread that returns ends
 *
 * The stack pointer is put back from EBX, which a routine keeps, because the
 * callbacks differ in how many arguments they take and who removes them. The
 * record's address is the callback instance a callback is handed: it is the
 * running callback's own, as Windows' instance lives on the pool thread's
 * stack.
 *
 * @param {number} fetch
 * @param {number} at
 * @returns {Uint8Array}
 */
export function poolLoopCode(fetch, at){
    const relative = (fetch - (at + 19)) | 0;
    /** @param {number} value */
    return new Uint8Array([
        0x83, 0xec, RECORD.SIZE,
        0xb8, ...imm32(RAN),
        0x50,
        0x8d, 0x4c, 0x24, 0x04,
        0x51,
        0xe8, ...imm32(relative),
        0x85, 0xc0,
        0x74, 0x26,
        0x3d, ...imm32(RUN),
        0x75, 0xea,
        0x89, 0xe3,
        0xff, 0x73, 0x18,
        0xff, 0x73, 0x14,
        0xff, 0x73, 0x10,
        0xff, 0x73, 0x0c,
        0xff, 0x73, 0x08,
        0xff, 0x73, 0x04,
        0xff, 0x13,
        0x89, 0xdc,
        0xb8, ...imm32(RAN),
        0xeb, 0xcb,
        0x83, 0xc4, RECORD.SIZE,
        0xc2, 0x04, 0x00,
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
function waitLoopCode(wait, after, at){
    /** @param {number} value */
    return new Uint8Array([
        0x8b, 0x5c, 0x24, 0x04,
        0x53,
        0xe8, ...imm32((wait - (at + 10)) | 0),
        0x50,
        0x53,
        0xe8, ...imm32((after - (at + 17)) | 0),
        0x85, 0xc0,
        0x75, 0xef,
        0xc2, 0x04, 0x00,
    ]);
}

/**
 * @typedef {import('./pool-types.js').ThreadPoolHost} ThreadPoolHost
 * @typedef {import('./pool-types.js').Job} Job
 * @typedef {import('./pool-types.js').Instance} Instance
 * @typedef {import('./pool-types.js').Waiter} Waiter
 * @typedef {import('./pool-types.js').Owner} Owner
 * @typedef {import('./pool-types.js').Timer} Timer
 * @typedef {import('./pool-types.js').Queue} Queue
 * @typedef {import('./pool-types.js').Wait} Wait
 * @typedef {import('./pool-types.js').Lane} Lane
 * @typedef {import('./pool-types.js').Worker} Worker
 */

/**
 * What a deletion answers, in its caller's terms: kernel32's BOOL and last
 * error, or ntdll's status. `done` is also what a caller that waited for the
 * callbacks is woken with.
 *
 * @typedef {Object} Answers
 * @property {number} done
 * @property {() => number} pending  callbacks still run and nobody waits for them
 * @property {(error: number) => number} refused  a Win32 error, said the caller's way
 */

/**
 * @param {ThreadPoolHost} host
 */
export function createThreadPool(host){
    const { guest } = host;
    const { kernel } = host;

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

    /** @param {Worker} worker @param {Job} job */
    const give = (worker, job)=>{
        worker.job = job;
        const args = job.instanced ? [worker.record, ...job.args] : job.args;
        guest.set32(worker.record + RECORD.ENTRY, job.entry);
        for (let index = 0; index < RECORD.COUNT; index++)
        {
            guest.set32(worker.record + RECORD.ARGS + index * 4, args[index] ?? 0);
        }
    };

    /** @param {Waiter[]} waiters @param {number} outstanding */
    const release = (waiters, outstanding)=>{
        for (const waiter of waiters.filter(each=>outstanding <= each.until))
        {
            waiters.splice(waiters.indexOf(waiter), 1);
            if (waiter.thread)
            {
                kernel.wake(waiter.thread, waiter.answer ?? 1);
            }
            if (waiter.event)
            {
                kernel.setEvent(waiter.event);
            }
        }
    };

    /**
     * Callbacks of an owner that are outstanding no more: returned, let go
     * by their instance, or dropped before they ran.
     *
     * @param {Owner} owner @param {number} count
     */
    const uncount = (owner, count)=>{
        owner.outstanding -= count;
        release(owner.waiters, owner.outstanding);
        owner.settled?.();
    };

    /**
     * Callbacks of an owner that are running or waiting to run no more:
     * returned, or dropped. One its instance let go is still live until it
     * returns, and a cleanup group waits for it (`gather`).
     *
     * @param {Owner} owner @param {number} count
     */
    const unlive = (owner, count)=>{
        owner.live = (owner.live ?? 0) - count;
        for (const told of owner.gathers ?? [])
        {
            told();
        }
        owner.settled?.();
    };

    /**
     * A callback returned: what it asked of its instance is done, in the
     * order Windows does it, and its owner has one fewer outstanding unless
     * it had let its owner go already.
     *
     * @param {Job} job
     */
    const finish = job=>{
        const state = job.state;
        for (const [name, args] of state?.completion ?? [])
        {
            if (host.call)
            {
                host.call(name, args);
            }
            else
            {
                host.divergence?.(name, 'asked of a thread pool callback\'s instance,'
                    + ' with no kernel32 here to do it');
            }
        }
        if (!state?.disassociated)
        {
            uncount(job.owner, 1);
        }
        unlive(job.owner, 1);
        job.done?.();
    };

    /** @param {Lane} lane  callbacks its threads are running */
    const busy = lane=>lane.threads - lane.starting - lane.idle.length;

    /**
     * A thread of a pool that is closing ends: it is no longer the pool's,
     * and its loop returns.
     *
     * @param {Worker} worker
     */
    const retire = worker=>{
        workers.delete(worker.thread);
        worker.lane.threads--;
    };

    /**
     * The loop's trap: records what the thread just finished, then hands it
     * the next callback or blocks it until there is one.
     *
     * @param {number[]} args
     */
    const fetch = ([record, last])=>{
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
        // Back from routines queued to it (an APC ended its idle wait): it is
        // idle no longer, and a callback handed to it meanwhile has not run.
        const idle = lane.idle.indexOf(worker);
        if (idle >= 0)
        {
            lane.idle.splice(idle, 1);
        }
        if (worker.job && (last >>> 0) !== RAN)
        {
            return RUN;
        }
        if (worker.job)
        {
            const done = worker.job;
            worker.job = null;
            ran++;
            // The environment's FinalizationCallback, on the same thread and
            // instance once the callback returned; the callback is done after
            // it, and what it asked of the instance done then.
            const { owner } = done;
            if (!done.finalizing && owner.finalization)
            {
                give(worker, { entry: owner.finalization, args: [owner.context ?? 0],
                    instanced: true, owner, state: done.state, finalizing: true });
                return RUN;
            }
            finish(done);
        }
        // A pool's maximum holds the callbacks running at once: a thread
        // past it, its maximum lowered, goes idle rather than take another.
        const next = busy(lane) - 1 < lane.max ? take(lane) : undefined;
        if (next)
        {
            give(worker, next);
            grow(lane);
            return RUN;
        }
        if (lane.retiring?.())
        {
            retire(worker);
            return 0;
        }
        // Idle, it waits alertably, as Windows' pool threads do: a routine
        // queued to it runs there and then (`apc.js`), and the loop asks again.
        lane.idle.push(worker);
        return kernel.alertably(thread, ()=>{
            kernel.block(thread, 'a thread pool callback');
            return host.park(thread);
        });
    };

    /** @param {Lane} lane @returns {boolean} whether a thread was made */
    const spawn = lane=>{
        if (lane.threads >= lane.max)
        {
            return false;
        }
        if (loop === 0)
        {
            const trap = host.register('<thread-pool>', { argBytes: 8, handler: fetch });
            const size = poolLoopCode(0, 0).length;
            const at = (host.allocateCode ?? host.allocate)(size);
            if (at === 0)
            {
                return false;
            }
            guest.setBytes(at, poolLoopCode(trap, at));
            loop = at;
        }
        const thread = makeThread({ entry: loop, name: lane.name,
            returnTo: host.threadReturn?.(),
            ...lane.stack
                ? { stackReserve: lane.stack.reserve, stackSize: lane.stack.commit } : {} });
        if (!thread)
        {
            return false;
        }
        host.threadBlock?.(thread);
        lanes.set(thread, lane);
        lane.threads++;
        lane.starting++;
        return true;
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
        job.owner.live = (job.owner.live ?? 0) + 1;
        const worker = busy(lane) < lane.max ? lane.idle.pop() : undefined;
        if (worker)
        {
            give(worker, job);
            kernel.wake(worker.thread, RUN);
            return;
        }
        lane.backlog.push(job);
        grow(lane);
    };

    let turn = 0;
    /**
     * The next callback waiting in a lane: the oldest of the owner served
     * longest ago, so owners take turns, as Windows' pool takes its objects
     * in turn -- one object's many callbacks do not hold up another's.
     *
     * @param {Lane} lane
     * @returns {Job | undefined}
     */
    const take = lane=>{
        let at = -1;
        for (let index = 0; index < lane.backlog.length; index++)
        {
            if (at < 0 || (lane.backlog[index].owner.served ?? 0)
                < (lane.backlog[at].owner.served ?? 0))
            {
                at = index;
            }
        }
        if (at < 0)
        {
            return undefined;
        }
        const [job] = lane.backlog.splice(at, 1);
        job.owner.served = ++turn;
        return job;
    };

    /**
     * Callbacks of an owner not yet started are dropped, as a wait asked to
     * cancel the pending ones drops them.
     *
     * @param {Owner} owner @param {Lane} lane
     * @returns {number}  how many were dropped
     */
    const drop = (owner, lane)=>{
        const kept = lane.backlog.filter(job=>job.owner !== owner);
        const dropped = lane.backlog.length - kept.length;
        lane.backlog.splice(0, lane.backlog.length, ...kept);
        if (dropped > 0)
        {
            uncount(owner, dropped);
            unlive(owner, dropped);
        }
        return dropped;
    };

    /**
     * Until the callbacks of every one of `owners` have returned, but for
     * `own` of them (the caller's): 0 at once, or a promise its caller waits
     * on, as a lock's waiter does. A callback that let its owner go is
     * waited for too.
     *
     * @param {Owner[]} owners @param {number} own
     * @returns {0 | Promise<0>}
     */
    const gather = (owners, own)=>{
        const left = ()=>owners.reduce((sum, owner)=>sum + (owner.live ?? 0), 0);
        if (left() <= own)
        {
            return 0;
        }
        return new Promise(resolve=>{
            const told = ()=>{
                if (left() <= own)
                {
                    owners.forEach(owner=>owner.gathers?.delete(told));
                    resolve(0);
                }
            };
            owners.forEach(owner=>(owner.gathers ??= new Set()).add(told));
        });
    };

    /**
     * The instance a running callback was handed, and its job: the record's
     * address on a pool thread.
     *
     * @param {number} instance
     */
    const instanceOf = instance=>{
        for (const worker of workers.values())
        {
            if (worker.record === (instance >>> 0) && worker.job)
            {
                return worker;
            }
        }
        return null;
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
     * @param {Answers} [answers]  kernel32's unless the caller is ntdll
     * @returns {number | any}
     */
    const complete = (owner, event, own, answers = boolAnswers)=>{
        const handle = wholeAddress(event);
        if (handle === INVALID_HANDLE_VALUE)
        {
            if (owner.outstanding <= own)
            {
                return answers.done;
            }
            const thread = kernel.currentThread();
            owner.waiters.push({ thread, until: own, answer: answers.done });
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
            return answers.done;
        }
        if (handle !== 0)
        {
            const signal = eventOf(handle);
            if (signal)
            {
                owner.waiters.push({ event: signal, until: 0 });
            }
        }
        return answers.pending();
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

    /** @type {Answers} */
    const boolAnswers = { done: 1, pending: ()=>fail(ERROR_IO_PENDING), refused: fail };
    /** @type {Answers} */
    const statusAnswers = {
        done: STATUS_SUCCESS,
        pending: ()=>STATUS_PENDING,
        refused: error=>(error === ERROR_INVALID_HANDLE ? STATUS_INVALID_HANDLE
            : STATUS_INVALID_PARAMETER),
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

    /**
     * @param {number} timerHandle @param {number} event
     * @param {Answers} [answers]
     */
    const deleteTimer = (timerHandle, event, answers = boolAnswers)=>{
        const timer = timers.get(timerHandle >>> 0);
        if (!timer)
        {
            return answers.refused(ERROR_INVALID_PARAMETER);
        }
        const own = running()?.owner === timer ? 1 : 0;
        cancel(timer);
        return complete(timer, event, own, answers);
    };

    /**
     * @param {number} queueHandle @param {number} event
     * @param {Answers} [answers]
     */
    const deleteQueue = (queueHandle, event, answers = boolAnswers)=>{
        const queue = queues.get(queueHandle >>> 0);
        if (!queue)
        {
            return answers.refused(ERROR_INVALID_HANDLE);
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
        const answer = complete(queue, event, own, answers);
        recount(queue);
        return answer;
    };

    /** @type {Map<number, Wait>} */
    const waits = new Map();
    let waitLoop = 0;

    /**
     * A thread that waits on the objects of many registered waits at once,
     * as Windows' wait threads do: one wait for any of them, the time-out the
     * nearest of theirs. A thread for every wait cost a stack each, and a
     * program registering hundreds of waits ran out of room for threads.
     *
     * @typedef {Object} WaitThread
     * @property {number} id  the thread's parameter, the address its loop asks by
     * @property {any} thread
     * @property {number} handles  where the objects are written for the wait
     * @property {Wait[]} waits  in the order they were registered
     * @property {import('../../../system/deadlines.js').Deadlines} deadlines  when each
     *     wait's time runs out, under its `id`; a wait for ever has none
     * @property {Wait[]} byId  the waits by `id`
     * @property {(id: number) => void} ranOut  fires the wait under `id`, its time out
     * @property {Wait[][]} asked  the waits the wait under way was asked for, by object in
 *     its order: two waits on one object are one entry, which fires the first of them
     * @property {boolean} leaving  out of waits, its loop ending
     */

    /** @type {Map<number, WaitThread>} */
    const waitThreads = new Map();

    /**
     * A wait unregistered is let go once its callbacks have returned. The
     * thread that waited for it holds the wait itself, not its handle, so the
     * handle may go to the next registration at once.
     *
     * @param {Wait} wait
     */
    const forget = wait=>{
        if (wait.cancelled && wait.outstanding === 0 && waits.get(wait.handle) === wait)
        {
            waits.delete(wait.handle);
            host.free?.(wait.handle);
        }
    };

    /**
     * The wait leaves its thread, its time-out with it. Its thread is not
     * told (`detach`).
     *
     * @param {Wait} wait
     * @returns {WaitThread | undefined}  the thread it left
     */
    const leave = wait=>{
        const home = wait.home;
        wait.home = undefined;
        if (home)
        {
            home.waits.splice(home.waits.indexOf(wait), 1);
            home.deadlines.release(wait.id);
            home.byId[wait.id] = undefined;
            wait.id = -1;
        }
        return home;
    };

    /**
     * The wait leaves its thread, which is told so: blocked, it is taken out
     * of its wait and waits again for what is left. Left in its wait, it
     * would take the next signal for a wait nobody has any more -- a
     * semaphore's count, an auto-reset event -- from whoever waits on the
     * object next.
     *
     * @param {Wait} wait
     */
    const detach = wait=>{
        const home = leave(wait);
        if (home)
        {
            kernel.alert(home.thread, WAIT_IO_COMPLETION);
        }
    };

    /** The wait's time runs out its time-out from now. @param {Wait} wait */
    const startTimeout = wait=>{
        if (wait.timeout !== INFINITE && wait.home)
        {
            wait.home.deadlines.move(wait.id, kernel.clock.virtualTime() + wait.timeout);
        }
    };

    /**
     * The wait thread asks: a wait for any of its waits' objects, alertable,
     * until the nearest time-out.
     */
    const waitStep = (/** @type {number[]} */ [id])=>{
        const home = /** @type {WaitThread} */ (waitThreads.get(id >>> 0));
        /** @type {Map<number, Wait[]>} */
        const byObject = new Map();
        const never = neverSignalled();
        for (const wait of home.waits)
        {
            // The process's and the thread's own pseudo-handles are never
            // signalled while it runs, and no wait for many objects takes
            // them: such a wait is its time-out alone.
            if (never !== 0 && isPseudo(wait.object))
            {
                continue;
            }
            byObject.set(wait.object, [...byObject.get(wait.object) ?? [], wait]);
        }
        home.asked = [...byObject.values()];
        const objects = home.asked.map(([wait])=>wait.object);
        if (objects.length === 0)
        {
            objects.push(never);
        }
        const now = kernel.clock.virtualTime();
        const nearest = home.deadlines.soonest();
        const bytes = new Uint8Array(objects.length * 4);
        const view = new DataView(bytes.buffer);
        objects.forEach((object, index)=>view.setUint32(index * 4, object, true));
        guest.setBytes(home.handles, bytes);
        return /** @type {NonNullable<ThreadPoolHost['waitFor']>} */ (host.waitFor)(
            objects.length, home.handles,
            nearest === Infinity ? INFINITE : Math.max(0, Math.ceil(nearest - now)));
    };

    /** @param {number} handle */
    const isPseudo = handle=>handle === CURRENT_PROCESS || handle === CURRENT_THREAD;

    let neverEvent = 0;
    /**
     * An event nobody sets, which a wait thread whose waits are all on
     * pseudo-handles waits on for their time-outs. Made by kernel32 when
     * first needed; 0 where there is no kernel32 to make it, and the
     * pseudo-handles are then waited on as they are.
     */
    const neverSignalled = ()=>(neverEvent ||=
        (host.call?.('CreateEventW', [0, 1, 0, 0]) ?? 0) >>> 0);

    /**
     * A wait fired: its callback handed to the pool, with the object
     * signalled or abandoned FALSE and the time out TRUE, as its
     * TimerOrWaitFired says. One that fires once leaves its thread; any
     * other waits again from now.
     *
     * @param {Wait} wait @param {number} result
     */
    const fireWait = (wait, result)=>{
        dispatch({ entry: wait.callback,
            args: wait.argsFor?.(result) ?? [wait.context, result === WAIT_TIMEOUT ? 1 : 0],
            owner: wait.owner ?? wait, instanced: wait.instanced },
        wait.inWaitThread ? waitLane : wait.lane ?? poolLane);
        if (wait.once)
        {
            wait.spent = true;
            leave(wait);
        }
        else
        {
            startTimeout(wait);
        }
    };

    /**
     * The wait answered: the wait whose object came fired, or every wait
     * whose time ran out; routines queued to the thread, or a wait added or
     * removed, end it with nothing to fire. The thread goes on while it has
     * waits, and ends once it has none.
     */
    const waitDone = (/** @type {number[]} */ [id, answer])=>{
        const home = /** @type {WaitThread} */ (waitThreads.get(id >>> 0));
        const result = wholeAddress(answer);
        const live = (/** @type {Wait | undefined} */ wait)=>
            wait !== undefined && !wait.cancelled && wait.home === home;
        if (result < home.asked.length || (result >= WAIT_ABANDONED
            && result < WAIT_ABANDONED + home.asked.length))
        {
            const wait = home.asked[result & 0x7f]?.find(live);
            if (wait)
            {
                fireWait(wait, result < WAIT_ABANDONED ? WAIT_OBJECT_0 : WAIT_ABANDONED);
            }
        }
        else if (result === WAIT_TIMEOUT)
        {
            home.deadlines.takeDue(kernel.clock.virtualTime(), home.ranOut);
        }
        else if (result !== WAIT_IO_COMPLETION)
        {
            // An object closed under a wait: the wait for all of them fails.
            // The waits whose objects are gone can never fire; they are said
            // and dropped, and the others wait on.
            for (const wait of home.asked.flat()
                .filter(each=>live(each) && !eventOrObject(each.object)))
            {
                host.divergence?.('RegisterWaitForSingleObject',
                    `the object 0x${wait.object.toString(16)} was closed under its wait,`
                    + ' which will never fire');
                leave(wait);
            }
        }
        if (home.waits.length === 0)
        {
            home.leaving = true;
            waitThreads.delete(home.id);
            host.free?.(home.handles);
            host.free?.(home.id);
            return 0;
        }
        return 1;
    };

    /** Whether a handle still names something a thread can wait on. @param {number} handle */
    const eventOrObject = handle=>{
        if (handle === CURRENT_PROCESS || handle === CURRENT_THREAD)
        {
            return true;
        }
        try
        {
            return kernel.handles.resolve(handle) !== null;
        }
        catch (e){
            void e;
            return false;
        }
    };

    /**
     * A wait thread with room for one more wait, made when every one is
     * full.
     *
     * @returns {WaitThread | null}
     */
    const waitThreadWithRoom = ()=>{
        for (const home of waitThreads.values())
        {
            if (!home.leaving && home.waits.length < MAXIMUM_WAIT_OBJECTS)
            {
                return home;
            }
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
                return null;
            }
            guest.setBytes(at, waitLoopCode(step, done, at));
            waitLoop = at;
        }
        const id = host.allocate(4);
        const handles = id === 0 ? 0 : host.allocate(MAXIMUM_WAIT_OBJECTS * 4);
        if (handles === 0)
        {
            host.free?.(id);
            return null;
        }
        const thread = makeThread({ entry: waitLoop, parameter: id,
            name: 'registered waits', returnTo: host.threadReturn?.() });
        if (!thread)
        {
            host.free?.(handles);
            host.free?.(id);
            return null;
        }
        host.threadBlock?.(thread);
        /** @type {WaitThread} */
        const home = { id, thread, handles, waits: [], asked: [], leaving: false,
            deadlines: createDeadlines(MAXIMUM_WAIT_OBJECTS), byId: [],
            ranOut: slot=>fireWait(/** @type {Wait} */ (home.byId[slot]), WAIT_TIMEOUT) };
        waitThreads.set(id, home);
        return home;
    };

    /**
     * A wait on one of the wait threads, its callback run on the pool's.
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
        const handle = host.allocate(4);
        if (handle === 0)
        {
            return ERROR_NOT_ENOUGH_MEMORY;
        }
        const home = waitThreadWithRoom();
        if (!home)
        {
            host.free?.(handle);
            return ERROR_NOT_ENOUGH_MEMORY;
        }
        /** @type {Wait} */
        const wait = { handle, object: object >>> 0, callback: callback >>> 0,
            context: context >>> 0, timeout: timeout >>> 0, id: home.deadlines.claim(),
            once: (flags & WT_EXECUTEONLYONCE) !== 0,
            inWaitThread: (flags & WT_EXECUTEINWAITTHREAD) !== 0, cancelled: false,
            spent: false, outstanding: 0, waiters: [] };
        wait.settled = ()=>forget(wait);
        wait.home = home;
        home.waits.push(wait);
        home.byId[wait.id] = wait;
        startTimeout(wait);
        waits.set(handle, wait);
        // Waiting already, the thread starts its wait again with this one in it.
        kernel.alert(home.thread, WAIT_IO_COMPLETION);
        return wait;
    };

    /**
     * No more callbacks: the wait leaves its thread (`detach`).
     *
     * @param {number} waitHandle @param {number} event
     * @param {Answers} [answers]
     */
    const unregisterWait = (waitHandle, event, answers = boolAnswers)=>{
        const wait = waits.get(waitHandle >>> 0);
        if (!wait || wait.cancelled)
        {
            return answers.refused(ERROR_INVALID_HANDLE);
        }
        wait.cancelled = true;
        detach(wait);
        const own = running()?.owner === wait ? 1 : 0;
        // Its own callback on the wait thread is the only one of it that can
        // be running there, so nothing is left pending (Wine's kernel32
        // test_RegisterWaitForSingleObject); one on the pool's is pending, as
        // a timer's own callback deleting it is.
        const answer = own === 1 && wait.inWaitThread && (event >>> 0) === 0 ? answers.done
            : complete(wait, event, own, answers);
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
        const bytes = guest.snapshot(pointer, 8);
        const value = new DataView(bytes.buffer, bytes.byteOffset, 8).getBigInt64(0, true);
        if (value <= 0n)
        {
            return Number(-value / 10000n);
        }
        const now = kernel.clock.wallClock();
        return Math.max(0, Number(value / 10000n) - FILETIME_EPOCH_MS - now);
    };

    /**
     * A registered wait stopped from outside its callbacks (a thread pool
     * wait set again or closed): it leaves its thread and fires no more.
     *
     * @param {Wait} wait
     */
    const cancelWait = wait=>{
        if (!wait.cancelled)
        {
            wait.cancelled = true;
            detach(wait);
            forget(wait);
        }
    };

    /**
     * A closed pool's idle threads end now; its busy ones once they are idle
     * (`fetch`), the lane's `retiring` saying so.
     *
     * @param {Lane} lane
     */
    const retireIdle = lane=>{
        for (const worker of lane.idle.splice(0))
        {
            retire(worker);
            kernel.wake(worker.thread, 0);
        }
    };

    /**
     * The thread pool API (CreateThreadpoolWork and the rest, ntdll's Tp*
     * calls) over these threads, lanes and waits: one mechanism under both.
     */
    const api = createThreadpoolApi({
        kernel, host, poolLane, makeLane, spawn, dispatch, drop, uncount, unlive, gather,
        complete, running,
        instanceOf, registerWait, cancelWait, dueIn, retireIdle,
    });

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
            ...api.diagnostics(),
        }),

        /**
         * The deletions as ntdll answers them: a status, and a caller that
         * waits for the callbacks woken with STATUS_SUCCESS; and the thread
         * pool API's objects, which ntdll's Tp* calls are.
         */
        native: {
            /** @param {number} wait @param {number} event */
            deregisterWait: (wait, event)=>unregisterWait(wait, event, statusAnswers),
            /** @param {number} timer @param {number} event */
            deleteTimer: (timer, event)=>deleteTimer(timer, event, statusAnswers),
            /** @param {number} queue @param {number} event */
            deleteTimerQueue: (queue, event)=>deleteQueue(queue, event, statusAnswers),
            objects: api.objects,
        },

        table: {
            ...api.table,

            /** HANDLE CreateTimerQueue(void) */
            CreateTimerQueue: {
                returns: 'pointer',
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
                    if (wholeAddress(out) === 0)
                    {
                        return fail(ERROR_INVALID_PARAMETER);
                    }
                    const made = createTimer(queue, callback, parameter, due, period, flags);
                    if (typeof made === 'number')
                    {
                        return fail(made);
                    }
                    guest.set32(wholeAddress(out), made.handle);
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
                    if (wholeAddress(out) === 0)
                    {
                        return fail(ERROR_INVALID_PARAMETER);
                    }
                    const made = registerWait(object, callback, context, timeout, flags);
                    if (typeof made === 'number')
                    {
                        return fail(made);
                    }
                    guest.set32(wholeAddress(out), made.handle);
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
            QueueUserWorkItem: {
                argBytes: 12,
                /** @param {number[]} args */
                handler: ([routine, context])=>{
                    if (wholeAddress(routine) === 0)
                    {
                        return fail(ERROR_INVALID_PARAMETER);
                    }
                    dispatch({ entry: wholeAddress(routine), args: [wholeAddress(context)],
                        owner: workItems });
                    return 1;
                },
            },
        },
    };
}
