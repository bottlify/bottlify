/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * sfc — System File Protection's client library, and the System Restore call
 * it also exports.
 *
 * An installer that replaces system files loads it at run time and looks up
 * three entries: the restore point call, and the two catalog calls exported by
 * ordinal alone. A library that will not load, or lacks any of the three, is
 * taken for a system the installer does not support. This machine keeps no
 * restore points, so that call says so the documented way, which an installer
 * reads as "go on without one".
 */

/** STATEMGRSTATUS.nStatus when System Restore is off. */
const ERROR_SERVICE_DISABLED = 1058;
const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_ACCESS_DENIED = 5;

const MAX_PATH = 260;

/**
 * Where an installed catalog is kept: the system catalog database, one
 * directory per subsystem GUID under CatRoot, this one the system component
 * and driver store every signed-file check consults.
 */
export const CATALOG_STORE =
    'C:\\WINDOWS\\system32\\CatRoot\\{F750E6C3-38EE-11D1-85E5-00C04FC295EE}';

/** The catalog calls have no names in the export table, only these numbers. */
export const SFC_ORDINALS = Object.freeze({ 8: 'SfpInstallCatalog', 9: 'SfpDeleteCatalog' });

/**
 * @typedef {Object} SfcHost
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} [readCString]
 * @property {import('../kernel32/files.js').FileSystem} [files]
 *           The volume a catalog is copied into the store on. Absent, no
 *           catalog can be installed.
 */

/** @param {string} path */
const baseName = path=>path.slice(Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')) + 1);

/**
 * @param {SfcHost} host
 */
export function createSfcFunctions(host){
    /**
     * BOOL SRSetRestorePoint(PRESTOREPOINTINFO pRestorePtSpec,
     *                        PSTATEMGRSTATUS pSMgrStatus)
     *
     * FALSE, with ERROR_SERVICE_DISABLED in nStatus. The block is packed, a
     * DWORD then the INT64 sequence number at 4, which only a point made
     * receives.
     */
    const setRestorePoint = {
        argBytes: 8,
        /** @param {number[]} args */
        handler: ([, status])=>{
            if ((status >>> 0) !== 0)
            {
                const bytes = new Uint8Array(4);
                new DataView(bytes.buffer).setUint32(0, ERROR_SERVICE_DISABLED, true);
                host.writeMemory(status >>> 0, bytes);
            }
            return 0;
        },
    };

    /** @param {number} address */
    const text = address=>((address >>> 0) === 0 || !host.readCString
        ? '' : host.readCString(address >>> 0, MAX_PATH));

    /**
     * Writes a whole catalog into the store under its own name.
     *
     * @param {import('../kernel32/files.js').FileSystem} files
     * @param {string} name @param {Uint8Array} bytes
     */
    const store = (files, name, bytes)=>{
        const parts = CATALOG_STORE.split('\\');
        for (let depth = 2; depth <= parts.length; depth++)
        {
            files.mkdir(parts.slice(0, depth).join('\\'));
        }
        const output = files.open(`${CATALOG_STORE}\\${name}`,
            { write: true, create: true, truncate: true });
        if (!output)
        {
            return ERROR_ACCESS_DENIED;
        }
        files.write(output, 0, bytes);
        files.close(output);
        return ERROR_SUCCESS;
    };

    return {
        SRSetRestorePoint: setRestorePoint,
        SRSetRestorePointA: setRestorePoint,
        SRSetRestorePointW: setRestorePoint,

        /**
         * DWORD SfpInstallCatalog(LPCSTR pszCatalog, LPCSTR pszDependency)
         *
         * Undocumented, and called by ordinal: the shape is what its callers
         * push and read back -- two strings popped by the callee, and an
         * error code, zero for success. The catalog at the path is copied
         * into the store; the dependency names a catalog it goes with and
         * changes nothing here.
         */
        SfpInstallCatalog: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([catalog])=>{
                const files = host.files;
                const path = text(catalog);
                const stat = files && path !== '' ? files.stat(path) : null;
                if (!files || !stat || stat.isDirectory)
                {
                    return ERROR_FILE_NOT_FOUND;
                }
                const input = files.open(path, { read: true });
                if (!input)
                {
                    return ERROR_FILE_NOT_FOUND;
                }
                const read = files.read(input, 0, stat.size);
                /** @param {Uint8Array} bytes */
                const finish = bytes=>{
                    files.close(input);
                    return store(files, baseName(path), bytes);
                };
                return read instanceof Uint8Array ? finish(read) : read.then(finish);
            },
        },

        /**
         * DWORD SfpDeleteCatalog(LPCSTR pszCatalogName)
         *
         * The installed catalog of that name leaves the store.
         */
        SfpDeleteCatalog: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([catalog])=>{
                const name = baseName(text(catalog));
                return name !== '' && host.files?.remove(`${CATALOG_STORE}\\${name}`)
                    ? ERROR_SUCCESS : ERROR_FILE_NOT_FOUND;
            },
        },
    };
}
