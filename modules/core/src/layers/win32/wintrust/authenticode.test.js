/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRUST, verifyAuthenticode } from './authenticode.js';
import { parseCertificate } from '../crypto/x509.js';
import { ext, makeCertificate, OIDS } from '../crypto/pki.test.js';
import {
    certificates, ISSUED, KEYS, NOW, SIGNED, signedCabinet, signedImage, YEAR,
} from './fixtures.test.js';

const chain = certificates();
const roots = [parseCertificate(chain.root)];
/** @param {Uint8Array} bytes @param {Partial<import('./authenticode.js').TrustOptions>} [more] */
const verify = (bytes, more)=>verifyAuthenticode(bytes, { roots, now: NOW, ...more });

test('a timestamped cabinet whose chains end at a trusted root is trusted', ()=>{
    assert.equal(verify(signedCabinet()), TRUST.OK);
    assert.equal(verify(signedCabinet({ withRoot: true })), TRUST.OK, 'the root carried too');
});

test('a root not in the store is untrusted; one nowhere to be found breaks the chain', ()=>{
    assert.equal(verify(signedCabinet({ withRoot: true }), { roots: [] }),
        TRUST.CERT_E_UNTRUSTEDROOT);
    assert.equal(verify(signedCabinet(), { roots: [] }), TRUST.CERT_E_CHAINING);
    assert.equal(verify(signedCabinet({ leave: 'pca' })), TRUST.CERT_E_CHAINING,
        'an intermediate missing');
});

test('a changed byte the signature covers is a bad digest, one it leaves out is not', ()=>{
    const signed = signedCabinet();
    const inBody = signed.slice();
    inBody[100] ^= 1;
    assert.equal(verify(inBody), TRUST.TRUST_E_BAD_DIGEST);
    const inReserved = signed.slice();
    inReserved[5] ^= 1;
    assert.equal(verify(inReserved), TRUST.OK, 'reserved1 is not covered');
    assert.equal(verify(inBody, { roots: [] }), TRUST.TRUST_E_BAD_DIGEST,
        'integrity is judged before the chain');
});

test('an unsigned cabinet has no signature, and a file of no signed form is unknown', ()=>{
    assert.equal(verify(signedCabinet({ unsigned: true })), TRUST.TRUST_E_NOSIGNATURE);
    assert.equal(verify(new Uint8Array(0)), TRUST.TRUST_E_SUBJECT_FORM_UNKNOWN);
    assert.equal(verify(new Uint8Array(Buffer.from('plain text, no signature'))),
        TRUST.TRUST_E_SUBJECT_FORM_UNKNOWN);
});

test('the chain is judged at the timestamp\'s time, or now when there is none', ()=>{
    // The publisher's certificate ran from a year before SIGNED to a year after.
    assert.equal(verify(signedCabinet({ stamped: null })), TRUST.CERT_E_EXPIRED, 'no timestamp');
    assert.equal(verify(signedCabinet({ stamped: null }), { now: SIGNED }), TRUST.OK);
    assert.equal(verify(signedCabinet({ stamped: SIGNED + 2 * YEAR })), TRUST.CERT_E_EXPIRED,
        'stamped after the publisher\'s certificate ended');
    assert.equal(verify(signedCabinet(), { lifetime: true }), TRUST.CERT_E_EXPIRED,
        'WTD_LIFETIME_SIGNING_FLAG');
    const lifetimeChain = certificates({ publisher: { extensions: [
        ext.extendedKeyUsage(OIDS.codeSigning, '1.3.6.1.4.1.311.10.3.13')] } });
    assert.equal(verify(signedCabinet({ chain: lifetimeChain })), TRUST.CERT_E_EXPIRED,
        'a publisher certificate with the lifetime signing usage');
    const expiredRoot = certificates({ root: { notAfter: SIGNED + YEAR } });
    assert.equal(verify(signedCabinet({ chain: expiredRoot }),
        { roots: [parseCertificate(expiredRoot.root)] }), TRUST.OK, 'a root expired since');
});

test('the publisher must be allowed to sign code and the authority to stamp time', ()=>{
    const serverAuth = '1.3.6.1.5.5.7.3.1';
    assert.equal(verify(signedCabinet({ chain: certificates({ publisher: {
        extensions: [ext.extendedKeyUsage(serverAuth)] } }) })), TRUST.CERT_E_WRONG_USAGE);
    assert.equal(verify(signedCabinet({ chain: certificates({ tsa: {
        extensions: [ext.extendedKeyUsage(OIDS.codeSigning)] } }) })), TRUST.CERT_E_WRONG_USAGE);
    assert.equal(verify(signedCabinet({ chain: certificates({ pca: {
        extensions: [ext.basicConstraints(true), ext.extendedKeyUsage(serverAuth)] } }) })),
    TRUST.CERT_E_WRONG_USAGE, 'an intermediate restricts what is below it');
    assert.equal(verify(signedCabinet({ chain: certificates({ publisher: { extensions: [] },
        pca: { extensions: [] } }) })), TRUST.OK, 'a chain restricting nothing allows it');
});

test('the signer, its certificate and the countersignature must each hold', ()=>{
    assert.equal(verify(signedCabinet({ leave: 'publisher' })), TRUST.TRUST_E_NO_SIGNER_CERT);
    assert.equal(verify(signedCabinet({ signerKey: KEYS.stranger })), TRUST.NTE_BAD_SIGNATURE);
    assert.equal(verify(signedCabinet({ countersigned: new Uint8Array(8) })),
        TRUST.TRUST_E_COUNTER_SIGNER);
    assert.equal(verify(signedCabinet({ leave: 'tsa' })), TRUST.TRUST_E_COUNTER_SIGNER);
});

test('a certificate signed by another key, or issued by a non-CA, breaks the chain', ()=>{
    const forged = certificates({ pca: { signer: KEYS.stranger } });
    assert.equal(verify(signedCabinet({ chain: forged })), TRUST.TRUST_E_CERT_SIGNATURE);
    const notCa = certificates({ pca: {
        extensions: [ext.basicConstraints(false), ext.extendedKeyUsage(OIDS.codeSigning)] } });
    assert.equal(verify(signedCabinet({ chain: notCa })), TRUST.TRUST_E_BASIC_CONSTRAINTS);
    const critical = certificates({ publisher: {
        extensions: [ext.extendedKeyUsage(OIDS.codeSigning), ext.unknownCritical()] } });
    assert.equal(verify(signedCabinet({ chain: critical })), TRUST.CERT_E_CRITICAL);
    const stranger = makeCertificate({ subject: 'Test Root', key: KEYS.stranger,
        notBefore: ISSUED, notAfter: ISSUED + 20 * YEAR });
    assert.equal(verify(signedCabinet(), { roots: [parseCertificate(stranger)] }),
        TRUST.TRUST_E_CERT_SIGNATURE, 'a root of the same name but another key');
});

test('WTD_HASH_ONLY_FLAG checks the file\'s digest and nothing else', ()=>{
    assert.equal(verify(signedCabinet(), { roots: [], hashOnly: true }), TRUST.OK);
    const changed = signedCabinet();
    changed[150] ^= 1;
    assert.equal(verify(changed, { hashOnly: true }), TRUST.TRUST_E_BAD_DIGEST);
});

test('a PE image\'s signature is found in its certificate table and covers all but that', ()=>{
    // Wine's wintrust tests, test_wintrust_digest, for the refusals.
    const signed = signedImage();
    assert.equal(verify(signed), TRUST.OK);
    const checksum = signed.slice();
    checksum[0x40 + 24 + 64] ^= 1;
    assert.equal(verify(checksum), TRUST.OK, 'the checksum is not covered');
    const section = signed.slice();
    section[0x300] ^= 1;
    assert.equal(verify(section), TRUST.TRUST_E_BAD_DIGEST);
    const header = signed.slice();
    header[19] ^= 1;
    assert.equal(verify(header), TRUST.TRUST_E_BAD_DIGEST, 'the DOS header is');
    assert.equal(verify(Uint8Array.from([...signed, 0x11, 0x22, 0x33, 0x44])),
        TRUST.TRUST_E_NOSIGNATURE, 'bytes after the certificate table');
    assert.equal(verify(signed.subarray(0, 64)), TRUST.TRUST_E_SUBJECT_FORM_UNKNOWN,
        'a DOS header alone');
    assert.equal(verify(signed.subarray(0, 0x200)), TRUST.TRUST_E_NOSIGNATURE,
        'the table cut off');
    assert.equal(verify(signedImage({ unsigned: true })), TRUST.TRUST_E_NOSIGNATURE);
});
