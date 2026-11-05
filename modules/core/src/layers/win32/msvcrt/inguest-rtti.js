/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * `dynamic_cast` in the guest. A C++ engine casts in its inner loops: 3DMark
 * 2001 SE's casts 72 million times in twelve minutes, some 830 a frame, and as
 * a host call that was 114 s of crossings, more than the guest's own time.
 * The cast reads a graph the compiler laid out in the image and writes
 * nothing, which is all the guest-code subset needs.
 *
 * The object's vtable is preceded by a pointer to its complete object locator
 * (`LOCATOR`), which says how far into the complete object this subobject sits
 * and points at the class hierarchy descriptor (`HIERARCHY`): a count and an
 * array of base class descriptors (`BASE`), each naming a type and where that
 * base sits. The cast searches the array for the requested type and adds the
 * base's offset -- a cast to the wrong offset answers a pointer that is not
 * null and is a different object, so the offset is the part that matters.
 * x86-64's RTTI holds image-relative offsets instead, so this is 32-bit only.
 */

/** @typedef {import('./guest-code.js').Guest} Guest */
/** @typedef {import('./guest-code.js').i32} i32 */
/** @typedef {import('./guest-code.js').u32} u32 */

/** The complete object locator: this subobject's offset in the complete object, its hierarchy. */
const LOCATOR_OFFSET = 4;
const LOCATOR_HIERARCHY = 16;
/** The class hierarchy descriptor: how many bases, and the array of them. */
const HIERARCHY_COUNT = 8;
const HIERARCHY_BASES = 12;
/** A base class descriptor: its type, and where it sits (PMD: mdisp, pdisp, vdisp). */
const BASE_MDISP = 8;
const BASE_PDISP = 12;
const BASE_VDISP = 16;
/** A type descriptor's decorated name begins after two reserved words. */
const TYPE_NAME = 8;
/** How far two names are compared: the runtime's reads stop there. */
const NAME_LIMIT = 512;

/**
 * void *__RTDynamicCast(void *object, LONG delta, void *from, void *to, BOOL isReference)
 *
 * `delta` is the offset from the pointer the caller holds to the start of its
 * own subobject; the locator's offset then reaches the complete object from
 * there. Two type descriptors are one type when they are the same address or
 * carry the same decorated name: a type used in two images has a descriptor in
 * each, and a cast across that boundary is what a pointer comparison alone gets
 * wrong. A virtual base is found through the object's own virtual base table.
 * A type that is no base of the object casts to null, a reference too (no
 * exception is thrown); `from` is not needed to find it.
 *
 * `isReference` is not read and not declared: the caller pops what it pushed.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} object @param {i32} delta @param {u32} from @param {u32} to
 * @returns {u32}
 */
export function __RTDynamicCast({ u8, u32, i32 }, object, delta, from, to){
    if (object === 0)
    {
        return 0;
    }
    const subobject = (object - delta) >>> 0;
    const locator = u32((u32(subobject) - 4) >>> 0);
    const complete = (subobject - i32(locator + LOCATOR_OFFSET)) >>> 0;
    const hierarchy = u32(locator + LOCATOR_HIERARCHY);
    const count = u32(hierarchy + HIERARCHY_COUNT);
    const bases = u32(hierarchy + HIERARCHY_BASES);
    for (/** @type {u32} */ let index = 0; index < count; index++)
    {
        const descriptor = u32(bases + index * 4);
        const type = u32(descriptor);
        // The same address, or the same name up to its end or to the limit.
        /** @type {i32} */
        let differs = 0;
        if (type !== to)
        {
            for (/** @type {u32} */ let at = 0; at < NAME_LIMIT; at++)
            {
                const a = u8(type + TYPE_NAME + at);
                if (a !== u8(to + TYPE_NAME + at))
                {
                    differs = 1;
                    break;
                }
                if (a === 0)
                {
                    break;
                }
            }
        }
        if (differs === 0)
        {
            const mdisp = i32(descriptor + BASE_MDISP);
            const pdisp = i32(descriptor + BASE_PDISP);
            if (pdisp < 0)
            {
                return (complete + mdisp) >>> 0;
            }
            const table = u32((complete + pdisp) >>> 0);
            return (complete + mdisp + pdisp + i32((table + i32(descriptor + BASE_VDISP)) >>> 0))
                >>> 0;
        }
    }
    return 0;
}
