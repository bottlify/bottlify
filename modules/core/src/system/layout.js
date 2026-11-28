/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A structure's layout, declared once as the SDK header declares it - its
 * fields in order, each with its kind - and laid out at either pointer width
 * by the compiler's rule: every field on its natural alignment (at most the
 * structure's `pack`), the structure on its most aligned field's, its size
 * rounded up to that. Offsets are derived, never written by hand: a table of
 * them kept beside a header drifted from it a field at a time, and a field
 * read one slot off is a plausible number, not an error.
 *
 * `layout.at(width)` is the structure at a width as a frozen table, each
 * named field's offset and `SIZE`: what every caller indexes. A field is read
 * and written in place through a memory port (`read`, `write`): the guest's
 * (`system/port.js`), or a host buffer's (`bufferPort`) for a structure put
 * together before it is written whole; the kind picks the port's call, and
 * nothing is built per read.
 *
 * Kinds: `u8` `i8` `u16` `i16` `u32` `i32` `f32` `u64` `i64` `f64`; `ptr`,
 * an address or a value of its size (UINT_PTR, WPARAM, SIZE_T), unsigned and
 * whole; `handle`, a handle or a LONG_PTR (HWND, LPARAM, LRESULT), held by
 * the engine as its low dword and sign-extended into a 64-bit field, so
 * HWND_TOPMOST is -1 whole; another layout, embedded; any of these with a
 * count, an array (a fixed string is `u8` or `u16` with its length). A field
 * whose name is null takes its room and has no name: a reserved field, or
 * one no caller reads. A nested layout with no name is C's anonymous member:
 * its fields are named in the outer table at their offset there, as an
 * anonymous union's are.
 */

/**
 * @typedef {'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32' | 'f32' | 'u64' | 'i64' | 'f64'
 *     | 'ptr' | 'handle'} Scalar
 * @typedef {readonly [string | null, Scalar | Layout]
 *     | readonly [string | null, Scalar | Layout, number]} Declared
 * @typedef {Readonly<Record<string, number>> & { readonly SIZE: number }} Table
 * @typedef {{ name: string, offset: number, kind: Scalar | 'struct', size: number,
 *     count: number }} Field
 *     One named field at a width: `size` one element's bytes, `count` 1 unless an array.
 * @typedef {import('./port.js').Port} Port
 */

/** The bytes of each scalar kind; `ptr` and `handle` are the width's. */
const BYTES = Object.freeze({ u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, f32: 4,
    u64: 8, i64: 8, f64: 8, ptr: 0, handle: 0 });

/** @param {Scalar | Layout} kind @param {4 | 8} width */
const sizeOfKind = (kind, width)=>(typeof kind === 'string'
    ? BYTES[kind] || width : kind.sizeOf(width));
/** @param {Scalar | Layout} kind @param {4 | 8} width */
const alignOfKind = (kind, width)=>(typeof kind === 'string'
    ? BYTES[kind] || width : kind.alignOf(width));

/**
 * Each table a layout made, to what it holds at its width.
 *
 * @type {WeakMap<object, { fields: Field[], byName: Map<string, Field>, width: 4 | 8,
 *     layout: Layout }>}
 */
const made = new WeakMap();

/**
 * @typedef {Object} Layout
 * @property {(width?: number) => Table} at  4 or 8; 4 by default
 * @property {(width?: number) => number} sizeOf
 * @property {(width?: number) => number} alignOf
 * @property {(name: string, width?: number) => number} offsetOf
 *     A named field's offset; a field it does not have is a RangeError.
 * @property {(width: 4 | 8) => readonly Field[]} fields  its named fields at a width, by offset
 */

/**
 * @param {readonly Declared[]} declared
 * @param {{ union?: boolean, pack?: number }} options
 * @returns {Layout}
 */
function define(declared, { union = false, pack = 8 }){
    /** @type {Map<number, { table: Table, fields: Field[], align: number }>} */
    const widths = new Map();
    /** @param {number} [requested] */
    const laid = (requested = 4)=>{
        const width = requested === 8 ? 8 : 4;
        const known = widths.get(width);
        if (known)
        {
            return known;
        }
        /** @type {Record<string, number>} */
        const table = {};
        /** @type {Field[]} */
        const fields = [];
        /** @param {string} label @param {number} offset @param {Omit<Field, 'name' | 'offset'>} rest */
        const name = (label, offset, rest)=>{
            if (Object.hasOwn(table, label) || label === 'SIZE')
            {
                throw new TypeError(`a layout names ${label} twice`);
            }
            table[label] = offset;
            fields.push({ ...rest, name: label, offset });
        };
        let end = 0;
        let align = 1;
        for (const [field, kind, count = 1] of declared)
        {
            const fieldAlign = Math.min(alignOfKind(kind, width), pack);
            const size = sizeOfKind(kind, width);
            const offset = union ? 0 : Math.ceil(end / fieldAlign) * fieldAlign;
            align = Math.max(align, fieldAlign);
            end = Math.max(end, offset + size * count);
            if (field !== null)
            {
                name(field, offset, { kind: typeof kind === 'string' ? kind : 'struct', size,
                    count });
            }
            else if (typeof kind !== 'string')
            {
                for (const inner of kind.fields(width))
                {
                    name(inner.name, offset + inner.offset, inner);
                }
            }
        }
        table.SIZE = Math.ceil(end / align) * align;
        fields.sort((a, b)=>a.offset - b.offset);
        const entry = { table: /** @type {Table} */ (Object.freeze(table)), fields, align };
        made.set(entry.table, { fields, byName: new Map(fields.map(f=>[f.name, f])), width,
            layout });
        widths.set(width, entry);
        return entry;
    };
    const layout = {
        /** @param {number} [width] */
        at: width=>laid(width).table,
        /** @param {number} [width] */
        sizeOf: width=>laid(width).table.SIZE,
        /** @param {number} [width] */
        alignOf: width=>laid(width).align,
        /** @param {string} field @param {number} [width] */
        offsetOf: (field, width)=>{
            const { table } = laid(width);
            if (!Object.hasOwn(table, field) || field === 'SIZE')
            {
                throw new RangeError(`the layout has no field ${field}`);
            }
            return table[field];
        },
        /** @param {4 | 8} width */
        fields: width=>laid(width).fields,
    };
    return Object.freeze(layout);
}

/**
 * A structure, its fields in the header's order.
 *
 * @param {readonly Declared[]} fields
 * @param {{ pack?: number }} [options]  `pack`: `#pragma pack`'s, where the header sets one
 */
export const struct = (fields, options = {})=>define(fields, options);

/**
 * A union: every member at its start, its size the largest's. A member given
 * as a list of fields is an anonymous structure, its names the union's.
 *
 * @param {readonly (Declared | readonly Declared[])[]} members
 */
export const union = members=>define(members.map(member=>(Array.isArray(member[0])
    ? /** @type {Declared} */ ([null, struct(/** @type {readonly Declared[]} */ (member))])
    : /** @type {Declared} */ (member))), { union: true });

/** @param {object} table */
const madeOf = table=>{
    const entry = made.get(table);
    if (!entry)
    {
        throw new TypeError('not a table a layout made');
    }
    return entry;
};

/**
 * A table's named fields by offset, with their kinds: for a caller that
 * walks a whole structure.
 *
 * @param {Table} table
 * @returns {readonly Field[]}
 */
export const fieldsOf = table=>madeOf(table).fields;

/**
 * A table's field by name; undefined for a name it does not have, or for a
 * table no layout made (a caller handed either kind asks what a field is).
 *
 * @param {Readonly<Record<string, number>>} table @param {string} name
 * @returns {Field | undefined}
 */
export const fieldOf = (table, name)=>made.get(table)?.byName.get(name);

/** The width a table was laid out at. @param {Table} table @returns {4 | 8} */
export const widthOf = table=>madeOf(table).width;

/**
 * The layout a table was laid out from: a module that exports its
 * structures at the width its callers use hands the other width out too.
 *
 * @param {Table} table @returns {Layout}
 */
export const layoutOf = table=>madeOf(table).layout;

/** @param {Table} table @param {string} name */
const scalar = (table, name)=>{
    const field = madeOf(table).byName.get(name);
    if (!field || field.kind === 'struct' || field.count !== 1)
    {
        throw new RangeError(`${name} is not a scalar field of the layout`);
    }
    return field;
};

/**
 * A field of the structure at `address`, read where it lies. An address is
 * whole at 8 bytes; a handle is its low dword; a 64-bit integer is a bigint.
 *
 * @param {Port} port @param {number} address @param {Table} table @param {string} name
 * @returns {number | bigint}
 */
export function read(port, address, table, name){
    const { offset, kind, size } = scalar(table, name);
    const at = address + offset;
    switch (kind)
    {
        case 'u8': return port.u8(at);
        case 'i8': return port.i8(at);
        case 'u16': return port.u16(at);
        case 'i16': return port.i16(at);
        case 'u32': case 'handle': return port.u32(at);
        case 'i32': return port.i32(at);
        // The field's width, not the port's: a structure of the other width is read as laid out.
        case 'ptr': return size === 8 ? port.u32(at) + port.u32(at + 4) * 2 ** 32 : port.u32(at);
        case 'f32': return port.f32(at);
        case 'f64': return port.f64(at);
        case 'u64': return port.u64(at);
        default: return port.i64(at);
    }
}

/**
 * The two dwords a pointer-sized field at 8 bytes holds for `value`, its
 * kind saying how a 32-bit value widens: an address past 4 GiB is held whole
 * and goes back whole; below it, a handle's high dword is its sign, an
 * address's zero.
 *
 * @param {number} value @param {'ptr' | 'handle'} kind
 * @returns {number} the high dword
 */
export const highOf = (value, kind)=>(value >= 2 ** 32 ? Math.floor(value / 2 ** 32) >>> 0
    : kind === 'handle' && (value | 0) < 0 ? 0xffffffff : 0);

/**
 * A field of the structure at `address`, written in place; the fields beside
 * it are left as they were.
 *
 * @param {Port} port @param {number} address @param {Table} table @param {string} name
 * @param {number | bigint} value
 */
export function write(port, address, table, name, value){
    const { offset, kind, size } = scalar(table, name);
    const at = address + offset;
    switch (kind)
    {
        case 'u8': case 'i8': port.set8(at, Number(value)); return;
        case 'u16': case 'i16': port.set16(at, Number(value)); return;
        case 'u32': case 'i32': port.set32(at, Number(value)); return;
        case 'ptr': case 'handle': {
            const number = Number(value);
            port.set32(at, number < 0 ? number >>> 0 : number % 2 ** 32);
            if (size === 8)
            {
                port.set32(at + 4, highOf(number, kind));
            }
            return;
        }
        case 'f32': port.setF32(at, Number(value)); return;
        case 'f64': port.setF64(at, Number(value)); return;
        default: port.set64(at, value);
    }
}

/** windef.h's POINT, which structures of every layer embed. */
export const POINT = struct([['x', 'i32'], ['y', 'i32']]);

/** windef.h's RECT: left, top, right, bottom. */
export const RECT = struct([['left', 'i32'], ['top', 'i32'], ['right', 'i32'], ['bottom', 'i32']]);

/** guiddef.h's GUID: a DWORD, two WORDs and eight bytes, on a four-byte boundary. */
export const GUID = struct([['Data1', 'u32'], ['Data2', 'u16'], ['Data3', 'u16'],
    ['Data4', 'u8', 8]]);
