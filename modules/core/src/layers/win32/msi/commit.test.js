/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A database written through msi.dll as a program writes one: created,
 * filled with SQL, its summary set, committed -- and opened again from the
 * file with everything there.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMsiFunctions } from './functions.js';
import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';
import { createHive } from '../advapi32/registry.js';
import { filesystemModule } from '../../filesystem/module.js';
import { createVolume } from '../kernel32/vfs.js';

const MSIDBOPEN_READONLY = 0;
const MSIDBOPEN_CREATE = 3;
const PID_TITLE = 2;
const VT_LPSTR = 30;

/** msi.dll over a flat memory and a fresh volume. */
async function setup(){
    const memory = new Uint8Array(0x100000);
    let next = 0x80000;
    const files = /** @type {any} */ (createVolume(await filesystemModule.create({})));
    files.mkdir('C:\\work');
    const fns = /** @type {any} */ (createMsiFunctions(/** @type {any} */ ({
        readMemory: (/** @type {number} */ at, /** @type {number} */ n)=>memory.subarray(at, at + n),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ bytes)=>
            memory.set(bytes, at),
        readCString: (/** @type {number} */ at)=>decodeAnsi(memory.subarray(at,
            memory.indexOf(0, at))),
        readWideString: ()=>'',
        allocate: (/** @type {number} */ size)=>{
            const at = next;
            next += size + 16;
            return at;
        },
        free: ()=>{},
        hive: createHive(),
        files,
        fullPath: (/** @type {string} */ path)=>path,
        callerThread: ()=>null,
    })));
    const view = new DataView(memory.buffer);
    // Above 64 KB, where a pointer is told from MsiOpenDatabase's modes.
    let scratch = 0x20000;
    /** @param {string} text */
    const put = text=>{
        const at = scratch;
        memory.set(encodeAnsi(`${text}\0`), at);
        scratch += text.length + 16;
        return at;
    };
    /** @param {string} name @param {number[]} args */
    const call = async(name, args)=>fns[name].handler(args);
    /** @param {string} sql @param {number} database */
    const run = async(sql, database)=>{
        assert.equal(await call('MsiDatabaseOpenViewA', [database, put(sql), 0x40]), 0, sql);
        const handle = view.getUint32(0x40, true);
        assert.equal(await call('MsiViewExecute', [handle, 0]), 0, sql);
        return handle;
    };
    /** @param {number} handle @param {number} field */
    const fieldText = async(handle, field)=>{
        view.setUint32(0x48, 256, true);
        await call('MsiRecordGetStringA', [handle, field, 0x8000, 0x48]);
        return decodeAnsi(memory.subarray(0x8000, memory.indexOf(0, 0x8000)));
    };
    return { files, call, put, view, run, fieldText };
}

test('a created database, filled and committed, reads back from its file', async()=>{
    const { files, call, put, view, run, fieldText } = await setup();
    const path = put('C:\\work\\made.msi');
    assert.equal(await call('MsiOpenDatabaseA', [path, MSIDBOPEN_CREATE, 0x40]), 0);
    const database = view.getUint32(0x40, true);
    await run('CREATE TABLE `Fruit` (`Name` CHAR(32) NOT NULL, `Count` SHORT '
        + 'PRIMARY KEY `Name`)', database);
    await run('INSERT INTO `Fruit` (`Name`, `Count`) VALUES (\'apple\', 3)', database);
    await run('INSERT INTO `Fruit` (`Name`, `Count`) VALUES (\'pear\', 5)', database);
    assert.equal(await call('MsiGetSummaryInformationA', [database, 0, 20, 0x44]), 0);
    const summary = view.getUint32(0x44, true);
    assert.equal(await call('MsiSummaryInfoSetPropertyA', [summary, PID_TITLE, VT_LPSTR, 0, 0,
        put('Fruit basket')]), 0);
    assert.equal(await call('MsiSummaryInfoPersist', [summary]), 0);
    assert.equal(files.stat('C:\\work\\made.msi'), null, 'nothing written before the commit');
    assert.equal(await call('MsiDatabaseCommit', [database]), 0);
    assert.ok(files.stat('C:\\work\\made.msi')?.size > 0);
    assert.equal(files.stat('C:\\work\\made.msi.tmp'), null, 'no temporary file left');

    assert.equal(await call('MsiOpenDatabaseA', [path, MSIDBOPEN_READONLY, 0x40]), 0);
    const again = view.getUint32(0x40, true);
    const query = await run('SELECT `Name`, `Count` FROM `Fruit` ORDER BY `Name`', again);
    const rows = [];
    while (await call('MsiViewFetch', [query, 0x4c]) === 0)
    {
        const record = view.getUint32(0x4c, true);
        rows.push([await fieldText(record, 1),
            await call('MsiRecordGetInteger', [record, 2])]);
    }
    assert.deepEqual(rows, [['apple', 3], ['pear', 5]]);
    assert.equal(await call('MsiGetSummaryInformationA', [again, 0, 0, 0x44]), 0);
    view.setUint32(0x48, 64, true);
    assert.equal(await call('MsiSummaryInfoGetPropertyA', [view.getUint32(0x44, true),
        PID_TITLE, 0x50, 0x54, 0x58, 0x9000, 0x48]), 0);
    assert.equal(decodeAnsi(new Uint8Array(view.buffer, 0x9000, 12)), 'Fruit basket',
        'the summary went with the commit');
});

test('a read-only database commits nothing, and an output path takes the changes', async()=>{
    const { files, call, put, view, run } = await setup();
    const path = put('C:\\work\\base.msi');
    await call('MsiOpenDatabaseA', [path, MSIDBOPEN_CREATE, 0x40]);
    const created = view.getUint32(0x40, true);
    await run('CREATE TABLE `T` (`K` CHAR(8) NOT NULL PRIMARY KEY `K`)', created);
    await call('MsiDatabaseCommit', [created]);
    const before = files.stat('C:\\work\\base.msi').size;

    await call('MsiOpenDatabaseA', [path, MSIDBOPEN_READONLY, 0x40]);
    assert.equal(await call('MsiDatabaseCommit', [view.getUint32(0x40, true)]), 0);
    assert.equal(files.stat('C:\\work\\base.msi').size, before);

    await call('MsiOpenDatabaseA', [path, put('C:\\work\\copy.msi'), 0x40]);
    const edited = view.getUint32(0x40, true);
    await run('INSERT INTO `T` (`K`) VALUES (\'x\')', edited);
    assert.equal(await call('MsiDatabaseCommit', [edited]), 0);
    assert.ok(files.stat('C:\\work\\copy.msi'), 'written to the output path');
    assert.equal(files.stat('C:\\work\\base.msi').size, before, 'the source untouched');
});
