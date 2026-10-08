/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * MsiEnableLog, as `msiexec /l` and a setup that wants a record of its
 * installation use it: the kinds of message it names written to the file,
 * an installation's start and end around them, the properties at the end
 * when asked, and the file started afresh or added to.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMsiFunctions } from './functions.js';
import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';
import { databaseBytes } from './database-writer.js';
import { EXECUTE_SEQUENCE, MACHINE, machine, packageDatabase, typed } from './install.fixture.js';
import { readFile } from './actions.js';

const PRODUCT = '{6D7A2B10-1111-4222-8333-944455556677}';
const INSTALLLOGMODE_INFO = 0x10;
const INSTALLLOGMODE_ACTIONSTART = 0x100;
const INSTALLLOGMODE_PROPERTYDUMP = 0x400;
const INSTALLLOGATTRIBUTES_APPEND = 0x1;

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
        'KeyPath'], [['Core', '{11111111-1111-1111-1111-111111111177}', 'INSTALLDIR', 0, null,
        'exe']]],
    FeatureComponents: [['Feature_', 'Component_'], [['Main', 'Core']]],
    File: [['File', 'Component_', 'FileName', 'FileSize', 'Version', 'Language', 'Attributes',
        'Sequence'], [['exe', 'Core', 'game.exe', 4, null, null, 0, 1]]],
    Media: [['DiskId', 'LastSequence', 'DiskPrompt', 'Cabinet', 'VolumeLabel', 'Source'],
        [[1, 1, null, null, null, null]]],
    InstallExecuteSequence: [['Action', 'Condition', 'Sequence'], EXECUTE_SEQUENCE],
};

test('an installation is logged as MsiEnableLog asked, afresh or added to', async()=>{
    const host = await machine(['C:\\src', 'C:\\src\\Game', 'C:\\logs'],
        { 'C:\\src\\Game\\game.exe': 'MZ..' });
    const { files } = host;
    const node = files.open('C:\\src\\game.msi', { write: true, create: true });
    files.write(node, 0, await databaseBytes(typed(packageDatabase(TABLES))));
    files.close(node);

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
    const logText = async()=>{
        const bytes = await readFile(files, 'C:\\logs\\setup.log');
        return bytes ? decodeAnsi(bytes) : null;
    };
    /** @param {string} commandLine */
    const install = async commandLine=>fns.MsiInstallProductA.handler(
        [put(0x100, 'C:\\src\\game.msi'), put(0x200, commandLine)]);
    const log = put(0x300, 'C:\\logs\\setup.log');

    assert.equal(fns.MsiEnableLogA.handler([INSTALLLOGMODE_ACTIONSTART | INSTALLLOGMODE_INFO
        | INSTALLLOGMODE_PROPERTYDUMP, log, 0]), 0);
    assert.equal(await install(''), 0);
    const first = /** @type {string} */ (await logText());
    const lines = first.split('\r\n');
    assert.match(lines[0], /^=== Logging started: \d+\/\d+\/\d{4} {2}\d+:\d\d:\d\d ===$/);
    assert.ok(lines.some(line=>/^Action \d\d:\d\d:\d\d: InstallFiles\./.test(line)),
        'each action as it starts');
    assert.ok(lines.includes(`Property(S): ProductCode = ${PRODUCT}`),
        'and the properties at the end, as the property-dump bit asks');
    assert.match(lines.at(-2) ?? '', /^=== Logging stopped: /);
    assert.equal(lines.at(-1), '', 'each line ends with CR LF');

    assert.equal(fns.MsiEnableLogA.handler([INSTALLLOGMODE_ACTIONSTART, log,
        INSTALLLOGATTRIBUTES_APPEND]), 0);
    assert.equal(await install('REINSTALL=ALL REINSTALLMODE=omus'), 0);
    const added = /** @type {string} */ (await logText());
    assert.ok(added.startsWith(first), 'appending keeps what the file had');
    assert.equal(added.match(/=== Logging started/g)?.length, 2);
    assert.ok(!added.slice(first.length).includes('Property(S)'),
        'and lists no properties when the bit is not asked for');

    assert.equal(fns.MsiEnableLogA.handler([INSTALLLOGMODE_ACTIONSTART, log, 0]), 0);
    assert.equal(await install('REMOVE=ALL'), 0);
    assert.equal((await logText())?.match(/=== Logging started/g)?.length, 1,
        'without the append attribute the file is started afresh');

    files.remove('C:\\logs\\setup.log');
    assert.equal(fns.MsiEnableLogA.handler([0, log, 0]), 0, 'no kinds is no log');
    assert.equal(await install(''), 0);
    assert.equal(await logText(), null, 'nothing is written');
});
