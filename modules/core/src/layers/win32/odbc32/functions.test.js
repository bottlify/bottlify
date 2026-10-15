/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ODBC32_ORDINALS, createOdbcFunctions } from './functions.js';

const SQL_SUCCESS = 0;
const SQL_SUCCESS_WITH_INFO = 1;
const SQL_ERROR = -1;
const SQL_INVALID_HANDLE = -2;
const SQL_NO_DATA = 100;
const SQL_HANDLE_ENV = 1;
const SQL_HANDLE_DBC = 2;
const SQL_HANDLE_STMT = 3;
const SQL_ATTR_ODBC_VERSION = 200;
const SQL_OV_ODBC3 = 3;

function machine(){
    const bytes = new Uint8Array(0x10000);
    const view = new DataView(bytes.buffer);
    const fns = createOdbcFunctions({
        writeMemory: (address, data)=>bytes.set(data, address),
    });
    /** @param {string} name @param {number[]} args */
    const call = (name, args)=>/** @type {number} */ (fns[/** @type {keyof typeof fns} */ (name)]
        .handler(args)) | 0;
    /** @param {number} at @param {number} length */
    const text = (at, length)=>String.fromCharCode(...bytes.subarray(at, at + length));
    return { fns, call, u32: (/** @type {number} */ at)=>view.getUint32(at, true),
        i16: (/** @type {number} */ at)=>view.getInt16(at, true), text };
}

test('handles are made in the order the specification sets, and connecting finds no source', ()=>{
    // An installer helper library imports this for a package's database steps;
    // a machine with no driver answers its connections as Windows does.
    const { call, u32, i16, text } = machine();
    assert.equal(call('SQLAllocHandle', [SQL_HANDLE_ENV, 0, 0x100]), SQL_SUCCESS);
    const environment = u32(0x100);
    assert.notEqual(environment, 0);

    assert.equal(call('SQLAllocHandle', [SQL_HANDLE_DBC, environment, 0x104]), SQL_ERROR,
        'a connection before the environment says which ODBC it speaks');
    assert.equal(u32(0x104), 0, 'and the out handle is null');
    assert.equal(call('SQLGetDiagRec', [SQL_HANDLE_ENV, environment, 1, 0x200, 0x210, 0x300,
        256, 0x220]), SQL_SUCCESS);
    assert.equal(text(0x200, 5), 'HY010');

    assert.equal(call('SQLSetEnvAttr', [environment, SQL_ATTR_ODBC_VERSION, SQL_OV_ODBC3, 0]),
        SQL_SUCCESS);
    assert.equal(call('SQLAllocHandle', [SQL_HANDLE_DBC, environment, 0x104]), SQL_SUCCESS);
    const connection = u32(0x104);
    assert.equal(call('SQLDriverConnect', [connection, 0, 0x400, -3, 0, 0, 0, 0]), SQL_ERROR);
    assert.equal(call('SQLGetDiagRec', [SQL_HANDLE_DBC, connection, 1, 0x200, 0x210, 0x300,
        256, 0x220]), SQL_SUCCESS);
    assert.equal(text(0x200, 6), 'IM002\0');
    assert.match(text(0x300, i16(0x220)), /Data source name not found/);
    assert.equal(call('SQLGetDiagRec', [SQL_HANDLE_DBC, connection, 2, 0x200, 0x210, 0x300,
        256, 0x220]), SQL_NO_DATA, 'one record');
    assert.equal(call('SQLGetDiagRec', [SQL_HANDLE_DBC, connection, 1, 0x200, 0x210, 0x300,
        10, 0x220]), SQL_SUCCESS_WITH_INFO, 'a message cut to the buffer');
    assert.equal(text(0x300, 10), '[Microsof\0');

    assert.equal(call('SQLAllocHandle', [SQL_HANDLE_STMT, connection, 0x108]), SQL_ERROR,
        'no statement on a connection never opened');
    assert.equal(call('SQLFreeHandle', [SQL_HANDLE_ENV, environment]), SQL_ERROR,
        'an environment with a connection under it stays');
    assert.equal(call('SQLFreeHandle', [SQL_HANDLE_DBC, connection]), SQL_SUCCESS);
    assert.equal(call('SQLFreeHandle', [SQL_HANDLE_ENV, environment]), SQL_SUCCESS);
    assert.equal(call('SQLFreeHandle', [SQL_HANDLE_ENV, environment]), SQL_INVALID_HANDLE);
});

test('ODBC 2\'s calls: SQLAllocEnv speaks version 2, SQLError takes its record', ()=>{
    const { call, u32, text } = machine();
    assert.equal(call('SQLAllocEnv', [0x100]), SQL_SUCCESS);
    assert.equal(call('SQLAllocConnect', [u32(0x100), 0x104]), SQL_SUCCESS);
    assert.equal(call('SQLConnect', [u32(0x104), 0, 0, 0, 0, 0, 0]), SQL_ERROR);
    assert.equal(call('SQLError', [u32(0x100), u32(0x104), 0, 0x200, 0x210, 0x300, 256, 0x220]),
        SQL_SUCCESS);
    assert.equal(text(0x200, 5), 'IM002');
    assert.equal(call('SQLError', [u32(0x100), u32(0x104), 0, 0x200, 0x210, 0x300, 256, 0x220]),
        SQL_NO_DATA, 'taken off the handle');
    assert.equal(call('SQLDataSources', [u32(0x100), 2, 0, 0, 0, 0, 0, 0]), SQL_NO_DATA,
        'no data source configured');
    assert.equal(call('SQLFreeConnect', [u32(0x104)]), SQL_SUCCESS);
    assert.equal(call('SQLFreeEnv', [u32(0x100)]), SQL_SUCCESS);
});

test('the export table\'s numbers name the entries Windows exports by them', ()=>{
    // The numbers odbc32's specification file gives; an installer helper
    // imports five of them by number alone.
    const { fns } = machine();
    assert.deepEqual([2, 24, 31, 36, 41].map(at=>ODBC32_ORDINALS[/** @type {2} */ (at)]),
        ['SQLAllocEnv', 'SQLAllocHandle', 'SQLFreeHandle', 'SQLGetDiagRec', 'SQLDriverConnect']);
    for (const name of Object.values(ODBC32_ORDINALS))
    {
        assert.ok(name in fns, `${name} is answered`);
    }
});
