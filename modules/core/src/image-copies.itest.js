/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A process keeps no copy of a library's file, nor of its mapped image, in the
 * engine's heap once the library is in guest memory: a library it ships and
 * one it loads at run time each held its file (and the shipped one its mapped
 * image too) for the life of the process, beside the guest's own copy -- two
 * or three times every library a program brought. Its resources are still
 * found, read where it lies mapped.
 *
 * The program finds a manifest resource in each library, by its module
 * handle, and exits with both sizes. What the process holds in array buffers
 * once it has run is measured with libraries grown by megabytes of file
 * data and with the same libraries at their own size: the difference was
 * twice the bytes added to the shipped library (its file and its mapped image)
 * and once those added to the one loaded at run time, and is none of them now.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** Bytes of file data each library is grown by. */
const GROWN = 8 << 20;
const RT_MANIFEST = 24;
/** A manifest's id that names no context to build: the resource is only looked up. */
const MANIFEST_ID = 3;

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];
/** @param {string} text */
const cString = text=>[...text].map(c=>c.charCodeAt(0)).concat(0);

/**
 * An image whose last section is grown by `bytes` of file data at its end,
 * mapped with it: a library that is mostly what it carries.
 *
 * @param {Uint8Array} file @param {number} bytes
 */
function grown(file, bytes){
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
    const pe = view.getUint32(0x3c, true);
    const optional = pe + 24;
    const last = optional + view.getUint16(pe + 20, true) + (view.getUint16(pe + 6, true) - 1) * 40;
    const rawSize = view.getUint32(last + 16, true);
    assert.equal(view.getUint32(last + 20, true) + rawSize, file.length,
        'its last section ends the file');
    const out = new Uint8Array(file.length + bytes);
    out.set(file);
    // Not zeroes, so that nothing holding it could hold less than all of it.
    for (let at = file.length; at < out.length; at += 251)
    {
        out[at] = at & 0xff;
    }
    const grownView = new DataView(out.buffer);
    grownView.setUint32(last + 16, rawSize + bytes, true);
    grownView.setUint32(last + 8,
        Math.max(grownView.getUint32(last + 8, true), rawSize) + bytes, true);
    grownView.setUint32(optional + 56, grownView.getUint32(optional + 56, true) + bytes, true);
    return out;
}

/**
 * @param {number} imageBase @param {string} manifest @param {number} extra
 * @returns {Uint8Array}
 */
const library = (imageBase, manifest, extra)=>grown(buildExe({
    dll: true, imageBase, imports: {},
    exports: [{ name: 'Answer', offset: 8 }],
    manifest: { id: MANIFEST_ID, text: manifest },
    code: ()=>[
        0xb8, 1, 0, 0, 0, 0xc2, 12, 0, // DllMain: TRUE
        0xb8, 42, 0, 0, 0, 0xc3, // Answer
    ],
}), extra);

/**
 * The program: the shipped library's manifest size plus 256 times the one
 * loaded at run time's.
 */
const program = buildExe({
    imports: {
        'shipped.dll': ['Answer'],
        'KERNEL32.dll': ['GetModuleHandleA', 'LoadLibraryA', 'FindResourceA', 'SizeofResource',
            'ExitProcess'],
    },
    data: { shipped: cString('shipped.dll'), later: cString('later.dll') },
    codeSize: 0x100,
    code: ({ iat, at })=>{
        // The module in eax: its manifest's size in eax.
        const manifestSize = [
            0x8b, 0xf0, // mov esi, eax
            0x6a, RT_MANIFEST, 0x6a, MANIFEST_ID, 0x56, // push type, name, module
            0xff, 0x15, ...u32(iat('FindResourceA')),
            0x50, 0x56, // push resource, module
            0xff, 0x15, ...u32(iat('SizeofResource')),
        ];
        return [
            0x68, ...u32(at('shipped')), 0xff, 0x15, ...u32(iat('GetModuleHandleA')),
            ...manifestSize,
            0x8b, 0xd8, // mov ebx, eax
            0x68, ...u32(at('later')), 0xff, 0x15, ...u32(iat('LoadLibraryA')),
            ...manifestSize,
            0xc1, 0xe0, 0x08, // shl eax, 8
            0x03, 0xc3, // add eax, ebx
            0x50, 0xff, 0x15, ...u32(iat('ExitProcess')),
        ];
    },
});

/**
 * What a process holds in array buffers once its program has run, past what
 * was held before it was made, and its exit code.
 *
 * @param {number} extra  Bytes each library is grown by.
 * @param {() => Promise<void>} settle  Collects, and waits for what is collected to be let go.
 */
async function heldAfterRun(extra, settle){
    const files = [
        { path: 'C:\\App\\shipped.dll', bytes: library(0x10000000, 'abc', extra) },
        { path: 'C:\\App\\later.dll', bytes: library(0x20000000, 'hello', extra) },
    ];
    await settle();
    const before = process.memoryUsage().arrayBuffers;
    const app = await createApp({
        executable: program, imagePath: 'C:\\App\\program.exe',
        storage: { load: async()=>({ files }) },
    });
    try
    {
        const code = await app.run({ timeoutMs: 100000 });
        await settle();
        return { code, held: process.memoryUsage().arrayBuffers - before };
    }
    finally
    {
        app.dispose();
    }
}

test('a library\'s file and mapped image are let go once it is in guest memory, its resources'
    + ' read there', { timeout: 300000 }, async()=>{
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc');
    const settle = async()=>{
        gc();
        await new Promise(done=>setTimeout(done, 20));
        gc();
    };
    // Once first, for what the first process of a thread makes and keeps.
    await heldAfterRun(0, settle);
    const small = await heldAfterRun(0, settle);
    assert.equal(small.code, 3 + 5 * 256, 'each library\'s manifest found by its handle');
    const large = await heldAfterRun(GROWN, settle);
    assert.equal(large.code, 3 + 5 * 256);
    const kept = large.held - small.held;
    assert.ok(kept < GROWN, `${(kept / 2 ** 20).toFixed(1)} MiB more held for libraries`
        + ` ${GROWN / 2 ** 20} MiB larger each: a copy of one is still kept`);
});
