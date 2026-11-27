/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * msi.dll's questions about what is installed, asked after a real
 * installation: features and their parents, components and their clients,
 * the registered user, source lists, descriptors, a published component
 * provided, a file's hash.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';
import { EXECUTE_SEQUENCE, machine, run } from './install.fixture.js';
import { createProductFunctions, decomposeDescriptor, unpackGuid } from './products.js';
import { descriptor, packGuid } from './system.js';
import { readFile } from './actions.js';
import { INSTALLSTATE } from './session.js';

const PRODUCT = '{6D7A2B10-1111-4222-8333-944455556666}';
const CORE = '{11111111-1111-1111-1111-111111111111}';
const CATEGORY = '{CCCCCCCC-1234-1234-1234-1234567890AB}';

/** @type {import('./install.fixture.js').Tables} */
const TABLES = {
    Property: [['Property', 'Value'], [['ProductCode', PRODUCT], ['ProductName', 'Game'],
        ['ProductVersion', '1.2.3'], ['Manufacturer', 'Maker'], ['ProductLanguage', '1033'],
        ['USERNAME', 'Player One'], ['COMPANYNAME', 'Guild']]],
    Directory: [['Directory', 'Directory_Parent', 'DefaultDir'], [
        ['TARGETDIR', null, 'SourceDir'], ['ProgramFilesFolder', 'TARGETDIR', '.'],
        ['INSTALLDIR', 'ProgramFilesFolder', 'Game']]],
    Feature: [['Feature', 'Feature_Parent', 'Title', 'Description', 'Display', 'Level',
        'Directory_', 'Attributes'], [
        ['Main', null, 'Main', null, 1, 1, 'INSTALLDIR', 0],
        ['Help', 'Main', 'Help', null, 2, 1, 'INSTALLDIR', 0]]],
    Component: [['Component', 'ComponentId', 'Directory_', 'Attributes', 'Condition',
        'KeyPath'], [['Core', CORE, 'INSTALLDIR', 0, null, 'exe'],
        ['Docs', '{22222222-2222-2222-2222-222222222222}', 'INSTALLDIR', 0, null, 'doc']]],
    FeatureComponents: [['Feature_', 'Component_'], [['Main', 'Core'], ['Help', 'Docs']]],
    File: [['File', 'Component_', 'FileName', 'FileSize', 'Version', 'Language', 'Attributes',
        'Sequence'], [['exe', 'Core', 'game.exe', 3, null, null, 0, 1],
        ['doc', 'Docs', 'help.txt', 4, null, null, 0, 2]]],
    Media: [['DiskId', 'LastSequence', 'DiskPrompt', 'Cabinet', 'VolumeLabel', 'Source'],
        [[1, 2, null, null, null, null]]],
    PublishComponent: [['ComponentId', 'Qualifier', 'Component_', 'AppData', 'Feature_'],
        [[CATEGORY, 'en', 'Core', null, 'Main']]],
    InstallExecuteSequence: [['Action', 'Condition', 'Sequence'], EXECUTE_SEQUENCE],
};

/** An installed product and msi.dll's product calls over a flat memory. */
async function installed(){
    const host = await machine(['C:\\src', 'C:\\src\\Game'],
        { 'C:\\src\\Game\\game.exe': 'abc', 'C:\\src\\Game\\help.txt': 'help' });
    assert.equal((await run(host, TABLES, '')).code, 0);
    const memory = new Uint8Array(0x10000);
    const view = new DataView(memory.buffer);
    /** @type {string[]} */
    const maintained = [];
    const fns = /** @type {Record<string, { handler: (args: number[]) => any }>} */ (
        /** @type {unknown} */ (createProductFunctions({
            registration: host.registration, hive: host.hive, files: host.files,
            fullPath: path=>path,
            reader: ()=>address=>((address >>> 0) === 0 ? null
                : decodeAnsi(memory.subarray(address, memory.indexOf(0, address)))),
            putString: (wide, text, buffer, size)=>{
                const room = view.getUint32(size, true);
                view.setUint32(size, text.length, true);
                if (room <= text.length)
                {
                    return 234;
                }
                memory.set(encodeAnsi(`${text}\0`), buffer);
                return 0;
            },
            putFixed: (wide, text, buffer)=>memory.set(encodeAnsi(`${text}\0`), buffer),
            readU32: address=>view.getUint32(address, true),
            writeU32: (address, value)=>view.setUint32(address, value >>> 0, true),
            writeMemory: (address, bytes)=>memory.set(bytes, address),
            get: ()=>null,
            readFile: path=>readFile(host.files, path),
            statPath: path=>(path === '' ? null : host.files.stat(path)),
            readPath: async path=>(path === '' ? null : readFile(host.files, path)),
            openPackage: async()=>null,
            maintain: async(code, request)=>{
                maintained.push(`${code} ${request}`);
                return 0;
            },
            // The installed package, as far as a descriptor that leaves the
            // component to its feature needs it.
            inspectPatch: async()=>1636,
            openHandle: ()=>1,
            advertise: async()=>0,
            productCodeOf: async()=>null,
            openProduct: async()=>/** @type {any} */ ({
                features: new Map([['Main', { components: ['Core'] }]]),
                components: new Map([['Core', { id: CORE, features: ['Main'] }]]),
                files: new Map(),
            }),
        })));
    /** @param {number} at @param {string} text */
    const put = (at, text)=>{
        memory.set(encodeAnsi(`${text}\0`), at);
        return at;
    };
    /** @param {number} at */
    const string = at=>decodeAnsi(memory.subarray(at, memory.indexOf(0, at)));
    return { host, fns, put, string, view, maintained };
}

test('features with their parents, components with their products', async()=>{
    const { fns, put, string } = await installed();
    const product = put(0x100, PRODUCT);
    assert.equal(fns.MsiEnumFeaturesA.handler([product, 0, 0x200, 0x300]), 0);
    assert.deepEqual([string(0x200), string(0x300)], ['Main', '']);
    assert.equal(fns.MsiEnumFeaturesA.handler([product, 1, 0x200, 0x300]), 0);
    assert.deepEqual([string(0x200), string(0x300)], ['Help', 'Main']);
    assert.equal(fns.MsiEnumFeaturesA.handler([product, 2, 0x200, 0x300]), 259);
    assert.equal(fns.MsiEnumFeaturesA.handler([put(0x400,
        '{00000000-0000-0000-0000-000000000001}'), 0, 0x200, 0]), 1605);
    assert.equal(fns.MsiEnumComponentsA.handler([0, 0x200]), 0);
    assert.equal(string(0x200), CORE);
    assert.equal(fns.MsiEnumComponentsA.handler([2, 0x200]), 259);
    assert.equal(fns.MsiEnumClientsA.handler([put(0x500, CORE), 0, 0x200]), 0);
    assert.equal(string(0x200), PRODUCT);
    assert.equal(fns.MsiGetProductCodeA.handler([put(0x500, CORE), 0x200]), 0);
    assert.equal(string(0x200), PRODUCT);
    assert.equal(fns.MsiUseFeatureA.handler([product, put(0x600, 'Help')]),
        INSTALLSTATE.LOCAL);
    assert.equal(fns.MsiUseFeatureA.handler([product, put(0x600, 'Nope')]),
        INSTALLSTATE.UNKNOWN);
});

test('the registered user, a component\'s state, and the product\'s own records', async()=>{
    const { fns, put, string, view, host } = await installed();
    const product = put(0x100, PRODUCT);
    for (const size of [0x40, 0x44, 0x48])
    {
        view.setUint32(size, 64, true);
    }
    assert.equal(fns.MsiGetUserInfoA.handler([product, 0x200, 0x40, 0x300, 0x44, 0x380, 0x48]),
        1, 'USERINFOSTATE_PRESENT');
    assert.deepEqual([string(0x200), string(0x300)], ['Player One', 'Guild']);
    view.setUint32(0x40, 3, true);
    assert.equal(fns.MsiGetUserInfoA.handler([product, 0x200, 0x40, 0, 0, 0, 0]), -3,
        'USERINFOSTATE_MOREDATA');
    assert.equal(fns.MsiQueryComponentStateA.handler([product, 0, 4, put(0x500, CORE), 0x60]),
        0);
    assert.equal(view.getInt32(0x60, true), INSTALLSTATE.LOCAL);
    view.setUint32(0x80, 20, true);
    assert.equal(await fns.MsiGetFileHashA.handler([put(0x7f0, ''), 0, 0x80]), 3,
        'ERROR_PATH_NOT_FOUND for an empty path (Wine\'s msi test)');
    host.files.remove('C:\\Program Files\\Game\\game.exe');
    fns.MsiQueryComponentStateA.handler([product, 0, 4, 0x500, 0x60]);
    assert.equal(view.getInt32(0x60, true), INSTALLSTATE.ABSENT, 'its key file gone');
    view.setUint32(0x40, 64, true);
    assert.equal(fns.MsiGetProductInfoExA.handler([product, 0, 4, put(0x600, 'State'), 0x200,
        0x40]), 0);
    assert.equal(string(0x200), '5');
    assert.equal(fns.MsiIsProductElevatedA.handler([product, 0x64]), 0);
    assert.equal(view.getUint32(0x64, true), 1);
});

test('a source list is added to, enumerated and cleared', async()=>{
    const { fns, put, string, view } = await installed();
    const product = put(0x100, PRODUCT);
    assert.equal(fns.MsiSourceListAddSourceExA.handler([product, 0, 4, 1, put(0x500,
        'D:\\Setup'), 0]), 0);
    const listed = [];
    for (let index = 0; ; index++)
    {
        view.setUint32(0x40, 128, true);
        if (fns.MsiSourceListEnumSourcesA.handler([product, 0, 4, 1, index, 0x200, 0x40]) !== 0)
        {
            break;
        }
        listed.push(string(0x200));
    }
    assert.deepEqual(listed, ['C:\\src\\', 'D:\\Setup\\'], 'the installation\'s own first');
    view.setUint32(0x40, 128, true);
    assert.equal(fns.MsiSourceListGetInfoA.handler([product, 0, 4, 0, put(0x600, 'PackageName'),
        0x200, 0x40]), 0);
    assert.equal(string(0x200), 'test.msi');
    assert.equal(fns.MsiSourceListClearAllExA.handler([product, 0, 4, 1]), 0);
    assert.equal(fns.MsiSourceListEnumSourcesA.handler([product, 0, 4, 1, 0, 0x200, 0x40]), 259);
});

test('descriptors pack and unpack, and a published component is provided through one',
    async()=>{
        const { fns, put, string, view } = await installed();
        assert.equal(unpackGuid(/** @type {string} */ (packGuid(PRODUCT))), PRODUCT);
        const text = /** @type {string} */ (descriptor(PRODUCT, 'Main', CORE, false));
        assert.deepEqual(decomposeDescriptor(`${text}tail`),
            { product: PRODUCT, feature: 'Main', component: CORE, used: text.length });
        assert.equal(fns.MsiDecomposeDescriptorA.handler([put(0x800, text), 0x200, 0x300, 0x380,
            0x60]), 0);
        assert.deepEqual([string(0x200), string(0x300), string(0x380)], [PRODUCT, 'Main', CORE]);
        view.setUint32(0x40, 128, true);
        assert.equal(await fns.MsiProvideQualifiedComponentA.handler([put(0x500, CATEGORY),
            put(0x600, 'en'), 0, 0x200, 0x40]), 0);
        assert.equal(string(0x200), 'C:\\Program Files\\Game\\game.exe');
        assert.equal(await fns.MsiProvideQualifiedComponentA.handler([0x500, put(0x600, 'fr'),
            0, 0x200, 0x40]), 1611, 'ERROR_INDEX_ABSENT for a qualifier never published');
    });

test('a file\'s MD5 hash, and a missing component repaired by its feature', async()=>{
    const { fns, put, view, maintained, host } = await installed();
    view.setUint32(0x80, 20, true);
    assert.equal(await fns.MsiGetFileHashA.handler([put(0x500,
        'C:\\Program Files\\Game\\game.exe'), 0, 0x80]), 0);
    const hash = [0, 1, 2, 3].map(word=>view.getUint32(0x84 + word * 4, true)
        .toString(16).padStart(8, '0'));
    // MD5("abc") is 900150983cd24fb0d6963f7d28e17f72, read as four little-endian words.
    assert.deepEqual(hash, ['98500190', 'b04fd23c', '7d3f96d6', '727fe128']);
    host.files.remove('C:\\Program Files\\Game\\game.exe');
    view.setUint32(0x40, 128, true);
    await fns.MsiProvideComponentA.handler([put(0x100, PRODUCT), put(0x600, 'Main'),
        put(0x500, CORE), 0, 0x200, 0x40]);
    assert.deepEqual(maintained, [`${PRODUCT} REINSTALL="Main" REINSTALLMODE=omus`]);
});

test('the Windows Installer 4.5 and 5.0 forms: per-context enumerations, paths, transactions',
    async()=>{
        const { fns, put, string, view } = await installed();
        const MACHINE_CONTEXT = 4;
        view.setUint32(0x40, 64, true);
        assert.equal(fns.MsiEnumComponentsExA.handler([0, MACHINE_CONTEXT, 0, 0x200, 0x60,
            0x300, 0x40]), 0);
        assert.equal(string(0x200), CORE);
        assert.equal(view.getUint32(0x60, true), MACHINE_CONTEXT);
        assert.equal(fns.MsiEnumComponentsExA.handler([0, 1, 0, 0x200, 0, 0, 0]), 259,
            'nothing installed per user');
        view.setUint32(0x40, 64, true);
        assert.equal(fns.MsiEnumClientsExA.handler([put(0x500, CORE), 0, MACHINE_CONTEXT, 0,
            0x200, 0, 0x300, 0x40]), 0);
        assert.equal(string(0x200), PRODUCT);
        view.setUint32(0x40, 128, true);
        assert.equal(fns.MsiGetComponentPathExA.handler([put(0x100, PRODUCT), 0x500, 0,
            MACHINE_CONTEXT, 0x200, 0x40]), INSTALLSTATE.LOCAL);
        assert.equal(string(0x200), 'C:\\Program Files\\Game\\game.exe');
        assert.equal(fns.MsiBeginTransactionA.handler([put(0x600, 'batch'), 0, 0x64, 0x68]), 0);
        assert.equal(fns.MsiEndTransaction.handler([1]), 0, 'committed');
    });
