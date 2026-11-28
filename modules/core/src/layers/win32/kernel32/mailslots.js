/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { overlappedLayout, overlappedResult } from '../common/overlapped.js';
import { wholeAddress } from '../common/pointers.js';

/**
 * Mailslots: a queue of messages one server handle reads and any number of
 * client handles write, found by a name under `\\.\mailslot\`.
 *
 * A message is read whole or not at all: a buffer too small for the next
 * one is refused and the message stays. A read of an empty slot waits the
 * slot's read timeout in guest time, as the completion ports wait, and a
 * write hands its message straight to a reader waiting for one.
 *
 * The slots are the process's own: a client in another process does not
 * find them.
 */

const ERROR_SUCCESS = 0;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_INVALID_NAME = 123;
const ERROR_SEM_TIMEOUT = 121;
const ERROR_ALREADY_EXISTS = 183;
const ERROR_NOACCESS = 998;
const ERROR_INVALID_PARAMETER = 87;
const STATUS_SUCCESS = 0;
const STATUS_ACCESS_VIOLATION = 0xc0000005;
const STATUS_INVALID_PARAMETER = 0xc000000d;
const STATUS_INVALID_INFO_CLASS = 0xc0000003;
const STATUS_INFO_LENGTH_MISMATCH = 0xc0000004;
const STATUS_OBJECT_NAME_INVALID = 0xc0000033;
const STATUS_OBJECT_NAME_COLLISION = 0xc0000035;
/** IO_STATUS_BLOCK.Information of a slot made. */
const FILE_CREATED = 2;
const STATUS_ACCESS_DENIED = 0xc0000022;
const STATUS_BUFFER_TOO_SMALL = 0xc0000023;
const STATUS_IO_TIMEOUT = 0xc00000b5;
const INVALID_HANDLE_VALUE = 0xffffffff;
const GENERIC_WRITE = 0x40000000;
const FILE_WRITE_DATA = 0x2;

/** What GetMailslotInfo says of the next message when there is none. */
const MAILSLOT_NO_MESSAGE = 0xffffffff;
/** CreateOptions' two synchronous modes: a handle without either does not wait. */
const FILE_SYNCHRONOUS_IO_ALERT = 0x10;
const FILE_SYNCHRONOUS_IO_NONALERT = 0x20;
const STATUS_PENDING = 0x103;
/** A read timeout that never runs out. */
const MAILSLOT_WAIT_FOREVER = 0xffffffff;

/** NtQueryInformationFile's FileMailslotQueryInformation, and its record's size. */
const FILE_MAILSLOT_QUERY_INFORMATION = 26;
const MAILSLOT_QUERY_SIZE = 24;
/** NtSetInformationFile's FileMailslotSetInformation: a pointer to the read timeout. */
const FILE_MAILSLOT_SET_INFORMATION = 27;
/** The read timeout a slot that waits for ever reports: the largest positive interval. */
const FOREVER_INTERVAL = 0x7fffffffffffffffn;

/** The prefix every mailslot a process makes is named under. */
const LOCAL_PREFIX = '\\\\.\\mailslot\\';

/**
 * @typedef {Object} Slot
 * @property {string} key  the name, upper-cased
 * @property {number} maxSize  0 for any size
 * @property {number} timeout  milliseconds, or MAILSLOT_WAIT_FOREVER
 * @property {Uint8Array[]} messages
 * @property {Reader[]} readers
 * @property {boolean} [asynchronous]  made without FILE_SYNCHRONOUS_IO_*: a native read
 *     answers STATUS_PENDING and finishes later, as CreateMailslot's and
 *     NtCreateMailslotFile's handles do on Windows
 */

/**
 * A thread parked reading an empty slot, and where its answer goes.
 *
 * @typedef {Object} Reader
 * @property {any} thread
 * @property {number} buffer
 * @property {number} length
 * @property {boolean} native  NtReadFile's, answered with a status
 * @property {number} out  the count's address, or the IO_STATUS_BLOCK's
 * @property {{ event: number, apc: number, context: number }} [async]  a native read
 *     that did not wait: it finishes through its block, event, APC and port
 * @property {any} [timer]  the kernel timer that ends an asynchronous read's wait
 * @property {number} [handle]
 */

/**
 * @typedef {Object} MailslotHost
 * @property {any} kernel  block, wake, onTimeout and the guest clock
 * @property {{ open: (type: string, object: any) => number,
 *     resolve: (handle: number, type?: string) => any,
 *     typeOf?: (handle: number) => string | null,
 *     holds?: (object: any) => boolean }} handles
 * @property {import('../common/guest.js').Guest} guest
 * @property {(code: number) => void} setLastError
 * @property {(thread: any, code: number) => void} setLastErrorFor
 * @property {() => any} currentThread
 * @property {() => any} park
 * @property {number} [pointerSize]  8 in a 64-bit process, whose IO_STATUS_BLOCK
 *     holds Information eight bytes in; absent, 4.
 * @property {(event: number) => void} [setEvent]
 * @property {(thread: any, routine: number, args: number[]) => void} [queueApc]
 * @property {(file: number, transferred: number, status: number, value: number) => boolean}
 *     [posted]  a native read's packet to the handle's port, its ApcContext the value
 */

/** A name read whole, as Windows reads it. */
const WHOLE_NAME = 32767;

/**
 * Whether a name is a mailslot's, as CreateFile is handed one.
 *
 * @param {string} name
 */
export const isMailslotName = name=>name.toUpperCase().startsWith(LOCAL_PREFIX.toUpperCase());

/** @param {MailslotHost} host */
export function createMailslots(host){
    const { guest } = host;
    const { kernel } = host;

    /** @type {Map<string, Slot>} */
    const slots = new Map();

    /** @param {number} code @param {number} [result] */
    const fail = (code, result = 0)=>{
        host.setLastError(code);
        return result;
    };

    /** @param {number} address @param {number} value */
    const writeDwordIf = (address, value)=>{
        if (address !== 0)
        {
            guest.setBytes(address, Uint8Array.of(value & 0xff, (value >>> 8) & 0xff,
                (value >>> 16) & 0xff, value >>> 24));
        }
    };

    const layout = overlappedLayout(host.pointerSize);
    /**
     * A native call's IO_STATUS_BLOCK, status and Information each a pointer
     * wide; a null one is not written.
     *
     * @param {number} block @param {number} status @param {number} count
     */
    const statusBlock = (block, status, count)=>{
        if (block !== 0)
        {
            overlappedResult(writeDwordIf, layout, block, status, count);
        }
    };

    /**
     * The slot a name is in use by. A slot whose server handle has been
     * closed gives its name up.
     *
     * @param {string} key
     */
    const live = key=>{
        const slot = slots.get(key);
        if (slot && host.handles.holds && !host.handles.holds(slot))
        {
            slots.delete(key);
            return null;
        }
        return slot ?? null;
    };

    /** @param {number} handle @param {string} type */
    const object = (handle, type)=>{
        try
        {
            return host.handles.resolve(handle >>> 0, type);
        }
        catch (e){
            void e;
            return null;
        }
    };

    kernel.onTimeout((/** @type {any} */ thread)=>{
        // A reader whose wait ran out has gone; a message written later
        // stays in the slot for the next read.
        for (const slot of slots.values())
        {
            slot.readers = slot.readers.filter(reader=>reader.thread !== thread);
        }
    });

    /**
     * Makes a slot under a name: its handle, or the Win32 error that refused it.
     *
     * @param {string | null} name @param {number} maxSize @param {number} timeout
     * @param {boolean} [asynchronous]
     * @returns {{ handle: number } | { error: number }}
     */
    const make = (name, maxSize, timeout, asynchronous = true)=>{
        if (name === null)
        {
            return { error: ERROR_PATH_NOT_FOUND };
        }
        if (!isMailslotName(name) || name.length === LOCAL_PREFIX.length)
        {
            return { error: ERROR_INVALID_NAME };
        }
        const key = name.toUpperCase();
        if (live(key))
        {
            return { error: ERROR_ALREADY_EXISTS };
        }
        /** @type {Slot} */
        const slot = { key, maxSize: maxSize >>> 0, timeout: timeout >>> 0, messages: [],
            readers: [], asynchronous };
        slots.set(key, slot);
        return { handle: host.handles.open('mailslot', slot) };
    };

    /**
     * CreateMailslot's answer: the handle, or INVALID_HANDLE_VALUE and the error.
     *
     * @param {string | null} name @param {number} maxSize @param {number} timeout
     */
    const create = (name, maxSize, timeout)=>{
        const made = make(name, maxSize, timeout);
        if ('error' in made)
        {
            return fail(made.error, INVALID_HANDLE_VALUE);
        }
        host.setLastError(ERROR_SUCCESS);
        return made.handle;
    };

    /**
     * NtCreateMailslotFile's name, in the object namespace (`\??\MAILSLOT\x`,
     * `\Device\MailSlot\x`), as the Win32 one CreateMailslot takes, or null
     * for a name that is not a mailslot's.
     *
     * @param {string} name
     */
    const win32Name = name=>{
        const named = /^\\(?:\?\?\\MAILSLOT|Device\\MailSlot)\\(.+)$/i.exec(name);
        return named ? `${LOCAL_PREFIX}${named[1]}` : null;
    };

    /**
     * NTSTATUS NtCreateMailslotFile(PHANDLE, ULONG DesiredAccess, POBJECT_ATTRIBUTES,
     *   PIO_STATUS_BLOCK, ULONG CreateOptions, ULONG MailslotQuota,
     *   ULONG MaxMessageSize, PLARGE_INTEGER ReadTimeout)
     *
     * CreateMailslot's slot under its native name. The read timeout is an
     * interval in 100 ns units, negative as a relative one is; none waits
     * for ever.
     *
     * @param {number[]} args
     */
    const ntCreateMailslotFile = ([out, , attributes, block, options, , maxSize, timeout])=>{
        if ((out >>> 0) === 0 || (attributes >>> 0) === 0)
        {
            return STATUS_ACCESS_VIOLATION;
        }
        const string = guest.u32((attributes >>> 0) + 8);
        const nameBytes = string === 0 ? 0 : guest.u32(string) & 0xffff;
        const buffer = string === 0 ? 0 : guest.u32(string + 4);
        const name = buffer === 0 ? '' : guest.wstr(buffer, (nameBytes >>> 1) * 2);
        const asked = win32Name(name);
        if (asked === null)
        {
            return STATUS_OBJECT_NAME_INVALID;
        }
        let milliseconds = MAILSLOT_WAIT_FOREVER;
        if ((timeout >>> 0) !== 0)
        {
            const interval = guest.i64(wholeAddress(timeout));
            milliseconds = interval > 0n ? MAILSLOT_WAIT_FOREVER : Number(-interval / 10000n);
        }
        const made = make(asked, maxSize, milliseconds, ((options >>> 0)
            & (FILE_SYNCHRONOUS_IO_ALERT | FILE_SYNCHRONOUS_IO_NONALERT)) === 0);
        if ('error' in made)
        {
            return made.error === ERROR_ALREADY_EXISTS ? STATUS_OBJECT_NAME_COLLISION
                : STATUS_OBJECT_NAME_INVALID;
        }
        writeDwordIf(out >>> 0, made.handle);
        if ((block >>> 0) !== 0)
        {
            writeDwordIf(block >>> 0, STATUS_SUCCESS);
            writeDwordIf((block >>> 0) + 4, FILE_CREATED);
        }
        return STATUS_SUCCESS;
    };

    /**
     * The answers a call gives, in its own terms: ReadFile and WriteFile a
     * count, TRUE or FALSE and the last error; NtReadFile and NtWriteFile
     * an IO_STATUS_BLOCK, written only when the transfer happens, and a
     * status.
     *
     * @typedef {Object} Caller
     * @property {boolean} native
     * @property {number} out  the count's address, or the IO_STATUS_BLOCK's
     */

    /** @param {Caller} caller @param {number} count */
    const report = (caller, count)=>{
        if (caller.native)
        {
            statusBlock(caller.out, STATUS_SUCCESS, count);
            return;
        }
        writeDwordIf(caller.out, count);
    };

    /** @param {Caller} caller @param {number} count */
    const succeed = (caller, count)=>{
        report(caller, count);
        if (caller.native)
        {
            return STATUS_SUCCESS;
        }
        host.setLastError(ERROR_SUCCESS);
        return 1;
    };

    /** @param {Caller} caller @param {number} code @param {number} status */
    const refuse = (caller, code, status)=>(caller.native ? status : fail(code));

    /**
     * Finishes a native read that did not wait: its block, its event, its APC
     * on the thread that asked, and a packet for the handle's port.
     *
     * @param {Reader} reader @param {number} status @param {number} count
     */
    const finishAsync = (reader, status, count)=>{
        const io = /** @type {NonNullable<Reader['async']>} */ (reader.async);
        if (reader.timer)
        {
            kernel.cancelTimer(reader.timer);
        }
        statusBlock(reader.out, status, count);
        if (io.event !== 0)
        {
            host.setEvent?.(io.event);
        }
        if (io.apc !== 0)
        {
            host.queueApc?.(reader.thread, io.apc, [io.context, reader.out, 0]);
        }
        host.posted?.(reader.handle ?? 0, count, status, io.context);
        return true;
    };

    /**
     * Gives a parked reader its answer and wakes it.
     *
     * @param {Reader} reader @param {Uint8Array | null} message  null: too big for it
     * @returns {boolean} whether the reader was still waiting
     */
    const answerReader = (reader, message)=>{
        if (reader.async)
        {
            if (message === null)
            {
                return finishAsync(reader, STATUS_BUFFER_TOO_SMALL, 0);
            }
            if (message.length > 0)
            {
                guest.setBytes(reader.buffer, message);
            }
            return finishAsync(reader, STATUS_SUCCESS, message.length);
        }
        if (message === null)
        {
            if (!reader.native)
            {
                host.setLastErrorFor(reader.thread, ERROR_INSUFFICIENT_BUFFER);
            }
            return kernel.wake(reader.thread, reader.native ? STATUS_BUFFER_TOO_SMALL : 0);
        }
        if (message.length > 0)
        {
            guest.setBytes(reader.buffer, message);
        }
        report(reader, message.length);
        if (!reader.native)
        {
            host.setLastErrorFor(reader.thread, ERROR_SUCCESS);
        }
        return kernel.wake(reader.thread, reader.native ? STATUS_SUCCESS : 1);
    };

    /**
     * CreateFile on a mailslot's name: a client handle that writes to it.
     *
     * @param {string} name @param {number} access
     * @returns {{ handle: number } | { error: number }}
     */
    const open = (name, access)=>{
        const slot = live(name.toUpperCase());
        if (!slot)
        {
            return { error: ERROR_FILE_NOT_FOUND };
        }
        const write = ((access >>> 0) & (GENERIC_WRITE | FILE_WRITE_DATA)) !== 0;
        return { handle: host.handles.open('mailslot-client', { slot, write }) };
    };

    /**
     * A read of a mailslot handle, or null for a handle that is none. A
     * client is no reader of its slot.
     *
     * @param {number} handle @param {number} buffer @param {number} length
     * @param {number} out  the count's address, or the IO_STATUS_BLOCK's
     * @param {boolean} [native]  NtReadFile's answers rather than ReadFile's
     * @param {number} [overlapped]  ReadFile's, which a mailslot read here waits for
     * @param {{ event: number, apc: number, context: number }} [io]  NtReadFile's
     *     event, APC and context: on an asynchronous handle the read does not wait
     */
    const read = (handle, buffer, length, out, native = false, overlapped = 0, io = undefined)=>{
        void overlapped;
        const kind = host.handles.typeOf?.(handle >>> 0) ?? null;
        /** @type {Caller} */
        const caller = { native, out: out >>> 0 };
        if (kind === 'mailslot-client')
        {
            return refuse(caller, ERROR_INVALID_PARAMETER, STATUS_INVALID_PARAMETER);
        }
        if (kind !== 'mailslot')
        {
            return null;
        }
        const slot = /** @type {Slot} */ (object(handle, 'mailslot'));
        const next = slot.messages[0];
        if (next)
        {
            if (next.length > (length >>> 0))
            {
                return refuse(caller, ERROR_INSUFFICIENT_BUFFER, STATUS_BUFFER_TOO_SMALL);
            }
            if ((buffer >>> 0) === 0 && next.length > 0)
            {
                return refuse(caller, ERROR_NOACCESS, STATUS_ACCESS_VIOLATION);
            }
            slot.messages.shift();
            if (next.length > 0)
            {
                guest.setBytes(wholeAddress(buffer), next);
            }
            return succeed(caller, next.length);
        }
        if (slot.timeout === 0)
        {
            return refuse(caller, ERROR_SEM_TIMEOUT, STATUS_IO_TIMEOUT);
        }
        if (native && io && slot.asynchronous)
        {
            /** @type {Reader} */
            const reader = { thread: host.currentThread(), buffer: buffer >>> 0,
                length: length >>> 0, ...caller, async: io, handle: handle >>> 0 };
            slot.readers.push(reader);
            if (slot.timeout !== MAILSLOT_WAIT_FOREVER)
            {
                // The read timeout ends it with STATUS_IO_TIMEOUT in its block.
                reader.timer = kernel.createTimer({ manualReset: true,
                    name: `mailslot ${slot.key}` });
                kernel.armTimer(reader.timer, kernel.clock.virtualTime() + slot.timeout, 0,
                    ()=>{
                        if (slot.readers.includes(reader))
                        {
                            slot.readers = slot.readers.filter(one=>one !== reader);
                            reader.timer = undefined;
                            finishAsync(reader, STATUS_IO_TIMEOUT, 0);
                        }
                    });
            }
            return STATUS_PENDING;
        }
        // Answered by the write that brings a message, or by the clock.
        if (!native)
        {
            host.setLastError(ERROR_SEM_TIMEOUT);
        }
        const thread = host.currentThread();
        slot.readers.push({ thread, buffer: buffer >>> 0, length: length >>> 0, ...caller });
        kernel.block(thread, `mailslot ${slot.key}`, slot.timeout === MAILSLOT_WAIT_FOREVER
            ? undefined
            : { deadline: kernel.clock.virtualTime() + slot.timeout,
                result: native ? STATUS_IO_TIMEOUT : 0 });
        return host.park();
    };

    /**
     * A write to a mailslot handle, or null for a handle that is none. The
     * server is no writer of its own slot.
     *
     * @param {number} handle @param {number} buffer @param {number} length
     * @param {number} out  the count's address, or the IO_STATUS_BLOCK's
     * @param {boolean} [native]  NtWriteFile's answers rather than WriteFile's
     */
    const write = (handle, buffer, length, out, native = false)=>{
        const kind = host.handles.typeOf?.(handle >>> 0) ?? null;
        /** @type {Caller} */
        const caller = { native, out: out >>> 0 };
        if (kind === 'mailslot')
        {
            return refuse(caller, ERROR_ACCESS_DENIED, STATUS_ACCESS_DENIED);
        }
        if (kind !== 'mailslot-client')
        {
            return null;
        }
        const client = object(handle, 'mailslot-client');
        if (!client.write)
        {
            return refuse(caller, ERROR_ACCESS_DENIED, STATUS_ACCESS_DENIED);
        }
        const count = length >>> 0;
        if ((buffer >>> 0) === 0 && count !== 0)
        {
            return refuse(caller, ERROR_NOACCESS, STATUS_ACCESS_VIOLATION);
        }
        const message = count === 0
            ? new Uint8Array(0) : guest.snapshot(wholeAddress(buffer), count);
        /** @type {Slot} */
        const slot = client.slot;
        const answer = succeed(caller, count);
        while (slot.readers.length > 0)
        {
            const reader = /** @type {Reader} */ (slot.readers.shift());
            if (message.length > reader.length)
            {
                // Too big for this reader: it is told so and the message stays.
                answerReader(reader, null);
                continue;
            }
            if (answerReader(reader, message))
            {
                return answer;
            }
        }
        slot.messages.push(message);
        return answer;
    };

    /**
     * What NtQueryInformationFile answers of a mailslot handle, server or
     * client, or null for a handle that is none. The read timeout is an
     * interval in 100 ns units, negative as a relative one is.
     *
     * @param {number} handle @param {number} kind
     * @returns {Uint8Array | 'unknown class' | null}
     */
    const information = (handle, kind)=>{
        const type = host.handles.typeOf?.(handle >>> 0) ?? null;
        if (type !== 'mailslot' && type !== 'mailslot-client')
        {
            return null;
        }
        if (kind !== FILE_MAILSLOT_QUERY_INFORMATION)
        {
            return 'unknown class';
        }
        const held = object(handle, type);
        /** @type {Slot} */
        const slot = type === 'mailslot' ? held : held.slot;
        const bytes = new Uint8Array(MAILSLOT_QUERY_SIZE);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, slot.maxSize, true);
        view.setUint32(8, slot.messages[0]?.length ?? MAILSLOT_NO_MESSAGE, true);
        view.setUint32(12, slot.messages.length, true);
        view.setBigInt64(16, slot.timeout === MAILSLOT_WAIT_FOREVER
            ? FOREVER_INTERVAL : BigInt(slot.timeout) * -10000n, true);
        return bytes;
    };

    /**
     * What NtSetInformationFile does to a mailslot handle, or null for a
     * handle that is none. Only the server's FileMailslotSetInformation sets
     * anything: the read timeout, an interval in 100 ns units (negative as a
     * relative one is) behind a pointer, or none - a NULL pointer - to wait
     * for ever.
     *
     * @param {number} handle @param {number} kind @param {number} from @param {number} length
     * @returns {number | null}  the NTSTATUS
     */
    const setInformation = (handle, kind, from, length)=>{
        const type = host.handles.typeOf?.(handle >>> 0) ?? null;
        if (type !== 'mailslot' && type !== 'mailslot-client')
        {
            return null;
        }
        if (kind !== FILE_MAILSLOT_SET_INFORMATION || type !== 'mailslot')
        {
            return kind !== FILE_MAILSLOT_SET_INFORMATION ? STATUS_INVALID_INFO_CLASS
                : STATUS_INVALID_PARAMETER;
        }
        if (length < 4)
        {
            return STATUS_INFO_LENGTH_MISMATCH;
        }
        /** @type {Slot} */
        const slot = object(handle, type);
        const pointer = guest.u32(from);
        if (pointer === 0)
        {
            slot.timeout = MAILSLOT_WAIT_FOREVER;
            return 0;
        }
        const interval = guest.i64(pointer);
        // The largest interval is the one a slot that waits for ever reports
        // (GetMailslotInfo's MAILSLOT_WAIT_FOREVER); a relative one is
        // negative, and zero answers at once.
        slot.timeout = interval > 0n ? MAILSLOT_WAIT_FOREVER : Number(-interval / 10000n);
        return 0;
    };

    const functions = {
        /**
         * HANDLE CreateMailslotA(LPCSTR lpName, DWORD nMaxMessageSize,
         *   DWORD lReadTimeout, LPSECURITY_ATTRIBUTES)
         */
        CreateMailslotA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([name, maxSize, timeout])=>create(
                wholeAddress(name) === 0 ? null : guest.cstr(wholeAddress(name), WHOLE_NAME),
                maxSize, timeout),
        },
        /** HANDLE CreateMailslotW(LPCWSTR, DWORD, DWORD, LPSECURITY_ATTRIBUTES) */
        CreateMailslotW: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([name, maxSize, timeout])=>create(
                wholeAddress(name) === 0 ? null : guest.wstr(wholeAddress(name),
                    WHOLE_NAME * 2),
                maxSize, timeout),
        },

        /**
         * BOOL GetMailslotInfo(HANDLE hMailslot, LPDWORD lpMaxMessageSize,
         *   LPDWORD lpNextSize, LPDWORD lpMessageCount, LPDWORD lpReadTimeout)
         *
         * Each pointer may be null.
         */
        GetMailslotInfo: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, maxSize, nextSize, count, timeout])=>{
                const slot = /** @type {Slot | null} */ (object(handle, 'mailslot'));
                if (!slot)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                writeDwordIf(wholeAddress(maxSize), slot.maxSize);
                writeDwordIf(wholeAddress(nextSize),
                    slot.messages[0]?.length ?? MAILSLOT_NO_MESSAGE);
                writeDwordIf(wholeAddress(count), slot.messages.length);
                writeDwordIf(wholeAddress(timeout), slot.timeout);
                host.setLastError(ERROR_SUCCESS);
                return 1;
            },
        },

        /** BOOL SetMailslotInfo(HANDLE hMailslot, DWORD lReadTimeout) */
        SetMailslotInfo: {
            argBytes: 8,
            // The native call rides on a Win32 entry over the same slots.
            natives: { NtCreateMailslotFile: { argBytes: 32, handler: ntCreateMailslotFile } },
            /** @param {number[]} args */
            handler: ([handle, timeout])=>{
                const slot = /** @type {Slot | null} */ (object(handle, 'mailslot'));
                if (!slot)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                slot.timeout = timeout >>> 0;
                host.setLastError(ERROR_SUCCESS);
                return 1;
            },
        },
    };

    return { functions, open, read, write, information, setInformation };
}
