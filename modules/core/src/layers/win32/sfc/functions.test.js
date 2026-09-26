/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filesystemModule } from '../../filesystem/module.js';
import { createVolume } from '../kernel32/vfs.js';
import { CATALOG_STORE, SFC_ORDINALS, createSfcFunctions } from './functions.js';

const ERROR_FILE_NOT_FOUND = 2;
const ERROR_SERVICE_DISABLED = 1058;

async function machine(){
    const bytes = new Uint8Array(0x400);
    const view = new DataView(bytes.buffer);
    const fs = await filesystemModule.create({});
    const volume = /** @type {any} */ (createVolume(fs));
    const fns = createSfcFunctions({
        writeMemory: (address, data)=>bytes.set(data, address),
        readCString: (address, maxLength)=>{
            let text = '';
            for (let at = address; at < address + maxLength && bytes[at] !== 0; at++)
            {
                text += String.fromCharCode(bytes[at]);
            }
            return text;
        },
        files: volume,
    });
    /** @param {number} at @param {string} text */
    const put = (at, text)=>{
        bytes.set([...text, '\0'].map(c=>c.charCodeAt(0)), at);
        return at;
    };
    /** @param {string} path @param {number[]} data */
    const file = (path, data)=>{
        const node = volume.open(path, { write: true, create: true, truncate: true });
        volume.write(node, 0, Uint8Array.from(data));
        volume.close(node);
    };
    /** @param {string} path */
    const contents = path=>{
        const stat = volume.stat(path);
        if (!stat)
        {
            return null;
        }
        const node = volume.open(path, { read: true });
        const data = [...volume.read(node, 0, stat.size)];
        volume.close(node);
        return data;
    };
    return { bytes, view, fns, put, file, contents, volume };
}

test('a restore point is refused as System Restore disabled, in the status block', async()=>{
    for (const name of /** @type {const} */ (
        ['SRSetRestorePoint', 'SRSetRestorePointA', 'SRSetRestorePointW']))
    {
        const { view, fns } = await machine();
        const status = 0x40;
        view.setUint32(status, 0xdeadbeef, true);
        view.setUint32(status + 4, 0x11111111, true);
        assert.equal(fns[name].argBytes, 8);
        assert.equal(fns[name].handler([0x10, status]), 0, `${name} fails`);
        assert.equal(view.getUint32(status, true), ERROR_SERVICE_DISABLED,
            'nStatus says why: every code but ERROR_SUCCESS is a failure');
        assert.equal(view.getUint32(status + 4, true), 0x11111111,
            'llSequenceNumber is packed at 4 and only written for a point that was made');
    }
});

test('with no status block there is nowhere to say why, and the answer is still no', async()=>{
    const { fns } = await machine();
    assert.equal(fns.SRSetRestorePointA.handler([0x10, 0]), 0);
});

test('a catalog is installed into the catalog store, and deleted from it by name', async()=>{
    const { fns, put, file, contents, volume } = await machine();
    assert.equal(SFC_ORDINALS[8], 'SfpInstallCatalog');
    assert.equal(SFC_ORDINALS[9], 'SfpDeleteCatalog');
    assert.equal(fns.SfpInstallCatalog.argBytes, 8);
    assert.equal(fns.SfpDeleteCatalog.argBytes, 4);

    volume.mkdir('C:\\temp');
    file('C:\\temp\\dx.cat', [0x30, 0x82, 1, 2]);
    assert.equal(await fns.SfpInstallCatalog.handler([put(0x100, 'C:\\temp\\dx.cat'), 0]), 0,
        'the answer is an error code, zero for success');
    assert.deepEqual(contents(`${CATALOG_STORE}\\dx.cat`), [0x30, 0x82, 1, 2]);
    assert.deepEqual(contents('C:\\temp\\dx.cat'), [0x30, 0x82, 1, 2], 'copied, not moved');

    assert.equal(fns.SfpDeleteCatalog.handler([put(0x100, 'dx.cat')]), 0);
    assert.equal(contents(`${CATALOG_STORE}\\dx.cat`), null);
    assert.equal(fns.SfpDeleteCatalog.handler([put(0x100, 'dx.cat')]), ERROR_FILE_NOT_FOUND,
        'a catalog that is not installed');
});

test('a catalog that is not there is not installed', async()=>{
    const { fns, put, contents } = await machine();
    assert.equal(await fns.SfpInstallCatalog.handler([put(0x100, 'C:\\temp\\none.cat'), 0]),
        ERROR_FILE_NOT_FOUND);
    assert.equal(contents(`${CATALOG_STORE}\\none.cat`), null);
});
