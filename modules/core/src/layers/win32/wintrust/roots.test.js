/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { defaultTrustedRoots } from './roots.js';
import { isSelfIssued, isSignedBy, parseCertificate } from '../crypto/x509.js';

test('the default store is Microsoft\'s 1997 root, by thumbprint, name and validity', ()=>{
    const [der] = defaultTrustedRoots();
    assert.equal(defaultTrustedRoots().length, 2);
    assert.equal(createHash('sha1').update(der).digest('hex').toUpperCase(),
        'A43489159A520F0D93D032CCAF37E7FE20A8B419');
    const root = parseCertificate(der);
    assert.equal(root.subjectName, 'Microsoft Root Authority');
    assert.equal(root.notBefore, Date.UTC(1997, 0, 10, 7));
    assert.equal(root.notAfter, Date.UTC(2020, 11, 31, 7));
    assert.equal(root.publicKey?.size, 256);
    assert.ok(isSelfIssued(root));
    assert.ok(isSignedBy(root, root.publicKey), 'its MD5 with RSA self-signature verifies');

    const thawte = defaultTrustedRoots()[1];
    assert.equal(createHash('sha1').update(thawte).digest('hex').toUpperCase(),
        'BE36A4562FB2EE05DBB3D32323ADF445084ED656');
    const timestamping = parseCertificate(thawte);
    assert.equal(timestamping.subjectName, 'Thawte Timestamping CA');
    assert.ok(isSelfIssued(timestamping));
    assert.ok(isSignedBy(timestamping, timestamping.publicKey));
});
