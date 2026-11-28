/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * DOS paths as the native interface names them.
 *
 * The native calls take object names, not paths: `C:\dir\file` is
 * `\??\C:\dir\file`, a share `\\server\share` is `\??\UNC\server\share`, and a
 * path already in the `\\?\` form is taken as it stands, unresolved. Resolving
 * the DOS path -- the current directory, `.` and `..`, forward slashes -- is
 * GetFullPathNameW's job, and this calls it rather than doing it a second
 * time, so the two can never disagree about where a relative name lands.
 */

import { STATUS } from './status.js';
import { COUNTED_STRING, countedStringAccess } from './strings.js';
import { wholeAddress } from '../common/pointers.js';

/** RTL_RELATIVE_NAME_U: a counted string, a directory handle and a reference. */
const RELATIVE_NAME_SIZE = 16;

/** The prefix that makes a resolved DOS path an object name. */
const DOS_DEVICES = '\\??\\';

/**
 * @typedef {Object} PathHost
 * @property {import('../common/guest.js').Guest} guest
 * @property {Record<string, { handler: Function }>} kernel32  Needs GetFullPathNameW; with
 *           GetCurrentDirectoryW and SetCurrentDirectoryW, the current directory too.
 * @property {(bytes: number) => number} allocate  The process heap, so that
 *           RtlFreeUnicodeString gives the name back where it came from.
 * @property {(address: number) => boolean} free
 */

/** @param {string} c */
const isSeparator = c=>c === '\\' || c === '/';

/**
 * RtlDetermineDosPathNameType_U's answer for a path: 1 a UNC name (`\\server`),
 * 2 a drive and its root (`C:\`), 3 a drive and a relative name (`C:x`), 4 rooted
 * on the current drive (`\x`), 5 relative, 6 a local device (`\\.\x`, `\\?\x`),
 * 7 the root of the local devices (`\\.`, `\\?`). Either separator counts.
 *
 * @param {string} path
 * @returns {number}
 */
function dosPathType(path){
    if (isSeparator(path[0]))
    {
        if (!isSeparator(path[1]))
        {
            return 4;
        }
        if (path[2] !== '.' && path[2] !== '?')
        {
            return 1;
        }
        if (path.length === 3)
        {
            return 7;
        }
        return isSeparator(path[3]) ? 6 : 1;
    }
    if (path.length >= 2 && path[1] === ':')
    {
        return isSeparator(path[2]) ? 2 : 3;
    }
    return 5;
}

/** The names that are devices in every folder, as Windows 10 and later know them. */
const DOS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)$/i;

/**
 * Where a path names a DOS device, as RtlIsDosDeviceName_U finds it: the
 * device's offset and length in bytes, or null. The last component is the
 * device's name once the spaces, dots and colons after it are dropped; a path
 * ending in a separator, a UNC name and a device path name no device this way.
 *
 * @param {string} path
 * @returns {{ offset: number, length: number } | null}
 */
function dosDeviceName(path){
    const type = dosPathType(path);
    if (type === 1 || type === 6 || type === 7 || path.startsWith('\\??\\'))
    {
        return null;
    }
    if (path === '' || isSeparator(path[path.length - 1]))
    {
        return null;
    }
    let start = 0;
    for (let at = path.length - 1; at >= 0; at--)
    {
        if (isSeparator(path[at]))
        {
            start = at + 1;
            break;
        }
    }
    if (start === 0 && type === 3)
    {
        start = 2;
    }
    const name = path.slice(start).replace(/[ .:]+$/, '');
    return DOS_DEVICE.test(name) ? { offset: start * 2, length: name.length * 2 } : null;
}

/**
 * The full path a DOS path names, as RtlGetFullPathName_U (and so
 * GetFullPathName) writes it, and where its file part starts (-1 for none).
 * `resolve` places an ordinary name - a drive's, the current directory's, a
 * share's - as every file call places it; what is written here around it:
 *
 * - a DOS device in any folder (`C:\dir\nul.`, `AUX`) is `\\.\NUL`, no file part;
 * - a local device path written with either separator (`//./x`, `\\?`,
 *   `//?/x/..`) is its root (`\\.\` or `\\?\`) and the rest, `.` and `..`
 *   taken but never above the root; only `\\?\` spelt with backslashes is the
 *   namespace that takes nothing, and is the caller's to keep as written;
 * - the last name loses its trailing dots and spaces, a wildcard's too
 *   (`*.` is `*`); one of nothing else is a directory (`...`, `x\.. `), and a
 *   path that names a directory by its separator keeps it, with no file part;
 * - a share's server alone (`\\server`) has no file part.
 *
 * @param {string} asked  the name as the caller wrote it, not empty
 * @param {(path: string) => string} resolve
 * @returns {{ path: string, filePart: number }}
 */
export function fullPathName(asked, resolve){
    const device = dosDeviceName(asked);
    if (device !== null)
    {
        const name = asked.slice(device.offset / 2, device.offset / 2 + device.length / 2);
        return { path: `\\\\.\\${name}`, filePart: -1 };
    }
    const type = dosPathType(asked);
    if (type === 6 || type === 7)
    {
        const root = `\\\\${asked[2]}\\`;
        /** @type {string[]} */
        const parts = [];
        const pieces = asked.slice(3).split(/[\\/]/);
        pieces.forEach((part, index)=>{
            if (part === '..')
            {
                parts.pop();
            }
            else if (part !== '' && part !== '.')
            {
                const kept = index === pieces.length - 1 ? part.replace(/[. ]+$/, '') : part;
                if (kept !== '')
                {
                    parts.push(kept);
                }
            }
        });
        const directory = parts.length > 0 && isSeparator(asked[asked.length - 1]);
        const path = root + parts.join('\\') + (directory ? '\\' : '');
        return { path, filePart: parts.length === 0 || directory ? -1
            : path.lastIndexOf('\\') + 1 };
    }
    let given = asked;
    const cut = Math.max(asked.lastIndexOf('\\'), asked.lastIndexOf('/'));
    const last = asked.slice(cut + 1);
    if (!/^(?:[A-Za-z]:)?\.{0,2}$/.test(last))
    {
        const kept = last.replace(/[. ]+$/, '');
        given = asked.slice(0, cut + 1) + (kept === '' ? (cut === -1 ? '.\\' : '') : kept);
    }
    const resolved = resolve(given);
    const directory = isSeparator(given[given.length - 1]) && !resolved.endsWith('\\');
    const path = directory ? `${resolved}\\` : resolved;
    const server = type === 1 && !path.slice(2).includes('\\');
    return { path, filePart: path.endsWith('\\') || server ? -1 : path.lastIndexOf('\\') + 1 };
}

/** Characters a short name cannot hold. */
const NOT_IN_SHORT_NAME = /["*+,/:;<=>?[\\\]|]/;
/** @param {string} name */
const hasControl = name=>[...name].some(c=>c.charCodeAt(0) < 0x20);

/**
 * Whether a name is a legal 8.3 name as RtlIsNameLegalDOS8Dot3 judges one, and
 * whether it has spaces: `.` and `..`, or one to eight characters, then at most
 * a dot and one to three more, no space first or last in either part (the
 * extension may begin with spaces), and none of the characters a short name
 * cannot hold.
 *
 * @param {string} name
 * @returns {{ legal: boolean, spaces: boolean }}
 */
function shortNameLegality(name){
    if (name === '.' || name === '..')
    {
        return { legal: true, spaces: false };
    }
    const parts = name.split('.');
    const [base, extension] = parts;
    const legal = parts.length <= 2
        && base.length >= 1 && base.length <= 8
        && base[0] !== ' ' && base[base.length - 1] !== ' '
        && (extension === undefined
            || (extension.length >= 1 && extension.length <= 3
                && extension[extension.length - 1] !== ' '))
        && !NOT_IN_SHORT_NAME.test(name) && !hasControl(name);
    return { legal, spaces: legal && name.includes(' ') };
}

/**
 * @param {PathHost} host
 */
export function createPathFunctions(host){
    const { guest } = host;
    const { readDescriptor, writeDescriptor, countedText } = countedStringAccess(host);
    /** A UNICODE_STRING's text, none for none. @param {number} at */
    const unicodeText = at=>(at === 0 ? '' : countedText(readDescriptor(wholeAddress(at)), true));
    /**
     * The object name a DOS path stands for, or null when it names nothing:
     * an empty path, or one GetFullPathNameW refuses.
     *
     * @param {number} dos  The caller's NUL-terminated wide path.
     * @returns {string | null}
     */
    const objectName = dos=>{
        const text = dos === 0 ? '' : guest.wstr(dos, 0x10000);
        if (text === '')
        {
            return null;
        }
        if (text.startsWith('\\\\?\\'))
        {
            return DOS_DEVICES + text.slice(4);
        }
        // An object name already, taken as written.
        if (text.startsWith(DOS_DEVICES) && text.length > DOS_DEVICES.length)
        {
            return text;
        }
        const fullPath = host.kernel32.GetFullPathNameW.handler;
        const needed = fullPath([dos, 0, 0, 0]) >>> 0;
        if (needed === 0)
        {
            return null;
        }
        const scratch = host.allocate(needed * 2);
        if (scratch === 0)
        {
            return null;
        }
        const written = fullPath([dos, needed, scratch, 0]) >>> 0;
        const full = written === 0 || written >= needed
            ? null : guest.wstr(scratch, needed * 2);
        host.free(scratch);
        if (full === null)
        {
            return null;
        }
        if (full.startsWith('\\\\.\\') || full.startsWith('\\\\?\\'))
        {
            return DOS_DEVICES + full.slice(4);
        }
        return full.startsWith('\\\\')
            ? `${DOS_DEVICES}UNC\\${full.slice(2)}`
            : DOS_DEVICES + full;
    };

    /**
     * The conversion both exports share, answered as a status.
     *
     * @param {number[]} args
     */
    const convert = ([dos, nt, filePart, relative])=>{
        const name = objectName(wholeAddress(dos));
        if (name === null)
        {
            return STATUS.OBJECT_NAME_INVALID;
        }
        const total = (name.length + 1) * 2;
        if (total > 0xffff)
        {
            return STATUS.NAME_TOO_LONG;
        }
        const buffer = host.allocate(total);
        if (buffer === 0)
        {
            return STATUS.NO_MEMORY;
        }
        guest.writeWide(buffer, name);
        writeDescriptor(wholeAddress(nt), { length: total - 2, maximumLength: total, buffer });
        if ((filePart >>> 0) !== 0)
        {
            // The last component, inside the buffer just handed out; none
            // when the path ends in a separator and so names a directory.
            // A share's server alone is no file either.
            const server = /^\\\?\?\\UNC\\[^\\]*$/.test(name);
            // Nor is a DOS device.
            const device = dosDeviceName(guest.wstr(wholeAddress(dos), 0x10000)) !== null;
            const part = name.endsWith('\\') || server || device ? 0
                : buffer + (name.lastIndexOf('\\') + 1) * 2;
            guest.set32(wholeAddress(filePart), part);
        }
        if ((relative >>> 0) !== 0)
        {
            // Nothing is made relative to an open directory here: every name
            // this produces is a full one.
            guest.fill(wholeAddress(relative), 0, RELATIVE_NAME_SIZE);
        }
        return STATUS.SUCCESS;
    };

    return {
        /**
         * BOOLEAN RtlDosPathNameToNtPathName_U(PCWSTR DosFileName,
         *   PUNICODE_STRING NtFileName, PWSTR *FilePart, PRTL_RELATIVE_NAME_U RelativeName)
         *
         * The name is allocated from the process heap and given back with
         * RtlFreeUnicodeString.
         */
        RtlDosPathNameToNtPathName_U: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: args=>(convert(args) === STATUS.SUCCESS ? 1 : 0),
        },

        /**
         * NTSTATUS RtlDosPathNameToNtPathName_U_WithStatus(PCWSTR, PUNICODE_STRING,
         *                                                  PWSTR *, PRTL_RELATIVE_NAME_U)
         */
        RtlDosPathNameToNtPathName_U_WithStatus: {
            argBytes: 16,
            handler: convert,
        },

        /** ULONG RtlDetermineDosPathNameType_U(PCWSTR Path) */
        RtlDetermineDosPathNameType_U: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([path])=>(path === 0 ? 0
                : dosPathType(guest.wstr(wholeAddress(path), 0x10000))),
        },

        /**
         * ULONG RtlIsDosDeviceName_U(PCWSTR Path)
         *
         * The device's offset in the high word and its length in the low,
         * both in bytes; zero when the path names none.
         */
        RtlIsDosDeviceName_U: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([path])=>{
                const found = path === 0 ? null
                    : dosDeviceName(guest.wstr(wholeAddress(path), 0x10000));
                return found === null ? 0 : (found.offset << 16 | found.length) >>> 0;
            },
        },

        /**
         * BOOLEAN RtlIsNameLegalDOS8Dot3(PCUNICODE_STRING Name, POEM_STRING OemName,
         *     PBOOLEAN NameContainsSpaces)
         *
         * The name upper-cased goes to OemName whatever the answer, where it
         * fits; whether it holds spaces is said only of a legal one.
         */
        RtlIsNameLegalDOS8Dot3: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([name, oem, spaces])=>{
                const text = unicodeText(name);
                if (text.length > 12)
                {
                    return 0;
                }
                const upper = text.toUpperCase();
                if (oem !== 0)
                {
                    const head = readDescriptor(wholeAddress(oem));
                    if (head.maximumLength < upper.length)
                    {
                        return 0;
                    }
                    guest.setBytes(head.buffer, Uint8Array.from(upper, c=>c.charCodeAt(0) & 0xff));
                    guest.set16(wholeAddress(oem) + COUNTED_STRING.LENGTH, upper.length);
                }
                const { legal, spaces: hasSpaces } = shortNameLegality(text);
                if (legal && spaces !== 0)
                {
                    guest.set8(wholeAddress(spaces), hasSpaces ? 1 : 0);
                }
                return legal ? 1 : 0;
            },
        },

        /**
         * ULONG RtlGetFullPathName_U(PCWSTR Name, ULONG Size, PWSTR Buffer, PWSTR *FilePart)
         *
         * GetFullPathNameW counted in bytes: the path's length when it fits,
         * and the room it needs with its terminator when it does not. No name
         * at all leaves the buffer as it was.
         */
        RtlGetFullPathName_U: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([name, size, buffer, filePart])=>{
                if (name === 0 || guest.wstr(wholeAddress(name), 2 * 2) === '')
                {
                    return 0;
                }
                const chars = host.kernel32.GetFullPathNameW.handler(
                    [name, (size >>> 0) >>> 1, buffer, filePart]) >>> 0;
                return chars * 2;
            },
        },

        ...(host.kernel32.GetCurrentDirectoryW && host.kernel32.SetCurrentDirectoryW
            ? {
                /**
                 * ULONG RtlGetCurrentDirectory_U(ULONG Size, PWSTR Buffer)
                 *
                 * GetCurrentDirectoryW counted in bytes, as RtlGetFullPathName_U.
                 */
                RtlGetCurrentDirectory_U: {
                    argBytes: 8,
                    /** @param {number[]} args */
                    handler: ([size, buffer])=>(host.kernel32.GetCurrentDirectoryW.handler(
                        [(size >>> 0) >>> 1, buffer]) >>> 0) * 2,
                },

                /** NTSTATUS RtlSetCurrentDirectory_U(PCUNICODE_STRING Path) */
                RtlSetCurrentDirectory_U: {
                    argBytes: 4,
                    /** @param {number[]} args */
                    handler: ([path])=>{
                        const text = unicodeText(path);
                        const scratch = host.allocate((text.length + 1) * 2);
                        if (scratch === 0)
                        {
                            return STATUS.NO_MEMORY;
                        }
                        guest.writeWide(scratch, text);
                        const done = host.kernel32.SetCurrentDirectoryW.handler([scratch]) !== 0;
                        host.free(scratch);
                        if (done)
                        {
                            return STATUS.SUCCESS;
                        }
                        const error = host.kernel32.GetLastError?.handler([]) >>> 0;
                        return SET_DIRECTORY_STATUS.get(error) ?? STATUS.OBJECT_NAME_INVALID;
                    },
                },
            }
            : {}),
    };
}

/** The status SetCurrentDirectory's error stands for. */
const SET_DIRECTORY_STATUS = new Map([
    [2, STATUS.OBJECT_NAME_NOT_FOUND],
    [3, STATUS.OBJECT_PATH_NOT_FOUND],
    [5, STATUS.ACCESS_DENIED],
    [123, STATUS.OBJECT_NAME_INVALID],
    [267, STATUS.NOT_A_DIRECTORY],
]);
