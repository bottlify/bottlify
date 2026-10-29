/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The advapi32 surface over the service control manager.
 *
 * There is one user and it is the administrator, so the manager opens for
 * anyone who asks. A handle still carries the access it was opened with,
 * and a call the handle was not opened for is refused as the manager refuses
 * it: an installer that opens with SC_MANAGER_CONNECT and then creates a
 * service learns it asked for too little.
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

import {
    HKEY_LOCAL_MACHINE, REG_SZ, REG_EXPAND_SZ, REG_DWORD, REG_MULTI_SZ,
} from './registry.js';
import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';
import { createCredFunctions } from './cred.js';
import { createPerfFunctions } from './perf.js';
import {
    WELL_KNOWN_SIDS, aceBytes, aclBytes, selfRelativeDescriptor, sidBytes,
} from './tokens.js';

const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_INVALID_NAME = 123;
const ERROR_INVALID_LEVEL = 124;
const ERROR_MORE_DATA = 234;
const ERROR_INVALID_ADDRESS = 487;
const ERROR_SERVICE_REQUEST_TIMEOUT = 1053;
const ERROR_SERVICE_DISABLED = 1058;
const ERROR_SERVICE_DOES_NOT_EXIST = 1060;
const ERROR_SERVICE_NOT_ACTIVE = 1062;
const ERROR_FAILED_SERVICE_CONTROLLER_CONNECT = 1063;
const ERROR_DATABASE_DOES_NOT_EXIST = 1065;
const ERROR_SERVICE_MARKED_FOR_DELETE = 1072;
const ERROR_SERVICE_EXISTS = 1073;
const ERROR_SERVICE_NEVER_STARTED = 1077;
const ERROR_DUPLICATE_SERVICE_NAME = 1078;
const ERROR_SERVICE_NOT_IN_EXE = 1083;
const ERROR_INVALID_SERVICE_LOCK = 1071;
const RPC_S_SERVER_UNAVAILABLE = 1722;

/** EnumServicesStatusEx's and QueryServiceStatusEx's one information level. */
const SC_ENUM_PROCESS_INFO = 0;
const SC_STATUS_PROCESS_INFO = 0;
/** ENUM_SERVICE_STATUS_PROCESS, ENUM_SERVICE_STATUS, SERVICE_STATUS(_PROCESS). */
const ENUM_SERVICE_STATUS_PROCESS_SIZE = 44;
const ENUM_SERVICE_STATUS_SIZE = 36;
const SERVICE_STATUS_SIZE = 28;
const SERVICE_STATUS_PROCESS_SIZE = 36;

/** Service types: the drivers, the programs, and the bit a program may add to either. */
const SERVICE_KERNEL_DRIVER = 0x01;
const SERVICE_FILE_SYSTEM_DRIVER = 0x02;
const SERVICE_DRIVER = 0x0b;
const SERVICE_WIN32_OWN_PROCESS = 0x10;
const SERVICE_WIN32_SHARE_PROCESS = 0x20;
const SERVICE_WIN32 = 0x30;
const SERVICE_INTERACTIVE_PROCESS = 0x100;
/** Start types: the two only a driver may have, and the last there is. */
const SERVICE_SYSTEM_START = 0x01;
const SERVICE_DISABLED = 0x04;
const SERVICE_ERROR_CRITICAL = 0x03;
/** Which services by state: running ones, stopped ones, or both. */
const SERVICE_ACTIVE = 1;
const SERVICE_STATE_ALL = 3;
const SERVICE_STOPPED = 1;
/** QueryServiceConfig2's levels: the description, failure actions, preshutdown. */
const SERVICE_CONFIG_DESCRIPTION = 1;
const SERVICE_CONFIG_FAILURE_ACTIONS = 2;
const SERVICE_CONFIG_DELAYED_AUTO_START_INFO = 3;
const SERVICE_CONFIG_PRESHUTDOWN_INFO = 7;
/** How long the manager waits on a service before shutdown, by default. */
const PRESHUTDOWN_TIMEOUT = 180000;

/** The manager's rights, and what each generic right comes to on it. */
const SC_MANAGER_CREATE_SERVICE = 0x0002;
const SC_MANAGER_ENUMERATE_SERVICE = 0x0004;
const SC_MANAGER_LOCK = 0x0008;
const SC_MANAGER_GENERIC = [0x20014, 0x20002, 0x20009, 0xf003f];
/** A service's rights, and its generic mapping. */
const SERVICE_QUERY_CONFIG = 0x0001;
const SERVICE_CHANGE_CONFIG = 0x0002;
const SERVICE_QUERY_STATUS = 0x0004;
const SERVICE_START = 0x0010;
const SERVICE_STOP = 0x0020;
const SERVICE_PAUSE_CONTINUE = 0x0040;
const SERVICE_INTERROGATE = 0x0080;
const SERVICE_USER_DEFINED_CONTROL = 0x0100;
const READ_CONTROL = 0x00020000;
const DELETE = 0x00010000;
const SERVICE_GENERIC = [0x2008d, 0x20002, 0x201f0, 0xf01ff];
/** The controls that need SERVICE_STOP, SERVICE_PAUSE_CONTINUE and SERVICE_INTERROGATE. */
const SERVICE_CONTROL_STOP = 1;
const SERVICE_CONTROL_PAUSE = 2;
const SERVICE_CONTROL_CONTINUE = 3;
const SERVICE_CONTROL_INTERROGATE = 4;

/** The database a program may name: the one there is, and the one there never is. */
const SERVICES_ACTIVE_DATABASE = 'SERVICESACTIVE';
const SERVICES_FAILED_DATABASE = 'SERVICESFAILED';
/** Where the manager keeps every service it knows. */
const SERVICES_PATH = 'SYSTEM\\CurrentControlSet\\Services';
/** A service name stops here, as a key name does. */
const MAX_SERVICE_NAME = 256;
/** A path or a display name a program hands over. */
const MAX_TEXT = 0x8000;
/** ChangeServiceConfig's "leave this one alone". */
const SERVICE_NO_CHANGE = 0xffffffff;
/** The account a service runs as when none is named. */
const LOCAL_SYSTEM = 'LocalSystem';

/** SetServiceObjectSecurity's refusal of what is no descriptor. */
const ERROR_INVALID_SECURITY_DESCR = 1338;
/** A security descriptor's header, and what its control word says. */
const SD_SIZE = 20;
const SECURITY_DESCRIPTOR_REVISION = 1;
const SE_DACL_PRESENT = 0x0004;
const SE_SELF_RELATIVE = 0x8000;
/** The rights SetServiceObjectSecurity needs for the owner and for the DACL. */
const WRITE_DAC = 0x00040000;
const WRITE_OWNER = 0x00080000;

/**
 * A service's security as SetServiceObjectSecurity left it, part by part:
 * each SID and the DACL as bytes, the DACL null for the null DACL.
 *
 * @typedef {{ owner?: Uint8Array, group?: Uint8Array, dacl?: Uint8Array | null }} ServiceSecurity
 */

/**
 * Handles of their own, above the registry's and the kernel's: an SC_HANDLE is
 * never an HKEY, and a program that confuses them gets ERROR_INVALID_HANDLE
 * from both sides rather than somebody else's object.
 */
const HANDLE_BASE = 0x5c000000;

/**
 * A service handle's descriptor, for GetSecurityInfo to answer: the function
 * under this key in the table takes the handle and what is asked for, and
 * answers null for a handle that is not a service's.
 */
export const SERVICE_SECURITY = Symbol('serviceSecurity');
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
 * @property {(bytes: number) => number} [allocate]
 *           What a credential, a performance instance and their kin are
 *           handed out in. Absent, those libraries are not offered.
 * @property {(address: number) => void} [release]
 * @property {(library: string, name: string, args: number[]) => unknown} [system]
 *           Another library's export, called as the program would call it.
 * @property {(path: string) => boolean} [fileExists]
 *           Whether a service's image is on the volume, which a start looks
 *           for first. Absent, every image is taken as there.
 * @property {string} [computerName]  This machine's name, which a program may pass for it.
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

/** @param {string} text @returns {Uint8Array} UTF-16 with its terminator */
const wideBytes = text=>new Uint8Array(Uint16Array.from(`${text}\0`, c=>c.charCodeAt(0)).buffer);

/**
 * Generic rights turned into the specific ones a mapping gives them.
 *
 * @param {number} access @param {number[]} mapping  read, write, execute, all
 */
const mapAccess = (access, mapping)=>{
    let mapped = (access & 0x0fffffff) >>> 0;
    [0x80000000, 0x40000000, 0x20000000, 0x10000000].forEach((bit, at)=>{
        if ((access & bit) !== 0)
        {
            mapped |= mapping[at];
        }
    });
    return mapped >>> 0;
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
     * database lock, and the access it was opened with.
     *
     * @typedef {{ kind: 'manager' | 'service' | 'lock', name?: string, access: number }} Held
     * @type {Map<number, Held>}
     */
    const handles = new Map();
    let next = HANDLE_BASE;

    /** @param {Held} object */
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
    const ansiAt = (address, maxLength)=>((address >>> 0) === 0
        ? null
        : host.readCString(address >>> 0, maxLength));

    /** @param {number} address @param {number} maxLength @returns {string | null} */
    const wideAt = (address, maxLength)=>{
        if ((address >>> 0) === 0 || !host.readMemory)
        {
            return null;
        }
        let text = '';
        for (let at = address >>> 0; text.length < maxLength; at += 2)
        {
            const unit = host.readMemory(at, 2);
            const code = unit[0] | unit[1] << 8;
            if (code === 0)
            {
                break;
            }
            text += String.fromCharCode(code);
        }
        return text;
    };

    /** @param {boolean} wide @returns {(address: number, maxLength: number) => string | null} */
    const reader = wide=>(wide ? wideAt : ansiAt);

    /**
     * A list of names, each terminated and the list by an empty one, as
     * lpDependencies is written; null for none given.
     *
     * @param {boolean} wide @param {number} address @returns {string[] | null}
     */
    const listAt = (wide, address)=>{
        if ((address >>> 0) === 0)
        {
            return null;
        }
        const names = [];
        let at = address >>> 0;
        for (;;)
        {
            const name = /** @type {string} */ (reader(wide)(at, MAX_TEXT));
            if (name === '' || names.length >= 256)
            {
                return names;
            }
            names.push(name);
            at += (name.length + 1) * (wide ? 2 : 1);
        }
    };

    /**
     * A service's dependencies as the manager keeps them: services under
     * DependOnService, groups -- written after a "+" -- under DependOnGroup.
     *
     * @param {number} key @param {string[]} names
     */
    const setDependencies = (key, names)=>{
        /** @param {string[]} list */
        const multi = list=>encodeAnsi(`${list.map(name=>`${name}\0`).join('')}\0`);
        hive.setValue(key, 'DependOnService', REG_MULTI_SZ,
            multi(names.filter(name=>!name.startsWith('+'))));
        hive.setValue(key, 'DependOnGroup', REG_MULTI_SZ,
            multi(names.filter(name=>name.startsWith('+')).map(name=>name.slice(1))));
    };

    /** @param {number} key @returns {string[]} the dependencies, groups after their "+" */
    const dependenciesOf = key=>{
        /** @param {string} name */
        const list = name=>{
            const value = hive.getValue(key, name);
            return value ? decodeAnsi(value.data).split('\0').filter(entry=>entry !== '') : [];
        };
        return [...list('DependOnService'), ...list('DependOnGroup').map(group=>`+${group}`)];
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
     *           objectName?: string | null, group?: string | null }} config
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
        if (config.group)
        {
            hive.setValue(key, 'Group', REG_SZ, sz(config.group));
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

    /**
     * The object a handle names, if it is of the kind wanted and was opened
     * with every right in `needed`; otherwise the error the call fails with.
     *
     * @param {number} handle @param {'manager' | 'service' | 'lock'} kind @param {number} [needed]
     * @returns {Held | number}
     */
    const holding = (handle, kind, needed = 0)=>{
        const object = handles.get(handle >>> 0);
        if (!object || object.kind !== kind)
        {
            return ERROR_INVALID_HANDLE;
        }
        return (object.access & needed) === needed ? object : ERROR_ACCESS_DENIED;
    };

    /** @param {number} handle @param {'manager' | 'service' | 'lock'} kind */
    const held = (handle, kind)=>{
        const object = holding(handle, kind);
        return typeof object === 'number' ? null : object;
    };

    /** @param {number} address @param {number} value */
    const writeDword = (address, value)=>host.writeMemory?.(address >>> 0, dword(value));

    /**
     * The security SetServiceObjectSecurity gave each service by name.
     *
     * @type {Map<string, ServiceSecurity>}
     */
    const security = new Map();

    /**
     * A service's descriptor with the parts asked for: what was set for it,
     * else the manager's default part.
     *
     * @param {string} name @param {number} wanted
     */
    const describe = (name, wanted)=>{
        const kept = security.get(name);
        if (!kept)
        {
            return serviceDescriptor(wanted);
        }
        const fallback = (/** @type {number} */ bit)=>{
            const relative = serviceDescriptor(bit);
            const view = new DataView(relative.buffer);
            const at = view.getUint32(bit === 1 ? 4 : bit === 2 ? 8 : 16, true);
            if (at === 0)
            {
                return undefined;
            }
            const size = bit === 4 ? view.getUint16(at + 2, true) : 8 + 4 * relative[at + 1];
            return relative.slice(at, at + size);
        };
        /** @type {ServiceSecurity} */
        const parts = {};
        if ((wanted & 1) !== 0)
        {
            parts.owner = 'owner' in kept ? kept.owner : fallback(1);
        }
        if ((wanted & 2) !== 0)
        {
            parts.group = 'group' in kept ? kept.group : fallback(2);
        }
        if ((wanted & 4) !== 0)
        {
            parts.dacl = 'dacl' in kept ? kept.dacl : fallback(4);
        }
        return selfRelativeDescriptor(parts).bytes;
    };

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
        /** @type {ServiceSecurity} */
        const parts = { owner: sidAt(part(4)), group: sidAt(part(8)) };
        if ((control & SE_DACL_PRESENT) !== 0)
        {
            const dacl = part(16);
            // An ACL says its own size in its header's third and fourth bytes.
            parts.dacl = dacl === 0 ? null
                : host.readMemory(dacl, readDword(dacl) >>> 16).slice();
        }
        return parts;
    };

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

    /** The services the database holds, each a key with a type, by name. */
    const allServices = ()=>hive.subkeys(servicesKey())
        .slice()
        .sort((a, b)=>a.toUpperCase().localeCompare(b.toUpperCase()))
        .flatMap(name=>{
            const key = serviceKey(name);
            if (!key || hive.getValue(key, 'Type') === null)
            {
                return [];
            }
            const type = numberOf(key, 'Type', SERVICE_WIN32_OWN_PROCESS);
            return [{ name, display: textOf(key, 'DisplayName') ?? name, type,
                group: textOf(key, 'Group') ?? '' }];
        });

    /** @param {boolean} wide @param {string} words */
    const encode = (wide, words)=>(wide ? wideBytes(words) : sz(words));

    /**
     * OpenService once the name is read, in either width.
     * @param {number} manager @param {string | null} name @param {number} access
     */
    const openService = (manager, name, access)=>{
        if (!held(manager, 'manager'))
        {
            return fail(ERROR_INVALID_HANDLE);
        }
        if (name === null)
        {
            return fail(ERROR_INVALID_ADDRESS);
        }
        if (name === '' || !serviceKey(name))
        {
            return fail(name === '' ? ERROR_INVALID_NAME : ERROR_SERVICE_DOES_NOT_EXIST);
        }
        return open({ kind: 'service', name, access: mapAccess(access, SERVICE_GENERIC) });
    };

    /**
     * OpenSCManager: this machine's active database, and nothing else.
     *
     * @param {string | null} machine @param {string | null} database @param {number} access
     */
    const openManager = (machine, database, access)=>{
        const local = machine === null || machine === ''
            || machine.replace(/^\\\\/, '').toUpperCase() === (host.computerName ?? '').toUpperCase();
        if (!local)
        {
            return fail(RPC_S_SERVER_UNAVAILABLE);
        }
        if (database !== null && database.toUpperCase() !== SERVICES_ACTIVE_DATABASE)
        {
            return fail(database.toUpperCase() === SERVICES_FAILED_DATABASE
                ? ERROR_DATABASE_DOES_NOT_EXIST : ERROR_INVALID_NAME);
        }
        host.setLastError?.(ERROR_SUCCESS);
        return open({ kind: 'manager', access: mapAccess(access, SC_MANAGER_GENERIC) });
    };

    /**
     * Whether a type, start and error control make a service the manager
     * would create: a driver or a program, an interactive program only as
     * the local system, a boot or system start only for a driver.
     *
     * @param {number} type @param {number} start @param {number} errorControl
     * @param {string | null} account
     */
    const validConfig = (type, start, errorControl, account)=>{
        const base = type & ~SERVICE_INTERACTIVE_PROCESS;
        const driver = base === SERVICE_KERNEL_DRIVER || base === SERVICE_FILE_SYSTEM_DRIVER;
        const program = base === SERVICE_WIN32_OWN_PROCESS || base === SERVICE_WIN32_SHARE_PROCESS;
        if (!driver && !program)
        {
            return false;
        }
        // The local system may be named on this machine, as .\LocalSystem.
        const system = account === null
            || account.replace(/^\.\\/, '').toUpperCase() === LOCAL_SYSTEM.toUpperCase();
        if ((type & SERVICE_INTERACTIVE_PROCESS) !== 0 && (driver || !system))
        {
            return false;
        }
        return start <= SERVICE_DISABLED && (driver || start > SERVICE_SYSTEM_START)
            && errorControl <= SERVICE_ERROR_CRITICAL;
    };

    /** A service whose name or display name is either text, but `self`. @param {string} text @param {string} [self] */
    const nameTaken = (text, self)=>allServices().some(entry=>
        entry.name.toUpperCase() !== self?.toUpperCase()
        && (entry.name.toUpperCase() === text.toUpperCase()
            || entry.display.toUpperCase() === text.toUpperCase()));

    /**
     * CreateService in either width.
     *
     * @param {boolean} wide
     */
    const createService = wide=>({
        argBytes: 52,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [manager, nameAddress, displayAddress, access, type,
            start, errorControl, pathAddress, groupAddress, , dependencies, startNameAddress])=>{
            const read = reader(wide);
            const owner = holding(manager, 'manager');
            if (typeof owner === 'number')
            {
                return fail(owner);
            }
            const name = read(nameAddress, MAX_SERVICE_NAME);
            const path = read(pathAddress, MAX_TEXT);
            if (name === null || path === null)
            {
                return fail(ERROR_INVALID_ADDRESS);
            }
            if ((owner.access & SC_MANAGER_CREATE_SERVICE) === 0)
            {
                return fail(ERROR_ACCESS_DENIED);
            }
            if (name === '' || name.includes('/') || name.includes('\\'))
            {
                return fail(ERROR_INVALID_NAME);
            }
            const account = read(startNameAddress, MAX_TEXT);
            if (path === '' || !validConfig(type >>> 0, start >>> 0, errorControl >>> 0, account))
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            if (serviceKey(name))
            {
                return fail([...marked].some(other=>other.toUpperCase() === name.toUpperCase())
                    ? ERROR_SERVICE_MARKED_FOR_DELETE : ERROR_SERVICE_EXISTS);
            }
            const display = read(displayAddress, MAX_TEXT) || null;
            if (nameTaken(name) || (display !== null && nameTaken(display)))
            {
                return fail(ERROR_DUPLICATE_SERVICE_NAME);
            }
            configure(hive.create(servicesKey(), name).key, {
                type: type >>> 0,
                start: start >>> 0,
                errorControl: errorControl >>> 0,
                imagePath: path,
                displayName: display,
                group: read(groupAddress, MAX_TEXT),
                // A service with no account named runs as the system.
                objectName: account || LOCAL_SYSTEM,
            });
            const depends = listAt(wide, dependencies);
            if (depends)
            {
                setDependencies(/** @type {number} */ (serviceKey(name)), depends);
            }
            return open({ kind: 'service', name, access: mapAccess(access, SERVICE_GENERIC) });
        },
    });

    /** @param {boolean} wide */
    const changeConfig = wide=>({
        argBytes: 44,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [service, type, start, errorControl, pathAddress,
            groupAddress, , dependencies, startNameAddress, , displayAddress])=>{
            const read = reader(wide);
            const object = holding(service, 'service', SERVICE_CHANGE_CONFIG);
            if (typeof object === 'number')
            {
                return fail(object);
            }
            const key = serviceKey(/** @type {string} */ (object.name));
            if (!key)
            {
                return fail(ERROR_INVALID_HANDLE);
            }
            /** @param {number} value @param {string} name @param {number} fallback */
            const merged = (value, name, fallback)=>((value >>> 0) === SERVICE_NO_CHANGE
                ? numberOf(key, name, fallback) : value >>> 0);
            const account = read(startNameAddress, MAX_TEXT) ?? textOf(key, 'ObjectName');
            if (!validConfig(merged(type, 'Type', SERVICE_WIN32_OWN_PROCESS),
                merged(start, 'Start', 3), merged(errorControl, 'ErrorControl', 1), account))
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            const display = read(displayAddress, MAX_TEXT);
            if (display && nameTaken(display, object.name))
            {
                return fail(ERROR_DUPLICATE_SERVICE_NAME);
            }
            configure(key, {
                type: type >>> 0,
                start: start >>> 0,
                errorControl: errorControl >>> 0,
                imagePath: read(pathAddress, MAX_TEXT),
                displayName: display,
                group: read(groupAddress, MAX_TEXT),
                objectName: read(startNameAddress, MAX_TEXT),
            });
            const depends = listAt(wide, dependencies);
            if (depends)
            {
                setDependencies(key, depends);
            }
            return 1;
        },
    });

    /**
     * StartService in either width. A disabled service is refused as such,
     * and one whose image is not on the volume as a file not found; any other
     * has no process here to run in, and times out as a service that never
     * reported back would.
     *
     * @param {boolean} wide
     */
    const startService = wide=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([service])=>{
            const object = holding(service, 'service', SERVICE_START);
            if (typeof object === 'number')
            {
                return fail(object);
            }
            const name = /** @type {string} */ (object.name);
            const key = serviceKey(name);
            if (!key || marked.has(name))
            {
                return fail(ERROR_SERVICE_MARKED_FOR_DELETE);
            }
            if (numberOf(key, 'Start', 3) === SERVICE_DISABLED)
            {
                return fail(ERROR_SERVICE_DISABLED);
            }
            const image = imageOf(textOf(key, 'ImagePath') ?? '');
            if (host.fileExists && image !== '' && !host.fileExists(image))
            {
                return fail(ERROR_FILE_NOT_FOUND);
            }
            host.divergence?.(wide ? 'StartServiceW' : 'StartServiceA',
                `${name}: no process hosts a service here; reported as timed out`);
            return fail(ERROR_SERVICE_REQUEST_TIMEOUT);
        },
    });

    /**
     * The file a service's command line runs: the quoted first word, or the
     * text up to the first ".exe" and its space.
     *
     * @param {string} line
     */
    const imageOf = line=>{
        const text = line.trim();
        if (text.startsWith('"'))
        {
            const end = text.indexOf('"', 1);
            return end < 0 ? text.slice(1) : text.slice(1, end);
        }
        const exe = text.toLowerCase().indexOf('.exe');
        return exe < 0 ? text.split(' ')[0] : text.slice(0, exe + 4);
    };

    /**
     * A service's status as SERVICE_STATUS, or SERVICE_STATUS_PROCESS with
     * the process and flags after it: stopped, never having started, with the
     * type its key was created with.
     *
     * @param {string} name @param {boolean} process
     */
    const statusOf = (name, process)=>{
        const key = serviceKey(name);
        const bytes = new Uint8Array(process ? SERVICE_STATUS_PROCESS_SIZE : SERVICE_STATUS_SIZE);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, key ? numberOf(key, 'Type', SERVICE_WIN32_OWN_PROCESS)
            : SERVICE_WIN32_OWN_PROCESS, true);
        view.setUint32(4, SERVICE_STOPPED, true);
        view.setUint32(12, ERROR_SERVICE_NEVER_STARTED, true);
        return bytes;
    };

    /**
     * QueryServiceConfig: nine fields, then the strings its pointers name, in
     * the caller's buffer. Every string is there, empty where the key holds
     * none -- a caller reads them without testing for NULL -- and the display
     * name is the service's own name when no other was given.
     *
     * @param {boolean} wide
     */
    const queryConfig = wide=>({
        argBytes: 16,
        handler: (/** @type {number[]} */ [service, buffer, size, needed])=>{
            const HEADER = 36;
            const object = holding(service, 'service', SERVICE_QUERY_CONFIG);
            if (typeof object === 'number')
            {
                return fail(object);
            }
            const name = /** @type {string} */ (object.name);
            const key = serviceKey(name);
            if (!key)
            {
                return fail(ERROR_INVALID_HANDLE);
            }
            if ((needed >>> 0) === 0)
            {
                return fail(ERROR_INVALID_ADDRESS);
            }
            // Path, group, dependencies (each terminated, then an empty one), account,
            // display name.
            const strings = [
                encode(wide, textOf(key, 'ImagePath') ?? ''),
                encode(wide, textOf(key, 'Group') ?? ''),
                // An empty list is still terminated twice.
                Uint8Array.from([...dependenciesOf(key).flatMap(entry=>[...encode(wide, entry)]),
                    ...new Uint8Array(dependenciesOf(key).length === 0 ? (wide ? 4 : 2)
                        : (wide ? 2 : 1))]),
                encode(wide, textOf(key, 'ObjectName') ?? ''),
                encode(wide, textOf(key, 'DisplayName') ?? name),
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
     * QueryServiceConfig2: the description -- a pointer, NULL when there is
     * none, and the text after it -- the failure actions, none, or the
     * preshutdown timeout. The A form asks for room for the description as
     * if it were wide, as Windows' does.
     *
     * @param {boolean} wide
     */
    const queryConfig2 = wide=>({
        argBytes: 20,
        /** @param {number[]} args */
        handler: ([service, level, buffer, size, needed])=>{
            const kind = level >>> 0;
            if (kind !== SERVICE_CONFIG_DESCRIPTION && kind !== SERVICE_CONFIG_FAILURE_ACTIONS
                && kind !== SERVICE_CONFIG_PRESHUTDOWN_INFO
                && kind !== SERVICE_CONFIG_DELAYED_AUTO_START_INFO)
            {
                return fail(ERROR_INVALID_LEVEL);
            }
            const object = holding(service, 'service', SERVICE_QUERY_CONFIG);
            if (typeof object === 'number')
            {
                return fail(object);
            }
            const key = serviceKey(/** @type {string} */ (object.name));
            if (!key)
            {
                return fail(ERROR_INVALID_HANDLE);
            }
            if ((needed >>> 0) === 0)
            {
                return fail(ERROR_INVALID_ADDRESS);
            }
            /** @type {Uint8Array} */
            let out;
            let total;
            if (kind === SERVICE_CONFIG_DESCRIPTION)
            {
                const description = textOf(key, 'Description');
                const text = description === null ? null : encode(wide, description);
                total = 4 + (description === null ? 0 : (description.length + 1) * 2);
                out = new Uint8Array(4 + (text?.length ?? 0));
                if (text)
                {
                    new DataView(out.buffer).setUint32(0, (buffer >>> 0) + 4, true);
                    out.set(text, 4);
                }
            }
            else if (kind === SERVICE_CONFIG_PRESHUTDOWN_INFO)
            {
                out = dword(numberOf(key, 'PreshutdownTimeout', PRESHUTDOWN_TIMEOUT));
                total = 4;
            }
            else if (kind === SERVICE_CONFIG_DELAYED_AUTO_START_INFO)
            {
                out = dword(numberOf(key, 'DelayedAutostart', 0));
                total = 4;
            }
            else
            {
                // SERVICE_FAILURE_ACTIONS: no reset period, message, command or action.
                out = new Uint8Array(20);
                total = 20;
            }
            writeDword(needed, total);
            if ((buffer >>> 0) === 0 || (size >>> 0) < total)
            {
                return fail((buffer >>> 0) === 0 && (size >>> 0) !== 0 ? ERROR_INVALID_ADDRESS
                    : ERROR_INSUFFICIENT_BUFFER);
            }
            host.writeMemory?.(buffer >>> 0, out);
            return 1;
        },
    });

    /**
     * ChangeServiceConfig2: a description -- an empty one removes it, a NULL
     * one leaves it -- or the preshutdown timeout; failure actions are taken
     * and kept nowhere, nothing here restarting a service that failed.
     *
     * @param {boolean} wide
     */
    const changeConfig2 = wide=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([service, level, info])=>{
            const object = holding(service, 'service', SERVICE_CHANGE_CONFIG);
            if (typeof object === 'number')
            {
                return fail(object);
            }
            const key = serviceKey(/** @type {string} */ (object.name));
            if (!key)
            {
                return fail(ERROR_INVALID_HANDLE);
            }
            if ((info >>> 0) === 0)
            {
                return fail(ERROR_INVALID_ADDRESS);
            }
            switch (level >>> 0)
            {
                case SERVICE_CONFIG_DESCRIPTION:
                {
                    const description = reader(wide)(readDword(info), MAX_TEXT);
                    if (description === '')
                    {
                        hive.deleteValue(key, 'Description');
                    }
                    else if (description !== null)
                    {
                        hive.setValue(key, 'Description', REG_SZ, sz(description));
                    }
                    return 1;
                }
                case SERVICE_CONFIG_PRESHUTDOWN_INFO:
                    hive.setValue(key, 'PreshutdownTimeout', REG_DWORD, dword(readDword(info)));
                    return 1;
                case SERVICE_CONFIG_DELAYED_AUTO_START_INFO:
                {
                    // A BOOL, and only TRUE or FALSE.
                    const delayed = readDword(info);
                    if (delayed > 1)
                    {
                        return fail(ERROR_INVALID_PARAMETER);
                    }
                    hive.setValue(key, 'DelayedAutostart', REG_DWORD, dword(delayed));
                    return 1;
                }
                case SERVICE_CONFIG_FAILURE_ACTIONS:
                    return 1;
                default:
                    return fail(ERROR_INVALID_LEVEL);
            }
        },
    });

    /**
     * GetServiceDisplayName and GetServiceKeyName: one name of a service
     * found by the other. Their sizes are in characters, and the two widths
     * disagree on them as Windows' do: the A form asks for twice the length
     * and leaves the size alone on a fit, the W form asks for the length and
     * answers it; a W size too small to hold a terminator is answered two.
     * A name not found empties a buffer that has room.
     *
     * @param {boolean} wide @param {boolean} byDisplay  Find by the display name.
     */
    const lookupName = (wide, byDisplay)=>({
        argBytes: 16,
        /** @param {number[]} args */
        handler: ([manager, nameAddress, buffer, sizeAddress])=>{
            if (!held(manager, 'manager'))
            {
                return fail(ERROR_INVALID_HANDLE);
            }
            if ((sizeAddress >>> 0) === 0)
            {
                return fail(ERROR_INVALID_ADDRESS);
            }
            const size = readDword(sizeAddress);
            // The A form answers a size of one -- the terminator of the empty
            // name it did not write -- whenever it has no buffer to write to.
            if (!wide && ((buffer >>> 0) === 0 || size === 0))
            {
                writeDword(sizeAddress, 1);
            }
            const asked = reader(wide)(nameAddress, MAX_TEXT);
            if (asked === null)
            {
                return fail(ERROR_INVALID_ADDRESS);
            }
            const entry = allServices().find(service=>(byDisplay ? service.display : service.name)
                .toUpperCase() === asked.toUpperCase());
            if (!entry)
            {
                if (wide && size < 2)
                {
                    writeDword(sizeAddress, 2);
                }
                else if ((buffer >>> 0) !== 0 && size !== 0)
                {
                    host.writeMemory?.(buffer >>> 0, new Uint8Array(wide ? 2 : 1));
                }
                return fail(ERROR_SERVICE_DOES_NOT_EXIST);
            }
            const answer = byDisplay ? entry.name : entry.display;
            if ((buffer >>> 0) === 0 || size <= answer.length)
            {
                if ((buffer >>> 0) !== 0 && size > 0)
                {
                    host.writeMemory?.(buffer >>> 0, new Uint8Array(wide ? 2 : 1));
                }
                writeDword(sizeAddress, wide ? answer.length : answer.length * 2);
                return fail(ERROR_INSUFFICIENT_BUFFER);
            }
            host.writeMemory?.(buffer >>> 0, encode(wide, answer));
            if (wide)
            {
                writeDword(sizeAddress, answer.length);
            }
            return 1;
        },
    });

    /**
     * EnumServicesStatusEx and EnumServicesStatus, A and W: the services the
     * database holds, in name order, each with its type and -- no service
     * ever runs here -- stopped. As many as fit are written, their names after
     * the records; with room for fewer than all, FALSE and ERROR_MORE_DATA,
     * the bytes the rest need and the resume handle where the next call
     * takes up.
     *
     * @param {boolean} wide @param {boolean} extended
     */
    const enumServices = (wide, extended)=>({
        argBytes: extended ? 40 : 32,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ args)=>{
            const [manager, level, typeMask, stateMask, buffer, size, needed, returned, resume,
                groupPointer] = extended ? args : [args[0], SC_ENUM_PROCESS_INFO, ...args.slice(1)];
            if (extended && (level >>> 0) !== SC_ENUM_PROCESS_INFO)
            {
                return fail(ERROR_INVALID_LEVEL);
            }
            const owner = holding(manager, 'manager');
            if (typeof owner === 'number')
            {
                return fail(owner);
            }
            if ((needed >>> 0) === 0 || (returned >>> 0) === 0)
            {
                return fail(ERROR_INVALID_ADDRESS);
            }
            const types = typeMask >>> 0;
            const states = stateMask >>> 0;
            if ((types & (SERVICE_DRIVER | SERVICE_WIN32)) === 0
                || (types & ~(SERVICE_DRIVER | SERVICE_WIN32 | SERVICE_INTERACTIVE_PROCESS)) !== 0
                || states === 0 || states > SERVICE_STATE_ALL)
            {
                writeDword(needed, 0);
                writeDword(returned, 0);
                return fail(ERROR_INVALID_PARAMETER);
            }
            writeDword(needed, 0);
            writeDword(returned, 0);
            if ((owner.access & SC_MANAGER_ENUMERATE_SERVICE) === 0)
            {
                return fail(ERROR_ACCESS_DENIED);
            }
            const group = extended && (groupPointer >>> 0) !== 0
                ? reader(wide)(groupPointer, MAX_SERVICE_NAME) : null;
            // A group no service is in is not a group.
            if (group !== null && group !== '' && !allServices().some(entry=>
                entry.group.toUpperCase() === group.toUpperCase()))
            {
                return fail(ERROR_SERVICE_DOES_NOT_EXIST);
            }
            const all = (states & ~SERVICE_ACTIVE) === 0 ? [] : allServices().filter(entry=>
                (entry.type & types) !== 0
                && (group === null || entry.group.toUpperCase() === group.toUpperCase()));
            const record = extended ? ENUM_SERVICE_STATUS_PROCESS_SIZE : ENUM_SERVICE_STATUS_SIZE;
            const first = (resume >>> 0) === 0 ? 0 : Math.min(readDword(resume), all.length);
            const rest = all.slice(first);
            // The A form asks for as much as the W form does: the manager
            // answers in UTF-16, and the A side converts in the room it got.
            const costOf = (/** @type {{ name: string, display: string }} */ entry)=>
                record + (entry.name.length + entry.display.length + 2) * 2;
            let room = (buffer >>> 0) === 0 ? 0 : size >>> 0;
            let fitting = 0;
            while (fitting < rest.length && costOf(rest[fitting]) <= room)
            {
                room -= costOf(rest[fitting]);
                fitting++;
            }
            const base = buffer >>> 0;
            let strings = base + fitting * record;
            rest.slice(0, fitting).forEach((entry, at)=>{
                const out = new Uint8Array(record);
                const view = new DataView(out.buffer);
                const name = encode(wide, entry.name);
                const display = encode(wide, entry.display);
                host.writeMemory?.(strings, name);
                view.setUint32(0, strings, true);
                strings += name.length;
                host.writeMemory?.(strings, display);
                view.setUint32(4, strings, true);
                strings += display.length;
                out.set(statusOf(entry.name, extended), 8);
                host.writeMemory?.(base + at * record, out);
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

    /** @param {boolean} wide */
    const openManagerIn = wide=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([machine, database, access])=>openManager(reader(wide)(machine, MAX_TEXT),
            reader(wide)(database, MAX_TEXT), access >>> 0),
    });

    /** @param {boolean} wide */
    const openServiceIn = wide=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([manager, nameAddress, access])=>
            openService(manager, reader(wide)(nameAddress, MAX_SERVICE_NAME), access >>> 0),
    });

    const extras = host.allocate ? {
        ...createCredFunctions({
            readMemory: /** @type {any} */ (host.readMemory),
            writeMemory: /** @type {any} */ (host.writeMemory),
            readCString: host.readCString,
            setLastError: host.setLastError ?? (()=>{}),
            allocate: host.allocate,
            release: host.release,
        }),
        ...createPerfFunctions({
            readMemory: /** @type {any} */ (host.readMemory),
            writeMemory: /** @type {any} */ (host.writeMemory),
            allocate: host.allocate,
            release: host.release,
            setLastError: host.setLastError,
            system: host.system,
        }),
    } : {};

    return {
        ...extras,

        /** @param {number} handle @param {number} wanted */
        [SERVICE_SECURITY]: (handle, wanted)=>(held(handle, 'service')
            ? serviceDescriptor(wanted) : null),

        /**
         * SC_HANDLE OpenSCManagerA/W(LPCTSTR lpMachineName, LPCTSTR lpDatabaseName,
         *                            DWORD dwDesiredAccess)
         *
         * Any access, because the one user is the administrator; the handle
         * keeps what was asked for.
         */
        OpenSCManagerA: openManagerIn(false),
        OpenSCManagerW: openManagerIn(true),

        /**
         * BOOL EnumServicesStatusEx(SC_HANDLE, SC_ENUM_TYPE InfoLevel,
         *   DWORD dwServiceType, DWORD dwServiceState, LPBYTE lpServices,
         *   DWORD cbBufSize, LPDWORD pcbBytesNeeded, LPDWORD lpServicesReturned,
         *   LPDWORD lpResumeHandle, LPCTSTR pszGroupName)
         * BOOL EnumServicesStatus(SC_HANDLE, DWORD dwServiceType, DWORD dwServiceState,
         *   LPENUM_SERVICE_STATUS, DWORD, LPDWORD, LPDWORD, LPDWORD lpResumeHandle)
         */
        EnumServicesStatusExA: enumServices(false, true),
        EnumServicesStatusExW: enumServices(true, true),
        EnumServicesStatusA: enumServices(false, false),
        EnumServicesStatusW: enumServices(true, false),

        /** SC_HANDLE OpenService(SC_HANDLE hSCManager, LPCTSTR lpServiceName, DWORD dwDesiredAccess) */
        OpenServiceA: openServiceIn(false),
        OpenServiceW: openServiceIn(true),

        /**
         * SC_HANDLE CreateService(SC_HANDLE hSCManager, LPCTSTR lpServiceName,
         *   LPCTSTR lpDisplayName, DWORD dwDesiredAccess, DWORD dwServiceType,
         *   DWORD dwStartType, DWORD dwErrorControl, LPCTSTR lpBinaryPathName,
         *   LPCTSTR lpLoadOrderGroup, LPDWORD lpdwTagId, LPCTSTR lpDependencies,
         *   LPCTSTR lpServiceStartName, LPCTSTR lpPassword)
         */
        CreateServiceA: createService(false),
        CreateServiceW: createService(true),

        /**
         * BOOL ChangeServiceConfig(SC_HANDLE hService, DWORD dwServiceType,
         *   DWORD dwStartType, DWORD dwErrorControl, LPCTSTR lpBinaryPathName,
         *   LPCTSTR lpLoadOrderGroup, LPDWORD lpdwTagId, LPCTSTR lpDependencies,
         *   LPCTSTR lpServiceStartName, LPCTSTR lpPassword, LPCTSTR lpDisplayName)
         */
        ChangeServiceConfigA: changeConfig(false),
        ChangeServiceConfigW: changeConfig(true),

        /**
         * BOOL QueryServiceConfig2(SC_HANDLE, DWORD dwInfoLevel, LPBYTE lpBuffer,
         *   DWORD cbBufSize, LPDWORD pcbBytesNeeded)
         * BOOL ChangeServiceConfig2(SC_HANDLE, DWORD dwInfoLevel, LPVOID lpInfo)
         */
        QueryServiceConfig2A: queryConfig2(false),
        QueryServiceConfig2W: queryConfig2(true),
        ChangeServiceConfig2A: changeConfig2(false),
        ChangeServiceConfig2W: changeConfig2(true),

        /** BOOL StartService(SC_HANDLE hService, DWORD dwNumServiceArgs, LPCTSTR *lpServiceArgVectors) */
        StartServiceA: startService(false),
        StartServiceW: startService(true),

        /**
         * BOOL ControlService(SC_HANDLE hService, DWORD dwControl,
         *                     LPSERVICE_STATUS lpServiceStatus)
         *
         * No service ever runs, so every one is stopped, and a stopped
         * service refuses a control -- after the right to send it is checked,
         * with its status written back.
         */
        ControlService: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([service, control, status])=>{
                const rights = new Map([[SERVICE_CONTROL_STOP, SERVICE_STOP],
                    [SERVICE_CONTROL_PAUSE, SERVICE_PAUSE_CONTINUE],
                    [SERVICE_CONTROL_CONTINUE, SERVICE_PAUSE_CONTINUE],
                    [SERVICE_CONTROL_INTERROGATE, SERVICE_INTERROGATE]]);
                const needed = rights.get(control >>> 0) ?? SERVICE_USER_DEFINED_CONTROL;
                const object = holding(service, 'service', needed);
                if (typeof object === 'number')
                {
                    return fail(object);
                }
                if ((status >>> 0) !== 0)
                {
                    host.writeMemory?.(status >>> 0,
                        statusOf(/** @type {string} */ (object.name), false));
                }
                return fail(ERROR_SERVICE_NOT_ACTIVE);
            },
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
                const object = handles.get(service >>> 0);
                if (!object || object.kind !== 'service')
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if ((status >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_ADDRESS);
                }
                if ((object.access & SERVICE_QUERY_STATUS) === 0)
                {
                    return fail(ERROR_ACCESS_DENIED);
                }
                host.writeMemory?.(status >>> 0, statusOf(/** @type {string} */ (object.name),
                    false));
                return 1;
            },
        },

        /**
         * BOOL QueryServiceStatusEx(SC_HANDLE hService, SC_STATUS_TYPE InfoLevel,
         *   LPBYTE lpBuffer, DWORD cbBufSize, LPDWORD pcbBytesNeeded)
         *
         * SERVICE_STATUS_PROCESS: no process, no flags. The level and the size
         * are checked before the handle.
         */
        QueryServiceStatusEx: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([service, level, buffer, size, needed])=>{
                if ((level >>> 0) !== SC_STATUS_PROCESS_INFO)
                {
                    return fail(ERROR_INVALID_LEVEL);
                }
                if ((size >>> 0) < SERVICE_STATUS_PROCESS_SIZE)
                {
                    if ((needed >>> 0) === 0)
                    {
                        return fail(ERROR_INVALID_ADDRESS);
                    }
                    writeDword(needed, SERVICE_STATUS_PROCESS_SIZE);
                    return fail(ERROR_INSUFFICIENT_BUFFER);
                }
                const object = holding(service, 'service', SERVICE_QUERY_STATUS);
                if (typeof object === 'number')
                {
                    return fail(object);
                }
                if ((needed >>> 0) === 0 || (buffer >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_ADDRESS);
                }
                host.writeMemory?.(buffer >>> 0, statusOf(/** @type {string} */ (object.name),
                    true));
                return 1;
            },
        },

        /**
         * BOOL QueryServiceObjectSecurity(SC_HANDLE, SECURITY_INFORMATION,
         *   PSECURITY_DESCRIPTOR, DWORD cbBufSize, LPDWORD pcbBytesNeeded)
         *
         * A self-relative descriptor of the parts asked for: the system owns
         * every service and its group, and its DACL lets the administrators
         * and the system do anything and everyone read.
         */
        QueryServiceObjectSecurity: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([service, wanted, buffer, size, needed])=>{
                const object = holding(service, 'service', READ_CONTROL);
                if (typeof object === 'number')
                {
                    return fail(object);
                }
                const bytes = describe(/** @type {string} */ (object.name), wanted >>> 0);
                if ((needed >>> 0) !== 0)
                {
                    writeDword(needed, bytes.length);
                }
                if ((buffer >>> 0) === 0 || (size >>> 0) < bytes.length)
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
         * self-relative -- and kept for the service, so that
         * QueryServiceObjectSecurity reads them back: what an installer that
         * lets ordinary users start its service writes.
         */
        SetServiceObjectSecurity: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([service, information, descriptor])=>{
                const asked = information >>> 0;
                const object = holding(service, 'service',
                    ((asked & 4) !== 0 ? WRITE_DAC : 0) | ((asked & 3) !== 0 ? WRITE_OWNER : 0));
                if (typeof object === 'number')
                {
                    return fail(object);
                }
                const read = descriptorParts(descriptor >>> 0);
                if (!read)
                {
                    return fail(ERROR_INVALID_SECURITY_DESCR);
                }
                const name = /** @type {string} */ (object.name);
                const kept = { ...security.get(name) };
                if ((asked & 1) !== 0)
                {
                    kept.owner = read.owner;
                }
                if ((asked & 2) !== 0)
                {
                    kept.group = read.group;
                }
                if ((asked & 4) !== 0)
                {
                    kept.dacl = read.dacl;
                }
                security.set(name, kept);
                return 1;
            },
        },

        /**
         * DWORD NotifyServiceStatusChangeW(SC_HANDLE hService, DWORD dwNotifyMask,
         *   PSERVICE_NOTIFYW pNotifyBuffer)
         *
         * Nothing here changes a service's state, so a notification has
         * nothing to wait for; it is refused rather than accepted and never
         * delivered.
         */
        NotifyServiceStatusChangeW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([service])=>{
                const object = holding(service, 'service', SERVICE_QUERY_STATUS);
                if (typeof object === 'number')
                {
                    return object;
                }
                host.divergence?.('NotifyServiceStatusChangeW',
                    'no service changes state here; nothing to notify');
                return ERROR_INVALID_PARAMETER;
            },
        },

        QueryServiceConfigA: queryConfig(false),
        QueryServiceConfigW: queryConfig(true),

        /** BOOL GetServiceDisplayName(SC_HANDLE, LPCTSTR lpServiceName, LPTSTR, LPDWORD) */
        GetServiceDisplayNameA: lookupName(false, false),
        GetServiceDisplayNameW: lookupName(true, false),
        /** BOOL GetServiceKeyName(SC_HANDLE, LPCTSTR lpDisplayName, LPTSTR, LPDWORD) */
        GetServiceKeyNameA: lookupName(false, true),
        GetServiceKeyNameW: lookupName(true, true),

        /** SC_LOCK LockServiceDatabase(SC_HANDLE hSCManager) */
        LockServiceDatabase: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([manager])=>{
                const owner = holding(manager, 'manager', SC_MANAGER_LOCK);
                return typeof owner === 'number' ? fail(owner)
                    : open({ kind: 'lock', access: 0 });
            },
        },
        /** BOOL UnlockServiceDatabase(SC_LOCK ScLock) */
        UnlockServiceDatabase: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([lock])=>(held(lock, 'lock') && handles.delete(lock >>> 0)
                ? 1
                : fail(ERROR_INVALID_SERVICE_LOCK)),
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
                const object = holding(service, 'service', DELETE);
                if (typeof object === 'number')
                {
                    return fail(object);
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
         * BOOL StartServiceCtrlDispatcher(const SERVICE_TABLE_ENTRY *lpServiceStartTable)
         *
         * Connects the process to the manager that started it. A process the
         * manager did not start has nothing to connect to: FALSE, and
         * ERROR_FAILED_SERVICE_CONTROLLER_CONNECT.
         */
        StartServiceCtrlDispatcherA: {
            argBytes: 4,
            handler: ()=>fail(ERROR_FAILED_SERVICE_CONTROLLER_CONNECT),
        },
        StartServiceCtrlDispatcherW: {
            argBytes: 4,
            handler: ()=>fail(ERROR_FAILED_SERVICE_CONTROLLER_CONNECT),
        },
        /**
         * SERVICE_STATUS_HANDLE RegisterServiceCtrlHandler(LPCTSTR lpServiceName,
         *   LPHANDLER_FUNCTION lpHandlerProc)
         * SERVICE_STATUS_HANDLE RegisterServiceCtrlHandlerEx(LPCTSTR, LPHANDLER_FUNCTION_EX,
         *   LPVOID lpContext)
         *
         * Names a handler for a service of this process. The process runs none,
         * so the name is not one of its services: NULL, ERROR_SERVICE_NOT_IN_EXE.
         */
        RegisterServiceCtrlHandlerA: { argBytes: 8, handler: ()=>fail(ERROR_SERVICE_NOT_IN_EXE) },
        RegisterServiceCtrlHandlerW: { argBytes: 8, handler: ()=>fail(ERROR_SERVICE_NOT_IN_EXE) },
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

/**
 * The descriptor every service has here, with the parts asked for: owned by
 * the system, its group the system's; full control to the administrators and
 * the system, read to everyone.
 *
 * @param {number} wanted
 */
function serviceDescriptor(wanted){
    const system = sidBytes(WELL_KNOWN_SIDS.system);
    return selfRelativeDescriptor({
        ...(wanted & 1) !== 0 ? { owner: system } : {},
        ...(wanted & 2) !== 0 ? { group: system } : {},
        ...(wanted & 4) !== 0 ? { dacl: aclBytes([
            aceBytes(0, 0, SERVICE_GENERIC[3], sidBytes(WELL_KNOWN_SIDS.administrators)),
            aceBytes(0, 0, SERVICE_GENERIC[3], system),
            aceBytes(0, 0, SERVICE_GENERIC[0], sidBytes(WELL_KNOWN_SIDS.everyone)),
        ]) } : {},
    }).bytes;
}
