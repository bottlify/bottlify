/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What the gates of Direct3D 10 and 11 drawn elsewhere share
 * (`d3d10-played.itest.js`, `d3d11-played.itest.js`): a seeded program's
 * choices, guest memory with the engine's write watch, and a shader.
 */

import { createHash } from 'node:crypto';
import { SHADER_KIND, SYSTEM_VALUE } from '../d3d10/dxbc.js';
import {
    assemble, cb, dclConstantBuffer, dclOutput, mov, o, ret,
} from '../d3d10/shader-fixtures.js';

/** @param {number} seed */
export const random = seed=>{
    let drawn = 0;
    const next = ()=>createHash('sha256').update(`${seed}:${drawn++}`).digest()
        .readUInt32LE(0) / 4294967296;
    return {
        /** @param {number} n */
        below: n=>Math.floor(next() * n),
        /** @template T @param {T[]} list @returns {T} */
        pick: list=>list[Math.floor(next() * list.length)],
        float: ()=>next() * 2 - 1,
    };
};

/**
 * Guest memory as the engine gives it: a bump heap, and a write watch at page
 * grain with a view of its own for each watch, as the engine's write clock
 * gives one to each buffer.
 */
export function guestMemory(){
    const memory = new Uint8Array(1 << 20);
    let next = 0x10000;
    /** The writes each page has had. @type {Uint32Array} */
    const versions = new Uint32Array(memory.length >>> 12);
    /** @param {number} address @param {number} length */
    const mark = (address, length)=>{
        for (let page = address >>> 12; page <= (address + length - 1) >>> 12; page++)
        {
            versions[page]++;
        }
    };
    /** @param {number} address @param {Uint8Array} bytes */
    const store = (address, bytes)=>{
        memory.set(bytes, address);
        mark(address, bytes.length);
    };
    return {
        memory,
        store,
        /** @type {import('../d3d10/render.js').GuestStorage} */
        storage: {
            allocate: bytes=>{
                const at = next;
                next += (bytes + 0xfff) & ~0xfff;
                return at;
            },
            free: ()=>{},
            readMemory: (address, length)=>memory.slice(address, address + length),
            writeMemory: store,
            watchWrites: (base, length)=>{
                const seen = versions.slice(base >>> 12, ((base + length - 1) >>> 12) + 1);
                return {
                    take: (address, size)=>{
                        /** @type {number[]} */
                        const pages = [];
                        for (let page = address >>> 12; page <= (address + size - 1) >>> 12;
                            page++)
                        {
                            const at = page - (base >>> 12);
                            if (at >= 0 && at < seen.length && seen[at] !== versions[page])
                            {
                                seen[at] = versions[page];
                                pages.push(page);
                            }
                        }
                        return pages;
                    },
                };
            },
        },
    };
}

/** A pixel shader whose colour is the first register of cb0. */
export const constantPixelShader = ()=>assemble({
    kind: SHADER_KIND.PIXEL,
    outputs: [{ name: 'SV_TARGET', systemValue: SYSTEM_VALUE.TARGET, register: 0 }],
    instructions: [dclConstantBuffer(0, 1), dclOutput(o(0)), mov(o(0), cb(0, 0)), ret()],
});
