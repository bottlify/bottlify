/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Disk space lists: what a set of copies and deletes would take on each
 * drive, before any of them is done.
 *
 * Each file is one entry, by its full path, case aside. A copy replaces
 * what the list had for the file; a delete replaces nothing but a delete,
 * a copy then deleted still being a copy. A file that is there when it is
 * added counts what it holds already -- a copy over it needs only what it
 * grows by, a delete gives back what it holds -- unless the list was made
 * to ignore the disk. Every size is in whole clusters.
 */

const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_DRIVE = 15;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_INVALID_NAME = 123;

/** The list's flags: ignore what the disk holds, and let a total fall below zero. */
const SPDSL_IGNORE_DISK = 0x1;
const SPDSL_DISALLOW_NEGATIVE_ADJUST = 0x2;

/** The operations a file can be listed for. */
const FILEOP_COPY = 0;
const FILEOP_DELETE = 2;

/** The cluster every size is counted in: the volume's allocation unit. */
const CLUSTER = 4096;

/**
 * @typedef {Object} DiskSpaceHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, wide: boolean) => string | null} text
 *           A string argument in the call's width; null for none.
 * @property {(value: string, wide: boolean) => Uint8Array} encode
 *           A string terminated, in the call's width.
 * @property {(path: string) => string | null} fullPath  null for a path that names no file.
 * @property {(path: string) => number | null} sizeOf  A file's size, null for none.
 * @property {(code: number) => void} setLastError
 * @property {(type: string, object: any) => number} open
 * @property {(handle: number, type: string) => any} resolve
 * @property {(handle: number) => any} close
 *
 * @typedef {{ operation: number, size: number, existing: number }} Entry
 * @typedef {{ flags: number, files: Map<string, Entry> }} DiskSpaceList
 */

/** A size in whole clusters. @param {number} size */
const clusters = size=>Math.ceil(size / CLUSTER) * CLUSTER;

/**
 * @param {DiskSpaceHost} host
 */
export function createDiskSpaceFunctions(host){
    /** @param {number} code @param {number} [result] */
    const fail = (code, result = 0)=>{
        host.setLastError(code);
        return result;
    };

    /** @param {number} handle @returns {DiskSpaceList | null} */
    const listOf = handle=>{
        try
        {
            return host.resolve(handle >>> 0, 'disk-space-list') ?? null;
        }
        catch {
            return null;
        }
    };

    /** @param {number} flags */
    const make = flags=>host.open('disk-space-list', { flags, files: new Map() });

    /** @param {number} flags */
    const validFlags = flags=>(flags & ~(SPDSL_IGNORE_DISK | SPDSL_DISALLOW_NEGATIVE_ADJUST)) === 0;

    /**
     * What the list needs on a drive, by its entries' full paths.
     *
     * @param {DiskSpaceList} list @param {string} drive  `C:`, upper case.
     */
    const required = (list, drive)=>{
        let total = 0;
        for (const [path, entry] of list.files)
        {
            if (path.slice(0, 2) !== drive)
            {
                continue;
            }
            total += entry.operation === FILEOP_COPY ? clusters(entry.size) - entry.existing
                : -entry.existing;
        }
        return (list.flags & SPDSL_DISALLOW_NEGATIVE_ADJUST) !== 0 ? Math.max(0, total) : total;
    };

    /** @param {number} address @param {number} value */
    const writeI64 = (address, value)=>{
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setBigInt64(0, BigInt(value), true);
        host.writeMemory(address >>> 0, bytes);
    };

    /** @param {boolean} wide */
    const create = wide=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [reserved1, reserved2, flags])=>{
            void wide;
            if ((reserved1 >>> 0) !== 0 || (reserved2 >>> 0) !== 0 || !validFlags(flags >>> 0))
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            return make(flags >>> 0);
        },
    });

    /** @param {boolean} wide */
    const duplicate = wide=>({
        argBytes: 16,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [handle, reserved1, reserved2, flags])=>{
            void wide;
            if ((reserved1 >>> 0) !== 0 || (reserved2 >>> 0) !== 0 || (flags >>> 0) !== 0)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            const list = listOf(handle);
            if (!list)
            {
                return fail(ERROR_INVALID_HANDLE);
            }
            const copy = make(list.flags);
            const made = /** @type {DiskSpaceList} */ (listOf(copy));
            list.files.forEach((entry, path)=>made.files.set(path, { ...entry }));
            return copy;
        },
    });

    /** @param {boolean} wide */
    const add = wide=>({
        argBytes: 28,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [handle, filePointer, sizeLow, sizeHigh, operation])=>{
            const list = listOf(handle);
            if (!list)
            {
                return fail(ERROR_INVALID_HANDLE);
            }
            if ((operation >>> 0) !== FILEOP_COPY && (operation >>> 0) !== FILEOP_DELETE)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            const name = host.text(filePointer, wide);
            if (name === null || name === '')
            {
                return fail(ERROR_INVALID_NAME);
            }
            if (/^[\\/]{2}/.test(name) || /[\\/]$/.test(name))
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            const full = host.fullPath(name);
            if (full === null)
            {
                return fail(ERROR_INVALID_NAME);
            }
            const path = full.replace(/\//g, '\\').toUpperCase();
            const had = list.files.get(path);
            if ((operation >>> 0) === FILEOP_DELETE && had?.operation === FILEOP_COPY)
            {
                return fail(0, 1);
            }
            const size = Number(BigInt.asIntN(64, BigInt(sizeHigh >>> 0) << 32n
                | BigInt(sizeLow >>> 0)));
            const there = (list.flags & SPDSL_IGNORE_DISK) !== 0 ? null : host.sizeOf(full);
            list.files.set(path, { operation: operation >>> 0, size,
                existing: there === null ? 0 : clusters(there) });
            return fail(0, 1);
        },
    });

    /** @param {boolean} wide */
    const query = wide=>({
        argBytes: 20,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [handle, drivePointer, space])=>{
            // The A form asks for a drive before the list, the W form the other way.
            const drive = host.text(drivePointer, wide);
            if (!wide && drive === null)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            const list = listOf(handle);
            if (!list)
            {
                return fail(ERROR_INVALID_HANDLE);
            }
            if (drive === null)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            const letter = drive.toUpperCase();
            if (!/^[A-Z]:$/.test(letter)
                || ![...list.files.keys()].some(path=>path.startsWith(letter)))
            {
                return fail(ERROR_INVALID_DRIVE);
            }
            if ((space >>> 0) !== 0)
            {
                writeI64(space, required(list, letter));
            }
            return fail(0, 1);
        },
    });

    /** @param {boolean} wide */
    const drives = wide=>({
        argBytes: 16,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [handle, buffer, size, requiredOut])=>{
            const list = listOf(handle);
            if (!list)
            {
                return fail(ERROR_INVALID_HANDLE);
            }
            const letters = [...new Set([...list.files.keys()].map(path=>path.slice(0, 2)
                .toLowerCase()))].sort();
            // Each drive whole or not at all; the size reported is the one
            // that would have held the first that did not fit.
            let used = 0;
            let fits = true;
            for (const letter of letters)
            {
                const needed = used + letter.length + 1;
                if ((buffer >>> 0) !== 0 && needed > (size >>> 0) && fits)
                {
                    fits = false;
                    used = needed;
                    break;
                }
                if ((buffer >>> 0) !== 0)
                {
                    host.writeMemory((buffer >>> 0) + used * (wide ? 2 : 1),
                        host.encode(letter, wide));
                }
                used = needed;
            }
            const total = used + 1;
            if ((requiredOut >>> 0) !== 0)
            {
                const bytes = new Uint8Array(4);
                new DataView(bytes.buffer).setUint32(0, total, true);
                host.writeMemory(requiredOut >>> 0, bytes);
            }
            if ((buffer >>> 0) === 0)
            {
                return fail(0, 1);
            }
            if (!fits || (size >>> 0) < total)
            {
                return fail(ERROR_INSUFFICIENT_BUFFER);
            }
            host.writeMemory((buffer >>> 0) + used * (wide ? 2 : 1), host.encode('', wide));
            return fail(0, 1);
        },
    });

    return {
        /** HDSKSPC SetupCreateDiskSpaceListA(PVOID Reserved1, DWORD Reserved2, UINT Flags) */
        SetupCreateDiskSpaceListA: create(false),
        SetupCreateDiskSpaceListW: create(true),

        /**
         * HDSKSPC SetupDuplicateDiskSpaceListA(HDSKSPC DiskSpace, PVOID Reserved1,
         *     DWORD Reserved2, UINT Flags) -- the reserved arguments checked first
         */
        SetupDuplicateDiskSpaceListA: duplicate(false),
        SetupDuplicateDiskSpaceListW: duplicate(true),

        /** BOOL SetupDestroyDiskSpaceList(HDSKSPC DiskSpace) */
        SetupDestroyDiskSpaceList: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                if (!listOf(handle))
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                host.close(handle >>> 0);
                return 1;
            },
        },

        /**
         * BOOL SetupAddToDiskSpaceListA(HDSKSPC DiskSpace, PCSTR TargetFilespec,
         *     LONGLONG FileSize, UINT Operation, PVOID Reserved1, UINT Reserved2)
         *
         * A copy or a delete of a file, by its path: a directory, a UNC or a
         * device path is ERROR_INVALID_PARAMETER, an empty one ERROR_INVALID_NAME.
         */
        SetupAddToDiskSpaceListA: add(false),
        SetupAddToDiskSpaceListW: add(true),

        /**
         * BOOL SetupQuerySpaceRequiredOnDriveA(HDSKSPC DiskSpace, PCSTR DriveSpec,
         *     LONGLONG *SpaceRequired, PVOID Reserved1, UINT Reserved2)
         *
         * A drive as `X:` the list has a file on; anything else is
         * ERROR_INVALID_DRIVE.
         */
        SetupQuerySpaceRequiredOnDriveA: query(false),
        SetupQuerySpaceRequiredOnDriveW: query(true),

        /**
         * BOOL SetupQueryDrivesInDiskSpaceListA(HDSKSPC DiskSpace, PSTR ReturnBuffer,
         *     DWORD ReturnBufferSize, PDWORD RequiredSize)
         *
         * The drives the list has files on, lower case and in order, each
         * terminated and an empty string after the last.
         */
        SetupQueryDrivesInDiskSpaceListA: drives(false),
        SetupQueryDrivesInDiskSpaceListW: drives(true),
    };
}
