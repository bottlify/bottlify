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

test('the default store holds the roots Microsoft signed with from 2001 on, as Windows 7 does',
    ()=>{
    // The .NET Framework 4.5 to 4.8 packages are signed by "Microsoft Code
    // Signing PCA 2010" and "2011", which chain to these; a machine without
    // them refuses the packages with CERT_E_CHAINING, as Windows does when
    // its roots were never updated.
        const byThumbprint = new Map(defaultTrustedRoots().map(der=>
            [createHash('sha1').update(der).digest('hex').toUpperCase(), der]));
        for (const [thumbprint, name] of [
            ['CDD4EEAE6000AC7F40C3802C171E30148030C072', 'Microsoft Root Certificate Authority'],
            ['3B1EFD3A66EA28B16697394703A72CA340A05BD5',
                'Microsoft Root Certificate Authority 2010'],
            ['8F43288AD272F3103B6FB1428485EA3014C0BCFE',
                'Microsoft Root Certificate Authority 2011'],
        ])
        {
            const der = byThumbprint.get(thumbprint);
            assert.ok(der, name);
            const root = parseCertificate(/** @type {Uint8Array} */ (der));
            assert.equal(root.subjectName, name);
            assert.ok(isSelfIssued(root), name);
            assert.ok(isSignedBy(root, root.publicKey), `${name} signed itself`);
        }
    });
