/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A patch through msi.dll: a .msp made the way a patch tool makes one -- a
 * transform pair and a cabinet inside it -- applied to the installed
 * product, listed, and removed again.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMsiFunctions } from './functions.js';
import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';
import { databaseBytes } from './database-writer.js';
import { EXECUTE_SEQUENCE, MACHINE, machine, packageDatabase, typed } from './install.fixture.js';
import { readFile } from './actions.js';
import { generateTransform, writeSummaryStream } from './transform.js';
import { openCompound, bytesSource } from './compound.js';
import { compoundBytes, storageOf, streamOf } from '../common/compound-writer.js';
import { encodeStreamName } from './database.js';
import { buildCabinet } from '../cabinet/cabinet.fixture.js';
import { PID } from './summary.js';
import { VT } from './summary.js';

const PRODUCT = '{6D7A2B10-1111-4222-8333-944455556666}';
const PATCH = '{9A9A9A9A-1111-4222-8333-944455556666}';
const CLSID_PATCH = '{000C1086-0000-0000-C000-000000000046}';

/** @param {string} version @param {number} size @param {number} sequence */
const tables = (version, size, sequence)=>/** @type {import('./install.fixture.js').Tables} */ ({
    Property: [['Property', 'Value'], [['ProductCode', PRODUCT], ['ProductName', 'Game'],
        ['ProductVersion', version], ['Manufacturer', 'Maker'], ['ProductLanguage', '1033'],
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
        // The patched file is compressed into the patch's cabinet, as a patch
        // tool marks it.
        'Sequence'], [['exe', 'Core', 'game.exe', size, null, null, sequence === 1 ? 0 : 0x4000,
        sequence]]],
    Media: [['DiskId', 'LastSequence', 'DiskPrompt', 'Cabinet', 'VolumeLabel', 'Source'],
        sequence === 1 ? [[1, 1, null, null, null, null]]
            : [[1, 1, null, null, null, null], [2, 2, null, '#PATCH_CAB', null, null]]],
    InstallExecuteSequence: [['Action', 'Condition', 'Sequence'], EXECUTE_SEQUENCE],
});

/** A transform's bytes as the storage a patch carries it in. @param {string} name @param {Uint8Array} bytes */
async function asStorage(name, bytes){
    const file = await openCompound(bytesSource(bytes));
    const children = [];
    for (const node of file.root.children.values())
    {
        children.push(streamOf(node.name, await file.readAll(node)));
    }
    return storageOf(name, children, file.root.clsid ?? undefined);
}

/** The .msp: the product transform, its "#" companion, and the cabinet with the new file. */
async function makePatch(){
    const base = typed(packageDatabase(tables('1.0', 4, 1)));
    const patched = typed(packageDatabase(tables('1.1', 6, 2)));
    const product = await generateTransform(patched, base);
    assert.equal(product.code, 0);
    const companionTables = { ...tables('1.1', 6, 2),
        PatchPackage: [['PatchId', 'Media_'], [[PATCH, 2]]] };
    const companion = await generateTransform(typed(packageDatabase(
        /** @type {any} */ (companionTables))), typed(packageDatabase(tables('1.1', 6, 2))));
    assert.equal(companion.code, 0);
    const content = encodeAnsi('MZ.v11');
    const cabinet = buildCabinet({ folders: [{ compression: 0,
        blocks: [{ packed: content, size: content.length }] }],
    files: [{ name: 'exe', size: content.length, offset: 0, folder: 0 }] });
    const summary = new Map([
        [PID.TEMPLATE, { type: VT.LPSTR, value: PRODUCT }],
        [PID.LASTAUTHOR, { type: VT.LPSTR, value: ':T1;:#T1' }],
        [PID.REVNUMBER, { type: VT.LPSTR, value: PATCH }],
    ]);
    return compoundBytes(storageOf('Root Entry', [
        streamOf('\u0005SummaryInformation', writeSummaryStream(/** @type {any} */ (summary))),
        await asStorage('T1', /** @type {Uint8Array} */ (product.bytes)),
        await asStorage('#T1', /** @type {Uint8Array} */ (companion.bytes)),
        streamOf(/** @type {string} */ (encodeStreamName('PATCH_CAB', false)), cabinet),
    ], CLSID_PATCH));
}

test('a patch is applied to the installed product, listed, and removed again', async()=>{
    const host = await machine(['C:\\src', 'C:\\src\\Game'],
        { 'C:\\src\\Game\\game.exe': 'MZ..' });
    const { files } = host;
    /** @param {string} path @param {Uint8Array} bytes */
    const write = (path, bytes)=>{
        const node = files.open(path, { write: true, create: true });
        files.write(node, 0, bytes);
        files.close(node);
    };
    write('C:\\src\\game.msi', await databaseBytes(typed(packageDatabase(tables('1.0', 4, 1)))));
    write('C:\\src\\fix.msp', await makePatch());

    const memory = new Uint8Array(0x40000);
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
    const text = async()=>{
        const bytes = await readFile(files, 'C:\\Program Files\\Game\\game.exe');
        return bytes ? decodeAnsi(bytes) : null;
    };
    assert.equal(await fns.MsiInstallProductA.handler([put(0x100, 'C:\\src\\game.msi'),
        put(0x200, '')]), 0);
    assert.equal(await text(), 'MZ..');

    assert.equal(await fns.MsiApplyPatchA.handler([put(0x300, 'C:\\src\\fix.msp'), 0, 0,
        put(0x400, '')]), 0);
    assert.equal(await text(), 'MZ.v11', 'the file the patch delivers, from its own cabinet');
    const product = put(0x500, PRODUCT);
    new DataView(memory.buffer).setUint32(0x40, 128, true);
    assert.equal(fns.MsiEnumPatchesA.handler([product, 0, 0x600, 0x700, 0x40]), 0);
    assert.equal(decodeAnsi(memory.subarray(0x700, memory.indexOf(0, 0x700))), ':T1;:#T1',
        'with the transforms it applied');
    assert.equal(decodeAnsi(memory.subarray(0x600, 0x600 + 38)), PATCH);
    const info = host.registration.patches(PRODUCT)[0];
    assert.match(info.localPackage, /^C:\\WINDOWS\\Installer\\[0-9a-f]+\.msp$/,
        'the machine keeps its own copy');

    const INSTALLTYPE_SINGLE_INSTANCE = 2;
    assert.equal(await fns.MsiRemovePatchesA.handler([put(0x800, PATCH), product,
        INSTALLTYPE_SINGLE_INSTANCE,
        put(0x900, '')]), 0);
    assert.equal(await text(), 'MZ..', 'the shipped file back');
    assert.deepEqual(host.registration.patches(PRODUCT), []);
    assert.equal(files.stat(info.localPackage), null);
    assert.equal(await fns.MsiApplyPatchA.handler([put(0x300, 'C:\\src\\game.msi'), 0, 0, 0]),
        1636, 'a package that is not a patch');
});
