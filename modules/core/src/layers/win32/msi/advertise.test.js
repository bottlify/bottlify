/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A product advertised to the machine: published with its shortcut and none
 * of its files, then installed by the first use of its feature.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMsiFunctions } from './functions.js';
import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';
import { databaseBytes } from './database-writer.js';
import { MACHINE, machine, packageDatabase, typed } from './install.fixture.js';
import { readFile } from './actions.js';
import { INSTALLSTATE } from './session.js';
import { decodeShellLink } from '../common/shell-link.js';
import { decomposeDescriptor } from './products.js';

const PRODUCT = '{6D7A2B10-1111-4222-8333-944455556666}';
const CORE = '{11111111-1111-1111-1111-111111111111}';

/** @type {import('./install.fixture.js').Tables} */
const TABLES = {
    Property: [['Property', 'Value'], [['ProductCode', PRODUCT], ['ProductName', 'Game'],
        ['ProductVersion', '1.0'], ['Manufacturer', 'Maker'], ['ProductLanguage', '1033'],
        ['ProgramFilesFolder', 'C:\\Program Files\\'],
        ['ProgramMenuFolder', 'C:\\WINDOWS\\Menu\\']]],
    Directory: [['Directory', 'Directory_Parent', 'DefaultDir'], [
        ['TARGETDIR', null, 'SourceDir'], ['ProgramFilesFolder', 'TARGETDIR', '.'],
        ['INSTALLDIR', 'ProgramFilesFolder', 'Game'], ['ProgramMenuFolder', 'TARGETDIR', '.']]],
    Feature: [['Feature', 'Feature_Parent', 'Title', 'Description', 'Display', 'Level',
        'Directory_', 'Attributes'], [['Main', null, 'Main', null, 1, 1, 'INSTALLDIR', 0]]],
    Component: [['Component', 'ComponentId', 'Directory_', 'Attributes', 'Condition',
        'KeyPath'], [['Core', CORE, 'INSTALLDIR', 0, null, 'exe']]],
    FeatureComponents: [['Feature_', 'Component_'], [['Main', 'Core']]],
    File: [['File', 'Component_', 'FileName', 'FileSize', 'Version', 'Language', 'Attributes',
        'Sequence'], [['exe', 'Core', 'game.exe', 4, null, null, 0, 1]]],
    Media: [['DiskId', 'LastSequence', 'DiskPrompt', 'Cabinet', 'VolumeLabel', 'Source'],
        [[1, 1, null, null, null, null]]],
    Shortcut: [['Shortcut', 'Directory_', 'Name', 'Component_', 'Target', 'Arguments',
        'Description', 'Hotkey', 'Icon_', 'IconIndex', 'ShowCmd', 'WkDir'],
    [['play', 'ProgramMenuFolder', 'Play', 'Core', 'Main', null, null, null, null, null, null,
        null]]],
    AdvertiseExecuteSequence: [['Action', 'Condition', 'Sequence'], [
        ['CostInitialize', null, 800], ['CostFinalize', null, 1000],
        ['InstallValidate', null, 1400], ['InstallInitialize', null, 1500],
        ['CreateShortcuts', null, 4500], ['PublishFeatures', null, 6300],
        ['PublishProduct', null, 6400], ['InstallFinalize', null, 6600]]],
    InstallExecuteSequence: [['Action', 'Condition', 'Sequence'], [
        ['CostInitialize', null, 800], ['CostFinalize', null, 1000],
        ['InstallValidate', null, 1400], ['InstallInitialize', null, 1500],
        ['ProcessComponents', null, 1600], ['InstallFiles', null, 4000],
        ['CreateShortcuts', null, 4500], ['RegisterProduct', null, 6100],
        ['PublishFeatures', null, 6300], ['PublishProduct', null, 6400],
        ['InstallFinalize', null, 6600]]],
};

test('advertised, then installed by the first use of its feature', async()=>{
    const host = await machine(['C:\\src', 'C:\\src\\Game', 'C:\\WINDOWS\\Menu'],
        { 'C:\\src\\Game\\game.exe': 'MZ..' });
    const { files } = host;
    const node = files.open('C:\\src\\game.msi', { write: true, create: true });
    files.write(node, 0, await databaseBytes(typed(packageDatabase(TABLES))));
    files.close(node);
    const memory = new Uint8Array(0x40000);
    const view = new DataView(memory.buffer);
    let next = 0x20000;
    const fns = /** @type {any} */ (createMsiFunctions(/** @type {any} */ ({
        readMemory: (/** @type {number} */ at, /** @type {number} */ n)=>memory.subarray(at, at + n),
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
        hive: host.hive, files, fullPath: (/** @type {string} */ path)=>path,
        callerThread: ()=>null, machine: ()=>MACHINE,
    })));
    /** @param {number} at @param {string} text */
    const put = (at, text)=>{
        memory.set(encodeAnsi(`${text}\0`), at);
        return at;
    };
    const ADVERTISEFLAGS_MACHINEASSIGN = 0;
    assert.equal(await fns.MsiAdvertiseProductA.handler([put(0x100, 'C:\\src\\game.msi'),
        ADVERTISEFLAGS_MACHINEASSIGN, 0, 0x409]), 0);
    assert.equal(host.registration.productState(PRODUCT), INSTALLSTATE.ADVERTISED);
    const product = put(0x200, PRODUCT);
    assert.equal(fns.MsiUseFeatureA.handler([product, put(0x300, 'Main')]),
        INSTALLSTATE.ADVERTISED);
    assert.equal(await readFile(files, 'C:\\Program Files\\Game\\game.exe'), null,
        'no file put down');
    const link = decodeShellLink(/** @type {Uint8Array} */ (
        await readFile(files, 'C:\\WINDOWS\\Menu\\Play.lnk')));
    assert.deepEqual(decomposeDescriptor(link?.darwinId ?? '')?.product, PRODUCT,
        'the shortcut names the product, its feature and component for the shell');

    view.setUint32(0x40, 260, true);
    assert.equal(await fns.MsiProvideComponentA.handler([product, 0x300, put(0x400, CORE), 0,
        0x1000, 0x40]), 0);
    assert.equal(decodeAnsi(memory.subarray(0x1000, memory.indexOf(0, 0x1000))),
        'C:\\Program Files\\Game\\game.exe');
    assert.notEqual(await readFile(files, 'C:\\Program Files\\Game\\game.exe'), null,
        'installed by its first use');
    assert.equal(host.registration.productState(PRODUCT), INSTALLSTATE.DEFAULT);
});
