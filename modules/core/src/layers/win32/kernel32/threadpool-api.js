/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The thread pool API: pools, cleanup groups and the callback objects a
 * program makes in them -- work, simple callbacks, timers and waits -- and
 * what a running callback may ask of its instance.
 *
 * kernel32's CreateThreadpool* calls are ntdll's Tp* calls on Windows; here
 * both are these objects (`objects`), kernel32's answering with BOOLs and
 * last errors (`table`), ntdll's with statuses (`ntdll/pool.js`). They run on
 * the thread pool's own threads and waits (`pool.js`): a pool is a lane of
 * threads of its own, with its own maximum and stack sizes, and the process's
 * pool is the lane timer queues and work items use.
 *
 * A callback's instance is where its pool thread keeps the record it was
 * handed, on that thread's stack, so it names the running callback and no
 * other: what is asked of it -- a semaphore to release, an event to set once
 * the callback returns, its owner let go -- is the running callback's.
 */

/** TP_CALLBACK_ENVIRON, 32-bit: version 1's fields, then version 3's. */
const ENVIRONMENT = Object.freeze({
    VERSION: 0, POOL: 4, CLEANUP_GROUP: 8, CANCEL_CALLBACK: 12, FINALIZATION: 24,
    PRIORITY: 32, V1_SIZE: 32, V3_SIZE: 40,
});
/** The last of TP_CALLBACK_PRIORITY's high, normal and low. */
const TP_CALLBACK_PRIORITY_LOW = 2;

/** A registered wait that fires once, whatever its object does after. */
const WT_EXECUTEONLYONCE = 0x00000008;
const INFINITE = 0xffffffff;
const INVALID_HANDLE_VALUE = 0xffffffff;

const ERROR_NOT_ENOUGH_MEMORY = 8;
const ERROR_INVALID_PARAMETER = 87;

/**
 * What a callback may ask to be done once it returns, by the kernel32 call
 * that does it, in the order they are done: the lock it holds let go first,
 * then what others wait on signalled, the library its code is in last.
 */
const COMPLETION_ORDER = Object.freeze(['LeaveCriticalSection', 'ReleaseMutex',
    'ReleaseSemaphore', 'SetEvent', 'FreeLibrary']);

/**
 * @typedef {import('./pool-types.js').Owner} Owner
 * @typedef {import('./pool-types.js').Lane} Lane
 * @typedef {import('./pool-types.js').Job} Job
 * @typedef {import('./pool-types.js').Wait} Wait
 * @typedef {import('./pool-types.js').Worker} Worker
 * @typedef {import('./pool-types.js').Instance} Instance
 */

/**
 * What the thread pool lends this API: its threads, lanes and waits.
 *
 * @typedef {Object} ThreadpoolCore
 * @property {any} kernel
 * @property {import('./pool-types.js').ThreadPoolHost} host
 * @property {Lane} poolLane  the process's pool
 * @property {(name: string, max: number) => Lane} makeLane
 * @property {(lane: Lane) => boolean} spawn  one more thread, false when none was made
 * @property {(job: Job, lane?: Lane) => void} dispatch
 * @property {(owner: Owner, lane: Lane) => number} drop  the owner's callbacks not yet started
 * @property {(owner: Owner, count: number) => void} uncount
 * @property {(owners: Owner[], own: number) => 0 | Promise<0>} gather
 * @property {(owner: Owner, event: number, own: number) => any} complete
 * @property {() => Job | null} running  the calling pool thread's callback
 * @property {(instance: number) => Worker | null} instanceOf
 * @property {(object: number, callback: number, context: number, timeout: number,
 *     flags: number) => Wait | number} registerWait
 * @property {(wait: Wait) => void} cancelWait
 * @property {(pointer: number) => number} dueIn  a FILETIME's due time, in ms from now
 * @property {(lane: Lane) => void} retireIdle
 */

/**
 * @typedef {Object} Pool
 * @property {number} handle
 * @property {Lane} lane
 * @property {boolean} released  closed by the program; gone once its objects are
 * @property {number} objects  callback objects made in it and not yet gone
 */

/**
 * @typedef {Object} Group
 * @property {number} handle
 * @property {Set<Item>} members
 */

/**
 * A callback object: its owner's count is the callbacks of it handed to the
 * pool and not yet returned.
 *
 * @typedef {Owner & {
 *     kind: 'work' | 'simple' | 'timer' | 'wait',
 *     handle: number, callback: number, context: number,
 *     pool: Pool, group: Group | null, cancel: number,
 *     closed: boolean, armed: boolean, clock: any, registered: Wait | null,
 *     gone?: boolean }} Item
 *     `closed`: released by the program (a simple callback is never, and goes
 *     once its callback returned); `cancel`: its environment's
 *     CleanupGroupCancelCallback.
 */

/**
 * @param {ThreadpoolCore} core
 */
export function createThreadpoolApi(core){
    const { kernel, host } = core;

    /** The process's pool, which a callback environment without one names. */
    /** @type {Pool} */
    const processPool = { handle: 0, lane: core.poolLane, released: false, objects: 0 };
    /** @type {Map<number, Pool>} */
    const pools = new Map();
    /** @type {Map<number, Group>} */
    const groups = new Map();
    /** @type {Map<number, Item>} */
    const items = new Map();

    /** @param {number} at */
    const read32 = at=>{
        const bytes = /** @type {NonNullable<typeof host.readMemory>} */ (host.readMemory)(at, 4);
        return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
    };
    /** @param {number} at @param {number} value */
    const write32 = (at, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(at, bytes);
    };

    /**
     * What a TP_CALLBACK_ENVIRON names, or why it is refused: a version
     * other than 1 and 3, a version 3 priority none of high, normal and low,
     * a pool or cleanup group that is not one, are ERROR_INVALID_PARAMETER.
     * None at all is the process's pool, no group.
     *
     * @param {number} environment
     * @returns {{ pool: Pool, group: Group | null, cancel: number, finalization: number }
     *     | { refused: number }}
     */
    const environmentOf = environment=>{
        if ((environment >>> 0) === 0 || !host.readMemory)
        {
            return { pool: processPool, group: null, cancel: 0, finalization: 0 };
        }
        const at = environment >>> 0;
        const version = read32(at + ENVIRONMENT.VERSION);
        if ((version !== 1 && version !== 3)
            || (version === 3 && read32(at + ENVIRONMENT.PRIORITY) > TP_CALLBACK_PRIORITY_LOW))
        {
            return { refused: ERROR_INVALID_PARAMETER };
        }
        const poolHandle = read32(at + ENVIRONMENT.POOL);
        const groupHandle = read32(at + ENVIRONMENT.CLEANUP_GROUP);
        const pool = poolHandle === 0 ? processPool : pools.get(poolHandle);
        const group = groupHandle === 0 ? null : groups.get(groupHandle);
        if (!pool || group === undefined)
        {
            return { refused: ERROR_INVALID_PARAMETER };
        }
        return { pool, group, cancel: read32(at + ENVIRONMENT.CANCEL_CALLBACK),
            finalization: read32(at + ENVIRONMENT.FINALIZATION) };
    };

    /**
     * A pool closed by the program goes once the last of its objects has:
     * its threads end, each once it is idle.
     *
     * @param {Pool} pool
     */
    const forgetPool = pool=>{
        if (pool.released && pool.objects === 0 && pool.handle !== 0)
        {
            core.retireIdle(pool.lane);
            host.free?.(pool.handle);
            pool.handle = 0;
        }
    };

    /**
     * A released object with nothing outstanding is gone: out of its group,
     * its pool and its handle given back. A simple callback goes so once its
     * callback has returned.
     *
     * @param {Item} item
     */
    const forget = item=>{
        if ((!item.closed && item.kind !== 'simple') || item.outstanding !== 0
            || (item.live ?? 0) !== 0)
        {
            return;
        }
        item.group?.members.delete(item);
        item.group = null;
        if (item.handle !== 0 && items.get(item.handle) === item)
        {
            items.delete(item.handle);
            host.free?.(item.handle);
        }
        if (item.pool.objects > 0 && !item.gone)
        {
            item.gone = true;
            item.pool.objects--;
            forgetPool(item.pool);
        }
    };

    /**
     * @param {Item['kind']} kind @param {number} callback @param {number} context
     * @param {number} environment
     * @returns {Item | number}  the object, or the Win32 error that refused it
     */
    const make = (kind, callback, context, environment)=>{
        if ((callback >>> 0) === 0)
        {
            return ERROR_INVALID_PARAMETER;
        }
        const env = environmentOf(environment);
        if ('refused' in env)
        {
            return env.refused;
        }
        const handle = kind === 'simple' ? 0 : host.allocate(8);
        if (kind !== 'simple' && handle === 0)
        {
            return ERROR_NOT_ENOUGH_MEMORY;
        }
        /** @type {Item} */
        const item = { kind, handle, callback: callback >>> 0, context: context >>> 0,
            pool: env.pool, group: env.group, cancel: env.cancel,
            finalization: env.finalization, closed: false, armed: false, clock: null,
            registered: null, outstanding: 0, waiters: [] };
        item.settled = ()=>forget(item);
        if (handle !== 0)
        {
            items.set(handle, item);
        }
        env.pool.objects++;
        env.group?.members.add(item);
        return item;
    };

    /** @param {number} handle @param {Item['kind']} kind */
    const itemOf = (handle, kind)=>{
        const item = items.get(handle >>> 0);
        return item && item.kind === kind ? item : null;
    };

    /** @param {Item} item @param {number[]} args */
    const run = (item, args)=>core.dispatch({ entry: item.callback, args, instanced: true,
        owner: item }, item.pool.lane);

    /** @param {Item} item  the timer stops; one already handed over still runs */
    const stopTimer = item=>{
        if (item.clock)
        {
            kernel.cancelTimer(item.clock);
        }
        item.armed = false;
    };

    /** @param {Item} item  the wait stops; one already handed over still runs */
    const stopWait = item=>{
        if (item.registered)
        {
            core.cancelWait(item.registered);
            item.registered = null;
        }
    };

    /**
     * The calling pool thread's instance, when `instance` is it, with what
     * its callback has asked so far.
     *
     * @param {number} instance
     * @returns {{ worker: Worker, job: Job, state: Instance } | null}
     */
    const stateOf = instance=>{
        const worker = core.instanceOf(instance);
        const job = worker?.job;
        if (!worker || !job)
        {
            return null;
        }
        job.state ??= { completion: [], disassociated: false, long: false };
        return { worker, job, state: job.state };
    };

    /**
     * What one of an owner's callbacks waits for: the rest of its
     * callbacks, but not itself.
     *
     * @param {Item} item
     */
    const ownShare = item=>(core.running()?.owner === item ? 1 : 0);

    const objects = {
        /** A pool of its own: a lane of threads, its maximum the process's until set. */
        allocPool: ()=>{
            const handle = host.allocate(8);
            if (handle === 0)
            {
                return 0;
            }
            /** @type {Pool} */
            const pool = { handle, lane: core.makeLane('thread pool', core.poolLane.max),
                released: false, objects: 0 };
            pool.lane.retiring = ()=>pool.released && pool.objects === 0;
            pools.set(handle, pool);
            return handle;
        },

        /** @param {number} handle */
        releasePool: handle=>{
            const pool = pools.get(handle >>> 0);
            if (pool)
            {
                pools.delete(pool.handle);
                pool.released = true;
                forgetPool(pool);
            }
        },

        /**
         * At most `max` callbacks of the pool run at once, on as many threads.
         *
         * @param {number} handle @param {number} max
         */
        setMax: (handle, max)=>{
            const pool = pools.get(handle >>> 0);
            if (pool)
            {
                pool.lane.max = max >>> 0;
            }
        },

        /**
         * At least `min` threads, made now: false when one could not be.
         * A minimum above the maximum raises the maximum.
         *
         * @param {number} handle @param {number} min
         */
        setMin: (handle, min)=>{
            const pool = pools.get(handle >>> 0);
            if (!pool)
            {
                return false;
            }
            pool.lane.max = Math.max(pool.lane.max, min >>> 0);
            while (pool.lane.threads < (min >>> 0))
            {
                if (!core.spawn(pool.lane))
                {
                    return false;
                }
            }
            return true;
        },

        /**
         * The stack its threads are made with from now on, not checked, as
         * Windows does not check it.
         *
         * @param {number} handle @param {number} information
         */
        setStack: (handle, information)=>{
            const pool = pools.get(handle >>> 0);
            if (!pool || (information >>> 0) === 0 || !host.readMemory)
            {
                return false;
            }
            pool.lane.stack = { reserve: read32(information >>> 0),
                commit: read32((information >>> 0) + 4) };
            return true;
        },

        /**
         * Its threads' stack: its own, or the program's image's until set.
         *
         * @param {number} handle @param {number} information
         */
        queryStack: (handle, information)=>{
            const pool = pools.get(handle >>> 0);
            const stack = pool?.lane.stack ?? host.imageStack?.();
            if (!pool || !stack || (information >>> 0) === 0)
            {
                return false;
            }
            write32(information >>> 0, stack.reserve);
            write32((information >>> 0) + 4, stack.commit);
            return true;
        },

        allocGroup: ()=>{
            const handle = host.allocate(4);
            if (handle !== 0)
            {
                groups.set(handle, { handle, members: new Set() });
            }
            return handle;
        },

        /** @param {number} handle */
        releaseGroup: handle=>{
            if (groups.delete(handle >>> 0))
            {
                host.free?.(handle >>> 0);
            }
        },

        /**
         * Every member of the group released, once its callbacks have
         * returned -- those not yet started dropped first when asked to
         * cancel, its CleanupGroupCancelCallback then called for each
         * member the program has not released itself, on this thread, with
         * the member's context and `userdata`. Timers and waits fire no
         * more. One of the members' own callbacks asking does not wait for
         * itself.
         *
         * @param {number} handle @param {number} cancel @param {number} userdata
         * @returns {0 | Promise<number>}
         */
        releaseMembers: (handle, cancel, userdata)=>{
            const group = groups.get(handle >>> 0);
            if (!group || group.members.size === 0)
            {
                return 0;
            }
            const members = [...group.members];
            group.members.clear();
            // A simple callback is a member while its one callback is: it is
            // cancelled only if that had not started, and one that runs to
            // its end calls no cancel callback.
            /** @type {Set<Item>} */
            const dropped = new Set();
            for (const item of members)
            {
                item.group = null;
                stopTimer(item);
                stopWait(item);
                if (cancel !== 0 && core.drop(item, item.pool.lane) > 0)
                {
                    dropped.add(item);
                }
            }
            const mine = core.running()?.owner;
            const waited = core.gather(members,
                members.some(item=>item === mine) ? 1 : 0);
            const thread = kernel.currentThread();
            const close = ()=>{
                for (const item of members)
                {
                    item.closed = true;
                    forget(item);
                }
            };
            const cancelled = cancel === 0 ? []
                : members.filter(item=>item.cancel !== 0
                    && (item.kind !== 'simple' || dropped.has(item)));
            if (waited === 0 && cancelled.length === 0)
            {
                close();
                return 0;
            }
            return (async()=>{
                await waited;
                for (const item of cancelled.filter(each=>!each.closed))
                {
                    if (host.callGuest)
                    {
                        await host.callGuest({ entry: item.cancel,
                            args: [item.context, userdata >>> 0], thread });
                    }
                    else
                    {
                        host.divergence?.('CloseThreadpoolCleanupGroupMembers',
                            'a cancel callback with no way to call it');
                    }
                }
                close();
                return 0;
            })();
        },

        /**
         * @param {Item['kind']} kind @param {number} callback @param {number} context
         * @param {number} environment
         * @returns {number | { error: number }}  the object's handle
         */
        create: (kind, callback, context, environment)=>{
            const made = make(kind, callback, context, environment);
            return typeof made === 'number' ? { error: made } : made.handle;
        },

        /**
         * One callback on the pool, handed its instance and context.
         *
         * @param {number} callback @param {number} context @param {number} environment
         * @returns {number}  0, or the Win32 error that refused it
         */
        simple: (callback, context, environment)=>{
            const made = make('simple', callback, context, environment);
            if (typeof made === 'number')
            {
                return made;
            }
            run(made, [made.context]);
            return 0;
        },

        /** A work's callback once more, handed its instance, context and the work. @param {number} handle */
        post: handle=>{
            const item = itemOf(handle, 'work');
            if (item && !item.closed)
            {
                run(item, [item.context, item.handle]);
            }
        },

        /**
         * Sets the timer anew from a FILETIME's due time, then every
         * `period` ms; with no due time stops it. It stays set once it has
         * fired, until it is stopped. The window a callback may be put off by
         * is the timer's to use and is not used: each fires at its due time.
         *
         * @param {number} handle @param {number} due @param {number} period
         * @returns {boolean}  whether it was set before
         */
        setTimer: (handle, due, period)=>{
            const item = itemOf(handle, 'timer');
            if (!item || item.closed)
            {
                return false;
            }
            const was = item.armed;
            stopTimer(item);
            if ((due >>> 0) === 0)
            {
                return was;
            }
            item.clock ??= kernel.createTimer({ name: 'thread pool timer' });
            item.armed = true;
            kernel.armTimer(item.clock, kernel.clock.virtualTime() + core.dueIn(due >>> 0),
                period >>> 0, ()=>run(item, [item.context, item.handle]));
            return was;
        },

        /** @param {number} handle */
        isTimerSet: handle=>itemOf(handle, 'timer')?.armed === true,

        /**
         * One wait on the object, its callback handed its instance, context,
         * the wait and WAIT_OBJECT_0, WAIT_ABANDONED_0 or WAIT_TIMEOUT, once.
         * No object stops the wait; no time-out waits for ever.
         *
         * @param {number} handle @param {number} object @param {number} timeout
         * @returns {boolean}  whether a wait was under way
         */
        setWait: (handle, object, timeout)=>{
            const item = itemOf(handle, 'wait');
            if (!item || item.closed)
            {
                return false;
            }
            const was = item.registered !== null && !item.registered.spent;
            stopWait(item);
            if ((object >>> 0) === 0)
            {
                return was;
            }
            const made = core.registerWait(object, item.callback, item.context,
                (timeout >>> 0) === 0 ? INFINITE : core.dueIn(timeout >>> 0), WT_EXECUTEONLYONCE);
            if (typeof made === 'number')
            {
                host.divergence?.('SetThreadpoolWait',
                    `the wait could not be made (error ${made})`);
                return was;
            }
            made.owner = item;
            made.argsFor = result=>[item.context, item.handle, result];
            made.instanced = true;
            made.lane = item.pool.lane;
            item.registered = made;
            return was;
        },

        /**
         * Returns once the object's callbacks have run; those not yet
         * started are dropped first when asked.
         *
         * @param {number} handle @param {number} cancel
         */
        waitFor: (handle, cancel)=>{
            const item = items.get(handle >>> 0);
            if (!item)
            {
                return 0;
            }
            if (cancel !== 0)
            {
                core.drop(item, item.pool.lane);
            }
            const done = core.complete(item, INVALID_HANDLE_VALUE, ownShare(item));
            return done === 1 ? 0 : done;
        },

        /**
         * Released: a timer or wait stops, and the object goes once its
         * callbacks have run.
         *
         * @param {number} handle
         */
        close: handle=>{
            const item = items.get(handle >>> 0);
            if (!item || item.closed)
            {
                return;
            }
            item.closed = true;
            stopTimer(item);
            stopWait(item);
            item.group?.members.delete(item);
            item.group = null;
            forget(item);
        },

        /**
         * Says the running callback may run long: whether another thread can
         * take the pool's next callback -- an idle one, or one the pool may
         * still make, made now when callbacks wait.
         *
         * @param {number} instance
         */
        mayRunLong: instance=>{
            const found = stateOf(instance);
            if (!found)
            {
                return false;
            }
            found.state.long = true;
            const { lane } = found.worker;
            const can = lane.idle.length > 0 || lane.threads < lane.max;
            if (can && lane.idle.length === 0 && lane.backlog.length > 0)
            {
                core.spawn(lane);
            }
            return can;
        },

        /**
         * A kernel32 call made once the running callback has returned: the
         * last of each kind asked is the one made.
         *
         * @param {number} instance @param {string} name @param {number[]} args
         */
        onCompletion: (instance, name, args)=>{
            const found = stateOf(instance);
            if (!found)
            {
                return;
            }
            const kept = found.state.completion.filter(([each])=>each !== name);
            kept.push([name, args]);
            kept.sort(([a], [b])=>COMPLETION_ORDER.indexOf(a) - COMPLETION_ORDER.indexOf(b));
            found.state.completion = kept;
        },

        /**
         * The running callback lets its object go: a wait for the object's
         * callbacks, or its group's, no longer waits for this one.
         *
         * @param {number} instance
         */
        disassociate: instance=>{
            const found = stateOf(instance);
            if (!found || found.state.disassociated)
            {
                return;
            }
            found.state.disassociated = true;
            core.uncount(found.job.owner, 1);
        },
    };

    /** @param {number} code */
    const fail = code=>{
        host.setLastError(code);
        return 0;
    };

    /** @param {Item['kind']} kind @param {number[]} args */
    const created = (kind, [callback, context, environment])=>{
        const made = objects.create(kind, callback, context, environment);
        return typeof made === 'number' ? made : fail(made.error);
    };

    /**
     * @param {number} argBytes @param {(args: number[]) => any} handler
     * @returns {{ argBytes: number, handler: (args: number[]) => any }}
     */
    const fn = (argBytes, handler)=>({ argBytes, handler });

    /** kernel32's calls: handles, BOOLs and last errors. */
    const table = {
        /** PTP_POOL CreateThreadpool(PVOID reserved) */
        CreateThreadpool: fn(4, ()=>objects.allocPool() || fail(ERROR_NOT_ENOUGH_MEMORY)),
        /** VOID CloseThreadpool(PTP_POOL) */
        CloseThreadpool: fn(4, ([pool])=>{
            objects.releasePool(pool);
            return 0;
        }),
        /** VOID SetThreadpoolThreadMaximum(PTP_POOL, DWORD) */
        SetThreadpoolThreadMaximum: fn(8, ([pool, max])=>{
            objects.setMax(pool, max);
            return 0;
        }),
        /** BOOL SetThreadpoolThreadMinimum(PTP_POOL, DWORD) */
        SetThreadpoolThreadMinimum: fn(8, ([pool, min])=>
            (objects.setMin(pool, min) ? 1 : fail(ERROR_NOT_ENOUGH_MEMORY))),
        /** BOOL SetThreadpoolStackInformation(PTP_POOL, PTP_POOL_STACK_INFORMATION) */
        SetThreadpoolStackInformation: fn(8, ([pool, information])=>
            (objects.setStack(pool, information) ? 1 : fail(ERROR_INVALID_PARAMETER))),
        /** BOOL QueryThreadpoolStackInformation(PTP_POOL, PTP_POOL_STACK_INFORMATION) */
        QueryThreadpoolStackInformation: fn(8, ([pool, information])=>
            (objects.queryStack(pool, information) ? 1 : fail(ERROR_INVALID_PARAMETER))),

        /** PTP_CLEANUP_GROUP CreateThreadpoolCleanupGroup(void) */
        CreateThreadpoolCleanupGroup: fn(0, ()=>
            objects.allocGroup() || fail(ERROR_NOT_ENOUGH_MEMORY)),
        /** VOID CloseThreadpoolCleanupGroup(PTP_CLEANUP_GROUP) */
        CloseThreadpoolCleanupGroup: fn(4, ([group])=>{
            objects.releaseGroup(group);
            return 0;
        }),
        /** VOID CloseThreadpoolCleanupGroupMembers(PTP_CLEANUP_GROUP, BOOL, PVOID) */
        CloseThreadpoolCleanupGroupMembers: fn(12, ([group, cancel, userdata])=>
            objects.releaseMembers(group, cancel, userdata)),

        /** PTP_WORK CreateThreadpoolWork(PTP_WORK_CALLBACK, PVOID, PTP_CALLBACK_ENVIRON) */
        CreateThreadpoolWork: fn(12, args=>created('work', args)),
        /** VOID SubmitThreadpoolWork(PTP_WORK) */
        SubmitThreadpoolWork: fn(4, ([work])=>{
            objects.post(work);
            return 0;
        }),
        /** VOID WaitForThreadpoolWorkCallbacks(PTP_WORK, BOOL fCancelPendingCallbacks) */
        WaitForThreadpoolWorkCallbacks: fn(8, ([work, cancel])=>objects.waitFor(work, cancel)),
        /** VOID CloseThreadpoolWork(PTP_WORK) */
        CloseThreadpoolWork: fn(4, ([work])=>{
            objects.close(work);
            return 0;
        }),
        /** BOOL TrySubmitThreadpoolCallback(PTP_SIMPLE_CALLBACK, PVOID, PTP_CALLBACK_ENVIRON) */
        TrySubmitThreadpoolCallback: fn(12, ([callback, context, environment])=>{
            const error = objects.simple(callback, context, environment);
            return error === 0 ? 1 : fail(error);
        }),

        /** PTP_TIMER CreateThreadpoolTimer(PTP_TIMER_CALLBACK, PVOID, PTP_CALLBACK_ENVIRON) */
        CreateThreadpoolTimer: fn(12, args=>created('timer', args)),
        /** VOID SetThreadpoolTimer(PTP_TIMER, PFILETIME pftDueTime, DWORD msPeriod, DWORD msWindowLength) */
        SetThreadpoolTimer: fn(16, ([timer, due, period])=>{
            objects.setTimer(timer, due, period);
            return 0;
        }),
        /** BOOL SetThreadpoolTimerEx(PTP_TIMER, PFILETIME, DWORD, DWORD): whether it was set */
        SetThreadpoolTimerEx: fn(16, ([timer, due, period])=>
            (objects.setTimer(timer, due, period) ? 1 : 0)),
        /** BOOL IsThreadpoolTimerSet(PTP_TIMER) */
        IsThreadpoolTimerSet: fn(4, ([timer])=>(objects.isTimerSet(timer) ? 1 : 0)),
        /** VOID WaitForThreadpoolTimerCallbacks(PTP_TIMER, BOOL fCancelPendingCallbacks) */
        WaitForThreadpoolTimerCallbacks: fn(8, ([timer, cancel])=>
            objects.waitFor(timer, cancel)),
        /** VOID CloseThreadpoolTimer(PTP_TIMER) */
        CloseThreadpoolTimer: fn(4, ([timer])=>{
            objects.close(timer);
            return 0;
        }),

        /** PTP_WAIT CreateThreadpoolWait(PTP_WAIT_CALLBACK, PVOID, PTP_CALLBACK_ENVIRON) */
        CreateThreadpoolWait: fn(12, args=>created('wait', args)),
        /** VOID SetThreadpoolWait(PTP_WAIT, HANDLE, PFILETIME pftTimeout) */
        SetThreadpoolWait: fn(12, ([wait, object, timeout])=>{
            objects.setWait(wait, object, timeout);
            return 0;
        }),
        /** BOOL SetThreadpoolWaitEx(PTP_WAIT, HANDLE, PFILETIME, PVOID): whether one was under way */
        SetThreadpoolWaitEx: fn(16, ([wait, object, timeout])=>
            (objects.setWait(wait, object, timeout) ? 1 : 0)),
        /** VOID WaitForThreadpoolWaitCallbacks(PTP_WAIT, BOOL fCancelPendingCallbacks) */
        WaitForThreadpoolWaitCallbacks: fn(8, ([wait, cancel])=>objects.waitFor(wait, cancel)),
        /** VOID CloseThreadpoolWait(PTP_WAIT) */
        CloseThreadpoolWait: fn(4, ([wait])=>{
            objects.close(wait);
            return 0;
        }),

        /** BOOL CallbackMayRunLong(PTP_CALLBACK_INSTANCE) */
        CallbackMayRunLong: fn(4, ([instance])=>(objects.mayRunLong(instance) ? 1 : 0)),
        /** VOID SetEventWhenCallbackReturns(PTP_CALLBACK_INSTANCE, HANDLE) */
        SetEventWhenCallbackReturns: fn(8, ([instance, event])=>{
            objects.onCompletion(instance, 'SetEvent', [event >>> 0]);
            return 0;
        }),
        /** VOID ReleaseSemaphoreWhenCallbackReturns(PTP_CALLBACK_INSTANCE, HANDLE, DWORD) */
        ReleaseSemaphoreWhenCallbackReturns: fn(12, ([instance, semaphore, count])=>{
            objects.onCompletion(instance, 'ReleaseSemaphore', [semaphore >>> 0, count >>> 0, 0]);
            return 0;
        }),
        /** VOID ReleaseMutexWhenCallbackReturns(PTP_CALLBACK_INSTANCE, HANDLE) */
        ReleaseMutexWhenCallbackReturns: fn(8, ([instance, mutex])=>{
            objects.onCompletion(instance, 'ReleaseMutex', [mutex >>> 0]);
            return 0;
        }),
        /** VOID LeaveCriticalSectionWhenCallbackReturns(PTP_CALLBACK_INSTANCE, PCRITICAL_SECTION) */
        LeaveCriticalSectionWhenCallbackReturns: fn(8, ([instance, section])=>{
            objects.onCompletion(instance, 'LeaveCriticalSection', [section >>> 0]);
            return 0;
        }),
        /** VOID FreeLibraryWhenCallbackReturns(PTP_CALLBACK_INSTANCE, HMODULE) */
        FreeLibraryWhenCallbackReturns: fn(8, ([instance, module])=>{
            objects.onCompletion(instance, 'FreeLibrary', [module >>> 0]);
            return 0;
        }),
        /** VOID DisassociateCurrentThreadFromCallback(PTP_CALLBACK_INSTANCE) */
        DisassociateCurrentThreadFromCallback: fn(4, ([instance])=>{
            objects.disassociate(instance);
            return 0;
        }),
    };

    return {
        objects,
        table,
        diagnostics: ()=>({ pools: pools.size, groups: groups.size, objects: items.size }),
    };
}
