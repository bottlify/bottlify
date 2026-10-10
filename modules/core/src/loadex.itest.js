/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What LoadLibraryEx's flags change, and what loading a program by name does,
 * as Wine's loader tests have it:
 *
 * - LOAD_LIBRARY_AS_DATAFILE maps the file and runs nothing: the handle is
 *   its base with the low bit set, GetModuleHandle does not find it, and
 *   FreeLibrary gives it back.
 * - DONT_RESOLVE_DLL_REFERENCES makes it a module, but neither binds its
 *   imports nor calls its DllMain; a later LoadLibrary returns the same module
 *   as it is.
 * - A program -- no IMAGE_FILE_DLL -- loaded by name is mapped the same way:
 *   its imports stay as the file wrote them and its entry point, which is its
 *   main, does not run.
 *
 * The program checks one property per bit of its exit code.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { parsePe, rvaToFileOffset } from './layers/loader/internal/pe.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** Where the fixture builder puts every image it makes. */
const IMAGE_BASE = 0x400000;

const LOAD_LIBRARY_AS_DATAFILE = 0x2;
const DONT_RESOLVE_DLL_REFERENCES = 0x1;

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/** @param {string} text */
const cString = text=>[...text].map(c=>c.charCodeAt(0)).concat(0);

/**
 * A fixture image given a relocation directory -- one empty block, in the
 * code's unused tail -- so that it can be mapped anywhere; its only absolute
 * addresses are the program's. Its code must end before 0x20.
 *
 * @param {Uint8Array} file
 */
function movable(file){
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
    const optional = view.getUint32(0x3c, true) + 4 + 20;
    view.setUint32(optional + 96 + 5 * 8, 0x1020, true);
    view.setUint32(optional + 96 + 5 * 8 + 4, 8, true);
    view.setUint32(0x220, 0x1000, true);
    view.setUint32(0x224, 8, true);
    return file;
}

/**
 * Marks a fixture image as a DLL.
 *
 * @param {Uint8Array} file
 */
function library(file){
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
    const characteristics = view.getUint32(0x3c, true) + 4 + 18;
    view.setUint16(characteristics, view.getUint16(characteristics, true) | 0x2000, true);
    return file;
}

/**
 * An image importing GetModuleHandleA whose entry point stores 1 at `into`
 * and answers TRUE as a DllMain does.
 *
 * @param {number} into
 * @returns {{ file: Uint8Array, slot: number, unbound: number }}
 *   `slot` is the import's IAT slot, as an RVA, and `unbound` what the file
 *   has in it before anything binds it.
 */
function image(into){
    let slot = 0;
    const file = movable(buildExe({
        imports: { 'KERNEL32.dll': ['GetModuleHandleA'] },
        code: ({ iat })=>{
            slot = iat('GetModuleHandleA') - IMAGE_BASE;
            return [
                0xc7, 0x05, ...u32(into), ...u32(1), //        mov dword [into], 1
                0xb8, ...u32(1), //                            mov eax, 1
                0xc2, 0x0c, 0x00, //                           ret 12
            ];
        },
    }));
    const parsed = parsePe(file);
    const at = rvaToFileOffset(parsed, slot);
    const unbound = new DataView(file.buffer, file.byteOffset).getUint32(at, true);
    return { file, slot, unbound };
}

/**
 * Exit code bits. As data: the handle's low bits are 1 (1), GetModuleHandle
 * finds nothing (2), DllMain did not run (4), FreeLibrary answered TRUE (8).
 * Unresolved: GetModuleHandle finds the handle (0x10), DllMain did not run
 * (0x20), the import slot is as the file wrote it (0x40), a second
 * LoadLibrary is the same module (0x80), still not attached (0x100) nor bound
 * (0x200). A program by name: loaded (0x400), its main did not run (0x800),
 * its import not bound (0x1000).
 */
const ALL = 0x1fff;

/**
 * @param {number} probeSlot @param {number} probeUnbound
 * @param {number} toolSlot @param {number} toolUnbound
 * @param {(addresses: { ran: number, attached: number }) => void} placed
 */
function buildProgram(probeSlot, probeUnbound, toolSlot, toolUnbound, placed){
    return buildExe({
        imports: { 'KERNEL32.dll': ['LoadLibraryA', 'LoadLibraryExA', 'FreeLibrary',
            'GetModuleHandleA', 'ExitProcess'] },
        data: {
            probe: cString('probe.dll'), tool: cString('tool.exe'),
            attached: [0, 0, 0, 0], ran: [0, 0, 0, 0],
        },
        codeSize: 0x180,
        code: ({ iat, at })=>{
            placed({ ran: at('ran'), attached: at('attached') });
            /** @param {string} fn */
            const call = fn=>[0xff, 0x15, ...u32(iat(fn))];
            /** or ebx, bit -- six bytes, which is what each skip jumps over. */
            const flag = (/** @type {number} */ bit)=>[0x81, 0xcb, ...u32(bit)];
            const JNE = 0x75;
            const JE = 0x74;
            const push = (/** @type {number} */ value)=>[0x68, ...u32(value)];
            /** @param {string} name @param {number} bit */
            const zeroAt = (name, bit)=>[
                0x83, 0x3d, ...u32(at(name)), 0x00, JNE, 6, ...flag(bit), // cmp [name], 0
            ];
            /** @param {number} reg @param {number} slot @param {number} want @param {number} bit */
            const slotHolds = (reg, slot, want, bit)=>[
                0x8b, 0x80 | reg, ...u32(slot), //                   mov eax, [reg + slot]
                0x3d, ...u32(want), JNE, 6, ...flag(bit), //         cmp eax, want
            ];
            const ESI = 6;
            const EDI = 7;
            return [
                0x31, 0xdb, //                                       xor ebx, ebx
                // As data.
                0x6a, LOAD_LIBRARY_AS_DATAFILE, 0x6a, 0x00, ...push(at('probe')),
                ...call('LoadLibraryExA'),
                0x89, 0xc6, //                                       mov esi, eax
                0x83, 0xe0, 0x03, 0x83, 0xf8, 0x01, JNE, 6, ...flag(0x1), // (eax & 3) == 1
                ...push(at('probe')), ...call('GetModuleHandleA'),
                0x85, 0xc0, JNE, 6, ...flag(0x2),
                ...zeroAt('attached', 0x4),
                0x56, ...call('FreeLibrary'), //                     push esi
                0x85, 0xc0, JE, 6, ...flag(0x8),
                // Unresolved.
                0x6a, DONT_RESOLVE_DLL_REFERENCES, 0x6a, 0x00, ...push(at('probe')),
                ...call('LoadLibraryExA'),
                0x89, 0xc6, //                                       mov esi, eax
                ...push(at('probe')), ...call('GetModuleHandleA'),
                0x85, 0xf6, JE, 10, //                               test esi, esi; jz
                0x39, 0xf0, JNE, 6, ...flag(0x10), //                cmp eax, esi
                ...zeroAt('attached', 0x20),
                ...slotHolds(ESI, probeSlot, probeUnbound, 0x40),
                ...push(at('probe')), ...call('LoadLibraryA'),
                0x39, 0xf0, JNE, 6, ...flag(0x80), //                cmp eax, esi
                ...zeroAt('attached', 0x100),
                ...slotHolds(ESI, probeSlot, probeUnbound, 0x200),
                // A program, by name.
                ...push(at('tool')), ...call('LoadLibraryA'),
                0x89, 0xc7, //                                       mov edi, eax
                0x85, 0xc0, JE, 6, ...flag(0x400),
                ...zeroAt('ran', 0x800),
                0x85, 0xff, JE, 19, //                               test edi, edi; jz
                ...slotHolds(EDI, toolSlot, toolUnbound, 0x1000),
                0x53, ...call('ExitProcess'), //                     push ebx
            ];
        },
    });
}

test('LoadLibraryEx loads as data, or leaves a module unresolved, as asked', { timeout: 60000 },
    async t=>{
        // The images' entry points store into the program's data, whose
        // address is only known once the program is laid out -- and the
        // program needs the images' import slots. The slots do not move with
        // what an entry point stores, so the images are built again once the
        // program says where.
        const unplaced = image(0);
        /** @type {{ ran: number, attached: number }} */
        let where = { ran: 0, attached: 0 };
        const executable = buildProgram(unplaced.slot, unplaced.unbound, unplaced.slot,
            unplaced.unbound, placed=>{ where = placed; });
        const probe = image(where.attached);
        const tool = image(where.ran);
        assert.deepEqual([probe.slot, probe.unbound, tool.slot, tool.unbound],
            [unplaced.slot, unplaced.unbound, unplaced.slot, unplaced.unbound]);

        const app = await createApp({
            executable,
            imagePath: 'C:\\App\\LoadEx.exe',
            files: [
                { path: 'C:\\App\\probe.dll', bytes: library(probe.file) },
                { path: 'C:\\App\\tool.exe', bytes: tool.file },
            ],
        });
        t.after(()=>app.dispose());

        const code = await app.run({ timeoutMs: 40000 });
        assert.equal(code, ALL, `missing bits 0x${(ALL & ~code).toString(16)}`);
    });

/**
 * A library importing from `NOSUCH.dll`, which nothing provides, whose entry
 * point stores 1 at `into`.
 *
 * @param {number} into
 */
function needy(into){
    return library(movable(buildExe({
        imports: { 'NOSUCH.dll': ['Thing'] },
        code: ()=>[
            0xc7, 0x05, ...u32(into), ...u32(1), //        mov dword [into], 1
            0xb8, ...u32(1), //                            mov eax, 1
            0xc2, 0x0c, 0x00, //                           ret 12
        ],
    })));
}

test('LoadLibrary refuses a library one of whose own libraries is nowhere, as Windows does',
    { timeout: 60000 }, async t=>{
        // Exit code bits: LoadLibrary answered NULL (1), GetLastError says
        // ERROR_MOD_NOT_FOUND (2), GetModuleHandle finds nothing (4), DllMain
        // did not run (8).
        const EVERY = 0xf;
        let attached = 0;
        const executable = buildExe({
            imports: { 'KERNEL32.dll': ['LoadLibraryA', 'GetLastError', 'GetModuleHandleA',
                'ExitProcess'] },
            data: { name: cString('needy.dll'), attached: [0, 0, 0, 0] },
            codeSize: 0x80,
            code: ({ iat, at })=>{
                attached = at('attached');
                /** @param {string} fn */
                const call = fn=>[0xff, 0x15, ...u32(iat(fn))];
                const flag = (/** @type {number} */ bit)=>[0x81, 0xcb, ...u32(bit)];
                const push = (/** @type {number} */ value)=>[0x68, ...u32(value)];
                const JNE = 0x75;
                return [
                    0x31, 0xdb, //                                   xor ebx, ebx
                    ...push(at('name')), ...call('LoadLibraryA'),
                    0x85, 0xc0, JNE, 6, ...flag(0x1), //             test eax, eax
                    ...call('GetLastError'),
                    0x3d, ...u32(126), JNE, 6, ...flag(0x2), //      cmp eax, 126
                    ...push(at('name')), ...call('GetModuleHandleA'),
                    0x85, 0xc0, JNE, 6, ...flag(0x4),
                    0x83, 0x3d, ...u32(at('attached')), 0x00, JNE, 6, ...flag(0x8),
                    0x53, ...call('ExitProcess'), //                 push ebx
                ];
            },
        });
        const app = await createApp({
            executable,
            imagePath: 'C:\\App\\Needy.exe',
            files: [{ path: 'C:\\App\\needy.dll', bytes: needy(attached) }],
        });
        t.after(()=>app.dispose());

        const code = await app.run({ timeoutMs: 40000 });
        assert.equal(code, EVERY, `missing bits 0x${(EVERY & ~code).toString(16)}`);
    });
