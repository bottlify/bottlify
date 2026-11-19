/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A file's reparse point as the file system's controls see it: what
 * FSCTL_SET_REPARSE_POINT takes, FSCTL_GET_REPARSE_POINT hands back and
 * FSCTL_DELETE_REPARSE_POINT asks to take off, as statuses. The buffer is
 * kept as it was set; a mount point and a symbolic link also name a place,
 * which the volume makes the reparse point stand for. Both DeviceIoControl
 * and NtFsControlFile go through `reparseRequest`.
 */

import { STATUS } from '../ntdll/status.js';

export const FSCTL_SET_REPARSE_POINT = 0x900a4;
export const FSCTL_GET_REPARSE_POINT = 0x900a8;
export const FSCTL_DELETE_REPARSE_POINT = 0x900ac;
/** The tags that name a place: a junction's and a symbolic link's. */
export const IO_REPARSE_TAG_MOUNT_POINT = 0xa0000003;
export const IO_REPARSE_TAG_SYMLINK = 0xa000000c;
/** A symbolic link whose substitute name is relative to the link's directory. */
const SYMLINK_FLAG_RELATIVE = 0x1;
/** A Microsoft tag's header is the tag, the data's length and a reserved word. */
const HEADER = 8;
/** Any other tag's carries a GUID after them, REPARSE_GUID_DATA_BUFFER's head. */
const GUID_HEADER = 24;
/**
 * sizeof(REPARSE_GUID_DATA_BUFFER): the least room a read of one is given
 * any of it in, and what a delete hands - a header with no data.
 */
const GUID_BUFFER = 28;
/** The tags no reparse point may carry: IO_REPARSE_TAG_RESERVED_ZERO and _ONE. */
const RESERVED_TAGS = 1;
/** The NT prefix a substitute name carries before a DOS path. */
const NT_PREFIX = '\\??\\';

/** @param {number} tag */
const isMicrosoft = tag=>((tag >>> 0) & 0x80000000) !== 0;

/**
 * @typedef {Object} ReparseVolume  What the requests act on.
 * @property {(path: string) => { tag: number, data: Uint8Array | null } | null} reparseOf
 * @property {(path: string,
 *     point: { tag: number, data: Uint8Array | null, target: string | null } | null)
 *     => string | null | { away: true }} setReparse  null when done, else the volume's code
 * @property {(path: string) => { isDirectory: boolean, size: number, junction?: string }
 *     | null} stat
 */

/**
 * The place a mount point or a symbolic link's buffer names, as a DOS path,
 * or null for one not on a drive (a device, a name that is no path) - the
 * link is then kept and stands for nothing. A relative link is resolved
 * against the directory holding `path`.
 *
 * @param {number} tag @param {Uint8Array} data @param {string} path
 * @returns {string | null | undefined}  undefined for a buffer that names nothing well-formed
 */
export function reparseTarget(tag, data, path){
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const names = HEADER + 8 + (tag === IO_REPARSE_TAG_SYMLINK ? 4 : 0);
    if (data.length < names)
    {
        return undefined;
    }
    const at = view.getUint16(HEADER, true);
    const length = view.getUint16(HEADER + 2, true);
    if ((at & 1) !== 0 || (length & 1) !== 0 || names + at + length > data.length)
    {
        return undefined;
    }
    let name = '';
    for (let offset = names + at; offset < names + at + length; offset += 2)
    {
        name += String.fromCharCode(view.getUint16(offset, true));
    }
    const relative = tag === IO_REPARSE_TAG_SYMLINK
        && (view.getUint32(HEADER + 8, true) & SYMLINK_FLAG_RELATIVE) !== 0;
    if (relative)
    {
        const parts = path.split('\\').slice(0, -1);
        for (const part of name.split(/[\\/]/))
        {
            if (part === '..')
            {
                if (parts.length > 1)
                {
                    parts.pop();
                }
            }
            else if (part !== '.' && part !== '')
            {
                parts.push(part);
            }
        }
        return parts.join('\\');
    }
    if (!name.startsWith(NT_PREFIX))
    {
        return null;
    }
    const dos = name.slice(NT_PREFIX.length);
    return /^[A-Za-z]:(\\|$)/.test(dos) ? dos.replace(/\\+$/, '') || dos : null;
}

/**
 * Whether a symbolic link's buffer names its place with a separator last:
 * a name for a directory, which a file reached through it is not.
 *
 * @param {Uint8Array | null} data
 */
export function namesDirectory(data){
    if (!data || data.length < HEADER + 12)
    {
        return false;
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const at = view.getUint16(HEADER, true);
    const length = view.getUint16(HEADER + 2, true);
    const last = HEADER + 12 + at + length - 2;
    return length >= 2 && last + 2 <= data.length && view.getUint16(last, true) === 0x5c;
}

/**
 * A mount point's buffer for a junction kept without one (a session's from
 * before buffers were kept): the substitute name, then the printed one.
 *
 * @param {string} target  a DOS path
 */
export function mountPointBuffer(target){
    /** @param {string} text */
    const utf16 = text=>Uint8Array.from([...text].flatMap(character=>
        [character.charCodeAt(0) & 0xff, character.charCodeAt(0) >>> 8]));
    const substitute = utf16(`${NT_PREFIX}${target}`);
    const printed = utf16(target);
    const data = new Uint8Array(HEADER + 8 + substitute.length + 2 + printed.length + 2);
    const view = new DataView(data.buffer);
    view.setUint32(0, IO_REPARSE_TAG_MOUNT_POINT, true);
    view.setUint16(4, data.length - HEADER, true);
    view.setUint16(HEADER + 2, substitute.length, true);
    view.setUint16(HEADER + 4, substitute.length + 2, true);
    view.setUint16(HEADER + 6, printed.length, true);
    data.set(substitute, HEADER + 8);
    data.set(printed, HEADER + 8 + substitute.length + 2);
    return data;
}

/**
 * One of the three reparse controls on the file or directory at `path`.
 * `input` is the buffer handed in, `room` the output's length (`hasOutput`
 * false for no output buffer at all); the answer is the status, the bytes
 * to hand back and how many the request reports.
 *
 * @param {ReparseVolume} volume @param {string} path @param {number} code
 * @param {Uint8Array | null} input @param {boolean} hasOutput @param {number} room
 * @param {{ divergence?: (api: string, detail: string) => void }} [say]
 * @returns {{ status: number, output?: Uint8Array, information: number }}
 */
export function reparseRequest(volume, path, code, input, hasOutput, room, say = {}){
    const refused = (/** @type {number} */ status)=>({ status, information: 0 });
    if (code === FSCTL_GET_REPARSE_POINT)
    {
        if (!hasOutput || room === 0)
        {
            return refused(STATUS.INVALID_USER_BUFFER);
        }
        const point = volume.reparseOf(path);
        if (!point)
        {
            return refused(STATUS.NOT_A_REPARSE_POINT);
        }
        const junction = volume.stat(path)?.junction;
        const data = point.data ?? mountPointBuffer(`${path.slice(0, 2)}\\${junction ?? ''}`);
        if (room < GUID_BUFFER)
        {
            return refused(STATUS.BUFFER_TOO_SMALL);
        }
        return room < data.length
            ? { status: STATUS.BUFFER_OVERFLOW, output: data.subarray(0, room), information: room }
            : { status: STATUS.SUCCESS, output: data, information: data.length };
    }
    if (input === null || input.length === 0)
    {
        return refused(STATUS.INVALID_BUFFER_SIZE);
    }
    if (input.length < HEADER)
    {
        return refused(STATUS.IO_REPARSE_DATA_INVALID);
    }
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    const tag = view.getUint32(0, true);
    const length = view.getUint16(4, true);
    if (code === FSCTL_DELETE_REPARSE_POINT)
    {
        // A delete hands a header alone, at the size of the GUID buffer's.
        if (length !== 0 || input.length !== GUID_HEADER)
        {
            return refused(STATUS.IO_REPARSE_DATA_INVALID);
        }
        if (tag <= RESERVED_TAGS)
        {
            return refused(STATUS.IO_REPARSE_TAG_INVALID);
        }
        const point = volume.reparseOf(path);
        if (!point)
        {
            return refused(STATUS.NOT_A_REPARSE_POINT);
        }
        if (point.tag !== tag)
        {
            return refused(STATUS.IO_REPARSE_TAG_MISMATCH);
        }
        const answer = volume.setReparse(path, null);
        return refused(answer === null ? STATUS.SUCCESS : STATUS.ACCESS_DENIED);
    }
    if (tag <= RESERVED_TAGS)
    {
        return refused(STATUS.IO_REPARSE_TAG_INVALID);
    }
    // The buffer is exactly its header and the data it says it has.
    if (input.length !== (isMicrosoft(tag) ? HEADER : GUID_HEADER) + length)
    {
        return refused(STATUS.IO_REPARSE_DATA_INVALID);
    }
    const entry = volume.stat(path);
    let target = null;
    if (tag === IO_REPARSE_TAG_MOUNT_POINT || tag === IO_REPARSE_TAG_SYMLINK)
    {
        const named = reparseTarget(tag, input, path);
        if (named === undefined)
        {
            return refused(STATUS.IO_REPARSE_DATA_INVALID);
        }
        // A mount point stands for a directory; a file is no place for one.
        if (tag === IO_REPARSE_TAG_MOUNT_POINT && entry && !entry.isDirectory)
        {
            return refused(STATUS.NOT_A_DIRECTORY);
        }
        // A link is taken without the privilege Windows asks (decisions.md
        // A275). A file holding data cannot become a link to another.
        if (tag === IO_REPARSE_TAG_SYMLINK && entry && !entry.isDirectory && entry.size > 0)
        {
            return refused(STATUS.IO_REPARSE_DATA_INVALID);
        }
        target = named;
    }
    const answer = volume.setReparse(path, { tag, data: input, target });
    if (answer !== null && typeof answer === 'object')
    {
        say.divergence?.('FSCTL_SET_REPARSE_POINT',
            `${path} names ${target} on another drive; kept, and it stands for nothing here`);
        return refused(STATUS.SUCCESS);
    }
    return refused(answer === null ? STATUS.SUCCESS
        : answer === 'DIRECTORY_NOT_EMPTY' ? STATUS.DIRECTORY_NOT_EMPTY
            : answer === 'WRITE_PROTECTED' ? STATUS.MEDIA_WRITE_PROTECTED : STATUS.ACCESS_DENIED);
}
