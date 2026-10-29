/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Security descriptors read out of guest memory and written back: either form
 * a caller holds -- absolute, its parts pointers, or self-relative, its parts
 * offsets -- read into its parts, and the self-relative form laid out from
 * them. The descriptor calls and the objects that keep one share the layout.
 */

/** SECURITY_DESCRIPTOR, absolute on a 32-bit machine: pointers where the offsets go. */
export const SD = Object.freeze({ REVISION: 0, CONTROL: 2, OWNER: 4, GROUP: 8, SACL: 12, DACL: 16,
    SIZE: 20 });
export const SE_OWNER_DEFAULTED = 0x0001;
export const SE_GROUP_DEFAULTED = 0x0002;
export const SE_DACL_PRESENT = 0x0004;
export const SE_DACL_DEFAULTED = 0x0008;
export const SE_SACL_PRESENT = 0x0010;
export const SE_SACL_DEFAULTED = 0x0020;
export const SE_DACL_AUTO_INHERIT_REQ = 0x0100;
export const SE_DACL_AUTO_INHERITED = 0x0400;
export const SE_DACL_PROTECTED = 0x1000;
export const SE_SACL_AUTO_INHERIT_REQ = 0x0200;
export const SE_SACL_AUTO_INHERITED = 0x0800;
export const SE_SACL_PROTECTED = 0x2000;
export const SE_RM_CONTROL_VALID = 0x4000;
export const SE_SELF_RELATIVE = 0x8000;

export const OWNER_SECURITY_INFORMATION = 0x1;
export const GROUP_SECURITY_INFORMATION = 0x2;
export const DACL_SECURITY_INFORMATION = 0x4;
export const SACL_SECURITY_INFORMATION = 0x8;
export const LABEL_SECURITY_INFORMATION = 0x10;

export const ACL_HEADER = 8;

/** The ACE types that name one trustee by a SID after the mask. */
const TRUSTEE_ACE_TYPES = new Set([0, 1, 2, 3, 0x11]);

/**
 * The parts of a descriptor, read: its control word and, for each part it
 * holds, the part's bytes -- a present ACL that is null comes back null.
 *
 * @typedef {Object} DescriptorParts
 * @property {number} control
 * @property {Uint8Array} [owner]
 * @property {Uint8Array} [group]
 * @property {Uint8Array | null} [dacl]
 * @property {Uint8Array | null} [sacl]
 */

/**
 * @param {(address: number, length: number) => Uint8Array} readMemory
 */
export function createDescriptorCodec(readMemory){
    /** @param {number} address */
    const readDword = address=>{
        const bytes = readMemory(address >>> 0, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    /** @param {number} address */
    const readWord = address=>{
        const bytes = readMemory(address >>> 0, 2);
        return bytes[0] | bytes[1] << 8;
    };

    /** A SID in guest memory, laid out, or null when it is not one. @param {number} sid */
    const sidAt = sid=>{
        if ((sid >>> 0) === 0)
        {
            return null;
        }
        const head = readMemory(sid >>> 0, 2);
        return head[0] === 1 && head[1] <= 15
            ? readMemory(sid >>> 0, 8 + 4 * head[1]).slice() : null;
    };

    /** An ACL in guest memory, its whole size as its header gives it. @param {number} acl */
    const aclAt = acl=>((acl >>> 0) === 0 ? null
        : readMemory(acl >>> 0, readWord((acl >>> 0) + 2)).slice());

    /**
     * Each ACE of an ACL, walked by its sizes, or null when the ACL is not one.
     *
     * @param {Uint8Array} acl
     * @returns {{ type: number, flags: number, mask: number, bytes: Uint8Array,
     *             sid: Uint8Array | null }[] | null}
     */
    const acesIn = acl=>{
        if (acl.length < ACL_HEADER || acl[0] < 2 || acl[0] > 4)
        {
            return null;
        }
        const view = new DataView(acl.buffer, acl.byteOffset, acl.length);
        const count = view.getUint16(4, true);
        const aces = [];
        let at = ACL_HEADER;
        for (let index = 0; index < count; index++)
        {
            if (at + 8 > acl.length)
            {
                return null;
            }
            const size = view.getUint16(at + 2, true);
            if (size < 8 || at + size > acl.length)
            {
                return null;
            }
            const type = acl[at];
            const trustee = TRUSTEE_ACE_TYPES.has(type) && size >= 16
                ? acl.slice(at + 8, at + size) : null;
            aces.push({
                type, flags: acl[at + 1], mask: view.getUint32(at + 4, true),
                bytes: acl.slice(at, at + size),
                sid: trustee && trustee[0] === 1 && 8 + 4 * trustee[1] <= trustee.length
                    ? trustee.slice(0, 8 + 4 * trustee[1]) : null,
            });
            at += size;
        }
        return aces;
    };

    /**
     * A descriptor of either form, read into its parts, or null when it is
     * not one: its revision is one, as InitializeSecurityDescriptor writes.
     *
     * @param {number} descriptor @returns {DescriptorParts | null}
     */
    const partsOf = descriptor=>{
        if ((descriptor >>> 0) === 0 || readMemory(descriptor >>> 0, 1)[0] !== 1)
        {
            return null;
        }
        const at = descriptor >>> 0;
        const control = readWord(at + SD.CONTROL);
        const relative = (control & SE_SELF_RELATIVE) !== 0;
        /** @param {number} slot */
        const part = slot=>{
            const value = readDword(at + slot);
            return relative && value !== 0 ? (at + value) >>> 0 : value;
        };
        /** @type {DescriptorParts} */
        const parts = { control };
        const owner = sidAt(part(SD.OWNER));
        const group = sidAt(part(SD.GROUP));
        if (owner)
        {
            parts.owner = owner;
        }
        if (group)
        {
            parts.group = group;
        }
        if ((control & SE_DACL_PRESENT) !== 0)
        {
            parts.dacl = aclAt(part(SD.DACL));
        }
        if ((control & SE_SACL_PRESENT) !== 0)
        {
            parts.sacl = aclAt(part(SD.SACL));
        }
        return parts;
    };

    /**
     * A self-relative descriptor of the parts: the header, then the SACL,
     * DACL, owner and group, each at the offset the header names -- the
     * order Windows lays them out in. The control word is the one given,
     * with the self-relative bit set.
     *
     * @param {DescriptorParts} parts
     */
    const selfRelative = parts=>{
        const order = /** @type {const} */ (['sacl', 'dacl', 'owner', 'group']);
        const slots = { owner: SD.OWNER, group: SD.GROUP, sacl: SD.SACL, dacl: SD.DACL };
        const size = SD.SIZE + order.reduce((sum, name)=>sum + (parts[name]?.length ?? 0), 0);
        const bytes = new Uint8Array(size);
        const view = new DataView(bytes.buffer);
        bytes[0] = 1;
        view.setUint16(SD.CONTROL, parts.control | SE_SELF_RELATIVE, true);
        let at = SD.SIZE;
        for (const name of order)
        {
            const part = parts[name];
            if (part)
            {
                view.setUint32(slots[name], at, true);
                bytes.set(part, at);
                at += part.length;
            }
        }
        return bytes;
    };

    /**
     * The parts a SECURITY_INFORMATION asks for: the rest dropped, with the
     * bits in the control word that describe them.
     *
     * @param {DescriptorParts} parts @param {number} wanted
     * @returns {DescriptorParts}
     */
    const partsAskedFor = (parts, wanted)=>{
        /** @type {DescriptorParts} */
        const kept = { control: 0 };
        if ((wanted & OWNER_SECURITY_INFORMATION) !== 0 && parts.owner)
        {
            kept.owner = parts.owner;
            kept.control |= parts.control & SE_OWNER_DEFAULTED;
        }
        if ((wanted & GROUP_SECURITY_INFORMATION) !== 0 && parts.group)
        {
            kept.group = parts.group;
            kept.control |= parts.control & SE_GROUP_DEFAULTED;
        }
        if ((wanted & DACL_SECURITY_INFORMATION) !== 0 && parts.dacl !== undefined)
        {
            kept.dacl = parts.dacl;
            kept.control |= parts.control & (SE_DACL_PRESENT | SE_DACL_DEFAULTED
                | SE_DACL_AUTO_INHERIT_REQ | SE_DACL_AUTO_INHERITED | SE_DACL_PROTECTED);
        }
        if ((wanted & (SACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION)) !== 0
            && parts.sacl !== undefined)
        {
            kept.sacl = parts.sacl;
            kept.control |= parts.control & (SE_SACL_PRESENT | SE_SACL_DEFAULTED
                | SE_SACL_AUTO_INHERIT_REQ | SE_SACL_AUTO_INHERITED | SE_SACL_PROTECTED);
        }
        return kept;
    };

    return { sidAt, aclAt, acesIn, partsOf, selfRelative, partsAskedFor };
}
