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
 * So a drive reports as a fixed disk unless it is a disc. Claiming a CD-ROM
 * for the machine's own volume would send a program down a path that ends at a
 * disc nobody can put in; claiming a removable drive invites it to ask the user
 * to insert something. A disc image mounted as a drive is the other case, and
 * the true one: it is a CD-ROM, with the label, the serial number and the
 * size the disc itself records, full, and read-only, which is what an
 * installer started from one expects to find about where it was started.
 *
 * The free-space figures are invented, and they have to be: the bytes live in a
 * bundle that is read-only and a session that is not, so there is no single
 * number that is the truth. What matters is that they are large, consistent
 * with each other, and stay inside what a 32-bit caller can hold -- a program
 * checking for room before it writes must find some, and one multiplying the
 * four values together must not overflow.
 */

import { encodeAnsi } from './locale.js';

/** @param {string} text @returns {Uint8Array} UTF-16, as a wide string is written. */
const encodeWide = text=>new Uint8Array(Uint16Array.from(text,
    character=>character.charCodeAt(0)).buffer);

/** What GetDriveType answers. Only three of the six are ever used here. */
const DRIVE_NO_ROOT_DIR = 1;
const DRIVE_FIXED = 3;
const DRIVE_CDROM = 5;

/** Codes this surface reports. */
const ERROR_WRITE_PROTECT = 19;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_BUFFER_OVERFLOW = 111;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_INSUFFICIENT_BUFFER = 122;

/** A path argument is at most this long. */
const MAX_PATH = 260;

const ERROR_NO_MORE_FILES = 18;
const ERROR_FILENAME_TOO_LONG = 206;

/**
 * Every volume GUID here begins the same and ends in its drive letter's
 * code: the name is the drive's for good, as a volume's is (roadmap/decisions.md).
 */
const VOLUME_GUID_PREFIX = 'b0771f42-0000-4000-8000-0000000000';

/** Volume searches' handles, apart from the kernel's and every other library's. */
const VOLUME_SEARCH_BASE = 0x5f800004;

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

/**
 * A disc, as the CD-ROM file system describes one: 2048-byte sectors, one to
 * a cluster, nothing free. Its names are compared without regard to case but
 * the flag says case-sensitive search is supported, the Joliet ones are
 * stored in Unicode, and the volume is read-only. The longest name is the
 * longest identifier a directory record holds, in characters.
 */
const DISC_SECTOR = 2048;
const DISC_FILE_SYSTEM = 'CDFS';
const FILE_CASE_SENSITIVE_SEARCH = 0x00000001;
const FILE_UNICODE_ON_DISK = 0x00000004;
const FILE_READ_ONLY_VOLUME = 0x00080000;
const DISC_COMPONENT_LENGTH = 221;
const DISC_UNICODE_COMPONENT_LENGTH = 110;

/** What GetComputerName answers. NetBIOS names are at most 15 characters. */
export const COMPUTER_NAME = 'BOTTLIFY';

/**
 * @typedef {Object} DriveHost
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, maxLength: number) => string} readWideString
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(code: number) => void} setLastError
 * @property {() => string[]} [drives]  Letters the filesystem has mounted.
 * @property {(letter: string) => { kind?: string, label?: string, serial?: number,
 *     size?: number, unicode?: boolean, readOnly?: boolean } | null} [volume]
 *     What a drive says of itself: a disc names its kind, `'cdrom'`, and what it records.
 */

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
     * drive means the current one, which is the first mounted letter. The
     * Win32 file namespace's `\\?\` and the device namespace's `\\.\` name
     * the same drive with their prefix in front, and a program that writes
     * its paths long asks about its drive that way.
     *
     * @param {string} path
     */
    const letterOf = path=>{
        if (path === '')
        {
            return letters()[0] ?? null;
        }
        const found = /^(?:\\\\[?.]\\)?([A-Za-z]):/.exec(path);
        return found ? found[1].toUpperCase() : null;
    };

    /** @param {string} path */
    const known = path=>{
        const letter = letterOf(path);
        return letter !== null && letters().includes(letter);
    };

    /** @param {string} path */
    const volumeOf = path=>{
        const letter = letterOf(path);
        return letter === null ? null : host.volume?.(letter) ?? null;
    };

    /** @param {string} path */
    const discAt = path=>{
        const volume = volumeOf(path);
        return volume?.kind === 'cdrom' ? volume : null;
    };

    /**
     * The label of each volume, by letter, as a program set it; a volume
     * nobody has labelled carries the machine's own, and a disc its own.
     *
     * @type {Map<string, string>}
     */
    const labels = new Map();
    /** @param {string} path */
    const labelOf = path=>discAt(path)?.label
        ?? labels.get(letterOf(path) ?? '') ?? VOLUME_LABEL;

    /**
     * Both forms of GetVolumeInformation, and both forms of GetDriveType, differ
     * only in how the path arrives. Sharing the body is not tidiness: two
     * implementations of one answer drift, and the drift shows as a drive that
     * exists when asked one way and not the other.
     *
     * @param {string} path
     */
    const driveType = path=>{
        if (!known(path))
        {
            return DRIVE_NO_ROOT_DIR;
        }
        return discAt(path) ? DRIVE_CDROM : DRIVE_FIXED;
    };

    /**
     * GetDiskFreeSpace in either spelling: the volume in clusters, clamped so
     * that the four figures multiplied stay under 2^32.
     *
     * @param {(address: number) => string} readPath
     */
    const diskFreeSpace = readPath=>({
        argBytes: 20,
        /** @param {number[]} args */
        handler: ([path, sectorsPerCluster, bytesPerSector, freeClusters, totalClusters])=>{
            const root = path === 0 ? '' : readPath(path >>> 0);
            if (!known(root))
            {
                host.setLastError(ERROR_INVALID_PARAMETER);
                return 0;
            }
            const disc = discAt(root);
            if (disc)
            {
                writeDwordIf(sectorsPerCluster >>> 0, 1);
                writeDwordIf(bytesPerSector >>> 0, DISC_SECTOR);
                writeDwordIf(freeClusters >>> 0, 0);
                writeDwordIf(totalClusters >>> 0, Math.ceil((disc.size ?? 0) / DISC_SECTOR));
                return 1;
            }
            writeDwordIf(sectorsPerCluster >>> 0, SECTORS_PER_CLUSTER);
            writeDwordIf(bytesPerSector >>> 0, BYTES_PER_SECTOR);
            writeDwordIf(freeClusters >>> 0, FREE_CLUSTERS);
            writeDwordIf(totalClusters >>> 0, TOTAL_CLUSTERS);
            return 1;
        },
    });

    /**
     * GetDiskFreeSpaceEx in either spelling.
     *
     * @param {(address: number) => string} readPath
     */
    const diskFreeSpaceEx = readPath=>({
        argBytes: 16,
        /** @param {number[]} args */
        handler: ([path, available, total, free])=>{
            const root = path === 0 ? '' : readPath(path >>> 0);
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
            const disc = discAt(root);
            writeQwordIf(available >>> 0, disc ? 0 : FREE_BYTES);
            writeQwordIf(total >>> 0, disc ? disc.size ?? 0 : VOLUME_BYTES);
            writeQwordIf(free >>> 0, disc ? 0 : FREE_BYTES);
            return 1;
        },
    });

    /**
     * GetVolumeInformation in either width; only the text differs.
     *
     * @param {(address: number, maxLength: number) => string} readPath
     * @param {(text: string) => Uint8Array} encode
     */
    const volumeInformation = (readPath, encode)=>({
        argBytes: 32,
        /** @param {number[]} args */
        handler: args=>{
            const [path, volumeName, volumeSize, serial,
                componentLength, flags, systemName, systemSize] = args;
            const root = path === 0 ? '' : readPath(path >>> 0, MAX_PATH);
            if (!known(root))
            {
                host.setLastError(ERROR_INVALID_PARAMETER);
                return 0;
            }
            const disc = discAt(root);
            const system = disc ? DISC_FILE_SYSTEM : FILE_SYSTEM;
            if (volumeName !== 0)
            {
                const label = labelOf(root);
                if (label.length + 1 > (volumeSize >>> 0))
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                host.writeMemory(volumeName >>> 0, encode(label + '\0'));
            }
            if (systemName !== 0)
            {
                if (system.length + 1 > (systemSize >>> 0))
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                host.writeMemory(systemName >>> 0, encode(system + '\0'));
            }
            if (disc)
            {
                writeDwordIf(serial >>> 0, (disc.serial ?? 0) >>> 0);
                writeDwordIf(componentLength >>> 0, disc.unicode
                    ? DISC_UNICODE_COMPONENT_LENGTH : DISC_COMPONENT_LENGTH);
                writeDwordIf(flags >>> 0, FILE_CASE_SENSITIVE_SEARCH | FILE_READ_ONLY_VOLUME
                    | (disc.unicode ? FILE_UNICODE_ON_DISK : 0));
                return 1;
            }
            writeDwordIf(serial >>> 0, VOLUME_SERIAL);
            writeDwordIf(componentLength >>> 0, MAX_COMPONENT_LENGTH);
            writeDwordIf(flags >>> 0, FILE_SYSTEM_FLAGS);
            return 1;
        },
    });

    /**
     * GetComputerName in either width: the name is ASCII, so the sizes are
     * the same numbers counted in characters.
     *
     * @param {(text: string) => Uint8Array} encode
     */
    const computerName = encode=>({
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
            host.writeMemory(buffer >>> 0, encode(COMPUTER_NAME + '\0'));
            writeDword(size >>> 0, COMPUTER_NAME.length);
            return 1;
        },
    });

    /**
     * The device a drive letter is a link to, as the object manager names it:
     * the disc drives numbered from 0 as CdRom, the other volumes from 1 as
     * HarddiskVolume, each in the order of the letters.
     *
     * @param {string} letter
     */
    const deviceOf = letter=>{
        const all = letters();
        const isDisc = (/** @type {string} */ other)=>host.volume?.(other)?.kind === 'cdrom';
        const same = all.filter(other=>isDisc(other) === isDisc(letter));
        const index = same.indexOf(letter);
        return isDisc(letter) ? `\\Device\\CdRom${index}` : `\\Device\\HarddiskVolume${index + 1}`;
    };

    /**
     * QueryDosDevice in either width: the target of a drive letter named
     * "C:" -- or, named nothing, the name of every drive -- as a list of
     * strings ended by an empty one. The answer is the characters stored,
     * their terminators counted; a device that is no drive is not found, and
     * a buffer too small for the list is stored nothing.
     *
     * @param {(address: number) => string} readName
     * @param {(text: string) => Uint8Array} encode
     */
    const queryDosDevice = (readName, encode)=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([name, target, max])=>{
            let list;
            if (name === 0)
            {
                list = letters().map(letter=>`${letter}:\0`).join('');
            }
            else
            {
                const found = /^([A-Za-z]):$/.exec(readName(name >>> 0));
                const letter = found ? found[1].toUpperCase() : null;
                if (letter === null || !letters().includes(letter))
                {
                    host.setLastError(ERROR_FILE_NOT_FOUND);
                    return 0;
                }
                list = `${deviceOf(letter)}\0`;
            }
            list += '\0';
            if (target === 0 || list.length > (max >>> 0))
            {
                host.setLastError(ERROR_INSUFFICIENT_BUFFER);
                return 0;
            }
            host.writeMemory(target >>> 0, encode(list));
            return list.length;
        },
    });

    /**
     * One NUL-terminated root per drive, and a second NUL after the last --
     * the block is what a caller walks, and it stops on the empty entry. The
     * length reported is the block without that final terminator when it
     * fits, and with it when it does not, which is the same two-call
     * protocol as everything else that fills a buffer here. Counted in the
     * characters of `encode`'s spelling.
     *
     * @param {(text: string) => Uint8Array} encode
     */
    const driveStrings = encode=>({
        argBytes: 8,
        /** @param {number[]} args */
        handler: ([size, buffer])=>{
            const block = letters().map(letter=>`${letter}:\\\0`).join('');
            const needed = block.length + 1;
            if (buffer === 0 || needed > (size >>> 0))
            {
                return needed;
            }
            host.writeMemory(buffer >>> 0, encode(block + '\0'));
            return block.length;
        },
    });

    /**
     * The volume GUID path of a drive's volume, `\\?\Volume{GUID}\`. The
     * GUID is the drive's own and stays the same from run to run, as a
     * volume's does on a machine: a program keys what it knows about a disk by
     * this name.
     *
     * @param {string} letter
     */
    const volumeNameOf = letter=>`\\\\?\\Volume{${VOLUME_GUID_PREFIX}${
        letter.charCodeAt(0).toString(16).padStart(2, '0')}}\\`;

    /** The drive a volume GUID path names, or null. @param {string} name */
    const letterOfVolume = name=>letters().find(letter=>
        volumeNameOf(letter).toLowerCase() === name.toLowerCase()) ?? null;

    /**
     * Text into a buffer of `room` characters, terminator included: TRUE, or
     * FALSE with `code` when it does not fit.
     *
     * @param {(text: string) => Uint8Array} encode @param {number} buffer
     * @param {number} room @param {string} text @param {number} code
     */
    const fitText = (encode, buffer, room, text, code)=>{
        if ((buffer >>> 0) === 0 || text.length + 1 > (room >>> 0))
        {
            host.setLastError(code);
            return 0;
        }
        host.writeMemory(buffer >>> 0, encode(`${text}\0`));
        return 1;
    };

    /**
     * GetVolumePathName in either width: the root of the volume a path is
     * on, which here is its drive's root -- each drive is one volume and none
     * is mounted in a folder of another -- kept in the namespace the path was
     * written in. A path with no drive is on the current one.
     *
     * @param {(address: number) => string} readPath
     * @param {(text: string) => Uint8Array} encode
     */
    const volumePathName = (readPath, encode)=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([path, buffer, room])=>{
            const asked = (path >>> 0) === 0 ? '' : readPath(path >>> 0);
            if (asked === '')
            {
                host.setLastError(ERROR_INVALID_PARAMETER);
                return 0;
            }
            const prefix = /^\\\\[?.]\\/.exec(asked)?.[0] ?? '';
            const letter = letterOf(asked.slice(prefix.length)) ?? letterOf('') ?? 'C';
            return fitText(encode, buffer, room, `${prefix}${letter}:\\`,
                ERROR_FILENAME_TOO_LONG);
        },
    });

    /**
     * GetVolumeNameForVolumeMountPoint in either width: a drive's root,
     * with its separator, names its volume's GUID path.
     *
     * @param {(address: number) => string} readPath
     * @param {(text: string) => Uint8Array} encode
     */
    const volumeNameForMountPoint = (readPath, encode)=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([path, buffer, room])=>{
            const ERROR_INVALID_NAME = 123;
            const asked = (path >>> 0) === 0 ? '' : readPath(path >>> 0);
            const root = /^(?:\\\\[?.]\\)?([A-Za-z]):\\$/.exec(asked);
            if (!root)
            {
                host.setLastError(asked.endsWith('\\') ? ERROR_FILE_NOT_FOUND : ERROR_INVALID_NAME);
                return 0;
            }
            const letter = root[1].toUpperCase();
            if (!letters().includes(letter))
            {
                host.setLastError(ERROR_FILE_NOT_FOUND);
                return 0;
            }
            return fitText(encode, buffer, room, volumeNameOf(letter), ERROR_FILENAME_TOO_LONG);
        },
    });

    /**
     * GetVolumePathNamesForVolumeName in either width: the one place a
     * volume is mounted, its drive's root, as a list ended by an empty name.
     * The characters the list takes are said whether it fits or not.
     *
     * @param {(address: number) => string} readPath
     * @param {(text: string) => Uint8Array} encode
     */
    const volumePathNames = (readPath, encode)=>({
        argBytes: 16,
        /** @param {number[]} args */
        handler: ([name, buffer, room, length])=>{
            const ERROR_INVALID_NAME = 123;
            const ERROR_MORE_DATA = 234;
            const asked = (name >>> 0) === 0 ? '' : readPath(name >>> 0);
            if (!/^\\\\\?\\Volume\{[0-9a-f-]{36}\}\\$/i.test(asked))
            {
                host.setLastError(ERROR_INVALID_NAME);
                return 0;
            }
            const letter = letterOfVolume(asked);
            if (letter === null)
            {
                host.setLastError(ERROR_FILE_NOT_FOUND);
                return 0;
            }
            const list = `${letter}:\\\0\0`;
            writeDwordIf(length >>> 0, list.length);
            if ((buffer >>> 0) === 0 || list.length > (room >>> 0))
            {
                host.setLastError(ERROR_MORE_DATA);
                return 0;
            }
            host.writeMemory(buffer >>> 0, encode(list));
            return 1;
        },
    });

    /**
     * The volume searches FindFirstVolume opened, by handle: the drives
     * still to give.
     *
     * @type {Map<number, string[]>}
     */
    const volumeSearches = new Map();
    let nextVolumeSearch = VOLUME_SEARCH_BASE;

    /** @param {(text: string) => Uint8Array} encode */
    const findFirstVolume = encode=>({
        argBytes: 8,
        /** @param {number[]} args */
        handler: ([buffer, room])=>{
            const INVALID_HANDLE_VALUE = 0xffffffff;
            const [first, ...rest] = letters();
            if (first === undefined)
            {
                host.setLastError(ERROR_NO_MORE_FILES);
                return INVALID_HANDLE_VALUE;
            }
            if (!fitText(encode, buffer, room, volumeNameOf(first), ERROR_FILENAME_TOO_LONG))
            {
                return INVALID_HANDLE_VALUE;
            }
            const handle = nextVolumeSearch;
            nextVolumeSearch += 4;
            volumeSearches.set(handle, rest);
            return handle;
        },
    });

    /** @param {(text: string) => Uint8Array} encode */
    const findNextVolume = encode=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([handle, buffer, room])=>{
            const ERROR_INVALID_HANDLE = 6;
            const rest = volumeSearches.get(handle >>> 0);
            if (!rest)
            {
                host.setLastError(ERROR_INVALID_HANDLE);
                return 0;
            }
            const [next] = rest;
            if (next === undefined)
            {
                host.setLastError(ERROR_NO_MORE_FILES);
                return 0;
            }
            if (!fitText(encode, buffer, room, volumeNameOf(next), ERROR_FILENAME_TOO_LONG))
            {
                return 0;
            }
            rest.shift();
            return 1;
        },
    });

    return {
        /**
         * BOOL GetVolumePathNameA/W(LPCSTR lpszFileName, LPSTR lpszVolumePathName,
         *   DWORD cchBufferLength)
         */
        GetVolumePathNameA: volumePathName(address=>host.readCString(address, MAX_PATH),
            encodeAnsi),
        GetVolumePathNameW: volumePathName(address=>host.readWideString(address, 0x10000),
            encodeWide),

        /**
         * BOOL GetVolumeNameForVolumeMountPointA/W(LPCSTR lpszVolumeMountPoint,
         *   LPSTR lpszVolumeName, DWORD cchBufferLength)
         */
        GetVolumeNameForVolumeMountPointA: volumeNameForMountPoint(
            address=>host.readCString(address, MAX_PATH), encodeAnsi),
        GetVolumeNameForVolumeMountPointW: volumeNameForMountPoint(
            address=>host.readWideString(address, MAX_PATH * 2), encodeWide),

        /**
         * BOOL GetVolumePathNamesForVolumeNameA/W(LPCSTR lpszVolumeName,
         *   LPCH lpszVolumePathNames, DWORD cchBufferLength, PDWORD lpcchReturnLength)
         */
        GetVolumePathNamesForVolumeNameA: volumePathNames(
            address=>host.readCString(address, MAX_PATH), encodeAnsi),
        GetVolumePathNamesForVolumeNameW: volumePathNames(
            address=>host.readWideString(address, MAX_PATH * 2), encodeWide),

        /**
         * HANDLE FindFirstVolumeA/W(LPSTR lpszVolumeName, DWORD cchBufferLength),
         * BOOL FindNextVolumeA/W(HANDLE hFindVolume, LPSTR lpszVolumeName, DWORD),
         * BOOL FindVolumeClose(HANDLE hFindVolume): each drive's volume, in
         * the order of the letters.
         */
        FindFirstVolumeA: findFirstVolume(encodeAnsi),
        FindFirstVolumeW: findFirstVolume(encodeWide),
        FindNextVolumeA: findNextVolume(encodeAnsi),
        FindNextVolumeW: findNextVolume(encodeWide),
        FindVolumeClose: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                if (!volumeSearches.delete(handle >>> 0))
                {
                    host.setLastError(6);
                    return 0;
                }
                return 1;
            },
        },

        /** DWORD QueryDosDeviceA(LPCSTR lpDeviceName, LPSTR lpTargetPath, DWORD ucchMax) */
        QueryDosDeviceA: queryDosDevice(address=>host.readCString(address, MAX_PATH), encodeAnsi),

        /** DWORD QueryDosDeviceW(LPCWSTR lpDeviceName, LPWSTR lpTargetPath, DWORD ucchMax) */
        QueryDosDeviceW: queryDosDevice(address=>host.readWideString(address, MAX_PATH * 2),
            encodeWide),

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

        /** DWORD GetLogicalDriveStringsA(DWORD nBufferLength, LPSTR lpBuffer) */
        GetLogicalDriveStringsA: driveStrings(encodeAnsi),

        /**
         * DWORD GetLogicalDriveStringsW(DWORD nBufferLength, LPWSTR lpBuffer)
         *
         * The same block in wide characters; the sizes are in characters too.
         */
        GetLogicalDriveStringsW: driveStrings(encodeWide),

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
                path === 0 ? '' : host.readWideString(path >>> 0, MAX_PATH * 2)),
        },

        /**
         * BOOL GetDiskFreeSpaceA(LPCSTR lpRootPathName, LPDWORD lpSectorsPerCluster,
         *                        LPDWORD lpBytesPerSector, LPDWORD lpNumberOfFreeClusters,
         *                        LPDWORD lpTotalNumberOfClusters)
         */
        GetDiskFreeSpaceA: diskFreeSpace(address=>host.readCString(address, MAX_PATH)),

        /** GetDiskFreeSpaceW: the same answers, the root read in UTF-16. */
        GetDiskFreeSpaceW: diskFreeSpace(address=>host.readWideString(address, MAX_PATH * 2)),

        /**
         * BOOL GetDiskFreeSpaceExA(LPCSTR lpDirectoryName,
         *   PULARGE_INTEGER lpFreeBytesAvailableToCaller,
         *   PULARGE_INTEGER lpTotalNumberOfBytes, PULARGE_INTEGER lpTotalNumberOfFreeBytes)
         *
         * The volume in bytes, whole -- the cluster call reports the same
         * volume clamped. There is one user and no quota, so what is free is
         * what the caller may have.
         */
        GetDiskFreeSpaceExA: diskFreeSpaceEx(address=>host.readCString(address, MAX_PATH)),

        /** GetDiskFreeSpaceExW: the same answers, the directory read in UTF-16. */
        GetDiskFreeSpaceExW: diskFreeSpaceEx(address=>host.readWideString(address, MAX_PATH * 2)),

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
        GetVolumeInformationA: volumeInformation(
            (address, length)=>host.readCString(address, length), encodeAnsi),

        /** GetVolumeInformationW: the same answers, the names in UTF-16 and sized in characters. */
        GetVolumeInformationW: volumeInformation(
            (address, length)=>host.readWideString(address, length * 2), encodeWide),

        /**
         * BOOL SetVolumeLabelA(LPCSTR lpRootPathName, LPCSTR lpVolumeName)
         *
         * The label GetVolumeInformationA reads back from then on; a null
         * name removes it. A root that is no drive fails as the query does.
         */
        SetVolumeLabelA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([path, name])=>{
                const root = path === 0 ? '' : host.readCString(path >>> 0, MAX_PATH);
                const letter = letterOf(root);
                if (letter === null || !known(root))
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                if (discAt(root))
                {
                    host.setLastError(ERROR_WRITE_PROTECT);
                    return 0;
                }
                labels.set(letter, name === 0 ? '' : host.readCString(name >>> 0, MAX_PATH));
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
        GetComputerNameA: computerName(encodeAnsi),

        /** BOOL GetComputerNameW(LPWSTR lpBuffer, LPDWORD nSize): the size in characters. */
        GetComputerNameW: computerName(encodeWide),
    };
}
