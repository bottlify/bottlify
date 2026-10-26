/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { criticalLayout } from './critical.js';

/**
 * Slim reader/writer locks, condition variables and one-time initialisation:
 * the synchronisation a program built for Vista and later reaches for instead
 * of critical sections and events. Each is one pointer-sized word the program
 * allocated and zeroed, and none needs a handle.
 *
 * What a thread waits for is kept here, by the word's address, and the word
 * itself is kept true -- zero while an SRW lock is free, its low bit set while
 * it is held and the holders counted above it while they share -- because a
 * program statically initialises one to zero and may look at it.
 *
 * Sleeping on a condition variable is two halves. Joining the variable's queue
 * and releasing the lock happen in one host call, because a wake that fell
 * between them would be lost for good. Taking the lock back afterwards is the
 * program's own call to acquire it, made by a few guest instructions after the
 * wait returns -- exactly what the wait promises, and something that may
 * itself have to wait.
 */

/** InitOnceBeginInitialize's and InitOnceComplete's flags. */
const INIT_ONCE_CHECK_ONLY = 0x1;
const INIT_ONCE_ASYNC = 0x2;
const INIT_ONCE_INIT_FAILED = 0x4;

/**
 * An INIT_ONCE's word: nobody has begun, one thread is initialising, some
 * are initialising without waiting on each other, or done -- then with the
 * context in the bits above the state.
 */
const ONCE_FRESH = 0;
const ONCE_RUNNING = 1;
const ONCE_DONE = 2;
const ONCE_RUNNING_ASYNC = 3;

const ERROR_INVALID_PARAMETER = 87;
const ERROR_GEN_FAILURE = 31;

/** SleepConditionVariableSRW's flag: the lock is held, and taken back, shared. */
const CONDITION_VARIABLE_LOCKMODE_SHARED = 0x1;
const INFINITE = 0xffffffff;
/** What a condition variable's sleep that ran out of time leaves as the error. */
const ERROR_TIMEOUT = 1460;

/** @param {number} value @returns {number[]} */
const dword = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/**
 * A near call from `at` to `target`.
 *
 * @param {number} at @param {number} target
 * @returns {number[]}
 */
const call = (at, target)=>[0xe8, ...dword(target - (at + 5))];

/**
 * BOOL SleepConditionVariableSRW(PCONDITION_VARIABLE, PSRWLOCK, DWORD, ULONG),
 * as guest code around the host's wait:
 *
 *     push the four arguments; call <cv-sleep-srw>
 *     push eax
 *     test eax, eax; jnz back; call <cv-timed-out>
 *   back:
 *     test byte [flags], LOCKMODE_SHARED
 *     push lock
 *     jz exclusive
 *     call AcquireSRWLockShared; jmp done
 *   exclusive:
 *     call AcquireSRWLockExclusive
 *   done:
 *     pop eax; ret 16
 *
 * @param {number} at
 * @param {{ sleep: number, timedOut: number, shared: number, exclusive: number }} traps
 * @returns {Uint8Array}
 */
export function sleepSrwCode(at, { sleep, timedOut, shared, exclusive }){
    return new Uint8Array([
        0xff, 0x74, 0x24, 0x10, //                push [esp+16]   flags
        0xff, 0x74, 0x24, 0x10, //                push [esp+16]   milliseconds
        0xff, 0x74, 0x24, 0x10, //                push [esp+16]   lock
        0xff, 0x74, 0x24, 0x10, //                push [esp+16]   condition variable
        ...call(at + 16, sleep),
        0x50, //                                  push eax
        0x85, 0xc0, //                            test eax, eax
        0x75, 0x05, //                            jnz back (+5)
        ...call(at + 26, timedOut),
        // back:
        0xf6, 0x44, 0x24, 0x14, CONDITION_VARIABLE_LOCKMODE_SHARED, // test byte [esp+20], 1
        0xff, 0x74, 0x24, 0x0c, //                push [esp+12]   lock
        0x74, 0x07, //                            jz exclusive (+7)
        ...call(at + 42, shared),
        0xeb, 0x05, //                            jmp done (+5)
        // exclusive:
        ...call(at + 49, exclusive),
        // done:
        0x58, //                                  pop eax
        0xc2, 0x10, 0x00, //                      ret 16
    ]);
}

/**
 * BOOL SleepConditionVariableCS(PCONDITION_VARIABLE, PCRITICAL_SECTION, DWORD),
 * the same shape, taking the section back through EnterCriticalSection.
 *
 * @param {number} at
 * @param {{ sleep: number, timedOut: number, enter: number }} traps
 * @returns {Uint8Array}
 */
export function sleepCsCode(at, { sleep, timedOut, enter }){
    return new Uint8Array([
        0xff, 0x74, 0x24, 0x0c, //                push [esp+12]   milliseconds
        0xff, 0x74, 0x24, 0x0c, //                push [esp+12]   critical section
        0xff, 0x74, 0x24, 0x0c, //                push [esp+12]   condition variable
        ...call(at + 12, sleep),
        0x50, //                                  push eax
        0x85, 0xc0, //                            test eax, eax
        0x75, 0x05, //                            jnz back (+5)
        ...call(at + 22, timedOut),
        // back:
        0xff, 0x74, 0x24, 0x0c, //                push [esp+12]   critical section
        ...call(at + 31, enter),
        0x58, //                                  pop eax
        0xc2, 0x0c, 0x00, //                      ret 12
    ]);
}

/**
 * BOOL InitOnceExecuteOnce(PINIT_ONCE, PINIT_ONCE_FN, PVOID Parameter,
 * LPVOID *Context), as guest code: the host says whether this thread is the
 * one to initialise, the program's own function does it, and the host is told
 * how it went.
 *
 *     push Context; push InitOnce; call <init-once-begin>
 *     cmp eax, 1; je run
 *     test eax, eax; sete al; movzx eax, al; ret 16    ; done: TRUE, refused: FALSE
 *   run:
 *     push Context; push Parameter; push InitOnce; call [InitFn]
 *     push Context; push eax; push InitOnce; call <init-once-end>
 *     ret 16
 *
 * @param {number} at
 * @param {{ begin: number, end: number }} traps
 * @returns {Uint8Array}
 */
export function executeOnceCode(at, { begin, end }){
    return new Uint8Array([
        0xff, 0x74, 0x24, 0x10, //                push [esp+16]   Context
        0xff, 0x74, 0x24, 0x08, //                push [esp+8]    InitOnce
        ...call(at + 8, begin),
        0x83, 0xf8, 0x01, //                      cmp eax, 1
        0x74, 0x0b, //                            je run (+11)
        0x85, 0xc0, //                            test eax, eax
        0x0f, 0x94, 0xc0, //                      sete al
        0x0f, 0xb6, 0xc0, //                      movzx eax, al
        0xc2, 0x10, 0x00, //                      ret 16
        // run:
        0xff, 0x74, 0x24, 0x10, //                push [esp+16]   Context
        0xff, 0x74, 0x24, 0x10, //                push [esp+16]   Parameter
        0xff, 0x74, 0x24, 0x0c, //                push [esp+12]   InitOnce
        0xff, 0x54, 0x24, 0x14, //                call [esp+20]   InitFn
        0xff, 0x74, 0x24, 0x10, //                push [esp+16]   Context
        0x50, //                                  push eax
        0xff, 0x74, 0x24, 0x0c, //                push [esp+12]   InitOnce
        ...call(at + 54, end),
        0xc2, 0x10, 0x00, //                      ret 16
    ]);
}

/**
 * @typedef {Object} SlimHost
 * @property {any} kernel
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, expected: number, value: number) => number} [compareExchangeU32]
 *           indivisible against the guest's threads on the process's other executors
 * @property {() => any} currentThread
 * @property {(thread?: any) => any} park
 * @property {(bytes: number) => number} allocate
 * @property {(bytes: number) => number} [allocateCode]
 * @property {(code: number) => void} [setLastError]
 * @property {{ wake: (address: number) => number }} critical
 * @property {number} [pointerSize]  8 in a 64-bit process; absent, 4.
 */

/**
 * @param {SlimHost} host
 * @param {(builder: any) => number} enterCritical
 *        Where EnterCriticalSection's guest code is, placed on first use.
 */
export function createSlimSync(host, enterCritical){
    const { kernel } = host;
    const CS = criticalLayout(host.pointerSize);

    /**
     * @typedef {Object} SrwState
     * @property {any} owner      The thread holding it exclusively, or null.
     * @property {number} shared  How many hold it shared.
     * @property {{ thread: any, exclusive: boolean }[]} waiters  In arrival order.
     */
    /** @type {Map<number, SrwState>} */
    const locks = new Map();
    /** @type {Map<number, any[]>} */
    const conditions = new Map();

    /** @param {number} address */
    const lockAt = address=>{
        let state = locks.get(address);
        if (!state)
        {
            state = { owner: null, shared: 0, waiters: [] };
            locks.set(address, state);
        }
        return state;
    };

    /** @param {number} address @param {SrwState} state */
    const publish = (address, state)=>{
        const word = state.owner !== null ? 1 : state.shared > 0 ? (state.shared << 4 | 1) : 0;
        host.writeMemory(address, new Uint8Array(dword(word >>> 0)));
    };

    /**
     * Takes the lock at once when it can be taken. A reader does not join
     * readers already inside while a writer waits, or a stream of readers
     * would keep the writer out for ever.
     *
     * @param {SrwState} state @param {any} thread @param {boolean} exclusive
     */
    const take = (state, thread, exclusive)=>{
        if (exclusive)
        {
            if (state.owner !== null || state.shared > 0)
            {
                return false;
            }
            state.owner = thread;
            return true;
        }
        if (state.owner !== null || state.waiters.some(waiter=>waiter.exclusive))
        {
            return false;
        }
        state.shared++;
        return true;
    };

    /**
     * Hands a free lock to whoever waits first: one writer, or every reader
     * queued before the next writer.
     *
     * @param {number} address @param {SrwState} state
     */
    const handOn = (address, state)=>{
        while (state.waiters.length > 0 && state.owner === null)
        {
            const next = state.waiters[0];
            if (next.exclusive && state.shared > 0)
            {
                break;
            }
            state.waiters.shift();
            if (next.exclusive)
            {
                state.owner = next.thread;
            }
            else
            {
                state.shared++;
            }
            kernel.wake(next.thread, 0);
            if (next.exclusive)
            {
                break;
            }
        }
        publish(address, state);
    };

    /** @param {number} address @param {boolean} exclusive */
    const acquire = (address, exclusive)=>{
        const thread = host.currentThread();
        const state = lockAt(address);
        if (take(state, thread, exclusive))
        {
            publish(address, state);
            return 0;
        }
        state.waiters.push({ thread, exclusive });
        kernel.block(thread, `${exclusive ? 'exclusive' : 'shared'} SRW lock`
            + ` 0x${address.toString(16)}`);
        return host.park(thread);
    };

    /** @param {number} address @param {boolean} exclusive */
    const release = (address, exclusive)=>{
        const state = locks.get(address);
        if (!state)
        {
            // A lock no acquire here ever took -- a word the program set --
            // is released to free, as the word's own arithmetic would leave it.
            host.writeMemory(address, new Uint8Array(4));
            return;
        }
        if (exclusive)
        {
            state.owner = null;
        }
        else if (state.shared > 0)
        {
            state.shared--;
        }
        if (state.owner === null && state.shared === 0)
        {
            handOn(address, state);
        }
        else
        {
            publish(address, state);
        }
    };

    // A sleeper whose time ran out has stopped waiting: a wake that found it
    // still queued would be spent on nobody.
    kernel.onTimeout?.((/** @type {any} */ thread)=>{
        for (const queue of conditions.values())
        {
            const at = queue.indexOf(thread);
            if (at >= 0)
            {
                queue.splice(at, 1);
            }
        }
    });

    /**
     * Queues the caller on a condition variable, then lets go of the lock,
     * and answers TRUE when woken or FALSE when the time runs out.
     *
     * @param {number} variable @param {number} milliseconds @param {() => void} letGo
     */
    const sleep = (variable, milliseconds, letGo)=>{
        const thread = host.currentThread();
        const wait = milliseconds >>> 0;
        if (wait === 0)
        {
            letGo();
            return 0;
        }
        let queue = conditions.get(variable);
        if (!queue)
        {
            queue = [];
            conditions.set(variable, queue);
        }
        queue.push(thread);
        kernel.block(thread, `condition variable 0x${variable.toString(16)}`,
            wait === INFINITE
                ? undefined
                : { deadline: kernel.clock.virtualTime() + wait, result: 0 });
        letGo();
        return host.park(thread);
    };

    /** @param {number} variable @param {number} count */
    const wakeSleepers = (variable, count)=>{
        const queue = conditions.get(variable) ?? [];
        for (const thread of queue.splice(0, Math.min(count, queue.length)))
        {
            kernel.wake(thread, 1);
        }
    };

    /**
     * Leaves a critical section the caller entered once, as LeaveCriticalSection
     * would, from the host: the owner and its count cleared, then the count of
     * those wanting it lowered, and a waiter handed it when there is one.
     *
     * @param {number} section
     */
    const leaveSection = section=>{
        const zero = new Uint8Array(4);
        host.writeMemory(section + CS.RECURSION_COUNT, zero);
        host.writeMemory(section + CS.OWNING_THREAD, zero);
        // The count goes down as LeaveCriticalSection's `lock dec` takes it:
        // a thread on another executor entering meanwhile takes it up with
        // `lock inc`, and a plain store of the count read before lost that --
        // the section read free with the thread parked on it, never woken.
        const at = section + CS.LOCK_COUNT;
        let lockCount;
        for (;;)
        {
            const was = new DataView(host.readMemory(at, 4).slice().buffer).getInt32(0, true);
            lockCount = (was - 1) | 0;
            if (host.compareExchangeU32 === undefined)
            {
                const bytes = new Uint8Array(4);
                new DataView(bytes.buffer).setInt32(0, lockCount, true);
                host.writeMemory(at, bytes);
                break;
            }
            if ((host.compareExchangeU32(at, was >>> 0, lockCount >>> 0) | 0) === was)
            {
                break;
            }
        }
        if (lockCount >= 0)
        {
            host.critical.wake(section);
        }
    };

    /** @type {{ srw: number, cs: number } | null} */
    let stubs = null;
    /** @param {any} builder */
    const placed = builder=>{
        if (stubs)
        {
            return stubs;
        }
        const timedOut = builder.register('<cv-timed-out>', {
            argBytes: 0,
            handler: ()=>{
                host.setLastError?.(ERROR_TIMEOUT);
                return 0;
            },
        });
        const traps = {
            timedOut,
            shared: builder.register('<srw-acquire-shared>', {
                argBytes: 4,
                /** @param {number[]} args */
                handler: ([lock])=>acquire(lock >>> 0, false),
            }),
            exclusive: builder.register('<srw-acquire-exclusive>', {
                argBytes: 4,
                /** @param {number[]} args */
                handler: ([lock])=>acquire(lock >>> 0, true),
            }),
        };
        const sleepSrw = builder.register('<cv-sleep-srw>', {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([variable, lock, milliseconds, flags])=>sleep(variable >>> 0,
                milliseconds, ()=>release(lock >>> 0,
                    (flags & CONDITION_VARIABLE_LOCKMODE_SHARED) === 0)),
        });
        const sleepCs = builder.register('<cv-sleep-cs>', {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([variable, section, milliseconds])=>sleep(variable >>> 0,
                milliseconds, ()=>leaveSection(section >>> 0)),
        });
        /** @param {(at: number) => Uint8Array} code */
        const place = code=>{
            const at = (host.allocateCode ?? host.allocate)(code(0).length);
            host.writeMemory(at, code(at));
            return at;
        };
        stubs = {
            srw: place(at=>sleepSrwCode(at, { ...traps, sleep: sleepSrw })),
            cs: place(at=>sleepCsCode(at,
                { sleep: sleepCs, timedOut, enter: enterCritical(builder) })),
        };
        return stubs;
    };

    /** @param {number} address */
    const clear = address=>host.writeMemory(address, new Uint8Array(4));

    /** @param {number} address */
    const readWord = address=>new DataView(
        host.readMemory(address, 4).slice().buffer).getUint32(0, true);
    /** @param {number} address @param {number} value */
    const writeWord = (address, value)=>{
        if (address !== 0)
        {
            host.writeMemory(address, new Uint8Array(dword(value >>> 0)));
        }
    };

    /**
     * Threads blocked until an initialisation someone else began is over:
     * BeginInitialize's callers with where to say whether it is theirs now,
     * and ExecuteOnce's with where its context goes.
     *
     * @type {Map<number, { thread: any, execute: boolean, pending: number,
     *     context: number }[]>}
     */
    const onceWaiters = new Map();

    /** @param {number} code */
    const refuse = code=>{
        host.setLastError?.(code);
        return 0;
    };

    /**
     * An initialisation is over: done, and everyone waiting is told the
     * context; or failed, and the first waiting becomes the one to do it.
     *
     * @param {number} once @param {boolean} succeeded @param {number} context
     */
    const settle = (once, succeeded, context)=>{
        const waiters = onceWaiters.get(once) ?? [];
        if (succeeded)
        {
            writeWord(once, (context & ~3) | ONCE_DONE);
            onceWaiters.delete(once);
            for (const waiter of waiters)
            {
                writeWord(waiter.context, context & ~3);
                if (!waiter.execute)
                {
                    writeWord(waiter.pending, 0);
                }
                kernel.wake(waiter.thread, waiter.execute ? 0 : 1);
            }
            return;
        }
        const next = waiters.shift();
        writeWord(once, next ? ONCE_RUNNING : ONCE_FRESH);
        if (next)
        {
            if (!next.execute)
            {
                writeWord(next.pending, 1);
            }
            kernel.wake(next.thread, 1);
        }
    };

    /**
     * The caller waits for the thread initialising to finish.
     *
     * @param {number} once @param {{ execute: boolean, pending: number, context: number }} how
     */
    const awaitOnce = (once, how)=>{
        const thread = host.currentThread();
        const waiters = onceWaiters.get(once) ?? [];
        waiters.push({ thread, ...how });
        onceWaiters.set(once, waiters);
        kernel.block(thread, `one-time initialisation 0x${once.toString(16)}`);
        return host.park(thread);
    };

    /** @type {number | null} */
    let executeOnce = null;
    /** @param {any} builder */
    const executeOnceAt = builder=>{
        if (executeOnce !== null)
        {
            return executeOnce;
        }
        const begin = builder.register('<init-once-begin>', {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([pointer, context])=>{
                const once = pointer >>> 0;
                const word = readWord(once);
                switch (word & 3)
                {
                    case ONCE_DONE:
                        writeWord(context >>> 0, word & ~3);
                        return 0;
                    case ONCE_FRESH:
                        writeWord(once, ONCE_RUNNING);
                        return 1;
                    case ONCE_RUNNING:
                        return awaitOnce(once,
                            { execute: true, pending: 0, context: context >>> 0 });
                    default:
                        // Begun without waiting by someone who will finish it
                        // the same way; a caller that waits has no part in it.
                        host.setLastError?.(ERROR_INVALID_PARAMETER);
                        return 2;
                }
            },
        });
        const end = builder.register('<init-once-end>', {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([pointer, succeeded, context])=>{
                const value = (context >>> 0) === 0 ? 0 : readWord(context >>> 0);
                settle(pointer >>> 0, succeeded !== 0, value);
                return succeeded !== 0 ? 1 : 0;
            },
        });
        const code = (/** @type {number} */ at)=>executeOnceCode(at, { begin, end });
        executeOnce = (host.allocateCode ?? host.allocate)(code(0).length);
        host.writeMemory(executeOnce, code(executeOnce));
        return executeOnce;
    };

    return {
        /** VOID InitializeSRWLock(PSRWLOCK) */
        InitializeSRWLock: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([lock])=>{
                locks.delete(lock >>> 0);
                clear(lock >>> 0);
                return 0;
            },
        },
        /** VOID AcquireSRWLockExclusive(PSRWLOCK) */
        AcquireSRWLockExclusive: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([lock])=>acquire(lock >>> 0, true),
        },
        /** VOID AcquireSRWLockShared(PSRWLOCK) */
        AcquireSRWLockShared: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([lock])=>acquire(lock >>> 0, false),
        },
        /** BOOLEAN TryAcquireSRWLockExclusive(PSRWLOCK) */
        TryAcquireSRWLockExclusive: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([lock])=>{
                const state = lockAt(lock >>> 0);
                const taken = take(state, host.currentThread(), true);
                publish(lock >>> 0, state);
                return taken ? 1 : 0;
            },
        },
        /** BOOLEAN TryAcquireSRWLockShared(PSRWLOCK) */
        TryAcquireSRWLockShared: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([lock])=>{
                const state = lockAt(lock >>> 0);
                const taken = take(state, host.currentThread(), false);
                publish(lock >>> 0, state);
                return taken ? 1 : 0;
            },
        },
        /** VOID ReleaseSRWLockExclusive(PSRWLOCK) */
        ReleaseSRWLockExclusive: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([lock])=>{
                release(lock >>> 0, true);
                return 0;
            },
        },
        /** VOID ReleaseSRWLockShared(PSRWLOCK) */
        ReleaseSRWLockShared: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([lock])=>{
                release(lock >>> 0, false);
                return 0;
            },
        },

        /** VOID InitializeConditionVariable(PCONDITION_VARIABLE) */
        InitializeConditionVariable: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([variable])=>{
                conditions.delete(variable >>> 0);
                clear(variable >>> 0);
                return 0;
            },
        },
        /** VOID WakeConditionVariable(PCONDITION_VARIABLE) */
        WakeConditionVariable: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([variable])=>{
                wakeSleepers(variable >>> 0, 1);
                return 0;
            },
        },
        /** VOID WakeAllConditionVariable(PCONDITION_VARIABLE) */
        WakeAllConditionVariable: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([variable])=>{
                wakeSleepers(variable >>> 0, Infinity);
                return 0;
            },
        },
        /**
         * BOOL SleepConditionVariableSRW(PCONDITION_VARIABLE, PSRWLOCK,
         *                                DWORD dwMilliseconds, ULONG Flags)
         */
        SleepConditionVariableSRW: {
            argBytes: 16,
            /** @param {any} builder */
            guest: builder=>placed(builder).srw,
        },
        /**
         * BOOL SleepConditionVariableCS(PCONDITION_VARIABLE, PCRITICAL_SECTION,
         *                               DWORD dwMilliseconds)
         */
        SleepConditionVariableCS: {
            argBytes: 12,
            /** @param {any} builder */
            guest: builder=>placed(builder).cs,
        },

        /** VOID InitOnceInitialize(PINIT_ONCE) */
        InitOnceInitialize: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>{
                onceWaiters.delete(pointer >>> 0);
                clear(pointer >>> 0);
                return 0;
            },
        },

        /**
         * BOOL InitOnceBeginInitialize(LPINIT_ONCE, DWORD dwFlags,
         *                              PBOOL fPending, LPVOID *lpContext)
         *
         * Whether the caller is the one to initialise (pending) or it is done
         * and here is the context. A synchronous begin while another thread is
         * initialising waits for it; an asynchronous one runs beside the
         * others, and the two kinds do not mix.
         */
        InitOnceBeginInitialize: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([pointer, flags, pending, context])=>{
                const once = pointer >>> 0;
                const asked = flags >>> 0;
                if ((asked & ~(INIT_ONCE_CHECK_ONLY | INIT_ONCE_ASYNC)) !== 0
                    || asked === (INIT_ONCE_CHECK_ONLY | INIT_ONCE_ASYNC))
                {
                    return refuse(ERROR_INVALID_PARAMETER);
                }
                const async = (asked & INIT_ONCE_ASYNC) !== 0;
                const word = readWord(once);
                const state = word & 3;
                if (state === ONCE_DONE)
                {
                    writeWord(pending >>> 0, 0);
                    writeWord(context >>> 0, word & ~3);
                    return 1;
                }
                if ((asked & INIT_ONCE_CHECK_ONLY) !== 0)
                {
                    return refuse(ERROR_GEN_FAILURE);
                }
                if (state === ONCE_FRESH)
                {
                    writeWord(once, async ? ONCE_RUNNING_ASYNC : ONCE_RUNNING);
                    writeWord(pending >>> 0, 1);
                    return 1;
                }
                if (async !== (state === ONCE_RUNNING_ASYNC))
                {
                    return refuse(ERROR_INVALID_PARAMETER);
                }
                if (async)
                {
                    writeWord(pending >>> 0, 1);
                    return 1;
                }
                return awaitOnce(once,
                    { execute: false, pending: pending >>> 0, context: context >>> 0 });
            },
        },

        /**
         * BOOL InitOnceComplete(LPINIT_ONCE, DWORD dwFlags, LPVOID lpContext)
         *
         * The context keeps its two low bits clear -- they are the state --
         * and a failure has none to keep.
         */
        InitOnceComplete: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([pointer, flags, context])=>{
                const once = pointer >>> 0;
                const asked = flags >>> 0;
                const failed = (asked & INIT_ONCE_INIT_FAILED) !== 0;
                const async = (asked & INIT_ONCE_ASYNC) !== 0;
                if ((asked & ~(INIT_ONCE_ASYNC | INIT_ONCE_INIT_FAILED)) !== 0
                    || (failed && async) || ((context >>> 0) & 3) !== 0
                    || (failed && context !== 0))
                {
                    return refuse(ERROR_INVALID_PARAMETER);
                }
                const state = readWord(once) & 3;
                if (state === ONCE_FRESH || state === ONCE_DONE)
                {
                    return refuse(ERROR_GEN_FAILURE);
                }
                if (async !== (state === ONCE_RUNNING_ASYNC))
                {
                    return refuse(ERROR_INVALID_PARAMETER);
                }
                settle(once, !failed, context >>> 0);
                return 1;
            },
        },

        /**
         * BOOL InitOnceExecuteOnce(PINIT_ONCE, PINIT_ONCE_FN InitFn,
         *                          PVOID Parameter, LPVOID *Context)
         */
        InitOnceExecuteOnce: {
            argBytes: 16,
            /** @param {any} builder */
            guest: builder=>executeOnceAt(builder),
        },
    };
}
