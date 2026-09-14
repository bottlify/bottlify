/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A program that names its own image gets the mapping it is running from.
 *
 * LoadLibrary and GetModuleHandle on the executable's own file name answer
 * its base, as they do for any module already loaded: the image has no
 * relocations and can live nowhere but where it is, and a program asks this
 * way to reach its own resources.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

const PREBUILT = new URL('../vendor/prebuilt/', import.meta.url);
const IMAGE_BASE = 0x400000;

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/**
 * Exits 0 when both calls answer the image base, 1 otherwise.
 */
function buildSelfLoadExe(){
    return buildExe({
        imports: { 'KERNEL32.dll': ['LoadLibraryA', 'GetModuleHandleA', 'ExitProcess'] },
        data: { name: [...new TextEncoder().encode('Self.exe'), 0] },
        codeSize: 0x60,
        code: ({ iat, at })=>{
            const body = [
                0x68, ...u32(at('name')), //              push name
                0xff, 0x15, ...u32(iat('LoadLibraryA')), // call [LoadLibraryA]
                0x3d, ...u32(IMAGE_BASE), //              cmp eax, IMAGE_BASE
                0x75, 0x00, //                            jne fail
                0x68, ...u32(at('name')), //              push name
                0xff, 0x15, ...u32(iat('GetModuleHandleA')), // call [GetModuleHandleA]
                0x3d, ...u32(IMAGE_BASE), //              cmp eax, IMAGE_BASE
                0x75, 0x00, //                            jne fail
                0x6a, 0x00, //                            push 0
                0xff, 0x15, ...u32(iat('ExitProcess')), // call [ExitProcess]
            ];
            const fail = body.length;
            for (let index = 0; index + 1 < body.length; index++)
            {
                if (body[index] === 0x75 && body[index + 1] === 0x00)
                {
                    body[index + 1] = fail - (index + 2);
                }
            }
            return [
                ...body,
                0x6a, 0x01, //                            fail: push 1
                0xff, 0x15, ...u32(iat('ExitProcess')), // call [ExitProcess]
            ];
        },
    });
}

test('a program that loads or asks for its own image by name gets the one it runs from',
    async t=>{
        const wasm = await readFile(new URL('v86.wasm', PREBUILT));
        const app = await createApp({
            executable: buildSelfLoadExe(),
            imagePath: 'C:\\App\\Self.exe',
            v86: {
                moduleUrl: new URL('libv86.mjs', PREBUILT).href,
                wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
            },
        });
        t.after(()=>app.dispose());
        const code = await app.run({ timeoutMs: 8000 });
        assert.equal(code, 0, 'both answers were the image base');
    });
