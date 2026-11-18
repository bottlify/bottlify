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
 * A pointer is a number either way, whole up to 2^53: an 8-byte write puts its
 * upper dword in (zero for an address below 4 GiB), an 8-byte read takes it
 * back. This is the codec for a block put together in a buffer before it is
 * written; a single pointer written into guest memory in place goes through
 * the memory layer's `writePointer`, whose rule is the same.
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
            const whole = value < 0 ? value >>> 0 : value;
            view.setUint32(offset, whole % 2 ** 32, true);
            view.setUint32(offset + 4, Math.floor(whole / 2 ** 32), true);
        }
        : (view, offset, value)=>view.setUint32(offset, value >>> 0, true);
    /** @type {(view: DataView, offset: number) => number} */
    const get = size === 8
        ? (view, offset)=>view.getUint32(offset, true) + view.getUint32(offset + 4, true) * 2 ** 32
        : (view, offset)=>view.getUint32(offset, true);
    /** @type {PointerWidth} */
    const width = {
        size,
        set,
        get,
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

/**
 * A pointer argument whole: its low dword, which every handler is given, and
 * the high one a 64-bit call carries beside it (the bridge's `args.high`). A
 * wide window's image and its data lie past 4 GiB (cork's `wideLayout`); in a
 * 32-bit process, or a 64-bit one in 4 GiB, the high half is zero and this is
 * the low dword unsigned.
 *
 * @param {number[] & { high?: number[] }} args @param {number} index
 */
export const pointerArg = (args, index)=>(args.high?.[index] ?? 0) * 2 ** 32
    + (args[index] >>> 0);

/**
 * A pointer of a host's width read and written in guest memory, whole, through
 * the host's own `readMemory` and `writeMemory`: what a library given those two
 * and a pointer size uses for every pointer-sized field it reads or answers
 * through, rather than a dword of its own and a zero beside it.
 *
 * @param {{ readMemory: (address: number, length: number) => Uint8Array,
 *     writeMemory: (address: number, bytes: Uint8Array) => void }} host
 * @param {number} [size]  4 or 8
 * @returns {{ read: (address: number) => number,
 *     write: (address: number, value: number) => void }}
 */
export function pointerIo(host, size = 4){
    const width = pointerWidth(size);
    return {
        read: address=>{
            const bytes = host.readMemory(address, width.size);
            return width.get(new DataView(bytes.buffer, bytes.byteOffset, width.size), 0);
        },
        write: (address, value)=>host.writeMemory(address, width.bytes(value)),
    };
}
