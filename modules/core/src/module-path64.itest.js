/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A system library a program loads by the path it is installed at -- the
 * Steam client's, which a game finds through the registry and loads from
 * Steam's directory -- reports that path, and the file there is the library's
 * image, which the program can open and read: the Steam API and the DRM
 * wrapper around a game check the client they loaded that way. The program
 * prints the name GetModuleFileNameA answers and exits with the first two
 * bytes it read from that file, or 0x10000 and the error of the open.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];
/** @param {string} text */
const ascii = text=>[...text].map(character=>character.charCodeAt(0)).concat(0);

const CLIENT = 'C:\\Program Files (x86)\\Steam\\steamclient64.dll';

test('a library loaded by its installed path reports that path, and its file reads as its image',
    { timeout: 60000 }, async t=>{
        const program = buildExe({
            bits: 64, codeSize: 0x100,
            imports: { 'KERNEL32.dll': ['LoadLibraryExA', 'GetModuleFileNameA', 'GetStdHandle',
                'WriteFile', 'CreateFileA', 'ReadFile', 'GetLastError', 'ExitProcess'] },
            data: { path: ascii(CLIENT), name: new Array(264).fill(0),
                read: new Array(8).fill(0), count: new Array(8).fill(0) },
            code: ({ iat, at, code })=>{
                /** @type {number[]} */
                const bytes = [];
                /** @param {number[]} op @param {number} to  a RIP-relative operand */
                const rip = (op, to)=>bytes.push(...op,
                    ...u32(to - (code(bytes.length) + op.length + 4)));
                const call = (/** @type {string} */ name)=>rip([0xff, 0x15], iat(name));
                bytes.push(0x48, 0x83, 0xec, 0x48); // sub rsp, 72
                rip([0x48, 0x8d, 0x0d], at('path')); // lea rcx, [path]
                bytes.push(0x31, 0xd2, 0x41, 0xb8, ...u32(8)); // xor edx, edx; mov r8d, 8
                call('LoadLibraryExA');
                bytes.push(0x48, 0x89, 0xc1); // mov rcx, rax
                rip([0x48, 0x8d, 0x15], at('name')); // lea rdx, [name]
                bytes.push(0x41, 0xb8, ...u32(260)); // mov r8d, 260
                call('GetModuleFileNameA');
                bytes.push(0x89, 0xc3); // mov ebx, eax
                bytes.push(0xb9, ...u32(-11 >>> 0)); // mov ecx, STD_OUTPUT_HANDLE
                call('GetStdHandle');
                bytes.push(0x48, 0x89, 0xc1); // mov rcx, rax
                rip([0x48, 0x8d, 0x15], at('name')); // lea rdx, [name]
                bytes.push(0x41, 0x89, 0xd8); // mov r8d, ebx
                rip([0x4c, 0x8d, 0x0d], at('count')); // lea r9, [count]
                bytes.push(0x48, 0xc7, 0x44, 0x24, 0x20, 0, 0, 0, 0); // [rsp+32] = 0
                call('WriteFile');
                // CreateFileA(name, GENERIC_READ, FILE_SHARE_READ, 0, OPEN_EXISTING, 0x80, 0)
                rip([0x48, 0x8d, 0x0d], at('name'));
                bytes.push(0xba, ...u32(0x80000000), 0x41, 0xb8, ...u32(1), 0x45, 0x31, 0xc9);
                bytes.push(0x48, 0xc7, 0x44, 0x24, 0x20, 3, 0, 0, 0);
                bytes.push(0x48, 0xc7, 0x44, 0x24, 0x28, 0x80, 0, 0, 0);
                bytes.push(0x48, 0xc7, 0x44, 0x24, 0x30, 0, 0, 0, 0);
                call('CreateFileA');
                bytes.push(0x48, 0x83, 0xf8, 0xff); // cmp rax, -1
                bytes.push(0x75, 0x00); // jne opened (patched below)
                const jne = bytes.length - 1;
                call('GetLastError');
                bytes.push(0x0d, ...u32(0x10000), 0x89, 0xc1); // or eax, 0x10000; mov ecx, eax
                call('ExitProcess');
                bytes[jne] = bytes.length - (jne + 1);
                // opened: ReadFile(handle, read, 2, count, 0); ExitProcess(read)
                bytes.push(0x48, 0x89, 0xc1);
                rip([0x48, 0x8d, 0x15], at('read'));
                bytes.push(0x41, 0xb8, ...u32(2));
                rip([0x4c, 0x8d, 0x0d], at('count'));
                bytes.push(0x48, 0xc7, 0x44, 0x24, 0x20, 0, 0, 0, 0);
                call('ReadFile');
                rip([0x8b, 0x0d], at('read')); // mov ecx, [read]
                call('ExitProcess');
                return bytes;
            },
        });
        const app = await createApp({ executable: program, engine: 'cork',
            win32: { steam: { steamId: '76561197960287930', accountName: 'test', apps: [480] } } });
        t.after(()=>app.dispose());
        /** @type {string[]} */
        const output = [];
        app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>output.push(text));
        const code = await app.run({ timeoutMs: 50000 });
        assert.equal(output.join(''), CLIENT, 'the path it was loaded from');
        assert.equal(code.toString(16), (0x5a4d).toString(16), 'and its file begins "MZ"');
    });
