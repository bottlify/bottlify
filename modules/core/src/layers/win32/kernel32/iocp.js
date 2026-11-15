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

import { STATUS, toDosError } from '../ntdll/status.js';
import { overlappedLayout, overlappedPosition, overlappedResult } from '../common/overlapped.js';
import { dueInMs, readLargeInteger } from './due-time.js';

/** Codes this surface reports. */
const ERROR_SUCCESS = 0;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const WAIT_TIMEOUT = 258;

/** What a wait on a port that was closed under it answers. */
const ERROR_ABANDONED_WAIT_0 = 735;

/** Waits with this timeout never give up. */
const INFINITE = 0xffffffff;

/** What a native wait on a port that was closed under it answers. */
const STATUS_ABANDONED_WAIT_0 = 0x00000080;

/**
 * One packet as OVERLAPPED_ENTRY (GetQueuedCompletionStatusEx) or
 * FILE_IO_COMPLETION_INFORMATION (NtRemoveIoCompletionEx) holds it: four
 * pointer-sized fields - the key, the overlapped (ApcContext), the status
 * (Internal), the bytes (Information).
 */
const ENTRY_FIELDS = 4;

/** IO_COMPLETION_INFORMATION_CLASS: IoCompletionBasicInformation, its Depth. */
const IO_COMPLETION_BASIC_INFORMATION = 0;

/** INVALID_HANDLE_VALUE, which CreateIoCompletionPort takes to mean "no file". */
const INVALID_HANDLE_VALUE = 0xffffffff;

/**
 * OVERLAPPED, 32-bit. Internal and InternalHigh are the operation's status and
 * its byte count, which is where GetOverlappedResult reads them from; hEvent is
 * signalled as well as the port, because a caller may be waiting on either.
 */

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
 * @property {number} [error]  the Win32 error of an operation that did not
 *           succeed: GetQueuedCompletionStatus answers FALSE with it
 * @property {number} [status]  its NTSTATUS, which the native calls hand back
 *           (a packet NtSetIoCompletion queued carries whatever it was given)
 */

/**
 * Where a waiting call wants its answer written. Captured when the thread parks,
 * because by the time a packet arrives the thread that writes it is somebody
 * else and these pointers are all that is left of the call.
 *
 * @typedef {Object} CompletionOut
 * @property {'win32' | 'native' | 'entries'} form  GetQueuedCompletionStatus's
 *     three out-parameters; NtRemoveIoCompletion's key, ApcContext and
 *     IO_STATUS_BLOCK; or a list of entries (the Ex calls), of which a woken
 *     waiter is handed one
 * @property {number} bytes  the bytes' out-parameter, or the IO_STATUS_BLOCK
 * @property {number} key
 * @property {number} overlapped
 * @property {number} [removed]  where the Ex calls write how many they handed over
 */

/**
 * @typedef {Object} CompletionPortHost
 * @property {number} [pointerSize]  8 in a 64-bit process, whose OVERLAPPED is
 *     laid out wider (`overlappedLayout`); absent, 4.
 * @property {any} kernel                        The kernel layer's API.
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(code: number) => void} setLastError            The running thread's.
 * @property {(thread: any, code: number) => void} setLastErrorFor
 *           A parked thread's, for whoever wakes it.
 * @property {() => any} currentThread
 * @property {(thread?: any) => any} park        Stops a thread; returns the parked token.
 * @property {(handle: number) => void} signalEvent
 * @property {(api: string, detail: string) => void} [divergence]
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
    const layout = overlappedLayout(host.pointerSize);
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
            const at = port.takers.findIndex((/** @type {any} */ waiter)=>waiter.thread === thread);
            if (at >= 0)
            {
                port.takers.splice(at, 1);
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

    /** A packet's NTSTATUS, for one posted with a Win32 error only. @param {CompletionPacket} packet */
    const statusOf = packet=>packet.status ?? (packet.error ? STATUS.UNSUCCESSFUL : 0);

    /**
     * One packet as an entry of a list: key, overlapped, status, bytes.
     *
     * @param {number} at @param {CompletionPacket} packet
     */
    const writeEntry = (at, packet)=>{
        const width = host.pointerSize ?? 4;
        const fields = [packet.key, packet.overlapped, statusOf(packet), packet.transferred];
        fields.forEach((value, index)=>writeDword(at + index * width, value));
    };

    /** @param {CompletionOut} out @param {CompletionPacket | null} packet */
    const answer = (out, packet)=>{
        if (out.form === 'entries')
        {
            if (packet)
            {
                writeEntry(out.overlapped, packet);
            }
            writeDwordIf(out.removed ?? 0, packet ? 1 : 0);
            return;
        }
        writeDwordIf(out.key, packet ? packet.key : 0);
        writeDwordIf(out.overlapped, packet ? packet.overlapped : 0);
        if (out.form === 'native')
        {
            if (packet)
            {
                writeDword(out.bytes, statusOf(packet));
                writeDword(out.bytes + 4, packet.transferred);
            }
            return;
        }
        writeDwordIf(out.bytes, packet ? packet.transferred : 0);
    };

    /**
     * What a waiter is woken with when a packet comes: a native wait's status,
     * or the Win32 call's BOOL with its last error set.
     *
     * @param {{ thread: any, out: CompletionOut, native: boolean }} waiter
     * @param {CompletionPacket} packet
     */
    const wakeValue = (waiter, packet)=>{
        if (waiter.native)
        {
            return STATUS.SUCCESS;
        }
        host.setLastErrorFor(waiter.thread, packet.error ?? ERROR_SUCCESS);
        return waiter.out.form === 'entries' ? 1 : (packet.error ? 0 : 1);
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
            for (const waiter of port.takers)
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
        while (port.takers.length > 0)
        {
            const waiter = port.takers.pop();
            answer(waiter.out, packet);
            // A thread that is no longer blocked -- terminated while parked --
            // takes nothing with it: the packet goes to whoever is next.
            if (kernel.wake(waiter.thread, wakeValue(waiter, packet)))
            {
                return;
            }
        }
        port.queue.push(packet);
        kernel.setEvent(port);
    };

    /**
     * The first queued packet taken off, the port's signal following its
     * queue: signalled while a packet waits.
     *
     * @param {any} port
     * @returns {CompletionPacket | undefined}
     */
    const take = port=>{
        const packet = port.queue.shift();
        if (packet && port.queue.length === 0)
        {
            kernel.resetEvent(port);
        }
        return packet;
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
        for (const waiter of port.takers)
        {
            answer(waiter.out, null);
            if (!waiter.native)
            {
                host.setLastErrorFor(waiter.thread, ERROR_ABANDONED_WAIT_0);
            }
            kernel.wake(waiter.thread, waiter.native ? STATUS_ABANDONED_WAIT_0 : 0);
        }
        // And whoever waits on the port's handle itself goes too.
        kernel.setEvent(port);
        port.takers.length = 0;
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
                const port = makePort();
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
                    form: 'win32', bytes: bytes >>> 0, key: key >>> 0, overlapped: overlapped >>> 0,
                };
                const queued = take(port);
                if (queued)
                {
                    answer(out, queued);
                    // A packet of a failed operation is still dequeued: FALSE,
                    // its error, and its OVERLAPPED written.
                    host.setLastError(queued.error ?? ERROR_SUCCESS);
                    return queued.error ? 0 : 1;
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
                return parkOn(port, out, false, wait, 0);
            },
        },

        /**
         * BOOL GetQueuedCompletionStatusEx(HANDLE CompletionPort,
         *   LPOVERLAPPED_ENTRY lpCompletionPortEntries, ULONG ulCount,
         *   PULONG ulNumEntriesRemoved, DWORD dwMilliseconds, BOOL fAlertable)
         *
         * As many queued packets as there are, up to the count; with none, a
         * wait for the next, which is handed over alone.
         */
        GetQueuedCompletionStatusEx: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([handle, entries, count, removed, timeout, alertable])=>{
                reportHangs();
                if (alertable !== 0)
                {
                    host.divergence?.('GetQueuedCompletionStatusEx',
                        'an alertable dequeue is not ended by an APC');
                }
                const port = portOf(handle);
                if (!port)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if ((entries >>> 0) === 0 || (count >>> 0) === 0 || (removed >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if (drain(port, entries >>> 0, count >>> 0, removed >>> 0) > 0)
                {
                    host.setLastError(ERROR_SUCCESS);
                    return 1;
                }
                if ((timeout >>> 0) === 0)
                {
                    return fail(WAIT_TIMEOUT);
                }
                host.setLastError(WAIT_TIMEOUT);
                return parkOn(port, { form: 'entries', bytes: 0, key: 0,
                    overlapped: entries >>> 0, removed: removed >>> 0 }, false, timeout >>> 0, 0);
            },
        },
    };

    /**
     * The queued packets handed over as entries, up to `count`; how many.
     *
     * @param {any} port @param {number} entries @param {number} count @param {number} removed
     */
    const drain = (port, entries, count, removed)=>{
        let taken = 0;
        const size = ENTRY_FIELDS * (host.pointerSize ?? 4);
        for (let packet = take(port); packet; packet = taken < count ? take(port) : undefined)
        {
            writeEntry(entries + taken * size, packet);
            taken++;
        }
        writeDword(removed, taken);
        return taken;
    };

    /**
     * Parks the calling thread on a port until a packet comes or the wait
     * runs out, `expired` the value it then answers.
     *
     * @param {any} port @param {CompletionOut} out @param {boolean} native
     * @param {number} wait  milliseconds, INFINITE for none
     * @param {number} expired
     */
    const parkOn = (port, out, native, wait, expired)=>{
        const thread = host.currentThread();
        port.takers.push({ thread, out, native, since: hostTime(), warned: false });
        kernel.block(thread, `completion port 0x${port.handle.toString(16)}`,
            wait === INFINITE
                ? undefined
                : { deadline: kernel.clock.virtualTime() + wait, result: expired });
        return host.park();
    };

    /**
     * A native timeout, as the milliseconds a port wait takes: no pointer is
     * no limit.
     *
     * @param {number} pointer
     */
    const nativeWait = pointer=>((pointer >>> 0) === 0 ? INFINITE
        : Math.min(INFINITE - 1, Math.ceil(dueInMs(readLargeInteger(host.readMemory, pointer),
            kernel.clock.wallClock()))));

    /** @param {number} handle @returns {any | number} the port, or the status for a handle that names none */
    const nativePort = handle=>portOf(handle)
        ?? (kernel.handles.has?.(handle >>> 0) ? STATUS.OBJECT_TYPE_MISMATCH
            : STATUS.INVALID_HANDLE);

    /**
     * A port made, its handle open. A port is a dispatcher object on Windows,
     * which a thread may wait on as on any other: signalled while a packet is
     * queued, and released when the port is closed. It is made as the kernel's
     * manual-reset event, its queue beside, so a wait on its handle is a wait
     * on that.
     */
    const makePort = ()=>{
        const port = Object.assign(kernel.createEvent({ manualReset: true, signalled: false,
            name: 'completion port' }), { queue: [], takers: [], handle: 0 });
        port.handle = kernel.handles.open('iocp', port);
        ports.add(port);
        return port;
    };

    /**
     * The native calls over the same ports, which ntdll publishes: a packet
     * one front door queues the other dequeues. A native packet's status is
     * the caller's own; a Win32 completion's is its operation's.
     */
    const natives = {
        /**
         * NTSTATUS NtCreateIoCompletion(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES,
         *                               ULONG NumberOfConcurrentThreads)
         *
         * A port is unnamed here: one made by name is made without it, and
         * NtOpenIoCompletion finds none.
         */
        NtCreateIoCompletion: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([out, , attributes])=>{
                if ((out >>> 0) === 0)
                {
                    return STATUS.ACCESS_VIOLATION;
                }
                if ((attributes >>> 0) !== 0 && readDword((attributes >>> 0) + 8) !== 0)
                {
                    host.divergence?.('NtCreateIoCompletion',
                        'a named port is made without its name');
                }
                writeDword(out >>> 0, makePort().handle);
                return STATUS.SUCCESS;
            },
        },
        /** NTSTATUS NtOpenIoCompletion(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES) */
        NtOpenIoCompletion: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([out])=>((out >>> 0) === 0 ? STATUS.ACCESS_VIOLATION
                : STATUS.OBJECT_NAME_NOT_FOUND),
        },
        /**
         * NTSTATUS NtSetIoCompletion(HANDLE, PVOID KeyContext, PVOID ApcContext,
         *                            NTSTATUS IoStatus, ULONG_PTR IoStatusInformation)
         */
        NtSetIoCompletion: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, key, apc, status, information])=>
                setCompletion(handle, key, apc, status, information),
        },
        /**
         * NTSTATUS NtSetIoCompletionEx(HANDLE, HANDLE ReserveObject, PVOID KeyContext,
         *   PVOID ApcContext, NTSTATUS IoStatus, ULONG_PTR IoStatusInformation)
         */
        NtSetIoCompletionEx: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([handle, , key, apc, status, information])=>
                setCompletion(handle, key, apc, status, information),
        },
        /**
         * NTSTATUS NtRemoveIoCompletion(HANDLE, PVOID *KeyContext, PVOID *ApcContext,
         *                               PIO_STATUS_BLOCK, PLARGE_INTEGER Timeout)
         */
        NtRemoveIoCompletion: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, key, apc, iosb, timeout])=>{
                const port = nativePort(handle);
                if (typeof port === 'number')
                {
                    return port;
                }
                if ((key >>> 0) === 0 || (apc >>> 0) === 0 || (iosb >>> 0) === 0)
                {
                    return STATUS.ACCESS_VIOLATION;
                }
                /** @type {CompletionOut} */
                const out = { form: 'native', bytes: iosb >>> 0, key: key >>> 0,
                    overlapped: apc >>> 0 };
                const queued = take(port);
                if (queued)
                {
                    answer(out, queued);
                    return STATUS.SUCCESS;
                }
                const wait = nativeWait(timeout);
                return wait === 0 ? STATUS.TIMEOUT : parkOn(port, out, true, wait, STATUS.TIMEOUT);
            },
        },
        /**
         * NTSTATUS NtRemoveIoCompletionEx(HANDLE,
         *   PFILE_IO_COMPLETION_INFORMATION Information, ULONG Count, PULONG Removed,
         *   PLARGE_INTEGER Timeout, BOOLEAN Alertable)
         */
        NtRemoveIoCompletionEx: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([handle, entries, count, removed, timeout])=>{
                const port = nativePort(handle);
                if (typeof port === 'number')
                {
                    return port;
                }
                if ((entries >>> 0) === 0 || (removed >>> 0) === 0)
                {
                    return STATUS.ACCESS_VIOLATION;
                }
                if ((count >>> 0) === 0)
                {
                    return STATUS.INVALID_PARAMETER;
                }
                if (drain(port, entries >>> 0, count >>> 0, removed >>> 0) > 0)
                {
                    return STATUS.SUCCESS;
                }
                const wait = nativeWait(timeout);
                return wait === 0 ? STATUS.TIMEOUT
                    : parkOn(port, { form: 'entries', bytes: 0, key: 0, overlapped: entries >>> 0,
                        removed: removed >>> 0 }, true, wait, STATUS.TIMEOUT);
            },
        },
        /**
         * NTSTATUS NtQueryIoCompletion(HANDLE, IO_COMPLETION_INFORMATION_CLASS,
         *                              PVOID, ULONG, PULONG)
         *
         * IO_COMPLETION_BASIC_INFORMATION: Depth, the packets queued.
         */
        NtQueryIoCompletion: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, kind, buffer, length, returned])=>{
                const port = nativePort(handle);
                if (typeof port === 'number')
                {
                    return port;
                }
                if (kind !== IO_COMPLETION_BASIC_INFORMATION)
                {
                    return STATUS.INVALID_INFO_CLASS;
                }
                if ((length >>> 0) < 4)
                {
                    return STATUS.INFO_LENGTH_MISMATCH;
                }
                if ((buffer >>> 0) === 0)
                {
                    return STATUS.ACCESS_VIOLATION;
                }
                writeDword(buffer >>> 0, port.queue.length);
                writeDwordIf(returned >>> 0, 4);
                return STATUS.SUCCESS;
            },
        },
    };

    /**
     * A packet the caller made queued, as NtSetIoCompletion does.
     *
     * @param {number} handle @param {number} key @param {number} apc
     * @param {number} status @param {number} information
     */
    const setCompletion = (handle, key, apc, status, information)=>{
        const port = nativePort(handle);
        if (typeof port === 'number')
        {
            return port;
        }
        const error = (status >>> 0) >>> 30 === 3 ? toDosError(status >>> 0) : 0;
        post(port, { transferred: information >>> 0, key: key >>> 0, overlapped: apc >>> 0,
            status: status >>> 0, ...error !== 0 ? { error } : {} });
        return STATUS.SUCCESS;
    };
    /** @type {any} */ (table.CreateIoCompletionPort).natives = natives;

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
        offsetOf: overlapped=>overlappedPosition(readDword, layout, overlapped >>> 0),

        /**
         * Finishes an overlapped operation: the OVERLAPPED's own status fields,
         * then its event, then a packet on whichever port the handle is bound to.
         * An operation that ended in an error status still posts, and the
         * packet answers FALSE with its error; `skip` is what the handle's
         * completion modes leave out of one that succeeded at once.
         *
         * @param {number} file @param {number} transferred @param {number} overlapped
         * @param {number} [status]  NTSTATUS, success by default
         * @param {{ port?: boolean, event?: boolean }} [skip]
         * @returns {boolean} whether a packet was posted -- false when the handle
         *   belongs to no port, which is the ordinary case rather than a failure
         */
        completed(file, transferred, overlapped, status = 0, skip = {}){
            const pointer = overlapped >>> 0;
            if (pointer !== 0)
            {
                overlappedResult(writeDword, layout, pointer, status, transferred);
                const event = readDword(pointer + layout.event);
                if (event !== 0 && !skip.event)
                {
                    host.signalEvent(event);
                }
            }
            const association = associations.get(file >>> 0);
            if (!association || skip.port)
            {
                return false;
            }
            const error = (status >>> 0) === 0 ? 0 : toDosError(status >>> 0);
            post(association.port, {
                transferred: transferred >>> 0,
                key: association.key,
                overlapped: pointer,
                status: status >>> 0,
                ...error !== 0 ? { error } : {},
            });
            return true;
        },

        /**
         * Binds a file handle to a port under a key: what CreateIoCompletionPort
         * does with an existing port, and NtSetInformationFile's
         * FileCompletionInformation, which is the same binding.
         *
         * @param {number} file @param {number} portHandle @param {number} key
         * @returns {boolean} false when the port handle names no port
         */
        bind(file, portHandle, key){
            const port = portOf(portHandle);
            if (!port)
            {
                return false;
            }
            associations.set(file >>> 0, { port, key: key >>> 0 });
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
            return [...ports].flatMap(port=>port.takers.map((/** @type {any} */ waiter)=>({
                port: `0x${port.handle.toString(16)}`,
                thread: waiter.thread?.name ?? null,
                waitedMs: at - waiter.since,
                queued: port.queue.length,
            })));
        },
    };
}
