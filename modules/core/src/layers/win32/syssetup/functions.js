/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * syssetup -- of Windows XP's setup library, the registry of OS components:
 * an exception package (an INF and its catalog) a setup registers to update
 * files the system protects. DirectX's setup asks whether DirectX is one,
 * unregisters what was, and registers its own package; without the library it
 * fell back to replacing the files at a restart.
 *
 * There is no file protection here to consult the packages, so the registry
 * is the run's alone: what one call registered the next query answers, and
 * nothing is written to the machine's registry. The two structures are kept
 * as the caller gave them, by the size each says it is -- DirectX's setup
 * passes 220 and 1108 bytes, the package's names inside the second -- and
 * only the component's GUID, after the first one's size, is read.
 */

const ERROR_FILE_NOT_FOUND = 2;
const ERROR_INVALID_PARAMETER = 87;

/** A SETUP_OS_COMPONENT_DATA holds at least its size and the GUID. */
const COMPONENT_HEAD = 20;
/** The most either structure is kept of. */
const MOST = 0x10000;

/**
 * @typedef {Object} SyssetupHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(code: number) => void} setLastError
 */

/** @param {SyssetupHost} host */
export function createSyssetupFunctions(host){
    /** Each registered component by its GUID's bytes. */
    /** @type {Map<string, { data: Uint8Array, exception: Uint8Array }>} */
    const components = new Map();

    /** @param {number} address */
    const dword = address=>new DataView(host.readMemory(address, 4).slice().buffer)
        .getUint32(0, true);
    /** @param {number} address */
    const guidAt = address=>Array.from(host.readMemory(address, 16), byte=>byte
        .toString(16).padStart(2, '0')).join('');
    /** A structure as its first dword sizes it, or null for one too small. @param {number} at */
    const structure = (at, least = 4)=>{
        const size = dword(at);
        return size >= least && size <= MOST ? host.readMemory(at, size).slice() : null;
    };
    /** @param {number} code */
    const fail = code=>{
        host.setLastError(code);
        return 0;
    };

    return {
        /**
         * BOOL SetupRegisterOsComponent(PSETUP_OS_COMPONENT_DATA ComponentData,
         *                               PSETUP_OS_EXCEPTION_DATA ExceptionData)
         */
        SetupRegisterOsComponent: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([data, exception])=>{
                const component = (data >>> 0) === 0 ? null : structure(data >>> 0, COMPONENT_HEAD);
                const pack = (exception >>> 0) === 0 ? null : structure(exception >>> 0);
                if (!component || !pack)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                components.set(guidAt((data >>> 0) + 4), { data: component, exception: pack });
                return 1;
            },
        },

        /** BOOL SetupUnRegisterOsComponent(const LPGUID ComponentGuid) */
        SetupUnRegisterOsComponent: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([guid])=>{
                if ((guid >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                return components.delete(guidAt(guid >>> 0)) ? 1 : fail(ERROR_FILE_NOT_FOUND);
            },
        },

        /**
         * BOOL SetupQueryRegisteredOsComponent(const LPGUID ComponentGuid,
         *     PSETUP_OS_COMPONENT_DATA SetupOsComponentData,
         *     PSETUP_OS_EXCEPTION_DATA SetupOsExceptionData)
         *
         * A component nobody registered is ERROR_FILE_NOT_FOUND, which DirectX's
         * setup takes for "not yet". One registered is written back into the
         * caller's structures, as far as each says it reaches.
         */
        SetupQueryRegisteredOsComponent: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([guid, data, exception])=>{
                if ((guid >>> 0) === 0 || (data >>> 0) === 0 || (exception >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const found = components.get(guidAt(guid >>> 0));
                if (!found)
                {
                    return fail(ERROR_FILE_NOT_FOUND);
                }
                for (const [at, kept] of /** @type {[number, Uint8Array][]} */ ([
                    [data >>> 0, found.data], [exception >>> 0, found.exception]]))
                {
                    const room = dword(at);
                    host.writeMemory(at + 4, kept.subarray(4, Math.min(kept.length, room)));
                }
                return 1;
            },
        },
    };
}
