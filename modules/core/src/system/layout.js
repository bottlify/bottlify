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
 * and written in place through any view of the guest's memory (`read`,
 * `write`), the kind deciding how; nothing is built per read.
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
 * @typedef {Object} LayoutView
 *     What a field is read and written through: the win32 guest view, or a
 *     buffer's (`bytesView`).
 * @property {(address: number) => number} u8
 * @property {(address: number) => number} u16
 * @property {(address: number) => number} u32
 * @property {(address: number, value: number) => void} set8
 * @property {(address: number, value: number) => void} set16
 * @property {(address: number, value: number) => void} set32
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
 * @type {WeakMap<object, { fields: Field[], byName: Map<string, Field>, width: 4 | 8 }>}
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
        made.set(entry.table, { fields, byName: new Map(fields.map(f=>[f.name, f])), width });
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

/** @param {Table} table @param {string} name */
const scalar = (table, name)=>{
    const field = madeOf(table).byName.get(name);
    if (!field || field.kind === 'struct' || field.count !== 1)
    {
        throw new RangeError(`${name} is not a scalar field of the layout`);
    }
    return field;
};

/** One word a float is reinterpreted through: nothing runs between its write and its read. */
const word = new DataView(new ArrayBuffer(8));

/**
 * A field of the structure at `address`, read where it lies. An address is
 * whole at 8 bytes; a handle is its low dword; a 64-bit integer is a bigint.
 *
 * @param {LayoutView} view @param {number} address @param {Table} table @param {string} name
 * @returns {number | bigint}
 */
export function read(view, address, table, name){
    const { offset, kind, size } = scalar(table, name);
    const at = address + offset;
    switch (kind)
    {
        case 'u8': return view.u8(at);
        case 'i8': return view.u8(at) << 24 >> 24;
        case 'u16': return view.u16(at);
        case 'i16': return view.u16(at) << 16 >> 16;
        case 'u32': case 'handle': return view.u32(at);
        case 'i32': return view.u32(at) | 0;
        case 'ptr': return size === 8 ? view.u32(at) + view.u32(at + 4) * 2 ** 32 : view.u32(at);
        case 'f32':
            word.setUint32(0, view.u32(at), true);
            return word.getFloat32(0, true);
        case 'f64':
            word.setUint32(0, view.u32(at), true);
            word.setUint32(4, view.u32(at + 4), true);
            return word.getFloat64(0, true);
        default: {
            const whole = BigInt(view.u32(at)) | BigInt(view.u32(at + 4)) << 32n;
            return kind === 'i64' ? BigInt.asIntN(64, whole) : whole;
        }
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
 * @param {LayoutView} view @param {number} address @param {Table} table @param {string} name
 * @param {number | bigint} value
 */
export function write(view, address, table, name, value){
    const { offset, kind, size } = scalar(table, name);
    const at = address + offset;
    switch (kind)
    {
        case 'u8': case 'i8': view.set8(at, Number(value) & 0xff); return;
        case 'u16': case 'i16': view.set16(at, Number(value) & 0xffff); return;
        case 'u32': case 'i32': view.set32(at, Number(value) >>> 0); return;
        case 'ptr': case 'handle': {
            const number = Number(value);
            view.set32(at, number < 0 ? number >>> 0 : number % 2 ** 32);
            if (size === 8)
            {
                view.set32(at + 4, highOf(number, kind));
            }
            return;
        }
        case 'f32':
            word.setFloat32(0, Number(value), true);
            view.set32(at, word.getUint32(0, true));
            return;
        case 'f64':
            word.setFloat64(0, Number(value), true);
            view.set32(at, word.getUint32(0, true));
            view.set32(at + 4, word.getUint32(4, true));
            return;
        default: {
            const whole = BigInt.asUintN(64, BigInt(value));
            view.set32(at, Number(whole & 0xffffffffn));
            view.set32(at + 4, Number(whole >> 32n));
        }
    }
}

/**
 * A view of a host buffer, for a structure put together before it is
 * written whole: the buffer's offsets are its addresses.
 *
 * @param {Uint8Array} bytes
 * @returns {LayoutView}
 */
export function bytesView(bytes){
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
        u8: at=>view.getUint8(at),
        u16: at=>view.getUint16(at, true),
        u32: at=>view.getUint32(at, true),
        set8: (at, value)=>view.setUint8(at, value),
        set16: (at, value)=>view.setUint16(at, value, true),
        set32: (at, value)=>view.setUint32(at, value, true),
    };
}

/** windef.h's POINT, which structures of every layer embed. */
export const POINT = struct([['x', 'i32'], ['y', 'i32']]);

/** windef.h's RECT: left, top, right, bottom. */
export const RECT = struct([['left', 'i32'], ['top', 'i32'], ['right', 'i32'], ['bottom', 'i32']]);

/** guiddef.h's GUID: a DWORD, two WORDs and eight bytes, on a four-byte boundary. */
export const GUID = struct([['Data1', 'u32'], ['Data2', 'u16'], ['Data3', 'u16'],
    ['Data4', 'u8', 8]]);
