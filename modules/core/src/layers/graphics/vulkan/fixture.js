/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A Vulkan runtime over guest memory that is a byte array and a GPU that is
 * the recording double, for the tests.
 *
 * A program's side of every call is a structure in memory and a pointer to
 * it, so the fixture is mostly a way to lay structures out: `put` takes a
 * layout and named fields and returns the address, and a field's width comes
 * from how the value is spelled -- a number is a dword, `u64(n)` two, `f32(x)`
 * the bits of a float. Anything not named is zero, which is what a program's
 * zero-initialised structure has.
 */

import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';
import { createVulkan } from './runtime.js';
import { readU32, readU64, writeF32, writeU32, writeU64 } from './structs.js';

/** Where the fixture's memory starts: a program never hands out address zero. */
const RAM_BASE = 0x00100000;
const RAM_SIZE = 4 << 20;

/** @typedef {{ u64: number } | { f32: number } | number} FieldValue */

/** @param {number} value @returns {{ u64: number }} */
export const u64 = value=>({ u64: value });
/** @param {number} value @returns {{ f32: number }} */
export const f32 = value=>({ f32: value });

/**
 * @param {{ screen?: { width: number, height: number },
 *           compressedTextures?: boolean }} [options]
 */
export function createFixture(options = {}){
    const ram = new Uint8Array(RAM_SIZE);
    const memory = {
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>ram.subarray(address - RAM_BASE,
            address - RAM_BASE + length),
        /** @param {number} address @param {Uint8Array} bytes */
        writeMemory: (address, bytes)=>ram.set(bytes, address - RAM_BASE),
    };
    let next = RAM_BASE + 0x1000;

    const gpu = createFakeDevice();
    /** @type {import('../webgpu/contract.js').PresentedFrame[]} */
    const presented = [];
    /** @type {any} */
    let backend = null;
    /** @type {string[]} */
    const divergences = [];
    /** @type {[number, number][]} */
    const resolutions = [];

    const vulkan = createVulkan({
        ...memory,
        backend: ()=>{
            backend ??= createBackend({
                device: gpu.device,
                queue: gpu.queue,
                presentTo: frame=>presented.push(frame),
                now: ()=>0,
            });
            return backend;
        },
        screen: ()=>options.screen ?? { width: 4, height: 4 },
        resolution: (width, height)=>resolutions.push([width, height]),
        divergence: (api, detail)=>divergences.push(`${api}: ${detail}`),
        compressedTextures: options.compressedTextures,
        adapter: ()=>({ vendor: 'test', description: 'the recording device' }),
    });

    /**
     * @param {number} bytes
     * @returns {number} an address, 16-aligned so an eight-byte field is aligned
     */
    const alloc = bytes=>{
        const at = next;
        next += (bytes + 15) & ~15;
        return at;
    };

    /**
     * @param {number} at
     * @param {Readonly<Record<string, number>>} layout
     * @param {Record<string, FieldValue>} fields
     * @returns {number} the address
     */
    const putAt = (at, layout, fields)=>{
        for (const [name, value] of Object.entries(fields))
        {
            const offset = layout[name];
            if (offset === undefined)
            {
                throw new Error(`no field ${name} in that layout`);
            }
            if (typeof value === 'number')
            {
                writeU32(memory, at + offset, value);
            }
            else if ('u64' in value)
            {
                writeU64(memory, at + offset, value.u64);
            }
            else
            {
                writeF32(memory, at + offset, value.f32);
            }
        }
        return at;
    };

    /**
     * @param {Readonly<Record<string, number>>} layout
     * @param {Record<string, FieldValue>} fields
     * @returns {number} the address
     */
    const put = (layout, fields)=>putAt(alloc(layout.SIZE), layout, fields);

    /** @param {readonly number[]} values @returns {number} an array of dwords */
    const u32s = values=>{
        const at = alloc(Math.max(4, values.length * 4));
        values.forEach((value, index)=>writeU32(memory, at + index * 4, value));
        return at;
    };

    /** @param {readonly number[]} values @returns {number} an array of qwords */
    const u64s = values=>{
        const at = alloc(Math.max(8, values.length * 8));
        values.forEach((value, index)=>writeU64(memory, at + index * 8, value));
        return at;
    };

    /** @param {string} value @returns {number} a NUL-terminated string */
    const str = value=>{
        const encoded = new TextEncoder().encode(`${value}\0`);
        const at = alloc(encoded.length);
        memory.writeMemory(at, encoded);
        return at;
    };

    /** @param {readonly string[]} values @returns {number} an array of string pointers */
    const strs = values=>u32s(values.map(str));

    /**
     * Calls a command as the guest would, with the arguments already split
     * into stack words: a 64-bit handle is passed as `u64(handle)` and becomes
     * two words.
     *
     * @param {string} name
     * @param {...(number | { u64: number })} args
     * @returns {number}
     */
    const call = (name, ...args)=>{
        /** @type {number[]} */
        const words = [];
        for (const arg of args)
        {
            if (typeof arg === 'number')
            {
                words.push(arg >>> 0);
            }
            else
            {
                words.push(arg.u64 >>> 0, Math.floor(arg.u64 / 0x100000000));
            }
        }
        return vulkan.handlers[name](words);
    };

    return {
        vulkan,
        gpu,
        presented,
        divergences,
        resolutions,
        memory,
        alloc,
        put,
        putAt,
        u32s,
        u64s,
        str,
        strs,
        call,
        /** @param {number} address */
        u32: address=>readU32(memory, address),
        /** @param {number} address */
        u64: address=>readU64(memory, address),
        /** An out-parameter slot. */
        out: ()=>alloc(8),
    };
}
