/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoot, nameKey, serializeCompoundFile } from '../ole32/cfb.js';
import { bytesSource, openCompound } from './compound.js';
import {
    createEmptyDatabase, encodeStreamName, encoderFor, decoderFor, openDatabase, readStringPool,
    writeStringPool,
} from './database.js';
import { columnInfo, insertRow, openView } from './query.js';
import { PID, VT, readSummary } from './summary.js';
import {
    ERROR_INSTALL_PACKAGE_INVALID, ERROR_INSTALL_TRANSFORM_FAILURE, ERROR_NO_DATA,
    ERROR_OPEN_FAILED, ERROR_SUCCESS, MSITRANSFORM_ERROR, MSITRANSFORM_VALIDATE, TRANSFORM_VIEW,
    applyTransform, applyTransformList, checkTransform, createTransformSummary, generateTransform,
    locateTransform, transformSummary, writeSummaryStream,
} from './transform.js';
import {
    ascii, openFile, run, select, storageOf, transformFile, wineDatabase, wineTransform, words,
} from './transform.fixture.js';

/**
 * A file opener over named byte arrays, as a host's would be.
 *
 * @param {Record<string, Uint8Array>} files
 */
const opener = files=>(/** @type {string} */ path)=>(path in files ? bytesSource(files[path])
    : null);

/** @param {string} name @param {boolean} table */
const packed = (name, table)=>/** @type {string} */ (encodeStreamName(name, table));

/**
 * A transform of the streams given by name: the tables' marked as tables.
 *
 * @param {(string | null)[]} strings  From number 1.
 * @param {Record<string, number[]>} tables  Each as 16-bit words.
 * @param {{ codepage?: number, streams?: Record<string, Uint8Array>, summary?: Uint8Array,
 *           clsid?: string }} [options]
 */
const transformOf = (strings, tables, options = {})=>{
    const codepage = options.codepage ?? 0;
    /** @type {number[]} */
    const pool = [codepage & 0xffff, codepage >>> 16];
    for (const text of strings)
    {
        pool.push(text?.length ?? 0, text ? 1 : 0);
    }
    /** @type {[string, Uint8Array][]} */
    const streams = [
        [packed('_StringPool', true), words(pool)],
        [packed('_StringData', true), ascii(strings.join(''))],
        ...Object.entries(tables).map(([name, values])=>/** @type {[string, Uint8Array]} */ (
            [packed(name, true), words(values)])),
        ...Object.entries(options.streams ?? {}).map(([name, data])=>
            /** @type {[string, Uint8Array]} */ ([packed(name, false), data])),
    ];
    if (options.summary)
    {
        streams.push(['\u0005SummaryInformation', options.summary]);
    }
    return transformFile(streams, { clsid: options.clsid });
};

/** A database with a table T (K string key, V short) of rows a=1 and b=2. */
const smallDatabase = ()=>{
    const db = createEmptyDatabase();
    run(db, [
        'CREATE TABLE `T` ( `K` CHAR(16) NOT NULL, `V` SHORT PRIMARY KEY `K`)',
        'INSERT INTO `T` ( `K`, `V` ) VALUES ( \'a\', 1 )',
        'INSERT INTO `T` ( `K`, `V` ) VALUES ( \'b\', 2 )',
    ]);
    return db;
};

/** @param {import('./database.js').Database} db @param {Uint8Array} bytes @param {number} flags */
const apply = (db, bytes, flags)=>applyTransform(db, 'x.mst', flags, opener({ 'x.mst': bytes }));

test('Wine\'s transform, viewed: _TransformView says what it would do and changes nothing',
    async()=>{
        const db = wineDatabase();
        const before = JSON.stringify(select(db, 'SELECT * FROM `MOO`'));
        assert.equal(await apply(db, transformFile(wineTransform()),
            MSITRANSFORM_ERROR.VIEWTRANSFORM), ERROR_SUCCESS);
        assert.equal(JSON.stringify(select(db, 'SELECT * FROM `MOO`')), before);
        assert.equal(db.table('AAR'), null, 'no table made');

        const opened = openView(db, 'SELECT * FROM `_TransformView`');
        assert.ok('view' in opened);
        const rows = select(db, 'SELECT * FROM `_TransformView`')
            .map(row=>row.map(value=>value ?? '').join('|')).sort();
        assert.deepEqual(rows, [
            'AAR|BAR||1282|2', 'AAR|BAR|bmw|2|', 'AAR|BAR|vw|1|', 'AAR|CAR||15871|1',
            'AAR|CREATE|||', 'AAR|INSERT|bmw||', 'AAR|INSERT|vw||',
            'BINARY|BLOB|1|BINARY.1|', 'BINARY|INSERT|1||',
            'MOO|COW||5378|3', 'MOO|DELETE|3||', 'MOO|OOO|1|c|a', 'MOO|PIG|1|5|', 'MOO|PIG||5378|4',
            'Property|CREATE|||', 'Property|INSERT|prop||', 'Property|Property||11592|1',
            'Property|Value|prop|val|', 'Property|Value||7424|2',
        ].sort());
        const view = /** @type {import('./database.js').Table} */ (db.table(TRANSFORM_VIEW));
        assert.deepEqual(view.columns.map(column=>column.name),
            ['Table', 'Column', 'Row', 'Data', 'Current']);
        const info = columnInfo(view.columns.map((column, index)=>({ table: 0, index, column })),
            [view], 'types');
        assert.deepEqual(info.fields.slice(1), ['g0', 'g0', 'G0', 'G0', 'G0']);

        // Held once: one FREE drops it.
        run(db, ['ALTER TABLE `_TransformView` FREE']);
        assert.equal(db.table(TRANSFORM_VIEW), null);
    });

test('Wine\'s transform, applied: rows added, changed and deleted, a table, columns, a stream',
    async()=>{
        const db = wineDatabase();
        assert.equal(await apply(db, transformFile(wineTransform()), 0), ERROR_SUCCESS);
        assert.deepEqual(select(db, 'SELECT * FROM `MOO`'),
            [[1, 'c', null, 5], [2, 'b', null, null]]);
        assert.deepEqual(/** @type {any} */ (db.table('MOO')).columns.slice(2).map((
            /** @type {any} */ column)=>[column.number, column.name, column.type]),
        [[3, 'COW', 0x1502], [4, 'PIG', 0x1502]]);
        assert.deepEqual(select(db, 'SELECT `CAR`, `BAR` FROM `AAR`'), [['vw', 1], ['bmw', 2]]);
        assert.deepEqual(/** @type {any} */ (db.table('AAR')).columns.map((
            /** @type {any} */ column)=>column.name), ['CAR', 'BAR']);
        assert.deepEqual(select(db, 'SELECT * FROM `Property`'), [['prop', 'val']]);
        assert.deepEqual(/** @type {any} */ (db.table('BINARY')).rows,
            [[1, 'BINARY.1'], [2, 'BINARY.2']]);
        assert.deepEqual(await db.readStream('BINARY.1'), ascii('naengmyon'));
        assert.deepEqual(await db.readStream('BINARY.2'), ascii('lamyon'), 'the old one stays');
        assert.ok(select(db, 'SELECT `Name` FROM `_Tables`').some(([name])=>name === 'AAR'));
        assert.ok(select(db, 'SELECT `Table`, `Number`, `Name` FROM `_Columns`')
            .some(([table, number, name])=>table === 'MOO' && number === 4 && name === 'PIG'));
    });

test('a transform is applied whole or not at all, and each condition can be let pass',
    async()=>{
        const strings = ['T', 'a', 'z', 'K', 'V'];
        /** @type {[string, number[], number][]} */
        const cases = [
            // An added row that is there.
            ['add existing row', [0x0201, 2, 0x8009], MSITRANSFORM_ERROR.ADDEXISTINGROW],
            // A deleted row that is not.
            ['delete missing row', [0x0000, 3], MSITRANSFORM_ERROR.DELMISSINGROW],
            // A changed row that is not.
            ['update missing row', [0x0002, 3, 0x8007], MSITRANSFORM_ERROR.UPDATEMISSINGROW],
        ];
        for (const [what, row, flag] of cases)
        {
            const db = smallDatabase();
            // A good change to row b first: when the transform is refused, it
            // goes with it.
            const file = transformOf([...strings, 'b'],
                { T: [0x0002, 6, 0x8063, ...row] });
            assert.equal(await apply(db, file, 0), ERROR_INSTALL_TRANSFORM_FAILURE, what);
            assert.deepEqual(select(db, 'SELECT * FROM `T`'), [['a', 1], ['b', 2]],
                `${what}: nothing changed`);
            assert.equal(await apply(db, file, flag), ERROR_SUCCESS, `${what} let pass`);
            assert.equal(select(db, 'SELECT `V` FROM `T` WHERE `K` = \'b\'')[0][0], 99, what);
        }
        const db = smallDatabase();
        assert.equal(await apply(db, transformOf(strings, { T: [0x0201, 2, 0x8009] }),
            MSITRANSFORM_ERROR.ADDEXISTINGROW), ERROR_SUCCESS);
        assert.deepEqual(select(db, 'SELECT * FROM `T`'), [['a', 9], ['b', 2]],
            'an added row that was let pass replaces the one there');
    });

test('tables added that are there and dropped that are not, and a code page changed',
    async()=>{
        const db = smallDatabase();
        const adds = transformOf(['T', 'K', 'V'], {
            _Tables: [0x0101, 1],
            _Columns: [0x0401, 1, 0, 2, 0xad10, 0x0401, 1, 0, 3, 0x8502],
        });
        assert.equal(await apply(db, adds, 0), ERROR_INSTALL_TRANSFORM_FAILURE);
        assert.equal(await apply(db, adds, MSITRANSFORM_ERROR.ADDEXISTINGTABLE), ERROR_SUCCESS);
        assert.equal(/** @type {any} */ (db.table('T')).columns.length, 2, 'the columns it has');

        const drops = transformOf(['Gone'], { _Tables: [0x0000, 1] });
        assert.equal(await apply(db, drops, 0), ERROR_INSTALL_TRANSFORM_FAILURE);
        assert.equal(await apply(db, drops, MSITRANSFORM_ERROR.DELMISSINGTABLE), ERROR_SUCCESS);

        const dropT = transformOf(['T'], { _Tables: [0x0000, 1] });
        assert.equal(await apply(db, dropT, 0), ERROR_SUCCESS);
        assert.equal(db.table('T'), null);
        assert.ok(!select(db, 'SELECT `Name` FROM `_Tables`').some(([name])=>name === 'T'));

        const other = createEmptyDatabase();
        other.codepage = 1252;
        const cyrillic = transformOf([], {}, { codepage: 1251 });
        assert.equal(await apply(other, cyrillic, 0), ERROR_INSTALL_TRANSFORM_FAILURE);
        assert.equal(await apply(other, cyrillic, MSITRANSFORM_ERROR.CHANGECODEPAGE),
            ERROR_SUCCESS);
        assert.equal(other.codepage, 1251);
        const neutral = createEmptyDatabase();
        assert.equal(await apply(neutral, cyrillic, 0), ERROR_SUCCESS, 'a neutral page takes it');
        assert.equal(neutral.codepage, 1251);
    });

test('a transform\'s strings are read in its own code page', async()=>{
    const db = smallDatabase();
    db.codepage = 1251;
    const word = 'Привет';
    const data = encoderFor(1251)(word);
    assert.equal(decoderFor(1251)(data), word);
    const strings = transformFile([
        [packed('_StringPool', true), words([1251, 0, data.length, 1])],
        [packed('_StringData', true), data],
        [packed('T', true), words([0x0201, 1, 0x8005])],
    ]);
    assert.equal(await apply(db, strings, 0), ERROR_SUCCESS);
    assert.deepEqual(select(db, `SELECT \`V\` FROM \`T\` WHERE \`K\` = '${word}'`), [[5]]);
});

test('a binary column changed or emptied: the stream goes with the row', async()=>{
    const db = wineDatabase();
    // BINARY row 2's stream replaced, then a transform that deletes the row.
    const replace = transformOf(['BINARY'], { BINARY: [0x0002, 0x8002, 0x0001] },
        { streams: { 'BINARY.2': ascii('naengmyon') } });
    assert.equal(await apply(db, replace, 0), ERROR_SUCCESS);
    assert.deepEqual(await db.readStream('BINARY.2'), ascii('naengmyon'));
    const remove = transformOf([], { BINARY: [0x0000, 0x8002] });
    assert.equal(await apply(db, remove, 0), ERROR_SUCCESS);
    assert.deepEqual(/** @type {any} */ (db.table('BINARY')).rows, []);
    assert.equal(db.hasStream('BINARY.2'), false);
});

test('what is not a transform, or not there, is refused with the documented codes', async()=>{
    const db = smallDatabase();
    assert.equal(await applyTransform(db, 'missing.mst', 0, opener({})), ERROR_OPEN_FAILED);
    assert.equal(await apply(db, new Uint8Array(1024), 0), ERROR_OPEN_FAILED);
    assert.equal(await apply(db, transformOf([], {}, {
        clsid: '{00000000-0000-0000-0000-000000000000}' }), 0), ERROR_INSTALL_TRANSFORM_FAILURE,
    'a docfile that is not a transform');
    assert.equal(await apply(db, transformFile([]), 0), ERROR_INSTALL_TRANSFORM_FAILURE,
        'no string pool');
    assert.equal(await apply(db, transformOf(['T'], { T: [0x0201] }), 0),
        ERROR_INSTALL_TRANSFORM_FAILURE, 'a record cut short');
    assert.equal(await apply(db, transformOf(['T'], { T: [0x0301, 1, 0x8001, 1] }), 0),
        ERROR_INSTALL_TRANSFORM_FAILURE, 'more columns than the table has');
    assert.equal(await applyTransform(db, ':embedded', 0, opener({})), ERROR_OPEN_FAILED,
        'a database made in memory embeds nothing');
});

/**
 * Summary bytes with a template, a revision number and a character count.
 *
 * @param {string} template @param {string} revision @param {number} validation
 * @param {number} [conditions]
 */
const summaryOf = (template, revision, validation, conditions = 0)=>writeSummaryStream(new Map([
    [PID.TEMPLATE, { type: VT.LPSTR, value: template }],
    [PID.REVNUMBER, { type: VT.LPSTR, value: revision }],
    [PID.CHARCOUNT, { type: VT.I4, value: (validation << 16 | conditions) | 0 }],
]));

const PRODUCT = '{11111111-2222-3333-4444-555555555555}';
const UPGRADE = '{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}';

/** A package with a summary and the properties a transform is checked against. */
const packageDatabase = ()=>{
    const db = createEmptyDatabase();
    const insert = (/** @type {string} */ name, /** @type {string} */ value)=>
        `INSERT INTO \`Property\` ( \`Property\`, \`Value\` ) VALUES ( '${name}', '${value}' )`;
    run(db, [
        'CREATE TABLE `Property` ( `Property` CHAR(72) NOT NULL, `Value` CHAR(0) '
            + 'PRIMARY KEY `Property`)',
        insert('ProductCode', PRODUCT), insert('ProductVersion', '2.5.100'),
        insert('UpgradeCode', UPGRADE), insert('ProductLanguage', '1033'),
    ]);
    const summary = writeSummaryStream(new Map([
        [PID.TEMPLATE, { type: VT.LPSTR, value: 'Intel;1033,1031' }]]));
    db.summaryStream = ()=>summary;
    return db;
};

test('validation: language, product, upgrade code and version as the flags ask', ()=>{
    const db = packageDatabase();
    const revision = (/** @type {string} */ version, product = PRODUCT, upgrade = UPGRADE)=>
        `${product}${version};${product}${version};${upgrade}`;
    const V = MSITRANSFORM_VALIDATE;
    /** @type {[string, string, string, number, boolean][]} */
    const cases = [
        ['nothing asked', 'Intel;1049', revision('1.0'), 0, true],
        ['a language the package lists', 'Intel;1031', revision('1.0'), V.LANGUAGE, true],
        ['one it does not', 'Intel;1049', revision('1.0'), V.LANGUAGE, false],
        ['a neutral transform', 'Intel;0', revision('1.0'), V.LANGUAGE, true],
        ['the platform is not checked', 'x64;1033', revision('1.0'), V.PLATFORM, true],
        ['the product', ';1033', revision('1.0', PRODUCT.toLowerCase()), V.PRODUCT, true],
        ['another product', ';1033', revision('1.0', '{0}'), V.PRODUCT, false],
        ['the upgrade code', ';1033', revision('1.0'), V.UPGRADECODE, true],
        ['another', ';1033', revision('1.0', PRODUCT, '{0}'), V.UPGRADECODE, false],
        ['major equal', ';1033', revision('2.0.0'), V.MAJORVERSION, true],
        ['major differs', ';1033', revision('3.5.100'), V.MAJORVERSION, false],
        ['minor equal', ';1033', revision('2.5.7'), V.MINORVERSION, true],
        ['minor differs', ';1033', revision('2.4.100'), V.MINORVERSION, false],
        ['update equal', ';1033', revision('2.5.100'), V.UPDATEVERSION, true],
        ['update differs', ';1033', revision('2.5.101'), V.UPDATEVERSION, false],
        ['major wins over minor', ';1033', revision('2.9'), V.MAJORVERSION | V.MINORVERSION, true],
        ['newer than base', ';1033', revision('2.5.99'),
            V.UPDATEVERSION | V.NEWGREATERBASEVERSION, true],
        ['not newer', ';1033', revision('2.5.100'), V.UPDATEVERSION | V.NEWGREATERBASEVERSION,
            false],
        ['less or equal', ';1033', revision('2.6'), V.MINORVERSION | V.NEWLESSEQUALBASEVERSION,
            true],
        ['less', ';1033', revision('2.5'), V.MINORVERSION | V.NEWLESSBASEVERSION, false],
        ['greater or equal', ';1033', revision('2.5'),
            V.MINORVERSION | V.NEWGREATEREQUALBASEVERSION, true],
    ];
    for (const [what, template, rev, flags, applies] of cases)
    {
        const result = checkTransform(db, readSummary(summaryOf(template, rev, flags)));
        assert.equal(result.code === ERROR_SUCCESS, applies, what);
        if (!applies)
        {
            assert.equal(result.code, ERROR_INSTALL_TRANSFORM_FAILURE, what);
            assert.notEqual(result.failed, 0, what);
        }
    }
    const bare = createEmptyDatabase();
    assert.equal(checkTransform(bare, readSummary(summaryOf(';1033', revision('1.0'),
        V.PRODUCT))).code, ERROR_INSTALL_PACKAGE_INVALID, 'no ProductCode to compare');
    assert.equal(checkTransform(db, readSummary(summaryOf(';1033', revision('1.0'), V.PRODUCT)),
        name=>(name === 'ProductCode' ? '{0}' : null)).code, ERROR_INSTALL_TRANSFORM_FAILURE,
    'the session\'s properties when it gives them');
});

test('TRANSFORMS: paths beside the package, secured prefixes, embedded storages', ()=>{
    const pkg = 'C:\\Setup\\product.msi';
    assert.deepEqual(locateTransform('lang.mst', pkg), { path: 'C:\\Setup\\lang.mst' });
    assert.deepEqual(locateTransform('sub\\a.mst', pkg), { path: 'C:\\Setup\\sub\\a.mst' });
    assert.deepEqual(locateTransform('D:\\x.mst', pkg), { path: 'D:\\x.mst' });
    assert.deepEqual(locateTransform('\\\\server\\share\\x.mst', pkg),
        { path: '\\\\server\\share\\x.mst' });
    assert.deepEqual(locateTransform('@lang.mst', pkg), { path: 'C:\\Setup\\lang.mst' });
    assert.deepEqual(locateTransform('|D:\\Secure\\x.mst', pkg), { path: 'D:\\Secure\\x.mst' });
    assert.deepEqual(locateTransform(':1031', pkg), { storage: '1031' });
});

test('TRANSFORMS applies each in order, leaves out one that does not apply, stops at one '
    + 'that is not there', async()=>{
    // A package file that embeds a German transform as the storage "1031".
    const german = storageOf([
        [packed('_StringPool', true), words([0, 0, 1, 1])],
        [packed('_StringData', true), ascii('a')],
        [packed('T', true), words([0x0002, 1, 0x8000 + 49])],
        ['\u0005SummaryInformation', summaryOf('Intel;1031', '', MSITRANSFORM_VALIDATE.LANGUAGE)],
    ], { name: '1031' });
    const root = createRoot();
    root.children.set(nameKey('1031'), german);
    const db = await openDatabase(await openCompound(bytesSource(serializeCompoundFile(root))));
    run(db, [
        'CREATE TABLE `T` ( `K` CHAR(16) NOT NULL, `V` SHORT PRIMARY KEY `K`)',
        'INSERT INTO `T` ( `K`, `V` ) VALUES ( \'a\', 1 )',
    ]);
    const template = writeSummaryStream(new Map([
        [PID.TEMPLATE, { type: VT.LPSTR, value: 'Intel;1033,1031' }]]));
    db.summaryStream = ()=>template;

    const french = transformOf(['a'], { T: [0x0002, 1, 0x8000 + 36] }, {
        summary: summaryOf('Intel;1036', '', MSITRANSFORM_VALIDATE.LANGUAGE) });
    const site = transformOf(['a'], { T: [0x0201, 1, 0x8000 + 7] }, {
        summary: summaryOf('', '', 0, MSITRANSFORM_ERROR.ADDEXISTINGROW) });
    const files = { 'C:\\Setup\\fr.mst': french, 'D:\\site.mst': site };
    const result = await applyTransformList(db, ':1031;fr.mst;|D:\\site.mst',
        { packagePath: 'C:\\Setup\\product.msi', openFile: opener(files) });
    assert.deepEqual(result, { code: ERROR_SUCCESS, applied: [':1031', '|D:\\site.mst'],
        skipped: ['fr.mst'] });
    assert.deepEqual(select(db, 'SELECT * FROM `T`'), [['a', 7]],
        'German first, then the site transform\'s row over it, as its summary lets pass');

    const missing = await applyTransformList(db, 'none.mst;|D:\\site.mst',
        { packagePath: 'C:\\Setup\\product.msi', openFile: opener(files) });
    assert.equal(missing.code, ERROR_INSTALL_TRANSFORM_FAILURE);
    assert.deepEqual(missing.applied, []);
});

/** The two databases of Wine's generate_transform: a reference, and it changed. */
const changedPair = ()=>{
    const reference = wineDatabase();
    const db = wineDatabase();
    run(db, [
        'CREATE TABLE `AAR` ( `BAR` SHORT NOT NULL, `CAR` CHAR(255) PRIMARY KEY `CAR`)',
        'INSERT INTO `AAR` ( `BAR`, `CAR` ) VALUES ( 1, \'vw\' )',
        'INSERT INTO `AAR` ( `BAR`, `CAR` ) VALUES ( 2, \'bmw\' )',
        'UPDATE `MOO` SET `OOO` = \'c\' WHERE `NOO` = 1',
        'DELETE FROM `MOO` WHERE `NOO` = 3',
        'ALTER TABLE `MOO` ADD `COW` INTEGER',
        'ALTER TABLE `MOO` ADD `PIG` INTEGER',
        'UPDATE `MOO` SET `PIG` = 5 WHERE `NOO` = 1',
        'CREATE TABLE `Property` ( `Property` CHAR(72) NOT NULL, `Value` CHAR(0) '
            + 'PRIMARY KEY `Property`)',
        'INSERT INTO `Property` ( `Property`, `Value` ) VALUES ( \'prop\', \'val\' )',
    ]);
    insertRow(db, /** @type {any} */ (db.table('BINARY')), [1, 'BINARY.1'], false);
    db.writeStream('BINARY.1', ascii('naengmyon'));
    return { db, reference };
};

/** @param {import('./database.js').Database} db */
const contents = async db=>{
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [name, table] of db.tables)
    {
        if (name !== '_Tables' && name !== '_Columns')
        {
            out[name] = { columns: table.columns.map(column=>[column.name, column.type]),
                rows: table.rows };
        }
    }
    out.streams = await Promise.all(db.streamNames().sort().map(async name=>
        [name, [...(await db.readStream(name)) ?? []]]));
    return out;
};

test('a generated transform makes the reference into the database it was made from', async()=>{
    const { db, reference } = changedPair();
    assert.deepEqual(await generateTransform(reference, wineDatabase()),
        { code: ERROR_NO_DATA, bytes: null }, 'two databases the same');
    const generated = await generateTransform(db, reference);
    assert.equal(generated.code, ERROR_SUCCESS);
    const bytes = /** @type {Uint8Array} */ (generated.bytes);
    const file = await openFile(bytes);
    assert.equal(file.root.clsid, '{000C1082-0000-0000-C000-000000000046}');
    assert.equal(await apply(reference, bytes, 0), ERROR_SUCCESS);
    assert.deepEqual(await contents(reference), await contents(db));

    // The MOO stream, word for word: row 3 deleted, row 1's OOO and PIG changed.
    const pool = readStringPool(
        await file.readAll(/** @type {any} */ (file.root.children.get(nameKey(
            packed('_StringPool', true))))),
        await file.readAll(/** @type {any} */ (file.root.children.get(nameKey(
            packed('_StringData', true))))));
    const moo = await file.readAll(/** @type {any} */ (file.root.children.get(nameKey(
        packed('MOO', true)))));
    const id = pool.strings.indexOf('c');
    assert.deepEqual(moo, words([0x0000, 0x8003, 0x000a, 0x8001, id, 0x8005]));
    const columns = await file.readAll(/** @type {any} */ (file.root.children.get(nameKey(
        packed('_Columns', true)))));
    const at = (/** @type {string} */ text)=>pool.strings.indexOf(text);
    const type = (/** @type {string} */ table, /** @type {number} */ index)=>
        0x8000 + /** @type {any} */ (db.table(table)).columns[index].type;
    assert.deepEqual(columns, words([
        0x0401, at('MOO'), 0x8003, at('COW'), type('MOO', 2),
        0x0401, at('MOO'), 0x8004, at('PIG'), type('MOO', 3),
        0x0401, at('AAR'), 0x0000, at('BAR'), type('AAR', 0),
        0x0401, at('AAR'), 0x0000, at('CAR'), type('AAR', 1),
        0x0401, at('Property'), 0x0000, at('Property'), type('Property', 0),
        0x0401, at('Property'), 0x0000, at('Value'), type('Property', 1),
    ]));
    assert.deepEqual(await file.readAll(/** @type {any} */ (file.root.children.get(nameKey(
        packed('BINARY.1', false))))), ascii('naengmyon'));
});

test('a change past the sixteenth column goes as a delete and an add', async()=>{
    const names = Array.from({ length: 18 }, (_, index)=>`C${index}`);
    const make = ()=>{
        const db = createEmptyDatabase();
        run(db, [`CREATE TABLE \`W\` ( ${names.map(name=>`\`${name}\` SHORT`).join(', ')} `
            + 'PRIMARY KEY `C0`)',
        `INSERT INTO \`W\` ( ${names.map(name=>`\`${name}\``).join(', ')} ) VALUES ( ${
            names.map((_, index)=>index).join(', ')} )`]);
        return db;
    };
    const reference = make();
    const db = make();
    run(db, ['UPDATE `W` SET `C17` = 99, `C3` = 33 WHERE `C0` = 0']);
    const { code, bytes } = await generateTransform(db, reference);
    assert.equal(code, ERROR_SUCCESS);
    const file = await openFile(/** @type {Uint8Array} */ (bytes));
    const w = await file.readAll(/** @type {any} */ (file.root.children.get(nameKey(
        packed('W', true)))));
    assert.deepEqual([...w.subarray(0, 4)], [0, 0, 0, 0x80], 'a delete of row 0 first');
    assert.deepEqual([...w.subarray(4, 6)], [0x01, 18], 'then the row, all eighteen columns');
    assert.equal(await apply(reference, /** @type {Uint8Array} */ (bytes), 0), ERROR_SUCCESS);
    assert.deepEqual(await contents(reference), await contents(db));
});

test('a table whose columns changed has no transform', async()=>{
    const reference = smallDatabase();
    const db = createEmptyDatabase();
    run(db, ['CREATE TABLE `T` ( `K` CHAR(16) NOT NULL, `V` LONG PRIMARY KEY `K`)']);
    assert.equal((await generateTransform(db, reference)).code, ERROR_INSTALL_TRANSFORM_FAILURE);
});

test('a transform\'s summary: template, revision, schema, flags', async()=>{
    const reference = packageDatabase();
    const db = packageDatabase();
    run(db, ['UPDATE `Property` SET `Value` = \'2.6.0\' WHERE `Property` = \'ProductVersion\'',
        'UPDATE `Property` SET `Value` = \'1031\' WHERE `Property` = \'ProductLanguage\'']);
    const summary = transformSummary(db, reference, MSITRANSFORM_ERROR.ADDEXISTINGROW,
        MSITRANSFORM_VALIDATE.PRODUCT | MSITRANSFORM_VALIDATE.LANGUAGE);
    assert.equal(summary.get(PID.TEMPLATE)?.value, 'Intel;1033');
    assert.equal(summary.get(PID.LASTAUTHOR)?.value, 'Intel;1031');
    assert.equal(summary.get(PID.REVNUMBER)?.value,
        `${PRODUCT}2.5.100;${PRODUCT}2.6.0;${UPGRADE}`);
    assert.equal(summary.get(PID.CHARCOUNT)?.value, 0x00030001);

    const { bytes } = await generateTransform(db, reference);
    const written = createTransformSummary(/** @type {Uint8Array} */ (bytes), db, reference,
        MSITRANSFORM_ERROR.ADDEXISTINGROW, MSITRANSFORM_VALIDATE.PRODUCT);
    assert.equal(written.code, ERROR_SUCCESS);
    const file = await openFile(/** @type {Uint8Array} */ (written.bytes));
    const read = readSummary(await file.readAll(/** @type {any} */ (
        file.root.children.get(nameKey('\u0005SummaryInformation')))));
    assert.deepEqual([...read.entries()], [...transformSummary(db, reference,
        MSITRANSFORM_ERROR.ADDEXISTINGROW, MSITRANSFORM_VALIDATE.PRODUCT).entries()]);
    assert.equal(checkTransform(reference, read).code, ERROR_SUCCESS,
        'it applies to the package it was made against');
    assert.equal(createTransformSummary(new Uint8Array(10), db, reference, 0, 0).code,
        ERROR_OPEN_FAILED);
});

test('the string pool writes back what it reads, long strings and all', ()=>{
    const long = 'x'.repeat(0x10005);
    const strings = [null, 'ab', null, long, 'y'];
    const { pool, data, longRefs } = writeStringPool(strings, [0, 2, 0, 1, 3], 1252);
    assert.equal(longRefs, false);
    assert.deepEqual(readStringPool(pool, data),
        { strings, codepage: 1252, longRefs: false });
    assert.deepEqual([...pool.subarray(0, 12)], [0xe4, 0x04, 0, 0, 2, 0, 2, 0, 0, 0, 0, 0]);
    const many = [null, ...Array.from({ length: 0x10000 }, (_, index)=>`s${index}`)];
    assert.equal(writeStringPool(many, [], 65001).longRefs, true);
    // Shift-JIS, which the Encoding standard knows by its own name.
    const japanese = '日本語';
    assert.equal(decoderFor(932)(encoderFor(932)(japanese)), japanese);
    assert.deepEqual([...encoderFor(1251)('Яz€')], [0xdf, 0x7a, 0x88]);
    assert.deepEqual([...encoderFor(1252)('\u4e00')], [0x3f], 'what the page lacks is "?"');
});

test('a pool that says three-byte references makes every string in a record three bytes',
    async()=>{
        const db = smallDatabase();
        const file = transformFile([
            // Code page 0, the top bit of the high word set; then "c".
            [packed('_StringPool', true), words([0, 0x8000, 1, 1])],
            [packed('_StringData', true), ascii('c')],
            [packed('T', true), Uint8Array.from([0x01, 0x02, 0x01, 0x00, 0x00, 0x03, 0x80])],
        ]);
        assert.equal(await apply(db, file, 0), ERROR_SUCCESS);
        assert.deepEqual(select(db, 'SELECT * FROM `T`'), [['a', 1], ['b', 2], ['c', 3]]);
    });
