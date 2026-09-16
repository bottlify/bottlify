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

/** Where the exported routine sits in the code: past everything else. */
const ANSWER_OFFSET = 0x70;

/**
 * Exits 0 when LoadLibrary and GetModuleHandle on the image's own name answer
 * its base, and GetProcAddress on that handle -- by name and by ordinal --
 * answers the exported routine's address; 1 otherwise.
 */
function buildSelfLoadExe(){
    return buildExe({
        imports: { 'KERNEL32.dll': ['LoadLibraryA', 'GetModuleHandleA', 'GetProcAddress',
            'ExitProcess'] },
        data: {
            name: [...new TextEncoder().encode('Self.exe'), 0],
            answer: [...new TextEncoder().encode('Answer'), 0],
        },
        exports: [{ name: 'Answer', offset: ANSWER_OFFSET }],
        codeSize: 0x80,
        code: ({ iat, at, code })=>{
            const body = [
                0x68, ...u32(at('name')), //              push name
                0xff, 0x15, ...u32(iat('LoadLibraryA')), // call [LoadLibraryA]
                0x3d, ...u32(IMAGE_BASE), //              cmp eax, IMAGE_BASE
                0x75, 0x00, //                            jne fail
                0x68, ...u32(at('name')), //              push name
                0xff, 0x15, ...u32(iat('GetModuleHandleA')), // call [GetModuleHandleA]
                0x3d, ...u32(IMAGE_BASE), //              cmp eax, IMAGE_BASE
                0x75, 0x00, //                            jne fail
                0x68, ...u32(at('answer')), //            push "Answer"
                0x68, ...u32(IMAGE_BASE), //              push IMAGE_BASE
                0xff, 0x15, ...u32(iat('GetProcAddress')), // call [GetProcAddress]
                0x3d, ...u32(code(ANSWER_OFFSET)), //     cmp eax, Answer
                0x75, 0x00, //                            jne fail
                0x6a, 0x01, //                            push 1 (ordinal)
                0x68, ...u32(IMAGE_BASE), //              push IMAGE_BASE
                0xff, 0x15, ...u32(iat('GetProcAddress')), // call [GetProcAddress]
                0x3d, ...u32(code(ANSWER_OFFSET)), //     cmp eax, Answer
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
            const tail = [
                ...body,
                0x6a, 0x01, //                            fail: push 1
                0xff, 0x15, ...u32(iat('ExitProcess')), // call [ExitProcess]
            ];
            while (tail.length < ANSWER_OFFSET)
            {
                tail.push(0xcc);
            }
            return [...tail, 0xc3]; //                    Answer: ret
        },
    });
}

test('a program that names its own image gets the one it runs from, exports included',
    { timeout: 15000 }, async t=>{
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
