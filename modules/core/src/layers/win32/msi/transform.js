/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Transforms: a package's tables changed by a second, smaller file -- a
 * language, a site's settings, an instance of the product -- without the
 * package itself being touched.
 *
 * A transform is a compound file (or a storage inside a package, named
 * ":name") whose class says it is one. It has a string pool of its own, in
 * `_StringPool` and `_StringData` as a database has, and a stream for every
 * table it changes, named as that table's stream is. Unlike a table's
 * stream, a transform's is stored a row at a time, each row behind a 16-bit
 * mask that says what it does:
 *
 *   - zero: delete the row whose keys follow;
 *   - the low bit set: add a row, of as many leading columns as the high byte
 *     counts, the rest null;
 *   - otherwise: change the row whose keys follow, in the columns whose bits
 *     are set (bit n for column n, from zero), and only those values follow
 *     the keys.
 *
 * Values are as wide as in the database, but a string is a number in the
 * transform's own pool, and a stream column only says whether the row has a
 * stream: the bytes are a stream of the transform named for the row's keys,
 * as the database names it. New tables are rows added to `_Tables`, new
 * columns rows added to `_Columns` (numbered null for the columns of a new
 * table, which take their places in the order they come), and both are
 * applied before any other table so that the rows that follow have their
 * columns.
 *
 * The summary information of a transform says what it may be applied to:
 * the high word of its character count holds the validation flags the
 * installer checks against the package, the low word the error conditions it
 * suppresses when applying it; its template names the platform and language
 * it was made from, its revision number the product codes and versions it
 * goes from and to and the upgrade code.
 */

import {
    createEntry, createRoot, nameKey, parseCompoundFile, serializeCompoundFile,
} from '../ole32/cfb.js';
import { parseGuid } from '../ole32/guid.js';
import { openCompound } from './compound.js';
import {
    MSITYPE, columnWidth, decodeStreamName, encodeStreamName, encoderFor, isBinaryType, isKey,
    isStringType, readStringPool, writeStringPool,
} from './database.js';
import { insertRow } from './query.js';
import { PID, VT, readSummary } from './summary.js';

export const ERROR_SUCCESS = 0;
export const ERROR_OPEN_FAILED = 110;
export const ERROR_NO_DATA = 232;
export const ERROR_INSTALL_PACKAGE_INVALID = 1620;
export const ERROR_INSTALL_TRANSFORM_FAILURE = 1624;
export const ERROR_CREATE_FAILED = 1631;

/** The conditions MsiDatabaseApplyTransform may be told to let pass, and its view instead. */
export const MSITRANSFORM_ERROR = Object.freeze({
    ADDEXISTINGROW: 0x01, DELMISSINGROW: 0x02, ADDEXISTINGTABLE: 0x04, DELMISSINGTABLE: 0x08,
    UPDATEMISSINGROW: 0x10, CHANGECODEPAGE: 0x20, VIEWTRANSFORM: 0x100,
});

/** What a transform's summary asks to be checked against the package before it is applied. */
export const MSITRANSFORM_VALIDATE = Object.freeze({
    LANGUAGE: 0x0001, PRODUCT: 0x0002, PLATFORM: 0x0004, MAJORVERSION: 0x0008,
    MINORVERSION: 0x0010, UPDATEVERSION: 0x0020, NEWLESSBASEVERSION: 0x0040,
    NEWLESSEQUALBASEVERSION: 0x0080, NEWEQUALBASEVERSION: 0x0100,
    NEWGREATEREQUALBASEVERSION: 0x0200, NEWGREATERBASEVERSION: 0x0400, UPGRADECODE: 0x0800,
});

/** The class of a transform's root storage. */
export const CLSID_MSI_TRANSFORM = '{000C1082-0000-0000-C000-000000000046}';

/** The table MSITRANSFORM_ERROR_VIEWTRANSFORM describes a transform in. */
export const TRANSFORM_VIEW = '_TransformView';

const SUMMARY_STREAM = '\u0005SummaryInformation';
const FMTID_SUMMARY = '{F29F85E0-4FF9-1068-AB91-08002B27B3D9}';
const POOL = '_StringPool';
const POOL_DATA = '_StringData';

/** A stream column's value in a record: the row has a stream in the transform. */
const STREAM = Symbol('stream');

/**
 * @typedef {import('./database.js').Database} Database
 * @typedef {import('./database.js').Table} Table
 * @typedef {import('./database.js').Column} Column
 * @typedef {import('./database.js').Row} Row
 * @typedef {import('./compound.js').CompoundFile} CompoundFile
 * @typedef {import('./compound.js').CompoundNode} CompoundNode
 * @typedef {import('./compound.js').ByteSource} ByteSource
 * @typedef {import('./summary.js').Summary} Summary
 * @typedef {string | number | null | undefined | typeof STREAM} RecordValue
 *          undefined for a column the record does not carry.
 * @typedef {{ mask: number, values: RecordValue[] }} TransformRecord
 */

/**
 * A record of a transform being written, before the pool's size, and so the
 * width of a reference, is known.
 *
 * @typedef {{ column: Column, value: string | number | null }} PendingCell
 * @typedef {{ mask: number, cells: PendingCell[] }} PendingRecord
 */

/** A transform this code refuses: malformed, or a condition it was not told to let pass. */
class TransformFailure extends Error {}

/**
 * A transform's storage read whole, but for the tables, which are parsed
 * only once the columns they are parsed against are known.
 *
 * @typedef {Object} LoadedTransform
 * @property {(string | null)[]} strings
 * @property {number} codepage
 * @property {boolean} longRefs
 * @property {[string, Uint8Array][]} tables  In the order the storage lists them.
 * @property {Map<string, Uint8Array>} streams  Every other stream, by its decoded name.
 * @property {Summary} summary
 */

/**
 * @param {CompoundFile} file @param {CompoundNode} storage
 * @returns {Promise<LoadedTransform>}
 */
async function loadTransform(file, storage){
    /** @type {Map<string, Uint8Array>} */
    const tableBytes = new Map();
    /** @type {[string, Uint8Array][]} */
    const tables = [];
    /** @type {Map<string, Uint8Array>} */
    const streams = new Map();
    let summary = new Map();
    for (const node of storage.children.values())
    {
        if (node.kind !== 'stream')
        {
            continue;
        }
        if (node.name === SUMMARY_STREAM)
        {
            summary = readSummary(await file.readAll(node));
            continue;
        }
        if (node.name.startsWith('\u0005'))
        {
            continue;
        }
        const { name, table } = decodeStreamName(node.name);
        const bytes = await file.readAll(node);
        if (!table)
        {
            streams.set(name, bytes);
        }
        else if (name === POOL || name === POOL_DATA)
        {
            tableBytes.set(name, bytes);
        }
        else
        {
            tables.push([name, bytes]);
        }
    }
    const pool = tableBytes.get(POOL);
    if (!pool)
    {
        throw new TransformFailure('a transform without a string pool');
    }
    const { strings, codepage, longRefs } = readStringPool(pool,
        tableBytes.get(POOL_DATA) ?? new Uint8Array(0));
    return { strings, codepage, longRefs, tables, streams, summary };
}

/**
 * A transform stream's records against the columns its table has by then.
 *
 * @param {Uint8Array} bytes @param {Column[]} columns @param {(string | null)[]} strings
 * @param {boolean} longRefs @returns {TransformRecord[]}
 */
export function readTransformRecords(bytes, columns, strings, longRefs){
    /** @type {TransformRecord[]} */
    const records = [];
    for (let at = 0; at < bytes.length;)
    {
        if (at + 2 > bytes.length)
        {
            throw new TransformFailure('a record cut short');
        }
        const mask = bytes[at] | bytes[at + 1] << 8;
        at += 2;
        const adds = (mask & 1) !== 0;
        if (adds && mask >> 8 > columns.length)
        {
            throw new TransformFailure('a row of more columns than its table');
        }
        if (!adds && columns.length < 16 && mask >> columns.length !== 0)
        {
            throw new TransformFailure('a change to a column the table does not have');
        }
        /** @type {RecordValue[]} */
        const values = new Array(columns.length).fill(undefined);
        for (const [index, column] of columns.entries())
        {
            const present = adds ? index < mask >> 8
                : isKey(column) || (index < 16 && (mask & 1 << index) !== 0);
            if (!present)
            {
                continue;
            }
            const width = columnWidth(column.type, longRefs);
            if (at + width > bytes.length)
            {
                throw new TransformFailure('a record cut short');
            }
            const raw = width === 2 ? bytes[at] | bytes[at + 1] << 8
                : width === 3 ? bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16
                    : (bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16
                        | bytes[at + 3] << 24) >>> 0;
            at += width;
            if (raw === 0)
            {
                values[index] = null;
            }
            else if (isBinaryType(column.type))
            {
                values[index] = STREAM;
            }
            else if ((column.type & MSITYPE.STRING) !== 0)
            {
                values[index] = strings[raw] ?? null;
            }
            else
            {
                values[index] = width === 2 ? raw - 0x8000 : (raw ^ 0x80000000) | 0;
            }
        }
        records.push({ mask, values });
    }
    return records;
}

/** @param {Column} column @param {unknown} left @param {unknown} right */
const sameValue = (column, left, right)=>(isStringType(column.type)
    ? (left ?? '') === (right ?? '') : (left ?? null) === (right ?? null));

/**
 * What identifies a row: its keys, a string key's null and empty string being
 * one value as the pool makes them.
 *
 * @param {Column[]} columns @param {readonly unknown[]} values
 */
const keyText = (columns, values)=>columns.flatMap((column, index)=>(isKey(column)
    ? [JSON.stringify(isStringType(column.type) ? values[index] ?? '' : values[index] ?? null)]
    : [])).join('\u0000');

/**
 * The name a row's stream is stored under: the table's, then each key's.
 *
 * @param {string} table @param {Column[]} columns @param {readonly unknown[]} values
 */
const streamNameOf = (table, columns, values)=>[table, ...columns
    .map((column, index)=>(isKey(column) ? String(values[index] ?? '') : null))
    .filter(text=>text !== null)].join('.');

/** @param {unknown} value @returns {string | null} */
const textOf = value=>(value === null || value === undefined || value === '' ? null
    : String(value));

/**
 * Applies a transform's storage to a database: all of it, or -- the
 * transform refused part way -- none of it. With
 * MSITRANSFORM_ERROR_VIEWTRANSFORM nothing is applied, and the temporary
 * `_TransformView` table describes what would be: a row per value a row
 * gains or changes (its table, column, keys tab-separated, the new value and
 * the current one), and rows that say CREATE, DROP, INSERT and DELETE, and
 * for a new column its type as Data and its number as Current.
 *
 * @param {Database} db @param {CompoundFile} file @param {CompoundNode} storage
 * @param {number} [errorConditions]  MSITRANSFORM_ERROR flags.
 * @param {{ requireClass?: boolean, log?: (text: string) => void }} [options]
 *        requireClass: refuse a storage whose class is not a transform's (as
 *        MsiDatabaseApplyTransform does; true unless said otherwise).
 * @returns {Promise<number>} ERROR_SUCCESS or ERROR_INSTALL_TRANSFORM_FAILURE
 */
export async function applyTransformStorage(db, file, storage, errorConditions = 0, options = {}){
    const log = options.log ?? (()=>{});
    if (options.requireClass !== false && storage.clsid !== CLSID_MSI_TRANSFORM)
    {
        log(`${storage.name}: not a transform's storage`);
        return ERROR_INSTALL_TRANSFORM_FAILURE;
    }
    /** @type {LoadedTransform} */
    let loaded;
    try
    {
        loaded = await loadTransform(file, storage);
    }
    catch (e){
        log(`${storage.name}: ${/** @type {Error} */ (e).message}`);
        return ERROR_INSTALL_TRANSFORM_FAILURE;
    }
    try
    {
        applyLoaded(db, loaded, errorConditions);
        return ERROR_SUCCESS;
    }
    catch (e){
        if (!(e instanceof TransformFailure))
        {
            throw e;
        }
        log(`${storage.name}: ${e.message}`);
        return ERROR_INSTALL_TRANSFORM_FAILURE;
    }
}

/**
 * The work, synchronous so that nothing sees the database half changed:
 * every change is made in place with a way to undo it, and undone if the
 * transform is refused or only viewed.
 *
 * @param {Database} db @param {LoadedTransform} loaded @param {number} errorConditions
 */
function applyLoaded(db, loaded, errorConditions){
    const view = (errorConditions & MSITRANSFORM_ERROR.VIEWTRANSFORM) !== 0;
    /** @param {number} flag @param {string} what */
    const condition = (flag, what)=>{
        if (!view && (errorConditions & flag) === 0)
        {
            throw new TransformFailure(what);
        }
    };
    if (loaded.codepage !== db.codepage && loaded.codepage !== 0 && db.codepage !== 0)
    {
        condition(MSITRANSFORM_ERROR.CHANGECODEPAGE,
            `code page ${loaded.codepage} over a database of ${db.codepage}`);
    }

    /** @type {(() => void)[]} */
    const undo = [];
    /** @type {Row[]} */
    const described = [];
    /** @type {Map<string, Uint8Array | null>} */
    const streamWrites = new Map();
    const consumed = new Set();
    const writable = { ...db, readOnly: false };
    /** @type {Map<Table, Map<string, Row>>} */
    const indexes = new Map();
    /** @param {Table} table */
    const indexOf = table=>{
        let index = indexes.get(table);
        if (!index)
        {
            index = new Map(table.rows.map(row=>[keyText(table.columns, row), row]));
            indexes.set(table, index);
        }
        return index;
    };
    /** @param {string} table @param {string} column @param {string | null} row
     *  @param {string | null} data @param {string | null} current */
    const describe = (table, column, row, data, current)=>{
        described.push([table, column, row, data, current]);
    };

    /** @param {Table} table @param {Row} row */
    const addRow = (table, row)=>{
        if (insertRow(writable, table, row, false) !== ERROR_SUCCESS)
        {
            throw new TransformFailure(`a row ${table.name} cannot take`);
        }
        indexOf(table).set(keyText(table.columns, row), row);
        undo.push(()=>{
            table.rows.splice(table.rows.indexOf(row), 1);
            table.temporaryRows.delete(row);
            indexOf(table).delete(keyText(table.columns, row));
        });
    };
    /** @param {Table} table @param {Row} row */
    const removeRow = (table, row)=>{
        const at = table.rows.indexOf(row);
        const temporary = table.temporaryRows.has(row);
        table.rows.splice(at, 1);
        table.temporaryRows.delete(row);
        const key = keyText(table.columns, row);
        indexOf(table).delete(key);
        undo.push(()=>{
            table.rows.splice(at, 0, row);
            if (temporary)
            {
                table.temporaryRows.add(row);
            }
            indexOf(table).set(key, row);
        });
    };
    /** @param {Row} row @param {number} index @param {string | number | null} value */
    const setValue = (row, index, value)=>{
        const old = row[index];
        row[index] = value;
        undo.push(()=>{
            row[index] = old;
        });
    };

    const tables = /** @type {Table} */ (db.table('_Tables'));
    const columns = /** @type {Table} */ (db.table('_Columns'));
    /** Tables already there that the transform adds, where that was let pass. */
    const kept = new Set();
    /** Tables the transform drops. */
    const dropped = new Set();

    try
    {
        const byName = new Map(loaded.tables);
        const tablesBytes = byName.get('_Tables');
        for (const record of tablesBytes ? readTransformRecords(tablesBytes, tables.columns,
            loaded.strings, loaded.longRefs) : [])
        {
            const name = record.values[0];
            if (typeof name !== 'string' || name === '')
            {
                throw new TransformFailure('a table without a name');
            }
            const existing = db.tables.get(name);
            if (record.mask === 0)
            {
                if (!existing || existing.temporary || name === '_Tables' || name === '_Columns')
                {
                    condition(MSITRANSFORM_ERROR.DELMISSINGTABLE, `no table ${name} to drop`);
                    continue;
                }
                if (view)
                {
                    describe(name, 'DROP', null, null, null);
                }
                dropped.add(name);
                db.tables.delete(name);
                undo.push(()=>db.tables.set(name, existing));
                const listed = indexOf(tables).get(keyText(tables.columns, [name]));
                if (listed)
                {
                    removeRow(tables, listed);
                }
                for (const column of columns.rows.filter(row=>row[0] === name))
                {
                    removeRow(columns, column);
                }
                continue;
            }
            if ((record.mask & 1) === 0)
            {
                throw new TransformFailure(`a change to the table ${name}`);
            }
            if (existing)
            {
                condition(MSITRANSFORM_ERROR.ADDEXISTINGTABLE, `the table ${name} is there`);
                kept.add(name);
                continue;
            }
            if (view)
            {
                describe(name, 'CREATE', null, null, null);
            }
            /** @type {Table} */
            const created = { name, columns: [], rows: [], temporary: false,
                temporaryRows: new Set(), hold: 0 };
            db.tables.set(name, created);
            undo.push(()=>db.tables.delete(name));
            addRow(tables, [name]);
        }

        /** How many null-numbered columns each table has been given. */
        const counted = new Map();
        const columnsBytes = byName.get('_Columns');
        for (const record of columnsBytes ? readTransformRecords(columnsBytes, columns.columns,
            loaded.strings, loaded.longRefs) : [])
        {
            const [tableName, number, name, type] = record.values;
            if (typeof tableName !== 'string')
            {
                throw new TransformFailure('a column of no table');
            }
            if (record.mask === 0)
            {
                if (dropped.has(tableName))
                {
                    continue;
                }
                if (!db.tables.has(tableName))
                {
                    condition(MSITRANSFORM_ERROR.DELMISSINGROW, `no table ${tableName}`);
                    continue;
                }
                throw new TransformFailure(`a column of ${tableName} removed`);
            }
            if ((record.mask & 1) === 0)
            {
                throw new TransformFailure(`a column of ${tableName} changed`);
            }
            const table = db.tables.get(tableName);
            if (!table || typeof name !== 'string' || name === '' || typeof type !== 'number')
            {
                throw new TransformFailure(`a column of ${tableName} that cannot be added`);
            }
            // The columns of a new table come numbered null, and take their
            // places in the order they come.
            const place = typeof number === 'number' ? number : (counted.get(tableName) ?? 0) + 1;
            if (typeof number !== 'number')
            {
                counted.set(tableName, place);
            }
            if (place <= table.columns.length)
            {
                const same = table.columns[place - 1];
                if (!kept.has(tableName) || same.name !== name)
                {
                    condition(MSITRANSFORM_ERROR.ADDEXISTINGROW,
                        `the column ${tableName}.${place} is there`);
                }
                continue;
            }
            if (place !== table.columns.length + 1)
            {
                throw new TransformFailure(`a column of ${tableName} out of its place`);
            }
            if (view)
            {
                describe(tableName, name, null, String(type), String(place));
            }
            table.columns.push({ table: tableName, number: place, name, type: type & 0xffff });
            for (const row of table.rows)
            {
                row.push(null);
            }
            indexes.delete(table);
            undo.push(()=>{
                table.columns.pop();
                for (const row of table.rows)
                {
                    row.pop();
                }
                indexes.delete(table);
            });
            addRow(columns, [tableName, place, name, type]);
        }

        for (const [name, bytes] of loaded.tables)
        {
            if (name === '_Tables' || name === '_Columns')
            {
                continue;
            }
            const table = db.tables.get(name);
            if (!table)
            {
                // What a transform says of a table neither the database nor
                // the transform has is nothing anything can read.
                continue;
            }
            applyRows(table, readTransformRecords(bytes, table.columns, loaded.strings,
                loaded.longRefs));
        }
    }
    catch (e){
        undo.reverse().forEach(step=>step());
        throw e;
    }

    /**
     * @param {Table} table @param {TransformRecord[]} records
     */
    function applyRows(table, records){
        const keyColumns = table.columns.map((column, index)=>(isKey(column) ? index : -1))
            .filter(index=>index >= 0);
        for (const record of records)
        {
            // A stream column's value is the name of the row's stream, and
            // the transform's stream of that name its bytes.
            const streamName = streamNameOf(table.name, table.columns, record.values);
            /** @param {number} index @returns {string | number | null} */
            const valueAt = index=>{
                const value = record.values[index];
                if (value !== STREAM)
                {
                    return value ?? null;
                }
                const bytes = loaded.streams.get(streamName);
                if (!bytes)
                {
                    return null;
                }
                consumed.add(streamName);
                streamWrites.set(streamName, bytes);
                return streamName;
            };
            const rowKey = keyColumns.map(index=>textOf(record.values[index]) ?? '').join('\t');
            const existing = indexOf(table).get(keyText(table.columns, record.values)) ?? null;
            /** @param {Row} row @param {number[]} changed */
            const change = (row, changed)=>{
                for (const index of changed)
                {
                    const value = valueAt(index);
                    if (view)
                    {
                        describe(table.name, table.columns[index].name, rowKey,
                            textOf(value), textOf(row[index]));
                    }
                    if (isBinaryType(table.columns[index].type) && row[index] !== null
                        && value === null)
                    {
                        streamWrites.set(String(row[index]), null);
                    }
                    setValue(row, index, value);
                }
            };
            const nonKeys = table.columns.map((column, index)=>(isKey(column) ? -1 : index))
                .filter(index=>index >= 0);
            if (record.mask === 0)
            {
                if (!existing)
                {
                    condition(MSITRANSFORM_ERROR.DELMISSINGROW,
                        `no row ${rowKey} in ${table.name}`);
                    continue;
                }
                if (view)
                {
                    describe(table.name, 'DELETE', rowKey, null, null);
                }
                removeRow(table, existing);
                table.columns.forEach((column, index)=>{
                    if (isBinaryType(column.type) && existing[index] !== null)
                    {
                        streamWrites.set(String(existing[index]), null);
                    }
                });
                continue;
            }
            if ((record.mask & 1) !== 0)
            {
                if (existing)
                {
                    condition(MSITRANSFORM_ERROR.ADDEXISTINGROW,
                        `the row ${rowKey} is in ${table.name}`);
                    change(existing, nonKeys);
                    continue;
                }
                const row = table.columns.map((_, index)=>valueAt(index));
                if (view)
                {
                    for (const index of nonKeys)
                    {
                        describe(table.name, table.columns[index].name, rowKey,
                            textOf(row[index]), null);
                    }
                    describe(table.name, 'INSERT', rowKey, null, null);
                }
                addRow(table, row);
                continue;
            }
            const changed = nonKeys.filter(index=>index < 16 && (record.mask & 1 << index) !== 0);
            if (!existing)
            {
                condition(MSITRANSFORM_ERROR.UPDATEMISSINGROW,
                    `no row ${rowKey} in ${table.name} to change`);
                if (view)
                {
                    for (const index of changed)
                    {
                        describe(table.name, table.columns[index].name, rowKey,
                            textOf(valueAt(index)), null);
                    }
                    describe(table.name, 'INSERT', rowKey, null, null);
                }
                continue;
            }
            change(existing, changed);
        }
    }

    if (view)
    {
        undo.reverse().forEach(step=>step());
        recordView(db, described);
        return;
    }
    for (const [name, bytes] of streamWrites)
    {
        db.writeStream(name, bytes);
    }
    // The rest of the transform's streams are there for what reads them by
    // name; the package's own are not replaced by them.
    for (const [name, bytes] of loaded.streams)
    {
        if (!consumed.has(name) && !db.hasStream(name))
        {
            db.writeStream(name, bytes);
        }
    }
    if (loaded.codepage !== 0)
    {
        db.codepage = loaded.codepage;
    }
}

/**
 * The rows of `_TransformView`, the table made (or held once more) for them.
 *
 * @param {Database} db @param {Row[]} rows
 */
function recordView(db, rows){
    let table = db.table(TRANSFORM_VIEW);
    if (table)
    {
        table.hold++;
    }
    else
    {
        const string = MSITYPE.STRING | 0x0400 | MSITYPE.TEMPORARY;
        table = {
            name: TRANSFORM_VIEW,
            columns: /** @type {[string, number][]} */ ([
                ['Table', string | MSITYPE.KEY], ['Column', string | MSITYPE.KEY],
                ['Row', string | MSITYPE.KEY | MSITYPE.NULLABLE],
                ['Data', string | MSITYPE.NULLABLE], ['Current', string | MSITYPE.NULLABLE],
            ]).map(([name, type], index)=>({ table: TRANSFORM_VIEW, number: index + 1, name,
                type })),
            rows: [], temporary: true, temporaryRows: new Set(), hold: 1,
        };
        db.tables.set(TRANSFORM_VIEW, table);
    }
    const writable = { ...db, readOnly: false };
    for (const row of rows)
    {
        // A second description of one value is one row.
        insertRow(writable, table, row, true);
    }
}

/**
 * MsiDatabaseApplyTransform's work: a transform named ":storage" in the
 * database's own file, or a file the caller opens.
 *
 * @param {Database} db @param {string} name
 * @param {number} errorConditions
 * @param {(path: string) => ByteSource | null | Promise<ByteSource | null>} openFile
 *        The file at a path as the caller resolves it; null if there is none.
 * @param {(text: string) => void} [log]
 * @returns {Promise<number>} ERROR_SUCCESS, ERROR_OPEN_FAILED when the
 *          storage is not there or is no compound file, or
 *          ERROR_INSTALL_TRANSFORM_FAILURE
 */
export async function applyTransform(db, name, errorConditions, openFile, log){
    const opened = await openTransform(db, name, openFile);
    if (!opened)
    {
        log?.(`${name}: no transform there`);
        return ERROR_OPEN_FAILED;
    }
    return applyTransformStorage(db, opened.file, opened.storage, errorConditions, { log });
}

/**
 * A transform's storage: ":name" for one the package embeds, anything else a
 * path for `openFile`.
 *
 * @param {Database} db @param {string} name
 * @param {(path: string) => ByteSource | null | Promise<ByteSource | null>} openFile
 * @returns {Promise<{ file: CompoundFile, storage: CompoundNode } | null>}
 */
export async function openTransform(db, name, openFile){
    if (name.startsWith(':'))
    {
        const file = db.compound ?? null;
        const storage = file?.root.children.get(nameKey(name.slice(1)));
        return file && storage?.kind === 'storage' ? { file, storage } : null;
    }
    const source = await openFile(name);
    if (!source)
    {
        return null;
    }
    try
    {
        const file = await openCompound(source);
        return { file, storage: file.root };
    }
    catch {
        return null;
    }
}

// ----- validation ------------------------------------------------------------

/**
 * A transform's summary, as what it says it applies to.
 *
 * @typedef {Object} TransformDescription
 * @property {string} platform        From its template, "Intel;1033".
 * @property {number} language        0 for none.
 * @property {string} productFrom     The product code it was made against.
 * @property {string} versionFrom
 * @property {string} productTo
 * @property {string} versionTo
 * @property {string} upgradeCode
 * @property {number} validation      MSITRANSFORM_VALIDATE flags.
 * @property {number} errorConditions MSITRANSFORM_ERROR flags it suppresses.
 */

/**
 * @param {Summary} summary @returns {TransformDescription}
 */
export function describeTransform(summary){
    const text = (/** @type {number} */ pid)=>{
        const value = summary.get(pid)?.value;
        return typeof value === 'string' ? value : '';
    };
    const [platform, languages = ''] = text(PID.TEMPLATE).split(';');
    const language = Number.parseInt(languages, 10);
    // "{product}version;{product}version;{upgrade code}"
    const match = /^(\{[^}]*\})([^;]*);(\{[^}]*\})([^;]*);(\{[^}]*\})?/.exec(text(PID.REVNUMBER));
    const flags = Number(summary.get(PID.CHARCOUNT)?.value ?? 0) >>> 0;
    return {
        platform, language: Number.isNaN(language) ? 0 : language,
        productFrom: match?.[1] ?? '', versionFrom: match?.[2] ?? '',
        productTo: match?.[3] ?? '', versionTo: match?.[4] ?? '', upgradeCode: match?.[5] ?? '',
        validation: flags >>> 16, errorConditions: flags & 0xffff,
    };
}

/**
 * A version's leading fields as numbers; a missing one is 0.
 *
 * @param {string} version @param {number} count
 */
const versionFields = (version, count)=>Array.from({ length: count },
    (_, index)=>Number.parseInt(version.split('.')[index] ?? '0', 10) || 0);

/**
 * Whether a transform may be applied to a package, as its summary's
 * validation flags ask: the package's language among those its template
 * lists, its product and upgrade codes the transform's base ones, its
 * version against the base version in as many fields as the flags name
 * (major; major and minor; major, minor and update -- the fewest named wins)
 * and in the relation they name, equality when they name none. The platform
 * is not checked: Windows does not check it.
 *
 * @param {Database} db
 * @param {Summary} summary  The transform's.
 * @param {(name: string) => string | null} [property]
 *        The package's properties; its Property table when not given.
 * @returns {{ code: number, failed: number }} ERROR_SUCCESS with failed 0
 *          when it applies; ERROR_INSTALL_PACKAGE_INVALID when the package
 *          lacks a property a flag compares; else ERROR_INSTALL_TRANSFORM_FAILURE
 *          and the flags that failed.
 */
export function checkTransform(db, summary, property = propertyOf(db)){
    const description = describeTransform(summary);
    const wanted = description.validation & ~MSITRANSFORM_VALIDATE.PLATFORM;
    let failed = 0;
    /** @param {string} name */
    const required = name=>{
        const value = property(name);
        return value === null || value === '' ? null : value;
    };
    const sameCode = (/** @type {string} */ left, /** @type {string} */ right)=>
        left.toUpperCase() === right.toUpperCase();

    if ((wanted & MSITRANSFORM_VALIDATE.LANGUAGE) !== 0 && description.language !== 0)
    {
        const template = readSummary(db.summaryStream()).get(PID.TEMPLATE)?.value;
        const languages = (typeof template === 'string' ? template.split(';')[1] ?? '' : '')
            .split(',').map(text=>Number.parseInt(text, 10)).filter(id=>id > 0);
        if (languages.length > 0 && !languages.includes(description.language))
        {
            failed |= MSITRANSFORM_VALIDATE.LANGUAGE;
        }
    }
    for (const [flag, name, expected] of /** @type {[number, string, string][]} */ ([
        [MSITRANSFORM_VALIDATE.PRODUCT, 'ProductCode', description.productFrom],
        [MSITRANSFORM_VALIDATE.UPGRADECODE, 'UpgradeCode', description.upgradeCode]]))
    {
        if ((wanted & flag) === 0)
        {
            continue;
        }
        const value = required(name);
        if (value === null)
        {
            return { code: ERROR_INSTALL_PACKAGE_INVALID, failed: flag };
        }
        if (!sameCode(value, expected))
        {
            failed |= flag;
        }
    }
    const fields = (wanted & MSITRANSFORM_VALIDATE.MAJORVERSION) !== 0 ? 1
        : (wanted & MSITRANSFORM_VALIDATE.MINORVERSION) !== 0 ? 2
            : (wanted & MSITRANSFORM_VALIDATE.UPDATEVERSION) !== 0 ? 3 : 0;
    if (fields > 0)
    {
        const flag = fields === 1 ? MSITRANSFORM_VALIDATE.MAJORVERSION
            : fields === 2 ? MSITRANSFORM_VALIDATE.MINORVERSION
                : MSITRANSFORM_VALIDATE.UPDATEVERSION;
        const version = required('ProductVersion');
        if (version === null)
        {
            return { code: ERROR_INSTALL_PACKAGE_INVALID, failed: flag };
        }
        const mine = versionFields(version, fields);
        const base = versionFields(description.versionFrom, fields);
        const order = mine.reduce((found, field, index)=>found
            || Math.sign(field - base[index]), 0);
        /** @type {[number, boolean][]} */
        const relations = [
            [MSITRANSFORM_VALIDATE.NEWLESSBASEVERSION, order < 0],
            [MSITRANSFORM_VALIDATE.NEWLESSEQUALBASEVERSION, order <= 0],
            [MSITRANSFORM_VALIDATE.NEWEQUALBASEVERSION, order === 0],
            [MSITRANSFORM_VALIDATE.NEWGREATEREQUALBASEVERSION, order >= 0],
            [MSITRANSFORM_VALIDATE.NEWGREATERBASEVERSION, order > 0],
        ];
        const named = relations.filter(([relation])=>(wanted & relation) !== 0);
        const holds = named.length === 0 ? order === 0 : named.some(([, result])=>result);
        if (!holds)
        {
            failed |= flag;
        }
    }
    return failed === 0 ? { code: ERROR_SUCCESS, failed: 0 }
        : { code: ERROR_INSTALL_TRANSFORM_FAILURE, failed };
}

/**
 * A property out of the database's Property table.
 *
 * @param {Database} db @returns {(name: string) => string | null}
 */
const propertyOf = db=>name=>{
    const row = db.table('Property')?.rows.find(entry=>entry[0] === name);
    return row && row[1] !== null ? String(row[1]) : null;
};

// ----- the TRANSFORMS property ----------------------------------------------

/**
 * Where an entry of TRANSFORMS is: ":name" a storage of the package; a path
 * behind "@" (secured, at the source) or "|" (secured, a full path) the same
 * file as without it; a relative path in the package's folder.
 *
 * @param {string} entry @param {string} packagePath
 * @returns {{ storage: string } | { path: string }}
 */
export function locateTransform(entry, packagePath){
    if (entry.startsWith(':'))
    {
        return { storage: entry.slice(1) };
    }
    const path = entry.startsWith('@') || entry.startsWith('|') ? entry.slice(1) : entry;
    if (/^[A-Za-z]:[\\/]/.test(path) || /^[\\/]/.test(path))
    {
        return { path };
    }
    return { path: packagePath.slice(0, packagePath.lastIndexOf('\\') + 1) + path };
}

/**
 * Applies the transforms a TRANSFORMS property lists, in order, to the
 * database a session is opening: each checked against the package as its
 * summary asks and left out if it does not apply, each applied with the
 * error conditions its summary suppresses.
 *
 * @param {Database} db @param {string} list
 * @param {{ packagePath: string,
 *           openFile: (path: string) => ByteSource | null | Promise<ByteSource | null>,
 *           property?: (name: string) => string | null,
 *           log?: (text: string) => void }} options
 * @returns {Promise<{ code: number, applied: string[], skipped: string[] }>}
 *          ERROR_INSTALL_TRANSFORM_FAILURE for one that is not there or does
 *          not apply cleanly, which stops the list there
 */
export async function applyTransformList(db, list, options){
    const log = options.log ?? (()=>{});
    /** @type {string[]} */
    const applied = [];
    /** @type {string[]} */
    const skipped = [];
    for (const entry of list.split(';'))
    {
        if (entry.trim() === '')
        {
            continue;
        }
        const place = locateTransform(entry, options.packagePath);
        const opened = await openTransform(db, 'storage' in place ? `:${place.storage}`
            : place.path, options.openFile);
        if (!opened)
        {
            log(`${entry}: the transform is not there`);
            return { code: ERROR_INSTALL_TRANSFORM_FAILURE, applied, skipped };
        }
        const summaryNode = opened.storage.children.get(nameKey(SUMMARY_STREAM));
        const summary = summaryNode ? readSummary(await opened.file.readAll(summaryNode))
            : new Map();
        const check = checkTransform(db, summary, options.property);
        if (check.code !== ERROR_SUCCESS)
        {
            log(`${entry}: does not apply to this package (validation 0x${
                check.failed.toString(16)})`);
            skipped.push(entry);
            continue;
        }
        const conditions = describeTransform(summary).errorConditions
            & ~MSITRANSFORM_ERROR.VIEWTRANSFORM;
        // A package's own storage is a transform by being named one; a
        // file has to say so by its class.
        const code = await applyTransformStorage(db, opened.file, opened.storage, conditions,
            { requireClass: !('storage' in place), log });
        if (code !== ERROR_SUCCESS)
        {
            return { code, applied, skipped };
        }
        applied.push(entry);
    }
    return { code: ERROR_SUCCESS, applied, skipped };
}

// ----- generating a transform ------------------------------------------------

/**
 * A table as it would be saved: neither temporary nor its temporary rows and
 * columns.
 *
 * @param {Table} table
 */
const persistentPart = table=>{
    const columns = table.columns.filter(column=>(column.type & MSITYPE.TEMPORARY) === 0);
    const rows = table.rows.filter(row=>!table.temporaryRows.has(row))
        .map(row=>row.slice(0, columns.length));
    return { columns, rows };
};

/** @param {Database} db */
const persistentTables = db=>new Map([...db.tables].filter(([name, table])=>!table.temporary
    && name !== '_Tables' && name !== '_Columns'));

/** @param {Uint8Array | null} left @param {Uint8Array | null} right */
const sameBytes = (left, right)=>left === right || (left !== null && right !== null
    && left.length === right.length && left.every((byte, index)=>byte === right[index]));

/**
 * MsiDatabaseGenerateTransform's work: the transform that makes `reference`
 * into `db`. Rows are matched by their keys; a row only in `reference` is
 * deleted, a row only in `db` added, a row in both changed in the columns
 * that differ -- or, where one of those columns is past the sixteen a mask
 * can name, deleted and added whole. A table's columns may only grow: one
 * whose columns were changed or removed has no transform.
 *
 * @param {Database} db @param {Database} reference
 * @returns {Promise<{ code: number, bytes: Uint8Array | null }>}
 *          ERROR_NO_DATA when the two are the same; ERROR_INSTALL_TRANSFORM_FAILURE
 *          when the difference is not one a transform can carry
 */
export async function generateTransform(db, reference){
    /** @type {(string | null)[]} */
    const strings = [null];
    /** @type {number[]} */
    const refs = [0];
    /** @type {Map<string, number>} */
    const ids = new Map();
    /** @param {string | null} text */
    const stringRef = text=>{
        if (text === null || text === '')
        {
            return 0;
        }
        let id = ids.get(text);
        if (id === undefined)
        {
            id = strings.length;
            ids.set(text, id);
            strings.push(text);
            refs.push(0);
        }
        refs[id]++;
        return id;
    };

    /** @type {Map<string, PendingRecord[]>} */
    const streams = new Map();
    /** @type {Map<string, Uint8Array>} */
    const payloads = new Map();
    /** @param {string} table @param {PendingRecord} record */
    const emit = (table, record)=>{
        for (const cell of record.cells)
        {
            if (typeof cell.value === 'string' && !isBinaryType(cell.column.type))
            {
                stringRef(cell.value);
            }
        }
        const list = streams.get(table) ?? [];
        list.push(record);
        streams.set(table, list);
    };
    /** @param {Column[]} columns @param {string | number | null} value @param {number} index */
    const cell = (columns, value, index)=>({ column: columns[index], value });

    const tablesColumns = /** @type {Table} */ (db.table('_Tables')).columns;
    const columnsColumns = /** @type {Table} */ (db.table('_Columns')).columns;
    const mine = persistentTables(db);
    const theirs = persistentTables(reference);

    for (const name of theirs.keys())
    {
        if (!mine.has(name))
        {
            emit('_Tables', { mask: 0, cells: [cell(tablesColumns, name, 0)] });
        }
    }
    for (const [name, table] of mine)
    {
        const { columns, rows } = persistentPart(table);
        const before = theirs.get(name);
        const old = before ? persistentPart(before) : null;
        if (!old)
        {
            emit('_Tables', { mask: 0x0101, cells: [cell(tablesColumns, name, 0)] });
        }
        const oldColumns = old?.columns ?? [];
        if (oldColumns.some((column, index)=>columns[index]?.name !== column.name
            || ((columns[index].type ^ column.type) & 0xffff & ~MSITYPE.TEMPORARY) !== 0))
        {
            return { code: ERROR_INSTALL_TRANSFORM_FAILURE, bytes: null };
        }
        if (columns.slice(oldColumns.length).some(isKey) && old)
        {
            return { code: ERROR_INSTALL_TRANSFORM_FAILURE, bytes: null };
        }
        for (let index = oldColumns.length; index < columns.length; index++)
        {
            const column = columns[index];
            // A new table's columns go numbered null, as Windows writes them.
            emit('_Columns', { mask: 0x0401, cells: [
                cell(columnsColumns, name, 0), cell(columnsColumns, old ? index + 1 : null, 1),
                cell(columnsColumns, column.name, 2),
                cell(columnsColumns, column.type & 0xffff & ~MSITYPE.TEMPORARY, 3)] });
        }

        const keys = columns.map((column, index)=>(isKey(column) ? index : -1))
            .filter(index=>index >= 0);
        /** @type {Map<string, Row>} */
        const oldRows = new Map((old?.rows ?? []).map(row=>[keyText(columns, row), row]));
        const newKeys = new Set(rows.map(row=>keyText(columns, row)));
        /** @param {Row} row */
        const keyCells = row=>keys.map(index=>cell(columns, row[index], index));
        /** @param {Row} row */
        const add = async row=>{
            emit(name, { mask: 1 | columns.length << 8,
                cells: row.map((value, index)=>cell(columns, value, index)) });
            for (const [index, column] of columns.entries())
            {
                if (isBinaryType(column.type) && row[index] !== null)
                {
                    payloads.set(streamNameOf(name, columns, row),
                        await db.readStream(String(row[index])) ?? new Uint8Array(0));
                }
            }
        };
        for (const [key, row] of oldRows)
        {
            if (!newKeys.has(key))
            {
                emit(name, { mask: 0, cells: keyCells(row) });
            }
        }
        for (const row of rows)
        {
            const was = oldRows.get(keyText(columns, row));
            if (!was)
            {
                await add(row);
                continue;
            }
            /** @type {number[]} */
            const changed = [];
            for (const [index, column] of columns.entries())
            {
                if (isKey(column))
                {
                    continue;
                }
                const then = index < oldColumns.length ? was[index] : null;
                const now = row[index];
                const differs = isBinaryType(column.type)
                    ? (then === null) !== (now === null) || (now !== null && !sameBytes(
                        await reference.readStream(String(then)), await db.readStream(String(now))))
                    : !sameValue(column, then, now);
                if (differs)
                {
                    changed.push(index);
                }
            }
            if (changed.length === 0)
            {
                continue;
            }
            if (changed.some(index=>index >= 16))
            {
                emit(name, { mask: 0, cells: keyCells(row) });
                await add(row);
                continue;
            }
            emit(name, { mask: changed.reduce((mask, index)=>mask | 1 << index, 0),
                cells: columns.flatMap((column, index)=>(isKey(column) || changed.includes(index)
                    ? [cell(columns, row[index], index)] : [])) });
            for (const index of changed)
            {
                if (isBinaryType(columns[index].type) && row[index] !== null)
                {
                    payloads.set(streamNameOf(name, columns, row),
                        await db.readStream(String(row[index])) ?? new Uint8Array(0));
                }
            }
        }
    }

    if (streams.size === 0 && db.codepage === reference.codepage)
    {
        return { code: ERROR_NO_DATA, bytes: null };
    }
    const { pool, data, longRefs } = writeStringPool(strings, refs, db.codepage);
    const root = createRoot();
    root.clsid = CLSID_MSI_TRANSFORM;
    /** @param {string | null} packed @param {Uint8Array} bytes */
    const put = (packed, bytes)=>{
        if (packed === null)
        {
            return false;
        }
        const entry = createEntry(packed, 'stream');
        entry.data = bytes;
        root.children.set(nameKey(packed), entry);
        return true;
    };
    put(encodeStreamName(POOL, true), pool);
    put(encodeStreamName(POOL_DATA, true), data);
    for (const [table, records] of streams)
    {
        if (!put(encodeStreamName(table, true), encodeRecords(records, ids, longRefs)))
        {
            return { code: ERROR_INSTALL_TRANSFORM_FAILURE, bytes: null };
        }
    }
    for (const [name, bytes] of payloads)
    {
        if (!put(encodeStreamName(name, false), bytes))
        {
            return { code: ERROR_INSTALL_TRANSFORM_FAILURE, bytes: null };
        }
    }
    return { code: ERROR_SUCCESS, bytes: serializeCompoundFile(root) };
}

/**
 * Records as a transform stores them: the mask, then each value carried, as
 * wide as its column.
 *
 * @param {PendingRecord[]} records
 * @param {Map<string, number>} ids @param {boolean} longRefs
 */
function encodeRecords(records, ids, longRefs){
    /** @type {number[]} */
    const out = [];
    for (const { mask, cells } of records)
    {
        out.push(mask & 0xff, mask >>> 8 & 0xff);
        for (const { column, value } of cells)
        {
            const width = columnWidth(column.type, longRefs);
            const raw = value === null ? 0 : isBinaryType(column.type) ? 1
                : (column.type & MSITYPE.STRING) !== 0 ? ids.get(String(value)) ?? 0
                    : width === 2 ? Number(value) + 0x8000 & 0xffff
                        : (Number(value) ^ 0x80000000) >>> 0;
            for (let byte = 0; byte < width; byte++)
            {
                out.push(raw >>> byte * 8 & 0xff);
            }
        }
    }
    return Uint8Array.from(out);
}

// ----- a transform's summary -------------------------------------------------

/**
 * The summary MsiCreateTransformSummaryInfo gives a transform from `db` (the
 * database after it) against `reference` (the one it applies to): the
 * reference's platform and language as its template, the new database's as
 * its last author, both product codes and versions and the upgrade code as
 * its revision number, the greater schema as its page count, and the
 * validation flags and error conditions as the two words of its character
 * count.
 *
 * @param {Database} db @param {Database} reference
 * @param {number} errorConditions @param {number} validation
 * @returns {Summary}
 */
export function transformSummary(db, reference, errorConditions, validation){
    const mine = readSummary(db.summaryStream());
    const theirs = readSummary(reference.summaryStream());
    const property = propertyOf(db);
    const referenceProperty = propertyOf(reference);
    /**
     * @param {Summary} summary @param {(name: string) => string | null} lookup
     */
    const platformAndLanguage = (summary, lookup)=>{
        const template = summary.get(PID.TEMPLATE)?.value;
        const [platform = '', languages = ''] = typeof template === 'string'
            ? template.split(';') : [];
        const language = lookup('ProductLanguage') ?? languages.split(',')[0] ?? '';
        return `${platform};${language}`;
    };
    /** @type {Summary} */
    const summary = new Map();
    const codepage = mine.get(PID.CODEPAGE) ?? theirs.get(PID.CODEPAGE);
    if (codepage)
    {
        summary.set(PID.CODEPAGE, codepage);
    }
    summary.set(PID.TITLE, { type: VT.LPSTR, value: 'Transform' });
    summary.set(PID.TEMPLATE, { type: VT.LPSTR,
        value: platformAndLanguage(theirs, referenceProperty) });
    summary.set(PID.LASTAUTHOR, { type: VT.LPSTR, value: platformAndLanguage(mine, property) });
    const upgrade = referenceProperty('UpgradeCode') ?? property('UpgradeCode') ?? '';
    summary.set(PID.REVNUMBER, { type: VT.LPSTR, value:
        `${referenceProperty('ProductCode') ?? ''}${referenceProperty('ProductVersion') ?? ''};`
        + `${property('ProductCode') ?? ''}${property('ProductVersion') ?? ''};${upgrade}` });
    const schema = Math.max(Number(mine.get(PID.PAGECOUNT)?.value ?? 0),
        Number(theirs.get(PID.PAGECOUNT)?.value ?? 0));
    if (schema > 0)
    {
        summary.set(PID.PAGECOUNT, { type: VT.I4, value: schema });
    }
    summary.set(PID.CHARCOUNT, { type: VT.I4,
        value: ((validation & 0xffff) << 16 | errorConditions & 0xffff) | 0 });
    return summary;
}

/**
 * A summary as a property set stream: one section, the code page first, each
 * value on a four-byte boundary.
 *
 * @param {Summary} summary @returns {Uint8Array}
 */
export function writeSummaryStream(summary){
    const codepage = Number(summary.get(PID.CODEPAGE)?.value ?? 0) & 0xffff;
    const encode = encoderFor(codepage);
    const entries = [...summary].sort(([left], [right])=>left - right);
    /** @type {Uint8Array[]} */
    const values = entries.map(([, { type, value }])=>{
        if (type === VT.LPSTR)
        {
            const text = encode(String(value));
            const out = new Uint8Array(8 + (text.length + 1 + 3 & ~3));
            const view = new DataView(out.buffer);
            view.setUint16(0, type, true);
            view.setUint32(4, text.length + 1, true);
            out.set(text, 8);
            return out;
        }
        const out = new Uint8Array(type === VT.FILETIME ? 12 : 8);
        const view = new DataView(out.buffer);
        view.setUint16(0, type, true);
        if (type === VT.I2)
        {
            view.setInt16(4, Number(value), true);
        }
        else if (type === VT.I4)
        {
            view.setInt32(4, Number(value), true);
        }
        else if (type === VT.FILETIME)
        {
            view.setBigUint64(4, BigInt(value), true);
        }
        return out;
    });
    const headerSize = 48;
    const tableSize = 8 + entries.length * 8;
    const size = tableSize + values.reduce((sum, bytes)=>sum + bytes.length, 0);
    const out = new Uint8Array(headerSize + size);
    const view = new DataView(out.buffer);
    view.setUint16(0, 0xfffe, true);
    // The system that wrote it: Windows, version 6.
    view.setUint32(4, 0x00020006, true);
    view.setUint32(24, 1, true);
    out.set(/** @type {Uint8Array} */ (parseGuid(FMTID_SUMMARY)), 28);
    view.setUint32(44, headerSize, true);
    view.setUint32(headerSize, size, true);
    view.setUint32(headerSize + 4, entries.length, true);
    let at = tableSize;
    entries.forEach(([pid], index)=>{
        view.setUint32(headerSize + 8 + index * 8, pid, true);
        view.setUint32(headerSize + 12 + index * 8, at, true);
        out.set(values[index], headerSize + at);
        at += values[index].length;
    });
    return out;
}

/**
 * MsiCreateTransformSummaryInfo's work: a transform file with the summary
 * `transformSummary` makes, in place of any it had.
 *
 * @param {Uint8Array} file  The transform as MsiDatabaseGenerateTransform wrote it.
 * @param {Database} db @param {Database} reference
 * @param {number} errorConditions @param {number} validation
 * @returns {{ code: number, bytes: Uint8Array | null }} ERROR_OPEN_FAILED when
 *          the file is not a compound file
 */
export function createTransformSummary(file, db, reference, errorConditions, validation){
    const root = parseCompoundFile(file);
    if (!root)
    {
        return { code: ERROR_OPEN_FAILED, bytes: null };
    }
    const entry = createEntry(SUMMARY_STREAM, 'stream');
    entry.data = writeSummaryStream(transformSummary(db, reference, errorConditions, validation));
    root.children.set(nameKey(SUMMARY_STREAM), entry);
    return { code: ERROR_SUCCESS, bytes: serializeCompoundFile(root) };
}
