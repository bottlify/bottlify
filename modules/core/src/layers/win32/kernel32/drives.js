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

/**
 * How far a name a program hands these is read: whole, as Windows reads it, up to
 * the 32 767 characters a path may have. A name cut shorter names another file.
 */
const WHOLE_NAME = 32767;

/** @param {string} text @returns {Uint8Array} UTF-16, as a wide string is written. */
const encodeWide = text=>new Uint8Array(Uint16Array.from(text,
    character=>character.charCodeAt(0)).buffer);

/** What GetDriveType answers. Only three of the six are ever used here. */
const DRIVE_NO_ROOT_DIR = 1;
const DRIVE_FIXED = 3;
const DRIVE_CDROM = 5;

/** Codes this surface reports. */
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_ACCESS_DENIED = 5;
const ERROR_NO_MORE_FILES = 18;
const ERROR_WRITE_PROTECT = 19;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_BUFFER_OVERFLOW = 111;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_INVALID_NAME = 123;
const ERROR_DIR_NOT_ROOT = 144;
const ERROR_FILENAME_EXCED_RANGE = 206;
const ERROR_MORE_DATA = 234;
const ERROR_NOT_A_REPARSE_POINT = 4390;

/** The statuses NtQueryVolumeInformationFile answers. */
const STATUS_BUFFER_OVERFLOW = 0x80000005;
const STATUS_INVALID_INFO_CLASS = 0xc0000003;
const STATUS_INFO_LENGTH_MISMATCH = 0xc0000004;
const STATUS_INVALID_HANDLE = 0xc0000008;
const ERROR_INVALID_HANDLE = 6;
const ERROR_BAD_LENGTH = 24;

/** The FS_INFORMATION_CLASS values answered, and their records' fixed parts. */
const FILE_FS_VOLUME_INFORMATION = 1;
const FILE_FS_SIZE_INFORMATION = 3;
const FILE_FS_DEVICE_INFORMATION = 4;
const FILE_FS_ATTRIBUTE_INFORMATION = 5;
const FILE_FS_FULL_SIZE_INFORMATION = 7;
const VOLUME_FIXED = 18;
const ATTRIBUTE_FIXED = 12;
/** FILE_FS_DEVICE_INFORMATION's device types and characteristics. */
const FILE_DEVICE_CD_ROM = 2;
const FILE_DEVICE_DISK = 7;
const FILE_REMOVABLE_MEDIA = 0x1;
const FILE_READ_ONLY_DEVICE = 0x2;
const FILE_DEVICE_IS_MOUNTED = 0x20;

/** DefineDosDevice's flags. */
const DDD_RAW_TARGET_PATH = 0x1;
const DDD_REMOVE_DEFINITION = 0x2;
const DDD_EXACT_MATCH_ON_REMOVE = 0x4;

/** `\\?\Volume{GUID}\`: what a volume's own name is, in characters. */
const VOLUME_NAME_LENGTH = 49;
/** What FindFirstVolume hands out, as far from the kernel's handles as their numbers go. */
const FIRST_VOLUME_FIND = 0x7f3e0000;

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
// NTFS keeps ACLs, and so does this volume: a program that reads a file's
// descriptor gets a real one and can set it (advapi32's file security).
const FS_PERSISTENT_ACLS = 0x00000008;
const FILE_SYSTEM_FLAGS = FS_CASE_IS_PRESERVED | FS_UNICODE_STORED_ON_DISK | FS_PERSISTENT_ACLS;

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

/**
 * A volume's own name, `\\?\Volume{GUID}\`: one per letter, the same every
 * time it is asked, built from the volume's serial and its letter. The file
 * calls open it as the drive's root.
 *
 * @param {string} letter
 */
export const volumeName = letter=>{
    const code = letter.toUpperCase().charCodeAt(0);
    const hex = (/** @type {number} */ value, /** @type {number} */ digits)=>
        (value >>> 0).toString(16).padStart(digits, '0');
    return `\\\\?\\Volume{${hex(VOLUME_SERIAL ^ code, 8)}-b077-11ef-8000-`
        + `${hex(code, 4)}${hex(VOLUME_SERIAL, 8)}}\\`;
};

/**
 * The drive a path to a volume's own name is on, and the rest of the path,
 * or null when it names none. The device namespace's `\\.\` names the same
 * volume as `\\?\` does.
 *
 * @param {string} path
 * @returns {{ letter: string, rest: string } | null}
 */
export const onVolume = path=>{
    const found = /^\\\\[?.]\\Volume\{[^}]*\}(\\|$)/i.exec(path);
    if (!found)
    {
        return null;
    }
    const wanted = `\\\\?\\${found[0].slice(4).replace(/\\?$/, '')}\\`.toLowerCase();
    for (let code = 0x41; code <= 0x5a; code++)
    {
        const letter = String.fromCharCode(code);
        if (volumeName(letter).toLowerCase() === wanted)
        {
            return { letter, rest: path.slice(found[0].length) };
        }
    }
    return null;
};

/**
 * The device a drive letter is a link to, as the object manager names it:
 * the disc drives numbered from 0 as CdRom, the other volumes from 1 as
 * HarddiskVolume, each in the order of the letters.
 *
 * @param {string[]} letters @param {(letter: string) => boolean} isDisc
 * @param {string} letter
 */
const deviceName = (letters, isDisc, letter)=>{
    const same = letters.filter(other=>isDisc(other) === isDisc(letter));
    const index = same.indexOf(letter);
    return isDisc(letter) ? `\\Device\\CdRom${index}` : `\\Device\\HarddiskVolume${index + 1}`;
};

/**
 * Every mount point the mount manager knows: each drive's letter and its
 * volume's own name, both links to the drive's device, with the volume's
 * unique ID. The ID is an MBR disk's -- the disk's signature and the
 * partition's offset, twelve bytes -- one disk with one partition per
 * letter: there is no disk under the volumes to read one from, and the ID
 * only has to be the same for the two links of a volume and differ between
 * volumes.
 *
 * @param {{ drives?: () => string[], volume?: (letter: string) => any }} host
 * @returns {{ link: string, id: Uint8Array, device: string }[]}
 */
export const mountPointsOf = host=>{
    const letters = (host.drives?.() ?? ['C']).map(letter=>letter[0].toUpperCase());
    const isDisc = (/** @type {string} */ letter)=>host.volume?.(letter)?.kind === 'cdrom';
    return letters.flatMap((letter, index)=>{
        const id = new Uint8Array(12);
        const view = new DataView(id.buffer);
        view.setUint32(0, VOLUME_SERIAL, true);
        view.setUint32(4, (index + 1) * 0x100000, true);
        const device = deviceName(letters, isDisc, letter);
        return [
            { link: `\\DosDevices\\${letter}:`, id, device },
            { link: `\\??\\${volumeName(letter).slice(4, -1)}`, id, device },
        ];
    });
};

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
 * @property {() => string} [currentDirectory]  The process's, as a full path.
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {(path: string) => { exists?: boolean, isDirectory?: boolean } | null} [stat]
 * @property {{ resolve: (handle: number, type?: string) => any }} [handles]
 *     The handle table, for the volume an open file is on.
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
     * @param {string | null} path  null for none: the current drive.
     */
    const driveType = path=>{
        const root = rootOf(path);
        if (root === null || !known(root))
        {
            return DRIVE_NO_ROOT_DIR;
        }
        return discAt(root) ? DRIVE_CDROM : DRIVE_FIXED;
    };

    /**
     * The drive root a path to the space and type calls means: its own
     * letter's, the current drive's for `\` or `/`, a volume's own name's;
     * null for the empty string and for a name with no drive in it.
     *
     * @param {string | null} path  null when the caller passed no path: the
     *     current directory's drive.
     * @returns {string | null}
     */
    const rootOf = path=>{
        if (path === null)
        {
            return currentRoot();
        }
        const text = path.replace(/\//g, '\\');
        if (text === '\\')
        {
            return currentRoot();
        }
        const own = letterOfVolume(text);
        if (own !== null)
        {
            return `${own}:\\`;
        }
        const plain = /^\\\\[?.]\\/.test(text) ? text.slice(4) : text;
        const drive = /^([A-Za-z]):(\\|$)/.exec(plain);
        return drive ? `${drive[1].toUpperCase()}:\\` : null;
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
            const root = rootOf(path === 0 ? null : readPath(path >>> 0));
            if (root === null || !known(root))
            {
                host.setLastError(ERROR_PATH_NOT_FOUND);
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
            const root = rootOf(path === 0 ? null : readPath(path >>> 0));
            if (root === null || !known(root))
            {
                host.setLastError(ERROR_PATH_NOT_FOUND);
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

    /** The current directory's drive, as `C:\`. */
    const currentRoot = ()=>{
        const found = /^([A-Za-z]):/.exec(host.currentDirectory?.() ?? '');
        return `${found ? found[1].toUpperCase() : letters()[0] ?? 'C'}:\\`;
    };

    /** The letter a volume's own name is, or null. @param {string} name */
    const letterOfVolume = name=>{
        const wanted = name.toLowerCase();
        return letters().find(letter=>volumeName(letter).toLowerCase() === wanted) ?? null;
    };

    /**
     * The root a path to GetVolumeInformation names -- `C:\`, the same behind
     * `\\?\` or `\\.\`, a volume's own name -- or null for a path that is no
     * root. `C:` alone is the drive's current directory, and a root only
     * while that is the drive's root.
     *
     * @param {string} named
     * @returns {string | null}
     */
    const rootNamed = named=>{
        const text = named.replace(/\//g, '\\');
        const volume = letterOfVolume(text);
        if (volume !== null)
        {
            return `${volume}:\\`;
        }
        const plain = /^\\\\[?.]\\/.test(text) ? text.slice(4) : text;
        const rooted = /^([A-Za-z]):\\$/.exec(plain);
        if (rooted)
        {
            return `${rooted[1].toUpperCase()}:\\`;
        }
        const bare = /^([A-Za-z]):$/.exec(plain);
        if (bare)
        {
            const letter = bare[1].toUpperCase();
            const current = host.currentDirectory?.() ?? '';
            const onDrive = current.toUpperCase().startsWith(`${letter}:`);
            return !onDrive || /^[A-Za-z]:\\?$/.test(current) ? `${letter}:\\` : null;
        }
        return null;
    };

    /**
     * The mount point a path is on, as GetVolumePathName names it, or the
     * error it is refused with. A path behind `\\?\` keeps the prefix and its
     * own spelling; a drive letter is upper-cased; a relative path, and one
     * in the object manager's `\??\`, is on the current directory's volume.
     * Nothing here is mounted in a folder, so the root of a drive is the
     * answer for every path on it.
     *
     * @param {string} name
     * @returns {{ path: string } | { error: number }}
     */
    const volumePathOf = name=>{
        const text = name.replace(/\//g, '\\');
        if (text.startsWith('\\\\?\\'))
        {
            const rest = text.slice(4);
            const drive = /^([A-Za-z]):(\\|$)/.exec(rest);
            if (drive && letters().includes(drive[1].toUpperCase()))
            {
                return { path: `\\\\?\\${drive[1]}:\\` };
            }
            const volume = /^Volume\{[^}]*\}\\/i.exec(rest);
            const letter = volume ? letterOfVolume(`\\\\?\\${volume[0]}`) : null;
            return letter !== null ? { path: volumeName(letter) } : { error: ERROR_INVALID_NAME };
        }
        if (text.startsWith('\\??\\'))
        {
            return { path: currentRoot() };
        }
        if (text.startsWith('\\\\'))
        {
            return { error: ERROR_INVALID_NAME };
        }
        if (text[1] === ':')
        {
            const letter = text[0].toUpperCase();
            return /[A-Z]/.test(letter) && letters().includes(letter)
                ? { path: `${letter}:\\` } : { error: ERROR_FILE_NOT_FOUND };
        }
        return { path: currentRoot() };
    };

    /**
     * Devices DefineDosDevice made, by name without regard to case, each the
     * targets it was given, the latest last: a definition removed uncovers
     * the one before it, as the object manager's link does.
     *
     * @type {Map<string, { name: string, targets: string[] }>}
     */
    const devices = new Map();

    /** Find handles FindFirstVolume gave out, each the letters still to tell. */
    /** @type {Map<number, string[]>} */
    const volumeFinds = new Map();
    let nextVolumeFind = FIRST_VOLUME_FIND;

    /**
     * Writes a string and its terminator where `room` characters fit, or
     * says the room is short.
     *
     * @param {number} buffer @param {number} room @param {string} text
     * @param {(text: string) => Uint8Array} encode
     */
    const fits = (buffer, room, text, encode)=>{
        if ((buffer >>> 0) === 0 || text.length + 1 > (room >>> 0))
        {
            return false;
        }
        host.writeMemory(buffer >>> 0, encode(`${text}\0`));
        return true;
    };

    /**
     * The volume calls whose only difference is the width of their strings.
     *
     * @param {(address: number) => string} read
     * @param {(text: string) => Uint8Array} encode
     */
    const volumeCalls = (read, encode)=>({
        /**
         * BOOL DefineDosDevice(DWORD dwFlags, LPCTSTR lpDeviceName, LPCTSTR lpTargetPath)
         *
         * A name for a path, as QueryDosDevice then reports it -- `\??\` in
         * front and its slashes turned unless the target is raw. What it
         * names is not routed to: a file opened through the new name is not
         * found, as the device's own link would not lead anywhere here.
         */
        DefineDosDevice: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([flags, name, target])=>{
                if ((name >>> 0) === 0)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                const device = read(name >>> 0);
                const key = device.toLowerCase();
                const given = (target >>> 0) === 0 ? null : read(target >>> 0);
                const path = given === null || (flags & DDD_RAW_TARGET_PATH) !== 0
                    ? given : `\\??\\${given.replace(/\//g, '\\')}`;
                if ((flags & DDD_REMOVE_DEFINITION) !== 0)
                {
                    const held = devices.get(key);
                    const at = held === undefined ? -1
                        : path !== null && (flags & DDD_EXACT_MATCH_ON_REMOVE) !== 0
                            ? held.targets.lastIndexOf(path) : held.targets.length - 1;
                    if (held === undefined || at < 0)
                    {
                        host.setLastError(ERROR_FILE_NOT_FOUND);
                        return 0;
                    }
                    held.targets.splice(at, 1);
                    if (held.targets.length === 0)
                    {
                        devices.delete(key);
                    }
                    return 1;
                }
                if (path === null)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                const held = devices.get(key) ?? { name: device, targets: [] };
                held.targets.push(path);
                devices.set(key, held);
                return 1;
            },
        },

        /**
         * HANDLE FindFirstVolume(LPTSTR lpszVolumeName, DWORD cchBufferLength)
         * BOOL FindNextVolume(HANDLE hFindVolume, LPTSTR lpszVolumeName, DWORD cchBufferLength)
         *
         * Every volume's own name, one at a time, in the letters' order.
         */
        FindFirstVolume: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([buffer, room])=>{
                const [first, ...rest] = letters();
                if (first === undefined)
                {
                    host.setLastError(ERROR_NO_MORE_FILES);
                    return 0xffffffff;
                }
                if (!fits(buffer, room, volumeName(first), encode))
                {
                    host.setLastError(ERROR_FILENAME_EXCED_RANGE);
                    return 0xffffffff;
                }
                const handle = nextVolumeFind;
                nextVolumeFind += 4;
                volumeFinds.set(handle, rest);
                return handle;
            },
        },
        FindNextVolume: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, buffer, room])=>{
                const rest = volumeFinds.get(handle >>> 0);
                if (rest === undefined)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                if (rest.length === 0)
                {
                    host.setLastError(ERROR_NO_MORE_FILES);
                    return 0;
                }
                if (!fits(buffer, room, volumeName(rest[0]), encode))
                {
                    host.setLastError(ERROR_FILENAME_EXCED_RANGE);
                    return 0;
                }
                rest.shift();
                return 1;
            },
        },

        /**
         * BOOL GetVolumeNameForVolumeMountPoint(LPCTSTR lpszVolumeMountPoint,
         *   LPTSTR lpszVolumeName, DWORD cchBufferLength)
         *
         * A drive's root to the volume's own name. The point must end in a
         * separator; a folder that is no mount point, a drive that is not
         * there and a name DefineDosDevice made are each refused as Windows
         * refuses them.
         */
        GetVolumeNameForVolumeMountPoint: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([point, buffer, room])=>{
                if ((room >>> 0) < VOLUME_NAME_LENGTH + 1)
                {
                    host.setLastError(ERROR_FILENAME_EXCED_RANGE);
                    return 0;
                }
                const text = (point >>> 0) === 0 ? '' : read(point >>> 0).replace(/\//g, '\\');
                if (!text.endsWith('\\'))
                {
                    host.setLastError(ERROR_INVALID_NAME);
                    return 0;
                }
                const own = letterOfVolume(text);
                const plain = text.startsWith('\\\\?\\') ? text.slice(4) : text;
                const drive = /^([A-Za-z]):\\$/.exec(plain);
                const letter = own ?? (drive ? drive[1].toUpperCase() : null);
                if (letter !== null && devices.has(`${letter.toLowerCase()}:`))
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                if (letter === null || !letters().includes(letter))
                {
                    let folder = null;
                    try
                    {
                        folder = drive ? null : host.stat?.(plain.slice(0, -1)) ?? null;
                    }
                    catch (e){
                        void e;
                    }
                    host.setLastError(folder?.exists ? ERROR_NOT_A_REPARSE_POINT
                        : ERROR_FILE_NOT_FOUND);
                    return 0;
                }
                fits(buffer, room, volumeName(letter), encode);
                return 1;
            },
        },

        /**
         * BOOL GetVolumePathName(LPCTSTR lpszFileName, LPTSTR lpszVolumePathName,
         *   DWORD cchBufferLength)
         *
         * The mount point a path is on. A buffer one character short of it
         * takes it without its trailing separator.
         */
        GetVolumePathName: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([name, buffer, room])=>{
                const text = (name >>> 0) === 0 ? '' : read(name >>> 0);
                if (text === '' || (buffer >>> 0) === 0 || (room >>> 0) === 0)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                const found = volumePathOf(text);
                if ('error' in found)
                {
                    host.setLastError(found.error);
                    return 0;
                }
                const path = found.path;
                const answer = (room >>> 0) >= path.length + 1 ? path
                    : (room >>> 0) === path.length ? path.slice(0, -1) : null;
                if (answer === null)
                {
                    host.setLastError(ERROR_FILENAME_EXCED_RANGE);
                    return 0;
                }
                host.writeMemory(buffer >>> 0, encode(`${answer}\0`));
                return 1;
            },
        },

        /**
         * BOOL GetVolumePathNamesForVolumeName(LPCTSTR lpszVolumeName,
         *   LPTCH lpszVolumePathNames, DWORD cchBufferLength, PDWORD lpcchReturnLength)
         *
         * Where a volume is mounted, as a list ended by an empty string: its
         * drive's root, the only place anything is mounted here.
         */
        GetVolumePathNamesForVolumeName: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([name, buffer, room, needed])=>{
                const text = (name >>> 0) === 0 ? '' : read(name >>> 0);
                if (!/^\\\\\?\\Volume\{[0-9a-f-]{36}\}\\$/i.test(text))
                {
                    host.setLastError(ERROR_INVALID_NAME);
                    return 0;
                }
                const letter = letterOfVolume(text);
                if (letter === null)
                {
                    host.setLastError(ERROR_FILE_NOT_FOUND);
                    return 0;
                }
                const list = `${letter}:\\\0\0`;
                writeDwordIf(needed >>> 0, list.length);
                if ((buffer >>> 0) === 0 || (room >>> 0) < list.length)
                {
                    host.setLastError(ERROR_MORE_DATA);
                    return 0;
                }
                host.writeMemory(buffer >>> 0, encode(list));
                return 1;
            },
        },
    });

    /**
     * GetVolumeInformation in either width; only the text differs.
     *
     * @param {(address: number) => string} readPath
     * @param {(text: string) => Uint8Array} encode
     */
    const volumeInformation = (readPath, encode)=>({
        argBytes: 32,
        /** @param {number[]} args */
        handler: args=>{
            const [path, labelBuffer, volumeSize, serial,
                componentLength, flags, systemName, systemSize] = args;
            const named = path === 0 ? '' : readPath(path >>> 0);
            const root = path === 0 ? '' : rootNamed(named);
            if (root === null)
            {
                host.setLastError(named.endsWith('\\') || named.endsWith('/')
                    ? ERROR_DIR_NOT_ROOT : ERROR_INVALID_NAME);
                return 0;
            }
            if (!known(root))
            {
                host.setLastError(ERROR_INVALID_PARAMETER);
                return 0;
            }
            const { label, system, serial: number, component, flags: kept } = factsOf(root);
            if (labelBuffer !== 0)
            {
                if (label.length + 1 > (volumeSize >>> 0))
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                host.writeMemory(labelBuffer >>> 0, encode(label + '\0'));
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
            writeDwordIf(serial >>> 0, number);
            writeDwordIf(componentLength >>> 0, component);
            writeDwordIf(flags >>> 0, kept);
            return 1;
        },
    });

    /**
     * What GetVolumeInformation says of the volume a root is on, whichever
     * way it was asked.
     *
     * @param {string} root
     */
    const factsOf = root=>{
        const disc = discAt(root);
        return disc ? {
            label: labelOf(root), system: DISC_FILE_SYSTEM, serial: (disc.serial ?? 0) >>> 0,
            component: disc.unicode ? DISC_UNICODE_COMPONENT_LENGTH : DISC_COMPONENT_LENGTH,
            flags: FILE_CASE_SENSITIVE_SEARCH | FILE_READ_ONLY_VOLUME
                | (disc.unicode ? FILE_UNICODE_ON_DISK : 0),
            disc,
        } : {
            label: labelOf(root), system: FILE_SYSTEM, serial: VOLUME_SERIAL,
            component: MAX_COMPONENT_LENGTH, flags: FILE_SYSTEM_FLAGS, disc: null,
        };
    };

    /**
     * The root of the volume an open file or directory is on, or null for a
     * handle that is neither.
     *
     * @param {number} handle
     */
    const rootOfHandle = handle=>{
        for (const kind of ['file', 'directory'])
        {
            try
            {
                const path = host.handles?.resolve(handle >>> 0, kind)?.path;
                if (typeof path === 'string' && /^[A-Za-z]:/.test(path))
                {
                    return `${path[0].toUpperCase()}:\\`;
                }
            }
            catch (e){
                void e;
            }
        }
        return null;
    };

    /**
     * One FS_INFORMATION_CLASS record of the volume a root is on, as
     * NtQueryVolumeInformationFile lays it out, and the part of it that
     * must fit whole; null for a class not kept.
     *
     * @param {string} root @param {number} kind
     * @returns {{ bytes: Uint8Array, fixed: number } | null}
     */
    const volumeRecord = (root, kind)=>{
        const facts = factsOf(root);
        /** @param {number} length @param {(view: DataView) => void} fill */
        const record = (length, fill)=>{
            const bytes = new Uint8Array(length);
            fill(new DataView(bytes.buffer));
            return bytes;
        };
        const discSectors = Math.ceil((facts.disc?.size ?? 0) / DISC_SECTOR);
        const total = facts.disc ? discSectors : VOLUME_BYTES / CLUSTER_BYTES;
        const free = facts.disc ? 0 : FREE_BYTES / CLUSTER_BYTES;
        const perCluster = facts.disc ? 1 : SECTORS_PER_CLUSTER;
        const sector = facts.disc ? DISC_SECTOR : BYTES_PER_SECTOR;
        switch (kind)
        {
            case FILE_FS_VOLUME_INFORMATION: {
                // VolumeCreationTime, VolumeSerialNumber, VolumeLabelLength,
                // SupportsObjects, then the label.
                const label = encodeWide(facts.label);
                const bytes = record(VOLUME_FIXED + label.length, view=>{
                    view.setUint32(8, facts.serial, true);
                    view.setUint32(12, label.length, true);
                });
                bytes.set(label, VOLUME_FIXED);
                return { bytes, fixed: VOLUME_FIXED };
            }
            case FILE_FS_SIZE_INFORMATION:
                return { bytes: record(24, view=>{
                    view.setBigUint64(0, BigInt(total), true);
                    view.setBigUint64(8, BigInt(free), true);
                    view.setUint32(16, perCluster, true);
                    view.setUint32(20, sector, true);
                }), fixed: 24 };
            case FILE_FS_DEVICE_INFORMATION:
                return { bytes: record(8, view=>{
                    view.setUint32(0, facts.disc ? FILE_DEVICE_CD_ROM : FILE_DEVICE_DISK, true);
                    view.setUint32(4, FILE_DEVICE_IS_MOUNTED | (facts.disc
                        ? FILE_REMOVABLE_MEDIA | FILE_READ_ONLY_DEVICE : 0), true);
                }), fixed: 8 };
            case FILE_FS_ATTRIBUTE_INFORMATION: {
                // FileSystemAttributes, MaximumComponentNameLength,
                // FileSystemNameLength, then the name.
                const name = encodeWide(facts.system);
                const bytes = record(ATTRIBUTE_FIXED + name.length, view=>{
                    view.setUint32(0, facts.flags, true);
                    view.setUint32(4, facts.component, true);
                    view.setUint32(8, name.length, true);
                });
                bytes.set(name, ATTRIBUTE_FIXED);
                return { bytes, fixed: ATTRIBUTE_FIXED };
            }
            case FILE_FS_FULL_SIZE_INFORMATION:
                return { bytes: record(32, view=>{
                    view.setBigUint64(0, BigInt(total), true);
                    view.setBigUint64(8, BigInt(free), true);
                    view.setBigUint64(16, BigInt(free), true);
                    view.setUint32(24, perCluster, true);
                    view.setUint32(28, sector, true);
                }), fixed: 32 };
            default:
                return null;
        }
    };

    /**
     * NTSTATUS NtQueryVolumeInformationFile(HANDLE, PIO_STATUS_BLOCK, PVOID,
     *                                       ULONG Length, FS_INFORMATION_CLASS)
     *
     * A buffer short of the record's fixed part takes nothing; one short of
     * its name takes what fits, the length still saying all of it.
     */
    const queryVolumeInformation = {
        argBytes: 20,
        /** @param {number[]} args */
        handler: ([handle, block, out, length, kind])=>{
            /** @param {number} status @param {number} information */
            const report = (status, information)=>{
                writeDwordIf(block >>> 0, status);
                writeDwordIf(block === 0 ? 0 : (block >>> 0) + 4, information);
                return status;
            };
            const root = rootOfHandle(handle);
            if (root === null)
            {
                return STATUS_INVALID_HANDLE;
            }
            const found = volumeRecord(root, kind >>> 0);
            if (found === null)
            {
                host.divergence?.('NtQueryVolumeInformationFile',
                    `information class ${kind >>> 0} is not kept`);
                return STATUS_INVALID_INFO_CLASS;
            }
            if ((length >>> 0) < found.fixed)
            {
                return STATUS_INFO_LENGTH_MISMATCH;
            }
            const stored = found.bytes.subarray(0, Math.min(found.bytes.length, length >>> 0));
            host.writeMemory(out >>> 0, stored);
            return report(stored.length < found.bytes.length ? STATUS_BUFFER_OVERFLOW : 0,
                stored.length);
        },
    };

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

    /** @param {string} letter */
    const deviceOf = letter=>deviceName(letters(), other=>host.volume?.(other)?.kind === 'cdrom',
        letter);

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
            const defined = name === 0 ? undefined
                : devices.get(readName(name >>> 0).toLowerCase());
            if (name === 0)
            {
                list = [...letters().map(letter=>`${letter}:`),
                    ...[...devices.values()].map(device=>device.name)]
                    .filter((device, at, all)=>all.findIndex(other=>
                        other.toLowerCase() === device.toLowerCase()) === at)
                    .map(device=>`${device}\0`).join('');
            }
            else if (defined !== undefined)
            {
                list = `${/** @type {string} */ (defined.targets.at(-1))}\0`;
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

    /** @param {string} name */
    const mountRefused = name=>({
        argBytes: 8,
        handler: ()=>{
            host.divergence?.(name, 'no mounted folders: the volume keeps no reparse points');
            host.setLastError(ERROR_ACCESS_DENIED);
            return 0;
        },
    });
    const notMountPoint = ()=>{
        host.setLastError(ERROR_NOT_A_REPARSE_POINT);
        return 0;
    };

    const ansiVolumes = volumeCalls(address=>host.readCString(address, WHOLE_NAME), encodeAnsi);
    const wideVolumes = volumeCalls(address=>host.readWideString(address, WHOLE_NAME * 2),
        encodeWide);

    return {
        // The volume calls, each in both widths (`volumeCalls`).
        DefineDosDeviceA: ansiVolumes.DefineDosDevice,
        DefineDosDeviceW: wideVolumes.DefineDosDevice,
        FindFirstVolumeA: ansiVolumes.FindFirstVolume,
        FindFirstVolumeW: wideVolumes.FindFirstVolume,
        FindNextVolumeA: ansiVolumes.FindNextVolume,
        FindNextVolumeW: wideVolumes.FindNextVolume,
        GetVolumeNameForVolumeMountPointA: ansiVolumes.GetVolumeNameForVolumeMountPoint,
        GetVolumeNameForVolumeMountPointW: wideVolumes.GetVolumeNameForVolumeMountPoint,
        GetVolumePathNameA: ansiVolumes.GetVolumePathName,
        GetVolumePathNameW: wideVolumes.GetVolumePathName,
        GetVolumePathNamesForVolumeNameA: ansiVolumes.GetVolumePathNamesForVolumeName,
        GetVolumePathNamesForVolumeNameW: wideVolumes.GetVolumePathNamesForVolumeName,

        /**
         * BOOL SetVolumeMountPointA/W(LPCTSTR lpszVolumeMountPoint, LPCTSTR lpszVolumeName)
         * BOOL DeleteVolumeMountPointA/W(LPCTSTR lpszVolumeMountPoint)
         *
         * No folder is a mount point here: the volume keeps no reparse
         * points. Making one is refused as it is to a user without the right
         * to, and removing one finds none.
         */
        SetVolumeMountPointA: mountRefused('SetVolumeMountPointA'),
        SetVolumeMountPointW: mountRefused('SetVolumeMountPointW'),
        DeleteVolumeMountPointA: { argBytes: 4, handler: notMountPoint },
        DeleteVolumeMountPointW: { argBytes: 4, handler: notMountPoint },

        /** BOOL FindVolumeClose(HANDLE hFindVolume) */
        FindVolumeClose: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                if (!volumeFinds.delete(handle >>> 0))
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                return 1;
            },
        },

        /** DWORD QueryDosDeviceA(LPCSTR lpDeviceName, LPSTR lpTargetPath, DWORD ucchMax) */
        QueryDosDeviceA: queryDosDevice(address=>host.readCString(address, WHOLE_NAME), encodeAnsi),

        /** DWORD QueryDosDeviceW(LPCWSTR lpDeviceName, LPWSTR lpTargetPath, DWORD ucchMax) */
        QueryDosDeviceW: queryDosDevice(address=>host.readWideString(address, WHOLE_NAME * 2),
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
                path === 0 ? null : host.readCString(path >>> 0, WHOLE_NAME)),
        },

        /** UINT GetDriveTypeW(LPCWSTR lpRootPathName) */
        GetDriveTypeW: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([path])=>driveType(
                path === 0 ? null : host.readWideString(path >>> 0, WHOLE_NAME * 2)),
        },

        /**
         * BOOL GetDiskFreeSpaceA(LPCSTR lpRootPathName, LPDWORD lpSectorsPerCluster,
         *                        LPDWORD lpBytesPerSector, LPDWORD lpNumberOfFreeClusters,
         *                        LPDWORD lpTotalNumberOfClusters)
         */
        GetDiskFreeSpaceA: diskFreeSpace(address=>host.readCString(address, WHOLE_NAME)),

        /** GetDiskFreeSpaceW: the same answers, the root read in UTF-16. */
        GetDiskFreeSpaceW: diskFreeSpace(address=>host.readWideString(address, WHOLE_NAME * 2)),

        /**
         * BOOL GetDiskFreeSpaceExA(LPCSTR lpDirectoryName,
         *   PULARGE_INTEGER lpFreeBytesAvailableToCaller,
         *   PULARGE_INTEGER lpTotalNumberOfBytes, PULARGE_INTEGER lpTotalNumberOfFreeBytes)
         *
         * The volume in bytes, whole -- the cluster call reports the same
         * volume clamped. There is one user and no quota, so what is free is
         * what the caller may have.
         */
        GetDiskFreeSpaceExA: diskFreeSpaceEx(address=>host.readCString(address, WHOLE_NAME)),

        /** GetDiskFreeSpaceExW: the same answers, the directory read in UTF-16. */
        GetDiskFreeSpaceExW: diskFreeSpaceEx(address=>host.readWideString(address, WHOLE_NAME * 2)),

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
            address=>host.readCString(address, WHOLE_NAME), encodeAnsi),

        /** GetVolumeInformationW: the same answers, the names in UTF-16 and sized in characters. */
        GetVolumeInformationW: volumeInformation(
            address=>host.readWideString(address, WHOLE_NAME * 2), encodeWide),

        /**
         * BOOL GetVolumeInformationByHandleW(HANDLE, LPWSTR lpVolumeNameBuffer,
         *     DWORD nVolumeNameSize, LPDWORD lpVolumeSerialNumber,
         *     LPDWORD lpMaximumComponentLength, LPDWORD lpFileSystemFlags,
         *     LPWSTR lpFileSystemNameBuffer, DWORD nFileSystemNameSize)
         *
         * GetVolumeInformationW's answers for the volume an open file or
         * directory is on; a name with no room for its terminator fails
         * with ERROR_BAD_LENGTH. The native query it rests on is ntdll's.
         */
        GetVolumeInformationByHandleW: {
            argBytes: 32,
            /** @param {number[]} args */
            handler: ([handle, labelBuffer, labelSize, serial, componentLength, flags,
                systemName, systemSize])=>{
                const root = rootOfHandle(handle);
                if (root === null)
                {
                    host.setLastError(ERROR_INVALID_HANDLE);
                    return 0;
                }
                const facts = factsOf(root);
                for (const [buffer, size, text] of /** @type {[number, number, string][]} */ ([
                    [labelBuffer, labelSize, facts.label], [systemName, systemSize, facts.system]]))
                {
                    if (buffer === 0)
                    {
                        continue;
                    }
                    if (text.length + 1 > (size >>> 0))
                    {
                        host.setLastError(ERROR_BAD_LENGTH);
                        return 0;
                    }
                    host.writeMemory(buffer >>> 0, encodeWide(text + '\0'));
                }
                writeDwordIf(serial >>> 0, facts.serial);
                writeDwordIf(componentLength >>> 0, facts.component);
                writeDwordIf(flags >>> 0, facts.flags);
                return 1;
            },
            natives: { NtQueryVolumeInformationFile: queryVolumeInformation },
        },

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
                const root = path === 0 ? '' : host.readCString(path >>> 0, WHOLE_NAME);
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
                labels.set(letter, name === 0 ? '' : host.readCString(name >>> 0, WHOLE_NAME));
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
