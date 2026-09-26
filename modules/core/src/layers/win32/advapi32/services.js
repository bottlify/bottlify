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
import { encodeAnsi } from '../kernel32/locale.js';

const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_NAME = 123;
const ERROR_SERVICE_REQUEST_TIMEOUT = 1053;
const ERROR_SERVICE_DOES_NOT_EXIST = 1060;
const ERROR_SERVICE_NOT_ACTIVE = 1062;
const ERROR_SERVICE_EXISTS = 1073;

/** Where the manager keeps every service it knows. */
const SERVICES_PATH = 'SYSTEM\\CurrentControlSet\\Services';

/** A service name stops here, as a key name does. */
const MAX_SERVICE_NAME = 256;
/** A path or a display name a program hands over. */
const MAX_TEXT = 0x8000;

/** ChangeServiceConfig's "leave this one alone". */
const SERVICE_NO_CHANGE = 0xffffffff;

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
 * @property {ReturnType<typeof import('./registry.js').createHive>} hive
 * @property {(code: number) => void} [setLastError]
 * @property {(api: string, detail: string) => void} [divergence]
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

    /** The key every service lives under, made if this is the first ask. */
    const servicesKey = ()=>hive.create(
        /** @type {any} */ (hive.root(HKEY_LOCAL_MACHINE)), SERVICES_PATH).key;

    /** @param {string} name */
    const serviceKey = name=>hive.open(servicesKey(), name);

    /**
     * The values the manager keeps for a service. Only the ones given are
     * written, which is what lets ChangeServiceConfig leave the rest alone.
     *
     * @param {import('./registry.js').RegistryKey} key
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

    /** @param {number} handle @param {'manager' | 'service' | 'lock'} kind */
    const held = (handle, kind)=>{
        const object = handles.get(handle >>> 0);
        return object && object.kind === kind ? object : null;
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

        /** SC_HANDLE OpenServiceA(SC_HANDLE hSCManager, LPCSTR lpServiceName, DWORD dwDesiredAccess) */
        OpenServiceA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([manager, nameAddress])=>{
                if (!held(manager, 'manager'))
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const name = text(nameAddress, MAX_SERVICE_NAME);
                if (!name)
                {
                    return fail(ERROR_INVALID_NAME);
                }
                if (!serviceKey(name))
                {
                    return fail(ERROR_SERVICE_DOES_NOT_EXIST);
                }
                return open({ kind: 'service', name });
            },
        },

        /**
         * SC_HANDLE CreateServiceA(SC_HANDLE hSCManager, LPCSTR lpServiceName,
         *   LPCSTR lpDisplayName, DWORD dwDesiredAccess, DWORD dwServiceType,
         *   DWORD dwStartType, DWORD dwErrorControl, LPCSTR lpBinaryPathName,
         *   LPCSTR lpLoadOrderGroup, LPDWORD lpdwTagId, LPCSTR lpDependencies,
         *   LPCSTR lpServiceStartName, LPCSTR lpPassword)
         */
        CreateServiceA: {
            argBytes: 52,
            /** @param {number[]} args */
            handler: ([manager, nameAddress, displayAddress, , type, start, errorControl,
                pathAddress, , , , startNameAddress])=>{
                if (!held(manager, 'manager'))
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const name = text(nameAddress, MAX_SERVICE_NAME);
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
                    imagePath: text(pathAddress, MAX_TEXT),
                    displayName: text(displayAddress, MAX_TEXT),
                    // A service with no account named runs as the system.
                    objectName: text(startNameAddress, MAX_TEXT) ?? 'LocalSystem',
                });
                return open({ kind: 'service', name });
            },
        },

        /**
         * BOOL ChangeServiceConfigA(SC_HANDLE hService, DWORD dwServiceType,
         *   DWORD dwStartType, DWORD dwErrorControl, LPCSTR lpBinaryPathName,
         *   LPCSTR lpLoadOrderGroup, LPDWORD lpdwTagId, LPCSTR lpDependencies,
         *   LPCSTR lpServiceStartName, LPCSTR lpPassword, LPCSTR lpDisplayName)
         */
        ChangeServiceConfigA: {
            argBytes: 44,
            /** @param {number[]} args */
            handler: ([service, type, start, errorControl, pathAddress, , , ,
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
                    imagePath: text(pathAddress, MAX_TEXT),
                    displayName: text(displayAddress, MAX_TEXT),
                    objectName: text(startNameAddress, MAX_TEXT),
                });
                return 1;
            },
        },

        /**
         * BOOL StartServiceA(SC_HANDLE hService, DWORD dwNumServiceArgs,
         *                    LPCSTR *lpServiceArgVectors)
         *
         * Nothing here can host a service process, so the start fails as one
         * that never reported back would.
         */
        StartServiceA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([service])=>{
                const object = held(service, 'service');
                if (!object)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                host.divergence?.('StartServiceA',
                    `${object.name}: no process hosts a service here; reported as timed out`);
                return fail(ERROR_SERVICE_REQUEST_TIMEOUT);
            },
        },

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

        /** BOOL CloseServiceHandle(SC_HANDLE hSCObject) */
        CloseServiceHandle: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>(handles.delete(handle >>> 0) ? 1 : fail(ERROR_INVALID_HANDLE)),
        },
    };
}
