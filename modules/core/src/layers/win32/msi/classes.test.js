/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * COM and shell registration from the package's tables: a class with its
 * server, ProgIDs and AppID, an extension with its verbs and MIME type, a
 * type library through oleaut32 -- written when the component installs,
 * taken out when it is removed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HKEY_CLASSES_ROOT } from '../advapi32/registry.js';
import { EXECUTE_SEQUENCE, machine, registryText, run } from './install.fixture.js';

const PRODUCT = '{6D7A2B10-1111-4222-8333-944455556666}';
const CLSID = '{12345678-1234-1234-1234-1234567890AB}';
const APPID = '{AAAAAAAA-1234-1234-1234-1234567890AB}';
const LIBID = '{BBBBBBBB-1234-1234-1234-1234567890AB}';

/** @type {import('./install.fixture.js').Tables} */
const TABLES = {
    Property: [['Property', 'Value'], [['ProductCode', PRODUCT], ['ProductName', 'Viewer'],
        ['ProductVersion', '1.0'], ['Manufacturer', 'Maker'], ['ProductLanguage', '1033']]],
    Directory: [['Directory', 'Directory_Parent', 'DefaultDir'], [
        ['TARGETDIR', null, 'SourceDir'], ['ProgramFilesFolder', 'TARGETDIR', '.'],
        ['INSTALLDIR', 'ProgramFilesFolder', 'Viewer']]],
    Feature: [['Feature', 'Feature_Parent', 'Title', 'Description', 'Display', 'Level',
        'Directory_', 'Attributes'], [['Main', null, 'Main', null, 1, 1, 'INSTALLDIR', 0]]],
    Component: [['Component', 'ComponentId', 'Directory_', 'Attributes', 'Condition',
        'KeyPath'], [
        ['Server', '{11111111-1111-1111-1111-111111111111}', 'INSTALLDIR', 0, null, 'dll'],
        ['App', '{22222222-2222-2222-2222-222222222222}', 'INSTALLDIR', 0, null, 'exe'],
    ]],
    FeatureComponents: [['Feature_', 'Component_'], [['Main', 'Server'], ['Main', 'App']]],
    File: [['File', 'Component_', 'FileName', 'FileSize', 'Version', 'Language', 'Attributes',
        'Sequence'], [
        ['dll', 'Server', 'viewer.dll', 4, null, null, 0, 1],
        ['exe', 'App', 'viewer.exe', 4, null, null, 0, 2],
    ]],
    Media: [['DiskId', 'LastSequence', 'DiskPrompt', 'Cabinet', 'VolumeLabel', 'Source'],
        [[1, 2, null, null, null, null]]],
    Class: [['CLSID', 'Context', 'Component_', 'ProgId_Default', 'Description', 'AppId_',
        'FileTypeMask', 'Icon_', 'IconIndex', 'DefInprocHandler', 'Argument', 'Feature_',
        'Attributes'], [
        [CLSID, 'InprocServer32', 'Server', 'Viewer.Document.1', 'Viewer Document', APPID,
            '0,2,FFFF,4D5A', 'doc.ico', 1, '2', null, 'Main', 0],
    ]],
    AppId: [['AppId', 'RemoteServerName', 'LocalService', 'ServiceParameters', 'DllSurrogate',
        'ActivateAtStorage', 'RunAsInteractiveUser'], [[APPID, null, null, null, '', 0, 1]]],
    ProgId: [['ProgId', 'ProgId_Parent', 'Class_', 'Description', 'Icon_', 'IconIndex'], [
        ['Viewer.Document.1', null, CLSID, 'Viewer Document', null, null],
        ['Viewer.Document', 'Viewer.Document.1', null, 'Viewer Document', null, null],
    ]],
    Extension: [['Extension', 'Component_', 'ProgId_', 'MIME_', 'Feature_'], [
        ['vwr', 'App', 'Viewer.Document.1', 'application/x-viewer', 'Main'],
    ]],
    Verb: [['Extension_', 'Verb', 'Sequence', 'Command', 'Argument'], [
        ['vwr', 'print', 2, '&Print', '/p "%1"'],
        ['vwr', 'open', 1, '&Open', '"%1"'],
    ]],
    MIME: [['ContentType', 'Extension_', 'CLSID'], [['application/x-viewer', 'vwr', CLSID]]],
    TypeLib: [['LibID', 'Language', 'Component_', 'Version', 'Description', 'Directory_',
        'Feature_', 'Cost'], [[LIBID, 0, 'Server', 0x102, 'Viewer Types', 'INSTALLDIR', 'Main',
        0]]],
    InstallExecuteSequence: [['Action', 'Condition', 'Sequence'], EXECUTE_SEQUENCE],
};

/** A machine with the package's files beside it. */
const viewerMachine = ()=>machine(['C:\\src', 'C:\\src\\Viewer'],
    { 'C:\\src\\Viewer\\viewer.dll': 'MZ..', 'C:\\src\\Viewer\\viewer.exe': 'MZ..' });

test('a class, its ProgIDs, AppID, extension, verbs and MIME type go where COM and the shell'
    + ' look', async()=>{
    const host = await viewerMachine();
    /** @type {[string, string | null][]} */
    const typeLibs = [];
    const { code } = await run(host, TABLES, '', {
        registerTypeLib: async(/** @type {string} */ path, /** @type {string | null} */ help)=>{
            typeLibs.push([path, help]);
            return 0;
        },
    });
    assert.equal(code, 0);
    /** @param {string} path @param {string} [name] */
    const at = (path, name = '')=>registryText(host.hive, HKEY_CLASSES_ROOT, path, name);
    assert.equal(at(`CLSID\\${CLSID}`), 'Viewer Document');
    assert.equal(at(`CLSID\\${CLSID}\\InprocServer32`), 'C:\\Program Files\\Viewer\\viewer.dll');
    assert.equal(at(`CLSID\\${CLSID}\\ProgID`), 'Viewer.Document.1');
    assert.equal(at(`CLSID\\${CLSID}\\VersionIndependentProgID`), 'Viewer.Document');
    assert.equal(at(`CLSID\\${CLSID}`, 'AppID'), APPID);
    assert.equal(at(`CLSID\\${CLSID}\\InprocHandler32`), 'ole32.dll');
    assert.equal(at(`CLSID\\${CLSID}\\DefaultIcon`),
        `C:\\WINDOWS\\Installer\\${PRODUCT}\\doc.ico,1`);
    assert.equal(at(`FileType\\${CLSID}\\0`), '0,2,FFFF,4D5A');
    assert.equal(at(`AppID\\${APPID}`, 'RunAs'), 'Interactive User');
    assert.equal(at(`AppID\\${APPID}`, 'DllSurrogate'), '');
    assert.equal(at('Viewer.Document.1\\CLSID'), CLSID);
    assert.equal(at('Viewer.Document\\CurVer'), 'Viewer.Document.1');
    assert.equal(at('Viewer.Document\\CLSID'), CLSID, 'its version\'s class');
    assert.equal(at('.vwr'), 'Viewer.Document.1');
    assert.equal(at('.vwr', 'Content Type'), 'application/x-viewer');
    assert.equal(at('Viewer.Document.1\\shell'), 'open', 'the first verb by Sequence');
    assert.equal(at('Viewer.Document.1\\shell\\open'), '&Open');
    assert.equal(at('Viewer.Document.1\\shell\\print\\command'),
        '"C:\\Program Files\\Viewer\\viewer.exe" /p "%1"');
    assert.equal(at('MIME\\Database\\Content Type\\application/x-viewer', 'Extension'), '.vwr');
    assert.deepEqual(typeLibs, [['C:\\Program Files\\Viewer\\viewer.dll',
        'C:\\Program Files\\Viewer\\']]);

    /** @type {[string, number, number, number][]} */
    const unregistered = [];
    /** @type {(id: string, major: number, minor: number, language: number) => Promise<number>} */
    const unregisterTypeLib = async(id, major, minor, language)=>{
        unregistered.push([id, major, minor, language]);
        return 0;
    };
    const removal = await run(host, TABLES, 'REMOVE=ALL', { unregisterTypeLib });
    assert.equal(removal.code, 0);
    for (const path of [`CLSID\\${CLSID}`, `AppID\\${APPID}`, 'Viewer.Document.1',
        'Viewer.Document', '.vwr', `FileType\\${CLSID}`,
        'MIME\\Database\\Content Type\\application/x-viewer'])
    {
        assert.equal(host.hive.open(host.hive.root(HKEY_CLASSES_ROOT), path), null, path);
    }
    assert.deepEqual(unregistered, [[LIBID, 1, 2, 0]]);
});
