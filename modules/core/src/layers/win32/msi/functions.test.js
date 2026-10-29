/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMsiFunctions } from './functions.js';
import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';
import { createHive } from '../advapi32/registry.js';

/** The msi table over a flat memory, with nothing installed and no package open. */
function setup(){
    const memory = new Uint8Array(0x100000);
    let next = 0x80000;
    /** @param {number} address @param {number} max */
    const readCString = (address, max)=>{
        const end = memory.indexOf(0, address);
        if (end < 0 || end - address > max)
        {
            throw new Error(`No NUL within ${max} bytes of 0x${address.toString(16)}`);
        }
        return decodeAnsi(memory.subarray(address, end));
    };
    const fns = /** @type {any} */ (createMsiFunctions(/** @type {any} */ ({
        readMemory: (/** @type {number} */ at, /** @type {number} */ n)=>memory.subarray(at, at + n),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ bytes)=>
            memory.set(bytes, at),
        readCString,
        readWideString: ()=>'',
        allocate: (/** @type {number} */ size)=>{
            const at = next;
            next += size + 16;
            return at;
        },
        free: ()=>{},
        hive: createHive(),
        callerThread: ()=>null,
        // As the filesystem resolves: an empty path is no path at all.
        fullPath: (/** @type {string} */ path)=>{
            if (path === '')
            {
                throw Object.assign(new Error('An empty path names nothing'),
                    { code: 'INVALID_PATH' });
            }
            return path;
        },
        files: { stat: ()=>null },
    })));
    /** @param {number} at @param {string} text */
    const put = (at, text)=>{
        memory.set(encodeAnsi(`${text}\0`), at);
        return at;
    };
    const view = new DataView(memory.buffer);
    const u32 = (/** @type {number} */ at)=>view.getUint32(at, true);
    /** @param {number} at @param {number} value */
    const setU32 = (at, value)=>view.setUint32(at, value, true);
    return { fns, put, u32, setU32, readCString };
}

test('a record holds a string of any length, as Windows bounds none', ()=>{
    // A script hands over all of a session's properties in one string, far
    // longer than any path; read to a fixed bound, it failed the installation.
    const { fns, put, u32, setU32, readCString } = setup();
    const record = fns.MsiCreateRecord.handler([1]);
    assert.notEqual(record, 0);
    const text = 'INSTALLDIR=C:\\Program Files\\Product;'.repeat(2000);
    assert.ok(text.length > 0x10000);
    assert.equal(fns.MsiRecordSetStringA.handler([record, 1, put(0x1000, text)]), 0);

    const SIZE = 0x40;
    const BUFFER = 0x30000;
    setU32(SIZE, 0);
    fns.MsiRecordGetStringA.handler([record, 1, 0, SIZE]);
    assert.equal(u32(SIZE), text.length, 'its length, asked with no buffer');
    setU32(SIZE, text.length + 1);
    assert.equal(fns.MsiRecordGetStringA.handler([record, 1, BUFFER, SIZE]), 0);
    assert.equal(readCString(BUFFER, 0x100000), text, 'and all of it, read back');
});

test('an installed product is reached through the package the machine kept for it', async()=>{
    const { fns, put, setU32 } = setup();
    const unknown = put(0x1000, '{6D7A2B10-1111-4222-8333-944455556666}');
    const OUT = 0x40;
    assert.equal(await fns.MsiConfigureProductA.handler([unknown, 0, 2]), 1605,
        'ERROR_UNKNOWN_PRODUCT for one the machine has no record of');
    assert.equal(await fns.MsiReinstallProductA.handler([unknown, 0x1]), 1605);
    assert.equal(await fns.MsiConfigureFeatureA.handler([unknown, put(0x2000, 'Main'), 2]),
        1605);
    setU32(OUT, 0);
    assert.equal(await fns.MsiOpenProductA.handler([unknown, OUT]), 1605);
    assert.equal(await fns.MsiConfigureProductA.handler([put(0x3000, 'not a guid'), 0, 2]), 87);
    assert.equal(await fns.MsiConfigureProductA.handler([unknown, 0, 9]), 87,
        'a state that is not one of the four');
    assert.equal(await fns.MsiOpenProductA.handler([unknown, 0]), 87);
});

test('an empty package path is a package that is not there, not a failure of the layer', async()=>{
    // Wine's suminfo and msi tests hand "" where a path goes.
    const { fns, put } = setup();
    const EMPTY = put(0x1000, '');
    const ERROR_INSTALL_PACKAGE_OPEN_FAILED = 1619;
    const ERROR_OPEN_FAILED = 110;
    assert.equal(await fns.MsiGetSummaryInformationA.handler([0, EMPTY, 0, 0x40]),
        1620, 'ERROR_INSTALL_PACKAGE_INVALID');
    assert.equal(await fns.MsiOpenPackageA.handler([EMPTY, 0x40]),
        ERROR_INSTALL_PACKAGE_OPEN_FAILED);
    assert.equal(await fns.MsiOpenDatabaseA.handler([EMPTY, 0, 0x40]), ERROR_OPEN_FAILED);
});
