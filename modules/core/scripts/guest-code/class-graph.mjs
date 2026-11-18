/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A class hierarchy laid out in guest memory as Visual C++ lays out its RTTI,
 * for the tests of what reads it (`__RTDynamicCast`): a type descriptor per
 * class, base class descriptors, a hierarchy, a complete object locator below
 * each vtable, and an object whose vtable pointers and virtual base table say
 * where its bases sit.
 *
 * Two widths. The i386's words are addresses and a type descriptor's name
 * follows two reserved dwords. x86-64's are offsets into the image (here: the
 * graph's first byte), the locator's last word its own offset, a type
 * descriptor's two reserved words eight bytes each, and the vtable and
 * virtual base table pointers eight bytes.
 *
 * Derived has bases Base at 0, Second at 8 and, through the virtual base
 * table at 16, Virtual 24 bytes past the table's pointer; Stranger is no base
 * of it, and a second descriptor of Base is another image's, with the same
 * name. With `long`, a base whose name is 600 letters, and a type named as it
 * up to 512 bytes and not past.
 *
 * For the tests: no part of the product.
 */

/**
 * @param {number} at  The graph's first byte, in guest memory: the image base at 64 bits.
 * @param {{ bits?: 32 | 64, long?: boolean, bytes?: number }} [options]
 */
export function classGraph(at, { bits = 32, long = false, bytes = 0x2000 } = {}){
    const wide = bits === 64;
    const pointer = wide ? 8 : 4;
    const image = new Uint8Array(bytes);
    const view = new DataView(image.buffer);
    let next = 0;
    /** @param {number} size */
    const allocate = size=>{
        const where = next;
        next += (size + 15) & ~15;
        if (next > bytes)
        {
            throw new Error('class graph: out of room');
        }
        return where;
    };
    /** @param {number} offset @param {number} value */
    const set = (offset, value)=>view.setUint32(offset, value >>> 0, true);
    /** An address in the graph as a word of its RTTI: itself, or its offset. @param {number} offset */
    const word = offset=>(wide ? offset : at + offset);
    /** @param {string} name */
    const type = name=>{
        const where = allocate(2 * pointer + name.length + 1);
        image.set([...name].map(character=>character.charCodeAt(0)), where + 2 * pointer);
        return where;
    };
    const named = {
        derived: type('.?AVDerived@@'), base: type('.?AVBase@@'), second: type('.?AVSecond@@'),
        virtual: type('.?AVVirtual@@'), stranger: type('.?AVStranger@@'),
        otherBase: type('.?AVBase@@'),
        ...long ? { long: type(`.?AV${'L'.repeat(600)}@@`),
            longOther: type(`.?AV${'L'.repeat(600)}@@X`) } : {},
    };
    /** @param {number} of @param {number} mdisp @param {number} pdisp @param {number} vdisp */
    const base = (of, mdisp, pdisp = -1, vdisp = 0)=>{
        const where = allocate(28);
        set(where, word(of));
        set(where + 8, mdisp);
        set(where + 12, pdisp);
        set(where + 16, vdisp);
        return where;
    };
    const bases = [base(named.derived, 0), base(named.base, 0), base(named.second, 8),
        base(named.virtual, 0, 16, 4), ...long ? [base(/** @type {number} */ (named.long), 4)] : []];
    const array = allocate(bases.length * 4);
    bases.forEach((descriptor, index)=>set(array + index * 4, word(descriptor)));
    const chain = allocate(16);
    set(chain + 8, bases.length);
    set(chain + 12, word(array));
    // A complete object of 48 bytes whose virtual base table, at 16, says
    // the virtual base sits 24 bytes past it.
    const complete = allocate(48);
    const table = allocate(8);
    set(table + 4, 24);
    set(complete + 16, at + table);
    /**
     * A vtable pointer at `offset` into the object, whose locator says so.
     *
     * @param {number} offset
     * @returns {number}  the subobject's address
     */
    const subobject = offset=>{
        const locator = allocate(24);
        set(locator, wide ? 1 : 0);
        set(locator + 4, offset);
        set(locator + 12, word(named.derived));
        set(locator + 16, word(chain));
        if (wide)
        {
            set(locator + 20, locator);
        }
        const vtable = allocate(2 * pointer);
        set(vtable, at + locator);
        set(complete + offset, at + vtable + pointer);
        return at + complete + offset;
    };
    /** @type {Record<string, number>} */
    const types = Object.fromEntries(Object.entries(named)
        .map(([name, where])=>[name, at + where]));
    return { image, types, subobject, complete: at + complete };
}
