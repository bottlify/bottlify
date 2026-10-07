/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * An installation as its interface hears it: the execute sequence of a small
 * package -- two files, a registry value, two components -- run through the
 * engine, and the messages a setup's own progress page is drawn from.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filesystemModule } from '../../filesystem/module.js';
import { createVolume } from '../kernel32/vfs.js';
import { createHive } from '../advapi32/registry.js';
import { windowsVersion } from '../kernel32/versions.js';
import { createEmptyDatabase } from './database.js';
import { createSession } from './session.js';
import { INSTALLMESSAGE, runSequence } from './actions.js';

/** @type {import('./session.js').Machine} */
const MACHINE = {
    windows: windowsVersion(), computerName: 'PC', userName: 'User', userSid: 'S-1-5-21-1',
    language: 0x409, screenWidth: 1024, screenHeight: 768, colorBits: 32,
    memoryMegabytes: 512, tempFolder: 'C:\\WINDOWS\\TEMP\\', environment: ()=>null,
    now: ()=>new Date(2026, 0, 1),
};

/** The package's tables, columns in their schema's order. */
const TABLES = {
    Directory: [['Directory', 'Directory_Parent', 'DefaultDir'], [
        ['TARGETDIR', null, 'SourceDir'],
        ['INSTALLDIR', 'TARGETDIR', 'App'],
    ]],
    Feature: [['Feature', 'Feature_Parent', 'Title', 'Description', 'Display', 'Level',
        'Directory_', 'Attributes'], [['Main', null, 'Main', null, 1, 1, 'INSTALLDIR', 0]]],
    Component: [['Component', 'ComponentId', 'Directory_', 'Attributes', 'Condition',
        'KeyPath'], [
        ['Core', '{11111111-1111-1111-1111-111111111111}', 'INSTALLDIR', 0, null, 'one'],
        ['Extra', '{22222222-2222-2222-2222-222222222222}', 'INSTALLDIR', 0, null, null],
    ]],
    FeatureComponents: [['Feature_', 'Component_'], [['Main', 'Core'], ['Main', 'Extra']]],
    File: [['File', 'Component_', 'FileName', 'FileSize', 'Version', 'Language', 'Attributes',
        'Sequence'], [
        ['one', 'Core', 'one.txt', 5, null, null, 0, 1],
        ['two', 'Core', 'TWO~1.TXT|two.txt', 3, null, null, 0, 2],
    ]],
    Media: [['DiskId', 'LastSequence', 'DiskPrompt', 'Cabinet', 'VolumeLabel', 'Source'],
        [[1, 2, null, null, null, null]]],
    Registry: [['Registry', 'Root', 'Key', 'Name', 'Value', 'Component_'],
        [['path', 2, 'Software\\Test', 'Path', '[INSTALLDIR]', 'Core']]],
    ActionText: [['Action', 'Description', 'Template'], [
        ['InstallFiles', 'Copying new files', 'File: [1],  Directory: [9],  Size: [6]'],
        ['WriteRegistryValues', 'Writing system registry values',
            'Key: [1], Name: [2], Value: [3]'],
    ]],
    InstallExecuteSequence: [['Action', 'Condition', 'Sequence'], [
        ['CostInitialize', null, 800], ['FileCost', null, 900], ['CostFinalize', null, 1000],
        ['InstallValidate', null, 1400], ['InstallInitialize', null, 1500],
        ['ProcessComponents', null, 1600], ['InstallFiles', null, 4000],
        ['WriteRegistryValues', null, 5000], ['InstallFinalize', null, 6600],
    ]],
};

/** The package, its files beside it under C:\src, installed with everything heard. */
async function install(){
    const db = createEmptyDatabase();
    for (const [name, [columns, rows]] of Object.entries(TABLES))
    {
        db.tables.set(name, {
            name, rows: /** @type {any[][]} */ (rows), temporary: false,
            temporaryRows: new Set(), hold: 0,
            columns: columns.map((column, index)=>({ table: name, number: index + 1,
                name: column, type: 0 })),
        });
    }
    const files = /** @type {any} */ (createVolume(await filesystemModule.create({})));
    files.mkdir('C:\\src');
    files.mkdir('C:\\src\\App');
    for (const [name, text] of [['one.txt', 'first'], ['two.txt', 'two']])
    {
        const node = files.open(`C:\\src\\App\\${name}`, { write: true, create: true });
        files.write(node, 0, new TextEncoder().encode(text));
        files.close(node);
    }
    const session = createSession({ db, packagePath: 'C:\\src\\test.msi', machine: MACHINE });
    /** @type {{ kind: number, fields: any[], at: string[] }[]} */
    const heard = [];
    const engine = /** @type {any} */ ({
        session, thread: null, ran: new Set(), commit: [], async: [], executing: true,
        host: {
            files,
            hive: createHive(),
            registration: { registerComponent: ()=>{} },
            /** @param {number} type @param {any} record */
            message: (type, record)=>{
                // What is on the volume when the message comes.
                const at = ['one.txt', 'two.txt']
                    .filter(name=>files.stat(`C:\\App\\${name}`)?.exists);
                heard.push({ kind: type & 0xff000000, fields: [...record.fields], at });
                return 0;
            },
            log: ()=>{},
        },
    });
    const code = await runSequence(engine, 'InstallExecuteSequence');
    return { code, heard, files };
}

test('the bar is set to what the installation will do, and moved by each piece as it is done',
    async()=>{
        const { code, heard } = await install();
        assert.equal(code, 0);
        const progress = heard.filter(entry=>entry.kind === INSTALLMESSAGE.PROGRESS)
            .map(entry=>entry.fields.slice(1));
        // Two files of five and three bytes, one registry value, two
        // components: what InstallValidate counts and what each is worth.
        assert.deepEqual(progress[0], [0, 5 + 3 + 13200 + 2 * 24000, 0, 0],
            'a reset to the total first, forward, the installation itself');
        assert.deepEqual(progress.slice(1).map(fields=>fields[0]), [2, 2, 2, 2, 2],
            'then reports');
        assert.equal(progress.slice(1).reduce((total, fields)=>total + fields[1], 0),
            progress[0][1], 'which come to the total');
    });

test('a file is told to the interface as it is begun and counted once it is down', async()=>{
    const { heard, files } = await install();
    const filesHeard = heard.filter(entry=>(entry.kind === INSTALLMESSAGE.ACTIONDATA
        && entry.fields[1]?.endsWith?.('.txt')) || (entry.kind === INSTALLMESSAGE.PROGRESS
        && entry.fields[1] === 2 && entry.fields[2] < 10));
    assert.deepEqual(filesHeard.map(entry=>[entry.kind === INSTALLMESSAGE.ACTIONDATA
        ? 'data' : 'progress', entry.at.join()]), [
        ['data', ''], ['progress', 'one.txt'], ['data', 'one.txt'], ['progress', 'one.txt,two.txt'],
    ]);
    const [first] = filesHeard;
    assert.equal(first.fields[0], 'File: [1],  Directory: [9],  Size: [6]', 'ActionText\'s'
        + ' template, for the interface to word it');
    assert.deepEqual([first.fields[1], first.fields[6], first.fields[9]],
        ['one.txt', 5, 'C:\\App\\']);
    assert.ok(files.stat('C:\\App\\two.txt')?.exists, 'by its long name');
});

test('an action written into the script starts again when the script carries it out', async()=>{
    const { heard } = await install();
    const starts = heard.filter(entry=>entry.kind === INSTALLMESSAGE.ACTIONSTART)
        .map(entry=>entry.fields[1]);
    const finalize = starts.indexOf('InstallFinalize');
    assert.deepEqual(starts.slice(finalize + 1), ['ProcessComponents', 'WriteRegistryValues'],
        'after InstallFinalize, as its script runs them');
    const value = heard.find(entry=>entry.kind === INSTALLMESSAGE.ACTIONDATA
        && entry.fields[1] === 'Software\\Test');
    assert.deepEqual(value?.fields, ['Key: [1], Name: [2], Value: [3]', 'Software\\Test', 'Path',
        'C:\\App\\'], 'and says what it writes, formatted');
    const writing = heard.findLastIndex(entry=>entry.kind === INSTALLMESSAGE.ACTIONSTART
        && entry.fields[1] === 'WriteRegistryValues');
    assert.ok(heard.indexOf(/** @type {any} */ (value)) > writing,
        'while it runs, not while it is written down');
});
