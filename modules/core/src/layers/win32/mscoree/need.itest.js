/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The run asks its embedder for the .NET Framework's layer: a managed program
 * started on a volume with no Framework 4, and a Framework setup a program
 * starts, each say `layer-needed` once; with the layer's files on the volume
 * neither does, and the setup is answered as run, exiting 0.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../../app.js';
import { assemble, buildExe } from '../../../../../../tools/fixtures/make-pe.mjs';
import { rewriteResources } from '../kernel32/resource-update.js';
import { managedExe } from '../../../../../../tools/fixtures/managed-exe.mjs';

const SHIM = 'C:\\WINDOWS\\Microsoft.NET\\Framework\\v4.0.30319\\mscoreei.dll';
const SETUP = 'C:\\App\\ndp48-x86-x64-allos-enu.exe';

/** @param {number} value */
const u32 = value=>[0, 8, 16, 24].map(at=>(value >>> at) & 0xff);

/**
 * @param {Uint8Array} executable
 * @param {{ windows?: any, files?: { path: string, bytes: Uint8Array }[] }} [options]
 */
async function run(executable, options = {}){
    /** @type {any[]} */
    const asked = [];
    const app = await createApp({ executable, imagePath: 'C:\\App\\managed.exe',
        windows: 'win7', ...options });
    // Told while the program was loaded, and kept for its first subscriber.
    app.on('layer-needed', (/** @type {any} */ event)=>asked.push(event));
    try
    {
        const code = (await app.run({ timeoutMs: 60_000 })) >>> 0;
        return { code, asked };
    }
    finally
    {
        await app.dispose();
    }
}

/**
 * A version block of one string table, as VerQueryValue reads one.
 *
 * @param {Record<string, string>} strings
 */
function versionBlock(strings){
    const utf16 = (/** @type {string} */ text)=>Uint8Array.from(
        [...`${text}\0`].flatMap(unit=>[unit.charCodeAt(0) & 0xff, unit.charCodeAt(0) >>> 8]));
    const pad = (/** @type {number} */ at)=>at + 3 & ~3;
    /** @param {string} key @param {Uint8Array | string | null} value @param {Uint8Array[]} [children] */
    const node = (key, value, children = [])=>{
        const bytes = typeof value === 'string' ? utf16(value) : value ?? new Uint8Array(0);
        const valueAt = pad(6 + (key.length + 1) * 2);
        let end = valueAt + bytes.length;
        const offsets = children.map(child=>{
            const at = pad(end);
            end = at + child.length;
            return at;
        });
        const out = new Uint8Array(end);
        const view = new DataView(out.buffer);
        view.setUint16(0, end, true);
        view.setUint16(2, typeof value === 'string' ? value.length + 1 : bytes.length, true);
        view.setUint16(4, typeof value === 'string' ? 1 : 0, true);
        out.set(utf16(key), 6);
        out.set(bytes, valueAt);
        children.forEach((child, index)=>out.set(child, offsets[index]));
        return out;
    };
    const fixed = new Uint8Array(52);
    new DataView(fixed.buffer).setUint32(0, 0xfeef04bd, true);
    return node('VS_VERSION_INFO', fixed, [node('StringFileInfo', null, [node('040904B0', null,
        Object.entries(strings).map(([key, text])=>node(key, text)))])]);
}

/** The 4.8 offline installer as far as its version block goes; run, it would exit 0x7f. */
const setupFile = /** @type {Uint8Array} */ (rewriteResources(buildExe({
    imports: { 'KERNEL32.dll': ['ExitProcess'] },
    code: ({ iat })=>[0x6a, 0x7f, 0xff, 0x15, ...u32(iat('ExitProcess'))] }),
[{ type: 16, name: 1, language: 0x409, data: versionBlock({
    CompanyName: 'Microsoft Corporation', FileDescription: 'Microsoft .NET Framework 4.8 Setup',
    OriginalFilename: 'NDP48-x86-x64-AllOS-ENU.exe' }) }]));

/** Starts the setup with CreateProcessA, waits for it, and exits with its exit code. */
const starter = buildExe({
    imports: { 'KERNEL32.dll': ['CreateProcessA', 'WaitForSingleObject', 'GetExitCodeProcess',
        'ExitProcess'] },
    data: { line: [...`"${SETUP}" /q /norestart`].map(c=>c.charCodeAt(0)).concat(0),
        startup: [...u32(68), ...new Array(64).fill(0)], info: new Array(16).fill(0),
        code: u32(0) },
    codeSize: 0x80,
    code: ({ iat, at })=>assemble([
        0x68, ...u32(at('info')), 0x68, ...u32(at('startup')), 0x6a, 0, 0x6a, 0, 0x6a, 0,
        0x6a, 0, 0x6a, 0, 0x6a, 0, 0x68, ...u32(at('line')), 0x6a, 0,
        0xff, 0x15, ...u32(iat('CreateProcessA')),
        0x6a, 0xff, 0xff, 0x35, ...u32(at('info')), //    WaitForSingleObject(hProcess, INFINITE)
        0xff, 0x15, ...u32(iat('WaitForSingleObject')),
        0x68, ...u32(at('code')), 0xff, 0x35, ...u32(at('info')),
        0xff, 0x15, ...u32(iat('GetExitCodeProcess')),
        0xff, 0x35, ...u32(at('code')), 0xff, 0x15, ...u32(iat('ExitProcess')),
    ]),
});

test('a managed program with no Framework on the volume asks for the Framework\'s layer',
    { timeout: 120_000 }, async()=>{
        const { asked } = await run(managedExe());
        assert.deepEqual(asked, [{ layer: 'dotnet48-x86', program: 'C:\\App\\managed.exe' }]);
        const there = await run(managedExe(),
            { files: [{ path: SHIM, bytes: new Uint8Array(64) }] });
        assert.deepEqual(there.asked, [], 'the layer\'s files are there');
    });

test('a Framework setup a program starts asks for the layer, and is answered as run',
    { timeout: 120_000 }, async()=>{
        const without = await run(starter, { files: [{ path: SETUP, bytes: setupFile }] });
        assert.equal(without.code, 0, 'the setup exited 0, not as the file would');
        assert.deepEqual(without.asked, [{ layer: 'dotnet48-x86' }]);
        const within = await run(starter, { files: [{ path: SETUP, bytes: setupFile },
            { path: SHIM, bytes: new Uint8Array(64) }] });
        assert.deepEqual(within, { code: 0, asked: [] });
    });
