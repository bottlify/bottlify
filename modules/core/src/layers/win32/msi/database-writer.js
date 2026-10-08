/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * An installer database written back out as a compound file: what
 * MsiDatabaseCommit saves and what the installer caches of a package.
 *
 * The tables in memory are the truth. `_Tables` and `_Columns` are made
 * afresh from them, so a table created, dropped or given a column since the
 * database was opened is described as it now is, and nothing temporary --
 * table, column or row -- is written. The string pool is made afresh too,
 * holding exactly the strings the rows refer to, with how many times; but a
 * string keeps the number the database already gave it, because a stored
 * table's order is the order of those numbers and a database reopened from
 * the file must sort its rows the way it did before it was saved.
 *
 * Streams that are not tables -- a Binary row's bytes, a cabinet, anything
 * an opened package carried -- are copied from wherever the database reads
 * them, a chunk at a time, so a package of hundreds of megabytes is written
 * without being held. The storages an opened package embeds (transforms
 * named ":name") are copied the same way.
 */

import { GUID_NULL } from '../ole32/guid.js';
import { compoundBytes, storageOf, streamOf, writeCompound } from '../common/compound-writer.js';
import {
    SYSTEM_COLUMNS, decodeStreamName, encodeStreamName, isBinaryType, isKey, isStringType,
    persistentPart, persistentTables, rowStreamName, writeStringPool, writeTableRows,
} from './database.js';

/** The class of an installer database's root storage. */
export const CLSID_MSI_DATABASE = '{000C1084-0000-0000-C000-000000000046}';

const SUMMARY_STREAM = '\u0005SummaryInformation';

/**
 * @typedef {import('./database.js').Database} Database
 * @typedef {import('./database.js').Row} Row
 * @typedef {import('./database.js').Column} Column
 * @typedef {import('./compound.js').CompoundNode} CompoundNode
 * @typedef {import('./compound.js').CompoundFile} CompoundFile
 * @typedef {import('../common/compound-writer.js').WriteNode} WriteNode
 * @typedef {import('../common/compound-writer.js').WriteStorage} WriteStorage
 * @typedef {import('../common/compound-writer.js').CompoundSink} CompoundSink
 *
 * @typedef {Object} DatabaseWriteOptions
 * @property {(name: string) => boolean} [omitStreams]
 *           Streams (by the name the database knows them by) to leave out:
 *           what a cached package drops of the cabinets it carried.
 * @property {string} [clsid]  The root's class; by default the one the file
 *           had when it was opened, or an installer database's.
 */

/** A database that cannot be saved as it is. */
export class DatabaseWriteError extends Error {}

/**
 * The compound file a database is, as a tree to write.
 *
 * @param {Database} db @param {DatabaseWriteOptions} [options]
 * @returns {WriteStorage}
 * @throws {DatabaseWriteError} for a table or stream whose name does not fit
 *         in a directory entry
 */
export function databaseTree(db, options = {}){
    const tables = [...persistentTables(db)]
        .map(([name, table])=>({ name, ...persistentPart(table) }))
        .filter(table=>table.columns.length > 0);

    // The pool: every string a saved row holds, under the number the database
    // knows it by, counted once for each place it is held.
    /** @type {(string | null)[]} */
    const strings = [null];
    /** @type {number[]} */
    const refs = [0];
    /** @param {string | number | null} text */
    const hold = text=>{
        if (text === null || text === '')
        {
            return;
        }
        const id = db.stringId(String(text));
        while (strings.length <= id)
        {
            strings.push(null);
            refs.push(0);
        }
        strings[id] = String(text);
        refs[id]++;
    };
    /** @param {Row} left @param {Row} right @param {number} count */
    const byKeys = (left, right, count)=>{
        for (let index = 0; index < count; index++)
        {
            const a = left[index];
            const b = right[index];
            const difference = typeof a === 'string' && typeof b === 'string'
                ? db.stringId(a) - db.stringId(b) : Number(a) - Number(b);
            if (difference !== 0)
            {
                return difference;
            }
        }
        return 0;
    };
    // Stored in key order, as the format keeps every table: a table's name by
    // its string's number, then a column's number.
    /** @type {Row[]} */
    const tableRows = tables.map(table=>[table.name]);
    /** @type {Row[]} */
    const columnRows = tables.flatMap(table=>table.columns.map((column, index)=>
        [table.name, index + 1, column.name, column.type & 0x7fff]));
    for (const row of [...tableRows, ...columnRows])
    {
        hold(row[0]);
    }
    tableRows.sort((left, right)=>byKeys(left, right, 1));
    columnRows.sort((left, right)=>byKeys(left, right, 2));
    columnRows.forEach(row=>hold(row[2]));

    const saved = [
        { name: '_Tables', columns: SYSTEM_COLUMNS._Tables, rows: tableRows },
        { name: '_Columns', columns: SYSTEM_COLUMNS._Columns, rows: columnRows },
        ...tables,
    ];
    for (const table of tables)
    {
        const text = table.columns.flatMap((column, index)=>
            (isStringType(column.type) ? [index] : []));
        for (const row of table.rows)
        {
            text.forEach(index=>hold(row[index]));
        }
    }
    const { pool, data, longRefs } = writeStringPool(strings, refs, db.codepage);
    /** @type {Map<string, number>} */
    const ids = new Map();
    strings.forEach((text, id)=>{
        if (text !== null)
        {
            ids.set(text, id);
        }
    });
    /** @param {string} text */
    const idOf = text=>/** @type {number} */ (ids.get(text));

    /** @type {WriteNode[]} */
    const children = [];
    /** @param {string} name @param {boolean} table */
    const packed = (name, table)=>{
        const encoded = encodeStreamName(name, table);
        if (encoded === null)
        {
            throw new DatabaseWriteError(`${name}: too long a name for a stream`);
        }
        return encoded;
    };
    children.push(streamOf(packed('_StringPool', true), pool));
    children.push(streamOf(packed('_StringData', true), data));
    for (const table of saved)
    {
        if (table.rows.length > 0)
        {
            children.push(streamOf(packed(table.name, true),
                writeTableRows(table.rows, table.columns, idOf, longRefs)));
        }
    }

    // A stream the file had keeps the name it had there: one another program
    // put in a package unpacked ("\u0005DigitalSignature") is looked for
    // by that name, not by the packed one the installer would give it.
    const compound = db.compound ?? null;
    /** @type {Map<string, string>} */
    const rawNames = new Map();
    for (const node of compound?.root.children.values() ?? [])
    {
        const { name, table } = decodeStreamName(node.name);
        if (node.kind === 'stream' && !table && !rawNames.has(name))
        {
            rawNames.set(name, node.name);
        }
    }

    // Every stream the database holds, then a binary row's under the name its
    // keys now give it, where that is not the one its bytes are under.
    const omit = options.omitStreams ?? (()=>false);
    /** @type {Map<string, string>} */
    const streams = new Map();
    for (const name of db.streamNames())
    {
        streams.set(name, name);
    }
    for (const table of tables)
    {
        const binary = table.columns.flatMap((column, index)=>
            (isBinaryType(column.type) ? [index] : []));
        if (binary.length === 0 || !table.columns.some(isKey))
        {
            continue;
        }
        for (const row of table.rows)
        {
            const name = rowStreamName(table.name, table.columns, row);
            for (const index of binary)
            {
                const from = row[index];
                if (typeof from === 'string' && from !== '' && from !== name && db.hasStream(from))
                {
                    streams.set(name, from);
                }
            }
        }
    }
    for (const [name, from] of streams)
    {
        if (omit(name))
        {
            continue;
        }
        const size = db.streamSize(from);
        if (size === null)
        {
            continue;
        }
        children.push({ kind: 'stream', name: rawNames.get(name) ?? packed(name, false), source: {
            size,
            read: async(offset, length)=>await db.readStreamRange(from, offset, length)
                ?? new Uint8Array(0),
        } });
    }

    const summary = db.summaryStream();
    if (summary)
    {
        children.push(streamOf(SUMMARY_STREAM, summary));
    }
    if (compound)
    {
        for (const node of compound.root.children.values())
        {
            if (node.kind === 'storage')
            {
                children.push(copyStorage(compound, node));
            }
        }
    }
    const opened = compound?.root.clsid;
    return storageOf('Root Entry', children,
        options.clsid ?? (opened && opened !== GUID_NULL ? opened : CLSID_MSI_DATABASE));
}

/**
 * A storage of the file a database was read from, to be written as it is.
 *
 * @param {CompoundFile} compound @param {CompoundNode} node @returns {WriteNode}
 */
function copyStorage(compound, node){
    if (node.kind === 'stream')
    {
        return { kind: 'stream', name: node.name, source: {
            size: node.size,
            read: (offset, length)=>compound.read(node, offset, length),
        } };
    }
    const clsid = node.clsid && node.clsid !== GUID_NULL ? node.clsid : undefined;
    return storageOf(node.name, [...node.children.values()]
        .map(child=>copyStorage(compound, child)), clsid);
}

/**
 * Writes a database through a sink, in file order: the tables and pool at
 * the start, then each large stream a chunk at a time.
 *
 * @param {Database} db @param {CompoundSink} sink @param {DatabaseWriteOptions} [options]
 * @returns {Promise<number>} the file's size
 */
export function writeDatabase(db, sink, options = {}){
    return writeCompound(databaseTree(db, options), sink);
}

/**
 * A database as one block of bytes.
 *
 * @param {Database} db @param {DatabaseWriteOptions} [options]
 * @returns {Promise<Uint8Array>}
 */
export function databaseBytes(db, options = {}){
    return compoundBytes(databaseTree(db, options));
}

/**
 * The streams a package carries its cabinets in: every Media row's Cabinet
 * that begins with "#" names one. What a package cached once it is
 * installed leaves out.
 *
 * @param {Database} db @returns {Set<string>}
 */
export function embeddedCabinets(db){
    const media = db.table('Media');
    const column = media?.columns.findIndex(entry=>entry.name === 'Cabinet') ?? -1;
    /** @type {Set<string>} */
    const names = new Set();
    for (const row of media && column >= 0 ? media.rows : [])
    {
        const cabinet = row[column];
        if (typeof cabinet === 'string' && cabinet.startsWith('#') && cabinet.length > 1)
        {
            names.add(cabinet.slice(1));
        }
    }
    return names;
}
