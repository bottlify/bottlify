/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The advapi32 surface over the registry.
 *
 * None of these returns a BOOL. Every one returns a LONG error code whose
 * success value is zero, so a guest that tests the result the way it tests
 * `WriteFile` reads success as failure -- which makes the codes below as much
 * of the contract as the arguments are.
 *
 * Two conventions run through the whole surface and are the usual source of
 * off-by-one bugs. Data sizes are in bytes and include the terminator that
 * string types carry; name sizes are in characters and are asymmetric -- on the
 * way in the buffer's capacity including room for the terminator, on the way
 * out the length without it.
 *
 * Access rights are accepted and ignored. There is one user, one process and no
 * security descriptor to check against, so a request Windows would refuse for
 * want of a right succeeds here.
 */

import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';
import { COMPUTER_NAME } from '../kernel32/drives.js';
import {
    HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, HKEY_USERS,
} from './registry.js';
import { STATUS } from '../ntdll/status.js';
import { USER_NAME } from './tokens.js';
import { createNamedSecurityFunctions } from './named-security.js';
import { createSecurityFunctions } from './security.js';
import { createLsaFunctions } from './lsa.js';
import { isTextUnicode } from './text.js';

const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_MORE_DATA = 234;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_NO_MORE_ITEMS = 259;
const ERROR_NOT_ENOUGH_MEMORY = 8;
const ERROR_INVALID_SID = 1337;
const ERROR_CALL_NOT_IMPLEMENTED = 120;
const ERROR_ALREADY_EXISTS = 183;

/** What RegNotifyChangeKeyValue watches for: a subkey made or deleted, a value set. */
const REG_NOTIFY_CHANGE_NAME = 0x1;
const REG_NOTIFY_CHANGE_LAST_SET = 0x4;
/** Every change it can watch, the four kinds, and the flag that frees it of its thread. */
const REG_NOTIFY_CHANGE_ALL = 0xf;
const REG_NOTIFY_THREAD_AGNOSTIC = 0x10000000;
const ERROR_BADDB = 1009;
const STATUS_SUCCESS = 0;
const STATUS_ACCESS_DENIED = 0xc0000022;
const STATUS_CANNOT_DELETE = 0xc0000121;

/** What a file RegSaveKey writes starts with: the tree follows as JSON. */
const HIVE_MAGIC = 'BTLHIVE1\n';

/**
 * Where the table keeps its hive unloading for ntdll's NtUnloadKey: a key
 * no name in a module's exports can be.
 */
export const UNLOAD_KEY = Symbol('unloadKey');

/**
 * The native registry calls over this table's keys and handles, which ntdll
 * publishes: `entries`, and `close(handle)` -- a status for a handle this
 * table issued or a predefined root, null for one that is not a key.
 */
export const REGISTRY_NATIVES = Symbol('registryNatives');

/**
 * The hive's key a registry handle is open on, for a library that installs
 * into a key the program opened (setupapi's HKR): null for a handle that is
 * not a key.
 */
export const KEY_OF_HANDLE = Symbol('keyOfHandle');

/** NtQueryKey's and NtEnumerateKey's classes, and the value classes, this answers. */
const KEY_BASIC_INFORMATION = 0;
const KEY_NODE_INFORMATION = 1;
const KEY_FULL_INFORMATION = 2;
const KEY_VALUE_BASIC_INFORMATION = 0;
const KEY_VALUE_FULL_INFORMATION = 1;
const KEY_VALUE_PARTIAL_INFORMATION = 2;
/** The class offset of a key with no class. */
const NO_CLASS = 0xffffffff;

/**
 * @typedef {{ values?: { name: string, type: number, data: number[] }[],
 *     keys?: (HiveTree & { name: string })[] }} HiveTree
 */

/** The count is a byte and the format allows eight. */
const MAX_SUB_AUTHORITIES = 8;

/** What RegCreateKeyEx reports through lpdwDisposition. */
const REG_CREATED_NEW_KEY = 1;
const REG_OPENED_EXISTING_KEY = 2;

/** The only type the older RegSetValue/RegQueryValue pair can carry. */
const REG_SZ = 1;
const REG_EXPAND_SZ = 2;
const REG_BINARY = 3;
const REG_MULTI_SZ = 7;

/** RegGetValue's errors for a value it found and will not answer as asked. */
const ERROR_DATATYPE_MISMATCH = 1629;
const ERROR_UNSUPPORTED_TYPE = 1630;
/** RegConnectRegistry's answer for a machine that is not this one. */
const ERROR_BAD_NETPATH = 53;
/** A value's data at an address no program can own. */
const ERROR_NOACCESS = 998;
/** Below this nothing is ever mapped. */
const NEVER_MAPPED = 0x10000;

/** RegGetValue's flags: the types it will answer, and how. */
const RRF_RT_REG_DWORD = 0x10;
const RRF_RT_REG_QWORD = 0x40;
const RRF_RT_DWORD = 0x18;
const RRF_RT_QWORD = 0x48;
const RRF_RT_ANY = 0xffff;
const RRF_SUBKEY_WOW6464KEY = 0x10000;
const RRF_SUBKEY_WOW6432KEY = 0x20000;
const RRF_NOEXPAND = 0x10000000;
const RRF_ZEROONFAILURE = 0x20000000;
/** Each value type's bit in an RRF_RT_ mask: REG_NONE, SZ, EXPAND_SZ, BINARY, DWORD, MULTI_SZ, QWORD. */
const TYPE_BITS = new Map([[0, 0x01], [1, 0x02], [2, 0x04], [3, 0x08], [4, 0x10], [7, 0x20],
    [11, 0x40]]);
/** The types whose data is text, and so arrives in UTF-16 through a W call. */
const STRING_TYPES = new Set([REG_SZ, REG_EXPAND_SZ, REG_MULTI_SZ]);

/** Registry key names stop at 255 characters, value names at 16383. */
const MAX_NAME = 16384;

/**
 * Handles are multiples of four, as the kernel's are, and stay below the
 * predefined roots so the two spaces can never be confused.
 */
const HANDLE_STRIDE = 4;
const HANDLE_LIMIT = 0x7ffffffc;
/**
 * Above every handle the kernel's table issues (it stops at 0x40000000), so a
 * native call that takes either kind -- NtClose -- knows which a value is.
 */
const FIRST_KEY_HANDLE = 0x40000004;

/** The one account's name, kept beside its SID and read from here by the module. */
export { USER_NAME };

/**
 * @typedef {Object} RegistryHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {ReturnType<typeof import('./registry-service.js').createRegistryService>} hive
 * @property {(bytes: number) => number} [allocate]
 *           Guest memory for the objects this library hands out by pointer -- a
 *           SID. Without it those calls fail as an out-of-memory would, which
 *           is a result a program is written to handle.
 * @property {(code: number) => void} [setLastError]
 * @property {import('../ole32/storage.js').StorageFiles} [files]
 *           The volume a hive is saved to and loaded from. Without it a
 *           save is refused and a load finds no file.
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {Map<string, any>} [security]  The run's file-security store (named-security.js).
 * @property {(path: string) => string} [resolvePath]  A path made absolute, to key the store by.
 * @property {{ set: (handle: number) => boolean, reset: (handle: number) => boolean }} [events]
 *           The kernel's events, which a change notification signals. Without
 *           them an asynchronous RegNotifyChangeKeyValue finds no event.
 */

/** @param {number[]} numbers */
const largest = numbers=>numbers.reduce((most, number)=>Math.max(most, number), 0);

/**
 * Builds the function table: name -> { argBytes, handler }.
 *
 * `argBytes` is the size of the argument list the guest compiled against; all
 * of these are stdcall, the bridge's default, so none of them says so.
 *
 * @param {RegistryHost} host
 */
export function createRegistryFunctions(host){
    /**
     * The changes RegNotifyChangeKeyValue is waiting for, each answered once:
     * the key a handle named, whether its subkeys count, the kinds of change,
     * and what to do when one comes.
     *
     * @type {{ handle: number, key: any, subtree: boolean, filter: number,
     *     settle: () => void }[]}
     */
    const watchers = [];

    /**
     * A change of a kind to a key: every watcher it concerns is answered and
     * forgotten.
     *
     * @param {any} key @param {number} kind
     */
    const notify = (key, kind)=>{
        for (const watcher of [...watchers])
        {
            if ((watcher.filter & kind) !== 0 && (watcher.key === key
                || (watcher.subtree && nodesUnder(watcher.key).has(key))))
            {
                watchers.splice(watchers.indexOf(watcher), 1);
                watcher.settle();
            }
        }
    };

    /**
     * The hive, its changes told to whoever watches: a subkey made or
     * deleted changes its parent's names, a value set or deleted its key.
     */
    const hive = {
        ...host.hive,
        /** @param {any} key @param {string | null} [path] */
        create(key, path){
            let parent = key;
            for (const part of typeof path === 'string' ? path.split('\\').filter(Boolean) : [])
            {
                const next = host.hive.open(parent, part);
                if (!next)
                {
                    break;
                }
                parent = next;
            }
            const made = host.hive.create(key, path);
            if (made.created)
            {
                notify(parent, REG_NOTIFY_CHANGE_NAME);
            }
            return made;
        },
        /** @param {any} key @param {string | null} [path] */
        remove(key, path){
            const parts = typeof path === 'string' ? path.split('\\').filter(Boolean) : [];
            const doomed = host.hive.open(key, path);
            const parent = parts.length > 0 ? host.hive.open(key, parts.slice(0, -1).join('\\'))
                : null;
            const result = host.hive.remove(key, path);
            if (result === 'deleted')
            {
                notify(parent ?? doomed, REG_NOTIFY_CHANGE_NAME);
            }
            return result;
        },
        /** @param {any} key @param {string} name @param {number} type @param {Uint8Array} data */
        setValue(key, name, type, data){
            const value = host.hive.setValue(key, name, type, data);
            notify(key, REG_NOTIFY_CHANGE_LAST_SET);
            return value;
        },
        /** @param {any} key @param {string} name */
        deleteValue(key, name){
            const deleted = host.hive.deleteValue(key, name);
            if (deleted)
            {
                notify(key, REG_NOTIFY_CHANGE_LAST_SET);
            }
            return deleted;
        },
        /** @param {any} parent @param {string} name @param {string} to */
        rename(parent, name, to){
            const result = host.hive.rename(parent, name, to);
            if (result === 'renamed')
            {
                notify(parent, REG_NOTIFY_CHANGE_NAME);
            }
            return result;
        },
    };

    /** @type {Map<number, number>} */
    const handles = new Map();
    /** @type {number[]} */
    const freed = [];
    let next = FIRST_KEY_HANDLE;

    /**
     * Fresh handles first, closed ones only once the range runs out: a handle
     * used after it was closed then lands on nothing -- a defined error -- and
     * not on whatever key was opened next.
     *
     * @param {number} key
     * @returns {number}
     */
    const allocate = key=>{
        let handle;
        if (next <= HANDLE_LIMIT)
        {
            handle = next;
            next += HANDLE_STRIDE;
        }
        else if (freed.length > 0)
        {
            handle = /** @type {number} */ (freed.shift());
        }
        else
        {
            throw new Error('Registry handle table exhausted');
        }
        handles.set(handle, key);
        return handle;
    };

    /**
     * The predefined roots are constants rather than allocations: always valid,
     * never closed.
     *
     * @param {number} handle
     * @returns {number | null}
     */
    const keyOf = handle=>hive.root(handle >>> 0) ?? handles.get(handle >>> 0) ?? null;

    /** @param {number} address */
    const readDword = address=>{
        const bytes = host.readMemory(address, 4);
        return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
    };

    /** The consumer line's answer to a security call: FALSE, and it says why. */
    const notImplemented = ()=>{
        host.setLastError?.(ERROR_CALL_NOT_IMPLEMENTED);
        return 0;
    };

    /** @param {number} address @param {number} value */
    const writeDword = (address, value)=>{
        host.writeMemory(address, new Uint8Array([
            value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
        ]));
    };

    /**
     * Most out-parameters here are optional, and a NULL one is not an error.
     *
     * @param {number} address @param {number} value
     */
    const writeDwordIf = (address, value)=>{
        if (address !== 0)
        {
            writeDword(address, value);
        }
    };

    /**
     * @param {number} pointer
     * @returns {string | null} null when the guest passed NULL, which is legal
     *                          almost everywhere in this surface
     */
    const readText = pointer=>(pointer === 0 ? null : host.readCString(pointer, MAX_NAME));

    /**
     * The narrow form of UTF-16 bytes: the hive holds every string as the
     * A calls read it, in the ANSI page, so what a W call brings is stored
     * as WideCharToMultiByte(CP_ACP) narrows it and read back by either.
     *
     * @param {Uint8Array} bytes
     */
    const narrowed = bytes=>{
        let text = '';
        for (let i = 0; i + 1 < bytes.length; i += 2)
        {
            text += String.fromCharCode(bytes[i] | bytes[i + 1] << 8);
        }
        return encodeAnsi(text);
    };

    /**
     * The wide form of a string the hive holds in the ANSI page, as a W read
     * answers it: MultiByteToWideChar(CP_ACP), a unit a character.
     *
     * @param {Uint8Array} bytes
     */
    const widened = bytes=>{
        const text = decodeAnsi(bytes);
        const out = new Uint8Array(text.length * 2);
        for (let at = 0; at < text.length; at++)
        {
            const unit = text.charCodeAt(at);
            out[at * 2] = unit & 0xff;
            out[at * 2 + 1] = unit >>> 8;
        }
        return out;
    };

    /** @param {number} pointer @returns {string | null} */
    const readWideText = pointer=>{
        if (pointer === 0)
        {
            return null;
        }
        let text = '';
        for (let at = 0; at < MAX_NAME; at++)
        {
            const pair = host.readMemory(pointer + at * 2, 2);
            const code = pair[0] | pair[1] << 8;
            if (code === 0)
            {
                break;
            }
            text += String.fromCharCode(code);
        }
        return text;
    };

    /** In the ANSI page. @param {number} pointer @param {string} text */
    const writeText = (pointer, text)=>{
        host.writeMemory(pointer, encodeAnsi(`${text}\0`));
    };

    /**
     * We do not track modification times, so callers get a zeroed FILETIME.
     *
     * @param {number} pointer
     */
    const writeFileTime = pointer=>{
        if (pointer !== 0)
        {
            host.writeMemory(pointer, new Uint8Array(8));
        }
    };

    /**
     * Every function but RegCloseKey starts by resolving its first argument,
     * and answering a stale handle with a code rather than an exception is half
     * of what this table promises.
     *
     * @param {(key: number, args: number[]) => number} handler
     * @returns {(args: number[]) => number}
     */
    const onKey = handler=>args=>{
        const key = keyOf(args[0]);
        return key ? handler(key, args) : ERROR_INVALID_HANDLE;
    };

    /**
     * RegCloseKey's body: a predefined root closes as nothing, an app key is
     * written back, and a change awaited on the key is signalled.
     *
     * @param {number} key
     */
    const closeKey = key=>{
        if (hive.root(key))
        {
            return ERROR_SUCCESS;
        }
        const held = handles.get(key);
        if (!held || !handles.delete(key))
        {
            return ERROR_INVALID_HANDLE;
        }
        const file = appKeys.get(key);
        if (file !== undefined)
        {
            appKeys.delete(key);
            writeHive(held, file, true);
            hive.forget(held);
        }
        // A key closed while a change is awaited on it signals the wait.
        for (const watcher of watchers.filter(one=>one.handle === key))
        {
            watchers.splice(watchers.indexOf(watcher), 1);
            watcher.settle();
        }
        freed.push(key);
        return ERROR_SUCCESS;
    };

    /**
     * Where a key hangs: its parent and its name there. Looked for from the
     * roots, as a handle holds only the key; a root has none.
     *
     * @param {any} key @returns {{ parent: any, name: string } | null}
     */
    const placeOf = key=>hive.placeOf(key);

    /**
     * The native registry: the same keys and handles, statuses for errors,
     * names as counted strings, and a path with no root under \REGISTRY.
     */
    const nativeRegistry = ()=>{
        /** @param {number} address  A UNICODE_STRING. @returns {string} */
        const counted = address=>{
            if (address === 0)
            {
                return '';
            }
            const length = readDword(address) & 0xffff;
            const buffer = readDword(address + 4);
            const units = buffer === 0 ? new Uint8Array(0) : host.readMemory(buffer, length & ~1);
            let text = '';
            for (let at = 0; at + 1 < units.length; at += 2)
            {
                text += String.fromCharCode(units[at] | units[at + 1] << 8);
            }
            return text;
        };

        /**
         * The key an OBJECT_ATTRIBUTES names, or the status it cannot be found
         * with: its name under its root directory, a key handle, or with no
         * root \REGISTRY\Machine or \REGISTRY\User and a path under it.
         *
         * @param {number} attributes
         * @returns {{ base: any, path: string } | number}
         */
        const namedBy = attributes=>{
            const root = readDword(attributes + 4);
            const path = counted(readDword(attributes + 8));
            if (root !== 0)
            {
                const base = keyOf(root);
                return base ? { base, path } : STATUS.INVALID_HANDLE;
            }
            const match = /^\\registry\\(machine|user)(?:\\(.*))?$/i.exec(path);
            const base = match ? hive.root(match[1].toLowerCase() === 'machine'
                ? HKEY_LOCAL_MACHINE : HKEY_USERS) : null;
            return base ? { base, path: match?.[2] ?? '' } : STATUS.OBJECT_NAME_NOT_FOUND;
        };

        /** @param {string} text */
        const utf16 = text=>{
            const bytes = new Uint8Array(text.length * 2);
            for (let at = 0; at < text.length; at++)
            {
                bytes[at * 2] = text.charCodeAt(at) & 0xff;
                bytes[at * 2 + 1] = text.charCodeAt(at) >>> 8;
            }
            return bytes;
        };

        /**
         * A value's information in one of the three classes, or null for
         * another class.
         *
         * @param {{ name: string, type: number, data: Uint8Array }} stored @param {number} kind
         * @returns {{ bytes: Uint8Array, fixed: number } | null}
         */
        const valueInformation = (stored, kind)=>{
            // Strings answered wide, as a W read answers them.
            const value = STRING_TYPES.has(stored.type)
                ? { ...stored, data: widened(stored.data) } : stored;
            const name = utf16(value.name);
            /** @type {Record<number, { fixed: number, nameAt: number, dataAt: number }>} */
            const shapes = {
                [KEY_VALUE_BASIC_INFORMATION]: { fixed: 12, nameAt: 12, dataAt: -1 },
                [KEY_VALUE_FULL_INFORMATION]: { fixed: 20, nameAt: 20,
                    dataAt: (20 + name.length + 3) & ~3 },
                [KEY_VALUE_PARTIAL_INFORMATION]: { fixed: 12, nameAt: -1, dataAt: 12 },
            };
            const shape = shapes[kind];
            if (!shape)
            {
                return null;
            }
            const size = shape.dataAt >= 0 ? shape.dataAt + value.data.length
                : shape.nameAt + name.length;
            const bytes = new Uint8Array(size);
            const view = new DataView(bytes.buffer);
            view.setUint32(4, value.type, true);
            if (kind === KEY_VALUE_PARTIAL_INFORMATION)
            {
                view.setUint32(8, value.data.length, true);
            }
            else if (kind === KEY_VALUE_FULL_INFORMATION)
            {
                view.setUint32(8, shape.dataAt, true);
                view.setUint32(12, value.data.length, true);
                view.setUint32(16, name.length, true);
            }
            else
            {
                view.setUint32(8, name.length, true);
            }
            if (shape.nameAt >= 0)
            {
                bytes.set(name, shape.nameAt);
            }
            if (shape.dataAt >= 0)
            {
                bytes.set(value.data, shape.dataAt);
            }
            return { bytes, fixed: shape.fixed };
        };

        /**
         * A key's information in one of the three classes, or null for another
         * class. No time is kept per key, so its last write reads as zero.
         *
         * @param {any} key @param {string} name @param {number} kind
         * @returns {{ bytes: Uint8Array, fixed: number } | null}
         */
        const keyInformation = (key, name, kind)=>{
            const text = utf16(name);
            if (kind === KEY_BASIC_INFORMATION || kind === KEY_NODE_INFORMATION)
            {
                const nameAt = kind === KEY_BASIC_INFORMATION ? 16 : 24;
                const bytes = new Uint8Array(nameAt + text.length);
                const view = new DataView(bytes.buffer);
                if (kind === KEY_NODE_INFORMATION)
                {
                    view.setUint32(12, NO_CLASS, true);
                }
                view.setUint32(nameAt - 4, text.length, true);
                bytes.set(text, nameAt);
                return { bytes, fixed: nameAt };
            }
            if (kind !== KEY_FULL_INFORMATION)
            {
                return null;
            }
            const subkeys = hive.subkeys(key);
            const values = hive.values(key);
            const bytes = new Uint8Array(44);
            const view = new DataView(bytes.buffer);
            view.setUint32(12, NO_CLASS, true);
            view.setUint32(20, subkeys.length, true);
            view.setUint32(24, Math.max(0, ...subkeys.map(one=>one.length * 2)), true);
            view.setUint32(32, values.length, true);
            view.setUint32(36, Math.max(0, ...values.map(one=>one.name.length * 2)), true);
            view.setUint32(40, Math.max(0, ...values.map(one=>one.data.length)), true);
            return { bytes, fixed: 44 };
        };

        /**
         * Writes an answer as far as the buffer holds it: the length it needs
         * always, nothing when not even the fixed part fits.
         *
         * @param {{ bytes: Uint8Array, fixed: number } | null} answer
         * @param {number} buffer @param {number} length @param {number} needed
         */
        const deliver = (answer, buffer, length, needed)=>{
            if (!answer)
            {
                return STATUS.INVALID_PARAMETER;
            }
            writeDwordIf(needed >>> 0, answer.bytes.length);
            if ((length >>> 0) < answer.fixed)
            {
                return STATUS.BUFFER_TOO_SMALL;
            }
            if ((buffer >>> 0) === 0)
            {
                return STATUS.ACCESS_VIOLATION;
            }
            host.writeMemory(buffer >>> 0,
                answer.bytes.subarray(0, Math.min(length >>> 0, answer.bytes.length)));
            return (length >>> 0) < answer.bytes.length ? STATUS.BUFFER_OVERFLOW : STATUS.SUCCESS;
        };

        /**
         * A key a native call names by handle: a predefined root is no handle
         * to these calls, as on Windows.
         *
         * @param {number} handle
         */
        const heldKey = handle=>(hive.root(handle >>> 0) ? null
            : handles.get(handle >>> 0) ?? null);

        /** @param {(key: any, args: number[]) => number} handler */
        const onHeld = handler=>(/** @type {number[]} */ args)=>{
            const key = heldKey(args[0]);
            return key ? handler(key, args) : STATUS.INVALID_HANDLE;
        };

        /**
         * @param {number} out @param {number} attributes @param {number} disposition
         * @param {boolean} create
         */
        const openOrCreate = (out, attributes, disposition, create)=>{
            if ((out >>> 0) === 0 || (attributes >>> 0) === 0)
            {
                return STATUS.ACCESS_VIOLATION;
            }
            const named = namedBy(attributes >>> 0);
            if (typeof named === 'number')
            {
                return named;
            }
            const found = hive.open(named.base, named.path);
            if (!found && !create)
            {
                return STATUS.OBJECT_NAME_NOT_FOUND;
            }
            const parts = named.path.split('\\').filter(Boolean);
            // One level at a time, as NT makes keys: a missing parent is not made.
            if (!found && parts.length > 1 && !hive.open(named.base, parts.slice(0, -1).join('\\')))
            {
                return STATUS.OBJECT_NAME_NOT_FOUND;
            }
            const made = found ? { key: found, created: false }
                : hive.create(named.base, named.path);
            writeDword(out >>> 0, allocate(made.key));
            writeDwordIf(disposition >>> 0,
                made.created ? REG_CREATED_NEW_KEY : REG_OPENED_EXISTING_KEY);
            return STATUS.SUCCESS;
        };

        return {
            entries: {
                /** NTSTATUS NtOpenKey(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES) */
                NtOpenKey: {
                    argBytes: 12,
                    /** @param {number[]} args */
                    handler: ([out, , attributes])=>openOrCreate(out, attributes, 0, false),
                },
                /**
                 * NTSTATUS NtCreateKey(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES,
                 *     ULONG TitleIndex, PUNICODE_STRING Class, ULONG CreateOptions,
                 *     PULONG Disposition)
                 */
                NtCreateKey: {
                    argBytes: 28,
                    /** @param {number[]} args */
                    handler: ([out, , attributes, , , , disposition])=>
                        openOrCreate(out, attributes, disposition, true),
                },
                /**
                 * NTSTATUS NtDeleteKey(HANDLE)
                 *
                 * The key the handle names goes, unless it has subkeys; the
                 * handle stays open on the key that is no longer there.
                 */
                NtDeleteKey: {
                    argBytes: 4,
                    handler: onHeld(key=>{
                        const place = placeOf(key);
                        const result = place ? hive.remove(place.parent, place.name) : 'missing';
                        if (result === 'deleted')
                        {
                            return STATUS.SUCCESS;
                        }
                        return result === 'has-subkeys' ? STATUS.CANNOT_DELETE
                            : STATUS.ACCESS_DENIED;
                    }),
                },
                /**
                 * NTSTATUS NtSetValueKey(HANDLE, PUNICODE_STRING ValueName,
                 *     ULONG TitleIndex, ULONG Type, PVOID Data, ULONG DataSize)
                 */
                NtSetValueKey: {
                    argBytes: 24,
                    handler: onHeld((key, [, name, , type, data, size])=>{
                        const bytes = (size >>> 0) === 0 ? new Uint8Array(0)
                            : host.readMemory(data >>> 0, size >>> 0).slice();
                        // The hive keeps a string in the ANSI page, as a W call stores it.
                        hive.setValue(key, counted(name >>> 0), type >>> 0,
                            STRING_TYPES.has(type >>> 0) ? narrowed(bytes) : bytes);
                        return STATUS.SUCCESS;
                    }),
                },
                /** NTSTATUS NtDeleteValueKey(HANDLE, PUNICODE_STRING ValueName) */
                NtDeleteValueKey: {
                    argBytes: 8,
                    handler: onHeld((key, [, name])=>(hive.deleteValue(key, counted(name >>> 0))
                        ? STATUS.SUCCESS : STATUS.OBJECT_NAME_NOT_FOUND)),
                },
                /**
                 * NTSTATUS NtQueryValueKey(HANDLE, PUNICODE_STRING ValueName,
                 *     KEY_VALUE_INFORMATION_CLASS, PVOID, ULONG Length, PULONG ResultLength)
                 */
                NtQueryValueKey: {
                    argBytes: 24,
                    handler: onHeld((key, [, name, kind, buffer, length, needed])=>{
                        const value = hive.getValue(key, counted(name >>> 0));
                        return value ? deliver(valueInformation(value, kind >>> 0), buffer, length,
                            needed) : STATUS.OBJECT_NAME_NOT_FOUND;
                    }),
                },
                /**
                 * NTSTATUS NtEnumerateValueKey(HANDLE, ULONG Index,
                 *     KEY_VALUE_INFORMATION_CLASS, PVOID, ULONG Length, PULONG ResultLength)
                 */
                NtEnumerateValueKey: {
                    argBytes: 24,
                    handler: onHeld((key, [, index, kind, buffer, length, needed])=>{
                        const value = hive.values(key)[index >>> 0];
                        return value ? deliver(valueInformation(value, kind >>> 0), buffer, length,
                            needed) : STATUS.NO_MORE_ENTRIES;
                    }),
                },
                /**
                 * NTSTATUS NtFlushKey(HANDLE): RegFlushKey's native call, with
                 * nothing to wait for and the handle still checked.
                 */
                NtFlushKey: {
                    argBytes: 4,
                    handler: onHeld(()=>STATUS.SUCCESS),
                },
                /**
                 * NTSTATUS NtQueryKey(HANDLE, KEY_INFORMATION_CLASS, PVOID,
                 *     ULONG Length, PULONG ResultLength)
                 */
                NtQueryKey: {
                    argBytes: 20,
                    handler: onHeld((key, [, kind, buffer, length, needed])=>
                        deliver(keyInformation(key, placeOf(key)?.name ?? '', kind >>> 0),
                            buffer, length, needed)),
                },
                /**
                 * NTSTATUS NtEnumerateKey(HANDLE, ULONG Index, KEY_INFORMATION_CLASS,
                 *     PVOID, ULONG Length, PULONG ResultLength)
                 */
                NtEnumerateKey: {
                    argBytes: 24,
                    handler: onHeld((key, [, index, kind, buffer, length, needed])=>{
                        const name = hive.subkeys(key)[index >>> 0];
                        const child = name === undefined ? null : hive.open(key, name);
                        return child ? deliver(keyInformation(child, name, kind >>> 0), buffer,
                            length, needed) : STATUS.NO_MORE_ENTRIES;
                    }),
                },
            },
            /**
             * NtClose of a key: closed as RegCloseKey closes it. A predefined
             * root is no handle here; anything else is not this table's.
             *
             * @param {number} handle @returns {number | null}
             */
            close: handle=>{
                if (hive.root(handle >>> 0))
                {
                    return STATUS.INVALID_HANDLE;
                }
                if (!handles.has(handle >>> 0))
                {
                    return null;
                }
                return closeKey(handle >>> 0) === ERROR_SUCCESS ? STATUS.SUCCESS
                    : STATUS.INVALID_HANDLE;
            },
        };
    };

    /**
     * LONG RegCreateKeyExA(HKEY, LPCSTR, DWORD, LPSTR lpClass, DWORD, REGSAM,
     *                      LPSECURITY_ATTRIBUTES, PHKEY, LPDWORD lpdwDisposition)
     *
     * Named here rather than written into the table because the older
     * RegCreateKeyA is the same call with everything but three arguments
     * defaulted, and two copies of a create would drift.
     */
    /**
     * @param {any} key @param {string | null} subKey
     * @param {number} result @param {number} disposition
     */
    const createKey = (key, subKey, result, disposition)=>{
        if (result === 0)
        {
            return ERROR_INVALID_PARAMETER;
        }
        const made = hive.create(key, subKey);
        writeDword(result, allocate(made.key));
        writeDwordIf(disposition,
            made.created ? REG_CREATED_NEW_KEY : REG_OPENED_EXISTING_KEY);
        return ERROR_SUCCESS;
    };
    const createKeyEx = {
        argBytes: 36,
        handler: onKey((key, [, subKey, , , , , , result, disposition])=>
            createKey(key, readText(subKey), result, disposition)),
    };

    /**
     * LONG RegOpenKeyExA(HKEY, LPCSTR, DWORD ulOptions, REGSAM, PHKEY), and
     * with `read` the wide name its W form brings.
     *
     * @param {(pointer: number) => string | null} read
     */
    const openKeyExWith = read=>({
        argBytes: 20,
        handler: onKey((key, [, subKey, , , result])=>{
            if (result === 0)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const found = hive.open(key, read(subKey));
            if (!found)
            {
                // Windows leaves *phkResult undefined here; zeroing it keeps a
                // caller that skips the check from using a stale handle.
                writeDword(result, 0);
                return ERROR_FILE_NOT_FOUND;
            }
            writeDword(result, allocate(found));
            return ERROR_SUCCESS;
        }),
    });
    const openKeyEx = openKeyExWith(readText);

    /**
     * LONG RegQueryValueExA(HKEY, LPCSTR, LPDWORD, LPDWORD lpType, LPBYTE lpData,
     * LPDWORD lpcbData), and its W form: a wide name, and a string value
     * answered in UTF-16 with its byte count doubled.
     *
     * @param {boolean} wide
     */
    const queryValueEx = wide=>({
        argBytes: 24,
        handler: onKey((key, [, name, , type, data, size])=>{
            const value = hive.getValue(key, (wide ? readWideText(name) : readText(name)) ?? '');
            if (!value)
            {
                return ERROR_FILE_NOT_FOUND;
            }
            writeDwordIf(type, value.type);
            if (size === 0)
            {
                // Asking for data without saying how much room there is is
                // the one combination Windows rejects outright.
                return data === 0 ? ERROR_SUCCESS : ERROR_INVALID_PARAMETER;
            }
            const bytes = wide && STRING_TYPES.has(value.type) ? widened(value.data) : value.data;
            const required = bytes.length;
            if (data === 0)
            {
                writeDword(size, required);
                return ERROR_SUCCESS;
            }
            if (readDword(size) < required)
            {
                writeDword(size, required);
                return ERROR_MORE_DATA;
            }
            host.writeMemory(data, bytes);
            writeDword(size, required);
            return ERROR_SUCCESS;
        }),
    });

    /**
     * How text arrives and leaves, the whole of the difference between an A
     * call and its W twin: names are read and written in the caller's width,
     * and a string value is answered in it -- widened from the ANSI page the
     * hive keeps, or narrowed into it on the way in.
     *
     * @typedef {Object} TextForm
     * @property {(pointer: number) => string | null} read
     * @property {(pointer: number, text: string) => void} write  With its terminator.
     * @property {(value: { type: number, data: Uint8Array }) => Uint8Array} answer
     * @property {(type: number, bytes: Uint8Array) => Uint8Array} store
     * @property {number} unit  Bytes a character takes.
     */
    /** @type {TextForm} */
    const ANSI = {
        read: readText,
        write: writeText,
        answer: value=>value.data,
        store: (type, bytes)=>bytes,
        unit: 1,
    };
    /** @type {TextForm} */
    const WIDE = {
        read: readWideText,
        write: (pointer, text)=>host.writeMemory(pointer, widened(encodeAnsi(`${text}\0`))),
        answer: value=>(STRING_TYPES.has(value.type) ? widened(value.data) : value.data),
        store: (type, bytes)=>(STRING_TYPES.has(type) ? narrowed(bytes) : bytes),
        unit: 2,
    };

    /**
     * An enumerated or queried name into a caller's buffer of `sizePointer`
     * characters, the terminator included going in and excluded coming out.
     *
     * @param {number} buffer @param {number} sizePointer
     * @param {string} name
     */
    const fitsName = (buffer, sizePointer, name)=>
        buffer !== 0 && sizePointer !== 0 && name.length + 1 <= readDword(sizePointer);

    /**
     * RegEnumValue in either width. Nothing is written unless everything
     * fits: a name or data too long for its buffer is ERROR_MORE_DATA with
     * the name and its count untouched and the data's size reported, as
     * advapi32's registry tests read them back.
     *
     * @param {TextForm} text
     */
    const enumValue = text=>({
        argBytes: 32,
        handler: onKey((key, [, index, name, nameSize, , type, data, size])=>{
            const values = hive.values(key);
            const at = index >>> 0;
            if (at >= values.length)
            {
                return ERROR_NO_MORE_ITEMS;
            }
            if (name === 0 || nameSize === 0 || (data !== 0 && size === 0))
            {
                return ERROR_INVALID_PARAMETER;
            }
            const value = values[at];
            const bytes = text.answer(value);
            const nameFits = fitsName(name, nameSize, value.name);
            const dataFits = data === 0 || readDword(size) >= bytes.length;
            writeDwordIf(type, value.type);
            writeDwordIf(size, bytes.length);
            if (!nameFits || !dataFits)
            {
                return ERROR_MORE_DATA;
            }
            text.write(name, value.name);
            writeDword(nameSize, value.name.length);
            if (data !== 0)
            {
                host.writeMemory(data, bytes);
            }
            return ERROR_SUCCESS;
        }),
    });

    /**
     * RegEnumKeyEx in either width; the class is empty and the time zero.
     *
     * @param {TextForm} text
     */
    const enumKeyEx = text=>({
        argBytes: 32,
        handler: onKey((key, [, index, name, nameSize, , keyClass, classSize, fileTime])=>{
            const names = hive.subkeys(key);
            const at = index >>> 0;
            if (at >= names.length)
            {
                return ERROR_NO_MORE_ITEMS;
            }
            if (name === 0 || nameSize === 0)
            {
                return ERROR_INVALID_PARAMETER;
            }
            if (!fitsName(name, nameSize, names[at]))
            {
                return ERROR_MORE_DATA;
            }
            text.write(name, names[at]);
            writeDword(nameSize, names[at].length);
            if (keyClass !== 0)
            {
                text.write(keyClass, '');
            }
            writeDwordIf(classSize, 0);
            writeFileTime(fileTime);
            return ERROR_SUCCESS;
        }),
    });

    /**
     * RegEnumKey in either width: the buffer's size by value, in characters.
     *
     * @param {TextForm} text
     */
    const enumKey = text=>({
        argBytes: 16,
        handler: onKey((key, [, index, name, size])=>{
            const names = hive.subkeys(key);
            const at = index >>> 0;
            if (at >= names.length)
            {
                return ERROR_NO_MORE_ITEMS;
            }
            if (name === 0 || (size >>> 0) <= names[at].length)
            {
                return ERROR_MORE_DATA;
            }
            text.write(name, names[at]);
            return ERROR_SUCCESS;
        }),
    });

    /**
     * RegQueryInfoKey in either width. The longest data is counted in the
     * bytes the caller's width answers it in.
     *
     * @param {TextForm} text
     */
    const queryInfoKey = text=>({
        argBytes: 48,
        handler: onKey((key, args)=>{
            const [, keyClass, classSize, , subKeys, maxSubKeyLen, maxClassLen, valueCount,
                maxValueNameLen, maxValueLen, securitySize, fileTime] = args;
            const names = hive.subkeys(key);
            const values = hive.values(key);
            if (keyClass !== 0)
            {
                text.write(keyClass, '');
            }
            writeDwordIf(classSize, 0);
            writeDwordIf(subKeys, names.length);
            writeDwordIf(maxSubKeyLen, largest(names.map(name=>name.length)));
            writeDwordIf(maxClassLen, 0);
            writeDwordIf(valueCount, values.length);
            writeDwordIf(maxValueNameLen, largest(values.map(value=>value.name.length)));
            writeDwordIf(maxValueLen, largest(values.map(value=>text.answer(value).length)));
            writeDwordIf(securitySize, 0);
            writeFileTime(fileTime);
            return ERROR_SUCCESS;
        }),
    });

    /**
     * RegDeleteKey (and RegDeleteKeyEx, whose view and reserved word change
     * nothing on a 32-bit system) in either width. NT deletes one key: one
     * with subkeys of its own is refused.
     *
     * @param {TextForm} text @param {number} argBytes
     */
    const deleteKey = (text, argBytes)=>({
        argBytes,
        handler: onKey((key, [, subKey])=>{
            const name = text.read(subKey);
            if (name === null)
            {
                return ERROR_INVALID_PARAMETER;
            }
            switch (hive.remove(key, name)){
                case 'deleted':
                    return ERROR_SUCCESS;
                case 'has-subkeys':
                    return ERROR_ACCESS_DENIED;
                default:
                    return ERROR_FILE_NOT_FOUND;
            }
        }),
    });

    /** @param {TextForm} text */
    const deleteValue = text=>({
        argBytes: 8,
        handler: onKey((key, [, name])=>
            (hive.deleteValue(key, text.read(name) ?? '') ? ERROR_SUCCESS : ERROR_FILE_NOT_FOUND)),
    });

    /**
     * The key a subkey argument names under `key`, or `key` itself for none.
     *
     * @param {any} key @param {string | null} name
     */
    const beneath = (key, name)=>(name === null || name === '' ? key : hive.open(key, name));

    /**
     * Everything under a key and the key's own values go; the key stays.
     *
     * @param {any} key
     */
    const empty = key=>{
        for (const name of hive.subkeys(key))
        {
            const child = hive.open(key, name);
            if (child)
            {
                empty(child);
            }
            hive.remove(key, name);
        }
        for (const value of hive.values(key))
        {
            hive.deleteValue(key, value.name);
        }
    };

    /**
     * A key's values and subkeys copied into another, recursively.
     *
     * @param {any} from @param {any} to
     */
    const copyInto = (from, to)=>{
        for (const value of hive.values(from))
        {
            hive.setValue(to, value.name, value.type, value.data.slice());
        }
        for (const name of hive.subkeys(from))
        {
            const child = hive.open(from, name);
            if (child)
            {
                copyInto(child, hive.create(to, name).key);
            }
        }
    };

    /**
     * RegGetValue in either width: a value under an optional subkey, its type
     * held to the RRF_RT_ mask the caller gives. A value of another type is
     * ERROR_UNSUPPORTED_TYPE with its type, size and data still answered (the
     * data zeroed for RRF_ZEROONFAILURE), and a binary value asked for as a
     * DWORD or a QWORD is ERROR_DATATYPE_MISMATCH unless it is that long. A
     * string is answered terminated whether it was stored so or not. A
     * REG_EXPAND_SZ without RRF_NOEXPAND is answered as REG_SZ, as Windows
     * answers it, but unexpanded: this library has no environment to read.
     *
     * @param {TextForm} text
     */
    const getValue = text=>({
        argBytes: 28,
        handler: onKey((key, [, subKey, name, flags, typeOut, data, size])=>{
            const mask = flags & RRF_RT_ANY;
            const views = flags & (RRF_SUBKEY_WOW6464KEY | RRF_SUBKEY_WOW6432KEY);
            if (mask === 0 || (data !== 0 && size === 0)
                || views === (RRF_SUBKEY_WOW6464KEY | RRF_SUBKEY_WOW6432KEY))
            {
                return ERROR_INVALID_PARAMETER;
            }
            const target = beneath(key, text.read(subKey));
            const value = target ? hive.getValue(target, text.read(name) ?? '') : null;
            if (!value)
            {
                return ERROR_FILE_NOT_FOUND;
            }
            let type = value.type;
            if (type === REG_EXPAND_SZ && (flags & RRF_NOEXPAND) === 0)
            {
                type = REG_SZ;
            }
            let bytes = text.answer(value);
            if (STRING_TYPES.has(value.type))
            {
                const last = bytes.length < text.unit
                    ? 1 : bytes[bytes.length - text.unit] | bytes[bytes.length - 1];
                if (last !== 0)
                {
                    const terminated = new Uint8Array(bytes.length + text.unit);
                    terminated.set(bytes);
                    bytes = terminated;
                }
            }
            const wanted = TYPE_BITS.get(type) ?? 0;
            let status = (mask & wanted) === 0 ? ERROR_UNSUPPORTED_TYPE : ERROR_SUCCESS;
            if (status === ERROR_SUCCESS && type === REG_BINARY)
            {
                const asDword = (mask & RRF_RT_DWORD) === RRF_RT_DWORD
                    && (mask & RRF_RT_REG_QWORD) === 0;
                const asQword = (mask & RRF_RT_QWORD) === RRF_RT_QWORD
                    && (mask & RRF_RT_REG_DWORD) === 0;
                if ((asDword && bytes.length !== 4) || (asQword && bytes.length !== 8))
                {
                    status = ERROR_DATATYPE_MISMATCH;
                }
            }
            writeDwordIf(typeOut, type);
            if (data !== 0)
            {
                const room = readDword(size);
                if (room < bytes.length)
                {
                    writeDword(size, bytes.length);
                    return status === ERROR_SUCCESS ? ERROR_MORE_DATA : status;
                }
                if (status === ERROR_UNSUPPORTED_TYPE && (flags & RRF_ZEROONFAILURE) !== 0)
                {
                    host.writeMemory(data, new Uint8Array(room));
                }
                else
                {
                    host.writeMemory(data, bytes);
                }
            }
            writeDwordIf(size, bytes.length);
            return status;
        }),
    });

    /**
     * @param {TextForm} text @param {any} key @param {number} subKey @param {number} name
     * @param {number} type @param {number} data @param {number} size
     */
    const setKeyValue = (text, key, subKey, name, type, data, size)=>{
        const subName = text.read(subKey);
        const target = subName === null || subName === '' ? key : hive.create(key, subName).key;
        return setValueIn(text, target, text.read(name), type, data, size);
    };

    /**
     * A value's data out of guest memory, or null for a pointer the caller
     * could not have meant: data in the never-mapped low 64 KiB, NULL with
     * it, is ERROR_NOACCESS, as advapi32's registry tests pass 1 and expect.
     *
     * @param {TextForm} text @param {any} key @param {string | null} name
     * @param {number} type @param {number} data @param {number} size
     */
    const setValueIn = (text, key, name, type, data, size)=>{
        const length = size >>> 0;
        if (length !== 0 && (data >>> 0) < NEVER_MAPPED)
        {
            return ERROR_NOACCESS;
        }
        // The memory layer may hand back a view onto guest memory, and what is
        // stored here outlives the call.
        const bytes = length === 0 ? new Uint8Array(0) : host.readMemory(data, length).slice();
        hive.setValue(key, name ?? '', type >>> 0, text.store(type >>> 0, bytes));
        return ERROR_SUCCESS;
    };

    /** @param {TextForm} text @param {any} key @param {number} subKey @param {number} name */
    const deleteKeyValue = (text, key, subKey, name)=>{
        const target = beneath(key, text.read(subKey));
        if (!target)
        {
            return ERROR_FILE_NOT_FOUND;
        }
        return hive.deleteValue(target, text.read(name) ?? '')
            ? ERROR_SUCCESS : ERROR_FILE_NOT_FOUND;
    };

    /** @param {TextForm} text @param {any} key @param {number} subKey */
    const deleteTree = (text, key, subKey)=>{
        const name = text.read(subKey);
        const target = beneath(key, name);
        if (!target)
        {
            return ERROR_FILE_NOT_FOUND;
        }
        empty(target);
        if (name !== null && name !== '')
        {
            hive.remove(key, name);
        }
        return ERROR_SUCCESS;
    };

    /**
     * @param {TextForm} text @param {any} key @param {number} subKey
     * @param {number} destination
     */
    const copyTree = (text, key, subKey, destination)=>{
        const to = keyOf(destination);
        if (!to)
        {
            return ERROR_INVALID_HANDLE;
        }
        const from = beneath(key, text.read(subKey));
        if (!from)
        {
            return ERROR_FILE_NOT_FOUND;
        }
        copyInto(from, to);
        return ERROR_SUCCESS;
    };

    /**
     * @param {string | null} machine @param {number} handle @param {number} result
     */
    const connectRegistry = (machine, handle, result)=>{
        const name = (machine ?? '').replace(/^\\\\/, '');
        if (name !== '' && name.toUpperCase() !== COMPUTER_NAME)
        {
            return ERROR_BAD_NETPATH;
        }
        if (result === 0 || !hive.root(handle))
        {
            return ERROR_INVALID_HANDLE;
        }
        writeDword(result, handle);
        return ERROR_SUCCESS;
    };


    /**
     * A key's subtree as a hive file holds it: its values and its subkeys,
     * not its own name.
     *
     * @param {number} key
     * @returns {HiveTree}
     */
    const exportTree = key=>({
        values: hive.values(key).map(value=>({
            name: value.name, type: value.type, data: [...value.data],
        })),
        keys: hive.subkeys(key).map(name=>({
            name, ...exportTree(/** @type {any} */ (hive.open(key, name))),
        })),
    });

    /** @param {number} key @param {HiveTree} tree */
    const importTree = (key, tree)=>{
        for (const value of tree.values ?? [])
        {
            hive.setValue(key, value.name, value.type >>> 0, Uint8Array.from(value.data ?? []));
        }
        for (const child of tree.keys ?? [])
        {
            importTree(hive.create(key, child.name).key, child);
        }
    };

    /** The subkey and everything under it, deepest first. @param {any} parent @param {string} name */
    const removeTree = (parent, name)=>{
        const key = hive.open(parent, name);
        if (key)
        {
            for (const child of hive.subkeys(key))
            {
                removeTree(key, child);
            }
            hive.remove(parent, name);
        }
    };

    /** @param {any} key @returns {Set<any>} the key and every key under it */
    const nodesUnder = key=>{
        const nodes = new Set([key]);
        for (const name of hive.subkeys(key))
        {
            for (const node of nodesUnder(hive.open(key, name)))
            {
                nodes.add(node);
            }
        }
        return nodes;
    };

    /** @param {any} key Whether a handle is open on the key or under it. */
    const heldUnder = key=>{
        const nodes = nodesUnder(key);
        return [...handles.values()].some(held=>nodes.has(held));
    };

    /**
     * Writes a key's subtree to a file of the volume: this library's own
     * format, read back by RegLoadKey and RegLoadAppKey, not a hive Windows
     * could mount.
     *
     * @param {any} key @param {string} path @param {boolean} replace
     * @returns {number} a Win32 error
     */
    const writeHive = (key, path, replace)=>{
        const files = host.files;
        if (!files)
        {
            return ERROR_ACCESS_DENIED;
        }
        if (!replace && files.stat(path)?.exists)
        {
            return ERROR_ALREADY_EXISTS;
        }
        const node = files.open(path, { write: true, create: true, truncate: true });
        if (!node)
        {
            return ERROR_ACCESS_DENIED;
        }
        files.write(node, 0, new TextEncoder().encode(
            `${HIVE_MAGIC}${JSON.stringify(exportTree(key))}`));
        files.close(node);
        if (!saidFormat)
        {
            saidFormat = true;
            host.divergence?.('RegSaveKey', 'a saved key is this engine\'s own format, read back '
                + 'by RegLoadKey here, not a hive file Windows could load');
        }
        return ERROR_SUCCESS;
    };
    let saidFormat = false;

    /**
     * A file RegSaveKey wrote, as its tree, or the error a load answers.
     *
     * @param {string} path
     * @returns {Promise<HiveTree | number> | HiveTree | number}
     */
    const readHive = path=>{
        const files = host.files;
        const found = files?.stat(path);
        if (!files || !found?.exists || found.isDirectory)
        {
            return ERROR_FILE_NOT_FOUND;
        }
        const node = files.open(path, { read: true });
        if (!node)
        {
            return ERROR_ACCESS_DENIED;
        }
        /** @param {Uint8Array} bytes */
        const parse = bytes=>{
            files.close(node);
            const text = new TextDecoder().decode(bytes);
            if (!text.startsWith(HIVE_MAGIC))
            {
                return ERROR_BADDB;
            }
            try
            {
                return /** @type {HiveTree} */ (JSON.parse(text.slice(HIVE_MAGIC.length)));
            }
            catch {
                return ERROR_BADDB;
            }
        };
        const bytes = files.read(node, 0, found.size);
        return bytes instanceof Promise ? bytes.then(parse) : parse(bytes);
    };

    /**
     * Hives loaded under a root, by `root\name` folded: the file each came
     * from, written back when it is unloaded.
     *
     * @type {Map<string, { file: string, root: number, name: string }>}
     */
    const loaded = new Map();
    /** @param {number} root @param {string} name */
    const loadedName = (root, name)=>`${root}\\${name.toLowerCase()}`;

    /**
     * RegLoadKey in either spelling: the file's tree under a new key of
     * HKEY_LOCAL_MACHINE or HKEY_USERS.
     *
     * @param {number} handle @param {string | null} name @param {string | null} path
     */
    const loadKey = (handle, name, path)=>{
        const root = hive.root(handle);
        if (!root || (handle !== HKEY_LOCAL_MACHINE && handle !== HKEY_USERS) || !name || !path)
        {
            return ERROR_INVALID_PARAMETER;
        }
        if (hive.open(root, name))
        {
            return ERROR_ALREADY_EXISTS;
        }
        /** @param {HiveTree | number} tree */
        const mount = tree=>{
            if (typeof tree === 'number')
            {
                return tree;
            }
            importTree(hive.create(root, name).key, tree);
            loaded.set(loadedName(handle, name), { file: path, root: handle, name });
            return ERROR_SUCCESS;
        };
        const tree = readHive(path);
        return tree instanceof Promise ? tree.then(mount) : mount(tree);
    };

    /**
     * Unloads a hive RegLoadKey mounted, writing what it holds now back to
     * its file: as an NTSTATUS, which RegUnLoadKey turns into a Win32 error.
     * A key that is no loaded hive is refused, as a hive the system keeps
     * is; one a handle is still open on cannot go.
     *
     * @param {number} handle @param {string} name
     * @returns {number}
     */
    const unload = (handle, name)=>{
        const record = loaded.get(loadedName(handle, name));
        const root = hive.root(handle);
        const key = root ? hive.open(root, name) : null;
        if (!record || !key)
        {
            return STATUS_ACCESS_DENIED;
        }
        if (heldUnder(key))
        {
            return STATUS_CANNOT_DELETE;
        }
        writeHive(key, record.file, true);
        removeTree(root, name);
        loaded.delete(loadedName(handle, name));
        return STATUS_SUCCESS;
    };

    /** @param {number} handle @param {string | null} name */
    const unloadKey = (handle, name)=>{
        if (!hive.root(handle) || !name)
        {
            return ERROR_INVALID_PARAMETER;
        }
        const status = unload(handle, name);
        return status === STATUS_SUCCESS ? ERROR_SUCCESS : ERROR_ACCESS_DENIED;
    };

    /**
     * RegSaveKey's spellings, narrow and wide, with and without flags.
     *
     * @param {TextForm} form @param {number} argBytes
     */
    const saveKeyWith = (form, argBytes)=>({
        argBytes,
        /** @param {number[]} args */
        handler: ([handle, file])=>{
            const key = keyOf(handle >>> 0);
            if (!key)
            {
                return ERROR_INVALID_HANDLE;
            }
            const path = form.read(file >>> 0);
            return path ? writeHive(key, path, false) : ERROR_INVALID_PARAMETER;
        },
    });

    /**
     * Keys RegLoadAppKey opened, by handle: a tree of their own outside
     * every root, written back to their file when the handle is closed.
     *
     * @type {Map<number, string>}
     */
    const appKeys = new Map();

    /** @param {string | null} path @param {number} out */
    const loadAppKey = (path, out)=>{
        if (!path || out === 0)
        {
            return ERROR_INVALID_PARAMETER;
        }
        /** @param {HiveTree | number} tree */
        const open = tree=>{
            if (typeof tree === 'number')
            {
                return tree;
            }
            const key = hive.detached();
            importTree(key, tree);
            const handle = allocate(key);
            appKeys.set(handle, path);
            writeDword(out, handle);
            return ERROR_SUCCESS;
        };
        const tree = readHive(path);
        return tree instanceof Promise ? tree.then(open) : open(tree);
    };

    return {
        RegOpenKeyExA: openKeyEx,

        /** LONG RegOpenKeyExW(HKEY, LPCWSTR, DWORD, REGSAM, PHKEY) */
        RegOpenKeyExW: openKeyExWith(readWideText),

        /**
         * LONG RegOpenKeyA(HKEY, LPCSTR, PHKEY)
         *
         * The 16-bit ancestor of RegOpenKeyExA, and still called: no options,
         * no access mask, otherwise the same function.
         */
        RegOpenKeyA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, subKey, result])=>
                openKeyEx.handler([handle, subKey, 0, 0, result]),
        },

        /**
         * LONG RegCreateKeyExA(HKEY, LPCSTR, DWORD, LPSTR lpClass, DWORD, REGSAM,
         *                      LPSECURITY_ATTRIBUTES, PHKEY, LPDWORD lpdwDisposition)
         */
        RegCreateKeyExA: createKeyEx,

        /**
         * LONG RegCreateKeyExW(HKEY, LPCWSTR, DWORD, LPWSTR, DWORD, REGSAM,
         *                      LPSECURITY_ATTRIBUTES, PHKEY, LPDWORD)
         */
        RegCreateKeyExW: {
            argBytes: 36,
            handler: onKey((key, [, subKey, , , , , , result, disposition])=>
                createKey(key, readWideText(subKey), result, disposition)),
        },

        /**
         * LONG RegCreateKeyA(HKEY, LPCSTR, PHKEY)
         *
         * The ancestor of RegCreateKeyExA, and still called. No class, no
         * options, no access mask and no disposition reported -- the caller
         * cannot tell whether the key was made or found, which is exactly why
         * the Ex form exists.
         */
        RegCreateKeyA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, subKey, result])=>
                createKeyEx.handler([handle, subKey, 0, 0, 0, 0, 0, result, 0]),
        },

        /**
         * LONG RegSetValueA(HKEY, LPCSTR lpSubKey, DWORD dwType, LPCSTR lpData,
         *                   DWORD cbData)
         *
         * The ancestor of RegSetValueExA, and a different shape rather than a
         * shorter one: the second argument names a *subkey*, not a value, and
         * what it writes is always that key's unnamed default as a string. A
         * caller passing a subkey that does not exist expects it to be made.
         *
         * The length is advisory and the string is taken as terminated, which
         * is what the documentation says and what callers rely on -- several
         * pass zero.
         */
        RegSetValueA: {
            argBytes: 20,
            handler: onKey((key, [, subKey, type, data])=>{
                if ((type >>> 0) !== REG_SZ || data === 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const name = readText(subKey);
                const target = name === null || name === ''
                    ? key
                    : hive.create(key, name).key;
                hive.setValue(target, '', REG_SZ, encodeAnsi(`${readText(data) ?? ''}\0`));
                return ERROR_SUCCESS;
            }),
        },

        /**
         * LONG RegQueryValueA(HKEY, LPCSTR lpSubKey, LPSTR lpValue, PLONG lpcbValue)
         *
         * The reading half of the pair above, and asymmetric with it: the size
         * is a LONG in bytes, in and out, and a NULL buffer asks how much room
         * the value needs rather than reading it.
         */
        RegQueryValueA: {
            argBytes: 16,
            handler: onKey((key, [, subKey, buffer, sizePointer])=>{
                const name = readText(subKey);
                const target = name === null || name === ''
                    ? key
                    : hive.open(key, name);
                if (!target)
                {
                    return ERROR_FILE_NOT_FOUND;
                }
                const value = hive.getValue(target, '');
                if (!value)
                {
                    return ERROR_FILE_NOT_FOUND;
                }
                const required = value.data.length;
                if (sizePointer === 0)
                {
                    return buffer === 0 ? ERROR_SUCCESS : ERROR_INVALID_PARAMETER;
                }
                if (buffer === 0)
                {
                    writeDword(sizePointer, required);
                    return ERROR_SUCCESS;
                }
                if (readDword(sizePointer) < required)
                {
                    writeDword(sizePointer, required);
                    return ERROR_MORE_DATA;
                }
                host.writeMemory(buffer, value.data);
                writeDword(sizePointer, required);
                return ERROR_SUCCESS;
            }),
        },

        /**
         * LONG RegFlushKey(HKEY)
         *
         * On a real machine this waits for the hive to reach the disk. Here the
         * hive is memory a program cannot outlive, so there is nothing to wait
         * for -- but the handle is still checked, because a caller that flushes
         * a stale key is asking to be told.
         */
        RegFlushKey: {
            argBytes: 4,
            handler: onKey(()=>ERROR_SUCCESS),
        },

        /**
         * BOOL GetUserNameA(LPSTR buffer, LPDWORD size)
         *
         * The size is in characters and includes the terminator in both
         * directions, which is the opposite of the registry enumerators just
         * above: on success it is the length written *with* the terminator, and
         * on failure it is what the caller must allocate. A caller that gets
         * either wrong allocates one byte short and truncates the last
         * character of every name it ever reads.
         */
        GetUserNameA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([buffer, size])=>{
                if ((size >>> 0) === 0)
                {
                    return 0;
                }
                const needed = USER_NAME.length + 1;
                if ((buffer >>> 0) === 0 || readDword(size >>> 0) < needed)
                {
                    writeDword(size >>> 0, needed);
                    host.setLastError?.(ERROR_INSUFFICIENT_BUFFER);
                    return 0;
                }
                writeText(buffer >>> 0, USER_NAME);
                writeDword(size >>> 0, needed);
                return 1;
            },
        },

        /** BOOL GetUserNameW(LPWSTR, LPDWORD): the same sizes, in wide characters. */
        GetUserNameW: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([buffer, size])=>{
                if ((size >>> 0) === 0)
                {
                    return 0;
                }
                const needed = USER_NAME.length + 1;
                if ((buffer >>> 0) === 0 || readDword(size >>> 0) < needed)
                {
                    writeDword(size >>> 0, needed);
                    host.setLastError?.(ERROR_INSUFFICIENT_BUFFER);
                    return 0;
                }
                host.writeMemory(buffer >>> 0, widened(encodeAnsi(`${USER_NAME}\0`)));
                writeDword(size >>> 0, needed);
                return 1;
            },
        },

        // GetFileSecurity and SetFileSecurity are advapi32's file-security
        // calls, beside the named ones (named-security.js).

        /**
         * BOOL IsTextUnicode(const VOID *lpv, int iSize, LPINT lpiResult)
         *
         * Whether a buffer reads as UTF-16, by the documented tests
         * (`text.js`): those lpiResult names, or all of them without it, and
         * through it which of those passed.
         */
        IsTextUnicode: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([buffer, size, result])=>{
                const length = Math.max(size | 0, 0);
                const asked = (result >>> 0) === 0 ? undefined
                    : new DataView(host.readMemory(result >>> 0, 4).slice().buffer)
                        .getUint32(0, true);
                const answer = (buffer >>> 0) === 0
                    ? { unicode: false, passed: 0 }
                    : isTextUnicode(host.readMemory(buffer >>> 0, length).slice(), asked);
                if ((result >>> 0) !== 0)
                {
                    const out = new Uint8Array(4);
                    new DataView(out.buffer).setUint32(0, answer.passed, true);
                    host.writeMemory(result >>> 0, out);
                }
                return answer.unicode ? 1 : 0;
            },
        },

        /**
         * BOOL InitiateSystemShutdownA(LPSTR lpMachineName, LPSTR lpMessage,
         *   DWORD dwTimeout, BOOL bForceAppsClosed, BOOL bRebootAfterShutdown)
         * BOOL InitiateSystemShutdownExA(..., DWORD dwReason)
         *
         * There is no machine to restart, and the call answers as the
         * consumer line of Windows did, which never had it: not implemented.
         * A setup asks only when what it replaced needs a restart, and the
         * user is the one to give it.
         */
        ...Object.fromEntries([['InitiateSystemShutdownA', 20], ['InitiateSystemShutdownW', 20],
            ['InitiateSystemShutdownExA', 24], ['InitiateSystemShutdownExW', 24]]
            .map(([name, argBytes])=>[name, {
                argBytes,
                handler: ()=>{
                    host.divergence?.(String(name), 'there is no machine to restart');
                    return notImplemented();
                },
            }])),

        /**
         * BOOL AllocateAndInitializeSid(PSID_IDENTIFIER_AUTHORITY pIdentifierAuthority,
         *                               BYTE nSubAuthorityCount, DWORD dwSubAuthority0..7,
         *                               PSID *pSid)
         *
         * A real SID in guest memory -- revision, count, the six-byte authority
         * and the sub-authorities -- because a program that builds one goes on
         * to compare it byte for byte with one it read from a token or an ACL.
         */
        AllocateAndInitializeSid: {
            argBytes: 44,
            /** @param {number[]} args */
            handler: ([authority, count, ...rest])=>{
                const out = rest[MAX_SUB_AUTHORITIES];
                const wanted = count & 0xff;
                if (wanted > MAX_SUB_AUTHORITIES)
                {
                    host.setLastError?.(ERROR_INVALID_SID);
                    return 0;
                }
                if (!host.allocate)
                {
                    host.setLastError?.(ERROR_NOT_ENOUGH_MEMORY);
                    return 0;
                }
                const size = 8 + 4 * wanted;
                const sid = host.allocate(size);
                const bytes = new Uint8Array(size);
                bytes[0] = 1;
                bytes[1] = wanted;
                bytes.set(host.readMemory(authority >>> 0, 6), 2);
                for (let at = 0; at < wanted; at++)
                {
                    const value = rest[at] >>> 0;
                    bytes.set([value & 0xff, value >>> 8 & 0xff,
                        value >>> 16 & 0xff, value >>> 24 & 0xff], 8 + at * 4);
                }
                host.writeMemory(sid, bytes);
                writeDword(out >>> 0, sid);
                return 1;
            },
        },

        /**
         * PVOID FreeSid(PSID pSid)
         *
         * Answers NULL, which is success -- the documented shape. The memory
         * itself stays with the process, as every small allocation here does.
         */
        FreeSid: { argBytes: 4, handler: ()=>0 },

        /**
         * LONG RegCloseKey(HKEY)
         *
         * A key RegLoadAppKey opened is written back to its file as it goes.
         */
        RegCloseKey: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>closeKey(handle >>> 0),
        },

        /**
         * LONG RegQueryValueExA(HKEY, LPCSTR, LPDWORD, LPDWORD lpType,
         *                       LPBYTE lpData, LPDWORD lpcbData)
         *
         * Well-behaved code calls this twice: once with no buffer to learn the
         * size, then again with one. Both paths have to work, and the first
         * must not require a buffer.
         */
        RegQueryValueExA: queryValueEx(false),

        /** LONG RegQueryValueExW: the same, its name and its string values wide. */
        RegQueryValueExW: queryValueEx(true),

        /**
         * LONG RegSetValueEx(HKEY, LPCSTR, DWORD, DWORD dwType, const BYTE*, DWORD cbData)
         *
         * One body, both spellings: the W form's text arrives as UTF-16 and
         * is stored as the hive keeps every string, so a value set through
         * either reads back through the other.
         */
        RegSetValueExA: {
            argBytes: 24,
            handler: onKey((key, [, name, , type, data, size])=>
                setValueIn(ANSI, key, ANSI.read(name), type, data, size)),
        },
        RegSetValueExW: {
            argBytes: 24,
            handler: onKey((key, [, name, , type, data, size])=>
                setValueIn(WIDE, key, WIDE.read(name), type, data, size)),
        },

        /**
         * LONG RegDeleteValue(HKEY, LPCSTR) and
         * LONG RegDeleteKey(HKEY, LPCSTR lpSubKey), in both spellings;
         * RegDeleteKeyEx(HKEY, LPCSTR, REGSAM, DWORD) is RegDeleteKey, the
         * registry having one view on a 32-bit system.
         */
        RegDeleteValueA: deleteValue(ANSI),
        RegDeleteValueW: deleteValue(WIDE),
        RegDeleteKeyA: deleteKey(ANSI, 8),
        RegDeleteKeyW: deleteKey(WIDE, 8),
        RegDeleteKeyExA: deleteKey(ANSI, 16),
        RegDeleteKeyExW: deleteKey(WIDE, 16),

        /**
         * LONG RegEnumKey(HKEY, DWORD dwIndex, LPSTR lpName, DWORD cchName)
         * LONG RegEnumKeyEx(HKEY, DWORD dwIndex, LPSTR, LPDWORD, LPDWORD,
         *                   LPSTR lpClass, LPDWORD lpcchClass, PFILETIME)
         * LONG RegEnumValue(HKEY, DWORD dwIndex, LPSTR, LPDWORD, LPDWORD,
         *                   LPDWORD lpType, LPBYTE lpData, LPDWORD lpcbData)
         * LONG RegQueryInfoKey(HKEY, LPSTR, LPDWORD, LPDWORD, LPDWORD, LPDWORD,
         *                      LPDWORD, LPDWORD, LPDWORD, LPDWORD, LPDWORD, PFILETIME)
         *
         * One body each, both spellings. The enumerators do not report the
         * size a name needed; RegQueryInfoKey is where a caller learns how
         * large to make its buffers, every length in characters without the
         * terminator but the data's, in bytes.
         */
        RegEnumKeyA: enumKey(ANSI),
        RegEnumKeyW: enumKey(WIDE),
        RegEnumKeyExA: enumKeyEx(ANSI),
        RegEnumKeyExW: enumKeyEx(WIDE),
        RegEnumValueA: enumValue(ANSI),
        RegEnumValueW: enumValue(WIDE),
        RegQueryInfoKeyA: queryInfoKey(ANSI),
        RegQueryInfoKeyW: queryInfoKey(WIDE),

        /** LONG RegOpenKeyW(HKEY, LPCWSTR, PHKEY) */
        RegOpenKeyW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, subKey, result])=>
                openKeyExWith(readWideText).handler([handle, subKey, 0, 0, result]),
        },

        /** LONG RegCreateKeyW(HKEY, LPCWSTR, PHKEY) */
        RegCreateKeyW: {
            argBytes: 12,
            handler: onKey((key, [, subKey, result])=>
                createKey(key, readWideText(subKey), result, 0)),
        },

        /**
         * LONG RegSetValueW(HKEY, LPCWSTR lpSubKey, DWORD dwType, LPCWSTR lpData,
         *                   DWORD cbData)
         *
         * RegSetValueA's shape in wide text: the subkey's default value, a
         * string only, to its first NUL whatever the size says.
         */
        RegSetValueW: {
            argBytes: 20,
            handler: onKey((key, [, subKey, type, data])=>{
                if ((type >>> 0) !== REG_SZ || data === 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const name = readWideText(subKey);
                const target = name === null || name === '' ? key : hive.create(key, name).key;
                hive.setValue(target, '', REG_SZ, encodeAnsi(`${readWideText(data) ?? ''}\0`));
                return ERROR_SUCCESS;
            }),
        },

        /**
         * LONG RegQueryValueW(HKEY, LPCWSTR lpSubKey, LPWSTR lpValue, PLONG lpcbValue)
         *
         * RegQueryValueA's reading in wide text, the size still in bytes.
         */
        RegQueryValueW: {
            argBytes: 16,
            handler: onKey((key, [, subKey, buffer, sizePointer])=>{
                const target = beneath(key, readWideText(subKey));
                const value = target ? hive.getValue(target, '') : null;
                if (!value)
                {
                    return ERROR_FILE_NOT_FOUND;
                }
                const bytes = WIDE.answer(value);
                if (sizePointer === 0)
                {
                    return buffer === 0 ? ERROR_SUCCESS : ERROR_INVALID_PARAMETER;
                }
                if (buffer !== 0 && readDword(sizePointer) < bytes.length)
                {
                    writeDword(sizePointer, bytes.length);
                    return ERROR_MORE_DATA;
                }
                if (buffer !== 0)
                {
                    host.writeMemory(buffer, bytes);
                }
                writeDword(sizePointer, bytes.length);
                return ERROR_SUCCESS;
            }),
        },

        /**
         * LONG RegGetValue(HKEY, LPCSTR lpSubKey, LPCSTR lpValue, DWORD dwFlags,
         *                  LPDWORD pdwType, PVOID pvData, LPDWORD pcbData)
         */
        RegGetValueA: getValue(ANSI),
        RegGetValueW: getValue(WIDE),

        /**
         * LONG RegSetKeyValue(HKEY, LPCSTR lpSubKey, LPCSTR lpValueName,
         *                     DWORD dwType, LPCVOID lpData, DWORD cbData)
         * LONG RegDeleteKeyValue(HKEY, LPCSTR lpSubKey, LPCSTR lpValueName)
         *
         * A value under a subkey in one call; the set makes the subkey, the
         * delete wants it there.
         */
        RegSetKeyValueA: {
            argBytes: 24,
            handler: onKey((key, [, subKey, name, type, data, size])=>
                setKeyValue(ANSI, key, subKey, name, type, data, size)),
        },
        RegSetKeyValueW: {
            argBytes: 24,
            handler: onKey((key, [, subKey, name, type, data, size])=>
                setKeyValue(WIDE, key, subKey, name, type, data, size)),
        },
        RegDeleteKeyValueA: {
            argBytes: 12,
            handler: onKey((key, [, subKey, name])=>deleteKeyValue(ANSI, key, subKey, name)),
        },
        RegDeleteKeyValueW: {
            argBytes: 12,
            handler: onKey((key, [, subKey, name])=>deleteKeyValue(WIDE, key, subKey, name)),
        },

        /**
         * LONG RegDeleteTree(HKEY, LPCSTR lpSubKey)
         *
         * The subkey and everything under it; with no subkey, everything
         * under the key and its values, the key itself kept.
         */
        RegDeleteTreeA: {
            argBytes: 8,
            handler: onKey((key, [, subKey])=>deleteTree(ANSI, key, subKey)),
        },
        RegDeleteTreeW: {
            argBytes: 8,
            handler: onKey((key, [, subKey])=>deleteTree(WIDE, key, subKey)),
        },

        /** LONG RegCopyTree(HKEY hKeySrc, LPCSTR lpSubKey, HKEY hKeyDest) */
        RegCopyTreeA: {
            argBytes: 12,
            handler: onKey((key, [, subKey, destination])=>
                copyTree(ANSI, key, subKey, destination)),
        },
        RegCopyTreeW: {
            argBytes: 12,
            handler: onKey((key, [, subKey, destination])=>
                copyTree(WIDE, key, subKey, destination)),
        },

        /**
         * LONG RegOpenCurrentUser(REGSAM, PHKEY)
         *
         * The one user's hive, which is HKEY_CURRENT_USER itself: a handle
         * that is always valid and closing which does nothing.
         */
        RegOpenCurrentUser: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([, result])=>{
                if ((result >>> 0) === 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                writeDword(result >>> 0, HKEY_CURRENT_USER);
                return ERROR_SUCCESS;
            },
        },

        /**
         * LONG RegConnectRegistry(LPCSTR lpMachineName, HKEY hKey, PHKEY)
         *
         * This machine, named or not, is the only one there is: a root of
         * its own registry is answered as itself, any other machine is not
         * on the network.
         */
        RegConnectRegistryA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([machine, handle, result])=>
                connectRegistry(ANSI.read(machine >>> 0), handle >>> 0, result >>> 0),
        },
        RegConnectRegistryW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([machine, handle, result])=>
                connectRegistry(WIDE.read(machine >>> 0), handle >>> 0, result >>> 0),
        },

        /**
         * LONG RegSaveKeyA(HKEY, LPCSTR lpFile, LPSECURITY_ATTRIBUTES)
         *
         * The key and everything under it into a new file; one already there
         * is ERROR_ALREADY_EXISTS.
         */
        RegSaveKeyA: saveKeyWith(ANSI, 12),
        RegSaveKeyW: saveKeyWith(WIDE, 12),
        /** LONG RegSaveKeyExA(HKEY, LPCSTR, LPSECURITY_ATTRIBUTES, DWORD Flags) */
        RegSaveKeyExA: saveKeyWith(ANSI, 16),
        RegSaveKeyExW: saveKeyWith(WIDE, 16),

        /**
         * LONG RegLoadKeyA(HKEY, LPCSTR lpSubKey, LPCSTR lpFile)
         *
         * A saved key mounted as a new subkey of HKEY_LOCAL_MACHINE or
         * HKEY_USERS until RegUnLoadKey writes it back.
         */
        RegLoadKeyA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, name, file])=>
                loadKey(handle >>> 0, ANSI.read(name >>> 0), ANSI.read(file >>> 0)),
        },
        RegLoadKeyW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, name, file])=>
                loadKey(handle >>> 0, WIDE.read(name >>> 0), WIDE.read(file >>> 0)),
        },

        /** LONG RegUnLoadKeyA(HKEY, LPCSTR lpSubKey) */
        RegUnLoadKeyA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, name])=>unloadKey(handle >>> 0, ANSI.read(name >>> 0)),
        },
        RegUnLoadKeyW: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, name])=>unloadKey(handle >>> 0, WIDE.read(name >>> 0)),
        },

        /**
         * LONG RegLoadAppKeyA(LPCSTR lpFile, PHKEY, REGSAM, DWORD dwOptions, DWORD Reserved)
         *
         * A saved key opened as a tree of the process's own, reached through
         * the handle alone.
         */
        RegLoadAppKeyA: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([file, out])=>loadAppKey(ANSI.read(file >>> 0), out >>> 0),
        },
        RegLoadAppKeyW: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([file, out])=>loadAppKey(WIDE.read(file >>> 0), out >>> 0),
        },

        /**
         * LONG RegNotifyChangeKeyValue(HKEY, BOOL bWatchSubtree, DWORD dwNotifyFilter,
         *                              HANDLE hEvent, BOOL fAsynchronous)
         *
         * One change of the kinds asked for, to the key or under it: the event
         * is reset now and signalled when it comes, or the caller waits for it.
         * A change after the registering thread has gone is still told, as
         * REG_NOTIFY_THREAD_AGNOSTIC asks.
         */
        RegNotifyChangeKeyValue: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, subtree, filter, event, asynchronous])=>{
                const key = keyOf(handle >>> 0);
                if (!key)
                {
                    return ERROR_INVALID_HANDLE;
                }
                const kinds = filter >>> 0;
                if ((kinds & ~(REG_NOTIFY_CHANGE_ALL | REG_NOTIFY_THREAD_AGNOSTIC)) !== 0
                    || (kinds & REG_NOTIFY_CHANGE_ALL) === 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const watcher = {
                    handle: handle >>> 0, key, subtree: subtree !== 0, filter: kinds,
                };
                if (asynchronous !== 0)
                {
                    if ((event >>> 0) === 0 || !host.events?.reset(event >>> 0))
                    {
                        return ERROR_INVALID_PARAMETER;
                    }
                    watchers.push({ ...watcher, settle: ()=>void host.events?.set(event >>> 0) });
                    return ERROR_SUCCESS;
                }
                return new Promise(resolve=>{
                    watchers.push({ ...watcher, settle: ()=>resolve(ERROR_SUCCESS) });
                });
            },
        },

        /**
         * LSTATUS RegRenameKey(HKEY hKey, LPCWSTR lpSubKeyName, LPCWSTR lpNewKeyName)
         *
         * The key, or a subkey of it, under a new name beside its siblings,
         * its values and subkeys with it. A name another sibling has is
         * refused, and so is a key of the classes root.
         */
        RegRenameKey: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, subKey, newName])=>{
                if ((subKey >>> 0) === 0 && (newName >>> 0) === 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const key = keyOf(handle >>> 0);
                if (!key)
                {
                    return ERROR_INVALID_HANDLE;
                }
                const named = (subKey >>> 0) === 0 ? key
                    : hive.open(key, readWideText(subKey >>> 0) ?? '');
                if (!named)
                {
                    return ERROR_FILE_NOT_FOUND;
                }
                const to = (newName >>> 0) === 0 ? null : readWideText(newName >>> 0);
                if (!to || to.includes('\\'))
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const place = placeOf(named);
                if (!place || hive.throughClasses(named))
                {
                    return ERROR_ACCESS_DENIED;
                }
                const result = hive.rename(place.parent, place.name, to);
                return result === 'renamed' ? ERROR_SUCCESS
                    : result === 'taken' ? ERROR_ALREADY_EXISTS : ERROR_FILE_NOT_FOUND;
            },
        },

        // Named by a path or a key's name, an object's security needs the
        // volume and the hive this library already holds.
        ...createNamedSecurityFunctions(host),
        // The descriptor and SDDL calls hand out LocalAlloc blocks.
        ...host.allocate ? createSecurityFunctions({ ...host, allocate: host.allocate,
            setLastError: host.setLastError ?? (()=>{}) }) : {},
        ...host.allocate ? createLsaFunctions({ ...host, allocate: host.allocate }) : {},

        [UNLOAD_KEY]: unload,
        [REGISTRY_NATIVES]: nativeRegistry(),
        [KEY_OF_HANDLE]: keyOf,
    };
}
