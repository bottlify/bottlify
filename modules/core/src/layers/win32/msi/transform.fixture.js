/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Transforms and databases for the transform tests, built the way the format
 * lays them out rather than through the code under test: a transform's
 * streams are written word by word, and a database is made with SQL.
 */

import assert from 'node:assert/strict';
import { createEntry, createRoot, nameKey, serializeCompoundFile } from '../ole32/cfb.js';
import { bytesSource, openCompound } from './compound.js';
import { createEmptyDatabase } from './database.js';
import { openView } from './query.js';
import { CLSID_MSI_TRANSFORM } from './transform.js';

/**
 * Little-endian 16-bit words, as a transform's streams and pools are made of.
 *
 * @param {number[]} values @returns {Uint8Array}
 */
export const words = values=>{
    const out = new Uint8Array(values.length * 2);
    values.forEach((value, index)=>{
        out[index * 2] = value & 0xff;
        out[index * 2 + 1] = value >>> 8 & 0xff;
    });
    return out;
};

/** @param {string} text */
export const ascii = text=>Uint8Array.from(text, character=>character.charCodeAt(0));

/** @param {number[]} values @returns {string} a directory name from its code units */
export const units = values=>String.fromCharCode(...values);

/**
 * A storage of streams under directory names given as they are stored.
 *
 * @param {[string, Uint8Array][]} streams
 * @param {{ clsid?: string, name?: string }} [options]
 * @returns {import('../ole32/cfb.js').CfbEntry}
 */
export function storageOf(streams, options = {}){
    const storage = options.name ? createEntry(options.name, 'storage') : createRoot();
    storage.clsid = options.clsid ?? CLSID_MSI_TRANSFORM;
    for (const [name, data] of streams)
    {
        const entry = createEntry(name, 'stream');
        entry.data = data;
        storage.children.set(nameKey(name), entry);
    }
    return storage;
}

/**
 * @param {[string, Uint8Array][]} streams @param {{ clsid?: string }} [options]
 * @returns {Uint8Array} a transform file
 */
export const transformFile = (streams, options)=>serializeCompoundFile(storageOf(streams,
    options));

/** @param {Uint8Array} bytes */
export const openFile = async bytes=>openCompound(bytesSource(bytes));

/**
 * Runs SQL statements against a database, each to completion.
 *
 * @param {import('./database.js').Database} db @param {string[]} statements
 */
export function run(db, statements){
    for (const text of statements)
    {
        const opened = openView(db, text);
        assert.ok('view' in opened, `${text}: ${'error' in opened ? opened.error : ''}`);
        assert.equal(opened.view.execute(null), 0, text);
        opened.view.close();
    }
}

/**
 * The rows a query answers, as the fields of each record.
 *
 * @param {import('./database.js').Database} db @param {string} text
 */
export function select(db, text){
    const opened = openView(db, text);
    assert.ok('view' in opened, text);
    opened.view.execute(null);
    /** @type {unknown[][]} */
    const rows = [];
    for (let record = opened.view.fetch(); record; record = opened.view.fetch())
    {
        rows.push(record.fields.slice(1));
    }
    opened.view.close();
    return rows;
}

/**
 * The database of Wine's transform test: MOO with three rows, BINARY with a
 * row and its stream.
 */
export function wineDatabase(){
    const db = createEmptyDatabase();
    run(db, [
        'CREATE TABLE `MOO` ( `NOO` SHORT NOT NULL, `OOO` CHAR(255) PRIMARY KEY `NOO`)',
        'INSERT INTO `MOO` ( `NOO`, `OOO` ) VALUES ( 1, \'a\' )',
        'INSERT INTO `MOO` ( `NOO`, `OOO` ) VALUES ( 2, \'b\' )',
        'INSERT INTO `MOO` ( `NOO`, `OOO` ) VALUES ( 3, \'c\' )',
        'CREATE TABLE `BINARY` ( `ID` SHORT NOT NULL, `BLOB` OBJECT PRIMARY KEY `ID`)',
    ]);
    db.table('BINARY')?.rows.push([2, 'BINARY.2']);
    db.writeStream('BINARY.2', ascii('lamyon'));
    return db;
}

/**
 * Wine's hand-made transform for that database, stream for stream: adds the
 * table AAR with two rows, adds columns COW and PIG to MOO, changes one of
 * its rows and deletes another, adds a BINARY row with a stream, and adds a
 * Property table with a row.
 *
 * @returns {[string, Uint8Array][]}
 */
export const wineTransform = ()=>[
    // AAR: two rows added, each a string key and a short.
    [units([0x4840, 0x3a8a, 0x481b]), words([0x0201, 0x0008, 0x8001, 0x0201, 0x0009, 0x8002])],
    // _Columns: MOO gains COW (3) and PIG (4); AAR's and Property's columns
    // come numbered null.
    [units([0x4840, 0x3b3f, 0x43f2, 0x4438, 0x45b1]), words([
        0x0401, 0x0001, 0x8003, 0x0002, 0x9502,
        0x0401, 0x0001, 0x8004, 0x0003, 0x9502,
        0x0401, 0x0005, 0x0000, 0x0006, 0xbdff,
        0x0401, 0x0005, 0x0000, 0x0007, 0x8502,
        0x0401, 0x000a, 0x0000, 0x000a, 0xad48,
        0x0401, 0x000a, 0x0000, 0x000b, 0x9d00,
    ])],
    // _Tables: AAR and Property added.
    [units([0x4840, 0x3f7f, 0x4164, 0x422f, 0x4836]), words([0x0101, 0x0005, 0x0101, 0x000a])],
    [units([0x4840, 0x3f3f, 0x4577, 0x446c, 0x3b6a, 0x45e4, 0x4824]),
        ascii('MOOCOWPIGcAARCARBARvwbmwPropertyValuepropval')],
    [units([0x4840, 0x3f3f, 0x4577, 0x446c, 0x3e6a, 0x44b2, 0x482f]), words([
        0, 0, 3, 2, 3, 1, 3, 1, 1, 1, 3, 3, 3, 1, 3, 1, 2, 1, 3, 1, 8, 4, 5, 1, 4, 1, 3, 1,
    ])],
    // MOO: row 1's OOO and PIG changed (mask bits 1 and 3); row 3 deleted.
    [units([0x4840, 0x3e16, 0x4818]), words([0x000a, 0x8001, 0x0004, 0x8005, 0x0000, 0x8003])],
    // BINARY: row 1 added with a stream, and the stream "BINARY.1".
    [units([0x4840, 0x3c8b, 0x3a97, 0x409b]), words([0x0201, 0x8001, 0x0001])],
    [units([0x3c8b, 0x3a97, 0x409b, 0x387e]), ascii('naengmyon')],
    // Property: prop = val.
    [units([0x4840, 0x4559, 0x44f2, 0x4568, 0x4737]), words([0x0201, 0x000c, 0x000d])],
];
