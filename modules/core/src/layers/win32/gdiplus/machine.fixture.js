/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GDI+'s exports over a fake guest memory, for the families' tests: a call
 * by name with REALs passed as their bits, as the guest passes them, and
 * the shapes the API hands back read out of memory.
 */

import { createGdiplusFunctions } from './functions.js';

/** @param {Record<string, any>} [more] */
export function gdiplusMachine(more = {}){
    const memory = new Uint8Array(0x40000);
    const view = new DataView(memory.buffer);
    let heap = 0x20000;
    /** @type {string[]} */
    const said = [];
    const fns = /** @type {Record<string, { handler: (args: number[]) => any }>} */ (
        /** @type {unknown} */ (createGdiplusFunctions({
            writeMemory: (address, bytes)=>memory.set(bytes, address),
            readMemory: (address, length)=>memory.subarray(address, address + length),
            allocate: bytes=>{
                const at = heap;
                heap += Math.ceil(bytes / 16) * 16;
                return at;
            },
            free: ()=>{},
            divergence: (api, detail)=>said.push(`${api}: ${detail}`),
            ...more,
        })));
    /** A scratch slot for each out-parameter, far from what tests write. */
    let scratch = 0x1000;
    const slot = (size = 16)=>{
        const at = scratch;
        scratch += Math.ceil(size / 16) * 16;
        memory.fill(0, at, at + size);
        return at;
    };
    const m = {
        memory, view, fns, said, slot,
        /** A REAL's bits, as an argument. @param {number} value */
        real: value=>new Uint32Array(Float32Array.of(value).buffer)[0],
        /** @param {string} name @param {number[]} args */
        call: (name, args)=>fns[name].handler(args),
        /**
         * Calls an export that writes a handle, and hands back the handle.
         *
         * @param {string} name @param {number[]} args  the out-parameter is added last
         */
        make(name, args){
            const out = slot(8);
            const status = fns[name].handler([...args, out]);
            if (status !== 0)
            {
                throw new Error(`${name} answered ${status}`);
            }
            return view.getUint32(out, true);
        },
        /** @param {number} at */
        u32: at=>view.getUint32(at, true),
        /** @param {number} at */
        i32: at=>view.getInt32(at, true),
        /** @param {number} at @param {number} count */
        f32s: (at, count)=>Array.from({ length: count }, (_, i)=>view.getFloat32(at + i * 4, true)),
        /** Points written into a new slot, its address. @param {number[][]} points */
        points(points){
            const at = slot(points.length * 8);
            points.flat().forEach((value, i)=>view.setFloat32(at + i * 4, value, true));
            return at;
        },
        /** @param {number[]} values */
        reals(values){
            const at = slot(values.length * 4);
            values.forEach((value, i)=>view.setFloat32(at + i * 4, value, true));
            return at;
        },
        /** @param {number[]} values */
        dwords(values){
            const at = slot(values.length * 4);
            values.forEach((value, i)=>view.setUint32(at + i * 4, value >>> 0, true));
            return at;
        },
        /**
         * A path's points and types.
         *
         * @param {number} path @returns {{ points: number[][], types: number[] }}
         */
        pathData(path){
            const countAt = slot(4);
            fns.GdipGetPointCount.handler([path, countAt]);
            const count = view.getInt32(countAt, true);
            if (count === 0)
            {
                return { points: [], types: [] };
            }
            const pointsAt = slot(count * 8);
            const typesAt = slot(count);
            fns.GdipGetPathPoints.handler([path, pointsAt, count]);
            fns.GdipGetPathTypes.handler([path, typesAt, count]);
            const flat = m.f32s(pointsAt, count * 2);
            return { points: Array.from({ length: count }, (_, i)=>[flat[i * 2], flat[i * 2 + 1]]),
                types: [...memory.subarray(typesAt, typesAt + count)] };
        },
    };
    return m;
}
