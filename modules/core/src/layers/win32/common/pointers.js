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

/** The highest address a program may hold on 32-bit Windows, or one not large-address aware. */
export const LOW_USER_TOP = 0x7ffeffff;

/**
 * The highest address a process's program may hold, as GetSystemInfo's
 * lpMaximumApplicationAddress and SystemBasicInformation's
 * MaximumUserModeAddress say it: the last byte below the 64 KiB Windows keeps
 * off the top of the user space, its top here being where the process's arena
 * ends - 0xFFFEFFFF for a 4 GiB process, as a large-address-aware program gets
 * on 64-bit Windows - and never below the 32-bit 0x7FFEFFFF.
 *
 * @param {number} top  where the process's memory ends
 */
export const highestUserAddress = top=>Math.max(LOW_USER_TOP, top - 0x10001);

/**
 * An address as the engine holds it: one below 4 GiB unsigned, whatever sign a
 * dword gave it, and one past 4 GiB - a 64-bit program's image at its own base
 * there - as it is, where `>>> 0` would leave its low dword, another address.
 *
 * @param {number} address
 */
export const wholeAddress = address=>(address >= 2 ** 32 ? address : address >>> 0);

/**
 * A message's WPARAM and LPARAM as a 64-bit caller passed them, where a dword
 * does not say it: user32 keeps both as dwords, a WPARAM widened as the UINT
 * and an LPARAM as the LONG, so a pointer past 2 GiB in an LPARAM (its high
 * half zero, not its sign's ones) and any value past 4 GiB are carried beside
 * the message, whole, to the procedure that takes it.
 *
 * `r` is the answer the procedure gave, set where the dword it resolved with
 * is not the whole of it, for the sender to answer whole (`wholeAnswer`).
 *
 * @typedef {{ w?: bigint, l?: bigint, r?: bigint }} WideParams
 */

/**
 * @param {number} wLow @param {number} wHigh @param {number} lLow @param {number} lHigh
 * @returns {WideParams | undefined}  undefined where the dwords say it all
 */
export const wideParams = (wLow, wHigh, lLow, lHigh)=>{
    const w = (wHigh >>> 0) !== 0;
    const l = (lHigh >>> 0) !== ((lLow | 0) < 0 ? 0xffffffff : 0);
    if (!w && !l)
    {
        return undefined;
    }
    /** @param {number} low @param {number} high */
    const whole = (low, high)=>BigInt(high >>> 0) << 32n | BigInt(low >>> 0);
    return { ...w ? { w: whole(wLow, wHigh) } : {}, ...l ? { l: whole(lLow, lHigh) } : {} };
};

/**
 * The same of a 64-bit call's arguments (`args.high`, the bridge's); undefined
 * for a 32-bit call, whose dwords are the values.
 *
 * @param {number[] & { high?: number[] }} args @param {number} w @param {number} l
 * @param {boolean} [answered]  the caller answers what the procedure does (a
 *     send): a 64-bit one is given a holder for the answer even where its
 *     parameters need none
 */
export const wideOf = (args, w, l, answered = false)=>(args.high
    ? wideParams(args[w], args.high[w], args[l], args.high[l]) ?? (answered ? {} : undefined)
    : undefined);

/**
 * A send's answer for a 64-bit sender: the procedure's whole where it left one
 * that is still the answer's dword, the dword otherwise (the bridge widens it).
 *
 * @param {number | null} result @param {WideParams | undefined} wide
 * @returns {number | bigint | null}
 */
export const wholeAnswer = (result, wide)=>(result !== null && wide?.r !== undefined
    && Number(wide.r & 0xffffffffn) === (result >>> 0) ? wide.r : result);

/**
 * What a procedure is handed for a message's WPARAM and LPARAM: the dwords
 * widened as ever, or the whole value carried beside them where it is still
 * the value of that dword (a message converted on the way has another).
 *
 * @param {{ wParam: number, lParam: number, wide?: WideParams }} message
 * @returns {[number | bigint, number | bigint]}
 */
export const paramsOf = message=>{
    const { w, l } = message.wide ?? {};
    /** @param {bigint | undefined} whole @param {number} dword */
    const still = (whole, dword)=>whole !== undefined
        && Number(whole & 0xffffffffn) === (dword >>> 0);
    return [still(w, message.wParam) ? /** @type {bigint} */ (w) : message.wParam >>> 0,
        still(l, message.lParam) ? /** @type {bigint} */ (l) : message.lParam | 0];
};

/**
 * An argument a handler only hands on to a routine of the program's - an
 * enumeration's context, an APC's parameter: the value as a 64-bit caller
 * passed it, a bigint where a dword widened by its type would not be it, and
 * the dword of a 32-bit caller as it is.
 *
 * @param {number[] & { high?: number[] }} args @param {number} index
 * @param {boolean} [signed]  an LPARAM or a LONG_PTR, widened by its sign;
 *     otherwise a pointer or a ULONG_PTR, by zeros
 * @returns {number | bigint}
 */
export const forwarded = (args, index, signed = false)=>{
    const high = args.high?.[index];
    if (high === undefined)
    {
        return args[index];
    }
    const low = args[index];
    const said = signed && (low | 0) < 0 ? 0xffffffff : 0;
    return (high >>> 0) === said ? (signed ? low | 0 : low >>> 0)
        : BigInt(high >>> 0) << 32n | BigInt(low >>> 0);
};
