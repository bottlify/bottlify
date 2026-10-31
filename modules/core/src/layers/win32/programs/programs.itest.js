/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The system programs as a parent sees them: a compiled parent starts one by
 * the name an installer uses, waits on it and exits with its exit code. Each
 * case checks that code and what the program did -- the product a package
 * installed, the registration a library wrote, the routine rundll32 ran --
 * with no file for any of the programs on the volume.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../../app.js';
import { buildExe } from '../../../../../../tools/make-pe.mjs';
import { waitingParent } from '../../../../../../tools/spawn-program.mjs';
import { HKEY_CURRENT_USER } from '../advapi32/registry.js';
import { databaseBytes } from '../msi/database-writer.js';
import { EXECUTE_SEQUENCE, packageDatabase, registryText } from '../msi/install.fixture.js';

const PRODUCT = '{0B7D2E40-5A61-4C8E-9F1A-3C2D4E5F6A7B}';

/** @param {number} value */
const u32 = value=>[0, 8, 16, 24].map(at=>(value >>> at) & 0xff);

/** A package whose one component writes HKCU\Software\Bottlify\Installed, Version = yes. */
async function registryPackage(){
    /** @type {import('../msi/install.fixture.js').Tables} */
    const tables = {
        Property: [['Property', 'Value'], [['ProductCode', PRODUCT], ['ProductName', 'Tiny'],
            ['ProductVersion', '1.0'], ['Manufacturer', 'Maker'], ['ProductLanguage', '1033']]],
        Directory: [['Directory', 'Directory_Parent', 'DefaultDir'],
            [['TARGETDIR', null, 'SourceDir']]],
        Feature: [['Feature', 'Feature_Parent', 'Title', 'Description', 'Display', 'Level',
            'Directory_', 'Attributes'], [['Main', null, 'Main', null, 1, 1, 'TARGETDIR', 0]]],
        Component: [['Component', 'ComponentId', 'Directory_', 'Attributes', 'Condition',
            'KeyPath'], [['Reg', '{5E6F7A8B-1C2D-4E3F-8A9B-0C1D2E3F4A5B}', 'TARGETDIR', 4, null,
            'version']]],
        FeatureComponents: [['Feature_', 'Component_'], [['Main', 'Reg']]],
        Registry: [['Registry', 'Root', 'Key', 'Name', 'Value', 'Component_'],
            [['version', 1, 'Software\\Bottlify\\Installed', 'Version', 'yes', 'Reg']]],
        Media: [['DiskId', 'LastSequence', 'DiskPrompt', 'Cabinet', 'VolumeLabel', 'Source'],
            [[1, 0, null, null, null, null]]],
        InstallExecuteSequence: [['Action', 'Condition', 'Sequence'], EXECUTE_SEQUENCE],
    };
    const db = packageDatabase(tables);
    db.tables.forEach(table=>{
        // Typed as the schema would type them, so the file reads back the same.
        for (const column of table.columns)
        {
            column.type = table.rows.some(row=>typeof row[column.number - 1] === 'number')
                ? 0x1502 : 0x1dff;
        }
        table.columns[0].type |= 0x2000;
    });
    return databaseBytes(db);
}

/**
 * A library for regsvr32 and rundll32, each routine writing what it was
 * handed where the test reads it:
 * - DllRegisterServer: HKCU\Software\Bottlify\Registered = "yes", S_OK;
 * - DllUnregisterServer: E_FAIL, writing nothing;
 * - Entry (ANSI), WideEntryW, WideEntry (ANSI): the command line they were
 *   handed, as the default value of ...\Run, ...\Wide and ...\Plain.
 */
function registeringLibrary(){
    const HKCU = u32(0x80000001);
    /** @param {string} text */
    const ansi = text=>[...Buffer.from(`${text}\0`, 'latin1')];
    /** @param {string} text */
    const wide = text=>[...Buffer.from(`${text}\0`, 'utf16le')];
    return buildExe({
        dll: true,
        imageBase: 0x10000000,
        imports: { 'ADVAPI32.dll': ['RegSetValueA', 'RegSetValueW'] },
        data: {
            registered: ansi('Software\\Bottlify\\Registered'), yes: ansi('yes'),
            run: ansi('Software\\Bottlify\\Run'), plain: ansi('Software\\Bottlify\\Plain'),
            wide: wide('Software\\Bottlify\\Wide'),
        },
        exports: [
            { name: 'DllRegisterServer', offset: 0x08 },
            { name: 'DllUnregisterServer', offset: 0x30 },
            { name: 'Entry', offset: 0x40 },
            { name: 'WideEntry', offset: 0x80 },
            { name: 'WideEntryW', offset: 0x60 },
        ],
        codeSize: 0xa0,
        code: ({ iat, at })=>{
            /** RegSetValue(HKCU, key, REG_SZ, the routine's lpszCmdLine, 0); ret 16. */
            const entry = (/** @type {string} */ key, /** @type {string} */ call)=>[
                0x6a, 0x00, 0xff, 0x74, 0x24, 0x10, 0x6a, 0x01, 0x68, ...u32(at(key)),
                0x68, ...HKCU, 0xff, 0x15, ...u32(iat(call)), 0xc2, 0x10, 0x00,
            ];
            const code = new Array(0xa0).fill(0xcc);
            /** @param {number} offset @param {number[]} bytes */
            const place = (offset, bytes)=>code.splice(offset, bytes.length, ...bytes);
            // DllMain: TRUE.
            place(0x00, [0xb8, ...u32(1), 0xc2, 0x0c, 0x00]);
            place(0x08, [0x6a, 0x03, 0x68, ...u32(at('yes')), 0x6a, 0x01,
                0x68, ...u32(at('registered')), 0x68, ...HKCU,
                0xff, 0x15, ...u32(iat('RegSetValueA')), 0x33, 0xc0, 0xc3]);
            // DllUnregisterServer: E_FAIL.
            place(0x30, [0xb8, ...u32(0x80004005), 0xc3]);
            place(0x40, entry('run', 'RegSetValueA'));
            place(0x60, entry('wide', 'RegSetValueW'));
            place(0x80, entry('plain', 'RegSetValueA'));
            return code;
        },
    });
}

/**
 * Runs a parent that starts `command` and exits with the child's code.
 *
 * @param {import('node:test').TestContext} t @param {string} command
 * @param {Record<string, any>} [options]
 */
async function startedBy(t, command, options = {}){
    const app = await createApp({
        executable: waitingParent(command),
        imagePath: 'C:\\App\\setup.exe',
        files: [
            { path: 'C:\\App\\tiny.msi', bytes: await registryPackage() },
            { path: 'C:\\App\\reg.dll', bytes: registeringLibrary() },
        ],
        // Without /s, regsvr32 says how it went in a box nobody is there to close.
        unattended: true,
        ...options,
    });
    t.after(()=>app.dispose());
    /** @type {any[]} */
    const started = [];
    app.on('process-started', (/** @type {any} */ event)=>started.push(event));
    /** @type {string[]} */
    const boxes = [];
    app.on('divergence', (/** @type {any} */ event)=>{
        if (event.api === 'MessageBox')
        {
            boxes.push(event.detail);
        }
    });
    const code = await app.run({ timeoutMs: 60000 });
    /** @param {string} key @param {string} [name] */
    const value = (key, name = '')=>registryText(app.registry(), HKEY_CURRENT_USER,
        `Software\\Bottlify\\${key}`, name);
    return { code, started, boxes, value, app };
}

for (const [where, options] of /** @type {[string, any][]} */ ([
    ['beside its parent', {}],
    ['in a worker of its own', { concurrency: 2 }],
]))
{
    test(`msiexec ${where} installs a package named relative to its parent's directory, and`
        + ' exits with the installer\'s answer', { timeout: 120000 }, async t=>{
        const run = await startedBy(t, 'msiexec /i tiny.msi /qn', options);
        assert.equal(run.code, 0, 'MsiInstallProduct answered ERROR_SUCCESS');
        assert.equal(run.value('Installed', 'Version'), 'yes', 'and the package was installed');
        const child = run.started.filter(event=>event.image !== 'C:\\App\\setup.exe');
        assert.deepEqual(child.map(event=>event.image), ['C:\\WINDOWS\\system32\\msiexec.exe'],
            'found in the system folder, with no file there');
        if (options.concurrency)
        {
            assert.equal(child[0].worker, true, 'in a worker of its own');
        }
    });
}

test('msiexec answers a usage error with 1639, and an unknown product with what msi.dll does',
    { timeout: 120000 }, async t=>{
        assert.equal((await startedBy(t, 'msiexec /z')).code, 1639, 'an option it does not take');
        assert.equal((await startedBy(t, 'MsiExec.exe /qn')).code, 1639, 'nothing to do');
        assert.equal((await startedBy(t, `C:\\Windows\\System32\\MsiExec.exe /X${PRODUCT} /qn`))
            .code, 1605, 'removing a product that is not installed: ERROR_UNKNOWN_PRODUCT');
    });

test('regsvr32 /s registers a library and exits 0; its failures exit 3, 4 and 5',
    { timeout: 120000 }, async t=>{
        const registered = await startedBy(t, 'regsvr32 /s C:\\App\\reg.dll');
        assert.equal(registered.code, 0);
        assert.equal(registered.value('Registered'), 'yes', 'DllRegisterServer ran');
        assert.deepEqual(registered.boxes, [], 'silent');

        const told = await startedBy(t, 'regsvr32 reg.dll');
        assert.equal(told.code, 0, 'a bare name, found in the parent\'s directory');
        assert.deepEqual(told.boxes.map(box=>/succeeded/.test(box)), [true],
            'and said so, without /s');

        assert.equal((await startedBy(t, 'regsvr32 /s C:\\App\\none.dll')).code, 3,
            'a library that does not load');
        assert.equal((await startedBy(t, 'regsvr32 /s /n /i:x C:\\App\\reg.dll')).code, 4,
            'an entry the library does not export');
        assert.equal((await startedBy(t, 'regsvr32 /s /u C:\\App\\reg.dll')).code, 5,
            'an entry that answered E_FAIL');
        assert.equal((await startedBy(t, 'regsvr32 /s /n C:\\App\\reg.dll')).code, 1,
            '/n without /i');
    });

test('rundll32 calls the entry with the rest of the line, its W spelling first, and exits 0',
    { timeout: 120000 }, async t=>{
        const ansi = await startedBy(t, 'rundll32.exe "C:\\App\\reg.dll",Entry  one two');
        assert.equal(ansi.code, 0);
        assert.equal(ansi.value('Run'), 'one two', 'the line after the entry, as typed');

        const wide = await startedBy(t, 'rundll32 C:\\App\\reg.dll WideEntry three');
        assert.equal(wide.code, 0);
        assert.equal(wide.value('Wide'), 'three', 'WideEntryW, handed the line as UTF-16');
        assert.equal(wide.value('Plain'), null, 'and not the ANSI WideEntry');
    });
