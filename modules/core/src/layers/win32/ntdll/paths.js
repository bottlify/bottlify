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
import { COUNTED_STRING } from './strings.js';

/** RTL_RELATIVE_NAME_U: a counted string, a directory handle and a reference. */
const RELATIVE_NAME_SIZE = 16;

/** The prefix that makes a resolved DOS path an object name. */
const DOS_DEVICES = '\\??\\';

/**
 * @typedef {Object} PathHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readWideString
 * @property {Record<string, { handler: Function }>} kernel32  Needs GetFullPathNameW.
 * @property {(bytes: number) => number} allocate  The process heap, so that
 *           RtlFreeUnicodeString gives the name back where it came from.
 * @property {(address: number) => boolean} free
 */

/** @param {string} text @returns {Uint8Array} UTF-16 with its terminator. */
const wide = text=>{
    const bytes = new Uint8Array((text.length + 1) * 2);
    for (let at = 0; at < text.length; at++)
    {
        bytes[at * 2] = text.charCodeAt(at) & 0xff;
        bytes[at * 2 + 1] = text.charCodeAt(at) >> 8;
    }
    return bytes;
};

/**
 * @param {PathHost} host
 */
export function createPathFunctions(host){
    /**
     * The object name a DOS path stands for, or null when it names nothing:
     * an empty path, or one GetFullPathNameW refuses.
     *
     * @param {number} dos  The caller's NUL-terminated wide path.
     * @returns {string | null}
     */
    const objectName = dos=>{
        const text = dos === 0 ? '' : host.readWideString(dos, 0x10000);
        if (text === '')
        {
            return null;
        }
        if (text.startsWith('\\\\?\\'))
        {
            return DOS_DEVICES + text.slice(4);
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
            ? null : host.readWideString(scratch, needed * 2);
        host.free(scratch);
        if (full === null)
        {
            return null;
        }
        if (full.startsWith('\\\\.\\'))
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
        const name = objectName(dos >>> 0);
        if (name === null)
        {
            return STATUS.OBJECT_NAME_INVALID;
        }
        const bytes = wide(name);
        if (bytes.length > 0xffff)
        {
            return STATUS.NAME_TOO_LONG;
        }
        const buffer = host.allocate(bytes.length);
        if (buffer === 0)
        {
            return STATUS.NO_MEMORY;
        }
        host.writeMemory(buffer, bytes);
        const descriptor = new Uint8Array(COUNTED_STRING.SIZE);
        const view = new DataView(descriptor.buffer);
        view.setUint16(COUNTED_STRING.LENGTH, bytes.length - 2, true);
        view.setUint16(COUNTED_STRING.MAXIMUM_LENGTH, bytes.length, true);
        view.setUint32(COUNTED_STRING.BUFFER, buffer, true);
        host.writeMemory(nt >>> 0, descriptor);
        if ((filePart >>> 0) !== 0)
        {
            // The last component, inside the buffer just handed out; none
            // when the path ends in a separator and so names a directory.
            const part = name.endsWith('\\') ? 0 : buffer + (name.lastIndexOf('\\') + 1) * 2;
            const out = new Uint8Array(4);
            new DataView(out.buffer).setUint32(0, part, true);
            host.writeMemory(filePart >>> 0, out);
        }
        if ((relative >>> 0) !== 0)
        {
            // Nothing is made relative to an open directory here: every name
            // this produces is a full one.
            host.writeMemory(relative >>> 0, new Uint8Array(RELATIVE_NAME_SIZE));
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
    };
}
