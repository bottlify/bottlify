/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Installer databases as text, and one database merged into another:
 * MsiDatabaseExport, MsiDatabaseImport and MsiDatabaseMerge.
 *
 * A table in text is an archive file (.idt): a line of column names, a line
 * of their types, a line of the table's name and its key columns, then a line
 * per row, every field ended by a tab or the line's end and every line by
 * CR LF. A type is a letter and a size: s for a string, l for one that is
 * localized, i for an integer, v for a stream, upper case where the column
 * may be null. A field cannot hold the characters that frame it, so a
 * carriage return is written as 0x11, a line feed as 0x19 and a tab as 0x10.
 * A stream is not in the text at all: its field names a file in a folder
 * beside the archive, named for the archive without its extension, where its
 * bytes are.
 *
 * Two tables are not tables. `_ForceCodepage` is the database's code page,
 * on a third line after two empty ones; `_SummaryInformation` is its summary
 * stream, a row for each property, a date written "yyyy/mm/dd hh:mm:ss".
 *
 * Merging copies every table of one database into another: a table the
 * other lacks is created, rows it lacks are added and rows it has as they are
 * left alone. A table of the same name must have the same columns -- names,
 * types, keys -- or nothing is merged. A row whose keys the base already has
 * with other data is a conflict: the table it is in is counted into an error
 * table and not merged, and the merge fails, though every table without one
 * is merged.
 */

import {
    decoderFor, encoderFor, isBinaryType, isKey, isStringType, persistentPart, persistentTables,
    rowStreamName,
} from './database.js';
import { columnInfo, insertRow } from './query.js';
import { SqlError, parseStatement } from './sql.js';
import { PID_TYPES, VT, readSummary } from './summary.js';
import { writeSummaryStream } from './transform.js';

export const ERROR_SUCCESS = 0;
export const ERROR_BAD_PATHNAME = 161;
export const ERROR_BAD_QUERY_SYNTAX = 1615;
export const ERROR_FUNCTION_FAILED = 1627;
export const ERROR_DATATYPE_MISMATCH = 1629;

const FORCE_CODEPAGE = '_ForceCodepage';
const SUMMARY_TABLE = '_SummaryInformation';
/** The extension a stream's file is given when a table is written out. */
const STREAM_EXTENSION = '.ibd';
/** Tables the database describes itself with, which an archive cannot replace. */
const SYSTEM_TABLES = new Set(['_Tables', '_Columns', '_Streams', '_Storages']);

/**
 * The code pages a database may be forced to: the ones Windows converts.
 * Anything else is refused rather than kept as a number nothing can decode.
 */
const CODEPAGES = new Set([0, 37, 437, 500, 708, 720, 737, 775, 850, 852, 855, 857, 858, 860, 861,
    862, 863, 864, 865, 866, 869, 870, 874, 875, 932, 936, 949, 950, 1026, 1047, 1250, 1251,
    1252, 1253, 1254, 1255, 1256, 1257, 1258, 1361, 10000, 10001, 10002, 10003, 10004, 10005,
    10006, 10007, 10008, 10010, 10017, 10021, 10029, 10079, 10081, 10082, 20127, 20866, 21866,
    28591, 28592, 28593, 28594, 28595, 28596, 28597, 28598, 28599, 28603, 28605, 65000, 65001]);

/** The characters a field cannot hold, and what stands for each in the text. */
const ESCAPES = /** @type {const} */ ([['\t', '\u0010'], ['\r', '\u0011'], ['\n', '\u0019']]);

/**
 * @typedef {import('./database.js').Database} Database
 * @typedef {import('./database.js').Table} Table
 * @typedef {import('./database.js').Column} Column
 * @typedef {import('./database.js').Row} Row
 *
 * A stream's file, by its path under the folder the archive is in.
 *
 * @typedef {{ path: string, bytes: Uint8Array }} ArchiveStream
 *
 * @typedef {Object} ArchiveExport
 * @property {number} code
 * @property {string} text      The archive as text.
 * @property {Uint8Array} bytes  The archive's file: the text in the database's code page.
 * @property {ArchiveStream[]} streams
 */

/** @param {string} text */
const escapeField = text=>ESCAPES.reduce((out, [plain, code])=>out.replaceAll(plain, code), text);

/**
 * The inverse of `escapeField`; a NUL, which a field cannot hold either,
 * reads as a line feed.
 *
 * @param {string} text
 */
const unescapeField = text=>ESCAPES.reduce((out, [plain, code])=>out.replaceAll(code, plain),
    text.replaceAll('\u0000', '\n'));

/** @param {string[][]} lines */
const joinLines = lines=>lines.map(fields=>`${fields.join('\t')}\r\n`).join('');

/**
 * A FILETIME as an archive writes a date, in the time it holds.
 *
 * @param {bigint} filetime
 */
function formatDate(filetime){
    const date = new Date(Number(filetime / 10000n) - 11644473600000);
    /** @param {number} value @param {number} width */
    const pad = (value, width = 2)=>String(value).padStart(width, '0');
    return `${pad(date.getUTCFullYear(), 4)}/${pad(date.getUTCMonth() + 1)}/`
        + `${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:`
        + `${pad(date.getUTCSeconds())}`;
}

/**
 * The inverse of `formatDate`.
 *
 * @param {string} text @returns {bigint | null}
 */
function parseDate(text){
    const match = /^(\d{1,4})\/(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{1,2}):(\d{1,2})$/
        .exec(text.trim());
    if (!match)
    {
        return null;
    }
    const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
    const ms = Date.UTC(year, month - 1, day, hour, minute, second);
    return Number.isNaN(ms) ? null : (BigInt(ms) + 11644473600000n) * 10000n;
}

/**
 * A table's column types as MsiViewGetColumnInfo spells them: "s72", "I4".
 *
 * @param {Table} table @returns {string[]}
 */
const typesOf = table=>/** @type {string[]} */ (columnInfo(table.columns.map((column, index)=>
    ({ table: 0, index, column })), [table], 'types').fields.slice(1));

/** @param {Column[]} columns */
const keyNames = columns=>columns.filter(isKey).map(column=>column.name);

/**
 * The file a row's streams are written to: its keys and the extension.
 *
 * @param {Column[]} columns @param {Row} row
 */
const streamFileName = (columns, row)=>`${columns.flatMap((column, index)=>
    (isKey(column) ? [String(row[index] ?? '')] : [])).join('.')}${STREAM_EXTENSION}`;

/**
 * MsiDatabaseExport's work: a table as an archive file, and the files of its
 * streams under a folder named for the table.
 *
 * @param {Database} db @param {string} tableName
 * @returns {Promise<ArchiveExport>} ERROR_BAD_QUERY_SYNTAX for a table that is not there
 */
export async function exportTable(db, tableName){
    /** @type {ArchiveStream[]} */
    const streams = [];
    /** @param {string} text @returns {ArchiveExport} */
    const done = text=>({ code: ERROR_SUCCESS, text, bytes: encoderFor(db.codepage)(text),
        streams });
    if (tableName === FORCE_CODEPAGE)
    {
        return done(`\r\n\r\n${db.codepage}\t${FORCE_CODEPAGE}\r\n`);
    }
    if (tableName === SUMMARY_TABLE)
    {
        const summary = [...readSummary(db.summaryStream())].sort(([left], [right])=>left - right);
        return done(joinLines([
            ['PropertyId', 'Value'], ['i2', 'l255'], [SUMMARY_TABLE, 'PropertyId'],
            ...summary.map(([pid, { type, value }])=>[String(pid), type === VT.FILETIME
                ? formatDate(BigInt(value)) : escapeField(String(value))]),
        ]));
    }
    const table = db.table(tableName);
    if (!table)
    {
        return { code: ERROR_BAD_QUERY_SYNTAX, text: '', bytes: new Uint8Array(0), streams };
    }
    /** @type {string[][]} */
    const lines = [
        table.columns.map(column=>column.name), typesOf(table),
        [table.name, ...keyNames(table.columns)],
    ];
    for (const row of table.rows)
    {
        /** @type {string[]} */
        const fields = [];
        for (const [index, column] of table.columns.entries())
        {
            const value = row[index] ?? null;
            if (value === null)
            {
                fields.push('');
                continue;
            }
            if (!isBinaryType(column.type))
            {
                fields.push(escapeField(String(value)));
                continue;
            }
            const bytes = await db.readStream(String(value));
            if (!bytes)
            {
                fields.push('');
                continue;
            }
            const file = streamFileName(table.columns, row);
            streams.push({ path: `${table.name}\\${file}`, bytes });
            fields.push(escapeField(file));
        }
        lines.push(fields);
    }
    return done(joinLines(lines));
}

/**
 * The folder an archive's streams are read from, under the archive's own
 * folder: the archive's name without its extension. Null for a name without
 * one, whose streams cannot be found.
 *
 * @param {string} file
 */
export function streamFolder(file){
    const dot = file.lastIndexOf('.');
    return dot > Math.max(file.lastIndexOf('\\'), file.lastIndexOf('/')) ? file.slice(0, dot)
        : null;
}

/**
 * An archive's lines as fields: a line ends at a line feed, with any carriage
 * returns before it; the empty lines after the last are not lines.
 *
 * @param {string} text @returns {string[][]}
 */
function archiveLines(text){
    const lines = text.split('\n').map(line=>line.replace(/\r+$/, ''));
    while (lines.length > 3 && lines[lines.length - 1] === '')
    {
        lines.pop();
    }
    return lines.map(line=>line.split('\t'));
}

/**
 * Columns out of an archive's names, types and keys, as CREATE TABLE would
 * make them: the type letters spelled as the SQL they stand for and the
 * statement's own reading of it used, so a column imported is the column a
 * program would have created. Null for a type that is not one.
 *
 * @param {string} table @param {string[]} names @param {string[]} types @param {string[]} keys
 * @returns {Column[] | null}
 */
function columnsOf(table, names, types, keys){
    const quoted = [table, ...names, ...keys];
    if (quoted.some(name=>name === '' || name.includes('`')) || keys.length === 0
        || new Set(names).size !== names.length)
    {
        return null;
    }
    /** @type {string[]} */
    const definitions = [];
    for (const [index, type] of types.entries())
    {
        const match = /^([sSlLiIvV])(\d+)$/.exec(type);
        if (!match)
        {
            return null;
        }
        const letter = match[1].toLowerCase();
        const size = Number(match[2]);
        let sql;
        if (letter === 's' || letter === 'l')
        {
            if (size > 255)
            {
                return null;
            }
            sql = size === 0 ? 'LONGCHAR' : `CHAR(${size})`;
        }
        else if (letter === 'i')
        {
            if (size > 4 || size === 3)
            {
                return null;
            }
            sql = size === 4 ? 'LONG' : 'SHORT';
        }
        else
        {
            sql = 'OBJECT';
        }
        const nullable = match[1] !== letter;
        definitions.push(`\`${names[index]}\` ${sql}${nullable ? '' : ' NOT NULL'}`
            + `${letter === 'l' ? ' LOCALIZABLE' : ''}`);
    }
    try
    {
        const statement = parseStatement(`CREATE TABLE \`${table}\` ( ${definitions.join(', ')} `
            + `PRIMARY KEY ${keys.map(key=>`\`${key}\``).join(', ')} )`);
        return statement.kind === 'create' ? statement.columns.map((column, index)=>({
            table, number: index + 1, name: column.name, type: column.type,
        })) : null;
    }
    catch (e){
        if (e instanceof SqlError)
        {
            return null;
        }
        throw e;
    }
}

/**
 * A table made part of a database, in place of any of its name: described in
 * `_Tables` and `_Columns` as one made by CREATE TABLE is when it is saved.
 *
 * @param {Database} db @param {Table} table
 */
function putTable(db, table){
    dropTable(db, table.name);
    db.tables.set(table.name, table);
    const tables = db.table('_Tables');
    const columns = db.table('_Columns');
    if (tables)
    {
        insertRow(db, tables, [table.name], false);
    }
    if (columns)
    {
        table.columns.forEach((column, index)=>insertRow(db, columns,
            [table.name, index + 1, column.name, column.type], false));
    }
}

/** @param {Database} db @param {string} name */
function dropTable(db, name){
    db.tables.delete(name);
    for (const system of ['_Tables', '_Columns'])
    {
        const table = db.table(system);
        if (table)
        {
            table.rows = table.rows.filter(row=>row[0] !== name);
        }
    }
}

/**
 * @param {string} name @param {Column[]} columns @returns {Table}
 */
const emptyTable = (name, columns)=>({
    name, columns, rows: [], temporary: false, temporaryRows: new Set(), hold: 0,
});

/**
 * MsiDatabaseImport's work: an archive file read into the database. A table
 * replaces any of its name; `_ForceCodepage` sets the code page, and
 * `_SummaryInformation` the summary's properties, the others kept.
 *
 * @param {Database} db
 * @param {string | Uint8Array} archive  The file's bytes, in the database's code
 *        page, or its text.
 * @param {(file: string) => Uint8Array | null | Promise<Uint8Array | null>} readStream
 *        A stream's file, by the name its field gives, out of the archive's
 *        `streamFolder`.
 * @returns {Promise<number>} ERROR_FUNCTION_FAILED for an archive that is not
 *          one, a type, row or stream that cannot be read, or a code page there is no such
 */
export async function importTable(db, archive, readStream){
    if (db.readOnly)
    {
        return ERROR_FUNCTION_FAILED;
    }
    const text = typeof archive === 'string' ? archive : decoderFor(db.codepage)(archive);
    const lines = archiveLines(text);
    if (lines.length < 3)
    {
        return ERROR_FUNCTION_FAILED;
    }
    const [names, types, labels] = lines;
    const rows = lines.slice(3);
    if (labels.length === 2 && labels[1] === FORCE_CODEPAGE)
    {
        const codepage = /^\d+$/.test(labels[0]) ? Number(labels[0]) : -1;
        if (!CODEPAGES.has(codepage))
        {
            return ERROR_FUNCTION_FAILED;
        }
        db.codepage = codepage;
        return ERROR_SUCCESS;
    }
    if (names.length !== types.length || rows.some(fields=>fields.length !== names.length))
    {
        return ERROR_FUNCTION_FAILED;
    }
    if (labels[0] === SUMMARY_TABLE)
    {
        return importSummary(db, rows);
    }
    if (SYSTEM_TABLES.has(labels[0]))
    {
        return ERROR_FUNCTION_FAILED;
    }
    const columns = columnsOf(labels[0], names, types, labels.slice(1));
    if (!columns)
    {
        return ERROR_FUNCTION_FAILED;
    }
    const table = emptyTable(labels[0], columns);
    /** @type {[Row, number, Uint8Array][]} */
    const streams = [];
    for (const fields of rows)
    {
        /** @type {Row} */
        const row = [];
        for (const [index, column] of columns.entries())
        {
            const field = fields[index];
            if (field === '')
            {
                row.push(null);
            }
            else if (isBinaryType(column.type))
            {
                const bytes = await readStream(unescapeField(field));
                if (!bytes)
                {
                    return ERROR_FUNCTION_FAILED;
                }
                streams.push([row, index, bytes]);
                row.push(null);
            }
            else if (isStringType(column.type))
            {
                row.push(unescapeField(field));
            }
            else if (/^\s*-?\d+\s*$/.test(field))
            {
                row.push(Number(field));
            }
            else
            {
                return ERROR_FUNCTION_FAILED;
            }
        }
        if (insertRow(db, table, row, false) !== ERROR_SUCCESS)
        {
            return ERROR_FUNCTION_FAILED;
        }
    }
    // Named once every row is whole: a stream is named for its row's keys.
    for (const [row, index, bytes] of streams)
    {
        const name = rowStreamName(table.name, columns, row);
        row[index] = name;
        db.writeStream(name, bytes);
    }
    putTable(db, table);
    return ERROR_SUCCESS;
}

/**
 * `_SummaryInformation`'s rows into the summary: each a property number and
 * its value as the property's type reads it.
 *
 * @param {Database} db @param {string[][]} rows
 */
function importSummary(db, rows){
    const summary = readSummary(db.summaryStream());
    for (const [pidText, valueText] of rows)
    {
        const pid = /^\d+$/.test(pidText) ? Number(pidText) : -1;
        const type = /** @type {Record<number, number>} */ (PID_TYPES)[pid];
        if (type === undefined)
        {
            return ERROR_FUNCTION_FAILED;
        }
        if (valueText === '')
        {
            continue;
        }
        if (type === VT.LPSTR)
        {
            summary.set(pid, { type, value: unescapeField(valueText) });
            continue;
        }
        if (type === VT.FILETIME)
        {
            const value = parseDate(valueText);
            if (value === null)
            {
                return ERROR_FUNCTION_FAILED;
            }
            summary.set(pid, { type, value });
            continue;
        }
        if (!/^\s*-?\d+\s*$/.test(valueText))
        {
            return ERROR_FUNCTION_FAILED;
        }
        summary.set(pid, { type, value: Number(valueText) | 0 });
    }
    db.setSummaryStream(writeSummaryStream(summary));
    return ERROR_SUCCESS;
}

/**
 * Whether two columns' types merge: strings, localized or not, of any size,
 * as long as both or neither may be null; anything else only the same type.
 *
 * @param {string} left @param {string} right
 */
const typesMatch = (left, right)=>left === right
    || ('ls'.includes(left[0]) && 'ls'.includes(right[0]))
    || ('LS'.includes(left[0]) && 'LS'.includes(right[0]));

/**
 * Whether a table of the database being merged can go into one of the base:
 * the same columns by name and type, the same keys.
 *
 * @param {Table} ours @param {Table} theirs
 */
function sameSchema(ours, theirs){
    if (ours.columns.length !== theirs.columns.length
        || ours.columns.some((column, index)=>column.name !== theirs.columns[index].name))
    {
        return false;
    }
    const left = typesOf(ours);
    const right = typesOf(theirs);
    if (left.some((type, index)=>!typesMatch(type, right[index])))
    {
        return false;
    }
    const ourKeys = keyNames(ours.columns);
    const theirKeys = keyNames(theirs.columns);
    return ourKeys.length === theirKeys.length
        && ourKeys.every((name, index)=>name === theirKeys[index]);
}

/** @param {Column[]} columns @param {Row} row */
const keyText = (columns, row)=>JSON.stringify(columns.flatMap((column, index)=>
    (isKey(column) ? [row[index] ?? null] : [])));

/**
 * Whether a row of the merged database holds what the base's row with its
 * keys does: a string null and empty alike, a stream by its bytes.
 *
 * @param {Database} db @param {Database} other @param {Column[]} columns
 * @param {Row} ours @param {Row} theirs
 */
async function sameRow(db, other, columns, ours, theirs){
    for (const [index, column] of columns.entries())
    {
        const left = ours[index] ?? null;
        const right = theirs[index] ?? null;
        if (isBinaryType(column.type))
        {
            const a = left === null ? null : await db.readStream(String(left));
            const b = right === null ? null : await other.readStream(String(right));
            if (a === null || b === null ? a !== b
                : a.length !== b.length || a.some((byte, at)=>byte !== b[at]))
            {
                return false;
            }
        }
        else if (isStringType(column.type) ? (left || null) !== (right || null) : left !== right)
        {
            return false;
        }
    }
    return true;
}

/**
 * MsiDatabaseMerge's work: every table of `other` merged into `db`.
 *
 * @param {Database} db @param {Database} other
 * @param {string | null} errorTable  Where a table with conflicts is counted:
 *        a table of columns Table and NumRowMergeConflicts, made when it is not there.
 * @returns {Promise<number>} ERROR_DATATYPE_MISMATCH, with nothing merged, when
 *          a table is in both with other columns; ERROR_FUNCTION_FAILED when a row
 *          conflicts
 */
export async function mergeDatabases(db, other, errorTable){
    if (db.readOnly)
    {
        return ERROR_FUNCTION_FAILED;
    }
    /** @type {{ theirs: Table, ours: Table | null, added: Row[], conflicts: number }[]} */
    const plans = [];
    for (const [name, table] of persistentTables(other))
    {
        const theirs = { ...table, ...persistentPart(table) };
        const ours = db.table(name);
        if (ours && !sameSchema(ours, theirs))
        {
            return ERROR_DATATYPE_MISMATCH;
        }
        plans.push({ theirs, ours, added: [], conflicts: 0 });
    }
    for (const plan of plans)
    {
        const { theirs, ours } = plan;
        /** @type {Map<string, Row>} */
        const existing = new Map(ours ? ours.rows.map(row=>[keyText(ours.columns, row), row]) : []);
        for (const row of theirs.rows)
        {
            const same = existing.get(keyText(theirs.columns, row));
            if (!same)
            {
                plan.added.push(row);
            }
            else if (!await sameRow(db, other, theirs.columns, same, row))
            {
                plan.conflicts++;
            }
        }
    }

    let conflicted = false;
    for (const { theirs, ours, added, conflicts } of plans)
    {
        if (conflicts > 0)
        {
            conflicted = true;
            if (errorTable !== null && errorTable !== '')
            {
                countConflicts(db, errorTable, theirs.name, conflicts);
            }
            continue;
        }
        const target = ours ?? emptyTable(theirs.name, theirs.columns.map(column=>({ ...column })));
        if (!ours)
        {
            putTable(db, target);
        }
        for (const source of added)
        {
            const row = [...source];
            /** @type {[number, Uint8Array][]} */
            const streams = [];
            for (const [index, column] of theirs.columns.entries())
            {
                if (isBinaryType(column.type) && row[index] !== null)
                {
                    const bytes = await other.readStream(String(row[index]));
                    row[index] = null;
                    if (bytes)
                    {
                        streams.push([index, bytes]);
                    }
                }
            }
            for (const [index, bytes] of streams)
            {
                const name = rowStreamName(target.name, target.columns, row);
                row[index] = name;
                db.writeStream(name, bytes);
            }
            if (insertRow(db, target, row, false) !== ERROR_SUCCESS)
            {
                return ERROR_FUNCTION_FAILED;
            }
        }
    }
    return conflicted ? ERROR_FUNCTION_FAILED : ERROR_SUCCESS;
}

/**
 * A table's conflicts counted in the error table, which is made as the
 * installer makes it when it is not there.
 *
 * @param {Database} db @param {string} errorTable @param {string} table @param {number} count
 */
function countConflicts(db, errorTable, table, count){
    let errors = db.table(errorTable);
    if (!errors)
    {
        const columns = columnsOf(errorTable, ['Table', 'NumRowMergeConflicts'], ['s255', 'i2'],
            ['Table']);
        if (!columns)
        {
            return;
        }
        errors = emptyTable(errorTable, columns);
        putTable(db, errors);
    }
    const at = errors.columns.findIndex(column=>column.name === 'NumRowMergeConflicts');
    const row = errors.rows.find(entry=>entry[0] === table);
    if (row && at >= 0)
    {
        row[at] = Number(row[at] ?? 0) + count;
        return;
    }
    insertRow(db, errors, errors.columns.map((column, index)=>(index === 0 ? table
        : index === at ? count : null)), false);
}
