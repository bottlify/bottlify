/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * DXSETUP in the engine's place: the optional components' cabinets beside it
 * installed by their INFs through the process's own file calls, the system's
 * own DirectX cabinets left alone, and a file it could not write said in its
 * exit code.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cabinet } from '../../../steam/redist.fixture.js';
import { fakeContext } from './context.fixture.js';
import { DSETUPERR_NOCOPY, DXSETUP_SUCCESS, runDxsetup } from './dxsetup.js';

/** @param {string} text */
const latin1 = text=>Uint8Array.from(text, c=>c.charCodeAt(0));

/** @param {string} text */
const wide = text=>{
    const bytes = new Uint8Array((text.length + 1) * 2);
    [...text].forEach((c, i)=>{
        bytes[i * 2] = c.charCodeAt(0);
    });
    return bytes;
};

/** @param {number} value */
const dword = value=>new Uint8Array(Uint32Array.of(value).buffer);

/** A PE image of a machine, as much of one as says which. @param {number} kind */
function peImage(kind){
    const bytes = new Uint8Array(0x100);
    const view = new DataView(bytes.buffer);
    view.setUint32(0x3c, 0x80, true);
    view.setUint16(0x84, kind, true);
    return bytes;
}

const D3DX10 = cabinet({
    'd3dx10_43.dll': peImage(0x14c),
    'd3dx10_43_x86.inf': latin1(['[Version]', 'Signature = "$Windows NT$"',
        '[DestinationDirs]', 'DefaultDestDir = 11', '[x86_Install]', 'CopyFiles = Files',
        '[Files]', 'd3dx10_43.dll'].join('\r\n')),
});
/** The system's own DirectX, for systems before XP: never read. */
const DXNT = cabinet({ 'ddraw.dll': peImage(0x14c) });

const FOLDER = 'C:\\Install\\dx\\';

/**
 * A machine whose volume has the setup's folder, answering the file calls
 * DXSETUP makes; `refuse` names a path CreateFileW will not open for writing.
 *
 * @param {{ refuse?: string }} [options]
 */
function machine({ refuse } = {}){
    /** @type {Record<string, Uint8Array>} */
    const files = {
        [`${FOLDER}DXSETUP.exe`]: peImage(0x14c),
        [`${FOLDER}Jun2010_d3dx10_43_x86.cab`]: D3DX10,
        [`${FOLDER}dxnt.cab`]: DXNT,
    };
    /** @type {Map<number, { path: string, writing: boolean }>} */
    const handles = new Map();
    /** @type {Set<string>} */
    const opened = new Set();
    /** @type {string[]} */
    let listing = [];
    let nextHandle = 0x100;
    let nextBuffer = 0x800000;
    /** @param {any} text */
    const pathOf = text=>String(text).slice(2, -1);
    /** @param {number} at @param {string} name @param {number} size */
    const record = (at, name, size)=>{
        const bytes = new Uint8Array(592);
        bytes.set(dword(size), 32);
        bytes.set(wide(name), 44);
        fake.memory.set(at, bytes);
    };
    const fake = fakeContext(`"${FOLDER}DXSETUP.exe" /silent`, call=>{
        const args = /** @type {any[]} */ (call.args);
        switch (call.name)
        {
            case 'GetModuleFileNameW':
                fake.memory.set(args[1], wide(`${FOLDER}DXSETUP.exe`));
                return `${FOLDER}DXSETUP.exe`.length;
            case 'GetNativeSystemInfo':
                fake.memory.set(args[0], new Uint8Array(36));
                return 0;
            case 'FindFirstFileW': {
                const pattern = pathOf(args[0]);
                assert.equal(pattern, `${FOLDER}*.cab`);
                listing = Object.keys(files).filter(path=>path.toLowerCase().endsWith('.cab'))
                    .map(path=>path.slice(FOLDER.length));
                const first = listing.shift();
                if (!first)
                {
                    return 0xffffffff;
                }
                record(args[1], first, files[FOLDER + first].length);
                return 0x77;
            }
            case 'FindNextFileW': {
                const next = listing.shift();
                if (!next)
                {
                    return 0;
                }
                record(args[1], next, files[FOLDER + next].length);
                return 1;
            }
            case 'CreateFileW': {
                const path = pathOf(args[0]);
                const writing = (args[1] & 0x40000000) !== 0;
                if (writing ? path === refuse : !files[path])
                {
                    return 0xffffffff;
                }
                opened.add(path);
                handles.set(nextHandle, { path, writing });
                return nextHandle++;
            }
            case 'VirtualAlloc': {
                const at = nextBuffer;
                nextBuffer += 0x100000;
                return at;
            }
            case 'ReadFile': {
                const content = files[/** @type {any} */ (handles.get(args[0])).path];
                fake.memory.set(args[1], content.slice(0, args[2]));
                fake.memory.set(args[3], dword(Math.min(content.length, args[2])));
                return 1;
            }
            case 'WriteFile': {
                const into = /** @type {any} */ (handles.get(args[0]));
                files[into.path] = (fake.memory.get(args[1]) ?? new Uint8Array(0))
                    .slice(0, args[2]);
                fake.memory.set(args[3], dword(args[2]));
                return 1;
            }
            default:
                return 1;
        }
    });
    return { ...fake, files, opened };
}

test('the optional components beside it are installed by their INFs', async()=>{
    const { context, files, opened } = machine();
    assert.equal(await runDxsetup(context), DXSETUP_SUCCESS);
    assert.deepEqual([...files['C:\\WINDOWS\\system32\\d3dx10_43.dll']], [...peImage(0x14c)]);
    assert.equal(opened.has(`${FOLDER}dxnt.cab`), false, 'the system\'s own DirectX left alone');
    assert.equal(files['C:\\WINDOWS\\system32\\ddraw.dll'], undefined);
});

test('a file it cannot write is DSETUPERR_NOCOPY, not success', async()=>{
    const { context } = machine({ refuse: 'C:\\WINDOWS\\system32\\d3dx10_43.dll' });
    assert.equal(await runDxsetup(context), DSETUPERR_NOCOPY);
});
