/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { privateEncrypt, sign } from 'node:crypto';
import { OID, verifyPkcs1, verifySigned } from './signature.js';
import { parseCertificate } from './x509.js';
import { der, hashOf, makeCertificate, makeKey } from './pki.test.js';

const key = makeKey();
const publicKey = /** @type {import('./signature.js').RsaKey} */ (
    parseCertificate(makeCertificate({ subject: 'Key', key })).publicKey);
const data = new Uint8Array(Buffer.from('signed bytes'));

test('a PKCS#1 v1.5 signature verifies under the digest it names, and only that', ()=>{
    for (const [hash, digestOid, signatureOid] of /** @type {const} */ ([
        ['md5', OID.MD5, OID.MD5_RSA],
        ['sha1', OID.SHA1, OID.SHA1_RSA],
        ['sha256', OID.SHA256, OID.SHA256_RSA],
    ]))
    {
        const signature = new Uint8Array(sign(hash, data, key.privateKey));
        assert.ok(verifyPkcs1(publicKey, digestOid, hashOf(hash, data), signature), hash);
        assert.ok(verifySigned(publicKey, signatureOid, data, signature), hash);
        assert.ok(!verifySigned(publicKey, signatureOid, data.subarray(1), signature),
            `${hash}: other data`);
    }
    const signature = new Uint8Array(sign('sha1', data, key.privateKey));
    assert.ok(!verifyPkcs1(publicKey, OID.MD5, hashOf('sha1', data), signature),
        'the DigestInfo names SHA-1');
    assert.ok(verifySigned(publicKey, OID.SHA1_RSA_OIW, data, signature), 'the OIW spelling');
    assert.ok(!verifySigned(publicKey, OID.RSA, data, signature), 'rsaEncryption names no digest');
    signature[5] ^= 1;
    assert.ok(!verifySigned(publicKey, OID.SHA1_RSA, data, signature), 'a changed signature');
});

test('a DigestInfo without its NULL parameters is accepted, one with more after it is not', ()=>{
    const hash = hashOf('sha1', data);
    const bare = der.seq(der.seq(der.oid(OID.SHA1)), der.octets(hash));
    assert.ok(verifyPkcs1(publicKey, OID.SHA1, hash,
        new Uint8Array(privateEncrypt(key.privateKey, bare))));
    const trailing = Uint8Array.from([...der.seq(der.seq(der.oid(OID.SHA1), der.nul()),
        der.octets(hash)), 0]);
    assert.ok(!verifyPkcs1(publicKey, OID.SHA1, hash,
        new Uint8Array(privateEncrypt(key.privateKey, trailing))));
    assert.ok(!verifyPkcs1(publicKey, OID.SHA1, hash,
        new Uint8Array(privateEncrypt(key.privateKey, hash))), 'a bare hash is no DigestInfo');
});

test('a signature longer than the modulus, or as large, is refused rather than reduced', ()=>{
    const hash = hashOf('sha1', data);
    assert.ok(!verifyPkcs1(publicKey, OID.SHA1, hash, new Uint8Array(publicKey.size + 1)));
    assert.ok(!verifyPkcs1(publicKey, OID.SHA1, hash, new Uint8Array(publicKey.size).fill(0xff)));
    assert.ok(!verifyPkcs1(publicKey, OID.SHA1, hash, new Uint8Array(0)));
});
