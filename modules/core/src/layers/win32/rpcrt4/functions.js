/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * rpcrt4: UUIDs, and the runtime a MIDL `-Os` proxy/stub DLL calls
 * (`runtime.js`), which is how an interface that no type library describes
 * crosses to another process.
 */

import { GUID_SIZE, formatGuid, parseGuid } from '../ole32/guid.js';
import { createMidl } from './midl.js';
import { createRuntime } from './runtime.js';

/** The RPC statuses. */
const RPC_S_OK = 0;
const RPC_S_OUT_OF_MEMORY = 14;
const RPC_S_INVALID_STRING_UUID = 1705;

/** A UUID's string form is 36 characters, without braces. */
const UUID_STRING_LENGTH = 36;

/**
 * @typedef {Object} RpcHost
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} [readCString]
 * @property {((api: string, detail: string) => void) | undefined} [divergence]
 * @property {(address: number, length: number) => Uint8Array} [readMemory]
 * @property {(bytes: number) => number} [allocate]
 *           Where a string the library hands out lives, freed by RpcStringFree.
 * @property {(address: number) => void} [free]
 * @property {Omit<import('./runtime.js').RuntimeHost,
 *     'readMemory' | 'writeMemory' | 'allocate' | 'free' | 'divergence'>} [runtime]
 *           What the proxy/stub runtime needs besides memory: calls into the
 *           guest, raising on the calling thread, the registry and ole32's
 *           marshaler. Absent, a proxy/stub DLL's entry points are not bound.
 * @property {Omit<import('./midl.js').MidlHost, 'readMemory' | 'writeMemory' | 'readCString'
 *     | 'readWideString' | 'allocate' | 'free' | 'divergence'>} [midl]
 *           What serving and calling an interface of MIDL's generated stubs
 *           needs besides memory: the run's table to find a server by its
 *           endpoint in, calls into the guest and raising on the calling
 *           thread. Absent, those entry points are not bound.
 * @property {(address: number) => string} [readWideString]
 */

/**
 * @param {RpcHost} host
 */
export function createRpcFunctions(host){
    const report = host.divergence ?? (()=>{});

    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address, bytes);
    };

    /**
     * UuidFromString once the string is read; NULL is the nil UUID.
     * @param {string | null} spelled @param {number} out
     */
    const uuidFromString = (spelled, out)=>{
        if (spelled === null)
        {
            host.writeMemory(out >>> 0, new Uint8Array(GUID_SIZE));
            return RPC_S_OK;
        }
        const bytes = spelled.length === UUID_STRING_LENGTH ? parseGuid(`{${spelled}}`) : null;
        if (bytes === null)
        {
            return RPC_S_INVALID_STRING_UUID;
        }
        host.writeMemory(out >>> 0, bytes);
        return RPC_S_OK;
    };

    /**
     * UuidToString's work in either width.
     * @param {number} uuid @param {number} out @param {boolean} wide
     */
    const uuidToString = (uuid, out, wide)=>{
        const bytes = (uuid >>> 0) === 0 || !host.readMemory
            ? new Uint8Array(GUID_SIZE)
            : host.readMemory(uuid >>> 0, GUID_SIZE);
        const codes = [...formatGuid(bytes).slice(1, -1).toLowerCase(), '\0']
            .map(c=>c.charCodeAt(0));
        const encoded = wide ? new Uint8Array(Uint16Array.from(codes).buffer)
            : Uint8Array.from(codes);
        const at = host.allocate?.(encoded.length) ?? 0;
        if (at === 0)
        {
            return RPC_S_OUT_OF_MEMORY;
        }
        host.writeMemory(at, encoded);
        writeU32(out >>> 0, at);
        return RPC_S_OK;
    };

    /** @param {number} pointer */
    const stringFree = pointer=>{
        if ((pointer >>> 0) === 0 || !host.readMemory)
        {
            return RPC_S_OK;
        }
        const held = new DataView(host.readMemory(pointer >>> 0, 4).slice().buffer)
            .getUint32(0, true);
        if (held !== 0)
        {
            host.free?.(held);
        }
        writeU32(pointer >>> 0, 0);
        return RPC_S_OK;
    };

    /** @type {Partial<ReturnType<typeof createRuntime>>} */
    const runtime = host.runtime && host.readMemory && host.allocate && host.free
        ? createRuntime({
            ...host.runtime,
            readMemory: host.readMemory,
            writeMemory: host.writeMemory,
            allocate: host.allocate,
            free: host.free,
            divergence: detail=>report('rpcrt4', detail),
        })
        : {};

    /** @type {Partial<ReturnType<typeof createMidl>>} */
    const midl = host.midl && host.readMemory && host.allocate && host.free && host.readCString
        && host.readWideString
        ? createMidl({
            ...host.midl,
            readMemory: host.readMemory,
            writeMemory: host.writeMemory,
            readCString: host.readCString,
            readWideString: host.readWideString,
            allocate: host.allocate,
            free: host.free,
            divergence: detail=>report('rpcrt4', detail),
        })
        : {};

    return {
        ...runtime,
        ...midl,

        /**
         * RPC_STATUS UuidCreate(UUID *Uuid)
         *
         * A version 4 UUID, the same one CoCreateGuid makes: the two fields a
         * reader inspects say it is random rather than a clock and an
         * address. Data3 is little-endian, so its high byte is the eighth.
         */
        UuidCreate: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([out])=>{
                const bytes = new Uint8Array(GUID_SIZE);
                crypto.getRandomValues(bytes);
                bytes[7] = (bytes[7] & 0x0f) | 0x40;
                bytes[8] = (bytes[8] & 0x3f) | 0x80;
                host.writeMemory(out >>> 0, bytes);
                return RPC_S_OK;
            },
        },

        /**
         * RPC_STATUS UuidFromStringA(RPC_CSTR StringUuid, UUID *Uuid)
         *
         * The string form has no braces, unlike the one COM speaks; a NULL
         * string is the nil UUID. One longer than a UUID's spelling -- COM's,
         * braces and all, which InstallShield hands it -- is not one:
         * RPC_S_INVALID_STRING_UUID, read no further than a UUID reaches.
         */
        UuidFromStringA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([text, out])=>{
                if ((text >>> 0) === 0)
                {
                    return uuidFromString(null, out);
                }
                let spelled;
                try
                {
                    spelled = host.readCString?.(text >>> 0, UUID_STRING_LENGTH + 1) ?? '';
                }
                catch {
                    return RPC_S_INVALID_STRING_UUID;
                }
                return uuidFromString(spelled, out);
            },
        },

        /** RPC_STATUS UuidFromStringW(RPC_WSTR StringUuid, UUID *Uuid) -- in UTF-16. */
        UuidFromStringW: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([text, out])=>uuidFromString((text >>> 0) === 0 ? null
                : host.readWideString?.(text >>> 0) ?? '', out),
        },

        /**
         * RPC_STATUS UuidToStringA(const UUID *Uuid, RPC_CSTR *StringUuid)
         *
         * The braceless spelling UuidFromStringA reads, in lower case, in a
         * string the library allocates; a NULL UUID is the nil one.
         */
        UuidToStringA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([uuid, out])=>uuidToString(uuid, out, false),
        },

        /** RPC_STATUS UuidToStringW(const UUID *Uuid, RPC_WSTR *StringUuid) -- in UTF-16. */
        UuidToStringW: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([uuid, out])=>uuidToString(uuid, out, true),
        },

        /** RPC_STATUS RpcStringFreeA(RPC_CSTR *String) -- freed, and the pointer cleared. */
        RpcStringFreeA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>stringFree(pointer),
        },

        /** RPC_STATUS RpcStringFreeW(RPC_WSTR *String) */
        RpcStringFreeW: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>stringFree(pointer),
        },
    };
}
