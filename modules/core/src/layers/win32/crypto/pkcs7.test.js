/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    checkSigner, parseSignedData, parseSignerInfo, PKCS7, signedContent, signerCertificate,
    signingTime,
} from './pkcs7.js';
import { DerError } from './der.js';
import {
    contentsOf, der, makeCertificate, makeKey, makeSignedData, makeSignerInfo, OIDS,
} from './pki.test.js';

const caKey = makeKey();
const signerKey = makeKey();
const tsaKey = makeKey();
const ca = makeCertificate({ subject: 'CA', key: caKey });
const signerCert = makeCertificate({ subject: 'Signer', issuer: 'CA', key: signerKey,
    signer: caKey, serial: 7 });
const tsaCert = makeCertificate({ subject: 'TSA', issuer: 'CA', key: tsaKey, signer: caKey,
    serial: 8 });
const content = der.seq(der.oid('1.2.3'), der.octets(Uint8Array.of(1, 2, 3)));

/** @param {Partial<import('./pki.test.js').SignerSpec>} [change] */
function message(change = {}){
    const signer = makeSignerInfo({ issuer: 'CA', serial: 7, key: signerKey,
        covered: contentsOf(content), attributes: [[OIDS.contentType, der.oid('1.2.3')]],
        ...change });
    return parseSignedData(makeSignedData({ contentType: OIDS.spcIndirectData, content,
        certificates: [ca, signerCert, tsaCert], signers: [signer.encoded] }));
}

test('SignedData is read: its content, its certificates and its signer', ()=>{
    const signed = message();
    assert.deepEqual(signed.digestAlgorithms, [OIDS.sha1]);
    assert.equal(signed.contentType, OIDS.spcIndirectData);
    assert.deepEqual([...signed.content ? signedContent(signed.content) : []],
        [...contentsOf(content)], 'the content inside its [0], less its own header');
    assert.deepEqual(signed.certificates.map(c=>c.subjectName), ['CA', 'Signer', 'TSA']);
    const [signer] = signed.signers;
    assert.equal(signer.digestAlgorithm, OIDS.sha1);
    assert.equal(signerCertificate(signed.certificates, signer)?.subjectName, 'Signer',
        'found by issuer and serial number');
});

test('a signer holds when the content hashes to its digest and the signature is its key\'s', ()=>{
    const signed = message();
    const [signer] = signed.signers;
    const key = signerCertificate(signed.certificates, signer)?.publicKey ?? null;
    const covered = signedContent(/** @type {any} */ (signed.content));
    assert.equal(checkSigner(signer, key, covered), 'ok');
    assert.equal(checkSigner(signer, key, covered.subarray(1)), 'digest', 'other content');
    assert.equal(checkSigner(signer, signed.certificates[2].publicKey, covered), 'signature',
        'another key');
    assert.equal(checkSigner(signer, null, covered), 'unsupported', 'no key at all');

    const stated = message({ messageDigest: new Uint8Array(20) }).signers[0];
    assert.equal(checkSigner(stated, key, covered), 'digest', 'a stated digest of other bytes');
});

test('with no authenticated attributes the signature is over the content\'s own digest', ()=>{
    const signed = message({ attributes: null });
    const [signer] = signed.signers;
    assert.equal(signer.authenticated, null);
    const key = signerCertificate(signed.certificates, signer)?.publicKey ?? null;
    assert.equal(checkSigner(signer, key, signedContent(/** @type {any} */ (signed.content))), 'ok');
});

test('a countersignature is a signer over the first signer\'s encrypted digest, with a time', ()=>{
    const first = makeSignerInfo({ issuer: 'CA', serial: 7, key: signerKey,
        covered: contentsOf(content) });
    const when = Date.UTC(2010, 5, 1, 12);
    const counter = makeSignerInfo({ issuer: 'CA', serial: 8, key: tsaKey,
        covered: first.encryptedDigest,
        attributes: [[OIDS.contentType, der.oid(OIDS.data)], [OIDS.signingTime, der.utc(when)]] });
    const signer = makeSignerInfo({ issuer: 'CA', serial: 7, key: signerKey,
        covered: contentsOf(content),
        unauthenticated: [[OIDS.counterSignature, counter.encoded]] });
    const signed = parseSignedData(makeSignedData({ contentType: OIDS.spcIndirectData, content,
        certificates: [ca, signerCert, tsaCert], signers: [signer.encoded] }));
    const [publisher] = signed.signers;
    const node = publisher.unauthenticated.get(PKCS7.COUNTER_SIGNATURE)?.[0];
    assert.ok(node);
    const countersigner = parseSignerInfo(node);
    assert.equal(signingTime(countersigner), when);
    assert.equal(signingTime(publisher), null);
    const tsa = signerCertificate(signed.certificates, countersigner);
    assert.equal(tsa?.subjectName, 'TSA');
    assert.equal(checkSigner(countersigner, tsa?.publicKey ?? null, publisher.encryptedDigest),
        'ok');
    assert.equal(checkSigner(countersigner, tsa?.publicKey ?? null, publisher.encryptedDigest
        .subarray(1)), 'digest');
});

test('a ContentInfo that is not SignedData, or not DER, is refused', ()=>{
    assert.throws(()=>parseSignedData(der.seq(der.oid(OIDS.data), der.ctx(0, der.octets(
        new Uint8Array(1))))), DerError);
    assert.throws(()=>parseSignedData(Uint8Array.of(0x30, 0x05, 1)), DerError);
});
