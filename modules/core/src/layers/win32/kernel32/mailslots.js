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
const INVALID_HANDLE_VALUE = 0xffffffff;
const GENERIC_WRITE = 0x40000000;
const FILE_WRITE_DATA = 0x2;

/** What GetMailslotInfo says of the next message when there is none. */
const MAILSLOT_NO_MESSAGE = 0xffffffff;
/** A read timeout that never runs out. */
const MAILSLOT_WAIT_FOREVER = 0xffffffff;

/** The prefix every mailslot a process makes is named under. */
const LOCAL_PREFIX = '\\\\.\\mailslot\\';

/**
 * @typedef {Object} Slot
 * @property {string} key  the name, upper-cased
 * @property {number} maxSize  0 for any size
 * @property {number} timeout  milliseconds, or MAILSLOT_WAIT_FOREVER
 * @property {Uint8Array[]} messages
 * @property {{ thread: any, buffer: number, length: number, read: number }[]} readers
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
     * Gives a waiting reader the next message, as its ReadFile would have
     * taken it.
     *
     * @param {{ buffer: number, read: number }} reader @param {Uint8Array} message
     */
    const deliver = (reader, message)=>{
        if (message.length > 0)
        {
            host.writeMemory(reader.buffer, message);
        }
        writeDwordIf(reader.read, message.length);
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
     * ReadFile on a mailslot handle, or null for a handle that is none.
     *
     * @param {number} handle @param {number} buffer @param {number} length
     * @param {number} count  where the length read goes
     */
    const read = (handle, buffer, length, count)=>{
        const kind = host.handles.typeOf?.(handle >>> 0) ?? null;
        if (kind === 'mailslot-client')
        {
            return fail(ERROR_ACCESS_DENIED);
        }
        if (kind !== 'mailslot')
        {
            return null;
        }
        const slot = /** @type {Slot} */ (object(handle, 'mailslot'));
        writeDwordIf(count >>> 0, 0);
        const next = slot.messages[0];
        if (next)
        {
            if (next.length > (length >>> 0))
            {
                return fail(ERROR_INSUFFICIENT_BUFFER);
            }
            if ((buffer >>> 0) === 0 && next.length > 0)
            {
                return fail(ERROR_NOACCESS);
            }
            slot.messages.shift();
            deliver({ buffer: buffer >>> 0, read: count >>> 0 }, next);
            host.setLastError(ERROR_SUCCESS);
            return 1;
        }
        if (slot.timeout === 0)
        {
            return fail(ERROR_SEM_TIMEOUT);
        }
        // Answered by the write that brings a message, or by the clock.
        host.setLastError(ERROR_SEM_TIMEOUT);
        const thread = host.currentThread();
        slot.readers.push({ thread, buffer: buffer >>> 0, length: length >>> 0,
            read: count >>> 0 });
        kernel.block(thread, `mailslot ${slot.key}`, slot.timeout === MAILSLOT_WAIT_FOREVER
            ? undefined
            : { deadline: kernel.clock.virtualTime() + slot.timeout, result: 0 });
        return host.park();
    };

    /**
     * WriteFile on a mailslot handle, or null for a handle that is none.
     *
     * @param {number} handle @param {number} buffer @param {number} length
     * @param {number} written
     */
    const write = (handle, buffer, length, written)=>{
        const kind = host.handles.typeOf?.(handle >>> 0) ?? null;
        if (kind === 'mailslot')
        {
            return fail(ERROR_ACCESS_DENIED);
        }
        if (kind !== 'mailslot-client')
        {
            return null;
        }
        const client = object(handle, 'mailslot-client');
        if (!client.write)
        {
            return fail(ERROR_ACCESS_DENIED);
        }
        const count = length >>> 0;
        if ((buffer >>> 0) === 0 && count !== 0)
        {
            return fail(ERROR_NOACCESS);
        }
        const message = count === 0
            ? new Uint8Array(0) : host.readMemory(buffer >>> 0, count).slice();
        /** @type {Slot} */
        const slot = client.slot;
        writeDwordIf(written >>> 0, count);
        host.setLastError(ERROR_SUCCESS);
        while (slot.readers.length > 0)
        {
            const reader = /** @type {Slot['readers'][number]} */ (slot.readers.shift());
            if (message.length > reader.length)
            {
                // Too big for this reader: it is told so and the message stays.
                host.setLastErrorFor(reader.thread, ERROR_INSUFFICIENT_BUFFER);
                kernel.wake(reader.thread, 0);
                continue;
            }
            deliver(reader, message);
            host.setLastErrorFor(reader.thread, ERROR_SUCCESS);
            if (kernel.wake(reader.thread, 1))
            {
                return 1;
            }
        }
        slot.messages.push(message);
        return 1;
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

    return { functions, open, read, write };
}
