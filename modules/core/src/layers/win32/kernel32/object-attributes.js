/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a native call's OBJECT_ATTRIBUTES says, and the Win32 name it gives.
 *
 * A native create or open names its object by a path in the object manager's
 * namespace (`object-namespace.js` walks it); Win32's names are the same
 * objects one directory down, in \BaseNamedObjects (or a session's). One
 * reading of the structure serves every native call that names a kernel
 * object, so a section and an event opened by the same path find the same name.
 *
 * OBJECT_ATTRIBUTES: Length, RootDirectory, ObjectName (a UNICODE_STRING),
 * Attributes, SecurityDescriptor, SecurityQualityOfService - each pointer the
 * process's width, Length padded to it.
 */

/** Attributes the native creates read. */
export const OBJ_INHERIT = 0x2;
export const OBJ_CASE_INSENSITIVE = 0x40;
export const OBJ_OPENIF = 0x80;
/** A link last in a path is the object opened, not its target. */
export const OBJ_OPENLINK = 0x100;

/** What a malformed OBJECT_ATTRIBUTES is refused with. */
const STATUS_INVALID_PARAMETER = 0xc000000d;
const STATUS_OBJECT_NAME_INVALID = 0xc0000033;
const STATUS_DATATYPE_MISALIGNMENT = 0x80000002;
const STATUS_OBJECT_PATH_SYNTAX_BAD = 0xc000003b;
/** The longest name a UNICODE_STRING carries, in bytes: an even count below 0xffff. */
const LONGEST_NAME = 0xfffc;

/**
 * @typedef {Object} ObjectAttributes
 * @property {number} root  RootDirectory: a handle the name is relative to, or 0
 * @property {string | null} name  the ObjectName, null where there is none
 * @property {number} attributes
 * @property {number} security  the SecurityDescriptor pointer, or 0
 * @property {number} invalid  the status a malformed structure is refused with,
 *     before anything it names is looked at; 0 for one that is well formed
 */

/**
 * Reads an OBJECT_ATTRIBUTES; null for a null pointer.
 *
 * The kernel checks the structure before it walks the name: a Length that is
 * not the structure's size is STATUS_INVALID_PARAMETER, a name of an odd
 * number of bytes or longer than a UNICODE_STRING can carry is
 * STATUS_OBJECT_NAME_INVALID, and a name whose characters do not start on a
 * character's boundary is STATUS_DATATYPE_MISALIGNMENT. A pointer it cannot
 * reach faults, which a native call answers as STATUS_ACCESS_VIOLATION.
 *
 * @param {(address: number, length: number) => Uint8Array} readMemory
 * @param {number} pointer
 * @param {4 | 8} [pointerSize]
 * @returns {ObjectAttributes | null}
 */
export function readObjectAttributes(readMemory, pointer, pointerSize = 4){
    if ((pointer >>> 0) === 0)
    {
        return null;
    }
    const size = pointerSize === 8 ? 48 : 24;
    const bytes = readMemory(pointer >>> 0, size);
    const view = new DataView(bytes.buffer, bytes.byteOffset, size);
    /** @param {number} at */
    const word = at=>(pointerSize === 8 ? Number(view.getBigUint64(at, true) & 0xffffffffn)
        : view.getUint32(at, true));
    const p = pointerSize;
    const read = {
        root: word(p),
        name: /** @type {string | null} */ (null),
        attributes: view.getUint32(p * 3, true),
        security: word(p * 4),
        invalid: 0,
    };
    if (view.getUint32(0, true) !== size)
    {
        read.invalid = STATUS_INVALID_PARAMETER;
        return read;
    }
    const string = word(p * 2);
    if (string !== 0)
    {
        const head = readMemory(string, pointerSize === 8 ? 16 : 8);
        const length = head[0] | head[1] << 8;
        const buffer = new DataView(head.buffer, head.byteOffset, head.length);
        const at = pointerSize === 8 ? Number(buffer.getBigUint64(8, true) & 0xffffffffn)
            : buffer.getUint32(4, true);
        if ((length & 1) !== 0 || length > LONGEST_NAME)
        {
            read.invalid = STATUS_OBJECT_NAME_INVALID;
            return read;
        }
        if (length !== 0 && (at & 1) !== 0)
        {
            read.invalid = STATUS_DATATYPE_MISALIGNMENT;
            return read;
        }
        const units = readMemory(at, length);
        let name = '';
        for (let unit = 0; unit + 1 < units.length; unit += 2)
        {
            name += String.fromCharCode(units[unit] | units[unit + 1] << 8);
        }
        read.name = name;
    }
    return read;
}

/**
 * The native path a Win32 name stands for, the path the namespace walks to it: names
 * with the Global\ prefix live in \BaseNamedObjects, every other name in the
 * interactive session's own (Local\ or no prefix alike).
 *
 * @param {string} name
 * @param {number} session
 * @returns {string}
 */
export function nativeNameOf(name, session){
    const shared = /^global\\(.*)$/is.exec(name);
    if (shared)
    {
        return `\\BaseNamedObjects\\${shared[1]}`;
    }
    const local = /^local\\(.*)$/is.exec(name)?.[1] ?? name;
    return `\\Sessions\\${session}\\BaseNamedObjects\\${local}`;
}

/**
 * What a native create or open has to walk, by the rules every one of them
 * shares: an open needs attributes (STATUS_INVALID_PARAMETER) and a name, and
 * with no directory handle that name is a path (STATUS_OBJECT_PATH_SYNTAX_BAD);
 * a create with no name makes an unnamed object (null), and so does one with
 * an empty name under a directory handle, where an open finds the directory
 * itself. A name absent beside a directory handle is
 * STATUS_OBJECT_NAME_INVALID for both.
 *
 * @param {ObjectAttributes | null} given
 * @param {boolean} opening
 * @returns {{ status: number } | { name: string | null }}
 */
export function nameToWalk(given, opening){
    if (given === null)
    {
        return opening ? { status: STATUS_INVALID_PARAMETER } : { name: null };
    }
    if (given.invalid !== 0)
    {
        return { status: given.invalid };
    }
    if (given.name === null)
    {
        return given.root !== 0 ? { status: STATUS_OBJECT_NAME_INVALID }
            : opening ? { status: STATUS_OBJECT_PATH_SYNTAX_BAD } : { name: null };
    }
    if (given.name === '')
    {
        return given.root !== 0 ? { name: opening ? '' : null }
            : opening ? { status: STATUS_OBJECT_PATH_SYNTAX_BAD } : { name: null };
    }
    return { name: given.name };
}
