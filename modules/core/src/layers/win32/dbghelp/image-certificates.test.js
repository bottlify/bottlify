/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * imagehlp's certificate table calls over a PE file on a file system made
 * here: entries added, enumerated by type, read and removed, the security
 * directory and the file's end following.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { certificateTable, createImageCertificateFunctions } from './image-certificates.js';
import { buildExe } from '../../../../../../tools/make-pe.mjs';

const ERROR_ACCESS_DENIED = 5;
const ERROR_BAD_EXE_FORMAT = 193;
const ERROR_INVALID_PARAMETER = 87;

/** A WIN_CERTIFICATE of `length` bytes in all, of `type`. @param {number} length @param {number} type */
const winCertificate = (length, type)=>{
    const out = new Uint8Array(length).fill(0xcc);
    const view = new DataView(out.buffer);
    view.setUint32(0, length, true);
    view.setUint16(4, 0x0200, true);
    view.setUint16(6, type, true);
    return out;
};

/** @param {Uint8Array} image @param {boolean} [writable] */
function machine(image, writable = true){
    const memory = new Uint8Array(0x10000);
    const view = new DataView(memory.buffer);
    const file = { bytes: image.slice() };
    let lastError = 0;
    const fns = createImageCertificateFunctions({
        readMemory: (at, length)=>memory.subarray(at, at + length),
        writeMemory: (at, bytes)=>memory.set(bytes, at),
        setLastError: code=>{
            lastError = code;
        },
        fileOf: handle=>(handle === 4 ? { path: 'C:\\a.exe', node: file, write: writable } : null),
        files: {
            stat: ()=>({ size: file.bytes.length }),
            read: (node, offset, length)=>node.bytes.slice(offset, offset + length),
            write: (node, offset, bytes)=>{
                if (offset + bytes.length > node.bytes.length)
                {
                    const grown = new Uint8Array(offset + bytes.length);
                    grown.set(node.bytes);
                    node.bytes = grown;
                }
                node.bytes.set(bytes, offset);
                return bytes.length;
            },
            truncate: (node, size)=>{
                const cut = new Uint8Array(size);
                cut.set(node.bytes.subarray(0, size));
                node.bytes = cut;
            },
        },
    });
    return { memory, view, fns, file, error: ()=>lastError };
}

test('certificates are added at the end, enumerated by type, read back and removed', ()=>{
    const image = buildExe({ imports: {}, data: {}, codeSize: 0x10, code: ()=>[0xc3] });
    const { memory, view, fns, file } = machine(image);
    memory.set(winCertificate(13, 2), 0x100);
    assert.equal(fns.ImageAddCertificate.handler([4, 0x100, 0x80]), 1);
    assert.equal(view.getUint32(0x80, true), 0);
    memory.set(winCertificate(16, 1), 0x200);
    assert.equal(fns.ImageAddCertificate.handler([4, 0x200, 0x80]), 1);
    assert.equal(view.getUint32(0x80, true), 1);
    const table = certificateTable(file.bytes);
    assert.ok(table);
    assert.equal(table.offset % 8, 0, 'the table on an eight-byte boundary');
    assert.equal(table.size, 16 + 16, 'the first entry padded to eight');
    assert.equal(table.offset + table.size, file.bytes.length, 'it ends the file');

    assert.equal(fns.ImageEnumerateCertificates.handler([4, 0xff, 0x84, 0x88, 4]), 1);
    assert.equal(view.getUint32(0x84, true), 2);
    assert.equal(fns.ImageEnumerateCertificates.handler([4, 1, 0x84, 0x88, 4]), 1);
    assert.deepEqual([view.getUint32(0x84, true), view.getUint32(0x88, true)], [1, 1],
        'by type: the second');

    view.setUint32(0x8c, 64, true);
    assert.equal(fns.ImageGetCertificateData.handler([4, 0, 0x300, 0x8c]), 1);
    assert.equal(view.getUint32(0x8c, true), 13);
    assert.deepEqual([...memory.subarray(0x300, 0x30d)], [...winCertificate(13, 2)]);

    assert.equal(fns.ImageRemoveCertificate.handler([4, 0]), 1);
    const after = certificateTable(file.bytes);
    assert.equal(after?.certificates.length, 1);
    assert.equal(after?.certificates[0].type, 1);
    assert.equal(fns.ImageRemoveCertificate.handler([4, 0]), 1);
    assert.equal(file.bytes.length, image.length + ((8 - image.length % 8) % 8),
        'the table gone, the file ends where it began');
    assert.equal(certificateTable(file.bytes)?.size, 0);
});

test('refusals: not an image, not writable, no such entry, no such handle', ()=>{
    const text = machine(new TextEncoder().encode('MZ but not an image at all, really not'));
    assert.equal(text.fns.ImageEnumerateCertificates.handler([4, 0xff, 0x84, 0, 0]), 0);
    assert.equal(text.error(), ERROR_BAD_EXE_FORMAT);
    const image = buildExe({ imports: {}, data: {}, codeSize: 0x10, code: ()=>[0xc3] });
    const reading = machine(image, false);
    reading.memory.set(winCertificate(16, 2), 0x100);
    assert.equal(reading.fns.ImageAddCertificate.handler([4, 0x100, 0]), 0);
    assert.equal(reading.error(), ERROR_ACCESS_DENIED);
    const writing = machine(image);
    assert.equal(writing.fns.ImageRemoveCertificate.handler([4, 0]), 0);
    assert.equal(writing.error(), ERROR_INVALID_PARAMETER);
    assert.equal(writing.fns.ImageEnumerateCertificates.handler([9, 0xff, 0x84, 0, 0]), 0);
});
