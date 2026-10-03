/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A program started from a disc image, as an installer is: the image mounted
 * as D:, the program's own file read off it, and the program asking about the
 * drive it was started from. It checks one property per bit of its exit code.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { createApp as createHostedApp } from './index.js';
import { buildExe } from '../../../tools/make-pe.mjs';
import { buildIso } from './layers/filesystem/internal/iso/iso.fixture.js';
import { openIso } from './layers/filesystem/internal/iso/iso9660.js';

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/** @param {string} text */
const cString = text=>[...text].map(c=>c.charCodeAt(0)).concat(0);

const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const CREATE_ALWAYS = 2;
const OPEN_EXISTING = 3;
const DRIVE_CDROM = 5;
const ERROR_WRITE_PROTECT = 19;

/**
 * Exit code bits: D:\ is a CD-ROM (1) labelled DEMO (2) on CDFS (4); the
 * program's current directory is the disc's root (8); a file on the disc
 * opens (0x10) and reads its first four bytes (0x20); creating one there
 * fails (0x40) as write-protected (0x80); and copying one to C: succeeds
 * (0x100).
 */
const ALL = 0x1ff;

function buildProgram(){
    return buildExe({
        imports: { 'KERNEL32.dll': ['GetDriveTypeA', 'GetVolumeInformationA', 'CreateFileA',
            'ReadFile', 'GetLastError', 'GetCurrentDirectoryA', 'CopyFileA', 'ExitProcess'] },
        data: {
            root: cString('D:\\'),
            data: cString('D:\\Data\\Game Data.cab'),
            fresh: cString('D:\\new.txt'),
            copy: cString('C:\\copy.cab'),
            label: new Array(32).fill(0),
            system: new Array(16).fill(0),
            here: new Array(64).fill(0),
            buffer: new Array(16).fill(0),
            count: [0, 0, 0, 0],
        },
        codeSize: 0x200,
        code: ({ iat, at })=>{
            /** @param {string} fn */
            const call = fn=>[0xff, 0x15, ...u32(iat(fn))];
            const push = (/** @type {number} */ value)=>[0x68, ...u32(value)];
            /** or ebx, bit -- six bytes, which is what each skip jumps over. */
            const flag = (/** @type {number} */ bit)=>[0x81, 0xcb, ...u32(bit)];
            const JNE = 0x75;
            const JE = 0x74;
            /** @param {string} name @param {number} value @param {number} bit */
            const holds = (name, value, bit)=>[
                0x81, 0x3d, ...u32(at(name)), ...u32(value), JNE, 6, ...flag(bit),
            ];
            return [
                0x31, 0xdb, //                                          xor ebx, ebx
                ...push(at('root')), ...call('GetDriveTypeA'),
                0x83, 0xf8, DRIVE_CDROM, JNE, 6, ...flag(0x1), //       cmp eax, 5
                0x6a, 16, ...push(at('system')), 0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00,
                0x6a, 32, ...push(at('label')), ...push(at('root')),
                ...call('GetVolumeInformationA'),
                ...holds('label', 0x4f4d4544, 0x2), //                  "DEMO"
                ...holds('system', 0x53464443, 0x4), //                 "CDFS"
                ...push(at('here')), 0x6a, 64, ...call('GetCurrentDirectoryA'),
                ...holds('here', 0x005c3a44, 0x8), //                   "D:\"
                0x6a, 0x00, 0x6a, 0x00, 0x6a, OPEN_EXISTING, 0x6a, 0x00, 0x6a, 0x01,
                ...push(GENERIC_READ), ...push(at('data')), ...call('CreateFileA'),
                0x83, 0xf8, 0xff, JE, 6, ...flag(0x10), //              cmp eax, -1
                0x6a, 0x00, ...push(at('count')), 0x6a, 4, ...push(at('buffer')),
                0x50, ...call('ReadFile'), //                           push eax
                ...holds('buffer', 0x04030201, 0x20),
                0x6a, 0x00, 0x6a, 0x00, 0x6a, CREATE_ALWAYS, 0x6a, 0x00, 0x6a, 0x00,
                ...push(GENERIC_WRITE), ...push(at('fresh')), ...call('CreateFileA'),
                0x83, 0xf8, 0xff, JNE, 6, ...flag(0x40),
                ...call('GetLastError'),
                0x83, 0xf8, ERROR_WRITE_PROTECT, JNE, 6, ...flag(0x80),
                0x6a, 0x00, ...push(at('copy')), ...push(at('data')), ...call('CopyFileA'),
                0x85, 0xc0, JE, 6, ...flag(0x100),
                0x53, ...call('ExitProcess'), //                        push ebx
            ];
        },
    });
}

test('a program started from a disc finds a read-only CD-ROM it was started from',
    { timeout: 60000 }, async t=>{
        const program = buildProgram();
        const cabinet = Uint8Array.from({ length: 5000 }, (_, at)=>(at + 1) & 0xff);
        const image = buildIso({
            label: 'DEMO',
            files: {
                'AUTORUN.INF': '[autorun]\r\nopen=SETUP.EXE\r\n',
                'SETUP.EXE': program,
                'Data/Game Data.cab': cabinet,
            },
        });
        // The program is read off the disc, as whoever starts it reads it.
        const iso = await openIso((offset, length)=>image.subarray(offset, offset + length));
        const entry = /** @type {any} */ (iso.find('SETUP.EXE'));
        const executable = /** @type {Uint8Array} */ (iso.read(entry, 0, entry.size));
        assert.deepEqual(executable, program);

        /** @type {any[]} */
        const mounted = [];
        const app = await createApp({
            executable,
            imagePath: 'D:\\SETUP.EXE',
            discs: [{ image: new Blob([image]) }],
        });
        t.after(()=>app.dispose());
        app.on?.('disc', (/** @type {any} */ payload)=>mounted.push(payload));

        const code = await app.run({ timeoutMs: 40000 });
        assert.equal(code, ALL, `missing bits 0x${(ALL & ~code).toString(16)}`);
        const copied = app.session.export()
            .find((/** @type {any} */ file)=>file.path.toLowerCase() === 'c:\\copy.cab');
        assert.deepEqual(copied?.bytes, cabinet);
        assert.ok(!app.session.export().some((/** @type {any} */ file)=>/^d:/i.test(file.path)),
            'nothing of the disc is in what the program wrote');
    });

test('a disc crosses the port protocol as the Blob it was chosen as', { timeout: 60000 }, async t=>{
    const program = buildExe({
        imports: { 'KERNEL32.dll': ['GetDriveTypeA', 'ExitProcess'] },
        data: { root: cString('D:\\') },
        codeSize: 0x40,
        code: ({ iat, at })=>[
            0x68, ...u32(at('root')), 0xff, 0x15, ...u32(iat('GetDriveTypeA')),
            0x50, 0xff, 0x15, ...u32(iat('ExitProcess')), //           push eax
        ],
    });
    const app = await createHostedApp({
        host: 'thread',
        executable: program,
        imagePath: 'D:\\SETUP.EXE',
        discs: [{ image: new Blob([buildIso({ files: { 'SETUP.EXE': program } })]) }],
    });
    t.after(()=>app.dispose());
    assert.equal(await app.run({ timeoutMs: 40000 }), DRIVE_CDROM);
});
