/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DerError, isSelfIssued, isSignedBy, KEY_USAGE, parseCertificate, USAGE } from './x509.js';
import { ext, makeCertificate, makeKey } from './pki.test.js';

const rootKey = makeKey();
const leafKey = makeKey();

test('a certificate\'s parts are read as RFC 5280 lays them out', ()=>{
    const notBefore = Date.UTC(2007, 7, 22, 22, 31, 2);
    const notAfter = Date.UTC(2012, 7, 25, 7);
    const certificate = parseCertificate(makeCertificate({
        subject: 'Leaf', issuer: 'Root', key: leafKey, signer: rootKey, serial: 0x1234,
        notBefore, notAfter, hash: 'sha256',
        extensions: [ext.basicConstraints(true, 1), ext.keyUsage(0, 5),
            ext.extendedKeyUsage(USAGE.CODE_SIGNING, USAGE.TIME_STAMPING)],
    }));
    assert.equal(certificate.version, 3);
    assert.deepEqual([...certificate.serial], [0x12, 0x34]);
    assert.equal(certificate.subjectName, 'Leaf');
    assert.equal(certificate.notBefore, notBefore);
    assert.equal(certificate.notAfter, notAfter);
    assert.equal(certificate.signatureAlgorithm, '1.2.840.113549.1.1.11');
    assert.equal(certificate.publicKey?.size, 128);
    assert.equal(certificate.publicKey?.e, 65537n);
    assert.deepEqual(certificate.basicConstraints, { ca: true, pathLength: 1 });
    assert.ok(certificate.keyUsage?.(KEY_USAGE.DIGITAL_SIGNATURE));
    assert.ok(certificate.keyUsage?.(KEY_USAGE.KEY_CERT_SIGN));
    assert.ok(!certificate.keyUsage?.(1));
    assert.deepEqual(certificate.extendedKeyUsage, [USAGE.CODE_SIGNING, USAGE.TIME_STAMPING]);
    assert.deepEqual(certificate.unknownCritical, []);
    assert.ok(!isSelfIssued(certificate));
});

test('a version 1 certificate has no extensions, and absent ones read as null', ()=>{
    const certificate = parseCertificate(makeCertificate({ subject: 'Old', key: rootKey,
        v1: true }));
    assert.equal(certificate.version, 1);
    assert.equal(certificate.basicConstraints, null);
    assert.equal(certificate.keyUsage, null);
    assert.equal(certificate.extendedKeyUsage, null);
    assert.ok(isSelfIssued(certificate));
});

test('a critical extension this build cannot read is listed; a CA flag left out is false', ()=>{
    const certificate = parseCertificate(makeCertificate({ subject: 'Odd', key: rootKey,
        extensions: [ext.unknownCritical(), ext.basicConstraints(false)] }));
    assert.deepEqual(certificate.unknownCritical, ['1.2.3.4.5']);
    assert.deepEqual(certificate.basicConstraints, { ca: false, pathLength: null });
});

test('a signature is checked with the issuer\'s key over the bytes signed', ()=>{
    const root = parseCertificate(makeCertificate({ subject: 'Root', key: rootKey }));
    const leaf = makeCertificate({ subject: 'Leaf', issuer: 'Root', key: leafKey,
        signer: rootKey });
    assert.ok(isSignedBy(root, root.publicKey), 'the root signs itself');
    assert.ok(isSignedBy(parseCertificate(leaf), root.publicKey));
    assert.ok(!isSignedBy(parseCertificate(leaf), parseCertificate(leaf).publicKey));
    assert.ok(!isSignedBy(parseCertificate(leaf), null));
    const changed = leaf.slice();
    const at = Buffer.from(changed).indexOf('Leaf');
    changed[at] ^= 0x20;
    assert.ok(!isSignedBy(parseCertificate(changed), root.publicKey), 'a changed subject');
});

test('bytes that are not a certificate are refused with a DerError', ()=>{
    assert.throws(()=>parseCertificate(Uint8Array.of(0x30, 0)), DerError);
    assert.throws(()=>parseCertificate(Uint8Array.of(1, 2, 3)), DerError);
});
