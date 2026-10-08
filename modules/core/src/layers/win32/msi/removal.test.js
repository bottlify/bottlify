/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A product's life after its installation: a removal takes back what each
 * component put down and leaves the machine with no record of the product,
 * a feature can go on its own, and a repair puts a lost file back. Each run
 * is a session of its own over the same package, as MsiConfigureProduct
 * makes one, starting from what the machine recorded.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filesystemModule } from '../../filesystem/module.js';
import { createVolume } from '../kernel32/vfs.js';
import { HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, createHive } from '../advapi32/registry.js';
import { windowsVersion } from '../kernel32/versions.js';
import { createEmptyDatabase } from './database.js';
import { INSTALLSTATE, createSession } from './session.js';
import { runSequence } from './actions.js';
import { createRegistration, valueText } from './registration.js';
import { editIni, INI_ACTION } from './ini.js';
import { environmentRow, installedValue, removedValue } from './environment.js';

const PRODUCT = '{6D7A2B10-1111-4222-8333-944455556666}';

/** @type {import('./session.js').Machine} */
const MACHINE = {
    windows: windowsVersion(), computerName: 'PC', userName: 'User', userSid: 'S-1-5-21-1',
    language: 0x409, screenWidth: 1024, screenHeight: 768, colorBits: 32,
    memoryMegabytes: 512, tempFolder: 'C:\\WINDOWS\\TEMP\\', environment: ()=>null,
    now: ()=>new Date(2026, 0, 1),
};

/** @type {Record<string, [string[], (string | number | null)[][]]>} */
const TABLES = {
    Property: [['Property', 'Value'], [
        ['ProductCode', PRODUCT], ['ProductName', 'Test'], ['ProductVersion', '1.0.0'],
        ['Manufacturer', 'Maker'], ['ProductLanguage', '1033'],
    ]],
    Directory: [['Directory', 'Directory_Parent', 'DefaultDir'], [
        ['TARGETDIR', null, 'SourceDir'],
        ['ProgramFilesFolder', 'TARGETDIR', '.'],
        ['INSTALLDIR', 'ProgramFilesFolder', 'Test'],
        ['DATADIR', 'INSTALLDIR', 'Data'],
    ]],
    Feature: [['Feature', 'Feature_Parent', 'Title', 'Description', 'Display', 'Level',
        'Directory_', 'Attributes'], [
        ['Main', null, 'Main', null, 1, 1, 'INSTALLDIR', 0],
        ['Extras', null, 'Extras', null, 2, 1, 'INSTALLDIR', 0],
    ]],
    Component: [['Component', 'ComponentId', 'Directory_', 'Attributes', 'Condition',
        'KeyPath'], [
        ['Core', '{11111111-1111-1111-1111-111111111111}', 'INSTALLDIR', 0, null, 'one'],
        ['Data', '{22222222-2222-2222-2222-222222222222}', 'DATADIR', 0, null, 'two'],
    ]],
    FeatureComponents: [['Feature_', 'Component_'], [['Main', 'Core'], ['Extras', 'Data']]],
    File: [['File', 'Component_', 'FileName', 'FileSize', 'Version', 'Language', 'Attributes',
        'Sequence'], [
        ['one', 'Core', 'one.txt', 5, null, null, 0, 1],
        ['two', 'Data', 'two.dat', 3, null, null, 0, 2],
    ]],
    Media: [['DiskId', 'LastSequence', 'DiskPrompt', 'Cabinet', 'VolumeLabel', 'Source'],
        [[1, 2, null, null, null, null]]],
    Registry: [['Registry', 'Root', 'Key', 'Name', 'Value', 'Component_'], [
        ['path', 2, 'Software\\Test', 'Path', '[INSTALLDIR]', 'Core'],
        ['data', 2, 'Software\\Test\\Data', 'Level', '#3', 'Data'],
        ['tree', 2, 'Software\\Test\\Tree', '*', null, 'Data'],
    ]],
    IniFile: [['IniFile', 'FileName', 'DirProperty', 'Section', 'Key', 'Value', 'Action',
        'Component_'], [
        ['ini1', 'test.ini', 'INSTALLDIR', 'Main', 'Path', '[INSTALLDIR]', 0, 'Core'],
        ['ini2', 'test.ini', 'INSTALLDIR', 'Main', 'Plugins', 'data', 3, 'Data'],
    ]],
    Environment: [['Environment', 'Name', 'Value', 'Component_'], [
        ['home', 'TEST_HOME', '[INSTALLDIR]', 'Core'],
        ['path', '=-*PATH', '[~];[INSTALLDIR]bin', 'Core'],
    ]],
    CreateFolder: [['Directory_', 'Component_'], [['DATADIR', 'Data']]],
    RemoveFile: [['FileKey', 'Component_', 'FileName', 'DirProperty', 'InstallMode'], [
        ['logs', 'Core', '*.log', 'INSTALLDIR', 2],
    ]],
    InstallExecuteSequence: [['Action', 'Condition', 'Sequence'], [
        ['CostInitialize', null, 800], ['FileCost', null, 900], ['CostFinalize', null, 1000],
        ['InstallValidate', null, 1400], ['InstallInitialize', null, 1500],
        ['ProcessComponents', null, 1600], ['UnpublishFeatures', null, 1800],
        ['RemoveRegistryValues', null, 2600], ['RemoveIniValues', null, 3100],
        ['RemoveEnvironmentStrings', null, 3300], ['RemoveFiles', null, 3500],
        ['RemoveFolders', null, 3600], ['CreateFolders', null, 3700],
        ['InstallFiles', null, 4000], ['WriteRegistryValues', null, 5000],
        ['WriteIniValues', null, 5100], ['WriteEnvironmentStrings', null, 5200],
        ['RegisterProduct', 'NOT REMOVE~="ALL"', 6100],
        ['PublishFeatures', 'NOT REMOVE~="ALL"', 6300], ['InstallFinalize', null, 6600],
    ]],
};

/** The package's database, columns in their schema's order. */
function packageDatabase(){
    const db = createEmptyDatabase();
    for (const [name, [columns, rows]] of Object.entries(TABLES))
    {
        db.tables.set(name, {
            name, rows, temporary: false, temporaryRows: new Set(), hold: 0,
            columns: columns.map((column, index)=>({ table: name, number: index + 1,
                name: column, type: 0 })),
        });
    }
    return db;
}

/** A machine with the package's files beside it under C:\src. */
async function machine(){
    const files = /** @type {any} */ (createVolume(await filesystemModule.create({})));
    for (const path of ['C:\\src', 'C:\\src\\Test', 'C:\\src\\Test\\Data', 'C:\\Program Files'])
    {
        files.mkdir(path);
    }
    for (const [name, text] of [['Test\\one.txt', 'first'], ['Test\\Data\\two.dat', 'two']])
    {
        const node = files.open(`C:\\src\\${name}`, { write: true, create: true });
        files.write(node, 0, new TextEncoder().encode(text));
        files.close(node);
    }
    const hive = createHive();
    return { files, hive, registration: createRegistration(hive) };
}

/**
 * Runs the execute sequence as one installation would, with what the machine
 * recorded of the product so far.
 *
 * @param {Awaited<ReturnType<typeof machine>>} host @param {string} commandLine
 */
async function run(host, commandLine){
    const { registration } = host;
    const session = createSession({
        db: packageDatabase(), packagePath: 'C:\\src\\test.msi', machine: MACHINE, commandLine,
        isInstalled: code=>registration.productState(code) === INSTALLSTATE.DEFAULT,
        installed: {
            feature: registration.featureInstalled,
            component: (product, id)=>registration.componentPath(product, id) !== null,
        },
    });
    session.setProperty('ProgramFilesFolder', 'C:\\Program Files\\');
    const engine = /** @type {any} */ ({
        session, thread: null, ran: new Set(), commit: [], async: [], executing: true,
        host: { ...host, message: ()=>0, log: ()=>{}, callDll: async()=>0 },
    });
    const code = await runSequence(engine, 'InstallExecuteSequence');
    return { code, session };
}

/** @param {any} files @param {string} path */
const text = async(files, path)=>{
    const stat = files.stat(path);
    if (!stat || stat.exists === false || stat.isDirectory)
    {
        return null;
    }
    const node = files.open(path, { read: true });
    const bytes = await files.read(node, 0, stat.size);
    files.close(node);
    return new TextDecoder('latin1').decode(bytes);
};

/** @param {any} hive @param {number} root @param {string} path @param {string} name */
const registryText = (hive, root, path, name)=>{
    const key = hive.open(hive.root(root), path);
    return key ? valueText(hive.getValue(key, name)) : null;
};

const MACHINE_ENVIRONMENT = 'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';

test('a removal takes back everything the installation put down, and the product with it',
    async()=>{
        const host = await machine();
        const { files, registration } = host;
        const hive = /** @type {any} */ (host.hive);
        const pathKey = hive.create(hive.root(HKEY_LOCAL_MACHINE), MACHINE_ENVIRONMENT).key;
        hive.setValue(pathKey, 'PATH', 2, new TextEncoder().encode('C:\\WINDOWS\0'));
        assert.equal((await run(host, '')).code, 0);
        assert.equal(await text(files, 'C:\\Program Files\\Test\\one.txt'), 'first');
        assert.equal(await text(files, 'C:\\Program Files\\Test\\Data\\two.dat'), 'two');
        assert.equal(registryText(hive, HKEY_LOCAL_MACHINE, 'Software\\Test', 'Path'),
            'C:\\Program Files\\Test\\');
        assert.ok(hive.open(hive.root(HKEY_LOCAL_MACHINE), 'Software\\Test\\Tree'));
        assert.equal(await text(files, 'C:\\Program Files\\Test\\test.ini'),
            '[Main]\r\nPath=C:\\Program Files\\Test\\\r\nPlugins=data\r\n');
        assert.equal(registryText(hive, HKEY_CURRENT_USER, 'Environment', 'TEST_HOME'),
            'C:\\Program Files\\Test\\');
        assert.equal(registryText(hive, HKEY_LOCAL_MACHINE, MACHINE_ENVIRONMENT, 'PATH'),
            'C:\\WINDOWS;C:\\Program Files\\Test\\bin');
        assert.equal(registration.productState(PRODUCT), INSTALLSTATE.DEFAULT);
        // Something the program wrote itself, which RemoveFile names.
        const node = files.open('C:\\Program Files\\Test\\run.log', { write: true, create: true });
        files.close(node);

        const { code, session } = await run(host, 'REMOVE=ALL');
        assert.equal(code, 0);
        assert.equal(session.getProperty('Installed'), '1', 'a maintenance session');
        for (const path of ['C:\\Program Files\\Test\\one.txt', 'C:\\Program Files\\Test\\run.log',
            'C:\\Program Files\\Test\\test.ini', 'C:\\Program Files\\Test\\Data\\two.dat'])
        {
            assert.equal(await text(files, path), null, path);
        }
        assert.equal(files.stat('C:\\Program Files\\Test')?.isDirectory ?? false, false,
            'the folders it made, once empty');
        assert.equal(files.stat('C:\\Program Files')?.isDirectory, true, 'but not the machine\'s');
        assert.equal(hive.open(hive.root(HKEY_LOCAL_MACHINE), 'Software\\Test'), null,
            'the values, the keys left empty and the key named whole');
        assert.equal(registryText(hive, HKEY_CURRENT_USER, 'Environment', 'TEST_HOME'), null);
        assert.equal(registryText(hive, HKEY_LOCAL_MACHINE, MACHINE_ENVIRONMENT, 'PATH'),
            'C:\\WINDOWS', 'only its own part of a list');
        assert.equal(registration.productState(PRODUCT), INSTALLSTATE.UNKNOWN);
        assert.deepEqual(registration.products(), []);
        assert.equal(registration.componentPath(PRODUCT,
            '{11111111-1111-1111-1111-111111111111}'), null);
    });

test('a feature removed on its own takes its components and leaves the rest', async()=>{
    const host = await machine();
    const { files, registration } = host;
    const hive = /** @type {any} */ (host.hive);
    await run(host, '');
    const { code } = await run(host, 'REMOVE=Extras');
    assert.equal(code, 0);
    assert.equal(await text(files, 'C:\\Program Files\\Test\\Data\\two.dat'), null);
    assert.equal(await text(files, 'C:\\Program Files\\Test\\one.txt'), 'first');
    assert.equal(await text(files, 'C:\\Program Files\\Test\\test.ini'),
        '[Main]\r\nPath=C:\\Program Files\\Test\\\r\n', 'the tag it added, not the line');
    assert.equal(registryText(hive, HKEY_LOCAL_MACHINE, 'Software\\Test', 'Path'),
        'C:\\Program Files\\Test\\');
    assert.equal(hive.open(hive.root(HKEY_LOCAL_MACHINE), 'Software\\Test\\Data'), null);
    assert.equal(registration.productState(PRODUCT), INSTALLSTATE.DEFAULT, 'still installed');
    assert.equal(registration.featureInstalled(PRODUCT, 'Main'), true);
    assert.equal(registration.featureInstalled(PRODUCT, 'Extras'), false);
});

test('a repair puts back a file that went missing, and a removal of nothing changes nothing',
    async()=>{
        const host = await machine();
        const { files } = host;
        await run(host, '');
        files.remove('C:\\Program Files\\Test\\one.txt');
        assert.equal((await run(host, 'REINSTALL=ALL REINSTALLMODE=omus')).code, 0);
        assert.equal(await text(files, 'C:\\Program Files\\Test\\one.txt'), 'first');
        const { session } = await run(host, 'REMOVE=Nothing');
        assert.equal(session.features.get('Main')?.action, INSTALLSTATE.UNKNOWN);
        assert.equal(await text(files, 'C:\\Program Files\\Test\\one.txt'), 'first');
    });

test('INI actions: a line set or made only where missing, a tag added and taken out', ()=>{
    const start = '[Main]\r\nA=1\r\n';
    assert.equal(editIni(start, 'main', 'a', '2', INI_ACTION.ADD_LINE), '[Main]\r\na=2\r\n');
    assert.equal(editIni(start, 'Main', 'A', '2', INI_ACTION.CREATE_LINE), start);
    assert.equal(editIni(start, 'Other', 'B', '3', INI_ACTION.CREATE_LINE),
        '[Main]\r\nA=1\r\n[Other]\r\nB=3\r\n');
    assert.equal(editIni(start, 'Main', 'A', 'x', INI_ACTION.ADD_TAG), '[Main]\r\nA=1,x\r\n');
    assert.equal(editIni('[Main]\r\nA=1,x\r\n', 'Main', 'A', 'X', INI_ACTION.REMOVE_TAG), start);
    assert.equal(editIni(start, 'Main', 'A', '1', INI_ACTION.REMOVE_TAG), '');
    assert.equal(editIni(`${start}B=2\r\n`, 'Main', 'A', '', INI_ACTION.REMOVE_LINE),
        '[Main]\r\nB=2\r\n');
    assert.equal(editIni(`${start}[Next]\r\nC=3\r\n`, 'Main', 'A', '', INI_ACTION.REMOVE_LINE),
        '[Next]\r\nC=3\r\n', 'a section left empty goes with its last key');
});

test('environment rows: prefixes and list parts, installed and removed', ()=>{
    const plain = environmentRow('VAR', 'value');
    assert.deepEqual([plain.onInstall, plain.removeOnUninstall, plain.machine],
        ['set', true, false]);
    assert.equal(installedValue(plain, 'old'), 'value');
    assert.equal(removedValue(plain, 'value'), null);
    const create = environmentRow('+VAR', 'value');
    assert.equal(installedValue(create, 'old'), undefined, '+ leaves one that is there');
    assert.equal(removedValue(create, 'value'), undefined, 'and leaves it on removal');
    const gone = environmentRow('!VAR', '');
    assert.equal(installedValue(gone, 'anything'), null);
    const append = environmentRow('=-*PATH', '[~];C:\\bin');
    assert.equal(append.machine, true);
    assert.equal(installedValue(append, 'C:\\a'), 'C:\\a;C:\\bin');
    assert.equal(installedValue(append, 'C:\\a;c:\\BIN'), undefined, 'already in the list');
    assert.equal(removedValue(append, 'C:\\a;C:\\bin;C:\\b'), 'C:\\a;C:\\b');
    const prepend = environmentRow('VAR', 'C:\\first;[~]');
    assert.equal(installedValue(prepend, 'C:\\a'), 'C:\\first;C:\\a');
});
