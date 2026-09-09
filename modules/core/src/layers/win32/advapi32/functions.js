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

const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_MORE_DATA = 234;
const ERROR_NO_MORE_ITEMS = 259;
const ERROR_NOT_ENOUGH_MEMORY = 8;
const ERROR_INVALID_SID = 1337;

/** The count is a byte and the format allows eight. */
const MAX_SUB_AUTHORITIES = 8;

/** What RegCreateKeyEx reports through lpdwDisposition. */
const REG_CREATED_NEW_KEY = 1;
const REG_OPENED_EXISTING_KEY = 2;

/** The only type the older RegSetValue/RegQueryValue pair can carry. */
const REG_SZ = 1;

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

    /** @param {number} pointer @param {string} text */
    const writeText = (pointer, text)=>{
        const bytes = new Uint8Array(text.length + 1);
        for (let i = 0; i < text.length; i++)
        {
            bytes[i] = text.charCodeAt(i) & 0xff;
        }
        host.writeMemory(pointer, bytes);
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
     * Writes an enumerated name into the caller's buffer, honouring the
     * character-count convention in both directions.
     *
     * @param {number} buffer @param {number} sizePointer @param {string} text
     * @returns {number} ERROR_SUCCESS, or a code the caller must return as is
     */
    const writeName = (buffer, sizePointer, text)=>{
        if (buffer === 0 || sizePointer === 0)
        {
            return ERROR_INVALID_PARAMETER;
        }
        if (text.length + 1 > readDword(sizePointer))
        {
            // The enumerators do not report the size they needed -- unlike the
            // data buffers below. RegQueryInfoKeyA is where a caller learns how
            // large its buffers have to be.
            return ERROR_MORE_DATA;
        }
        writeText(buffer, text);
        writeDword(sizePointer, text.length);
        return ERROR_SUCCESS;
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
    const createKeyEx = {
        argBytes: 36,
        handler: onKey((key, [, subKey, , , , , , result, disposition])=>{
            if (result === 0)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const made = hive.create(key, readText(subKey));
            writeDword(result, allocate(made.key));
            writeDwordIf(disposition,
                made.created ? REG_CREATED_NEW_KEY : REG_OPENED_EXISTING_KEY);
            return ERROR_SUCCESS;
        }),
    };

    /** LONG RegOpenKeyExA(HKEY, LPCSTR, DWORD ulOptions, REGSAM, PHKEY) */
    const openKeyEx = {
        argBytes: 20,
        handler: onKey((key, [, subKey, , , result])=>{
            if (result === 0)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const found = hive.open(key, readText(subKey));
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
    };

    return {
        RegOpenKeyExA: openKeyEx,

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
                if ((type >>> 0) !== REG_SZ)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const name = readText(subKey);
                const target = name === null || name === ''
                    ? key
                    : hive.create(key, name).key;
                const text = readText(data) ?? '';
                const bytes = new Uint8Array(text.length + 1);
                for (let at = 0; at < text.length; at++)
                {
                    bytes[at] = text.charCodeAt(at) & 0xff;
                }
                hive.setValue(target, '', REG_SZ, bytes);
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
        RegQueryValueExA: {
            argBytes: 24,
            handler: onKey((key, [, name, , type, data, size])=>{
                const value = hive.getValue(key, readText(name) ?? '');
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
                const required = value.data.length;
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
                host.writeMemory(data, value.data);
                writeDword(size, required);
                return ERROR_SUCCESS;
            }),
        },

        /** LONG RegSetValueExA(HKEY, LPCSTR, DWORD, DWORD dwType, const BYTE*, DWORD cbData) */
        RegSetValueExA: {
            argBytes: 24,
            handler: onKey((key, [, name, , type, data, size])=>{
                const length = size >>> 0;
                // The memory layer may hand back a view onto guest memory, and
                // what is stored here outlives the call.
                const bytes = data === 0 || length === 0
                    ? new Uint8Array(0)
                    : host.readMemory(data, length).slice();
                hive.setValue(key, readText(name) ?? '', type >>> 0, bytes);
                return ERROR_SUCCESS;
            }),
        },

        /** LONG RegDeleteValueA(HKEY, LPCSTR) */
        RegDeleteValueA: {
            argBytes: 8,
            handler: onKey((key, [, name])=>
                hive.deleteValue(key, readText(name) ?? '')
                    ? ERROR_SUCCESS
                    : ERROR_FILE_NOT_FOUND),
        },

        /**
         * LONG RegDeleteKeyA(HKEY, LPCSTR)
         *
         * NT does not delete a tree: a key with subkeys of its own is refused,
         * and the caller is expected to walk the tree itself.
         */
        RegDeleteKeyA: {
            argBytes: 8,
            handler: onKey((key, [, subKey])=>{
                switch (hive.remove(key, readText(subKey))){
                    case 'deleted':
                        return ERROR_SUCCESS;
                    case 'has-subkeys':
                        return ERROR_ACCESS_DENIED;
                    default:
                        return ERROR_FILE_NOT_FOUND;
                }
            }),
        },

        /**
         * LONG RegEnumKeyExA(HKEY, DWORD dwIndex, LPSTR, LPDWORD, LPDWORD,
         *                    LPSTR lpClass, LPDWORD lpcchClass, PFILETIME)
         */
        RegEnumKeyExA: {
            argBytes: 32,
            handler: onKey((key, [, index, name, nameSize, , keyClass, classSize, fileTime])=>{
                const names = hive.subkeys(key);
                const at = index >>> 0;
                if (at >= names.length)
                {
                    return ERROR_NO_MORE_ITEMS;
                }
                const status = writeName(name, nameSize, names[at]);
                if (status !== ERROR_SUCCESS)
                {
                    return status;
                }
                // Classes are a facility nothing we run uses; an empty one is
                // still an answer, and callers do read the length back.
                if (keyClass !== 0)
                {
                    writeText(keyClass, '');
                }
                writeDwordIf(classSize, 0);
                writeFileTime(fileTime);
                return ERROR_SUCCESS;
            }),
        },

        /**
         * LONG RegEnumValueA(HKEY, DWORD dwIndex, LPSTR, LPDWORD, LPDWORD,
         *                    LPDWORD lpType, LPBYTE lpData, LPDWORD lpcbData)
         */
        RegEnumValueA: {
            argBytes: 32,
            handler: onKey((key, [, index, name, nameSize, , type, data, size])=>{
                const values = hive.values(key);
                const at = index >>> 0;
                if (at >= values.length)
                {
                    return ERROR_NO_MORE_ITEMS;
                }
                const value = values[at];
                const status = writeName(name, nameSize, value.name);
                if (status !== ERROR_SUCCESS)
                {
                    return status;
                }
                writeDwordIf(type, value.type);
                const required = value.data.length;
                if (data === 0)
                {
                    writeDwordIf(size, required);
                    return ERROR_SUCCESS;
                }
                if (size === 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                if (readDword(size) < required)
                {
                    // The data half does report what it needed, where the name
                    // half above does not.
                    writeDword(size, required);
                    return ERROR_MORE_DATA;
                }
                host.writeMemory(data, value.data);
                writeDword(size, required);
                return ERROR_SUCCESS;
            }),
        },

        /**
         * LONG RegQueryInfoKeyA(HKEY, LPSTR, LPDWORD, LPDWORD, LPDWORD, LPDWORD,
         *                       LPDWORD, LPDWORD, LPDWORD, LPDWORD, LPDWORD, PFILETIME)
         *
         * The oracle the enumerators are not: this is where a caller learns how
         * large to make the buffers it will pass them. Every length here counts
         * characters and excludes the terminator, except the data length, which
         * counts bytes and includes it.
         */
        RegQueryInfoKeyA: {
            argBytes: 48,
            handler: onKey((key, args)=>{
                const [, keyClass, classSize, , subKeys, maxSubKeyLen, maxClassLen, valueCount,
                    maxValueNameLen, maxValueLen, securitySize, fileTime] = args;
                const names = hive.subkeys(key);
                const values = hive.values(key);
                if (keyClass !== 0)
                {
                    writeText(keyClass, '');
                }
                writeDwordIf(classSize, 0);
                writeDwordIf(subKeys, names.length);
                writeDwordIf(maxSubKeyLen, largest(names.map(name=>name.length)));
                writeDwordIf(maxClassLen, 0);
                writeDwordIf(valueCount, values.length);
                writeDwordIf(maxValueNameLen, largest(values.map(value=>value.name.length)));
                writeDwordIf(maxValueLen, largest(values.map(value=>value.data.length)));
                writeDwordIf(securitySize, 0);
                writeFileTime(fileTime);
                return ERROR_SUCCESS;
            }),
        },
    };
}
