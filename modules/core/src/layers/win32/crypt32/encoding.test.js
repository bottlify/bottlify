/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * crypt32's conversions: base64 and hex text both ways, a certificate's hash
 * by its CNG name, sealed memory, extension structures decoded and encoded,
 * and X.500 names from text and back.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { binaryToString, stringToBinary } from './encoding.js';
import { nameToString, stringToName } from './names.js';
import { createSha256 } from '../crypto/digest.js';
import { LEAF, setup } from './pki.fixtures.test.js';

const ERROR_MORE_DATA = 234;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INVALID_DATA = 13;
const ERROR_FILE_NOT_FOUND = 2;
const CRYPT_E_INVALID_X500_STRING = 0x80092023;

test('bytes as base64, PEM and hex text, and back', ()=>{
    const bytes = Uint8Array.from({ length: 50 }, (_, i)=>i * 5);
    const base64 = /** @type {string} */ (binaryToString(bytes, 1));
    assert.ok(base64.endsWith('\r\n'));
    assert.equal(base64.split('\r\n')[0].length, 64, 'lines of 64');
    assert.equal(binaryToString(bytes, 1 | 0x40000000)?.includes('\r'), false, 'NOCRLF');
    const pem = /** @type {string} */ (binaryToString(bytes, 0));
    assert.match(pem, /^-----BEGIN CERTIFICATE-----\r\n[\s\S]*-----END CERTIFICATE-----\r\n$/);
    assert.equal(binaryToString(Uint8Array.of(1, 0xab), 12), '01ab\r\n', 'HEXRAW');
    assert.equal(binaryToString(Uint8Array.from({ length: 10 }, (_, i)=>i), 4),
        '00 01 02 03 04 05 06 07  08 09\r\n', 'HEX: two spaces after the eighth');
    assert.equal(binaryToString(bytes, 99), null);
    for (const [text, format] of [[base64, 1], [pem, 0], ['01ab', 12], ['01 ab', 4]])
    {
        assert.ok(stringToBinary(String(text), Number(format)), String(format));
    }
    assert.deepEqual(stringToBinary(pem, 6)?.format, 0, 'BASE64_ANY finds the header');
    assert.deepEqual(stringToBinary(base64, 6)?.format, 1);
    assert.deepEqual([...stringToBinary('01ab', 12)?.bytes ?? []], [1, 0xab]);
    assert.equal(stringToBinary('not base64!', 1), null);
});

test('the A and W calls follow the size protocol', ()=>{
    const { call, put, u32, view, errors, bytes } = setup();
    const data = put(Uint8Array.of(0xde, 0xad, 0xbe, 0xef));
    const size = put(new Uint8Array(4));
    assert.equal(call('CryptBinaryToStringA', data, 4, 12, 0, size), 1);
    assert.equal(u32(size), 11, 'eight digits, CRLF and the terminator');
    view.setUint32(size, 5, true);
    const out = put(new Uint8Array(32));
    assert.equal(call('CryptBinaryToStringA', data, 4, 12, out, size), 0);
    assert.equal(errors.at(-1), ERROR_MORE_DATA);
    view.setUint32(size, 32, true);
    assert.equal(call('CryptBinaryToStringW', data, 4, 12, out, size), 1);
    assert.equal(u32(size), 10, 'without the terminator');
    assert.equal(bytes[out], 'd'.charCodeAt(0));
    assert.equal(bytes[out + 1], 0);

    const text = put('3q2+7w==');
    view.setUint32(size, 0, true);
    assert.equal(call('CryptStringToBinaryA', text, 0, 1, 0, size, 0, 0), 1);
    assert.equal(u32(size), 4);
    const flags = put(new Uint8Array(4));
    assert.equal(call('CryptStringToBinaryA', text, 0, 1, out, size, 0, flags), 1);
    assert.deepEqual([...bytes.subarray(out, out + 4)], [0xde, 0xad, 0xbe, 0xef]);
    assert.equal(u32(flags), 1);
    assert.equal(call('CryptStringToBinaryA', put('!!'), 0, 1, out, size, 0, 0), 0);
    assert.equal(errors.at(-1), ERROR_INVALID_DATA);
});

test('a certificate\'s hash by CNG name', ()=>{
    const { call, put, u32, bytes, wide, errors } = setup();
    const data = put(LEAF);
    const size = put(new Uint8Array(4));
    assert.equal(call('CryptHashCertificate2', wide('SHA256'), 0, 0, data, LEAF.length, 0, size),
        1);
    assert.equal(u32(size), 32);
    const out = put(new Uint8Array(32));
    assert.equal(call('CryptHashCertificate2', wide('sha256'), 0, 0, data, LEAF.length, out,
        size), 1);
    const digest = createSha256();
    digest.update(LEAF);
    assert.deepEqual([...bytes.subarray(out, out + 32)], [...digest.digest()]);
    assert.equal(call('CryptHashCertificate2', wide('MD2'), 0, 0, data, LEAF.length, out, size),
        0);
    assert.equal(errors.at(-1), 0x80090008);
});

test('sealed memory changes in place and comes back; its size is in blocks', ()=>{
    const { call, put, bytes, errors } = setup();
    const secret = Uint8Array.from({ length: 32 }, (_, i)=>i);
    const at = put(secret);
    assert.equal(call('CryptProtectMemory', at, 32, 0), 1);
    assert.notDeepEqual([...bytes.subarray(at, at + 32)], [...secret]);
    assert.equal(call('CryptUnprotectMemory', at, 32, 0), 1);
    assert.deepEqual([...bytes.subarray(at, at + 32)], [...secret]);
    assert.equal(call('CryptProtectMemory', at, 20, 0), 0);
    assert.equal(errors.at(-1), ERROR_INVALID_PARAMETER);
    // Another process's crypt32 opens what was sealed across processes.
    const other = setup();
    assert.equal(call('CryptProtectMemory', at, 32, 1), 1);
    const moved = other.put(bytes.slice(at, at + 32));
    assert.equal(other.call('CryptUnprotectMemory', moved, 32, 1), 1);
    assert.deepEqual([...other.bytes.subarray(moved, moved + 32)], [...secret]);
});

test('extension structures decode as wincrypt.h lays them out, and encode back', ()=>{
    const { call, put, u32, view, bytes, errors } = setup();
    const { ascii, wide } = {
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
    };
    const size = put(new Uint8Array(4));
    const out = put(new Uint8Array(4));
    /** @param {number | string} type @param {Uint8Array} der */
    const decode = (type, der)=>{
        const typePointer = typeof type === 'string' ? put(type) : type;
        assert.equal(call('CryptDecodeObjectEx', 1, typePointer, put(der), der.length, 0x8000, 0,
            out, size), 1);
        return u32(out);
    };
    const constraints = decode(15, Uint8Array.of(0x30, 0x06, 0x01, 0x01, 0xff, 0x02, 0x01, 0x03));
    assert.deepEqual([u32(constraints), u32(constraints + 4), u32(constraints + 8)], [1, 1, 3]);
    const usage = decode('2.5.29.37', Uint8Array.of(0x30, 0x0a, 0x06, 0x08, 0x2b, 0x06, 0x01, 0x05,
        0x05, 0x07, 0x03, 0x01));
    assert.equal(u32(usage), 1);
    assert.equal(ascii(u32(u32(usage + 4))), '1.3.6.1.5.5.7.3.1');
    // dNSName example.test and an IP address.
    const names = decode(12, Uint8Array.of(0x30, 0x14, 0x82, 0x0c, ...new TextEncoder().encode(
        'example.test'), 0x87, 0x04, 10, 0, 0, 1));
    assert.equal(u32(names), 2);
    const entries = u32(names + 4);
    assert.deepEqual([u32(entries), wide(u32(entries + 4))], [3, 'example.test']);
    assert.deepEqual([u32(entries + 12), u32(entries + 16)], [8, 4]);
    assert.deepEqual([...bytes.subarray(u32(entries + 20), u32(entries + 20) + 4)], [10, 0, 0, 1]);

    view.setUint32(size, 0, true);
    assert.equal(call('CryptDecodeObjectEx', 1, 15, put(Uint8Array.of(0x30, 0)), 2, 0, 0, 0,
        size), 1);
    assert.equal(u32(size), 12, 'the size asked first');
    assert.equal(call('CryptDecodeObjectEx', 1, 15, put(Uint8Array.of(0x04, 0)), 2, 0x8000, 0,
        out, size), 0);
    assert.equal(errors.at(-1), 0x8009310b, 'not the structure: a bad tag');
    assert.equal(call('CryptDecodeObjectEx', 1, 7, put(Uint8Array.of(0x30, 0)), 2, 0x8000, 0,
        out, size), 0);
    assert.equal(errors.at(-1), ERROR_FILE_NOT_FOUND, 'a type not decoded');

    view.setUint32(size, 64, true);
    const encoded = put(new Uint8Array(64));
    assert.equal(call('CryptEncodeObjectEx', 1, 15, constraints, 0, 0, encoded, size), 1);
    assert.deepEqual([...bytes.subarray(encoded, encoded + u32(size))],
        [0x30, 0x06, 0x01, 0x01, 0xff, 0x02, 0x01, 0x03]);
    view.setUint32(size, 64, true);
    assert.equal(call('CryptEncodeObjectEx', 1, put('2.5.29.37'), usage, 0, 0, encoded, size), 1);
    assert.equal(u32(size), 12);
});

test('X.500 names from text and back, quoting where a value needs it', ()=>{
    const parsed = stringToName('CN=www.example.test, O="Example, Inc.", C=US', 3);
    assert.ok('encoded' in parsed);
    const text = nameToString(/** @type {{ encoded: Uint8Array }} */ (parsed).encoded, 3);
    assert.equal(text, 'CN=www.example.test, O="Example, Inc.", C=US');
    assert.equal(nameToString(/** @type {{ encoded: Uint8Array }} */ (parsed).encoded, 1),
        'www.example.test, "Example, Inc.", US', 'CERT_SIMPLE_NAME_STR');
    assert.equal(nameToString(/** @type {{ encoded: Uint8Array }} */ (parsed).encoded,
        3 | 0x02000000), 'C=US, O="Example, Inc.", CN=www.example.test', 'reversed');
    const plus = stringToName('CN=a + OU=b; OID.1.2.3=x', 3);
    assert.equal(nameToString(/** @type {{ encoded: Uint8Array }} */ (plus).encoded, 2),
        '2.5.4.3=a + 2.5.4.11=b, 1.2.3=x', 'CERT_OID_NAME_STR');
    assert.deepEqual(stringToName('XX=1', 3), { error: 0 });
    assert.deepEqual(stringToName('CN=a, nonsense', 3), { error: 6 });

    const { call, put, u32, bytes, errors } = setup();
    const size = put(new Uint8Array(4));
    const source = put('CN=Test Root');
    assert.equal(call('CertStrToNameA', 1, source, 3, 0, 0, size, 0), 1);
    const out = put(new Uint8Array(u32(size)));
    assert.equal(call('CertStrToNameA', 1, source, 3, 0, out, size, 0), 1);
    assert.equal(nameToString(bytes.slice(out, out + u32(size)), 3), 'CN=Test Root');
    const error = put(new Uint8Array(4));
    const bad = put('CN=a, ZZ=b');
    assert.equal(call('CertStrToNameA', 1, bad, 3, 0, out, size, error), 0);
    assert.equal(errors.at(-1), CRYPT_E_INVALID_X500_STRING);
    assert.equal(u32(error), bad + 6, 'where it could not read on');
});
