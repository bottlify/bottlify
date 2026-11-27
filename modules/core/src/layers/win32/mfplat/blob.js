/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A store of attributes as bytes, for MFGetAttributesAsBlob and
 * MFInitAttributesFromBlob: what a program keeps a media type in (a
 * registry value, a file) and makes it again from.
 *
 * Microsoft documents the calls, not the bytes; the bytes are only ever read
 * back by the same calls, so the layout is this machine's: a header of a
 * magic word and a count, then for each item its key, its type and a value
 * word (a UINT32, or the length of a variable value) and a value quadword
 * (a UINT64 or a double, a GUID's or string's or blob's offset from the
 * blob's start), the variable values after the items. An empty store is
 * eight bytes, as Windows' is (Wine's test_attributes_serialization). An
 * interface value is not written: it cannot outlive the process that holds
 * it.
 */

import { TYPE } from './attributes.js';
import { utf16z } from '../common/utf16.js';

const MAGIC = 0x41464d49; // 'IMFA'
const HEADER = 8;
const ITEM = 16 + 4 + 4 + 8;

/** @typedef {import('./attributes.js').Item} Item */

/**
 * The bytes of a variable-length value, or null for a fixed one.
 *
 * @param {Item} item @param {(guid: string) => Uint8Array} guidBytes
 * @returns {Uint8Array | null}
 */
const variable = (item, guidBytes)=>{
    switch (item.vt)
    {
        case TYPE.GUID:
            return guidBytes(item.value);
        case TYPE.STRING:
            return utf16z(item.value);
        case TYPE.BLOB:
            return Uint8Array.from(item.value);
        default:
            return null;
    }
};

/**
 * @param {Map<string, Item>} items @param {(guid: string) => Uint8Array} guidBytes
 * @returns {Uint8Array}
 */
export function serialize(items, guidBytes){
    const kept = [...items].filter(([, item])=>item.vt !== TYPE.IUNKNOWN && item.vt !== TYPE.EMPTY);
    const tails = kept.map(([, item])=>variable(item, guidBytes));
    const size = HEADER + kept.length * ITEM
        + tails.reduce((sum, tail)=>sum + (tail?.length ?? 0), 0);
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, MAGIC, true);
    view.setUint32(4, kept.length, true);
    let tailAt = HEADER + kept.length * ITEM;
    kept.forEach(([key, item], index)=>{
        const at = HEADER + index * ITEM;
        bytes.set(guidBytes(key), at);
        view.setUint32(at + 16, item.vt, true);
        const tail = tails[index];
        if (tail)
        {
            view.setUint32(at + 20, tail.length, true);
            view.setBigUint64(at + 24, BigInt(tailAt), true);
            bytes.set(tail, tailAt);
            tailAt += tail.length;
        }
        else if (item.vt === TYPE.UINT32)
        {
            view.setUint32(at + 20, item.value >>> 0, true);
        }
        else if (item.vt === TYPE.UINT64)
        {
            view.setBigUint64(at + 24, BigInt.asUintN(64, item.value), true);
        }
        else
        {
            view.setFloat64(at + 24, item.value, true);
        }
    });
    return bytes;
}

/**
 * The items a blob holds, or null for bytes that are not one: short, of
 * another magic, or with a value outside them.
 *
 * @param {Uint8Array} bytes @param {(at: Uint8Array) => string} guidOf
 * @returns {Map<string, Item> | null}
 */
export function deserialize(bytes, guidOf){
    if (bytes.length < HEADER)
    {
        return null;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const count = view.getUint32(4, true);
    if (view.getUint32(0, true) !== MAGIC || HEADER + count * ITEM > bytes.length)
    {
        return null;
    }
    /** @type {Map<string, Item>} */
    const items = new Map();
    for (let index = 0; index < count; index++)
    {
        const at = HEADER + index * ITEM;
        const key = guidOf(bytes.subarray(at, at + 16));
        const vt = view.getUint32(at + 16, true);
        const length = view.getUint32(at + 20, true);
        const offset = Number(view.getBigUint64(at + 24, true));
        const tail = ()=>(offset + length <= bytes.length
            ? bytes.subarray(offset, offset + length) : null);
        switch (vt)
        {
            case TYPE.UINT32:
                items.set(key, { vt, value: length });
                break;
            case TYPE.UINT64:
                items.set(key, { vt, value: view.getBigUint64(at + 24, true) });
                break;
            case TYPE.DOUBLE:
                items.set(key, { vt, value: view.getFloat64(at + 24, true) });
                break;
            case TYPE.GUID:
            case TYPE.STRING:
            case TYPE.BLOB:
            {
                const value = tail();
                if (!value)
                {
                    return null;
                }
                items.set(key, { vt, value: vt === TYPE.GUID ? guidOf(value)
                    : vt === TYPE.BLOB ? Uint8Array.from(value)
                        : String.fromCharCode(...new Uint16Array(value.slice(0, length - 2)
                            .buffer)) });
                break;
            }
            default:
                return null;
        }
    }
    return items;
}
