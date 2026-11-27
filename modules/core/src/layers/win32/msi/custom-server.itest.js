/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A library custom action of the other width runs in a custom action server,
 * as Windows Installer runs one: a 32-bit setup on a 64-bit machine starts
 * msiexec, its installation meets a 64-bit library in the package's Binary
 * table, and the action, run in a 64-bit msiexec -Embedding, reads a property
 * of the installation's session and sets another, which the installation
 * then writes to the registry. A 64-bit library loaded into the 32-bit
 * installer fails to load, and the installation ends 1603 (the .NET
 * Framework's x64 package's WiX actions).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../../app.js';
import { buildExe } from '../../../../../../tools/fixtures/make-pe.mjs';
import { waitingParent } from '../../../../../../tools/fixtures/spawn-program.mjs';
import { HKEY_CURRENT_USER } from '../advapi32/registry.js';
import { databaseBytes } from './database-writer.js';
import { MSITYPE } from './database.js';
import { EXECUTE_SEQUENCE, packageDatabase, registryText, typed } from './install.fixture.js';

/** @param {number} value */
const u32 = value=>[0, 8, 16, 24].map(at=>(value >>> at) & 0xff);
/** @param {string} text */
const wide = text=>[...Buffer.from(`${text}\0`, 'utf16le')];

/**
 * A 64-bit library whose export `Act(hInstall)` copies the session's
 * ProductLanguage into a property FROM64 and answers ERROR_SUCCESS.
 */
function library64(){
    return buildExe({
        dll: true,
        bits: 64,
        imageBase: 0x180000000,
        imports: { 'msi.dll': ['MsiGetPropertyW', 'MsiSetPropertyW'] },
        data: { language: wide('ProductLanguage'), into: wide('FROM64'),
            buffer: new Array(64).fill(0), size: u32(32) },
        exports: [{ name: 'Act', offset: 0x10 }],
        codeSize: 0x60,
        code: ({ iat, at, code })=>{
            /** @param {number} target @param {number} next */
            const rel = (target, next)=>u32((target - code(next)) | 0);
            const bytes = new Array(0x60).fill(0xcc);
            // DllMain: TRUE.
            bytes.splice(0, 6, 0xb8, 1, 0, 0, 0, 0xc3);
            const act = [
                0x53,                                            // push rbx
                0x48, 0x83, 0xec, 0x20,                          // sub rsp, 0x20
                0x48, 0x89, 0xcb,                                // mov rbx, rcx
                0x48, 0x8d, 0x15, ...rel(at('language'), 0x1f),  // lea rdx, [language]
                0x4c, 0x8d, 0x05, ...rel(at('buffer'), 0x26),    // lea r8, [buffer]
                0x4c, 0x8d, 0x0d, ...rel(at('size'), 0x2d),      // lea r9, [size]
                0xff, 0x15, ...rel(iat('MsiGetPropertyW'), 0x33),
                0x48, 0x89, 0xd9,                                // mov rcx, rbx
                0x48, 0x8d, 0x15, ...rel(at('into'), 0x3d),      // lea rdx, [into]
                0x4c, 0x8d, 0x05, ...rel(at('buffer'), 0x44),    // lea r8, [buffer]
                0xff, 0x15, ...rel(iat('MsiSetPropertyW'), 0x4a),
                0x31, 0xc0,                                      // xor eax, eax
                0x48, 0x83, 0xc4, 0x20,                          // add rsp, 0x20
                0x5b,                                            // pop rbx
                0xc3,                                            // ret
            ];
            bytes.splice(0x10, act.length, ...act);
            return bytes;
        },
    });
}

/** The package: the action before InstallInitialize, a registry value of what it set. */
function serverPackage(){
    const db = typed(packageDatabase({
        Property: [['Property', 'Value'], [
            ['ProductCode', '{6C1D2E3F-4A5B-4C6D-8E7F-9A0B1C2D3E4F}'], ['ProductName', 'Wide'],
            ['ProductVersion', '1.0'], ['Manufacturer', 'Maker'], ['ProductLanguage', '1033']]],
        Directory: [['Directory', 'Directory_Parent', 'DefaultDir'],
            [['TARGETDIR', null, 'SourceDir']]],
        Feature: [['Feature', 'Feature_Parent', 'Title', 'Description', 'Display', 'Level',
            'Directory_', 'Attributes'], [['Main', null, 'Main', null, 1, 1, 'TARGETDIR', 0]]],
        Component: [['Component', 'ComponentId', 'Directory_', 'Attributes', 'Condition',
            'KeyPath'], [['Reg', '{7D2E3F4A-5B6C-4D7E-9F8A-0B1C2D3E4F5A}', 'TARGETDIR', 4, null,
            'value']]],
        FeatureComponents: [['Feature_', 'Component_'], [['Main', 'Reg']]],
        Registry: [['Registry', 'Root', 'Key', 'Name', 'Value', 'Component_'],
            [['value', 1, 'Software\\Bottlify\\Server', 'Language', '[FROM64]', 'Reg']]],
        Binary: [['Name', 'Data'], [['ca64', null]]],
        CustomAction: [['Action', 'Type', 'Source', 'Target'], [['Read64', 1, 'ca64', 'Act']]],
        Media: [['DiskId', 'LastSequence', 'DiskPrompt', 'Cabinet', 'VolumeLabel', 'Source'],
            [[1, 0, null, null, null, null]]],
        InstallExecuteSequence: [['Action', 'Condition', 'Sequence'],
            [...EXECUTE_SEQUENCE, ['Read64', null, 1450]]],
    }, { 'Binary.ca64': library64() }));
    const data = db.table('Binary')?.columns[1];
    if (data)
    {
        data.type = MSITYPE.STRING | MSITYPE.VALID | MSITYPE.NULLABLE;
    }
    return databaseBytes(db);
}

// A process in a worker of its own makes no pipe another process can hold: the
// run's pipe namespace is on the run's thread, so its CreatePipe pair is its
// own alone and its children inherit nothing of it.
const NO_PIPES_ACROSS = 'a process in a worker of its own has no pipes its children inherit';
for (const [where, options, todo] of /** @type {[string, any, string | undefined][]} */ ([
    ['beside the installation', {}, undefined],
    ['in a worker of its own', { concurrency: 4 }, NO_PIPES_ACROSS],
]))
{
    test(`a 64-bit library action of a 32-bit installation runs in a custom action server ${where}`,
        { timeout: 180000, todo }, async t=>{
            const app = await createApp({
                executable: waitingParent('msiexec /i wide.msi /qn'),
                imagePath: 'C:\\App\\setup.exe',
                machine: 'amd64',
                files: [{ path: 'C:\\App\\wide.msi', bytes: await serverPackage() }],
                unattended: true,
                ...options,
            });
            t.after(()=>app.dispose());
            /** @type {any[]} */
            const started = [];
            app.on('process-started', (/** @type {any} */ event)=>started.push(event));
            const code = await app.run({ timeoutMs: 150000 });
            assert.equal(code, 0, 'the installation answered ERROR_SUCCESS');
            assert.equal(registryText(app.registry(), HKEY_CURRENT_USER,
                'Software\\Bottlify\\Server', 'Language'), '1033',
            'the action read ProductLanguage and set FROM64 in the installation\'s session');
            assert.deepEqual(started.map(event=>event.image).filter(image=>/msiexec/i.test(image)),
                ['C:\\WINDOWS\\SysWOW64\\msiexec.exe', 'C:\\WINDOWS\\system32\\msiexec.exe'],
                'the 32-bit setup\'s msiexec is SysWOW64\'s, its server the system folder\'s');
        });
}
