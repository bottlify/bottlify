/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The catalog administrator: a file's hash as a catalog lists it, and a
 * search that finds no catalog.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogHash, createCatalogFunctions } from './catalog.js';
import { createSha1 } from '../crypto/digest.js';
import { OID } from '../crypto/signature.js';
import { buildExe } from '../../../../../../tools/make-pe.mjs';

const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_NOT_FOUND = 1168;
const ERROR_INVALID_HANDLE = 6;

/** @param {Record<number, Uint8Array>} files */
function machine(files){
    const memory = new Uint8Array(0x10000);
    const view = new DataView(memory.buffer);
    let lastError = 0;
    const fns = /** @type {Record<string, { handler: (args: number[]) => any }>} */ (
        /** @type {unknown} */ (createCatalogFunctions({
            readMemory: (at, length)=>memory.subarray(at, at + length),
            writeMemory: (at, bytes)=>memory.set(bytes, at),
            readWideString: at=>{
                let text = '';
                for (let i = at; view.getUint16(i, true) !== 0; i += 2)
                {
                    text += String.fromCharCode(view.getUint16(i, true));
                }
                return text;
            },
            setLastErrorFor: (_thread, code)=>{
                lastError = code;
            },
            callerThread: ()=>({}),
            fileBytes: handle=>files[handle] ?? null,
        })));
    return { memory, view, fns, error: ()=>lastError };
}

test('a plain file is listed by the hash of all of it, a PE image by its Authenticode digest', ()=>{
    const text = new TextEncoder().encode('not an image');
    const image = buildExe({ imports: {}, data: {}, codeSize: 0x10, code: ()=>[0xc3] });
    const { memory, view, fns, error } = machine({ 4: text, 8: image });
    view.setUint32(0x100, 4, true);
    assert.equal(fns.CryptCATAdminCalcHashFromFileHandle.handler([4, 0x100, 0x200, 0]), 0);
    assert.equal(error(), ERROR_INSUFFICIENT_BUFFER);
    assert.equal(view.getUint32(0x100, true), 20, 'the size it needs');
    assert.equal(fns.CryptCATAdminCalcHashFromFileHandle.handler([4, 0x100, 0x200, 0]), 1);
    const digest = createSha1();
    digest.update(text);
    assert.deepEqual([...memory.subarray(0x200, 0x214)], [...digest.digest()]);

    assert.equal(fns.CryptCATAdminCalcHashFromFileHandle.handler([8, 0x100, 0x200, 0]), 1);
    assert.deepEqual([...memory.subarray(0x200, 0x214)],
        [...(catalogHash(image, OID.SHA1) ?? [])]);
    const flat = createSha1();
    flat.update(image);
    assert.notDeepEqual([...memory.subarray(0x200, 0x214)], [...flat.digest()],
        'the checksum and the certificate directory are left out');
    assert.equal(fns.CryptCATAdminCalcHashFromFileHandle.handler([12, 0x100, 0x200, 0]), 0);
    assert.equal(error(), ERROR_INVALID_HANDLE);
});

test('a context is SHA1 or SHA256 by name; no catalog lists anything', ()=>{
    const text = new TextEncoder().encode('data');
    const { memory, view, fns, error } = machine({ 4: text });
    [...'SHA256\0'].forEach((ch, i)=>view.setUint16(0x300 + i * 2, ch.charCodeAt(0), true));
    assert.equal(fns.CryptCATAdminAcquireContext2.handler([0x100, 0, 0x300, 0, 0]), 1);
    const admin = view.getUint32(0x100, true);
    view.setUint32(0x104, 32, true);
    assert.equal(fns.CryptCATAdminCalcHashFromFileHandle2.handler([admin, 4, 0x104, 0x200, 0]),
        1);
    assert.equal(view.getUint32(0x104, true), 32);
    assert.ok(memory.subarray(0x200, 0x220).some(byte=>byte !== 0));
    assert.equal(fns.CryptCATAdminEnumCatalogFromHash.handler([admin, 0x200, 32, 0, 0]), 0);
    assert.equal(error(), ERROR_NOT_FOUND);
    assert.equal(fns.CryptCATCatalogInfoFromContext.handler([0, 0x400, 0]), 0);
    assert.equal(fns.CryptCATAdminReleaseContext.handler([admin, 0]), 1);
    assert.equal(fns.CryptCATAdminReleaseContext.handler([admin, 0]), 0, 'released once');
    assert.equal(fns.CryptCATAdminAcquireContext.handler([0x100, 0, 0]), 1);
});
