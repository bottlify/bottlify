/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    ERROR_BAD_QUERY_SYNTAX, ERROR_DATATYPE_MISMATCH, ERROR_FUNCTION_FAILED, ERROR_SUCCESS,
    exportTable, importTable, mergeDatabases, streamFolder,
} from './archive.js';
import { bytesSource, openCompound } from './compound.js';
import { databaseBytes } from './database-writer.js';
import { createEmptyDatabase, openDatabase } from './database.js';
import { PID, VT, readSummary } from './summary.js';
import { ascii, run, select } from './transform.fixture.js';

/** @typedef {import('./database.js').Database} Database */

const noStreams = ()=>null;

/** @param {Database} db @param {string} table */
const exported = async(db, table)=>{
    const result = await exportTable(db, table);
    assert.equal(result.code, ERROR_SUCCESS, table);
    return result.text;
};

/** @param {Database} db @param {string} text */
const imported = async(db, text)=>importTable(db, text, noStreams);

test('a table is written as names, types, its name and keys, then its rows, CR LF', async()=>{
    // Wine's test_msiexport: the columns' types say whether they may be null.
    const db = createEmptyDatabase();
    run(db, [
        'CREATE TABLE `phone` ( `id` INT, `name` CHAR(32), `number` CHAR(32) PRIMARY KEY `id`)',
        'INSERT INTO `phone` ( `id`, `name`, `number` ) VALUES ( 1, \'Abe\', \'8675309\' )',
    ]);
    const result = await exportTable(db, 'phone');
    assert.equal(result.text,
        'id\tname\tnumber\r\nI2\tS32\tS32\r\nphone\tid\r\n1\tAbe\t8675309\r\n');
    assert.deepEqual(result.bytes, ascii(result.text));
    assert.deepEqual(result.streams, []);
    assert.equal((await exportTable(db, 'nothing')).code, ERROR_BAD_QUERY_SYNTAX);
});

test('the code page is a table of its own, refused when it is not one', async()=>{
    const db = createEmptyDatabase();
    assert.equal(await exported(db, '_ForceCodepage'), '\r\n\r\n0\t_ForceCodepage\r\n');
    assert.equal(await imported(db, '\r\n\r\n850\t_ForceCodepage\r\n'), ERROR_SUCCESS);
    assert.equal(db.codepage, 850);
    assert.equal(await exported(db, '_ForceCodepage'), '\r\n\r\n850\t_ForceCodepage\r\n');
    assert.equal(await imported(db, '\r\n\r\n9999\t_ForceCodepage\r\n'), ERROR_FUNCTION_FAILED);
    assert.equal(db.codepage, 850);
});

test('a table is read with its types, its keys and its nulls, lines ending in LF alone', async()=>{
    // Wine's test_msiimport.
    const db = createEmptyDatabase();
    assert.equal(await imported(db, 'FirstPrimaryColumn\tSecondPrimaryColumn\tShortInt\t'
        + 'ShortIntNullable\tLongInt\tLongIntNullable\tString\tLocalizableString\t'
        + 'LocalizableStringNullable\n'
        + 's255\ti2\ti2\tI2\ti4\tI4\tS255\tS0\ts0\n'
        + 'TestTable\tFirstPrimaryColumn\n'
        + 'stringage\t5\t2\t\t2147483640\t-2147483640\tanother string\tlocalizable\tduh\n'),
    ERROR_SUCCESS);
    const text = await exported(db, 'TestTable');
    assert.equal(text.split('\r\n')[1], 's255\ti2\ti2\tI2\ti4\tI4\tS255\tS0\ts0');
    assert.equal(text.split('\r\n')[2], 'TestTable\tFirstPrimaryColumn');
    assert.deepEqual(select(db, 'SELECT * FROM `TestTable`'), [['stringage', 5, 2, null,
        2147483640, -2147483640, 'another string', 'localizable', 'duh']]);
    assert.deepEqual(select(db, 'SELECT `Name` FROM `_Tables`'), [['TestTable']]);
    assert.equal(select(db, 'SELECT * FROM `_Columns` WHERE `Table` = \'TestTable\'').length, 9);

    assert.equal(await imported(db, 'PrimaryOne\tPrimaryTwo\ns255\ts255\n'
        + 'TwoPrimary\tPrimaryOne\tPrimaryTwo\npapaya\tleaf\npapaya\tflower\n'), ERROR_SUCCESS);
    assert.deepEqual(select(db, 'SELECT * FROM `TwoPrimary`').length, 2);
    assert.equal(await imported(db, 'A\tB\tC\tD\tE\tF\r\ns72\ts72\ts72\ts72\ts72\ts72\n'
        + 'Table\tA\r\na\tb\tc\td\te\tf\ng\th\ti\tj\tk\tl\r\n'), ERROR_SUCCESS);
    assert.deepEqual(select(db, 'SELECT * FROM `Table`'),
        [['a', 'b', 'c', 'd', 'e', 'f'], ['g', 'h', 'i', 'j', 'k', 'l']]);
    // A carriage return alone does not end a line.
    assert.equal(await imported(db, 'A\tB\tC\tD\tE\tF\rs72\ts72\ts72\ts72\ts72\ts72\n'
        + 'Table2\tA\r\na\tb\tc\td\te\tf\ng\th\ti\tj\tk\tl\r\n'), ERROR_FUNCTION_FAILED);
    assert.equal(db.table('Table2'), null);
});

test('what is not an archive is refused, and leaves the table as it was', async()=>{
    const db = createEmptyDatabase();
    const good = 'A\tB\r\ns72\tI2\r\nT\tA\r\nx\t1\r\n';
    assert.equal(await imported(db, good), ERROR_SUCCESS);
    for (const bad of [
        '', 'A\tB\r\ns72\r\nT\tA\r\n', 'A\tB\r\ns72\tI2\r\nT\tA\r\nx\r\n',
        'A\tB\r\ns72\tx2\r\nT\tA\r\n', 'A\tB\r\ns72\ti3\r\nT\tA\r\n', 'A\tB\r\ns72\ti2\r\nT\r\n',
        'A\tB\r\ns72\ti2\r\nT\tC\r\n', 'A\tA\r\ns72\ti2\r\nT\tA\r\n',
        'A\tB\r\ns72\ti2\r\nT\tA\r\ny\tz\r\n',
        'A\tB\r\ns72\ti2\r\nT\tA\r\ny\t1\r\ny\t2\r\n', 'A\r\ns72\r\n_Tables\tA\r\n',
    ])
    {
        assert.equal(await imported(db, bad), ERROR_FUNCTION_FAILED, JSON.stringify(bad));
    }
    assert.deepEqual(select(db, 'SELECT * FROM `T`'), [['x', 1]]);
});

test('a table imported again replaces the one there', async()=>{
    const db = createEmptyDatabase();
    run(db, ['CREATE TABLE `T` ( `A` CHAR(72) NOT NULL, `B` SHORT PRIMARY KEY `A`)',
        'INSERT INTO `T` ( `A`, `B` ) VALUES ( \'old\', 1 )']);
    assert.equal(await imported(db, 'A\tC\r\ns72\tS10\r\nT\tA\r\nnew\tthing\r\n'), ERROR_SUCCESS);
    assert.deepEqual(select(db, 'SELECT * FROM `T`'), [['new', 'thing']]);
    assert.deepEqual(select(db, 'SELECT `Name` FROM `_Columns` WHERE `Table` = \'T\''),
        [['A'], ['C']]);
});

test('tabs and line breaks in a field go out escaped and come back', async()=>{
    const db = createEmptyDatabase();
    run(db, ['CREATE TABLE `Property` ( `Property` CHAR(72) NOT NULL, '
        + '`Value` LONGCHAR NOT NULL LOCALIZABLE PRIMARY KEY `Property`)']);
    const value = 'one\r\ntwo\tthree\nfour';
    /** @type {import('./database.js').Table} */ (db.table('Property')).rows
        .push(['Text', value]);
    const text = await exported(db, 'Property');
    assert.equal(text, 'Property\tValue\r\ns72\tl0\r\nProperty\tProperty\r\n'
        + 'Text\tone\u0011\u0019two\u0010three\u0019four\r\n');
    const copy = createEmptyDatabase();
    assert.equal(await imported(copy, text), ERROR_SUCCESS);
    assert.deepEqual(select(copy, 'SELECT `Value` FROM `Property`'), [[value]]);
});

test('a stream is a file beside the archive, named for the archive and the row', async()=>{
    // Wine's test_binary_import: the archive bin_import.idt, its stream in bin_import\.
    assert.equal(streamFolder('bin_import.idt'), 'bin_import');
    assert.equal(streamFolder('a.b\\noextension'), null);
    const db = createEmptyDatabase();
    /** @type {string[]} */
    const asked = [];
    const archive = 'Name\tData\r\ns72\tV0\r\nBinary\tName\r\nfilename1\tfilename1.ibd\r\n'
        + 'empty\t\r\n';
    assert.equal(await importTable(db, archive, file=>{
        asked.push(file);
        return file === 'filename1.ibd' ? ascii('just some words') : null;
    }), ERROR_SUCCESS);
    assert.deepEqual(asked, ['filename1.ibd']);
    // Rows in key order: a string key's order is the order its string came in.
    assert.deepEqual(db.table('Binary')?.rows,
        [['filename1', 'Binary.filename1'], ['empty', null]]);
    assert.deepEqual(await db.readStream('Binary.filename1'), ascii('just some words'));

    const result = await exportTable(db, 'Binary');
    assert.equal(result.text, archive);
    assert.deepEqual(result.streams, [{ path: 'Binary\\filename1.ibd',
        bytes: ascii('just some words') }]);
    assert.equal(await importTable(createEmptyDatabase(), archive, ()=>null),
        ERROR_FUNCTION_FAILED, 'a stream file that is not there');
});

test('the summary information is a table of properties, dates written out', async()=>{
    // Wine's test_suminfo_import.
    const db = createEmptyDatabase();
    const archive = 'PropertyId\tValue\r\ni2\tl255\r\n_SummaryInformation\tPropertyId\r\n'
        + '1\t1252\r\n2\tInstaller Database\r\n3\tInstaller description\r\n4\tWineHQ\r\n'
        + '5\tInstaller\r\n6\tInstaller comments\r\n7\tIntel;1033,2057\r\n'
        + '9\t{12345678-1234-1234-1234-123456789012}\r\n12\t2009/04/12 15:46:11\r\n'
        + '13\t2009/04/12 15:46:11\r\n14\t200\r\n15\t2\r\n18\tVim\r\n19\t2\r\n';
    assert.equal(await imported(db, archive), ERROR_SUCCESS);
    const summary = readSummary(db.summaryStream());
    assert.deepEqual(summary.get(PID.CODEPAGE), { type: VT.I2, value: 1252 });
    assert.deepEqual(summary.get(PID.TITLE), { type: VT.LPSTR, value: 'Installer Database' });
    assert.deepEqual(summary.get(PID.PAGECOUNT), { type: VT.I4, value: 200 });
    assert.deepEqual(summary.get(PID.CREATE_DTM), { type: VT.FILETIME,
        value: (BigInt(Date.UTC(2009, 3, 12, 15, 46, 11)) + 11644473600000n) * 10000n });
    assert.equal(await exported(db, '_SummaryInformation'), archive);

    assert.equal(await imported(db, 'PropertyId\tValue\r\ni2\tl255\r\n'
        + '_SummaryInformation\tPropertyId\r\n4\tSomeone else\r\n'), ERROR_SUCCESS);
    const again = readSummary(db.summaryStream());
    assert.equal(again.get(PID.AUTHOR)?.value, 'Someone else');
    assert.equal(again.get(PID.TITLE)?.value, 'Installer Database', 'the others kept');
    for (const bad of ['17\tx', '12\tyesterday', '14\tmany'])
    {
        assert.equal(await imported(db, 'PropertyId\tValue\r\ni2\tl255\r\n'
            + `_SummaryInformation\tPropertyId\r\n${bad}\r\n`), ERROR_FUNCTION_FAILED, bad);
    }
});

test('imported tables are saved and read back as they were written out', async()=>{
    const db = createEmptyDatabase();
    const tables = {
        Property: 'Property\tValue\r\ns72\tl0\r\nProperty\tProperty\r\nB\tsecond\r\n'
            + 'A\tfirst\r\n',
        Binary: 'Name\tData\r\ns72\tV0\r\nBinary\tName\r\nicon\ticon.ibd\r\n',
        Numbers: 'Key\tShort\tLong\r\ni2\tI2\tI4\r\nNumbers\tKey\r\n-3\t\t70000\r\n7\t-2\t\r\n',
    };
    for (const text of Object.values(tables))
    {
        assert.equal(await importTable(db, text, ()=>ascii('pixels')), ERROR_SUCCESS);
    }
    const reopened = await openDatabase(await openCompound(bytesSource(await databaseBytes(db))));
    for (const name of Object.keys(tables))
    {
        assert.equal(await exported(reopened, name), await exported(db, name), name);
    }
    assert.deepEqual((await exportTable(reopened, 'Binary')).streams,
        [{ path: 'Binary\\icon.ibd', bytes: ascii('pixels') }]);
});

/**
 * A base and a database to merge into it, each with the statements given.
 *
 * @param {string[]} base @param {string[]} merge
 */
const pair = (base, merge)=>{
    const db = createEmptyDatabase();
    const other = createEmptyDatabase();
    run(db, base);
    run(other, merge);
    return { db, other };
};

test('tables of other columns are not merged, and nothing else is', async()=>{
    // Wine's test_dbmergeview: names, types, keys and how many keys must agree.
    const cases = [
        ['`One` SHORT NOT NULL, `Two` CHAR(255) PRIMARY KEY `One`',
            '`One` CHAR(255) NOT NULL, `Two` SHORT PRIMARY KEY `One`'],
        ['`One` SHORT NOT NULL, `Two` CHAR(255) PRIMARY KEY `One`',
            '`One` SHORT NOT NULL, `Three` CHAR(255) PRIMARY KEY `One`'],
        ['`One` SHORT NOT NULL, `Two` CHAR(255) PRIMARY KEY `One`',
            '`One` SHORT NOT NULL, `Two` CHAR(255) NOT NULL PRIMARY KEY `One`'],
        ['`One` SHORT NOT NULL, `Two` SHORT PRIMARY KEY `One`',
            '`One` SHORT NOT NULL, `Two` LONG PRIMARY KEY `One`'],
        ['`One` SHORT NOT NULL, `Two` CHAR(255) NOT NULL PRIMARY KEY `One`',
            '`One` SHORT NOT NULL, `Two` CHAR(255) NOT NULL PRIMARY KEY `Two`'],
        ['`One` SHORT NOT NULL, `Two` CHAR(255) NOT NULL PRIMARY KEY `One`',
            '`One` SHORT NOT NULL, `Two` CHAR(255) NOT NULL PRIMARY KEY `One`, `Two`'],
        ['`One` SHORT NOT NULL PRIMARY KEY `One`',
            '`One` SHORT NOT NULL, `Two` CHAR(255) PRIMARY KEY `One`'],
    ];
    for (const [ours, theirs] of cases)
    {
        const { db, other } = pair([`CREATE TABLE \`MergeTest\` ( ${ours} )`], [
            'CREATE TABLE `Extra` ( `Id` SHORT NOT NULL PRIMARY KEY `Id`)',
            'INSERT INTO `Extra` ( `Id` ) VALUES ( 1 )',
            `CREATE TABLE \`MergeTest\` ( ${theirs} )`,
        ]);
        assert.equal(await mergeDatabases(db, other, 'MergeErrors'), ERROR_DATATYPE_MISMATCH,
            theirs);
        assert.equal(db.table('Extra'), null, 'checked before anything is merged');
        assert.equal(db.table('MergeErrors'), null);
    }
});

test('strings of other sizes or localized merge; new tables and rows are added', async()=>{
    const { db, other } = pair([
        'CREATE TABLE `MergeTest` ( `One` SHORT NOT NULL, `Two` CHAR(255) PRIMARY KEY `One`)',
        'INSERT INTO `MergeTest` ( `One`, `Two` ) VALUES ( 1, \'foo\' )',
    ], [
        'CREATE TABLE `MergeTest` ( `One` SHORT NOT NULL, `Two` CHAR(72) LOCALIZABLE '
            + 'PRIMARY KEY `One`)',
        'INSERT INTO `MergeTest` ( `One`, `Two` ) VALUES ( 1, \'foo\' )',
        'INSERT INTO `MergeTest` ( `One`, `Two` ) VALUES ( 2, \'bar\' )',
        'CREATE TABLE `Binary` ( `Name` CHAR(72) NOT NULL, `Data` OBJECT PRIMARY KEY `Name`)',
    ]);
    /** @type {import('./database.js').Table} */ (other.table('Binary')).rows
        .push(['icon', 'Somewhere.else']);
    other.writeStream('Somewhere.else', ascii('pixels'));
    assert.equal(await mergeDatabases(db, other, 'MergeErrors'), ERROR_SUCCESS);
    assert.deepEqual(select(db, 'SELECT * FROM `MergeTest`'), [[1, 'foo'], [2, 'bar']]);
    assert.deepEqual(db.table('Binary')?.rows, [['icon', 'Binary.icon']]);
    assert.deepEqual(await db.readStream('Binary.icon'), ascii('pixels'));
    assert.deepEqual(select(db, 'SELECT `Name` FROM `_Tables` WHERE `Name` = \'Binary\''),
        [['Binary']]);
    assert.equal(db.table('MergeErrors'), null, 'no conflicts, no error table');
    assert.equal(await mergeDatabases(db, other, null), ERROR_SUCCESS, 'merged twice');
    assert.equal(db.table('MergeTest')?.rows.length, 2);
});

test('a conflicting row is counted in the error table and its table not merged', async()=>{
    const statements = (/** @type {string} */ two)=>[
        'CREATE TABLE `MergeTest` ( `One` SHORT NOT NULL, `Two` CHAR(255) PRIMARY KEY `One`)',
        `INSERT INTO \`MergeTest\` ( \`One\`, \`Two\` ) VALUES ( 1, '${two}' )`,
    ];
    const { db, other } = pair(statements('foo'), [
        ...statements('bar'),
        'INSERT INTO `MergeTest` ( `One`, `Two` ) VALUES ( 2, \'new\' )',
        'CREATE TABLE `Clean` ( `Id` SHORT NOT NULL PRIMARY KEY `Id`)',
        'INSERT INTO `Clean` ( `Id` ) VALUES ( 7 )',
    ]);
    assert.equal(await mergeDatabases(db, other, 'MergeErrors'), ERROR_FUNCTION_FAILED);
    assert.deepEqual(select(db, 'SELECT * FROM `MergeTest`'), [[1, 'foo']]);
    assert.deepEqual(select(db, 'SELECT * FROM `Clean`'), [[7]], 'a table without one merged');
    assert.equal(await exported(db, 'MergeErrors'), 'Table\tNumRowMergeConflicts\r\n'
        + 's255\ti2\r\nMergeErrors\tTable\r\nMergeTest\t1\r\n');

    const { db: base, other: theirs } = pair(statements('foo'), statements('bar'));
    assert.equal(await mergeDatabases(base, theirs, null), ERROR_FUNCTION_FAILED);
    assert.equal(base.table('MergeErrors'), null, 'no table named, none made');
});

test('a stream conflicts by its bytes', async()=>{
    const statements = ['CREATE TABLE `Binary` ( `Name` CHAR(72) NOT NULL, `Data` OBJECT '
        + 'PRIMARY KEY `Name`)'];
    const { db, other } = pair(statements, statements);
    for (const [database, bytes] of /** @type {const} */ ([[db, 'one'], [other, 'one']]))
    {
        /** @type {import('./database.js').Table} */ (database.table('Binary')).rows
            .push(['icon', 'Binary.icon']);
        database.writeStream('Binary.icon', ascii(bytes));
    }
    assert.equal(await mergeDatabases(db, other, 'Errors'), ERROR_SUCCESS, 'the same bytes');
    other.writeStream('Binary.icon', ascii('two'));
    assert.equal(await mergeDatabases(db, other, 'Errors'), ERROR_FUNCTION_FAILED);
    assert.deepEqual(select(db, 'SELECT * FROM `Errors`'), [['Binary', 1]]);
});
