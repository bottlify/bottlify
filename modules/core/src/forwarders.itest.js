/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * An export forwarder ("LIB.Name", "LIB.#7", PE/COFF 6.3.2) is followed to
 * the library it names, by GetProcAddress and by an import table alike; the
 * forwarding library then holds that library, which a FreeLibrary by name
 * does not unload while it stands; a forwarder that leads back to itself is
 * the image's fault, ERROR_BAD_EXE_FORMAT.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/fixtures/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255];

/** @param {string} text */
const cString = text=>[...text].map(c=>c.charCodeAt(0)).concat(0);

/** DllMain answering TRUE: what every library here starts with, eight bytes. */
const DLL_MAIN = [0xb8, 1, 0, 0, 0, 0xc2, 0x0c, 0x00];

/** s.dll: `func` answers 7. */
const source = ()=>buildExe({
    dll: true,
    imageBase: 0x10000000,
    imports: { 'KERNEL32.dll': ['GetLastError'] },
    exports: [{ name: 'func', offset: DLL_MAIN.length }],
    code: ()=>[...DLL_MAIN, 0xb8, 7, 0, 0, 0, 0xc3],
});

/** f.dll: `func` forwards to s.dll's by name, `second` to it by ordinal. */
const forwarder = ()=>buildExe({
    dll: true,
    imageBase: 0x11000000,
    imports: { 'KERNEL32.dll': ['GetLastError'] },
    exports: [{ name: 'func', forwards: 's.func' }, { name: 'second', forwards: 's.#1' }],
    code: ()=>DLL_MAIN,
});

/** loop.dll: `func` forwards to itself. */
const loop = ()=>buildExe({
    dll: true,
    imageBase: 0x12000000,
    imports: { 'KERNEL32.dll': ['GetLastError'] },
    exports: [{ name: 'func', forwards: 'loop.func' }],
    code: ()=>DLL_MAIN,
});

/**
 * Code that ends the program with its first failed check's number, or with 1.
 *
 * @param {(asm: {
 *     bytes: number[], call: (name: string) => void,
 *     fail: (opcode: number, check: number) => void,
 * }) => void} body
 * @param {(name: string) => number} iat
 */
const checked = (body, iat)=>{
    /** @type {number[]} */
    const bytes = [];
    /** @type {[number, number][]} */
    const fixups = [];
    const call = (/** @type {string} */ name)=>bytes.push(0xff, 0x15, ...u32(iat(name)));
    body({
        bytes, call,
        // A short conditional jump to the stub that exits with `check`.
        fail: (opcode, check)=>fixups.push([bytes.push(opcode, 0) - 1, check]),
    });
    bytes.push(0x6a, 1);
    call('ExitProcess');
    for (const [place, check] of fixups)
    {
        bytes[place] = bytes.length - (place + 1);
        bytes.push(0x6a, check);
        call('ExitProcess');
    }
    return bytes;
};

const JZ = 0x74;
const JNZ = 0x75;

/**
 * @param {import('node:test').TestContext} t
 * @param {Uint8Array} executable @param {Record<string, Uint8Array>} libraries
 */
const run = async(t, executable, libraries)=>{
    const app = await createApp({
        executable,
        imagePath: 'C:\\App\\fwd.exe',
        storage: { load: async()=>({ files: Object.entries(libraries)
            .map(([name, bytes])=>({ path: `C:\\App\\${name}`, bytes })) }) },
    });
    t.after(()=>app.dispose());
    return app.run({ timeoutMs: 30_000 });
};

test('GetProcAddress follows a forwarder by name and by ordinal, and the forwarder holds'
    + ' its target', { timeout: 60_000 }, async t=>{
    const program = buildExe({
        imports: { 'KERNEL32.dll': ['LoadLibraryA', 'GetProcAddress', 'GetModuleHandleA',
            'FreeLibrary', 'ExitProcess'] },
        data: { s: cString('s.dll'), f: cString('f.dll'), func: cString('func'),
            second: cString('second') },
        codeSize: 0x100,
        code: ({ iat, at })=>checked(({ bytes, call, fail })=>{
            bytes.push(0x68, ...u32(at('s')));
            call('LoadLibraryA');
            bytes.push(0x89, 0xc3); // mov ebx, eax
            bytes.push(0x68, ...u32(at('f')));
            call('LoadLibraryA');
            bytes.push(0x89, 0xc6); // mov esi, eax
            bytes.push(0x68, ...u32(at('func')), 0x56); // push "func"; push esi
            call('GetProcAddress');
            bytes.push(0x85, 0xc0); // test eax, eax
            fail(JZ, 10);
            bytes.push(0x89, 0xc7, 0xff, 0xd7); // mov edi, eax; call edi
            bytes.push(0x83, 0xf8, 7); // cmp eax, 7
            fail(JNZ, 11);
            bytes.push(0x68, ...u32(at('second')), 0x56);
            call('GetProcAddress');
            bytes.push(0x39, 0xf8); // cmp eax, edi
            fail(JNZ, 12);
            bytes.push(0x53); // push ebx: s.dll's own reference given back
            call('FreeLibrary');
            bytes.push(0x68, ...u32(at('s')));
            call('GetModuleHandleA');
            bytes.push(0x85, 0xc0);
            fail(JZ, 13); // unloaded while f.dll's forwarder holds it
            bytes.push(0x56); // push esi: f.dll gone, and its hold with it
            call('FreeLibrary');
            bytes.push(0x68, ...u32(at('s')));
            call('GetModuleHandleA');
            bytes.push(0x85, 0xc0);
            fail(JNZ, 14);
        }, iat),
    });
    assert.equal(await run(t, program, { 's.dll': source(), 'f.dll': forwarder() }), 1);
});

test('an import bound through a forwarder loads the library it names', { timeout: 60_000 },
    async t=>{
        // Nothing names s.dll but f.dll's forwarder: the import of f.dll!func
        // has it loaded before the program runs, as Windows' loader snaps it.
        const program = buildExe({
            imports: { 'f.dll': ['func'], 'KERNEL32.dll': ['ExitProcess'] },
            code: ({ iat })=>[0xff, 0x15, ...u32(iat('func')), 0x50,
                0xff, 0x15, ...u32(iat('ExitProcess'))],
        });
        assert.equal(await run(t, program, { 's.dll': source(), 'f.dll': forwarder() }), 7);
    });

test('a library loaded at run time has an import through a forwarder bound',
    { timeout: 60_000 }, async t=>{
        // user.dll imports f.dll!func; s.dll is loaded for it when it is.
        const user = buildExe({
            dll: true,
            imageBase: 0x13000000,
            imports: { 'f.dll': ['func'] },
            exports: [{ name: 'call', offset: DLL_MAIN.length }],
            code: ({ iat })=>[...DLL_MAIN, 0xff, 0x25, ...u32(iat('func'))],
        });
        const program = buildExe({
            imports: { 'KERNEL32.dll': ['LoadLibraryA', 'GetProcAddress', 'ExitProcess'] },
            data: { user: cString('user.dll'), call: cString('call') },
            code: ({ iat, at })=>checked(({ bytes, call, fail })=>{
                bytes.push(0x68, ...u32(at('user')));
                call('LoadLibraryA');
                bytes.push(0x85, 0xc0);
                fail(JZ, 10);
                bytes.push(0x68, ...u32(at('call')), 0x50);
                call('GetProcAddress');
                bytes.push(0xff, 0xd0, 0x83, 0xf8, 7); // call eax; cmp eax, 7
                fail(JNZ, 11);
            }, iat),
            codeSize: 0x80,
        });
        assert.equal(await run(t, program,
            { 's.dll': source(), 'f.dll': forwarder(), 'user.dll': user }), 1);
    });

test('a forwarder that leads back to itself is ERROR_BAD_EXE_FORMAT', { timeout: 60_000 },
    async t=>{
        const program = buildExe({
            imports: { 'KERNEL32.dll': ['LoadLibraryA', 'GetProcAddress', 'GetLastError',
                'ExitProcess'] },
            data: { loop: cString('loop.dll'), func: cString('func') },
            code: ({ iat, at })=>[
                0x68, ...u32(at('loop')), 0xff, 0x15, ...u32(iat('LoadLibraryA')),
                0x68, ...u32(at('func')), 0x50, 0xff, 0x15, ...u32(iat('GetProcAddress')),
                0xff, 0x15, ...u32(iat('GetLastError')),
                0x50, 0xff, 0x15, ...u32(iat('ExitProcess')),
            ],
            codeSize: 0x60,
        });
        assert.equal(await run(t, program, { 'loop.dll': loop() }), 193);
    });
