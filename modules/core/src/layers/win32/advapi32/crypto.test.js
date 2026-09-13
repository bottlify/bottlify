/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCryptoFunctions } from './crypto.js';

/* The contract's numbers, restated here so a wrong constant in the module
 * cannot be hidden by the test importing it. */
const CALG_MD5 = 0x8003;
const CALG_SHA1 = 0x8004;
const CALG_SHA256 = 0x800c;
const CALG_RC4 = 0x6801;
const CALG_RSA_SIGN = 0x2400;

const HP_ALGID = 1;
const HP_HASHVAL = 2;
const HP_HASHSIZE = 4;

const PROV_RSA_FULL = 1;
const CRYPT_VERIFYCONTEXT = 0xf0000000;
const CRYPT_NEWKEYSET = 0x8;
const CRYPT_EXPORTABLE = 0x1;

const PUBLICKEYBLOB = 6;
const PLAINTEXTKEYBLOB = 8;
const RSA1_MAGIC = 0x31415352;

const NTE_BAD_HASH = 0x80090002;
const NTE_BAD_KEY = 0x80090003;
const NTE_BAD_DATA = 0x80090005;
const NTE_BAD_SIGNATURE = 0x80090006;
const NTE_BAD_ALGID = 0x80090008;
const NTE_BAD_TYPE = 0x8009000a;
const NTE_BAD_HASH_STATE = 0x8009000c;
const NTE_BAD_KEYSET = 0x80090016;
const NTE_BAD_PROV_TYPE = 0x80090017;
const ERROR_MORE_DATA = 234;

/** A fixed 512-bit RSA key; the round trip m -> m^e -> ^d was checked. */
const RSA_N = BigInt('0x' + [
    'e199e4349acd0682cf3cab7eab7cc943fd1f83895aa9874049af199350622f48',
    'fd1870872808befeec05a167546c28e9653c4becf9f0eedb2733f9ea5da535e9',
].join(''));
const RSA_D = BigInt('0x' + [
    '18a701e673b20acf9988c62eb9db917cc1f8c31d6bd051acc740809975f3bcb9',
    'd7105f1dcd87cfc2cee213110d5208dc39d14d8308fd30f1b19477a35b851ad9',
].join(''));

/** The PKCS#1 v1.5 DigestInfo prefix for SHA-1, from the standard. */
const SHA1_PREFIX = [0x30, 0x21, 0x30, 0x09, 0x06, 0x05, 0x2b, 0x0e, 0x03,
    0x02, 0x1a, 0x05, 0x00, 0x04, 0x14];

/** @param {bigint} base @param {bigint} exp @param {bigint} mod */
function modPow(base, exp, mod){
    let r = 1n;
    let b = ((base % mod) + mod) % mod;
    let e = exp;
    while (e > 0n)
    {
        if ((e & 1n) === 1n)
        {
            r = (r * b) % mod;
        }
        e >>= 1n;
        b = (b * b) % mod;
    }
    return r;
}

/** @param {Uint8Array} bytes big-endian @returns {bigint} */
function beToBigInt(bytes){
    let v = 0n;
    for (const byte of bytes)
    {
        v = (v << 8n) | BigInt(byte);
    }
    return v;
}

/** @param {bigint} value @param {number} length @returns {Uint8Array} little-endian */
function bigIntToLe(value, length){
    const out = new Uint8Array(length);
    let v = value;
    for (let i = 0; i < length; i++)
    {
        out[i] = Number(v & 0xffn);
        v >>= 8n;
    }
    return out;
}

/** Addresses the fixtures use; nothing about them matters but that they differ. */
const OUT = 0x400;
const CONTAINER = 0x410;
const DATA = 0x500;
const BUFFER = 0x600;
const SIZE = 0x700;
const BLOB = 0x800;

/**
 * Guest memory as a flat array. `readMemory` hands back a view rather than a
 * copy, exactly as the real memory layer may, so the module has to copy what
 * it keeps.
 */
function setup(){
    const bytes = new Uint8Array(0x4000);
    /** @type {{ lastError: number, divergences: { api: string, detail: string }[] }} */
    const state = { lastError: 0, divergences: [] };
    const fns = createCryptoFunctions({
        /** @param {number} a @param {number} l */
        readMemory: (a, l)=>bytes.subarray(a, a + l),
        /** @param {number} a @param {Uint8Array} d */
        writeMemory: (a, d)=>bytes.set(d, a),
        /** @param {number} a @param {number} max */
        readCString(a, max){
            let text = '';
            for (let i = 0; i < max && bytes[a + i] !== 0; i++)
            {
                text += String.fromCharCode(bytes[a + i]);
            }
            return text;
        },
        /** @param {number} code */
        setLastError: code=>{
            state.lastError = code;
        },
        /** @param {string} api @param {string} detail */
        divergence: (api, detail)=>{
            state.divergences.push({ api, detail });
        },
    });

    /** @param {number} at @param {number} value */
    const putDword = (at, value)=>{
        for (let i = 0; i < 4; i++)
        {
            bytes[at + i] = (value >>> (i * 8)) & 0xff;
        }
    };
    /** @param {number} at */
    const getDword = at=>((bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)
        | (bytes[at + 3] << 24)) >>> 0);
    /** @param {number} at @param {Uint8Array} data */
    const putBytes = (at, data)=>bytes.set(data, at);
    /** @param {number} at @param {number} length */
    const getBytes = (at, length)=>bytes.slice(at, at + length);
    /** @param {number} at @param {string} text */
    const putAnsi = (at, text)=>{
        for (let i = 0; i < text.length; i++)
        {
            bytes[at + i] = text.charCodeAt(i) & 0xff;
        }
        bytes[at + text.length] = 0;
    };

    /** Acquires a verify-context provider and returns its handle. */
    const acquire = ()=>{
        assert.equal(fns.CryptAcquireContextA.handler(
            [OUT, 0, 0, PROV_RSA_FULL, CRYPT_VERIFYCONTEXT]), 1);
        return getDword(OUT);
    };

    /** @param {number} prov @param {number} algid @param {Uint8Array} data */
    const hashOf = (prov, algid, data)=>{
        assert.equal(fns.CryptCreateHash.handler([prov, algid, 0, 0, OUT]), 1);
        const hash = getDword(OUT);
        putBytes(DATA, data);
        assert.equal(fns.CryptHashData.handler([hash, DATA, data.length, 0]), 1);
        return hash;
    };

    /** @param {number} hash @returns {Uint8Array} the finalised value */
    const valueOf = hash=>{
        putDword(SIZE, 64);
        assert.equal(fns.CryptGetHashParam.handler([hash, HP_HASHVAL, BUFFER, SIZE, 0]), 1);
        return getBytes(BUFFER, getDword(SIZE));
    };

    return { fns, state, bytes, putDword, getDword, putBytes, getBytes, putAnsi,
        acquire, hashOf, valueOf };
}

/** @param {Uint8Array} bytes */
const hex = bytes=>[...bytes].map(b=>b.toString(16).padStart(2, '0')).join('');

/** @param {string} text */
const ascii = text=>{
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++)
    {
        out[i] = text.charCodeAt(i) & 0xff;
    }
    return out;
};

test('MD5 answers the RFC 1321 vectors', ()=>{
    const { acquire, hashOf, valueOf } = setup();
    const prov = acquire();
    const vectors = [
        ['', 'd41d8cd98f00b204e9800998ecf8427e'],
        ['abc', '900150983cd24fb0d6963f7d28e17f72'],
        ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
        ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
    ];
    for (const [text, want] of vectors)
    {
        assert.equal(hex(valueOf(hashOf(prov, CALG_MD5, ascii(text)))), want, text);
    }
});

test('SHA-1 answers the FIPS 180 vectors', ()=>{
    const { acquire, hashOf, valueOf } = setup();
    const prov = acquire();
    const long = 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq';
    const vectors = [
        ['abc', 'a9993e364706816aba3e25717850c26c9cd0d89d'],
        [long, '84983e441c3bd26ebaae4aa1f95129e5e54670f1'],
    ];
    for (const [text, want] of vectors)
    {
        assert.equal(hex(valueOf(hashOf(prov, CALG_SHA1, ascii(text)))), want, text);
    }
});

test('SHA-256 answers the FIPS 180 vector', ()=>{
    const { acquire, hashOf, valueOf } = setup();
    const prov = acquire();
    assert.equal(hex(valueOf(hashOf(prov, CALG_SHA256, ascii('abc')))),
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('a hash fed in pieces matches one fed whole', ()=>{
    const { fns, acquire, valueOf, putBytes, getDword } = setup();
    const prov = acquire();
    const text = ascii('abcdefghij'.repeat(20)); // 200 bytes, past several blocks
    assert.equal(fns.CryptCreateHash.handler([prov, CALG_SHA1, 0, 0, OUT]), 1);
    const whole = getDword(OUT);
    putBytes(DATA, text);
    assert.equal(fns.CryptHashData.handler([whole, DATA, text.length, 0]), 1);
    const want = hex(valueOf(whole));

    assert.equal(fns.CryptCreateHash.handler([prov, CALG_SHA1, 0, 0, OUT]), 1);
    const pieces = getDword(OUT);
    // Chunks that straddle the 64-byte block boundary in awkward places.
    let at = 0;
    for (const size of [1, 7, 63, 64, 65])
    {
        const piece = text.subarray(at, at + size);
        putBytes(DATA, piece);
        assert.equal(fns.CryptHashData.handler([pieces, DATA, piece.length, 0]), 1);
        at += size;
    }
    assert.equal(hex(valueOf(pieces)), want);
});

test('reading HP_HASHVAL finalises the hash and later data is refused', ()=>{
    const { fns, state, acquire, hashOf, valueOf, putBytes } = setup();
    const prov = acquire();
    const hash = hashOf(prov, CALG_MD5, ascii('abc'));
    assert.equal(valueOf(hash).length, 16);
    putBytes(DATA, ascii('more'));
    assert.equal(fns.CryptHashData.handler([hash, DATA, 4, 0]), 0);
    assert.equal(state.lastError, NTE_BAD_HASH_STATE);
});

test('HP_HASHSIZE and HP_ALGID report the algorithm, an unknown one is refused', ()=>{
    const { fns, state, acquire, putDword, getDword } = setup();
    const prov = acquire();
    assert.equal(fns.CryptCreateHash.handler([prov, CALG_SHA256, 0, 0, OUT]), 1);
    const hash = getDword(OUT);
    putDword(SIZE, 4);
    assert.equal(fns.CryptGetHashParam.handler([hash, HP_HASHSIZE, BUFFER, SIZE, 0]), 1);
    assert.equal(getDword(BUFFER), 32);
    putDword(SIZE, 4);
    assert.equal(fns.CryptGetHashParam.handler([hash, HP_ALGID, BUFFER, SIZE, 0]), 1);
    assert.equal(getDword(BUFFER), CALG_SHA256);
    assert.equal(fns.CryptCreateHash.handler([prov, 0x8009, 0, 0, OUT]), 0);
    assert.equal(state.lastError, NTE_BAD_ALGID);
});

test('a short value buffer reports the size it needed', ()=>{
    const { fns, state, acquire, hashOf, putDword, getDword } = setup();
    const prov = acquire();
    const hash = hashOf(prov, CALG_SHA1, ascii('abc'));
    putDword(SIZE, 4);
    assert.equal(fns.CryptGetHashParam.handler([hash, HP_HASHVAL, BUFFER, SIZE, 0]), 0);
    assert.equal(state.lastError, ERROR_MORE_DATA);
    assert.equal(getDword(SIZE), 20);
});

test('an unknown container fails until it is created with CRYPT_NEWKEYSET', ()=>{
    const { fns, state, getDword, putAnsi } = setup();
    putAnsi(CONTAINER, 'InstallShield');
    assert.equal(fns.CryptAcquireContextA.handler([OUT, CONTAINER, 0, PROV_RSA_FULL, 0]), 0);
    assert.equal(state.lastError, NTE_BAD_KEYSET);
    assert.equal(fns.CryptAcquireContextA.handler(
        [OUT, CONTAINER, 0, PROV_RSA_FULL, CRYPT_NEWKEYSET]), 1);
    const created = getDword(OUT);
    // Now that it exists, acquiring it again without the flag succeeds.
    assert.equal(fns.CryptAcquireContextA.handler([OUT, CONTAINER, 0, PROV_RSA_FULL, 0]), 1);
    assert.equal(fns.CryptReleaseContext.handler([created, 0]), 1);
});

test('an unknown provider type is refused', ()=>{
    const { fns, state } = setup();
    assert.equal(fns.CryptAcquireContextA.handler(
        [OUT, 0, 0, 999, CRYPT_VERIFYCONTEXT]), 0);
    assert.equal(state.lastError, NTE_BAD_PROV_TYPE);
});

test('releasing a provider frees the hashes it handed out', ()=>{
    const { fns, state, acquire, hashOf, putBytes } = setup();
    const prov = acquire();
    const hash = hashOf(prov, CALG_MD5, ascii('abc'));
    assert.equal(fns.CryptReleaseContext.handler([prov, 0]), 1);
    putBytes(DATA, ascii('x'));
    assert.equal(fns.CryptHashData.handler([hash, DATA, 1, 0]), 0);
    assert.equal(state.lastError, NTE_BAD_HASH);
});

test('a derived RC4 key encrypts and decrypts back to the plaintext', ()=>{
    const { fns, acquire, hashOf, putBytes, putDword, getDword, getBytes } = setup();
    const prov = acquire();
    const hash = hashOf(prov, CALG_MD5, ascii('secret seed'));
    // dwFlags top 16 bits name the key length; 128 bits for RC4.
    assert.equal(fns.CryptDeriveKey.handler([prov, CALG_RC4, hash, 128 << 16, OUT]), 1);
    const key = getDword(OUT);
    const plain = ascii('attack at dawn');
    putBytes(BUFFER, plain);
    putDword(SIZE, plain.length);
    assert.equal(fns.CryptEncrypt.handler([key, 0, 1, 0, BUFFER, SIZE, 256]), 1);
    assert.equal(getDword(SIZE), plain.length);
    const cipher = getBytes(BUFFER, plain.length);
    assert.notEqual(hex(cipher), hex(plain));
    putBytes(BUFFER, cipher);
    putDword(SIZE, cipher.length);
    assert.equal(fns.CryptDecrypt.handler([key, 0, 1, 0, BUFFER, SIZE]), 1);
    assert.deepEqual(getBytes(BUFFER, cipher.length), plain);
});

test('a generated RC4 key round-trips and CryptGenRandom fills the buffer', ()=>{
    const { fns, acquire, putBytes, putDword, getDword, getBytes } = setup();
    const prov = acquire();
    assert.equal(fns.CryptGenKey.handler([prov, CALG_RC4, CRYPT_EXPORTABLE, OUT]), 1);
    const key = getDword(OUT);
    const plain = ascii('round trip me');
    putBytes(BUFFER, plain);
    putDword(SIZE, plain.length);
    assert.equal(fns.CryptEncrypt.handler([key, 0, 1, 0, BUFFER, SIZE, 256]), 1);
    const cipher = getBytes(BUFFER, plain.length);
    putBytes(BUFFER, cipher);
    putDword(SIZE, cipher.length);
    assert.equal(fns.CryptDecrypt.handler([key, 0, 1, 0, BUFFER, SIZE]), 1);
    assert.deepEqual(getBytes(BUFFER, cipher.length), plain);

    const zeros = new Uint8Array(32);
    putBytes(BUFFER, zeros);
    assert.equal(fns.CryptGenRandom.handler([prov, 32, BUFFER]), 1);
    assert.notEqual(hex(getBytes(BUFFER, 32)), hex(zeros));
});

test('a plaintext key blob imports, and an exportable one exports back', ()=>{
    const { fns, acquire, putBytes, putDword, getDword, getBytes } = setup();
    const prov = acquire();
    const keyBytes = ascii('0123456789abcd'); // a 128-bit RC4 key
    const blob = new Uint8Array(8 + 4 + keyBytes.length);
    blob[0] = PLAINTEXTKEYBLOB;
    blob[1] = 2;
    blob.set(new Uint8Array([CALG_RC4 & 0xff, (CALG_RC4 >>> 8) & 0xff, 0, 0]), 4);
    blob.set(new Uint8Array([keyBytes.length, 0, 0, 0]), 8);
    blob.set(keyBytes, 12);
    putBytes(BLOB, blob);
    assert.equal(fns.CryptImportKey.handler(
        [prov, BLOB, blob.length, 0, CRYPT_EXPORTABLE, OUT]), 1);
    const key = getDword(OUT);

    putDword(SIZE, 0);
    assert.equal(fns.CryptExportKey.handler([key, 0, PLAINTEXTKEYBLOB, 0, 0, SIZE]), 1);
    const needed = getDword(SIZE);
    assert.equal(needed, blob.length);
    assert.equal(fns.CryptExportKey.handler([key, 0, PLAINTEXTKEYBLOB, 0, BUFFER, SIZE]), 1);
    assert.deepEqual(getBytes(BUFFER, needed), blob);
});

test('an RSA public key verifies a real signature and rejects a tampered one', ()=>{
    const { fns, state, acquire, hashOf, valueOf, putBytes, getDword } = setup();
    const prov = acquire();
    const message = ascii('verify me');
    const hash = hashOf(prov, CALG_SHA1, message);
    const digest = valueOf(hash);

    // The encoded message: 00 01 <0xff pad> 00 <DigestInfo> <hash>, 64 bytes.
    const em = new Uint8Array(64);
    em[0] = 0;
    em[1] = 1;
    const tLen = SHA1_PREFIX.length + digest.length;
    let at = 2;
    while (at < 64 - tLen - 1)
    {
        em[at++] = 0xff;
    }
    em[at++] = 0;
    for (const byte of SHA1_PREFIX)
    {
        em[at++] = byte;
    }
    em.set(digest, at);
    const signature = bigIntToLe(modPow(beToBigInt(em), RSA_D, RSA_N), 64);

    // Import the public key as a PUBLICKEYBLOB: header, RSAPUBKEY, LE modulus.
    const modulus = bigIntToLe(RSA_N, 64);
    const blob = new Uint8Array(8 + 12 + 64);
    blob[0] = PUBLICKEYBLOB;
    blob[1] = 2;
    blob.set(new Uint8Array([CALG_RSA_SIGN & 0xff, (CALG_RSA_SIGN >>> 8) & 0xff, 0, 0]), 4);
    blob.set(new Uint8Array([RSA1_MAGIC & 0xff, (RSA1_MAGIC >>> 8) & 0xff,
        (RSA1_MAGIC >>> 16) & 0xff, (RSA1_MAGIC >>> 24) & 0xff]), 8);
    blob.set(new Uint8Array([0, 2, 0, 0]), 12); // bitlen 512, little-endian
    blob.set(new Uint8Array([0x01, 0x00, 0x01, 0x00]), 16); // pubexp 65537
    blob.set(modulus, 20);
    putBytes(BLOB, blob);
    assert.equal(fns.CryptImportKey.handler([prov, BLOB, blob.length, 0, 0, OUT]), 1);
    const pub = getDword(OUT);

    putBytes(DATA, signature);
    assert.equal(fns.CryptVerifySignatureA.handler(
        [hash, DATA, 64, pub, 0, 0]), 1);

    const tampered = signature.slice();
    tampered[10] ^= 0xff;
    putBytes(DATA, tampered);
    assert.equal(fns.CryptVerifySignatureA.handler([hash, DATA, 64, pub, 0, 0]), 0);
    assert.equal(state.lastError, NTE_BAD_SIGNATURE);
});

test('a public key blob exports back the way it was imported', ()=>{
    const { fns, acquire, putBytes, putDword, getDword, getBytes } = setup();
    const prov = acquire();
    const modulus = bigIntToLe(RSA_N, 64);
    const blob = new Uint8Array(8 + 12 + 64);
    blob[0] = PUBLICKEYBLOB;
    blob[1] = 2;
    blob.set(new Uint8Array([CALG_RSA_SIGN & 0xff, (CALG_RSA_SIGN >>> 8) & 0xff, 0, 0]), 4);
    blob.set(new Uint8Array([RSA1_MAGIC & 0xff, (RSA1_MAGIC >>> 8) & 0xff,
        (RSA1_MAGIC >>> 16) & 0xff, (RSA1_MAGIC >>> 24) & 0xff]), 8);
    blob.set(new Uint8Array([0, 2, 0, 0]), 12);
    blob.set(new Uint8Array([0x01, 0x00, 0x01, 0x00]), 16);
    blob.set(modulus, 20);
    putBytes(BLOB, blob);
    assert.equal(fns.CryptImportKey.handler([prov, BLOB, blob.length, 0, 0, OUT]), 1);
    const pub = getDword(OUT);
    putDword(SIZE, 0);
    assert.equal(fns.CryptExportKey.handler([pub, 0, PUBLICKEYBLOB, 0, 0, SIZE]), 1);
    assert.equal(getDword(SIZE), blob.length);
    putDword(SIZE, blob.length);
    assert.equal(fns.CryptExportKey.handler([pub, 0, PUBLICKEYBLOB, 0, BUFFER, SIZE]), 1);
    assert.deepEqual(getBytes(BUFFER, blob.length), blob);
});

test('signing without a private key fails, and a bad blob is refused', ()=>{
    const { fns, state, acquire, hashOf, putBytes, putDword } = setup();
    const prov = acquire();
    const hash = hashOf(prov, CALG_MD5, ascii('abc'));
    putBytes(BUFFER, new Uint8Array(64));
    putDword(SIZE, 64);
    assert.equal(fns.CryptSignHashA.handler([hash, 2, 0, 0, BUFFER, SIZE]), 0);
    assert.equal(state.lastError, NTE_BAD_KEY);

    // An unknown blob type is refused outright.
    putBytes(BLOB, new Uint8Array([9, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    assert.equal(fns.CryptImportKey.handler([prov, BLOB, 12, 0, 0, OUT]), 0);
    assert.equal(state.lastError, NTE_BAD_TYPE);

    // A plaintext blob that claims more key bytes than it carries is bad data.
    putBytes(BLOB, new Uint8Array([PLAINTEXTKEYBLOB, 2, 0, 0,
        CALG_RC4 & 0xff, (CALG_RC4 >>> 8) & 0xff, 0, 0, 100, 0, 0, 0]));
    assert.equal(fns.CryptImportKey.handler([prov, BLOB, 12, 0, 0, OUT]), 0);
    assert.equal(state.lastError, NTE_BAD_DATA);
});
