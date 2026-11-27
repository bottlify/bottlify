/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Certificate stores, contexts and chains, driven as a TLS client drives
 * them: the server's certificates into a memory store, a chain asked for, the
 * chain judged under the SSL policy. The certificates are made for these
 * tests (a root, an intermediate it signed, a server certificate for
 * *.example.test and example.test and a client one the intermediate signed,
 * and a stranger that signed itself), valid from 2026 to 2036.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT, INTERMEDIATE, LEAF, ROOT, STRANGER, setup } from './pki.fixtures.test.js';
import { nameMatches, TRUST_ERROR, TRUST_INFO } from './certificates.js';

const E_INVALIDARG = 0x80070057;
const CRYPT_E_EXISTS = 0x80092005;
const CRYPT_E_NOT_FOUND = 0x80092004;
const CERT_E_EXPIRED = 0x800b0101;
const CERT_E_UNTRUSTEDROOT = 0x800b0109;
const CERT_E_CHAINING = 0x800b010a;
const CERT_E_CN_NO_MATCH = 0x800b010f;
const CERT_E_WRONG_USAGE = 0x800b0110;
const CRYPT_E_REVOCATION_OFFLINE = 0x80092013;
const SERVER_AUTH = '1.3.6.1.5.5.7.3.1';

test('a server certificate chains through the intermediate to a trusted root', ()=>{
    const { call, create, chain, policy, live } = setup();
    const leaf = create(LEAF);
    const built = chain(leaf, [INTERMEDIATE]);
    assert.equal(built.error, 0);
    assert.equal(built.elements.length, 3);
    assert.equal(built.elements[0].context, leaf, 'the leaf element is the context asked about');
    assert.ok(built.elements[2].info & TRUST_INFO.IS_SELF_SIGNED);
    assert.ok(built.elements[0].info & TRUST_INFO.HAS_PREFERRED_ISSUER);
    for (const server of ['www.example.test', 'example.test', 'WWW.Example.Test'])
    {
        assert.deepEqual(policy(built.context, server), { error: 0, chain: -1, element: -1 },
            server);
    }
    for (const server of ['a.b.example.test', 'other.test', 'example.test.evil'])
    {
        assert.equal(policy(built.context, server).error, CERT_E_CN_NO_MATCH, server);
    }
    assert.equal(policy(built.context, 'other.test', { checks: 0x1000 }).error, 0,
        'SECURITY_FLAG_IGNORE_CERT_CN_INVALID');
    assert.equal(policy(built.context, null).error, 0, 'no name, no name check');
    // Everything is let go: the chain's references, then the caller's own.
    call('CertFreeCertificateChain', built.context);
    call('CertFreeCertificateContext', leaf);
    const rootStore = [...live];
    assert.equal(rootStore.length, 1, 'only the ROOT store\'s own context is left');
});

test('a chain whose intermediate was not sent is partial', ()=>{
    const { create, chain, policy } = setup();
    const built = chain(create(LEAF), []);
    assert.equal(built.elements.length, 1);
    assert.ok(built.error & TRUST_ERROR.IS_PARTIAL_CHAIN);
    assert.equal(policy(built.context, 'www.example.test').error, CERT_E_CHAINING);
});

test('a root the machine does not trust is an untrusted root, which a flag can excuse', ()=>{
    const { create, chain, policy } = setup({ roots: [] });
    const built = chain(create(LEAF), [INTERMEDIATE, ROOT]);
    assert.equal(built.elements.length, 3);
    assert.equal(built.elements[2].error, TRUST_ERROR.IS_UNTRUSTED_ROOT);
    assert.equal(built.error, TRUST_ERROR.IS_UNTRUSTED_ROOT);
    assert.deepEqual(policy(built.context, 'www.example.test'),
        { error: CERT_E_UNTRUSTEDROOT, chain: 0, element: 2 });
    assert.equal(policy(built.context, 'www.example.test', { checks: 0x100 }).error, 0);
    assert.equal(policy(built.context, 'www.example.test', { policy: 1, flags: 0x10 }).error, 0,
        'the base policy\'s CERT_CHAIN_POLICY_ALLOW_UNKNOWN_CA_FLAG');

    const stranger = chain(create(STRANGER), []);
    assert.equal(stranger.elements.length, 1);
    assert.ok(stranger.elements[0].info & TRUST_INFO.IS_SELF_SIGNED);
    assert.equal(stranger.error, TRUST_ERROR.IS_UNTRUSTED_ROOT);
});

test('a chain judged at a time past its certificates is not time valid', ()=>{
    const { create, chain, policy } = setup();
    const built = chain(create(LEAF), [INTERMEDIATE], { time: Date.UTC(2060, 0, 1) });
    assert.ok(built.elements.every(element=>element.error & TRUST_ERROR.IS_NOT_TIME_VALID));
    assert.equal(policy(built.context, 'www.example.test').error, CERT_E_EXPIRED);
    assert.equal(policy(built.context, 'www.example.test', { checks: 0x2000 }).error, 0);
    const now = chain(create(LEAF), [INTERMEDIATE], { time: Date.UTC(2031, 5, 1) });
    assert.equal(now.error, 0);
});

test('a client certificate is no server\'s, by the policy and by the usage asked for', ()=>{
    const { create, chain, policy } = setup();
    const client = chain(create(CLIENT), [INTERMEDIATE]);
    assert.equal(client.error, 0, 'no usage asked, none judged');
    assert.equal(policy(client.context, 'client.example.test').error, CERT_E_WRONG_USAGE);
    assert.equal(policy(client.context, 'client.example.test', { client: true }).error, 0);
    const asked = chain(create(CLIENT), [INTERMEDIATE], { usages: [SERVER_AUTH] });
    assert.equal(asked.elements[0].error, TRUST_ERROR.IS_NOT_VALID_FOR_USAGE);
    assert.equal(policy(asked.context, 'client.example.test', { checks: 0x200 }).error, 0);
    const server = chain(create(LEAF), [INTERMEDIATE], { usages: [SERVER_AUTH] });
    assert.equal(server.error, 0);
});

test('revocation, when asked, is unknown and offline: nothing is fetched', ()=>{
    const { create, chain, policy } = setup();
    const unknown = TRUST_ERROR.REVOCATION_STATUS_UNKNOWN | TRUST_ERROR.IS_OFFLINE_REVOCATION;
    const whole = chain(create(LEAF), [INTERMEDIATE], { flags: 0x20000000 });
    assert.deepEqual(whole.elements.map(element=>element.error), [unknown, unknown, 0],
        'a root is not checked for revocation');
    const end = chain(create(LEAF), [INTERMEDIATE], { flags: 0x10000000 });
    assert.deepEqual(end.elements.map(element=>element.error), [unknown, 0, 0]);
    assert.equal(policy(end.context, 'www.example.test').error, CRYPT_E_REVOCATION_OFFLINE);
    assert.equal(policy(end.context, 'www.example.test', { checks: 0x80 }).error, 0);
    assert.equal(policy(end.context, 'www.example.test', { policy: 1 }).error, 0,
        'the base policy does not judge revocation that is unknown');
});

test('a context is CERT_CONTEXT over CERT_INFO, as wincrypt.h lays them out', ()=>{
    const { bytes, u32, create, call, put, errors } = setup();
    const leaf = create(LEAF);
    assert.equal(u32(leaf), 1, 'X509_ASN_ENCODING');
    assert.deepEqual(bytes.slice(u32(leaf + 4), u32(leaf + 4) + u32(leaf + 8)), LEAF);
    const info = u32(leaf + 12);
    assert.equal(u32(info), 2, 'CERT_V3');
    assert.deepEqual([...bytes.slice(u32(info + 8), u32(info + 8) + u32(info + 4))],
        [5, 4, 3, 2, 1], 'the serial number little-endian');
    const cString = (/** @type {number} */ at)=>{
        let text = '';
        for (let i = at; bytes[i] !== 0; i++)
        {
            text += String.fromCharCode(bytes[i]);
        }
        return text;
    };
    assert.equal(cString(u32(info + 12)), '1.2.840.113549.1.1.11', 'sha256RSA');
    assert.equal(cString(u32(info + 56)), '1.2.840.113549.1.1.1', 'an RSA key');
    assert.equal(u32(info + 104), 6, 'six extensions');
    const extensions = u32(info + 108);
    assert.deepEqual(Array.from({ length: 6 }, (_, i)=>cString(u32(extensions + i * 16))),
        ['2.5.29.19', '2.5.29.15', '2.5.29.37', '2.5.29.17', '2.5.29.14', '2.5.29.35']);
    assert.equal(u32(extensions + 4), 1, 'basic constraints are critical');
    assert.equal(u32(extensions + 16 * 2 + 4), 0, 'the usage is not');
    // The value is the OCTET STRING's contents: a SEQUENCE of usages.
    assert.equal(bytes[u32(extensions + 16 * 2 + 12)], 0x30);
    // A store keeps a context of its own; adding the same one again is refused.
    const store = call('CertOpenStore', 2, 0, 0, 0, 0);
    const added = put(new Uint8Array(4));
    assert.equal(call('CertAddCertificateContextToStore', store, leaf, 1, added), 1);
    assert.notEqual(u32(added), leaf);
    assert.equal(u32(u32(added) + 16), store, 'its hCertStore is the store');
    assert.equal(call('CertAddCertificateContextToStore', store, leaf, 1, 0), 0);
    assert.equal(errors.at(-1), CRYPT_E_EXISTS);
    assert.equal(call('CertAddCertificateContextToStore', store, leaf, 2, 0), 1, 'USE_EXISTING');
    assert.equal(call('CertCreateCertificateContext', 1, put(new Uint8Array([1, 2, 3])), 3), 0);
    assert.equal(call('CertCloseStore', 0, 0), 1, 'a NULL store closes');
});

test('a store enumerates what it holds; ROOT holds the machine\'s roots', ()=>{
    const { u32, call, put, errors } = setup({ roots: [ROOT, STRANGER] });
    const root = call('CertOpenStore', 10, 0, 0, 0x20000, put(new Uint8Array([82, 0, 79, 0, 79,
        0, 84, 0, 0, 0])));
    assert.notEqual(root, 0);
    /** @type {number[]} */
    const seen = [];
    for (let context = call('CertEnumCertificatesInStore', root, 0); context !== 0;
        context = call('CertEnumCertificatesInStore', root, context))
    {
        seen.push(u32(context + 8));
    }
    assert.deepEqual(seen, [ROOT.length, STRANGER.length]);
    assert.equal(errors.at(-1), CRYPT_E_NOT_FOUND);
    assert.equal(call('CertCloseStore', root, 0), 1);
    const named = call('CertOpenSystemStoreA', 0, put('MY'));
    assert.equal(call('CertEnumCertificatesInStore', named, 0), 0, 'MY starts empty');
    assert.equal(call('CertOpenStore', 10, 0, 0, 0x4000, put(new Uint8Array([88, 0, 0, 0]))), 0,
        'a system store that does not exist is not opened when it must exist');
    assert.equal(call('CertGetCertificateChain', 0, 0x1234, 0, 0, put(new Uint8Array(16)), 0, 0,
        put(new Uint8Array(4))), 0);
    assert.equal(errors.at(-1), E_INVALIDARG, 'a context that is none');
});

test('a name matches a pattern whole, a wildcard only as the leftmost label', ()=>{
    assert.ok(nameMatches('example.test', 'EXAMPLE.test.'));
    assert.ok(nameMatches('*.example.test', 'a.example.test'));
    assert.ok(!nameMatches('*.example.test', 'example.test'));
    assert.ok(!nameMatches('*.example.test', 'a.b.example.test'));
    assert.ok(!nameMatches('*.test', 'example.test'), 'a wildcard over a top-level name');
    assert.ok(!nameMatches('example.test', 'xexample.test'));
});
