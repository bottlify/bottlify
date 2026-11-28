/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The thread pool's shapes, which its threads and waits (`pool.js`) and the
 * thread pool API over them (`threadpool-api.js`) both speak.
 */

/**
 * @typedef {Object} ThreadPoolHost
 * @property {any} kernel  `createThread`, `block`, `alertably`, `wake`, `currentThread`, the
 *           timers (`createTimer`, `armTimer`, `cancelTimer`), `setEvent`,
 *           `handles` and the guest clock.
 * @property {(name: string, fn: { argBytes: number, handler: Function }) => number} register
 *           Puts a host function behind a guest address: the loop's trap.
 * @property {(bytes: number) => number} allocate
 * @property {number} [pointerSize]  8 in a 64-bit process; absent, 4.
 *           Guest memory for what a program is handed as a handle, which on
 *           Windows is an address too, and 0 when there is none.
 * @property {(bytes: number) => number} [allocateCode]
 *           Pages of their own for the loop (`code-arena.js`).
 * @property {(address: number) => void} [free]
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => void }}
 *     [processHeap]  Blocks of the process heap, zeroed, for the objects a program
 *           is handed (a pool, a cleanup group, a work, timer, wait or I/O
 *           object): Windows makes them there, and HeapValidate on
 *           GetProcessHeap() knows one until it is released. Absent, `allocate`.
 * @property {import('../common/guest.js').Guest} guest
 * @property {() => number} [wallClock]  Milliseconds since 1970, which an
 *           absolute due time is counted against; absent, the guest's clock.
 * @property {(thread: any) => void} [threadBlock]
 *           Gives a pool thread its environment block, as CreateThread's are.
 * @property {(thread: any) => any} park  Stops a thread inside a trap.
 * @property {(code: number) => void} setLastError
 * @property {(count: number, handles: number, milliseconds: number) => any} [waitFor]
 *           WaitForMultipleObjectsEx for any of them, alertable, from inside a
 *           trap: its answer, or the park that answers it later. Alertable,
 *           because a wait thread runs the routines queued to it, and because
 *           a wait added to or taken from it starts its wait again
 *           (`kernel.alert`). Absent, no wait can be registered.
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {() => number} [threadReturn]  Where a thread that returns ends.
 * @property {() => number} [threadStart]
 *           Where a pool thread begins, as CreateThread's do: the libraries
 *           told of it, then its loop. Zero, or absent, and it begins in its loop.
 * @property {(name: string, args: number[]) => any} [call]
 *           Another kernel32 export's handler, by name: what a callback asked
 *           to be done once it returns (ReleaseSemaphore, SetEvent, ...).
 * @property {(call: { entry: number, args: number[], thread: any }) => Promise<number>} [callGuest]
 *           A guest routine called from inside a trap: a cleanup group's
 *           cancel callbacks, on the thread that closes its members.
 * @property {() => { reserve: number, commit: number } | null} [imageStack]
 *           The program's SizeOfStackReserve and SizeOfStackCommit, a pool's
 *           stack sizes until it is given its own.
 * @property {(file: number, sink: ((packet: any) => void) | null)
 *     => boolean | 'synchronous'} [bindIo]
 *           Sends a file's completions to a thread pool I/O object (`iocp.js`
 *           `bindSink`), or with null takes them back.
 */

/**
 * A callback handed to the pool, and whatever counts it as outstanding until
 * it has returned.
 *
 * @typedef {Object} Job
 * @property {number} entry
 * @property {number[]} args
 * @property {Owner} owner
 * @property {boolean} [instanced]  handed its callback instance before `args`
 * @property {Instance} [state]  what the callback asked of its instance
 * @property {boolean} [finalizing]  the owner's FinalizationCallback, after its callback
 * @property {() => void} [done]  told once the callback has returned
 */

/**
 * A running callback's instance: what it asked to be done once it returns,
 * and whether it has let its owner go (DisassociateCurrentThreadFromCallback).
 *
 * @typedef {Object} Instance
 * @property {[string, number[]][]} completion  kernel32 calls, in the order Windows makes them
 * @property {boolean} disassociated
 * @property {boolean} long  said to run long (CallbackMayRunLong)
 */

/**
 * @typedef {Object} Waiter
 * @property {any} [thread]  blocked in a deletion that waits
 * @property {any} [event]   a kernel event to set
 * @property {number} until  finished once no more than this many are outstanding
 * @property {number} [answer]  what the blocked thread's call answers when it is woken
 */

/**
 * Anything whose callbacks a deletion can wait for.
 *
 * @typedef {Object} Owner
 * @property {number} outstanding  handed to the pool and not yet returned
 * @property {Waiter[]} waiters
 * @property {() => void} [settled]  told each time one returns
 * @property {number} [live]  handed to the pool and not yet returned, let go or not
 * @property {number} [served]  when a callback of it was last taken from a backlog
 * @property {Set<() => void>} [gathers]  waits for many owners at once, told each time
 * @property {number} [finalization]  its environment's FinalizationCallback, called on the
 *     same thread once each of its callbacks returns, with its instance and context
 * @property {number} [context]
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
 *     timeout: number, id: number, once: boolean, inWaitThread: boolean,
 *     cancelled: boolean, spent: boolean, home?: any, owner?: Owner,
 *     argsFor?: (result: number) => number[], lane?: Lane, instanced?: boolean }} Wait
 *     `id`: its time-out's in its wait thread's deadlines, -1 off one; `spent`: a wait
 *     that fires once has fired; `home`: the wait thread it is on, while it is;
 *     `lane`: the pool its callback runs on, the process's unless a thread
 *     pool wait's own.
 */

/**
 * Threads that take callbacks from one backlog: a pool's, and the wait
 * thread's, which runs a WT_EXECUTEINWAITTHREAD callback where Windows runs
 * it -- on the one thread its waits share, one callback after the other.
 *
 * @typedef {Object} Lane
 * @property {string} name
 * @property {number} max  threads at most, and callbacks running at once
 * @property {number} threads  made, started or not
 * @property {Worker[]} idle
 * @property {Job[]} backlog
 * @property {number} starting  made and not yet at their first question
 * @property {{ reserve: number, commit: number }} [stack]  its threads' stacks
 * @property {() => boolean} [retiring]  its threads end once idle (a pool closed)
 */

/**
 * @typedef {Object} Worker
 * @property {any} thread
 * @property {number} record  also the instance its callbacks are handed
 * @property {Job | null} job
 * @property {Lane} lane
 */

export {};
