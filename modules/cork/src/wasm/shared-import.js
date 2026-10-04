/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A module's imported memory declared shared, for a module built before the
 * memory it links to was known to be: a module that imports a memory links
 * only against one whose sharedness its import declares, and a shared one
 * must declare a maximum.
 */

/** The most pages a 32-bit memory has: a shared import declaring it links against any. */
export const SHARED_MAX_PAGES = 65536;

/** @param {Uint8Array} bytes @param {number} at @returns {[number, number]} value, next */
const readLeb = (bytes, at)=>{
    let value = 0;
    let shift = 0;
    for (;;)
    {
        const byte = bytes[at++];
        value += (byte & 0x7f) * 2 ** shift;
        shift += 7;
        if ((byte & 0x80) === 0)
        {
            return [value, at];
        }
    }
};

/** @param {number} value @returns {number[]} */
const leb = value=>{
    /** @type {number[]} */
    const out = [];
    for (;;)
    {
        const byte = value % 128;
        value = Math.floor(value / 128);
        if (value === 0)
        {
            out.push(byte);
            return out;
        }
        out.push(byte | 0x80);
    }
};

/**
 * The import section's body with every imported memory declared shared, up
 * to `maxPages`; the rest of its entries as they are.
 *
 * @param {Uint8Array} bytes @param {number} start @param {number} maxPages
 * @returns {number[]}
 */
const sharedImports = (bytes, start, maxPages)=>{
    /** @type {number[]} */
    const section = [];
    /** @param {number} from @param {number} to */
    const copy = (from, to)=>{
        for (let index = from; index < to; index++)
        {
            section.push(bytes[index]);
        }
    };
    let [count, cursor] = readLeb(bytes, start);
    section.push(...leb(count));
    for (; count > 0; count--)
    {
        const from = cursor;
        for (let name = 0; name < 2; name++)
        {
            const [length, next] = readLeb(bytes, cursor);
            cursor = next + length;
        }
        const kind = bytes[cursor++];
        copy(from, cursor);
        if (kind !== 2)
        {
            // A function's type index, a table's type and limits, a global's
            // type and mutability: copied as they are.
            const descriptor = cursor;
            if (kind === 0)
            {
                cursor = readLeb(bytes, cursor)[1];
            }
            else if (kind === 1)
            {
                const flags = bytes[cursor + 1];
                cursor = readLeb(bytes, cursor + 2)[1];
                if (flags & 1)
                {
                    cursor = readLeb(bytes, cursor)[1];
                }
            }
            else
            {
                cursor += 2;
            }
            copy(descriptor, cursor);
            continue;
        }
        const flags = bytes[cursor];
        const [min, afterMin] = readLeb(bytes, cursor + 1);
        cursor = (flags & 1) ? readLeb(bytes, afterMin)[1] : afterMin;
        section.push(3, ...leb(min), ...leb(maxPages));
    }
    return section;
};

/**
 * The module's bytes with every imported memory shared, up to `maxPages`;
 * a copy of them as they are when it imports none. Only the import section
 * is rebuilt; every other section is copied in one piece, never spread into
 * arguments, which a module's code section is too large for on a worker's
 * stack.
 *
 * @param {Uint8Array} bytes @param {number} [maxPages]
 * @returns {Uint8Array}
 */
export function withSharedMemoryImport(bytes, maxPages = SHARED_MAX_PAGES){
    let at = 8;
    while (at < bytes.length)
    {
        const id = bytes[at];
        const [size, start] = readLeb(bytes, at + 1);
        const end = start + size;
        if (id === 2)
        {
            const section = sharedImports(bytes, start, maxPages);
            const head = [2, ...leb(section.length)];
            const out = new Uint8Array(at + head.length + section.length + bytes.length - end);
            out.set(bytes.subarray(0, at), 0);
            out.set(head, at);
            out.set(section, at + head.length);
            out.set(bytes.subarray(end), at + head.length + section.length);
            return out;
        }
        at = end;
    }
    return bytes.slice();
}
