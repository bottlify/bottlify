/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Protocol buffers, as far as Steam's messages use them.
 *
 * A message is described by a schema -- each field's name, number and type,
 * from Valve's published .proto definitions -- and travels as a plain object.
 * Only the fields a schema names are read; the rest of a message is skipped,
 * so a schema lists what we use and a server adding fields breaks nothing.
 * 64-bit integers are BigInts: a Steam ID or a job id does not fit a double.
 */

/**
 * @typedef {'uint32' | 'int32' | 'uint64' | 'fixed32' | 'fixed64' | 'bool' | 'string'
 *     | 'bytes' | 'float'} Scalar
 * @typedef {[number, Scalar | Schema] | [number, Scalar | Schema, 'repeated']} Field
 * @typedef {{ [name: string]: Field }} Schema
 */

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH = 2;
const WIRE_FIXED32 = 5;

/** @param {Scalar | Schema} type */
const wireOf = type=>{
    switch (type)
    {
        case 'fixed64': return WIRE_FIXED64;
        case 'fixed32': case 'float': return WIRE_FIXED32;
        case 'uint32': case 'int32': case 'uint64': case 'bool': return WIRE_VARINT;
        default: return WIRE_LENGTH;
    }
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Encodes a message.
 *
 * @param {Schema} schema
 * @param {Record<string, any>} message
 * @returns {Uint8Array}
 */
export function encode(schema, message){
    /** @type {number[]} */
    const out = [];
    /** @param {bigint} value */
    const varint = value=>{
        let left = BigInt.asUintN(64, value);
        while (left > 0x7Fn)
        {
            out.push(Number(left & 0x7Fn) | 0x80);
            left >>= 7n;
        }
        out.push(Number(left));
    };
    /** @param {Uint8Array} bytes */
    const raw = bytes=>{
        for (const byte of bytes)
        {
            out.push(byte);
        }
    };
    /** @param {number} value @param {number} size */
    const little = (value, size)=>{
        for (let at = 0; at < size; at++)
        {
            out.push((value >>> (at * 8)) & 0xFF);
        }
    };
    for (const [name, field] of Object.entries(schema))
    {
        const value = message[name];
        if (value === undefined || value === null)
        {
            continue;
        }
        const [number, type, repeated] = field;
        for (const item of repeated ? value : [value])
        {
            varint(BigInt(number * 8 + wireOf(type)));
            switch (type)
            {
                case 'uint32': varint(BigInt(item >>> 0)); break;
                // A negative int32 is ten bytes, sign-extended to 64 bits.
                case 'int32': varint(BigInt(item | 0)); break;
                case 'uint64': varint(BigInt(item)); break;
                case 'bool': varint(item ? 1n : 0n); break;
                case 'fixed32': little(item >>> 0, 4); break;
                case 'float':
                {
                    const view = new DataView(new ArrayBuffer(4));
                    view.setFloat32(0, item, true);
                    raw(new Uint8Array(view.buffer));
                    break;
                }
                case 'fixed64':
                {
                    const view = new DataView(new ArrayBuffer(8));
                    view.setBigUint64(0, BigInt.asUintN(64, BigInt(item)), true);
                    raw(new Uint8Array(view.buffer));
                    break;
                }
                default:
                {
                    const bytes = type === 'string' ? encoder.encode(item)
                        : type === 'bytes' ? item
                            : encode(/** @type {Schema} */ (type), item);
                    varint(BigInt(bytes.length));
                    raw(bytes);
                }
            }
        }
    }
    return Uint8Array.from(out);
}

/**
 * Decodes a message; a repeated field is an array even when absent.
 *
 * @param {Schema} schema
 * @param {Uint8Array} bytes
 * @returns {Record<string, any>}
 */
export function decode(schema, bytes){
    /** @type {Map<number, [string, Field]>} */
    const byNumber = new Map();
    /** @type {Record<string, any>} */
    const message = {};
    for (const [name, field] of Object.entries(schema))
    {
        byNumber.set(field[0], [name, field]);
        if (field[2])
        {
            message[name] = [];
        }
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = 0;
    const varint = ()=>{
        let value = 0n;
        let shift = 0n;
        for (;;)
        {
            if (at >= bytes.length)
            {
                throw new RangeError('protobuf: a varint runs past the message');
            }
            const byte = bytes[at++];
            value |= BigInt(byte & 0x7F) << shift;
            if (!(byte & 0x80))
            {
                return value;
            }
            shift += 7n;
        }
    };
    /** @param {number} length */
    const take = length=>{
        if (at + length > bytes.length)
        {
            throw new RangeError('protobuf: a field runs past the message');
        }
        const slice = bytes.subarray(at, at + length);
        at += length;
        return slice;
    };
    /** @param {Scalar | Schema} type @param {number} wire */
    const scalar = (type, wire)=>{
        switch (wire)
        {
            case WIRE_VARINT:
            {
                const value = varint();
                return type === 'uint64' ? value
                    : type === 'bool' ? value !== 0n
                        : type === 'int32' ? Number(BigInt.asIntN(32, value))
                            : Number(BigInt.asUintN(32, value));
            }
            case WIRE_FIXED64:
            {
                const value = view.getBigUint64(take(8).byteOffset - bytes.byteOffset, true);
                return value;
            }
            case WIRE_FIXED32:
            {
                const offset = take(4).byteOffset - bytes.byteOffset;
                return type === 'float' ? view.getFloat32(offset, true)
                    : view.getUint32(offset, true);
            }
            default:
                throw new RangeError(`protobuf: wire type ${wire} where a scalar was expected`);
        }
    };
    while (at < bytes.length)
    {
        const key = Number(varint());
        const wire = key & 7;
        const known = byNumber.get(key >>> 3);
        if (!known)
        {
            switch (wire)
            {
                case WIRE_VARINT: varint(); break;
                case WIRE_FIXED64: take(8); break;
                case WIRE_LENGTH: take(Number(varint())); break;
                case WIRE_FIXED32: take(4); break;
                default: throw new RangeError(`protobuf: wire type ${wire} cannot be skipped`);
            }
            continue;
        }
        const [name, [, type, repeated]] = known;
        /** @type {any[]} */
        const values = [];
        if (wire === WIRE_LENGTH && typeof type === 'object')
        {
            values.push(decode(type, take(Number(varint()))));
        }
        else if (wire === WIRE_LENGTH && (type === 'string' || type === 'bytes'))
        {
            const slice = take(Number(varint()));
            values.push(type === 'string' ? decoder.decode(slice) : slice.slice());
        }
        else if (wire === WIRE_LENGTH)
        {
            // A packed run of scalars.
            const end = at + Number(varint());
            // scalar() moves `at` on, which the loop condition cannot see.
            for (;;)
            {
                if (at >= end)
                {
                    break;
                }
                values.push(scalar(type, wireOf(type)));
            }
        }
        else
        {
            values.push(scalar(type, wire));
        }
        if (repeated)
        {
            message[name].push(...values);
        }
        else
        {
            message[name] = values[values.length - 1];
        }
    }
    return message;
}
