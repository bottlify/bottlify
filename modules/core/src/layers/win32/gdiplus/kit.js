/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What every family of GDI+'s flat API shares: its status codes, the one
 * table of objects its handles name, and guest memory read and written in
 * the shapes the API passes - REALs, points, rectangles, pointers.
 *
 * An object is held by kind ('matrix', 'path', 'brush'...): a handle of
 * another kind is no object to a call, which answers InvalidParameter as
 * GDI+ answers a pointer it does not recognise.
 */

import { pointerWidth } from '../common/pointers.js';

/** GpStatus (gdiplustypes.h). */
export const Status = Object.freeze({
    Ok: 0, GenericError: 1, InvalidParameter: 2, OutOfMemory: 3, ObjectBusy: 4,
    InsufficientBuffer: 5, NotImplemented: 6, Win32Error: 7, WrongState: 8, Aborted: 9,
    FileNotFound: 10, ValueOverflow: 11, AccessDenied: 12, UnknownImageFormat: 13,
    FontFamilyNotFound: 14, FontStyleNotFound: 15, NotTrueTypeFont: 16,
    UnsupportedGdiplusVersion: 17, GdiplusNotInitialized: 18, PropertyNotFound: 19,
    PropertyNotSupported: 20,
});

/** Handles of their own, as pointers would be: never zero, never a guest address used. */
const HANDLE_BASE = 0x5e000000;
const HANDLE_STRIDE = 16;

/**
 * @typedef {Object} KitHost
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {4 | 8} [pointerSize]
 * @property {(api: string, detail: string, kind?: string) => void} [divergence]
 */

/**
 * @param {KitHost} host
 */
export function createKit(host){
    const pointer = pointerWidth(host.pointerSize ?? 4);
    /** @type {Map<number, { kind: string, value: any }>} */
    const objects = new Map();
    /** The divergences said: each once. @type {Set<string>} */
    const said = new Set();
    let next = HANDLE_BASE;

    const handle = ()=>{
        const made = next;
        next += HANDLE_STRIDE;
        return made;
    };

    /** @param {number} address @param {Uint8Array} bytes */
    const write = (address, bytes)=>host.writeMemory(address >>> 0, bytes);
    /** @param {number} address @param {number} length */
    const read = (address, length)=>host.readMemory(address >>> 0, length).slice();
    /** @param {number} address @param {number} length */
    const view = (address, length)=>new DataView(read(address, length).buffer);

    const kit = {
        Status,
        pointer,
        handle,

        /**
         * A new object of `kind`, its handle written to `out` when one is given.
         *
         * @param {string} kind @param {any} value @param {number} [out]
         * @returns {number} the handle
         */
        add(kind, value, out = 0){
            const made = handle();
            objects.set(made, { kind, value });
            if ((out >>> 0) !== 0)
            {
                kit.putPointer(out, made);
            }
            return made;
        },
        /**
         * The object a handle names, if it is of `kind` (any of them, given
         * several); undefined for any other.
         *
         * @param {number} at @param {...string} kinds
         * @returns {any}
         */
        get(at, ...kinds){
            const held = objects.get(at >>> 0);
            return held && kinds.includes(held.kind) ? held.value : undefined;
        },
        /** @param {number} at */
        kindOf: at=>objects.get(at >>> 0)?.kind,
        /** @param {number} at @param {...string} kinds */
        remove(at, ...kinds){
            const held = objects.get(at >>> 0);
            if (!held || !kinds.includes(held.kind))
            {
                return false;
            }
            objects.delete(at >>> 0);
            return true;
        },

        /** A REAL argument, as its bits arrive. @param {number} bits */
        real: bits=>new Float32Array(Uint32Array.of(bits >>> 0).buffer)[0],
        /** A REAL's bits, to hand back where a REAL is returned. @param {number} value */
        bits: value=>new Uint32Array(Float32Array.of(value).buffer)[0],

        read,
        write,
        view,
        /** @param {number} address */
        u32: address=>view(address, 4).getUint32(0, true),
        /** @param {number} address */
        i32: address=>view(address, 4).getInt32(0, true),
        /** @param {number} address */
        f32: address=>view(address, 4).getFloat32(0, true),
        /** @param {number} address @param {number} count */
        f32s(address, count){
            const data = view(address, count * 4);
            return Array.from({ length: count }, (_, at)=>data.getFloat32(at * 4, true));
        },
        /** @param {number} address @param {number} count */
        i32s(address, count){
            const data = view(address, count * 4);
            return Array.from({ length: count }, (_, at)=>data.getInt32(at * 4, true));
        },
        /** @param {number} address @param {number} value */
        putU32: (address, value)=>write(address,
            new Uint8Array(Uint32Array.of(value >>> 0).buffer)),
        /** @param {number} address @param {number} value */
        putI32: (address, value)=>write(address, new Uint8Array(Int32Array.of(value | 0).buffer)),
        /** @param {number} address @param {number} value */
        putF32: (address, value)=>write(address, new Uint8Array(Float32Array.of(value).buffer)),
        /** @param {number} address @param {number[]} values */
        putF32s: (address, values)=>write(address,
            new Uint8Array(Float32Array.from(values).buffer)),
        /** @param {number} address @param {number[]} values */
        putI32s: (address, values)=>write(address, new Uint8Array(Int32Array.from(values).buffer)),
        /** @param {number} address @param {number} value */
        putPointer: (address, value)=>write(address, pointer.bytes(value)),
        /** @param {number} address */
        pointerAt: address=>pointer.get(view(address, pointer.size), 0),
        /** A BOOL out-parameter. @param {number} address @param {boolean} value */
        putBool: (address, value)=>write(address,
            new Uint8Array(Uint32Array.of(value ? 1 : 0).buffer)),

        /**
         * Points the caller passed: `count` of them, REALs or INTs, as
         * [x, y] pairs of numbers.
         *
         * @param {number} address @param {number} count @param {boolean} [integers]
         * @returns {[number, number][]}
         */
        points(address, count, integers = false){
            const values = integers ? kit.i32s(address, count * 2) : kit.f32s(address, count * 2);
            return Array.from({ length: count }, (_, at)=>[values[at * 2], values[at * 2 + 1]]);
        },
        /**
         * @param {number} address @param {[number, number][]} points
         * @param {boolean} [integers]  rounded, as GDI+ rounds to an integer point
         */
        putPoints(address, points, integers = false){
            const flat = points.flat();
            if (integers)
            {
                kit.putI32s(address, flat.map(value=>Math.round(value)));
            }
            else
            {
                kit.putF32s(address, flat);
            }
        },

        /**
         * Says once that a call does less than GDI+'s, and answers its status.
         *
         * @param {string} api @param {string} detail @param {number} [status]
         * @param {string} [kind]  'loss' for something the program made that did not happen
         */
        diverge(api, detail, status = Status.NotImplemented, kind = undefined){
            const key = `${api}:${detail}`;
            if (!said.has(key))
            {
                said.add(key);
                host.divergence?.(api, detail, kind);
            }
            return status;
        },
    };
    return kit;
}

/** @typedef {ReturnType<typeof createKit>} Kit */

/**
 * An export: its argument bytes at 32 bits and what it does.
 *
 * @param {number} argBytes @param {(args: number[]) => any} handler
 */
/**
 * An export: its 32-bit argument bytes, its handler, and the arguments that
 * are not a dword by value (`floats`: a REAL, which an x86-64 caller passes
 * in an XMM register), for the bridge to read back into that layout.
 *
 * @param {number} argBytes @param {(args: number[]) => any} handler
 * @param {{ floats?: Record<number, 'f32' | 'f64'> }} [wide]
 */
export const fn = (argBytes, handler, wide = {})=>({ argBytes, handler, ...wide });
