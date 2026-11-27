/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a TLS library asks of a certificate once it has one: finding it in a
 * store, its names, its properties and usages, a chain engine of its own,
 * the certificate inside a file or a signed message, and whether one
 * certificate signed another.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSha1 } from '../crypto/digest.js';
import { PROP } from './certificates.js';
import { CLIENT, INTERMEDIATE, LEAF, ROOT, STRANGER, setup } from './pki.fixtures.test.js';

const CRYPT_E_NOT_FOUND = 0x80092004;
const ERROR_MORE_DATA = 234;
const CRYPT_E_NO_MATCH = 0x80092009;
const NTE_BAD_SIGNATURE = 0x80090006;
const CRYPT_E_NO_KEY_PROPERTY = 0x8009200b;
const SERVER_AUTH = '1.3.6.1.5.5.7.3.1';

/** @param {Uint8Array} bytes */
const sha1 = bytes=>{
    const digest = createSha1();
    digest.update(bytes);
    return [...digest.digest()];
};

/** Strings out of guest memory. @param {Uint8Array} bytes */
const readers = bytes=>({
    ascii: (/** @type {number} */ at)=>{
        let text = '';
        for (let i = at; bytes[i] !== 0; i++)
        {
            text += String.fromCharCode(bytes[i]);
        }
        return text;
    },
    wide: (/** @type {number} */ at)=>{
        let text = '';
        for (let i = at; bytes[i] !== 0 || bytes[i + 1] !== 0; i += 2)
        {
            text += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
        }
        return text;
    },
});

/** A memory store holding `certificates`, and the machine. @param {Uint8Array[]} certificates */
function storeOf(certificates, options = {}){
    const machine = setup(options);
    const store = machine.call('CertOpenStore', 2, 0, 0, 0, 0);
    for (const one of certificates)
    {
        machine.call('CertAddEncodedCertificateToStore', store, 1, machine.put(one), one.length,
            4, 0);
    }
    return { ...machine, store };
}

/** Writes a dword by address into the machine `pokeable` made last. */
let poke = /** @type {(at: number, value: number) => void} */ (()=>{});

/** A store of `certificates` on a machine whose dwords `poke` writes. */
function pokeable(/** @type {Uint8Array[]} */ certificates, options = {}){
    const machine = storeOf(certificates, options);
    poke = (at, value)=>machine.view.setUint32(at, value >>> 0, true);
    return machine;
}

test('a store is searched by name, string, hash, usage and the certificate itself', ()=>{
    const { call, put, wide, store, errors, u32, divergences } = pokeable(
        [ROOT, INTERMEDIATE, LEAF, CLIENT]);
    /** @param {number} type @param {number} para @param {number} [flags] */
    const all = (type, para, flags = 0)=>{
        const found = [];
        for (let at = call('CertFindCertificateInStore', store, 1, flags, type, para, 0); at !== 0;
            at = call('CertFindCertificateInStore', store, 1, flags, type, para, at))
        {
            found.push(u32(at + 8));
        }
        return found;
    };
    assert.deepEqual(all(0, 0), [ROOT.length, INTERMEDIATE.length, LEAF.length, CLIENT.length],
        'CERT_FIND_ANY');
    assert.equal(errors.at(-1), CRYPT_E_NOT_FOUND);
    assert.deepEqual(all(0x80007, wide('example.TEST')), [LEAF.length, CLIENT.length],
        'CERT_FIND_SUBJECT_STR_W, a part of a value, case aside');
    assert.deepEqual(all(0x70004, put('Intermediate')), [LEAF.length, CLIENT.length],
        'CERT_FIND_ISSUER_STR_A');
    const hash = put(new Uint8Array(8));
    poke(hash, 20);
    poke(hash + 4, put(Uint8Array.from(sha1(INTERMEDIATE))));
    assert.deepEqual(all(0x10000, hash), [INTERMEDIATE.length], 'CERT_FIND_SHA1_HASH');
    const usage = put(new Uint8Array(8));
    const list = put(new Uint8Array(4));
    poke(list, put(SERVER_AUTH));
    poke(usage, 1);
    poke(usage + 4, list);
    assert.deepEqual(all(0xa0000, usage), [ROOT.length, INTERMEDIATE.length, LEAF.length],
        'CERT_FIND_ENHKEY_USAGE: no extension is every usage');
    assert.deepEqual(all(0xa0000, usage, 0x2), [LEAF.length], 'only the extension\'s say');
    const leaf = call('CertCreateCertificateContext', 1, put(LEAF), LEAF.length);
    assert.deepEqual(all(0xd0000, leaf), [LEAF.length], 'CERT_FIND_EXISTING');
    assert.deepEqual(all(0xc0000, leaf), [INTERMEDIATE.length], 'CERT_FIND_ISSUER_OF');
    assert.deepEqual(all(0x150000, 0), [], 'no private keys');
    assert.deepEqual(all(0x110000, 0), [], 'a find type not provided finds nothing');
    assert.ok(divergences.some(line=>line.startsWith('CertFindCertificateInStore')));
});

test('names: simple, DNS, email-less, RDN in X.500 form, an attribute, the issuer\'s', ()=>{
    const { call, put, bytes } = pokeable([]);
    const { ascii, wide: readWide } = readers(bytes);
    const leaf = call('CertCreateCertificateContext', 1, put(LEAF), LEAF.length);
    /** @param {number} type @param {number} [flags] @param {number} [para] */
    const nameA = (type, flags = 0, para = 0)=>{
        const size = call('CertGetNameStringA', leaf, type, flags, para, 0, 0);
        const out = put(new Uint8Array(size));
        assert.equal(call('CertGetNameStringA', leaf, type, flags, para, out, size), size);
        return ascii(out);
    };
    assert.equal(nameA(4), 'www.example.test', 'CERT_NAME_SIMPLE_DISPLAY_TYPE');
    assert.equal(nameA(4, 1), 'Test Intermediate', 'the issuer\'s');
    assert.equal(nameA(6), '*.example.test', 'CERT_NAME_DNS_TYPE: the first DNS name');
    assert.equal(nameA(1), '', 'no email');
    assert.equal(call('CertGetNameStringA', leaf, 1, 0, 0, 0, 0), 1, 'the empty name is 1');
    assert.equal(nameA(2), 'CN=www.example.test', 'CERT_NAME_RDN_TYPE');
    assert.equal(nameA(3, 0, put('2.5.4.3')), 'www.example.test', 'CERT_NAME_ATTR_TYPE');
    const out = put(new Uint8Array(16));
    assert.equal(call('CertGetNameStringW', leaf, 4, 0, 0, out, 4), 4, 'cut to the buffer');
    assert.equal(readWide(out), 'www');
    // A friendly name, set as a blob of UTF-16, is the friendly display name.
    const text = put(Uint8Array.of(70, 0, 114, 0, 0, 0));
    const blob = put(new Uint8Array(8));
    poke(blob, 6);
    poke(blob + 4, text);
    assert.equal(call('CertSetCertificateContextProperty', leaf, PROP.FRIENDLY_NAME, 0, blob), 1);
    assert.equal(nameA(5), 'Fr', 'CERT_NAME_FRIENDLY_DISPLAY_TYPE');
});

test('properties: hashes computed, blobs kept, the key provider laid out where it is read', ()=>{
    const { call, put, bytes, errors, u32, wide } = pokeable([]);
    const { wide: readWide } = readers(bytes);
    const leaf = call('CertCreateCertificateContext', 1, put(LEAF), LEAF.length);
    const size = put(new Uint8Array(4));
    assert.equal(call('CertGetCertificateContextProperty', leaf, PROP.SHA1_HASH, 0, size), 1);
    assert.equal(u32(size), 20);
    poke(size, 4);
    const out = put(new Uint8Array(32));
    assert.equal(call('CertGetCertificateContextProperty', leaf, PROP.SHA1_HASH, out, size), 0);
    assert.equal(errors.at(-1), ERROR_MORE_DATA);
    assert.equal(u32(size), 20, 'the size it needs');
    assert.equal(call('CertGetCertificateContextProperty', leaf, PROP.SHA1_HASH, out, size), 1);
    assert.deepEqual([...bytes.subarray(out, out + 20)], sha1(LEAF));
    assert.equal(call('CertGetCertificateContextProperty', leaf, PROP.KEY_PROV_INFO, 0, size), 0);
    assert.equal(errors.at(-1), CRYPT_E_NOT_FOUND);

    const info = put(new Uint8Array(28));
    poke(info, wide('container'));
    poke(info + 4, wide('Microsoft Enhanced Cryptographic Provider v1.0'));
    poke(info + 8, 1);
    poke(info + 24, 1);
    assert.equal(call('CertSetCertificateContextProperty', leaf, PROP.KEY_PROV_INFO, 0, info), 1);
    poke(size, 0);
    call('CertGetCertificateContextProperty', leaf, PROP.KEY_PROV_INFO, 0, size);
    const record = put(new Uint8Array(u32(size)));
    assert.equal(call('CertGetCertificateContextProperty', leaf, PROP.KEY_PROV_INFO, record,
        size), 1);
    assert.equal(readWide(u32(record)), 'container', 'its pointers point into the copy');
    assert.equal(readWide(u32(record + 4)), 'Microsoft Enhanced Cryptographic Provider v1.0');
    assert.deepEqual([u32(record + 8), u32(record + 24)], [1, 1]);
    assert.equal(call('CertSetCertificateContextProperty', leaf, PROP.KEY_PROV_INFO, 0, 0), 1);
    assert.equal(call('CertGetCertificateContextProperty', leaf, PROP.KEY_PROV_INFO, 0, size), 0,
        'set to NULL, gone');
    assert.equal(call('CryptAcquireCertificatePrivateKey', leaf, 0, 0, 0, 0, 0), 0);
    assert.equal(errors.at(-1), CRYPT_E_NO_KEY_PROPERTY);
});

test('usages, time validity, extensions and names compared', ()=>{
    const { call, put, bytes, errors, u32 } = pokeable([]);
    const { ascii } = readers(bytes);
    const leaf = call('CertCreateCertificateContext', 1, put(LEAF), LEAF.length);
    const root = call('CertCreateCertificateContext', 1, put(ROOT), ROOT.length);
    const size = put(new Uint8Array(4));
    assert.equal(call('CertGetEnhancedKeyUsage', leaf, 0, 0, size), 1);
    const usage = put(new Uint8Array(u32(size)));
    assert.equal(call('CertGetEnhancedKeyUsage', leaf, 0, usage, size), 1);
    assert.equal(u32(usage), 1);
    assert.equal(ascii(u32(u32(usage + 4))), SERVER_AUTH);
    assert.equal(call('CertGetEnhancedKeyUsage', root, 0, usage, size), 1);
    assert.equal(u32(usage), 0, 'no restriction');
    assert.equal(errors.at(-1), CRYPT_E_NOT_FOUND, 'valid for every usage');

    const info = u32(leaf + 12);
    assert.equal(call('CertVerifyTimeValidity', 0, info), 0, 'valid now (2030)');
    const early = put(new Uint8Array(8));
    new DataView(bytes.buffer).setBigUint64(early, (BigInt(Date.UTC(2020, 0, 1))
        + 11644473600000n) * 10000n, true);
    assert.equal(call('CertVerifyTimeValidity', early, info) | 0, -1, 'not yet');
    new DataView(bytes.buffer).setBigUint64(early, (BigInt(Date.UTC(2040, 0, 1))
        + 11644473600000n) * 10000n, true);
    assert.equal(call('CertVerifyTimeValidity', early, info), 1, 'expired');

    const keyUsage = put(new Uint8Array(2));
    assert.equal(call('CertGetIntendedKeyUsage', 1, info, keyUsage, 2), 1);
    assert.equal(bytes[keyUsage], 0xa0, 'digitalSignature and keyEncipherment');
    const extensions = u32(info + 108);
    const found = call('CertFindExtension', put('2.5.29.17'), u32(info + 104), extensions);
    assert.equal(ascii(u32(found)), '2.5.29.17');
    assert.equal(call('CertFindExtension', put('1.2.3'), u32(info + 104), extensions), 0);

    const rootInfo = u32(root + 12);
    assert.equal(call('CertCompareCertificateName', 1, rootInfo + 24, rootInfo + 48), 1,
        'a self-signed certificate\'s two names are one');
    assert.equal(call('CertCompareCertificateName', 1, info + 24, info + 48), 0);
});

test('a chain engine adds its stores and may trust a root store of its own', ()=>{
    const { call, put, u32, store, chain } = pokeable([INTERMEDIATE], { roots: [] });
    const roots = call('CertOpenStore', 2, 0, 0, 0, 0);
    call('CertAddEncodedCertificateToStore', roots, 1, put(ROOT), ROOT.length, 4, 0);
    const list = put(new Uint8Array(4));
    poke(list, store);
    const config = put(new Uint8Array(48));
    poke(config, 48);
    poke(config + 16, 1);
    poke(config + 20, list);
    poke(config + 40, roots);
    const out = put(new Uint8Array(4));
    assert.equal(call('CertCreateCertificateChainEngine', config, out), 1);
    const engine = u32(out);
    const leaf = call('CertCreateCertificateContext', 1, put(LEAF), LEAF.length);
    const parameters = put(new Uint8Array(16));
    poke(parameters, 16);
    const result = put(new Uint8Array(4));
    assert.equal(call('CertGetCertificateChain', engine, leaf, 0, 0, parameters, 0, 0, result), 1);
    const context = u32(result);
    assert.equal(u32(context + 4), 0, 'the engine\'s intermediate and its own root: trusted');
    assert.equal(u32(u32(u32(context + 16)) + 12), 3);
    call('CertFreeCertificateChain', context);
    // The default engine trusts no root here (the machine's roots are none).
    const plain = chain(leaf, [INTERMEDIATE]);
    assert.notEqual(plain.error, 0);
    call('CertFreeCertificateChainEngine', engine);
    assert.equal(call('CertFindChainInStore', store, 1, 0, 1, 0, 0), 0);
    assert.equal(call('CertControlStore', store, 0, 1, 0), 1, 'CERT_STORE_CTRL_RESYNC');
    assert.equal(call('CertControlStore', store, 0, 4, 0), 1, 'CERT_STORE_CTRL_AUTO_RESYNC');
});

test('CryptQueryObject finds a certificate in DER, in PEM and in a file', ()=>{
    const pem = new TextEncoder().encode(`-----BEGIN CERTIFICATE-----\n${
        btoa(String.fromCharCode(...LEAF)).match(/.{1,64}/g)?.join('\n')}\n-----END CERTIFICATE-----\n`);
    const { call, put, u32, errors, wide } = pokeable([], { files: { 'C:\\leaf.crt': LEAF } });
    const outs = put(new Uint8Array(24));
    /** @param {number} type @param {number} object @param {number} [formats] */
    const query = (type, object, formats = 0x6)=>call('CryptQueryObject', type, object, 0x2,
        formats, 0, outs, outs + 4, outs + 8, outs + 12, outs + 16, outs + 20);
    const blob = put(new Uint8Array(8));
    poke(blob, LEAF.length);
    poke(blob + 4, put(LEAF));
    assert.equal(query(2, blob), 1);
    assert.deepEqual([u32(outs), u32(outs + 4), u32(outs + 8)], [0x10001, 1, 1],
        'X509 and PKCS7, CERT_QUERY_CONTENT_CERT, binary');
    assert.equal(u32(u32(outs + 20) + 8), LEAF.length, 'the context');
    assert.equal(u32(call('CertEnumCertificatesInStore', u32(outs + 12), 0) + 8), LEAF.length,
        'and a store holding it');
    poke(blob, pem.length);
    poke(blob + 4, put(pem));
    assert.equal(query(2, blob), 1);
    assert.equal(u32(outs + 8), 2, 'CERT_QUERY_FORMAT_BASE64_ENCODED');
    assert.equal(query(2, blob, 0x2), 0, 'binary only');
    assert.equal(errors.at(-1), CRYPT_E_NO_MATCH);
    assert.equal(query(1, wide('C:\\leaf.crt')), 1);
    assert.equal(query(1, wide('C:\\none.crt')), 0);
    void STRANGER;
});

test('a signature is checked against an issuer\'s certificate, key or chain element', ()=>{
    const { call, put, u32, errors } = pokeable([]);
    const leaf = call('CertCreateCertificateContext', 1, put(LEAF), LEAF.length);
    const intermediate = call('CertCreateCertificateContext', 1, put(INTERMEDIATE),
        INTERMEDIATE.length);
    const root = call('CertCreateCertificateContext', 1, put(ROOT), ROOT.length);
    assert.equal(call('CryptVerifyCertificateSignatureEx', 0, 1, 2, leaf, 2, intermediate, 0, 0),
        1);
    assert.equal(call('CryptVerifyCertificateSignatureEx', 0, 1, 2, leaf, 2, root, 0, 0), 0);
    assert.equal(errors.at(-1), NTE_BAD_SIGNATURE);
    // CERT_PUBLIC_KEY_INFO is CERT_INFO's at +56.
    const key = u32(intermediate + 12) + 56;
    const blob = put(new Uint8Array(8));
    poke(blob, LEAF.length);
    poke(blob + 4, put(LEAF));
    assert.equal(call('CryptVerifyCertificateSignatureEx', 0, 1, 1, blob, 1, key, 0, 0), 1,
        'an encoded certificate against a public key');
});

test('a PKCS #7 message is a store of its certificates and answers CryptMsgGetParam', async()=>{
    const { derElement, oidContents } = await import('../crypto/x509.js');
    const signed = derElement(0x30, derElement(0x06, oidContents('1.2.840.113549.1.7.2')),
        derElement(0xa0, derElement(0x30, Uint8Array.of(0x02, 0x01, 0x01), derElement(0x31),
            derElement(0x30, derElement(0x06, oidContents('1.2.840.113549.1.7.1'))),
            derElement(0xa0, LEAF, INTERMEDIATE), derElement(0x31))));
    const { call, put, u32, bytes, errors } = pokeable([]);
    const blob = put(new Uint8Array(8));
    poke(blob, signed.length);
    poke(blob + 4, put(signed));
    const outs = put(new Uint8Array(24));
    assert.equal(call('CryptQueryObject', 2, blob, 1 << 8, 2, 0, outs, outs + 4, outs + 8,
        outs + 12, outs + 16, 0), 1);
    assert.equal(u32(outs + 4), 8, 'CERT_QUERY_CONTENT_PKCS7_SIGNED');
    const message = u32(outs + 16);
    const size = put(new Uint8Array(4));
    const out = put(new Uint8Array(4096));
    poke(size, 4096);
    assert.equal(call('CryptMsgGetParam', message, 11, 0, out, size), 1);
    assert.equal(u32(out), 2, 'CMSG_CERT_COUNT_PARAM');
    poke(size, 4096);
    assert.equal(call('CryptMsgGetParam', message, 12, 1, out, size), 1);
    assert.deepEqual([...bytes.subarray(out, out + u32(size))], [...INTERMEDIATE]);
    poke(size, 4096);
    assert.equal(call('CryptMsgGetParam', message, 5, 0, out, size), 1);
    assert.equal(u32(out), 0, 'no signers');
    assert.equal(call('CryptMsgGetParam', message, 7, 0, out, size), 0);
    assert.equal(errors.at(-1), 0x80091008, 'CRYPT_E_INVALID_INDEX');
    assert.equal(call('CryptMsgClose', message), 1);
    const store = u32(outs + 12);
    const first = call('CertEnumCertificatesInStore', store, 0);
    assert.equal(u32(first + 8), LEAF.length);
});
