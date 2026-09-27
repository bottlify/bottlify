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
import { HKEY_CURRENT_USER } from './registry.js';

const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_MORE_DATA = 234;
const ERROR_NO_MORE_ITEMS = 259;
const ERROR_NOT_ENOUGH_MEMORY = 8;
const ERROR_INVALID_SID = 1337;
const ERROR_CALL_NOT_IMPLEMENTED = 120;

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
 * Who the program is running as. There is one account and no way to become
 * another, so this is a constant rather than something to configure -- but it
 * has to be answered, because a program that cannot learn its own user name
 * often refuses to start rather than carrying on without one.
 */
const USER_NAME = 'User';

/**
 * @typedef {Object} RegistryHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {ReturnType<typeof import('./registry.js').createHive>} hive
 * @property {(bytes: number) => number} [allocate]
 *           Guest memory for the objects this library hands out by pointer -- a
 *           SID. Without it those calls fail as an out-of-memory would, which
 *           is a result a program is written to handle.
 * @property {(code: number) => void} [setLastError]
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
    const { hive } = host;

    /** @type {Map<number, import('./registry.js').RegistryKey>} */
    const handles = new Map();
    /** @type {number[]} */
    const freed = [];
    let next = HANDLE_STRIDE;

    /**
     * Fresh handles first, closed ones only once the range runs out: a handle
     * used after it was closed then lands on nothing -- a defined error -- and
     * not on whatever key was opened next.
     *
     * @param {import('./registry.js').RegistryKey} key
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
     * @returns {import('./registry.js').RegistryKey | null}
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
     * @param {(key: import('./registry.js').RegistryKey, args: number[]) => number} handler
     * @returns {(args: number[]) => number}
     */
    const onKey = handler=>args=>{
        const key = keyOf(args[0]);
        return key ? handler(key, args) : ERROR_INVALID_HANDLE;
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
                    return 0;
                }
                host.writeMemory(buffer >>> 0, widened(encodeAnsi(`${USER_NAME}\0`)));
                writeDword(size >>> 0, needed);
                return 1;
            },
        },

        /**
         * BOOL GetFileSecurityA(LPCSTR, SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
         *                      DWORD nLength, LPDWORD lpnLengthNeeded)
         * BOOL SetFileSecurityA(LPCSTR, SECURITY_INFORMATION, PSECURITY_DESCRIPTOR)
         *
         * This machine's volume carries no security descriptors, and the
         * honest answer is the one the consumer line of Windows gave: the
         * call is not implemented. A program of the era asks before it
         * copies a file and carries on when told so; told nothing -- a zero
         * with a stale error behind it -- it takes the copy for failed.
         */
        GetFileSecurityA: { argBytes: 20, handler: notImplemented },
        SetFileSecurityA: { argBytes: 12, handler: notImplemented },

        /**
         * BOOL ImpersonateSelf(SECURITY_IMPERSONATION_LEVEL)
         * BOOL RevertToSelf(VOID)
         *
         * Impersonating oneself is the one impersonation that always
         * succeeds, and reverting from it is nothing. Both answer TRUE, so a
         * program that impersonates before opening its token goes on to open
         * it rather than stopping at a refusal Windows would not give.
         */
        ImpersonateSelf: { argBytes: 4, handler: ()=>1 },
        RevertToSelf: { argBytes: 0, handler: ()=>1 },

        SetFileSecurityW: {
            argBytes: 12,
            handler: ()=>{
                host.setLastError?.(ERROR_CALL_NOT_IMPLEMENTED);
                return 0;
            },
        },

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

        /** LONG RegCloseKey(HKEY) */
        RegCloseKey: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const key = handle >>> 0;
                if (hive.root(key))
                {
                    return ERROR_SUCCESS;
                }
                if (!handles.delete(key))
                {
                    return ERROR_INVALID_HANDLE;
                }
                freed.push(key);
                return ERROR_SUCCESS;
            },
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
    };
}
