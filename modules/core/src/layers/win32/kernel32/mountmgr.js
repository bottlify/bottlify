/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The mount manager, the one device a program opens by name here.
 *
 * A program lists the volumes and the names they are mounted under by
 * opening `\\.\MountPointManager` and asking IOCTL_MOUNTMGR_QUERY_POINTS,
 * as FindFirstVolume does underneath. The answer is the drives' letters and
 * volume names drives.js gives every other caller, laid out as
 * MOUNTMGR_MOUNT_POINTS: Size, NumberOfMountPoints, one 24-byte
 * MOUNTMGR_MOUNT_POINT per link, then the names and IDs those point into,
 * each offset counted from the start of the output.
 */

/** The name CreateFile opens the device by, as MOUNTMGR_DOS_DEVICE_NAME spells it. */
export const MOUNT_MANAGER = '\\\\.\\MountPointManager';

/** CTL_CODE(MOUNTMGRCONTROLTYPE 0x6d, 2, METHOD_BUFFERED, FILE_ANY_ACCESS). */
export const IOCTL_MOUNTMGR_QUERY_POINTS = 0x6d0008;

const STATUS_SUCCESS = 0;
const STATUS_BUFFER_OVERFLOW = 0x80000005;
const STATUS_INVALID_PARAMETER = 0xc000000d;
const STATUS_OBJECT_NAME_NOT_FOUND = 0xc0000034;
const STATUS_INVALID_DEVICE_REQUEST = 0xc0000010;

/** sizeof(MOUNTMGR_MOUNT_POINT), and the header ahead of the array. */
const POINT_SIZE = 24;
const HEADER_SIZE = 8;

/** @param {string} text */
const utf16 = text=>{
    const bytes = new Uint8Array(text.length * 2);
    for (let at = 0; at < text.length; at++)
    {
        bytes[at * 2] = text.charCodeAt(at) & 0xff;
        bytes[at * 2 + 1] = text.charCodeAt(at) >>> 8;
    }
    return bytes;
};

/** @param {Uint8Array} a @param {Uint8Array} b @param {boolean} [caseless] */
const same = (a, b, caseless = false)=>{
    if (a.length !== b.length)
    {
        return false;
    }
    if (!caseless)
    {
        return a.every((byte, at)=>byte === b[at]);
    }
    const text = (/** @type {Uint8Array} */ bytes)=>String.fromCharCode(
        ...new Uint16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)))
        .toUpperCase();
    return text(a) === text(b);
};

/**
 * What a control code asks of the mount manager, answered: the status, the
 * count IO_STATUS_BLOCK.Information carries, and the bytes for the output
 * buffer. A request refused for its buffers writes neither the block nor
 * the output, as the manager refuses one before it starts.
 *
 * @param {{ link: string, id: Uint8Array, device: string }[]} points
 * @param {number} code
 * @param {Uint8Array | null} input  the input buffer, null for none
 * @param {number} outLength
 * @returns {{ status: number, information: number, output: Uint8Array | null }}
 */
export function mountManagerControl(points, code, input, outLength){
    if (code >>> 0 !== IOCTL_MOUNTMGR_QUERY_POINTS)
    {
        return { status: STATUS_INVALID_DEVICE_REQUEST, information: 0, output: null };
    }
    const refused = { status: STATUS_INVALID_PARAMETER, information: 0, output: null };
    if (input === null || input.length < POINT_SIZE || outLength < HEADER_SIZE + POINT_SIZE)
    {
        return refused;
    }
    const view = new DataView(input.buffer, input.byteOffset, input.length);
    /** @param {number} at the field's offset in MOUNTMGR_MOUNT_POINT */
    const field = at=>{
        const offset = view.getUint32(at, true);
        const length = view.getUint16(at + 4, true);
        return length === 0 ? null
            : offset + length > input.length ? undefined
                : input.subarray(offset, offset + length);
    };
    const link = field(0);
    const id = field(8);
    const device = field(16);
    if (link === undefined || id === undefined || device === undefined)
    {
        return refused;
    }
    // Every field the input gives narrows the list; a zeroed input asks for all.
    const chosen = points.filter(point=>(link === null || same(utf16(point.link), link, true))
        && (id === null || same(point.id, id))
        && (device === null || same(utf16(point.device), device, true)));
    if (chosen.length === 0)
    {
        return { status: STATUS_OBJECT_NAME_NOT_FOUND, information: 0, output: null };
    }
    const encoded = chosen.map(point=>({
        link: utf16(point.link), id: point.id, device: utf16(point.device) }));
    const size = encoded.reduce((sum, point)=>sum + point.link.length
        + ((point.id.length + 1) & ~1) + point.device.length,
    HEADER_SIZE + POINT_SIZE * chosen.length);
    const output = new Uint8Array(outLength < size ? HEADER_SIZE : size);
    const out = new DataView(output.buffer);
    out.setUint32(0, size, true);
    out.setUint32(4, chosen.length, true);
    if (outLength < size)
    {
        // The size it needs and how many there are, for the caller's second try.
        return { status: STATUS_BUFFER_OVERFLOW, information: HEADER_SIZE, output };
    }
    let next = HEADER_SIZE + POINT_SIZE * chosen.length;
    encoded.forEach((point, index)=>{
        const at = HEADER_SIZE + POINT_SIZE * index;
        [point.link, point.id, point.device].forEach((bytes, which)=>{
            out.setUint32(at + which * 8, next, true);
            out.setUint16(at + which * 8 + 4, bytes.length, true);
            output.set(bytes, next);
            // Keeps the device name after an odd-length ID on a UTF-16 boundary.
            next += (bytes.length + 1) & ~1;
        });
    });
    return { status: STATUS_SUCCESS, information: size, output };
}
