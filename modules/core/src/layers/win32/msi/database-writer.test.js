/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bytesSource, openCompound } from './compound.js';
import { COPY_CHUNK, compoundBytes, storageOf, streamOf } from './compound-writer.js';
import { isPattern, patternSource, pieceFile } from './compound-writer.fixture.js';
import {
    CLSID_MSI_DATABASE, DatabaseWriteError, databaseBytes, databaseTree, embeddedCabinets,
    writeDatabase,
} from './database-writer.js';
import {
    createEmptyDatabase, encodeStreamName, openDatabase, readStringPool,
} from './database.js';
import { PID, VT, readSummary } from './summary.js';
import { insertRow } from './query.js';
import { ascii, run, select } from './transform.fixture.js';
import { writeSummaryStream } from './transform.js';

/** @typedef {import('./database.js').Database} Database */

/** @param {Uint8Array} bytes */
const reopen = async bytes=>openDatabase(await openCompound(bytesSource(bytes)));

/**
 * What a program can see of a database: every saved table's columns and
 * rows, every stream and the code page.
 *
 * @param {Database} db
 */
const contents = async db=>{
    /** @type {Record<string, unknown>} */
    const tables = {};
    for (const [name, table] of db.tables)
    {
        if (!table.temporary)
        {
            tables[name] = {
                columns: table.columns.map(column=>[column.number, column.name, column.type]),
                rows: table.rows.filter(row=>!table.temporaryRows.has(row)),
            };
        }
    }
    /** @type {Record<string, Uint8Array | null>} */
    const streams = {};
    for (const name of db.streamNames().sort())
    {
        streams[name] = await db.readStream(name);
    }
    return { codepage: db.codepage, tables, streams };
};

test('tables, nulls, integers, long strings and streams read back as they were', async()=>{
    const db = createEmptyDatabase();
    run(db, [
        'CREATE TABLE `Values` ( `Key` CHAR(72) NOT NULL, `Short` SHORT, `Long` LONG, '
            + '`Text` LONGCHAR LOCALIZABLE PRIMARY KEY `Key`)',
        'INSERT INTO `Values` (`Key`, `Short`, `Long`, `Text`) VALUES (\'b\', -2, 70000, \'x\')',
        'INSERT INTO `Values` (`Key`, `Short`, `Long`) VALUES (\'a\', 32767, -2147483647)',
        'INSERT INTO `Values` (`Key`) VALUES (\'c\')',
        'CREATE TABLE `Binary` ( `Name` CHAR(72) NOT NULL, `Data` OBJECT PRIMARY KEY `Name`)',
        'CREATE TABLE `Empty` ( `Id` SHORT NOT NULL PRIMARY KEY `Id`)',
        'CREATE TABLE `Scratch` ( `Id` SHORT NOT NULL TEMPORARY PRIMARY KEY `Id`) HOLD',
        'INSERT INTO `Scratch` (`Id`) VALUES (1)',
    ]);
    const long = 'L'.repeat(70000);
    run(db, [`INSERT INTO \`Values\` (\`Key\`, \`Text\`) VALUES ('d', '${long}')`]);
    const binary = /** @type {import('./database.js').Table} */ (db.table('Binary'));
    binary.rows.push(['icon', 'Binary.icon'], ['none', null]);
    db.writeStream('Binary.icon', ascii('pixels'));
    db.writeStream('Data1.cab', new Uint8Array(5000).fill(7));
    // Not saved: a temporary row and a temporary column.
    const values = /** @type {import('./database.js').Table} */ (db.table('Values'));
    assert.equal(insertRow(db, values, ['z', 1, 1, 'gone'], true), 0);
    run(db, ['ALTER TABLE `Values` ADD `Note` CHAR(10) TEMPORARY']);

    const before = await contents(db);
    const after = await reopen(await databaseBytes(db));
    const read = await contents(after);
    assert.deepEqual(Object.keys(read.tables).sort(),
        ['Binary', 'Empty', 'Values', '_Columns', '_Tables']);
    for (const name of ['Binary', 'Empty'])
    {
        assert.deepEqual(read.tables[name], before.tables[name], name);
    }
    assert.deepEqual(after.table('Values')?.columns.map(column=>column.name),
        ['Key', 'Short', 'Long', 'Text'], 'the temporary column is not saved');
    assert.deepEqual(after.table('Values')?.rows, [
        ['b', -2, 70000, 'x'], ['a', 32767, -2147483647, null], ['c', null, null, null],
        ['d', null, null, long],
    ]);
    assert.deepEqual(after.table('Values')?.columns.map(column=>column.type),
        values.columns.slice(0, 4).map(column=>column.type));
    assert.deepEqual(after.table('_Tables')?.rows.map(row=>row[0]).sort(),
        ['Binary', 'Empty', 'Values']);
    assert.deepEqual(after.table('_Columns')?.rows.filter(row=>row[0] === 'Values')
        .map(row=>row.slice(1)), values.columns.slice(0, 4)
        .map((column, index)=>[index + 1, column.name, column.type]));
    assert.deepEqual(read.streams, before.streams);
    assert.deepEqual(select(after, 'SELECT `Key` FROM `Values` WHERE `Short` = -2'), [['b']]);
});

test('the pool keeps each string\'s number and counts its references', async()=>{
    const db = createEmptyDatabase();
    run(db, [
        'CREATE TABLE `T` ( `K` CHAR(8) NOT NULL, `V` CHAR(8) PRIMARY KEY `K`)',
        'INSERT INTO `T` (`K`, `V`) VALUES (\'zz\', \'shared\')',
        'INSERT INTO `T` (`K`, `V`) VALUES (\'aa\', \'shared\')',
    ]);
    const ids = ['T', 'K', 'V', 'zz', 'aa', 'shared'].map(text=>db.stringId(text));
    const bytes = await databaseBytes(db);
    const after = await reopen(bytes);
    assert.deepEqual(['T', 'K', 'V', 'zz', 'aa', 'shared'].map(text=>after.stringId(text)), ids);
    assert.deepEqual(select(after, 'SELECT `K` FROM `T` ORDER BY `K`'), [['zz'], ['aa']],
        'a string column orders by the number, as before it was saved');

    const file = await openCompound(bytesSource(bytes));
    const poolNode = file.root.children.get(
        /** @type {string} */ (encodeStreamName('_StringPool', true)).toUpperCase());
    const pool = await file.readAll(/** @type {any} */ (poolNode));
    const refsOf = (/** @type {number} */ id)=>pool[id * 4 + 2] | pool[id * 4 + 3] << 8;
    assert.equal(refsOf(db.stringId('shared')), 2);
    assert.equal(refsOf(db.stringId('T')), 1 + 2, 'in _Tables once, in _Columns per column');
});

test('a pool past 65535 strings makes every reference three bytes', async()=>{
    const db = createEmptyDatabase();
    run(db, ['CREATE TABLE `Many` ( `K` CHAR(16) NOT NULL, `N` LONG PRIMARY KEY `K`)']);
    const many = /** @type {import('./database.js').Table} */ (db.table('Many'));
    for (let index = 0; index < 70000; index++)
    {
        many.rows.push([`s${index}`, index]);
    }
    const bytes = await databaseBytes(db);
    const file = await openCompound(bytesSource(bytes));
    const stream = async(/** @type {string} */ name)=>file.readAll(/** @type {any} */ (
        file.root.children.get(/** @type {string} */ (encodeStreamName(name, true))
            .toUpperCase())));
    assert.equal(readStringPool(await stream('_StringPool'), await stream('_StringData')).longRefs,
        true);
    assert.equal((await stream('Many')).length, 70000 * (3 + 4));
    const after = await openDatabase(file);
    assert.deepEqual(after.table('Many')?.rows.slice(-2), [['s69998', 69998], ['s69999', 69999]]);
    assert.equal(after.table('Many')?.rows.length, 70000);
});

test('a code page is kept, and the strings are in it', async()=>{
    const db = createEmptyDatabase();
    db.codepage = 1251;
    run(db, [
        'CREATE TABLE `Property` ( `Property` CHAR(72) NOT NULL, `Value` LONGCHAR '
            + 'PRIMARY KEY `Property`)',
        'INSERT INTO `Property` (`Property`, `Value`) VALUES (\'ProductName\', \'Игра\')',
    ]);
    const after = await reopen(await databaseBytes(db));
    assert.equal(after.codepage, 1251);
    assert.deepEqual(after.table('Property')?.rows, [['ProductName', 'Игра']]);
});

test('an opened package written again keeps its streams, storages, summary and class',
    async()=>{
        const db = createEmptyDatabase();
        run(db, [
            'CREATE TABLE `Media` ( `DiskId` SHORT NOT NULL, `Cabinet` CHAR(255) '
                + 'PRIMARY KEY `DiskId`)',
            'INSERT INTO `Media` (`DiskId`, `Cabinet`) VALUES (1, \'#Data1.cab\')',
            'INSERT INTO `Media` (`DiskId`, `Cabinet`) VALUES (2, \'Disk2.cab\')',
            'CREATE TABLE `Gone` ( `Id` SHORT NOT NULL PRIMARY KEY `Id`)',
        ]);
        db.writeStream('Untouched', ascii('as it was'));
        db.setSummaryStream(writeSummaryStream(new Map([
            [PID.CODEPAGE, { type: VT.I2, value: 1252 }],
            [PID.TITLE, { type: VT.LPSTR, value: 'Installation Database' }],
        ])));
        // A transform embedded as a storage, and a stream another program
        // named without packing, both as an opened package carries them.
        const first = databaseTree(db);
        first.children.push(storageOf('1033.mst', [streamOf('inside', ascii('t'))],
            '{000C1082-0000-0000-C000-000000000046}'));
        first.children.push(streamOf('\u0005DigitalSignature', ascii('sig')));
        const opened = await reopen(await compoundBytes(first));

        run(opened, [
            'DROP TABLE `Gone`',
            'INSERT INTO `Media` (`DiskId`, `Cabinet`) VALUES (3, \'Disk3.cab\')',
        ]);
        opened.writeStream('Added', ascii('new'));
        const summary = readSummary(opened.summaryStream());
        summary.set(PID.AUTHOR, { type: VT.LPSTR, value: 'Someone' });
        opened.setSummaryStream(writeSummaryStream(summary));

        const bytes = await databaseBytes(opened);
        const file = await openCompound(bytesSource(bytes));
        assert.equal(file.root.clsid, CLSID_MSI_DATABASE);
        assert.equal(file.root.children.get('1033.MST')?.clsid,
            '{000C1082-0000-0000-C000-000000000046}');
        assert.ok(file.root.children.has('\u0005DIGITALSIGNATURE'), 'its own name, unpacked');
        const after = await openDatabase(file);
        assert.equal(after.table('Gone'), null);
        assert.deepEqual(after.table('Media')?.rows,
            [[1, '#Data1.cab'], [2, 'Disk2.cab'], [3, 'Disk3.cab']]);
        assert.deepEqual(await after.readStream('Untouched'), ascii('as it was'));
        assert.deepEqual(await after.readStream('Added'), ascii('new'));
        assert.equal(readSummary(after.summaryStream()).get(PID.AUTHOR)?.value, 'Someone');
        assert.equal(readSummary(after.summaryStream()).get(PID.TITLE)?.value,
            'Installation Database');
    });

test('a large cabinet is copied a chunk at a time, or left out', async()=>{
    const size = 12 * 1024 * 1024 + 7;
    const cabinet = patternSource(size, 3);
    const db = createEmptyDatabase();
    run(db, [
        'CREATE TABLE `Media` ( `DiskId` SHORT NOT NULL, `Cabinet` CHAR(255) '
            + 'PRIMARY KEY `DiskId`)',
        'INSERT INTO `Media` (`DiskId`, `Cabinet`) VALUES (1, \'#Data1.cab\')',
    ]);
    db.writeStream('Binary.ui', ascii('dialog'));
    const tree = databaseTree(db);
    tree.children.push({ kind: 'stream', name: /** @type {string} */ (
        encodeStreamName('Data1.cab', false)), source: cabinet });
    const original = pieceFile();
    await writeDatabase(await reopen(await compoundBytes(tree)), original.sink);
    const opened = await openDatabase(await openCompound(original.source()));
    assert.equal(opened.streamSize('Data1.cab'), size);

    // Written again from the opened file: read where it lies, never whole.
    /** @type {number[]} */
    const reads = [];
    const range = opened.readStreamRange;
    opened.readStreamRange = async(name, offset, length)=>{
        if (name === 'Data1.cab')
        {
            reads.push(length);
        }
        return range(name, offset, length);
    };
    const copy = pieceFile();
    await writeDatabase(opened, copy.sink);
    assert.ok(reads.length > 1 && reads.every(length=>length <= COPY_CHUNK));
    const again = await openDatabase(await openCompound(copy.source()));
    assert.ok(isPattern(/** @type {Uint8Array} */ (await again.readStream('Data1.cab')), 0, 3));

    assert.deepEqual([...embeddedCabinets(opened)], ['Data1.cab']);
    const cached = await reopen(await databaseBytes(opened,
        { omitStreams: name=>embeddedCabinets(opened).has(name) }));
    assert.equal(cached.hasStream('Data1.cab'), false);
    assert.deepEqual(await cached.readStream('Binary.ui'), ascii('dialog'));
    assert.deepEqual(cached.table('Media')?.rows, [[1, '#Data1.cab']]);
});

test('a name that does not fit in a directory entry is refused', ()=>{
    const db = createEmptyDatabase();
    db.writeStream('-'.repeat(32), ascii('long'));
    assert.throws(()=>databaseTree(db), DatabaseWriteError);
});
