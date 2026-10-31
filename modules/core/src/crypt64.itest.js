/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A 64-bit program's certificate context, as wincrypt.h lays it out at that
 * width: pbCertEncoded at 8, cbCertEncoded at 16, pCertInfo at 24, and
 * CERT_INFO's blobs and extension list pointer-wide. Laid out at 32 bits, a
 * TLS library reading the machine's roots took cbCertEncoded and pCertInfo
 * together as the certificate's address and faulted parsing it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';
import { certificateLayout } from './layers/win32/crypt32/certificates.js';

/** @param {number} value @returns {number[]} */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];
/** @param {string} text */
const wide = text=>[...text].flatMap(c=>[c.charCodeAt(0), 0]).concat(0, 0);

test('CERT_CONTEXT, CERT_INFO and CERT_EXTENSION have wincrypt.h\'s offsets at both widths',
    ()=>{
        const narrow = certificateLayout(4);
        assert.deepEqual(narrow.context, { size: 20, encoded: 4, length: 8, info: 12, store: 16 });
        assert.equal(narrow.info.size, 112);
        assert.deepEqual([narrow.info.issuer, narrow.info.subject, narrow.info.publicKey,
            narrow.info.keyBits, narrow.info.extensionCount, narrow.info.extensions],
        [24, 48, 56, 68, 104, 108]);
        const long = certificateLayout(8);
        assert.deepEqual(long.context, { size: 40, encoded: 8, length: 16, info: 24, store: 32 });
        assert.equal(long.info.size, 208);
        assert.deepEqual([long.info.serial, long.info.signature, long.info.issuer,
            long.info.notBefore, long.info.subject, long.info.publicKey, long.info.keyBits,
            long.info.extensionCount, long.info.extensions],
        [8, 24, 48, 64, 80, 96, 120, 192, 200]);
        assert.deepEqual(long.extension, { size: 32, critical: 8, value: 16 });
    });

test('a 64-bit program reads a root certificate\'s encoding and info where its layout has them',
    { timeout: 60000 }, async t=>{
        let contextAt = 0;
        const program = buildExe({
            bits: 64, codeSize: 0x100,
            imports: { 'CRYPT32.dll': ['CertOpenSystemStoreW', 'CertEnumCertificatesInStore'],
                'KERNEL32.dll': ['ExitProcess'] },
            data: { root: wide('ROOT'), context: new Array(8).fill(0x55) },
            code: ({ iat, at, code })=>{
                contextAt = at('context');
                /** @type {number[]} */
                const bytes = [];
                /** @param {number[]} op @param {number} to */
                const rip = (op, to)=>bytes.push(...op,
                    ...u32(to - (code(bytes.length) + op.length + 4)));
                bytes.push(0x48, 0x83, 0xec, 0x28); //                     sub rsp, 40
                bytes.push(0x31, 0xc9); //                                 xor ecx, ecx
                rip([0x48, 0x8d, 0x15], at('root')); //                    lea rdx, [root]
                rip([0xff, 0x15], iat('CertOpenSystemStoreW'));
                bytes.push(0x48, 0x89, 0xc1, 0x31, 0xd2); //               rcx = store, rdx = 0
                rip([0xff, 0x15], iat('CertEnumCertificatesInStore'));
                rip([0x48, 0x89, 0x05], at('context')); //                 mov [context], rax
                bytes.push(0x31, 0xc9);
                rip([0xff, 0x15], iat('ExitProcess'));
                return bytes;
            },
        });
        const app = await createApp({ executable: program, engine: 'cork' });
        t.after(()=>app.dispose());
        assert.equal(await app.run({ timeoutMs: 30000 }), 0);
        /** @param {number} at @param {number} length */
        const read = (at, length)=>new DataView(app.debug.read(at, length).slice().buffer);
        const context = Number(read(contextAt, 8).getBigUint64(0, true));
        assert.ok(context !== 0 && context < 0x100000000, 'a context, a whole quadword');
        const fields = read(context, 40);
        assert.equal(fields.getUint32(0, true), 1, 'X509_ASN_ENCODING');
        const encoded = Number(fields.getBigUint64(8, true));
        const length = fields.getUint32(16, true);
        assert.ok(length > 100 && length < 0x10000, `cbCertEncoded at 16 (${length})`);
        const der = read(encoded, 4);
        assert.equal(der.getUint8(0), 0x30, 'pbCertEncoded at 8: a DER SEQUENCE');
        assert.equal(der.getUint16(2, false) + 4, length, 'whose length is cbCertEncoded');
        const info = Number(fields.getBigUint64(24, true));
        assert.equal(read(info, 4).getUint32(0, true), 2, 'pCertInfo at 24: a version 3');
        const issuer = read(info + 48, 16);
        assert.ok(issuer.getUint32(0, true) > 0 && issuer.getBigUint64(8, true) !== 0n,
            'its Issuer a blob of 16 bytes at 48');
    });
