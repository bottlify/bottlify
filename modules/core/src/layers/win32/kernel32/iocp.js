/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * I/O completion ports: the queue a finished overlapped operation lands in, and
 * the wait a worker pool spends most of its life inside.
 *
 * A port is the one kernel32 object whose entire purpose is to make a thread
 * stop. A pool calls GetQueuedCompletionStatus with an infinite timeout and
 * expects to be asleep until somebody hands it work, so answering "nothing yet"
 * instead of waiting is not merely the wrong return value: every idle worker
 * becomes a spin that eats the quantum of the thread that would have posted the
 * work, and the pool starves the program that owns it.
 *
 * The wait therefore uses the scheduler's own blocking, with the caller's
 * timeout as a deadline in guest time. The other half is that something must
 * eventually post: an overlapped ReadFile or WriteFile on a handle bound to a
 * port owes a packet when it finishes. Signalling the OVERLAPPED's event is not
 * a substitute -- the event is what a single caller polls, the packet is what
 * the pool is waiting on.
 *
 * Two details are load-bearing and easy to leave out. A thread parked on a port
 * whose handle is then closed must be woken with ERROR_ABANDONED_WAIT_0 rather
 * than left on something nothing can reach; and a handle's association with a
 * port dies with the handle, because handle numbers are recycled and a stale
 * association makes the next file's completions land in somebody else's port.
 */

/** Codes this surface reports. */
const ERROR_SUCCESS = 0;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const WAIT_TIMEOUT = 258;

/** What a wait on a port that was closed under it answers. */
const ERROR_ABANDONED_WAIT_0 = 735;

/** Waits with this timeout never give up. */
const INFINITE = 0xffffffff;

/** INVALID_HANDLE_VALUE, which CreateIoCompletionPort takes to mean "no file". */
const INVALID_HANDLE_VALUE = 0xffffffff;

/**
 * OVERLAPPED, 32-bit. Internal and InternalHigh are the operation's status and
 * its byte count, which is where GetOverlappedResult reads them from; hEvent is
 * signalled as well as the port, because a caller may be waiting on either.
 */
const OVERLAPPED_INTERNAL = 0;
const OVERLAPPED_INTERNAL_HIGH = 4;
const OVERLAPPED_OFFSET = 8;
const OVERLAPPED_EVENT = 16;

/**
 * How long a thread may wait on a port before the wait is reported as a
 * suspected hang, in host milliseconds.
 *
 * Host rather than guest time on purpose: a machine where every thread is parked
 * on a port has no deadline to move its clock to, so guest time stops and a
 * threshold measured in it would never be reached -- which is exactly the case
 * worth naming.
 */
const HANG_AFTER_MS = 10_000;

/**
 * @typedef {Object} CompletionPacket
 * @property {number} transferred
 * @property {number} key
 * @property {number} overlapped
 */

/**
 * Where a waiting call wants its answer written. Captured when the thread parks,
 * because by the time a packet arrives the thread that writes it is somebody
 * else and these pointers are all that is left of the call.
 *
 * @typedef {Object} CompletionOut
 * @property {number} bytes
 * @property {number} key
 * @property {number} overlapped
 */

/**
 * @typedef {Object} CompletionPortHost
 * @property {any} kernel                        The kernel layer's API.
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(code: number) => void} setLastError            The running thread's.
 * @property {(thread: any, code: number) => void} setLastErrorFor
 *           A parked thread's, for whoever wakes it.
 * @property {() => any} currentThread
 * @property {(thread?: any) => any} park        Stops a thread; returns the parked token.
 * @property {(handle: number) => void} signalEvent
 * @property {(text: string) => void} [trace]
 * @property {() => number} [hostTime]
 *           Host milliseconds, for the hang report alone. The wall clock unless
 *           a caller supplies one; deliberately not the guest's clock, for the
 *           reason given at HANG_AFTER_MS.
 */

/**
 * @param {CompletionPortHost} host
 */
export function createIoCompletionPorts(host){
    const { kernel } = host;
    const hostTime = host.hostTime ?? (()=>Date.now());

    /**
     * Every open port, so a timed-out thread can be taken off whichever one it
     * was queued on without being asked which.
     *
     * @type {Set<any>}
     */
    const ports = new Set();

    /**
     * fileHandle -> the port its completions go to, and the key they carry.
     *
     * One table for the process rather than one per port: a completion is posted
     * from the file's side, which knows a handle and nothing else.
     *
     * @type {Map<number, { port: any, key: number }>}
     */
    const associations = new Map();

    kernel.onTimeout((/** @type {any} */ thread)=>{
        // A thread whose wait ran out has stopped waiting. Left on the queue it
        // would be handed a packet later, consuming one nobody is there to read.
        for (const port of ports)
        {
            const at = port.waiters.findIndex((/** @type {any} */ waiter)=>waiter.thread === thread);
            if (at >= 0)
            {
                port.waiters.splice(at, 1);
            }
        }
    });

    /** @param {number} code @param {number} [result] */
    const fail = (code, result = 0)=>{
        host.setLastError(code);
        return result;
    };

    /** @param {number} address @param {number} value */
    const writeDword = (address, value)=>{
        host.writeMemory(address, new Uint8Array([
            value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff,
        ]));
    };

    /** @param {number} address @param {number} value */
    const writeDwordIf = (address, value)=>{
        if (address !== 0)
        {
            writeDword(address, value);
        }
    };

    /** @param {number} address */
    const readDword = address=>{
        const bytes = host.readMemory(address, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };

    /** @param {number} handle */
    const portOf = handle=>{
        try
        {
            return kernel.handles.resolve(handle >>> 0, 'iocp');
        }
        catch (e){
            void e;
            return null;
        }
    };

    /** @param {CompletionOut} out @param {CompletionPacket | null} packet */
    const answer = (out, packet)=>{
        writeDwordIf(out.bytes, packet ? packet.transferred : 0);
        writeDwordIf(out.key, packet ? packet.key : 0);
        writeDwordIf(out.overlapped, packet ? packet.overlapped : 0);
    };

    /**
     * A wait nobody can satisfy looks exactly like work: the threads are parked,
     * the machine is quiet, and nothing says which port is holding them. This
     * names it. Checked whenever a port is touched and whenever diagnostics are
     * read, which is the one thing that still happens while everything is parked.
     */
    const reportHangs = ()=>{
        if (!host.trace)
        {
            return;
        }
        const at = hostTime();
        for (const port of ports)
        {
            for (const waiter of port.waiters)
            {
                if (waiter.warned || at - waiter.since < HANG_AFTER_MS)
                {
                    continue;
                }
                waiter.warned = true;
                host.trace(`GetQueuedCompletionStatus: ${waiter.thread?.name ?? 'a thread'}`
                    + ` has waited ${Math.round((at - waiter.since) / 1000)}s on completion port`
                    + ` 0x${port.handle.toString(16)}, whose queue is empty -- if the program is`
                    + ' not progressing, an operation finished without posting its completion');
            }
        }
    };

    /**
     * Hands a packet to the first thread waiting for one, or queues it.
     *
     * A woken thread is answered here rather than where it parked: its call has
     * no more code to run, so this is the only moment at which both the packet
     * and the pointers it goes into are known.
     *
     * @param {any} port @param {CompletionPacket} packet
     */
    const post = (port, packet)=>{
        while (port.waiters.length > 0)
        {
            const waiter = port.waiters.shift();
            answer(waiter.out, packet);
            host.setLastErrorFor(waiter.thread, ERROR_SUCCESS);
            // A thread that is no longer blocked -- terminated while parked --
            // takes nothing with it: the packet goes to whoever is next.
            if (kernel.wake(waiter.thread, 1))
            {
                return;
            }
        }
        port.queue.push(packet);
    };

    /**
     * Wakes everyone parked on a port that is going away.
     *
     * ERROR_ABANDONED_WAIT_0 rather than a timeout, because the two mean
     * opposite things to a pool: a timeout says "ask again", and asking again
     * about a closed handle is a loop that cannot end.
     *
     * @param {any} port
     */
    const abandon = port=>{
        for (const waiter of port.waiters)
        {
            answer(waiter.out, null);
            host.setLastErrorFor(waiter.thread, ERROR_ABANDONED_WAIT_0);
            kernel.wake(waiter.thread, 0);
        }
        port.waiters.length = 0;
    };

    const table = {
        /**
         * HANDLE CreateIoCompletionPort(HANDLE FileHandle, HANDLE ExistingCompletionPort,
         *   ULONG_PTR CompletionKey, DWORD NumberOfConcurrentThreads)
         *
         * Two functions in one entry point: with an existing port it binds a
         * handle to it, without one it makes a port -- optionally binding the
         * same handle on the way past.
         */
        CreateIoCompletionPort: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([file, existing, key])=>{
                reportHangs();
                const bindable = (file >>> 0) !== INVALID_HANDLE_VALUE && file !== 0;
                if ((existing >>> 0) !== 0)
                {
                    const port = portOf(existing);
                    if (!port)
                    {
                        return fail(ERROR_INVALID_HANDLE);
                    }
                    if (!bindable)
                    {
                        // Naming a port and no file asks for nothing at all.
                        return fail(ERROR_INVALID_PARAMETER);
                    }
                    associations.set(file >>> 0, { port, key: key >>> 0 });
                    return existing >>> 0;
                }
                const port = { queue: [], waiters: [], handle: 0 };
                port.handle = kernel.handles.open('iocp', port);
                ports.add(port);
                if (bindable)
                {
                    associations.set(file >>> 0, { port, key: key >>> 0 });
                }
                return port.handle;
            },
        },

        /**
         * BOOL PostQueuedCompletionStatus(HANDLE CompletionPort,
         *   DWORD dwNumberOfBytesTransferred, ULONG_PTR dwCompletionKey,
         *   LPOVERLAPPED lpOverlapped)
         *
         * The three values are opaque to the system and come back exactly as
         * they went in, which is what makes this the way a pool is woken with a
         * private key that means "stop" rather than with a real completion.
         */
        PostQueuedCompletionStatus: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, transferred, key, overlapped])=>{
                reportHangs();
                const port = portOf(handle);
                if (!port)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                post(port, {
                    transferred: transferred >>> 0,
                    key: key >>> 0,
                    overlapped: overlapped >>> 0,
                });
                host.setLastError(ERROR_SUCCESS);
                return 1;
            },
        },

        /**
         * BOOL GetQueuedCompletionStatus(HANDLE CompletionPort,
         *   LPDWORD lpNumberOfBytes, PULONG_PTR lpCompletionKey,
         *   LPOVERLAPPED *lpOverlapped, DWORD dwMilliseconds)
         *
         * The out-parameters are cleared and the timeout error is set *before*
         * the thread parks. A wait that expires is woken by the scheduler with
         * nobody to write an answer for it, so what it finds has to be true
         * already; a packet that arrives first overwrites both.
         */
        GetQueuedCompletionStatus: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, bytes, key, overlapped, timeout])=>{
                reportHangs();
                const port = portOf(handle);
                if (!port)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                /** @type {CompletionOut} */
                const out = {
                    bytes: bytes >>> 0, key: key >>> 0, overlapped: overlapped >>> 0,
                };
                const queued = port.queue.shift();
                if (queued)
                {
                    answer(out, queued);
                    host.setLastError(ERROR_SUCCESS);
                    return 1;
                }

                // A caller reads lpOverlapped to tell a timeout from a failed
                // operation, so a stale pointer there is one it dereferences.
                answer(out, null);
                const wait = timeout >>> 0;
                if (wait === 0)
                {
                    // Zero is a poll, and the one case where not blocking is the
                    // documented behaviour rather than a shortcut.
                    return fail(WAIT_TIMEOUT);
                }

                host.setLastError(WAIT_TIMEOUT);
                const thread = host.currentThread();
                port.waiters.push({ thread, out, since: hostTime(), warned: false });
                kernel.block(thread, `completion port 0x${port.handle.toString(16)}`,
                    wait === INFINITE
                        ? undefined
                        : { deadline: kernel.clock.virtualTime() + wait, result: 0 });
                return host.park();
            },
        },
    };

    return {
        table,

        /**
         * Where an overlapped operation was asked to start.
         *
         * Windows reads the position out of the OVERLAPPED rather than from the
         * file pointer whenever one is supplied, which is how several reads of
         * one file are in flight at once without agreeing on a pointer.
         *
         * @param {number} overlapped
         */
        offsetOf: overlapped=>readDword((overlapped >>> 0) + OVERLAPPED_OFFSET),

        /**
         * Finishes an overlapped operation: the OVERLAPPED's own status fields,
         * then its event, then a packet on whichever port the handle is bound to.
         *
         * @param {number} file @param {number} transferred @param {number} overlapped
         * @returns {boolean} whether a packet was posted -- false when the handle
         *   belongs to no port, which is the ordinary case rather than a failure
         */
        completed(file, transferred, overlapped){
            const pointer = overlapped >>> 0;
            if (pointer !== 0)
            {
                writeDword(pointer + OVERLAPPED_INTERNAL, ERROR_SUCCESS);
                writeDword(pointer + OVERLAPPED_INTERNAL_HIGH, transferred >>> 0);
                const event = readDword(pointer + OVERLAPPED_EVENT);
                if (event !== 0)
                {
                    host.signalEvent(event);
                }
            }
            const association = associations.get(file >>> 0);
            if (!association)
            {
                return false;
            }
            post(association.port, {
                transferred: transferred >>> 0,
                key: association.key,
                overlapped: pointer,
            });
            return true;
        },

        /**
         * A handle has been closed. Whatever it named, its association goes with
         * it -- handle numbers are recycled, and an association that outlives its
         * handle sends the next file's completions somewhere nobody is reading.
         *
         * @param {number} handle @param {any} object  What the handle named.
         */
        closed(handle, object){
            associations.delete(handle >>> 0);
            if (!object || !ports.has(object))
            {
                return;
            }
            abandon(object);
            ports.delete(object);
            for (const [file, association] of associations)
            {
                if (association.port === object)
                {
                    associations.delete(file);
                }
            }
        },

        /**
         * Who is waiting on what, and for how long. Read by whoever drives the
         * machine: a program whose threads are all parked on a port looks
         * exactly like an idle one from outside, and this is the difference.
         */
        snapshot(){
            reportHangs();
            const at = hostTime();
            return [...ports].flatMap(port=>port.waiters.map((/** @type {any} */ waiter)=>({
                port: `0x${port.handle.toString(16)}`,
                thread: waiter.thread?.name ?? null,
                waitedMs: at - waiter.since,
                queued: port.queue.length,
            })));
        },
    };
}
