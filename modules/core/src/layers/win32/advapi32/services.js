/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The advapi32 surface over the service control manager.
 *
 * There is one user and it is the administrator, so the manager opens for
 * anyone who asks -- an installer asks with SC_MANAGER_CREATE_SERVICE to
 * learn whether it may install, and refusing would tell it that it may not.
 *
 * The service database is the registry, as it is on Windows: a service is
 * the key `HKLM\SYSTEM\CurrentControlSet\Services\<name>` and its values,
 * and creating one writes exactly the values the real manager writes, so a
 * program that reads its own service back through the registry finds it.
 *
 * What is not here is a process to run a service in. Starting one fails the
 * way a service that never reported back fails, and controlling one fails
 * the way a stopped service does; both are results a program is written to
 * handle, and both are reported as a divergence.
 */

import { HKEY_LOCAL_MACHINE, REG_SZ, REG_EXPAND_SZ, REG_DWORD } from './registry.js';
import { WELL_KNOWN_SIDS, aceBytes, aclBytes, selfRelativeDescriptor, sidBytes } from './tokens.js';
import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';

const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_NAME = 123;
const ERROR_SERVICE_REQUEST_TIMEOUT = 1053;
const ERROR_SERVICE_DOES_NOT_EXIST = 1060;
const ERROR_SERVICE_NOT_ACTIVE = 1062;
const ERROR_SERVICE_MARKED_FOR_DELETE = 1072;
const ERROR_SERVICE_EXISTS = 1073;
const ERROR_FAILED_SERVICE_CONTROLLER_CONNECT = 1063;
const ERROR_SERVICE_NOT_IN_EXE = 1083;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INVALID_LEVEL = 124;
const ERROR_MORE_DATA = 234;

/** EnumServicesStatusEx's one information level, and the record it writes per service. */
const SC_ENUM_PROCESS_INFO = 0;
const ENUM_SERVICE_STATUS_PROCESS_SIZE = 44;

/** Service types: the drivers, the programs, and the bit a program may add to either. */
const SERVICE_DRIVER = 0x0b;
const SERVICE_WIN32 = 0x30;
const SERVICE_INTERACTIVE_PROCESS = 0x100;
const SERVICE_WIN32_OWN_PROCESS = 0x10;

/** Which services by state: running ones, stopped ones, or both. */
const SERVICE_ACTIVE = 1;
const SERVICE_STATE_ALL = 3;
const SERVICE_STOPPED = 1;

/** Where the manager keeps every service it knows. */
const SERVICES_PATH = 'SYSTEM\\CurrentControlSet\\Services';

/** A service name stops here, as a key name does. */
const MAX_SERVICE_NAME = 256;
/** A path or a display name a program hands over. */
const MAX_TEXT = 0x8000;

/** ChangeServiceConfig's "leave this one alone". */
const SERVICE_NO_CHANGE = 0xffffffff;

/** QueryServiceStatusEx's one level, and the SERVICE_STATUS_PROCESS it writes. */
const SC_STATUS_PROCESS_INFO = 0;
const SERVICE_STATUS_PROCESS_SIZE = 36;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_INVALID_ADDRESS = 487;
const ERROR_SERVICE_NEVER_STARTED = 1077;
const ERROR_INVALID_SECURITY_DESCR = 1338;

/**
 * ChangeServiceConfig2's levels, winsvc.h's from the description (1) to
 * launch protection (12); the tenth and eleventh are not defined.
 */
const SERVICE_CONFIG_DESCRIPTION = 1;
const CONFIG2_LEVELS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 12]);

/** A security descriptor's header, and what its control word says. */
const SD_SIZE = 20;
const SECURITY_DESCRIPTOR_REVISION = 1;
const SE_DACL_PRESENT = 0x0004;
const SE_SELF_RELATIVE = 0x8000;
const OWNER_SECURITY_INFORMATION = 0x1;
const GROUP_SECURITY_INFORMATION = 0x2;
const DACL_SECURITY_INFORMATION = 0x4;

/** Rights on a service: all of them, and reading, asking its state and starting it. */
const SERVICE_ALL_ACCESS = 0xf01ff;
const SERVICE_READ_AND_START = 0x2019d;
const ACCESS_ALLOWED_ACE_TYPE = 0;
/** The interactive user and service logons, whom the default lets start a service. */
const INTERACTIVE_SID = { authority: 5, subAuthorities: [4] };
const SERVICE_LOGON_SID = { authority: 5, subAuthorities: [6] };

/**
 * A service's security, part by part: each SID and the DACL as bytes, the
 * DACL null for the null DACL and absent for none.
 *
 * @typedef {{ owner?: Uint8Array, group?: Uint8Array, dacl?: Uint8Array | null }} ServiceSecurity
 */

/**
 * The descriptor the manager gives a service it creates, as Windows' own
 * default reads.
 *
 * @returns {ServiceSecurity}
 */
const defaultSecurity = ()=>({
    owner: sidBytes(WELL_KNOWN_SIDS.administrators),
    group: sidBytes(WELL_KNOWN_SIDS.system),
    dacl: aclBytes([
        aceBytes(ACCESS_ALLOWED_ACE_TYPE, 0, SERVICE_ALL_ACCESS, sidBytes(WELL_KNOWN_SIDS.system)),
        aceBytes(ACCESS_ALLOWED_ACE_TYPE, 0, SERVICE_ALL_ACCESS,
            sidBytes(WELL_KNOWN_SIDS.administrators)),
        aceBytes(ACCESS_ALLOWED_ACE_TYPE, 0, SERVICE_READ_AND_START, sidBytes(INTERACTIVE_SID)),
        aceBytes(ACCESS_ALLOWED_ACE_TYPE, 0, SERVICE_READ_AND_START, sidBytes(SERVICE_LOGON_SID)),
    ]),
});

/**
 * Handles of their own, above the registry's and the kernel's: an SC_HANDLE is
 * never an HKEY, and a program that confuses them gets ERROR_INVALID_HANDLE
 * from both sides rather than somebody else's object.
 */
const HANDLE_BASE = 0x5c000000;
const HANDLE_STRIDE = 4;

/**
 * @typedef {Object} ServiceHost
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, bytes: Uint8Array) => void} [writeMemory]
 * @property {ReturnType<typeof import('./registry-service.js').createRegistryService>} hive
 * @property {(code: number) => void} [setLastError]
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {(address: number, length: number) => Uint8Array} [readMemory]
 *           What EnumServicesStatusEx reads a resume handle and a wide group
 *           name with. Absent, every enumeration starts at the first service,
 *           and a wide group name matches none.
 */

/**
 * Text as the hive keeps a string, in the ANSI page the A calls read it in,
 * with its terminator.
 *
 * @param {string} text @returns {Uint8Array}
 */
const sz = text=>encodeAnsi(`${text}\0`);

/** @param {number} value @returns {Uint8Array} */
const dword = value=>{
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
    return bytes;
};

/**
 * Builds the function table: name -> { argBytes, handler }.
 *
 * @param {ServiceHost} host
 */
export function createServiceFunctions(host){
    const { hive } = host;

    /**
     * What a handle names: the manager itself, a service by name, or the
     * database lock.
     *
     * @type {Map<number, { kind: 'manager' | 'service' | 'lock', name?: string }>}
     */
    const handles = new Map();
    let next = HANDLE_BASE;

    /** @param {{ kind: 'manager' | 'service' | 'lock', name?: string }} object */
    const open = object=>{
        const handle = next;
        next += HANDLE_STRIDE;
        handles.set(handle, object);
        return handle;
    };

    /** @param {number} code */
    const fail = code=>{
        host.setLastError?.(code);
        return 0;
    };

    /** @param {number} address @param {number} maxLength */
    const text = (address, maxLength)=>((address >>> 0) === 0
        ? null
        : host.readCString(address >>> 0, maxLength));

    /**
     * A string argument in the width the call was made in: null for NULL,
     * and null too for a wide one when nothing here can read memory.
     *
     * @param {boolean} wide @param {number} address @param {number} maxLength
     */
    const textIn = (wide, address, maxLength)=>{
        if (!wide)
        {
            return text(address, maxLength);
        }
        if ((address >>> 0) === 0 || !host.readMemory)
        {
            return null;
        }
        let read = '';
        for (let at = address >>> 0; read.length < maxLength; at += 2)
        {
            const unit = host.readMemory(at, 2);
            const code = unit[0] | unit[1] << 8;
            if (code === 0)
            {
                break;
            }
            read += String.fromCharCode(code);
        }
        return read;
    };

    /** The key every service lives under, made if this is the first ask. */
    const servicesKey = ()=>hive.create(
        /** @type {any} */ (hive.root(HKEY_LOCAL_MACHINE)), SERVICES_PATH).key;

    /** @param {string} name */
    const serviceKey = name=>hive.open(servicesKey(), name);

    /**
     * The values the manager keeps for a service. Only the ones given are
     * written, which is what lets ChangeServiceConfig leave the rest alone.
     *
     * @param {number} key
     * @param {{ type?: number, start?: number, errorControl?: number,
     *           imagePath?: string | null, displayName?: string | null,
     *           objectName?: string | null }} config
     */
    const configure = (key, config)=>{
        if (config.type !== undefined && config.type !== SERVICE_NO_CHANGE)
        {
            hive.setValue(key, 'Type', REG_DWORD, dword(config.type));
        }
        if (config.start !== undefined && config.start !== SERVICE_NO_CHANGE)
        {
            hive.setValue(key, 'Start', REG_DWORD, dword(config.start));
        }
        if (config.errorControl !== undefined && config.errorControl !== SERVICE_NO_CHANGE)
        {
            hive.setValue(key, 'ErrorControl', REG_DWORD, dword(config.errorControl));
        }
        if (config.imagePath)
        {
            hive.setValue(key, 'ImagePath', REG_EXPAND_SZ, sz(config.imagePath));
        }
        if (config.displayName)
        {
            hive.setValue(key, 'DisplayName', REG_SZ, sz(config.displayName));
        }
        if (config.objectName)
        {
            hive.setValue(key, 'ObjectName', REG_SZ, sz(config.objectName));
        }
    };

    /** The services DeleteService marked, whose keys go with their last handle. */
    const marked = new Set();

    /** @param {number} parent @param {string} name */
    const removeTree = (parent, name)=>{
        const key = hive.open(parent, name);
        if (!key)
        {
            return;
        }
        for (const child of hive.subkeys(key))
        {
            removeTree(key, child);
        }
        hive.remove(parent, name);
    };

    /** @param {number} handle @param {'manager' | 'service' | 'lock'} kind */
    const held = (handle, kind)=>{
        const object = handles.get(handle >>> 0);
        return object && object.kind === kind ? object : null;
    };

    /** @param {number} address @param {number} value */
    const writeDword = (address, value)=>host.writeMemory?.(address >>> 0, dword(value));

    /** @param {number} address */
    const readDword = address=>{
        const bytes = host.readMemory?.(address >>> 0, 4);
        return bytes ? new DataView(bytes.slice().buffer).getUint32(0, true) : 0;
    };

    /** A value of a service's key as a number, or `fallback`. @param {number} key @param {string} name @param {number} fallback */
    const numberOf = (key, name, fallback)=>{
        const value = hive.getValue(key, name);
        return value && value.data.length >= 4
            ? new DataView(value.data.buffer, value.data.byteOffset).getUint32(0, true)
            : fallback;
    };

    /** A value of a service's key as text, or null. @param {number} key @param {string} name */
    const textOf = (key, name)=>{
        const value = hive.getValue(key, name);
        if (!value || value.data.length === 0)
        {
            return null;
        }
        const end = value.data.indexOf(0);
        return decodeAnsi(value.data.subarray(0, end < 0 ? value.data.length : end));
    };

    /**
     * The group name an enumeration was asked for: null for none, the text
     * otherwise -- undefined when it is wide and nothing here can read it.
     *
     * @param {number} pointer @param {boolean} wide
     */
    const groupNamed = (pointer, wide)=>{
        if ((pointer >>> 0) === 0)
        {
            return null;
        }
        if (!wide)
        {
            return host.readCString(pointer >>> 0, MAX_SERVICE_NAME);
        }
        if (!host.readMemory)
        {
            return undefined;
        }
        let named = '';
        for (let at = pointer >>> 0; named.length < MAX_SERVICE_NAME; at += 2)
        {
            const unit = host.readMemory(at, 2);
            const code = unit[0] | unit[1] << 8;
            if (code === 0)
            {
                break;
            }
            named += String.fromCharCode(code);
        }
        return named;
    };

    /**
     * OpenService once the name is read, in either width.
     * @param {number} manager @param {string | null} name
     */
    const openService = (manager, name)=>{
        if (!held(manager, 'manager'))
        {
            return fail(ERROR_INVALID_HANDLE);
        }
        if (!name)
        {
            return fail(ERROR_INVALID_NAME);
        }
        if (!serviceKey(name))
        {
            return fail(ERROR_SERVICE_DOES_NOT_EXIST);
        }
        return open({ kind: 'service', name });
    };

    /**
     * The service's key as QUERY_SERVICE_CONFIG: nine fields, then the strings
     * its pointers name, in the caller's buffer. Every string is there, empty
     * where the key holds none -- a caller reads them without testing for
     * NULL -- and the display name is the service's own name when no other
     * was given, as CreateService records it.
     *
     * @param {boolean} wide
     */
    const queryConfig = wide=>({
        argBytes: 16,
        handler: (/** @type {number[]} */ [service, buffer, size, needed])=>{
            const HEADER = 36;
            const object = held(service, 'service');
            const name = object ? /** @type {string} */ (object.name) : '';
            const key = object ? serviceKey(name) : null;
            if (!key)
            {
                return fail(ERROR_INVALID_HANDLE);
            }
            if ((needed >>> 0) === 0)
            {
                return fail(ERROR_INVALID_ADDRESS);
            }
            const encode = (/** @type {string} */ words)=>(wide
                ? new Uint8Array(Uint16Array.from(`${words} `, c=>c.charCodeAt(0)).buffer)
                : sz(words));
            // Path, group, dependencies (an empty list: two terminators), account, display name.
            const strings = [
                encode(textOf(key, 'ImagePath') ?? ''),
                encode(textOf(key, 'Group') ?? ''),
                new Uint8Array(wide ? 4 : 2),
                encode(textOf(key, 'ObjectName') ?? ''),
                encode(textOf(key, 'DisplayName') ?? name),
            ];
            const total = strings.reduce((sum, bytes)=>sum + bytes.length, HEADER);
            writeDword(needed, total);
            if ((size >>> 0) < total || (buffer >>> 0) === 0)
            {
                return fail(ERROR_INSUFFICIENT_BUFFER);
            }
            const out = new Uint8Array(total);
            const view = new DataView(out.buffer);
            view.setUint32(0, numberOf(key, 'Type', SERVICE_WIN32_OWN_PROCESS), true);
            view.setUint32(4, numberOf(key, 'Start', 3), true);
            view.setUint32(8, numberOf(key, 'ErrorControl', 1), true);
            view.setUint32(20, numberOf(key, 'Tag', 0), true);
            let at = HEADER;
            for (const [index, offset] of [12, 16, 24, 28, 32].entries())
            {
                view.setUint32(offset, (buffer >>> 0) + at, true);
                out.set(strings[index], at);
                at += strings[index].length;
            }
            host.writeMemory?.(buffer >>> 0, out);
            return 1;
        },
    });

    /**
     * EnumServicesStatusExA and W: the services the database holds, in name
     * order, each with its type and -- no service ever runs here -- stopped.
     * As many as fit are written, their names after the records; with room
     * for fewer than all, FALSE and ERROR_MORE_DATA, the bytes the rest need
     * and the resume handle where the next call takes up.
     *
     * @param {boolean} wide
     */
    const enumServices = wide=>({
        argBytes: 40,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [manager, level, typeMask, stateMask, buffer, size,
            needed, returned, resume, groupPointer])=>{
            if (!held(manager, 'manager'))
            {
                return fail(ERROR_INVALID_HANDLE);
            }
            if ((level >>> 0) !== SC_ENUM_PROCESS_INFO)
            {
                return fail(ERROR_INVALID_LEVEL);
            }
            const types = typeMask >>> 0;
            const states = stateMask >>> 0;
            if ((types & (SERVICE_DRIVER | SERVICE_WIN32)) === 0
                || (types & ~(SERVICE_DRIVER | SERVICE_WIN32 | SERVICE_INTERACTIVE_PROCESS)) !== 0
                || states === 0 || states > SERVICE_STATE_ALL
                || (needed >>> 0) === 0 || (returned >>> 0) === 0)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            const group = groupNamed(groupPointer, wide);
            /** @param {string} words */
            const encode = words=>(wide
                ? new Uint8Array(Uint16Array.from(`${words}\0`, c=>c.charCodeAt(0)).buffer)
                : sz(words));

            const all = (states & ~SERVICE_ACTIVE) === 0 ? [] : hive.subkeys(servicesKey())
                .slice()
                .sort((a, b)=>a.toUpperCase().localeCompare(b.toUpperCase()))
                .flatMap(name=>{
                    const key = serviceKey(name);
                    if (!key)
                    {
                        return [];
                    }
                    const type = numberOf(key, 'Type', SERVICE_WIN32_OWN_PROCESS);
                    const own = textOf(key, 'Group') ?? '';
                    const inGroup = group === null
                        || (group !== undefined && own.toUpperCase() === group.toUpperCase());
                    return (type & types) !== 0 && inGroup
                        ? [{ name, display: textOf(key, 'DisplayName') ?? name, type }]
                        : [];
                });

            const first = (resume >>> 0) === 0 ? 0 : Math.min(readDword(resume), all.length);
            const rest = all.slice(first);
            const costOf = (/** @type {{ name: string, display: string }} */ entry)=>
                ENUM_SERVICE_STATUS_PROCESS_SIZE + encode(entry.name).length
                + encode(entry.display).length;
            let room = size >>> 0;
            let fitting = 0;
            while (fitting < rest.length && costOf(rest[fitting]) <= room)
            {
                room -= costOf(rest[fitting]);
                fitting++;
            }

            const base = buffer >>> 0;
            let strings = base + fitting * ENUM_SERVICE_STATUS_PROCESS_SIZE;
            rest.slice(0, fitting).forEach((entry, at)=>{
                const record = new DataView(new ArrayBuffer(ENUM_SERVICE_STATUS_PROCESS_SIZE));
                const name = encode(entry.name);
                const display = encode(entry.display);
                host.writeMemory?.(strings, name);
                record.setUint32(0, strings, true);
                strings += name.length;
                host.writeMemory?.(strings, display);
                record.setUint32(4, strings, true);
                strings += display.length;
                // SERVICE_STATUS_PROCESS: the type, stopped, nothing accepted,
                // no exit codes, no process -- every other word zero.
                record.setUint32(8, entry.type, true);
                record.setUint32(12, SERVICE_STOPPED, true);
                host.writeMemory?.(base + at * ENUM_SERVICE_STATUS_PROCESS_SIZE,
                    new Uint8Array(record.buffer));
            });

            writeDword(returned, fitting);
            const left = rest.slice(fitting).reduce((sum, entry)=>sum + costOf(entry), 0);
            writeDword(needed, left);
            if ((resume >>> 0) !== 0)
            {
                writeDword(resume, fitting === rest.length ? 0 : first + fitting);
            }
            return fitting === rest.length ? 1 : fail(ERROR_MORE_DATA);
        },
    });

    /** CreateService in either width. @param {boolean} wide */
    const createService = wide=>({
        argBytes: 52,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [manager, nameAddress, displayAddress, , type, start,
            errorControl, pathAddress, , , , startNameAddress])=>{
            if (!held(manager, 'manager'))
            {
                return fail(ERROR_INVALID_HANDLE);
            }
            const name = textIn(wide, nameAddress, MAX_SERVICE_NAME);
            if (!name)
            {
                return fail(ERROR_INVALID_NAME);
            }
            if (serviceKey(name))
            {
                return fail(ERROR_SERVICE_EXISTS);
            }
            configure(hive.create(servicesKey(), name).key, {
                type: type >>> 0,
                start: start >>> 0,
                errorControl: errorControl >>> 0,
                imagePath: textIn(wide, pathAddress, MAX_TEXT),
                displayName: textIn(wide, displayAddress, MAX_TEXT),
                // A service with no account named runs as the system.
                objectName: textIn(wide, startNameAddress, MAX_TEXT) ?? 'LocalSystem',
            });
            return open({ kind: 'service', name });
        },
    });

    /** ChangeServiceConfig in either width. @param {boolean} wide */
    const changeConfig = wide=>({
        argBytes: 44,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [service, type, start, errorControl, pathAddress, , , ,
            startNameAddress, , displayAddress])=>{
            const object = held(service, 'service');
            const key = object ? serviceKey(/** @type {string} */ (object.name)) : null;
            if (!key)
            {
                return fail(ERROR_INVALID_HANDLE);
            }
            configure(key, {
                type: type >>> 0,
                start: start >>> 0,
                errorControl: errorControl >>> 0,
                imagePath: textIn(wide, pathAddress, MAX_TEXT),
                displayName: textIn(wide, displayAddress, MAX_TEXT),
                objectName: textIn(wide, startNameAddress, MAX_TEXT),
            });
            return 1;
        },
    });

    /** ChangeServiceConfig2 in either width. @param {boolean} wide */
    const changeConfig2 = wide=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [service, level, info])=>{
            const object = held(service, 'service');
            const key = object ? serviceKey(/** @type {string} */ (object.name)) : null;
            if (!key)
            {
                return fail(ERROR_INVALID_HANDLE);
            }
            if (!CONFIG2_LEVELS.has(level >>> 0))
            {
                return fail(ERROR_INVALID_LEVEL);
            }
            if ((info >>> 0) === 0)
            {
                return fail(ERROR_INVALID_ADDRESS);
            }
            if ((level >>> 0) === SERVICE_CONFIG_DESCRIPTION)
            {
                // SERVICE_DESCRIPTION: one pointer to the text, NULL to leave it.
                const description = textIn(wide, readDword(info), MAX_TEXT);
                if (description !== null)
                {
                    hive.setValue(key, 'Description', REG_SZ, sz(description));
                }
            }
            return 1;
        },
    });

    /**
     * StartService in either width. Nothing here can host a service process,
     * so the start fails as one that never reported back would.
     *
     * @param {string} api
     */
    const startService = api=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [service])=>{
            const object = held(service, 'service');
            if (!object)
            {
                return fail(ERROR_INVALID_HANDLE);
            }
            host.divergence?.(api,
                `${object.name}: no process hosts a service here; reported as timed out`);
            return fail(ERROR_SERVICE_REQUEST_TIMEOUT);
        },
    });

    /**
     * The security SetServiceObjectSecurity gave each service by name; a
     * service with none has the manager's default.
     *
     * @type {Map<string, ServiceSecurity>}
     */
    const security = new Map();

    /**
     * The parts of a descriptor the caller made, absolute -- pointers -- or
     * self-relative -- offsets from its start -- or null for one that is
     * not a descriptor. A DACL present with no list is the null DACL.
     *
     * @param {number} at
     * @returns {ServiceSecurity | null}
     */
    const descriptorParts = at=>{
        if (at === 0 || !host.readMemory)
        {
            return null;
        }
        const head = host.readMemory(at, SD_SIZE).slice();
        if (head[0] !== SECURITY_DESCRIPTOR_REVISION)
        {
            return null;
        }
        const view = new DataView(head.buffer);
        const control = view.getUint16(2, true);
        const relative = (control & SE_SELF_RELATIVE) !== 0;
        /** @param {number} slot */
        const part = slot=>{
            const value = view.getUint32(slot, true);
            return value === 0 ? 0 : relative ? (at + value) >>> 0 : value;
        };
        /** @param {number} sid */
        const sidAt = sid=>(sid === 0 ? undefined
            : host.readMemory?.(sid, 8 + 4 * (host.readMemory?.(sid, 2)[1] ?? 0)).slice());
        const dacl = part(16);
        /** @type {ServiceSecurity} */
        const parts = { owner: sidAt(part(4)), group: sidAt(part(8)) };
        if ((control & SE_DACL_PRESENT) !== 0)
        {
            // An ACL says its own size in its header's third and fourth bytes.
            const size = dacl === 0 ? 0 : readDword(dacl) >>> 16;
            parts.dacl = dacl === 0 ? null : host.readMemory(dacl, size).slice();
        }
        return parts;
    };

    return {
        /**
         * SC_HANDLE OpenSCManagerA(LPCSTR lpMachineName, LPCSTR lpDatabaseName,
         *                          DWORD dwDesiredAccess)
         *
         * Any access, because the one user is the administrator.
         */
        OpenSCManagerA: {
            argBytes: 12,
            handler: ()=>open({ kind: 'manager' }),
        },

        /**
         * SC_HANDLE OpenSCManagerW(LPCWSTR lpMachineName, LPCWSTR lpDatabaseName,
         *                          DWORD dwDesiredAccess)
         *
         * The A form's manager: the names are this machine's and its one
         * database, whichever width they come in.
         */
        OpenSCManagerW: {
            argBytes: 12,
            handler: ()=>open({ kind: 'manager' }),
        },

        /**
         * BOOL EnumServicesStatusExA(SC_HANDLE hSCManager, SC_ENUM_TYPE InfoLevel,
         *   DWORD dwServiceType, DWORD dwServiceState, LPBYTE lpServices,
         *   DWORD cbBufSize, LPDWORD pcbBytesNeeded, LPDWORD lpServicesReturned,
         *   LPDWORD lpResumeHandle, LPCSTR pszGroupName)
         * BOOL EnumServicesStatusExW(..., LPCWSTR pszGroupName)
         */
        EnumServicesStatusExA: enumServices(false),
        EnumServicesStatusExW: enumServices(true),

        /** SC_HANDLE OpenServiceA(SC_HANDLE hSCManager, LPCSTR lpServiceName, DWORD dwDesiredAccess) */
        OpenServiceA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([manager, nameAddress])=>
                openService(manager, text(nameAddress, MAX_SERVICE_NAME)),
        },

        /** SC_HANDLE OpenServiceW(SC_HANDLE hSCManager, LPCWSTR lpServiceName, DWORD dwDesiredAccess) */
        OpenServiceW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([manager, nameAddress])=>
                openService(manager, groupNamed(nameAddress, true) ?? null),
        },

        /**
         * SC_HANDLE CreateServiceA(SC_HANDLE hSCManager, LPCSTR lpServiceName,
         *   LPCSTR lpDisplayName, DWORD dwDesiredAccess, DWORD dwServiceType,
         *   DWORD dwStartType, DWORD dwErrorControl, LPCSTR lpBinaryPathName,
         *   LPCSTR lpLoadOrderGroup, LPDWORD lpdwTagId, LPCSTR lpDependencies,
         *   LPCSTR lpServiceStartName, LPCSTR lpPassword)
         * SC_HANDLE CreateServiceW(..., LPCWSTR ...)
         */
        CreateServiceA: createService(false),
        CreateServiceW: createService(true),

        /**
         * BOOL ChangeServiceConfigA(SC_HANDLE hService, DWORD dwServiceType,
         *   DWORD dwStartType, DWORD dwErrorControl, LPCSTR lpBinaryPathName,
         *   LPCSTR lpLoadOrderGroup, LPDWORD lpdwTagId, LPCSTR lpDependencies,
         *   LPCSTR lpServiceStartName, LPCSTR lpPassword, LPCSTR lpDisplayName)
         * BOOL ChangeServiceConfigW(..., LPCWSTR ...)
         */
        ChangeServiceConfigA: changeConfig(false),
        ChangeServiceConfigW: changeConfig(true),

        /**
         * BOOL ChangeServiceConfig2A(SC_HANDLE hService, DWORD dwInfoLevel, LPVOID lpInfo)
         * BOOL ChangeServiceConfig2W(SC_HANDLE hService, DWORD dwInfoLevel, LPVOID lpInfo)
         *
         * The optional configuration. A description is kept where the
         * manager keeps it, the key's `Description`, and a NULL one leaves it
         * as it was; the other levels Windows defines are taken and, there
         * being no service to fail, restart or start late, change nothing.
         */
        ChangeServiceConfig2A: changeConfig2(false),
        ChangeServiceConfig2W: changeConfig2(true),

        /**
         * BOOL StartServiceA(SC_HANDLE hService, DWORD dwNumServiceArgs,
         *                    LPCSTR *lpServiceArgVectors)
         *
         * Nothing here can host a service process, so the start fails as one
         * that never reported back would.
         */
        StartServiceA: startService('StartServiceA'),

        /** BOOL StartServiceW(SC_HANDLE hService, DWORD dwNumServiceArgs, LPCWSTR *lpServiceArgVectors) */
        StartServiceW: startService('StartServiceW'),

        /**
         * BOOL ControlService(SC_HANDLE hService, DWORD dwControl,
         *                     LPSERVICE_STATUS lpServiceStatus)
         *
         * No service ever runs, so every one is stopped, and a stopped
         * service refuses a control.
         */
        ControlService: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([service])=>(held(service, 'service')
                ? fail(ERROR_SERVICE_NOT_ACTIVE)
                : fail(ERROR_INVALID_HANDLE)),
        },

        /**
         * BOOL QueryServiceStatus(SC_HANDLE hService, LPSERVICE_STATUS lpServiceStatus)
         *
         * Stopped, never having started -- no service runs here -- with the
         * type its key was created with.
         */
        QueryServiceStatus: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([service, status])=>{
                const object = held(service, 'service');
                if (!object)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const key = serviceKey(/** @type {string} */ (object.name));
                const typed = key ? hive.getValue(key, 'Type') : null;
                const type = typed && typed.data.length >= 4
                    ? new DataView(typed.data.buffer, typed.data.byteOffset).getUint32(0, true)
                    : SERVICE_WIN32_OWN_PROCESS;
                const bytes = new Uint8Array(28);
                const view = new DataView(bytes.buffer);
                view.setUint32(0, type, true);
                view.setUint32(4, SERVICE_STOPPED, true);
                view.setUint32(12, ERROR_SERVICE_NEVER_STARTED, true);
                host.writeMemory?.(status >>> 0, bytes);
                return 1;
            },
        },

        /**
         * BOOL QueryServiceStatusEx(SC_HANDLE hService, SC_STATUS_TYPE InfoLevel,
         *   LPBYTE lpBuffer, DWORD cbBufSize, LPDWORD pcbBytesNeeded)
         *
         * SERVICE_STATUS_PROCESS, the one level there is: QueryServiceStatus's
         * answer with no process behind it and no flags. A buffer smaller
         * than the record says how big it must be.
         */
        QueryServiceStatusEx: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([service, level, buffer, size, needed])=>{
                const object = held(service, 'service');
                if (!object)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if ((level >>> 0) !== SC_STATUS_PROCESS_INFO)
                {
                    return fail(ERROR_INVALID_LEVEL);
                }
                if ((size >>> 0) < SERVICE_STATUS_PROCESS_SIZE || (buffer >>> 0) === 0)
                {
                    if ((needed >>> 0) !== 0)
                    {
                        writeDword(needed, SERVICE_STATUS_PROCESS_SIZE);
                    }
                    return fail(ERROR_INSUFFICIENT_BUFFER);
                }
                const key = serviceKey(/** @type {string} */ (object.name));
                const bytes = new Uint8Array(SERVICE_STATUS_PROCESS_SIZE);
                const view = new DataView(bytes.buffer);
                view.setUint32(0, key ? numberOf(key, 'Type', SERVICE_WIN32_OWN_PROCESS)
                    : SERVICE_WIN32_OWN_PROCESS, true);
                view.setUint32(4, SERVICE_STOPPED, true);
                view.setUint32(12, ERROR_SERVICE_NEVER_STARTED, true);
                host.writeMemory?.(buffer >>> 0, bytes);
                return 1;
            },
        },

        /**
         * BOOL QueryServiceObjectSecurity(SC_HANDLE hService,
         *   SECURITY_INFORMATION dwSecurityInformation,
         *   PSECURITY_DESCRIPTOR lpSecurityDescriptor, DWORD cbBufSize,
         *   LPDWORD pcbBytesNeeded)
         *
         * The service's descriptor, self-relative, with the parts asked for:
         * the ones SetServiceObjectSecurity gave it, or the manager's default
         * -- the administrators own it and, with the system, may do anything
         * to it; interactive and service users may read it, ask its state and
         * start it.
         */
        QueryServiceObjectSecurity: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([service, information, buffer, size, needed])=>{
                const object = held(service, 'service');
                if (!object)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const kept = security.get(/** @type {string} */ (object.name)) ?? defaultSecurity();
                const asked = information >>> 0;
                /** @type {{ owner?: Uint8Array, group?: Uint8Array, dacl?: Uint8Array | null }} */
                const parts = {};
                if ((asked & OWNER_SECURITY_INFORMATION) !== 0 && kept.owner)
                {
                    parts.owner = kept.owner;
                }
                if ((asked & GROUP_SECURITY_INFORMATION) !== 0 && kept.group)
                {
                    parts.group = kept.group;
                }
                if ((asked & DACL_SECURITY_INFORMATION) !== 0 && kept.dacl !== undefined)
                {
                    parts.dacl = kept.dacl;
                }
                const { bytes } = selfRelativeDescriptor(parts);
                if ((needed >>> 0) !== 0)
                {
                    writeDword(needed, bytes.length);
                }
                if ((size >>> 0) < bytes.length || (buffer >>> 0) === 0)
                {
                    return fail(ERROR_INSUFFICIENT_BUFFER);
                }
                host.writeMemory?.(buffer >>> 0, bytes);
                return 1;
            },
        },

        /**
         * BOOL SetServiceObjectSecurity(SC_HANDLE hService,
         *   SECURITY_INFORMATION dwSecurityInformation,
         *   PSECURITY_DESCRIPTOR lpSecurityDescriptor)
         *
         * The parts named, taken from the descriptor -- absolute or
         * self-relative -- and kept for the service: what an installer that
         * lets ordinary users start its service writes, and reads back.
         */
        SetServiceObjectSecurity: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([service, information, descriptor])=>{
                const object = held(service, 'service');
                if (!object)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const read = descriptorParts(descriptor >>> 0);
                if (!read)
                {
                    return fail(ERROR_INVALID_SECURITY_DESCR);
                }
                const name = /** @type {string} */ (object.name);
                const kept = { ...security.get(name) ?? defaultSecurity() };
                const asked = information >>> 0;
                if ((asked & OWNER_SECURITY_INFORMATION) !== 0)
                {
                    kept.owner = read.owner;
                }
                if ((asked & GROUP_SECURITY_INFORMATION) !== 0)
                {
                    kept.group = read.group;
                }
                if ((asked & DACL_SECURITY_INFORMATION) !== 0)
                {
                    kept.dacl = read.dacl;
                }
                security.set(name, kept);
                return 1;
            },
        },

        /**
         * BOOL QueryServiceConfigA(SC_HANDLE hService, LPQUERY_SERVICE_CONFIGA
         *   lpServiceConfig, DWORD cbBufSize, LPDWORD pcbBytesNeeded)
         * BOOL QueryServiceConfigW(..., LPQUERY_SERVICE_CONFIGW, ...)
         */
        QueryServiceConfigA: queryConfig(false),
        QueryServiceConfigW: queryConfig(true),

        /** SC_LOCK LockServiceDatabase(SC_HANDLE hSCManager) */
        LockServiceDatabase: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([manager])=>(held(manager, 'manager')
                ? open({ kind: 'lock' })
                : fail(ERROR_INVALID_HANDLE)),
        },

        /** BOOL UnlockServiceDatabase(SC_LOCK ScLock) */
        UnlockServiceDatabase: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([lock])=>(held(lock, 'lock') && handles.delete(lock >>> 0)
                ? 1
                : fail(ERROR_INVALID_HANDLE)),
        },

        /**
         * BOOL DeleteService(SC_HANDLE hService)
         *
         * Marks the service for deletion. No service runs here, so its key
         * goes as soon as no handle is open on it, which is when the manager
         * removes a stopped one.
         */
        DeleteService: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([service])=>{
                const object = held(service, 'service');
                if (!object)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const name = /** @type {string} */ (object.name);
                if (marked.has(name))
                {
                    return fail(ERROR_SERVICE_MARKED_FOR_DELETE);
                }
                marked.add(name);
                return 1;
            },
        },

        /** BOOL CloseServiceHandle(SC_HANDLE hSCObject) */
        CloseServiceHandle: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const object = handles.get(handle >>> 0);
                if (!object)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                handles.delete(handle >>> 0);
                const name = object.name;
                if (object.kind === 'service' && name !== undefined && marked.has(name)
                    && ![...handles.values()].some(other=>other.name === name))
                {
                    marked.delete(name);
                    removeTree(servicesKey(), name);
                }
                return 1;
            },
        },

        // The other side of the manager: what a program calls to run as a
        // service. None here is started by one, so these answer as they do to
        // any program that was started from a shell -- which is what a game
        // that carries a service mode finds when it tries it and falls back to
        // running as an ordinary program.

        /**
         * BOOL StartServiceCtrlDispatcherA(const SERVICE_TABLE_ENTRYA *lpServiceStartTable)
         *
         * Connects the process to the manager that started it. A process the
         * manager did not start has nothing to connect to: FALSE, and
         * ERROR_FAILED_SERVICE_CONTROLLER_CONNECT.
         */
        StartServiceCtrlDispatcherA: {
            argBytes: 4,
            handler: ()=>fail(ERROR_FAILED_SERVICE_CONTROLLER_CONNECT),
        },

        /** The same, its table's names in UTF-16. */
        StartServiceCtrlDispatcherW: {
            argBytes: 4,
            handler: ()=>fail(ERROR_FAILED_SERVICE_CONTROLLER_CONNECT),
        },

        /**
         * SERVICE_STATUS_HANDLE RegisterServiceCtrlHandlerA(LPCSTR lpServiceName,
         *                                                   LPHANDLER_FUNCTION lpHandlerProc)
         *
         * Names a handler for a service of this process. The process runs none,
         * so the name is not one of its services: NULL, ERROR_SERVICE_NOT_IN_EXE.
         */
        RegisterServiceCtrlHandlerA: {
            argBytes: 8,
            handler: ()=>fail(ERROR_SERVICE_NOT_IN_EXE),
        },

        /** The same, the service's name in UTF-16. */
        RegisterServiceCtrlHandlerW: {
            argBytes: 8,
            handler: ()=>fail(ERROR_SERVICE_NOT_IN_EXE),
        },

        /**
         * SERVICE_STATUS_HANDLE RegisterServiceCtrlHandlerExA/W(LPCSTR lpServiceName,
         *   LPHANDLER_FUNCTION_EX lpHandlerProc, LPVOID lpContext)
         *
         * The handler that takes a context: the same answer.
         */
        RegisterServiceCtrlHandlerExA: {
            argBytes: 12,
            handler: ()=>fail(ERROR_SERVICE_NOT_IN_EXE),
        },
        RegisterServiceCtrlHandlerExW: {
            argBytes: 12,
            handler: ()=>fail(ERROR_SERVICE_NOT_IN_EXE),
        },

        /**
         * BOOL SetServiceStatus(SERVICE_STATUS_HANDLE hServiceStatus,
         *                       LPSERVICE_STATUS lpServiceStatus)
         *
         * Reports a state to the manager through the handle the registration
         * gave. None was given, so whatever is passed is not one.
         */
        SetServiceStatus: {
            argBytes: 8,
            handler: ()=>fail(ERROR_INVALID_HANDLE),
        },
    };
}
