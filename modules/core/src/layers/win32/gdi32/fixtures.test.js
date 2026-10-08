/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * gdi32 over the real drawing engine for the tests that read pixels back:
 * the machine `painted` builds and the pens `pens` selects into it.
 */

import { createGdiFunctions } from './functions.js';
import { createGdiDrawing } from '../../graphics/gdi/context.js';
import { surfaceForDdb, surfaceForDibSection } from '../../graphics/gdi/surface.js';

/**
 * gdi32 over the real drawing engine, wired as the win32 module wires it: a
 * memory DC on a top-down 32-bit DIB section whose pixels a test reads back,
 * the program's callbacks recorded rather than run, and every last error set.
 *
 * @param {number} width @param {number} height
 * @param {{ answer?: (entry: number, args: number[]) => number }} [options]
 *        What the program's callback answers, zero by default.
 */
export function painted(width, height, { answer = ()=>0 } = {}){
    const bytes = new Uint8Array(0x80000);
    const view = new DataView(bytes.buffer);
    let next = 0x40000;
    let handles = 4;
    /** @type {number[][]} */
    const called = [];
    /** @type {number[]} */
    const errors = [];
    const gdi = createGdiFunctions({
        readMemory: (address, length)=>bytes.slice(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        readCString: ()=>'',
        handles: { open: ()=>(handles += 4), close: ()=>undefined },
        surfaces: {
            /** @param {number} size */
            allocate(size){
                const address = next;
                next += (size + 0xff) & ~0xff;
                return address;
            },
            free: ()=>undefined,
        },
        graphics: {
            createDrawing: options=>createGdiDrawing(options),
            surfaceFor: (dc, bitmap)=>(bitmap.pixels ? surfaceForDdb(bitmap)
                : surfaceForDibSection(bitmap, bytes, 0)),
        },
        call: async(entry, args)=>{
            called.push([entry, ...args]);
            return answer(entry, args);
        },
        setLastError: code=>errors.push(code),
    });
    const fns = /** @type {Record<string, { argBytes: number, handler: (args: number[]) => any }>} */ (
        /** @type {unknown} */ (gdi.table));
    /**
     * A top-down DIB section selected into a memory DC of its own.
     *
     * @param {number} w @param {number} h
     * @param {{ bitCount?: number, masks?: number[] }} [format]
     */
    const section = (w, h, { bitCount = 32, masks } = {})=>{
        const info = 0x100;
        bytes.fill(0, info, info + 64);
        view.setUint32(info, 40, true);
        view.setInt32(info + 4, w, true);
        view.setInt32(info + 8, -h, true);
        view.setUint16(info + 12, 1, true);
        view.setUint16(info + 14, bitCount, true);
        if (masks)
        {
            view.setUint32(info + 16, 3, true);
        }
        // Masks, or for an indexed section black and white, follow the header.
        (masks ?? [0, 0xffffff]).forEach((value, index)=>
            view.setUint32(info + 40 + index * 4, value, true));
        const bitmap = fns.CreateDIBSection.handler([0, info, 0, 0x80, 0, 0]);
        const at = view.getUint32(0x80, true);
        const dc = fns.CreateCompatibleDC.handler([0]);
        fns.SelectObject.handler([dc, bitmap]);
        return {
            dc,
            bitmap,
            at,
            /** @param {number} x @param {number} y */
            pixel: (x, y)=>view.getUint32(at + (y * w + x) * 4, true),
            /** @param {number} x @param {number} y @param {number} value */
            put: (x, y, value)=>view.setUint32(at + (y * w + x) * 4, value >>> 0, true),
            /** @param {number} value */
            fill: value=>{
                for (let index = 0; index < w * h; index++)
                {
                    view.setUint32(at + index * 4, value >>> 0, true);
                }
            },
        };
    };
    return { bytes, view, gdi, fns, called, errors, section, ...section(width, height) };
}

/**
 * Selects a solid pen and a solid brush into a DC.
 *
 * @param {ReturnType<typeof painted>} machine @param {number} pen @param {number} brush
 */
export function pens(machine, pen, brush){
    const { fns, dc } = machine;
    fns.SelectObject.handler([dc, fns.CreatePen.handler([0, 1, pen])]);
    fns.SelectObject.handler([dc, fns.CreateSolidBrush.handler([brush])]);
}

