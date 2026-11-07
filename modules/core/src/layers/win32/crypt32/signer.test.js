/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a setup engine checks its packages with: the signer of a PKCS #7
 * message found and verified (CryptMsgGetAndVerifySigner), a public key's
 * hash (CryptHashPublicKeyInfo), and CryptDecodeObject, the older spelling
 * of CryptDecodeObjectEx.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSha1 } from '../crypto/digest.js';
import { childrenOf, encoding, readNode } from '../crypto/der.js';
import {
    contentsOf, der, makeCertificate, makeKey, makeSignedData, makeSignerInfo, OIDS,
} from '../crypto/pki.test.js';
import { LEAF, setup } from './pki.fixtures.test.js';

const CRYPT_E_NO_TRUSTED_SIGNER = 0x8009202b;

const caKey = makeKey();
const signerKey = makeKey();
const ca = makeCertificate({ subject: 'CA', key: caKey });
const signerCert = makeCertificate({ subject: 'Signer', issuer: 'CA', key: signerKey,
    signer: caKey, serial: 7 });
const content = der.seq(der.oid('1.2.3'), der.octets(Uint8Array.of(1, 2, 3)));

/** A message signed over `covered` by the signer certificate's key. @param {Uint8Array} covered */
const signedOver = covered=>makeSignedData({ contentType: OIDS.data, content,
    certificates: [ca, signerCert],
    signers: [makeSignerInfo({ issuer: 'CA', serial: 7, key: signerKey, covered,
        attributes: [[OIDS.contentType, der.oid('1.2.3')]] }).encoded] });

/** The message as CryptQueryObject opens it, and the calls to make on it. @param {Uint8Array} signed */
function opened(signed){
    const machine = setup();
    const { call, put, u32, view } = machine;
    const blob = put(new Uint8Array(8));
    view.setUint32(blob, signed.length, true);
    view.setUint32(blob + 4, put(signed), true);
    const outs = put(new Uint8Array(24));
    assert.equal(call('CryptQueryObject', 2, blob, 1 << 8, 2, 0, outs, outs + 4, outs + 8,
        outs + 12, outs + 16, 0), 1);
    return { ...machine, message: u32(outs + 16) };
}

test('the signer whose signature verifies is answered, with its index', ()=>{
    const { call, put, u32, bytes, message } = opened(signedOver(contentsOf(content)));
    const out = put(new Uint8Array(8));
    assert.equal(call('CryptMsgGetAndVerifySigner', message, 0, 0, 0, out, out + 4), 1);
    const context = u32(out);
    assert.deepEqual([...bytes.subarray(u32(context + 4), u32(context + 4) + u32(context + 8))],
        [...signerCert], 'the signer\'s certificate, as a context');
    assert.equal(u32(out + 4), 0);
    assert.equal(call('CertFreeCertificateContext', context), 1);
});

test('a signature over other bytes finds no signer, unless only finding is asked', ()=>{
    const { call, put, u32, errors, message } = opened(signedOver(Uint8Array.of(9, 9, 9)));
    const out = put(new Uint8Array(8));
    assert.equal(call('CryptMsgGetAndVerifySigner', message, 0, 0, 0, out, 0), 0);
    assert.equal(errors.at(-1), CRYPT_E_NO_TRUSTED_SIGNER);
    assert.equal(call('CryptMsgGetAndVerifySigner', message, 0, 0, 0x2, out, 0), 1,
        'CMSG_SIGNER_ONLY_FLAG');
    assert.notEqual(u32(out), 0);
    assert.equal(call('CryptMsgGetAndVerifySigner', message, 0, 0, 0x1, out, 0), 0,
        'CMSG_TRUSTED_SIGNER_FLAG: no store here makes it trusted');
    assert.equal(errors.at(-1), CRYPT_E_NO_TRUSTED_SIGNER);
});

test('CryptHashPublicKeyInfo hashes the key\'s SubjectPublicKeyInfo', ()=>{
    const { call, put, u32, bytes, view } = setup();
    const leaf = call('CertCreateCertificateContext', 1, put(LEAF), LEAF.length);
    // CERT_PUBLIC_KEY_INFO is CERT_INFO's at +56.
    const info = u32(leaf + 12) + 56;
    const size = put(new Uint8Array(4));
    assert.equal(call('CryptHashPublicKeyInfo', 0, 0, 0, 1, info, 0, size), 1);
    assert.equal(u32(size), 20, 'SHA-1 when no algorithm is named');
    const out = put(new Uint8Array(32));
    assert.equal(call('CryptHashPublicKeyInfo', 0, 0, 0, 1, info, out, size), 1);
    const tbs = childrenOf(childrenOf(readNode(LEAF))[0]);
    const spki = encoding(tbs[6]);
    const sha1 = createSha1();
    sha1.update(spki);
    assert.deepEqual([...bytes.subarray(out, out + 20)], [...sha1.digest()]);
    view.setUint32(size, 32, true);
    assert.equal(call('CryptHashPublicKeyInfo', 0, 0x800c, 0, 1, info, out, size), 1);
    assert.equal(u32(size), 32, 'SHA-256 by its ALG_ID');
});

test('CryptDecodeObject decodes into the caller\'s buffer as CryptDecodeObjectEx does', ()=>{
    const { call, put, u32, view } = setup();
    const size = put(new Uint8Array(4));
    // X509_BASIC_CONSTRAINTS2 (15) of an empty sequence.
    assert.equal(call('CryptDecodeObject', 1, 15, put(Uint8Array.of(0x30, 0)), 2, 0, 0, size), 1);
    assert.equal(u32(size), 12, 'the size asked first');
    const out = put(new Uint8Array(12));
    assert.equal(call('CryptDecodeObject', 1, 15, put(Uint8Array.of(0x30, 0)), 2, 0x8000, out,
        size), 1, 'an allocation flag is not one this spelling has');
    assert.equal(view.getUint32(out, true), 0, 'not a CA');
});
