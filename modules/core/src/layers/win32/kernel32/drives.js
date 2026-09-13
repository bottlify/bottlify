/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a program asks about the volumes it can see.
 *
 * A game asks these for two reasons and they want opposite answers. One is to
 * find its own data — which drive it was installed on, whether that drive is
 * still there — and the other is to decide whether it is running from a CD, in
 * which case a whole different set of paths and a copy-protection check follow.
 *
 * So every drive here reports as a fixed disk, and there is exactly one of
 * them. Claiming a CD-ROM would send a program down a path that ends at a disc
 * nobody can put in; claiming a removable drive invites it to ask the user to
 * insert something. A fixed disk is both true of where the files actually are
 * and the answer with no branch behind it.
 *
 * The free-space figures are invented, and they have to be: the bytes live in a
 * bundle that is read-only and a session that is not, so there is no single
 * number that is the truth. What matters is that they are large, consistent
 * with each other, and stay inside what a 32-bit caller can hold -- a program
 * checking for room before it writes must find some, and one multiplying the
 * four values together must not overflow.
 */

/** What GetDriveType answers. Only two of the six are ever used here. */
const DRIVE_NO_ROOT_DIR = 1;
const DRIVE_FIXED = 3;

/** Codes this surface reports. */
const ERROR_INVALID_PARAMETER = 87;
const ERROR_BUFFER_OVERFLOW = 111;

/** A path argument is at most this long. */
const MAX_PATH = 260;

/**
 * The geometry claimed, and the reason for these particular numbers.
 *
 * 512-byte sectors and 8 to a cluster is an ordinary volume of the era. The
 * volume itself is thirty-two gigabytes with twenty-four free: nothing here has
 * a size of its own, a program of the era installs into a fraction of that, so
 * a figure this large refuses no installation and is still a disk such a
 * program could have seen.
 *
 * The cluster call cannot say that much. The documented way to get a byte
 * count out of it is to multiply all four values on 32-bit arithmetic, and a
 * product at or past 2^32 wraps -- to zero, which reads as a full disk. So it
 * reports the volume as the consumer line of Windows reported a large one:
 * clamped so the product stays below 2^32, two gigabytes at most. The byte
 * call has the room and says the whole of it.
 */
const BYTES_PER_SECTOR = 512;
const SECTORS_PER_CLUSTER = 8;
const CLUSTER_BYTES = BYTES_PER_SECTOR * SECTORS_PER_CLUSTER;
const VOLUME_BYTES = 32 * 1024 * 1024 * 1024;
const FREE_BYTES = 24 * 1024 * 1024 * 1024;
/** The most clusters the cluster call may report: a product just under 2^32. */
const CLUSTER_CAP = 0x1_0000_0000 / CLUSTER_BYTES - 1;
const TOTAL_CLUSTERS = Math.min(VOLUME_BYTES / CLUSTER_BYTES, CLUSTER_CAP);
const FREE_CLUSTERS = Math.min(FREE_BYTES / CLUSTER_BYTES, CLUSTER_CAP);

/** What the volume calls itself. */
const VOLUME_LABEL = 'Bottlify';
const FILE_SYSTEM = 'NTFS';
const VOLUME_SERIAL = 0xb0771f42;
const MAX_COMPONENT_LENGTH = 255;

/**
 * Flags reported for the volume. Case-preserving and case-insensitive names is
 * what every Windows filesystem of this era did and what this one does; unicode
 * names says a wide path is not truncated on the way through.
 */
const FS_CASE_IS_PRESERVED = 0x00000002;
const FS_UNICODE_STORED_ON_DISK = 0x00000004;
const FILE_SYSTEM_FLAGS = FS_CASE_IS_PRESERVED | FS_UNICODE_STORED_ON_DISK;

/** What GetComputerName answers. NetBIOS names are at most 15 characters. */
const COMPUTER_NAME = 'BOTTLIFY';

/**
 * @typedef {Object} DriveHost
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, maxLength: number) => string} readWideString
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(code: number) => void} setLastError
 * @property {() => string[]} [drives]  Letters the filesystem has mounted.
 */

/** @param {string} text */
const latin1 = text=>{
    const bytes = new Uint8Array(text.length);
    for (let at = 0; at < text.length; at++)
    {
        bytes[at] = text.charCodeAt(at) & 0xff;
    }
    return bytes;
};

/**
 * @param {DriveHost} host
 */
export function createDriveFunctions(host){
    /** Every mounted letter, upper-cased. C is assumed when nothing says. */
    const letters = ()=>(host.drives?.() ?? ['C']).map(letter=>letter[0].toUpperCase());

    /** @param {number} address */
    const readDword = address=>{
        const bytes = host.readMemory(address, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };

    /** @param {number} address @param {number} value */
    const writeDword = (address, value)=>{
        host.writeMemory(address, new Uint8Array([
            value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff,
        ]));
    };

    /** A NULL out-parameter is not an error here; every one of these is optional. */
    const writeDwordIf = (/** @type {number} */ address, /** @type {number} */ value)=>{
        if (address !== 0)
        {
            writeDword(address, value);
        }
    };

    /**
     * The drive letter a path names, or null when it names none. A path with no
     * drive means the current one, which is the first mounted letter.
     *
     * @param {string} path
     */
    const letterOf = path=>{
        if (path === '')
        {
            return letters()[0] ?? null;
        }
        const found = /^([A-Za-z]):/.exec(path);
        return found ? found[1].toUpperCase() : null;
    };

    /** @param {string} path */
    const known = path=>{
        const letter = letterOf(path);
        return letter !== null && letters().includes(letter);
    };

    /**
     * Both forms of GetVolumeInformation, and both forms of GetDriveType, differ
     * only in how the path arrives. Sharing the body is not tidiness: two
     * implementations of one answer drift, and the drift shows as a drive that
     * exists when asked one way and not the other.
     *
     * @param {string} path
     */
    const driveType = path=>known(path) ? DRIVE_FIXED : DRIVE_NO_ROOT_DIR;

    return {
        /**
         * DWORD GetLogicalDrives(VOID)
         *
         * A bitmask where bit 0 is A: and bit 2 is C:. A caller walks it rather
         * than reading a list, so a letter missing here is a drive that does not
         * exist however well it answers elsewhere.
         */
        GetLogicalDrives: {
            argBytes: 0,
            handler: ()=>{
                let mask = 0;
                for (const letter of letters())
                {
                    mask |= 1 << (letter.charCodeAt(0) - 0x41);
                }
                return mask >>> 0;
            },
        },

        /**
         * DWORD GetLogicalDriveStringsA(DWORD nBufferLength, LPSTR lpBuffer)
         *
         * One NUL-terminated root per drive, and a second NUL after the last --
         * the block is what a caller walks, and it stops on the empty entry. The
         * length reported is the block without that final terminator when it
         * fits, and with it when it does not, which is the same two-call
         * protocol as everything else that fills a buffer here.
         */
        GetLogicalDriveStringsA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([size, buffer])=>{
                const block = letters().map(letter=>`${letter}:\\\0`).join('');
                const needed = block.length + 1;
                if (buffer === 0 || needed > (size >>> 0))
                {
                    return needed;
                }
                host.writeMemory(buffer >>> 0, latin1(block + '\0'));
                return block.length;
            },
        },

        /** UINT GetDriveTypeA(LPCSTR lpRootPathName) */
        GetDriveTypeA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([path])=>driveType(
                path === 0 ? '' : host.readCString(path >>> 0, MAX_PATH)),
        },

        /** UINT GetDriveTypeW(LPCWSTR lpRootPathName) */
        GetDriveTypeW: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([path])=>driveType(
                path === 0 ? '' : host.readWideString(path >>> 0, MAX_PATH)),
        },

        /**
         * BOOL GetDiskFreeSpaceA(LPCSTR lpRootPathName, LPDWORD lpSectorsPerCluster,
         *                        LPDWORD lpBytesPerSector, LPDWORD lpNumberOfFreeClusters,
         *                        LPDWORD lpTotalNumberOfClusters)
         */
        GetDiskFreeSpaceA: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([path, sectorsPerCluster, bytesPerSector, freeClusters, totalClusters])=>{
                const root = path === 0 ? '' : host.readCString(path >>> 0, MAX_PATH);
                if (!known(root))
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                writeDwordIf(sectorsPerCluster >>> 0, SECTORS_PER_CLUSTER);
                writeDwordIf(bytesPerSector >>> 0, BYTES_PER_SECTOR);
                writeDwordIf(freeClusters >>> 0, FREE_CLUSTERS);
                writeDwordIf(totalClusters >>> 0, TOTAL_CLUSTERS);
                return 1;
            },
        },

        /**
         * BOOL GetDiskFreeSpaceExA(LPCSTR lpDirectoryName,
         *   PULARGE_INTEGER lpFreeBytesAvailableToCaller,
         *   PULARGE_INTEGER lpTotalNumberOfBytes, PULARGE_INTEGER lpTotalNumberOfFreeBytes)
         *
         * The volume in bytes, whole -- the cluster call reports the same
         * volume clamped. There is one user and no quota, so what is free is
         * what the caller may have.
         */
        GetDiskFreeSpaceExA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([path, available, total, free])=>{
                const root = path === 0 ? '' : host.readCString(path >>> 0, MAX_PATH);
                if (!known(root))
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                /** @param {number} address @param {number} value */
                const writeQwordIf = (address, value)=>{
                    if (address !== 0)
                    {
                        writeDword(address, value >>> 0);
                        writeDword(address + 4, Math.floor(value / 0x1_0000_0000));
                    }
                };
                writeQwordIf(available >>> 0, FREE_BYTES);
                writeQwordIf(total >>> 0, VOLUME_BYTES);
                writeQwordIf(free >>> 0, FREE_BYTES);
                return 1;
            },
        },

        /**
         * BOOL GetVolumeInformationA(LPCSTR lpRootPathName, LPSTR lpVolumeNameBuffer,
         *   DWORD nVolumeNameSize, LPDWORD lpVolumeSerialNumber,
         *   LPDWORD lpMaximumComponentLength, LPDWORD lpFileSystemFlags,
         *   LPSTR lpFileSystemNameBuffer, DWORD nFileSystemNameSize)
         *
         * The two name buffers are filled only when they are big enough, and a
         * caller that passed a short one gets FALSE for the whole call rather
         * than a truncated name -- this is the one place in the file surface
         * where a size mismatch fails instead of reporting a size.
         */
        GetVolumeInformationA: {
            argBytes: 32,
            /** @param {number[]} args */
            handler: args=>{
                const [path, volumeName, volumeSize, serial,
                    componentLength, flags, systemName, systemSize] = args;
                const root = path === 0 ? '' : host.readCString(path >>> 0, MAX_PATH);
                if (!known(root))
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                if (volumeName !== 0)
                {
                    if (VOLUME_LABEL.length + 1 > (volumeSize >>> 0))
                    {
                        host.setLastError(ERROR_INVALID_PARAMETER);
                        return 0;
                    }
                    host.writeMemory(volumeName >>> 0, latin1(VOLUME_LABEL + '\0'));
                }
                if (systemName !== 0)
                {
                    if (FILE_SYSTEM.length + 1 > (systemSize >>> 0))
                    {
                        host.setLastError(ERROR_INVALID_PARAMETER);
                        return 0;
                    }
                    host.writeMemory(systemName >>> 0, latin1(FILE_SYSTEM + '\0'));
                }
                writeDwordIf(serial >>> 0, VOLUME_SERIAL);
                writeDwordIf(componentLength >>> 0, MAX_COMPONENT_LENGTH);
                writeDwordIf(flags >>> 0, FILE_SYSTEM_FLAGS);
                return 1;
            },
        },

        /**
         * BOOL GetComputerNameA(LPSTR lpBuffer, LPDWORD nSize)
         *
         * The size argument is in and out, and both directions matter. Going in
         * it is the room the caller has; coming back it is the length written,
         * or -- when there was not enough room -- the length *needed including
         * the terminator*, which is how a caller sizes its second attempt. The
         * two differ by one, and answering with the wrong one leaves a caller
         * allocating a buffer that is exactly one byte short for ever.
         */
        GetComputerNameA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([buffer, size])=>{
                if (size === 0)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                const room = readDword(size >>> 0);
                if (buffer === 0 || COMPUTER_NAME.length + 1 > room)
                {
                    writeDword(size >>> 0, COMPUTER_NAME.length + 1);
                    host.setLastError(ERROR_BUFFER_OVERFLOW);
                    return 0;
                }
                host.writeMemory(buffer >>> 0, latin1(COMPUTER_NAME + '\0'));
                writeDword(size >>> 0, COMPUTER_NAME.length);
                return 1;
            },
        },
    };
}
