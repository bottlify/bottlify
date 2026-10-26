/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A guest pointer's width: 4 bytes in a 32-bit process, 8 in a 64-bit one,
 * and with it every pointer-sized field a handler lays out -- `char **`
 * arrays, a FILE's `_ptr`, a `SIZE_T`, a `DWORD_PTR` mask.
 *
 * A 64-bit process runs in a 4 GiB window, so a pointer's value is a number
 * either way: an 8-byte write leaves the high half zero, an 8-byte read keeps
 * the low half, which is the whole address.
 */

/**
 * @typedef {Object} PointerWidth
 * @property {4 | 8} size
 * @property {(view: DataView, offset: number, value: number) => void} set
 * @property {(view: DataView, offset: number) => number} get
 * @property {(value: number) => Uint8Array} bytes  one pointer, as memory holds it
 * @property {(values: number[]) => Uint8Array} array  the pointers and a null after them
 */

/** @type {Map<number, PointerWidth>} */
const widths = new Map();

/**
 * @param {number} [size]  4 or 8; 4 by default, which is every 32-bit host's
 * @returns {PointerWidth}
 */
export function pointerWidth(size = 4){
    const known = widths.get(size);
    if (known)
    {
        return known;
    }
    if (size !== 4 && size !== 8)
    {
        throw new RangeError(`a pointer is 4 or 8 bytes, not ${size}`);
    }
    /** @type {(view: DataView, offset: number, value: number) => void} */
    const set = size === 8
        ? (view, offset, value)=>{
            view.setUint32(offset, value >>> 0, true);
            view.setUint32(offset + 4, 0, true);
        }
        : (view, offset, value)=>view.setUint32(offset, value >>> 0, true);
    /** @type {PointerWidth} */
    const width = {
        size,
        set,
        get: (view, offset)=>view.getUint32(offset, true),
        bytes: value=>{
            const bytes = new Uint8Array(size);
            set(new DataView(bytes.buffer), 0, value);
            return bytes;
        },
        array: values=>{
            const bytes = new Uint8Array((values.length + 1) * size);
            const view = new DataView(bytes.buffer);
            values.forEach((value, index)=>set(view, index * size, value));
            return bytes;
        },
    };
    widths.set(size, width);
    return width;
}
