/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

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
const STATUS_ACCESS_DENIED = 0xc0000022;
const STATUS_BUFFER_TOO_SMALL = 0xc0000023;
const STATUS_IO_TIMEOUT = 0xc00000b5;
const INVALID_HANDLE_VALUE = 0xffffffff;
const GENERIC_WRITE = 0x40000000;
const FILE_WRITE_DATA = 0x2;

/** What GetMailslotInfo says of the next message when there is none. */
const MAILSLOT_NO_MESSAGE = 0xffffffff;
/** A read timeout that never runs out. */
const MAILSLOT_WAIT_FOREVER = 0xffffffff;

/** NtQueryInformationFile's FileMailslotQueryInformation, and its record's size. */
const FILE_MAILSLOT_QUERY_INFORMATION = 26;
const MAILSLOT_QUERY_SIZE = 24;
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
 */

/**
 * @typedef {Object} MailslotHost
 * @property {any} kernel  block, wake, onTimeout and the guest clock
 * @property {{ open: (type: string, object: any) => number,
 *     resolve: (handle: number, type?: string) => any,
 *     typeOf?: (handle: number) => string | null,
 *     holds?: (object: any) => boolean }} handles
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, maxLength: number) => string} readWideString  limit in bytes
 * @property {(code: number) => void} setLastError
 * @property {(thread: any, code: number) => void} setLastErrorFor
 * @property {() => any} currentThread
 * @property {() => any} park
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
            host.writeMemory(address, Uint8Array.of(value & 0xff, (value >>> 8) & 0xff,
                (value >>> 16) & 0xff, value >>> 24));
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

    kernel.onTimeout?.((/** @type {any} */ thread)=>{
        // A reader whose wait ran out has gone; a message written later
        // stays in the slot for the next read.
        for (const slot of slots.values())
        {
            slot.readers = slot.readers.filter(reader=>reader.thread !== thread);
        }
    });

    /**
     * Makes a slot under a name, or says why not.
     *
     * @param {string | null} name @param {number} maxSize @param {number} timeout
     */
    const create = (name, maxSize, timeout)=>{
        if (name === null)
        {
            return fail(ERROR_PATH_NOT_FOUND, INVALID_HANDLE_VALUE);
        }
        if (!isMailslotName(name) || name.length === LOCAL_PREFIX.length)
        {
            return fail(ERROR_INVALID_NAME, INVALID_HANDLE_VALUE);
        }
        const key = name.toUpperCase();
        if (live(key))
        {
            return fail(ERROR_ALREADY_EXISTS, INVALID_HANDLE_VALUE);
        }
        /** @type {Slot} */
        const slot = { key, maxSize: maxSize >>> 0, timeout: timeout >>> 0, messages: [],
            readers: [] };
        slots.set(key, slot);
        host.setLastError(ERROR_SUCCESS);
        return host.handles.open('mailslot', slot);
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
        writeDwordIf(caller.out, caller.native ? STATUS_SUCCESS : count);
        if (caller.native)
        {
            writeDwordIf(caller.out + 4, count);
        }
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
     * Gives a parked reader its answer and wakes it.
     *
     * @param {Reader} reader @param {Uint8Array | null} message  null: too big for it
     * @returns {boolean} whether the reader was still waiting
     */
    const answerReader = (reader, message)=>{
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
            host.writeMemory(reader.buffer, message);
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
     */
    const read = (handle, buffer, length, out, native = false)=>{
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
                host.writeMemory(buffer >>> 0, next);
            }
            return succeed(caller, next.length);
        }
        if (slot.timeout === 0)
        {
            return refuse(caller, ERROR_SEM_TIMEOUT, STATUS_IO_TIMEOUT);
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
            ? new Uint8Array(0) : host.readMemory(buffer >>> 0, count).slice();
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

    const functions = {
        /**
         * HANDLE CreateMailslotA(LPCSTR lpName, DWORD nMaxMessageSize,
         *   DWORD lReadTimeout, LPSECURITY_ATTRIBUTES)
         */
        CreateMailslotA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([name, maxSize, timeout])=>create(
                (name >>> 0) === 0 ? null : host.readCString(name >>> 0, WHOLE_NAME),
                maxSize, timeout),
        },
        /** HANDLE CreateMailslotW(LPCWSTR, DWORD, DWORD, LPSECURITY_ATTRIBUTES) */
        CreateMailslotW: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([name, maxSize, timeout])=>create(
                (name >>> 0) === 0 ? null : host.readWideString(name >>> 0, WHOLE_NAME * 2),
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
                writeDwordIf(maxSize >>> 0, slot.maxSize);
                writeDwordIf(nextSize >>> 0, slot.messages[0]?.length ?? MAILSLOT_NO_MESSAGE);
                writeDwordIf(count >>> 0, slot.messages.length);
                writeDwordIf(timeout >>> 0, slot.timeout);
                host.setLastError(ERROR_SUCCESS);
                return 1;
            },
        },

        /** BOOL SetMailslotInfo(HANDLE hMailslot, DWORD lReadTimeout) */
        SetMailslotInfo: {
            argBytes: 8,
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

    return { functions, open, read, write, information };
}
