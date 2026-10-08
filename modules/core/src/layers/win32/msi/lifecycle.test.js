/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A product's whole life through msi.dll, as a setup and the control panel
 * drive it: a package file installed by MsiInstallProduct, the machine's own
 * copy of it kept, the source taken away, and the product removed by
 * MsiConfigureProduct from that copy alone.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMsiFunctions } from './functions.js';
import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';
import { databaseBytes } from './database-writer.js';
import { EXECUTE_SEQUENCE, MACHINE, machine, packageDatabase } from './install.fixture.js';
import { readFile } from './actions.js';
import { INSTALLSTATE } from './session.js';

const PRODUCT = '{6D7A2B10-1111-4222-8333-944455556666}';
const INSTALLSTATE_ABSENT = 2;

/** @type {import('./install.fixture.js').Tables} */
const TABLES = {
    Property: [['Property', 'Value'], [['ProductCode', PRODUCT], ['ProductName', 'Game'],
        ['ProductVersion', '1.0'], ['Manufacturer', 'Maker'], ['ProductLanguage', '1033'],
        ['ProgramFilesFolder', 'C:\\Program Files\\']]],
    Directory: [['Directory', 'Directory_Parent', 'DefaultDir'], [
        ['TARGETDIR', null, 'SourceDir'], ['ProgramFilesFolder', 'TARGETDIR', '.'],
        ['INSTALLDIR', 'ProgramFilesFolder', 'Game']]],
    Feature: [['Feature', 'Feature_Parent', 'Title', 'Description', 'Display', 'Level',
        'Directory_', 'Attributes'], [['Main', null, 'Main', null, 1, 1, 'INSTALLDIR', 0]]],
    Component: [['Component', 'ComponentId', 'Directory_', 'Attributes', 'Condition',
        'KeyPath'], [['Core', '{11111111-1111-1111-1111-111111111111}', 'INSTALLDIR', 0, null,
        'exe']]],
    FeatureComponents: [['Feature_', 'Component_'], [['Main', 'Core']]],
    File: [['File', 'Component_', 'FileName', 'FileSize', 'Version', 'Language', 'Attributes',
        'Sequence'], [['exe', 'Core', 'game.exe', 4, null, null, 0, 1]]],
    Media: [['DiskId', 'LastSequence', 'DiskPrompt', 'Cabinet', 'VolumeLabel', 'Source'],
        [[1, 1, null, null, null, null]]],
    InstallExecuteSequence: [['Action', 'Condition', 'Sequence'], EXECUTE_SEQUENCE],
};

test('installed from a package, kept by the machine, removed after its source is gone',
    async()=>{
        const host = await machine(['C:\\src', 'C:\\src\\Game'],
            { 'C:\\src\\Game\\game.exe': 'MZ..' });
        const { files, hive } = host;
        const db = packageDatabase(TABLES);
        db.tables.forEach(table=>{
            // Typed as the schema would type them, so the file reads back the same.
            for (const column of table.columns)
            {
                column.type = table.rows.some(row=>typeof row[column.number - 1] === 'number')
                    ? 0x1502 : 0x1dff;
            }
            table.columns[0].type |= 0x2000;
        });
        const bytes = await databaseBytes(db);
        const node = files.open('C:\\src\\game.msi', { write: true, create: true });
        files.write(node, 0, bytes);
        files.close(node);

        const memory = new Uint8Array(0x40000);
        let next = 0x20000;
        const fns = /** @type {any} */ (createMsiFunctions(/** @type {any} */ ({
            readMemory: (/** @type {number} */ at, /** @type {number} */ n)=>
                memory.subarray(at, at + n),
            writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ data)=>
                memory.set(data, at),
            readCString: (/** @type {number} */ at)=>decodeAnsi(memory.subarray(at,
                memory.indexOf(0, at))),
            allocate: (/** @type {number} */ size)=>{
                const at = next;
                next += size + 16;
                return at;
            },
            free: ()=>{},
            hive, files, fullPath: (/** @type {string} */ path)=>path, callerThread: ()=>null,
            machine: ()=>MACHINE,
        })));
        /** @param {number} at @param {string} text */
        const put = (at, text)=>{
            memory.set(encodeAnsi(`${text}\0`), at);
            return at;
        };
        assert.equal(await fns.MsiInstallProductA.handler([put(0x100, 'C:\\src\\game.msi'),
            put(0x200, '')]), 0);
        assert.equal(await readFile(files, 'C:\\Program Files\\Game\\game.exe') !== null, true);
        assert.equal(host.registration.productState(PRODUCT), INSTALLSTATE.DEFAULT);
        const local = host.registration.productInfo(PRODUCT, 'LocalPackage');
        const kept = 'value' in local ? local.value : '';
        assert.match(kept, /^C:\\WINDOWS\\Installer\\[0-9a-f]+\.msi$/,
            'the machine\'s own copy');
        assert.ok(files.stat(kept)?.size > 0);

        files.remove('C:\\src\\game.msi');
        assert.equal(await fns.MsiConfigureProductA.handler([put(0x300, PRODUCT), 0,
            INSTALLSTATE_ABSENT]), 0);
        assert.equal(await readFile(files, 'C:\\Program Files\\Game\\game.exe'), null);
        assert.equal(host.registration.productState(PRODUCT), INSTALLSTATE.UNKNOWN);
        assert.equal(files.stat(kept), null, 'and the copy goes with the product');
    });
