/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * PEB->Ldr is a real, walkable module list, not a null a program dereferences
 * on the first field it reads.
 *
 * This is what an anti-tamper check or a plugin loader does before it does
 * anything else: read FS:[0x30] for the PEB, PEB+0x0c for Ldr, and walk
 * Ldr->InLoadOrderModuleList counting entries. The fixture below is exactly
 * that walk, done in guest code, with the count as its own exit code.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';


/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/**
 * Walks `InLoadOrderModuleList` from `PEB->Ldr` and exits with the count of
 * entries it found -- the list is circular, so the walk ends the moment it
 * gets back to the head it started from, never on a null.
 */
function buildWalkLdrExe(){
    return buildExe({
        imports: { 'KERNEL32.dll': ['ExitProcess'] },
        codeSize: 0x60,
        code: ({ iat })=>{
            const before = [
                0x64, 0xa1, ...u32(0x30), //  mov eax, fs:[0x30]   -> PEB
                0x8b, 0x40, 0x0c, //          mov eax, [eax+0x0c]  -> Ldr
                0x8d, 0x48, 0x0c, //          lea ecx, [eax+0x0c]  -> &InLoadOrderModuleList (head)
                0x8b, 0x11, //                mov edx, [ecx]       -> first node
                0x31, 0xc0, //                xor eax, eax         -> count = 0
            ];
            const loopBody = [
                0x39, 0xca, //                cmp edx, ecx
                0x74, 0x00, //                je done              (patched)
                0x40, //                      inc eax
                0x8b, 0x12, //                mov edx, [edx]
                0xeb, 0x00, //                jmp loop             (patched)
            ];
            // je's displacement is relative to the instruction after it; done
            // is the very next thing after the loop, at loopBody's own end.
            loopBody[3] = loopBody.length - 4;
            // jmp's displacement is relative to the instruction after it too,
            // back to where the loop began.
            loopBody[loopBody.length - 1] = (-loopBody.length) & 0xff;

            return [
                ...before,
                ...loopBody,
                0x50, //                      push eax
                0xff, 0x15, ...u32(iat('ExitProcess')),
            ];
        },
    });
}

test('a fixture that walks InLoadOrderModuleList counts every module, never a null', async t=>{
    const app = await createApp({
        executable: buildWalkLdrExe(),
        imagePath: 'C:\\App\\Walk.exe',
    });
    t.after(()=>app.dispose());

    const count = await app.run({ timeoutMs: 8000 });

    // The exact count is every system library this build synthesises plus the
    // program's own image, which is not this test's to pin -- it changes
    // whenever win32 gains or loses a library. What the walk itself proves is
    // that PEB->Ldr is real, the list is really circular, and it holds more
    // than just the running program.
    assert.ok(count > 1, `expected more than the program's own entry, got ${count}`);
    assert.ok(count < 256, 'the walk ended by reaching the head again, not by wrapping the count');
});

/** @param {string} text @returns {number[]} */
const cString = text=>[...text].map(c=>c.charCodeAt(0)).concat(0);

/**
 * Asks GetModuleHandleA about three libraries, and a fourth time after loading
 * one of them, and exits with one bit per handle that came back non-zero:
 * comctl32 before (1), kernel32 (2), gdi32 (4), comctl32 after (8).
 */
function buildHandlesExe(){
    return buildExe({
        imports: {
            'KERNEL32.dll': ['GetModuleHandleA', 'LoadLibraryA', 'ExitProcess'],
            'USER32.dll': ['MessageBeep'],
        },
        data: {
            comctl: cString('comctl32.dll'), kernel: cString('KERNEL32.DLL'),
            gdi: cString('gdi32'),
        },
        codeSize: 0x80,
        code: ({ iat, at })=>{
            /** @param {string} name @param {number} bit */
            const handle = (name, bit)=>[
                0x68, ...u32(at(name)), //                     push name
                0xff, 0x15, ...u32(iat('GetModuleHandleA')), // call [GetModuleHandleA]
                0x85, 0xc0, 0x74, 0x03, //                     test eax, eax; jz +3
                0x80, 0xcb, bit, //                            or bl, bit
            ];
            return [
                0x31, 0xdb, //                                 xor ebx, ebx
                ...handle('comctl', 1),
                ...handle('kernel', 2),
                ...handle('gdi', 4),
                0x68, ...u32(at('comctl')), //                 push comctl
                0xff, 0x15, ...u32(iat('LoadLibraryA')), //    call [LoadLibraryA]
                ...handle('comctl', 8),
                0x53, //                                       push ebx
                0xff, 0x15, ...u32(iat('ExitProcess')),
            ];
        },
    });
}

test('GetModuleHandleEx finds the program itself from an address in it', async t=>{
    // FROM_ADDRESS | UNCHANGED_REFCOUNT on an address of the program's own: a
    // loader stub's way of finding its module, which Windows answers with the
    // image base. The handle is the exit code.
    const executable = buildExe({
        imports: { 'KERNEL32.dll': ['GetModuleHandleExA', 'ExitProcess'] },
        data: { handle: [0, 0, 0, 0], mine: [0] },
        codeSize: 0x40,
        code: ({ iat, at })=>[
            0x68, ...u32(at('handle')), //                 push &handle
            0x68, ...u32(at('mine')), //                   push an address in the image
            0x6a, 0x06, //                                 push FROM_ADDRESS | UNCHANGED_REFCOUNT
            0xff, 0x15, ...u32(iat('GetModuleHandleExA')),
            0xff, 0x35, ...u32(at('handle')), //           push [handle]
            0xff, 0x15, ...u32(iat('ExitProcess')),
        ],
    });
    const app = await createApp({ executable, imagePath: 'C:\\App\\Own.exe' });
    t.after(()=>app.dispose());

    assert.equal(await app.run({ timeoutMs: 8000 }), 0x400000);
});

test('a module is there for GetModuleHandle once it is loaded, and not before', async t=>{
    // Wine's own tests find comctl32 absent from a program that imports only
    // user32 and friends; a system library the program imports brings in
    // those it imports itself, and kernel32 is in every process.
    const app = await createApp({
        executable: buildHandlesExe(),
        imagePath: 'C:\\App\\Handles.exe',
    });
    t.after(()=>app.dispose());

    assert.equal(await app.run({ timeoutMs: 8000 }), 2 | 4 | 8);
});
