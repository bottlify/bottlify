/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a native call's OBJECT_ATTRIBUTES says, and the Win32 name it gives.
 *
 * A native create or open names its object by a path in the object manager's
 * namespace; Win32's names are the same objects one directory down, in
 * \BaseNamedObjects (or a session's). One reading of the structure serves every
 * native call that names a kernel object, so a section and an event opened by
 * the same path find the same name.
 *
 * OBJECT_ATTRIBUTES: Length, RootDirectory, ObjectName (a UNICODE_STRING),
 * Attributes, SecurityDescriptor, SecurityQualityOfService - each pointer the
 * process's width, Length padded to it.
 */

/** Attributes the native creates read. */
export const OBJ_INHERIT = 0x2;
export const OBJ_OPENIF = 0x80;

/**
 * @typedef {Object} ObjectAttributes
 * @property {number} root  RootDirectory: a handle the name is relative to, or 0
 * @property {string | null} name  the ObjectName, null where there is none
 * @property {number} attributes
 * @property {number} security  the SecurityDescriptor pointer, or 0
 */

/**
 * Reads an OBJECT_ATTRIBUTES; null for a null pointer.
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
    const string = word(p * 2);
    let name = null;
    if (string !== 0)
    {
        const head = readMemory(string, pointerSize === 8 ? 16 : 8);
        const length = head[0] | head[1] << 8;
        const buffer = new DataView(head.buffer, head.byteOffset, head.length);
        const units = readMemory(pointerSize === 8
            ? Number(buffer.getBigUint64(8, true) & 0xffffffffn) : buffer.getUint32(4, true),
        length);
        name = '';
        for (let at = 0; at + 1 < units.length; at += 2)
        {
            name += String.fromCharCode(units[at] | units[at + 1] << 8);
        }
    }
    return {
        root: word(p),
        name,
        attributes: view.getUint32(p * 3, true),
        security: word(p * 4),
    };
}

/**
 * The Win32 name a native path names: the object directory Win32 names live in
 * (\BaseNamedObjects, or a session's) taken off. A name relative to a
 * directory handle is that name, the directory a program opens for it. A path
 * elsewhere in the namespace is no Win32 name: undefined.
 *
 * @param {ObjectAttributes} given
 * @returns {string | undefined}
 */
export function win32NameOf(given){
    if (given.name === null)
    {
        return undefined;
    }
    if (given.root !== 0)
    {
        return given.name;
    }
    return /^\\(?:sessions\\\d+\\)?basenamedobjects\\(.+)$/i.exec(given.name)?.[1];
}
