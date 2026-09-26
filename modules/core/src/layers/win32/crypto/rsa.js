/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The RSA arithmetic every signature check here stands on: a modular
 * exponentiation over BigInt and the conversions between integers and the
 * byte orders their encodings use -- big-endian in DER and PKCS#1,
 * little-endian in the CryptoAPI's key blobs.
 */

/** @param {bigint} base @param {bigint} exp @param {bigint} mod */
export function modPow(base, exp, mod){
    let result = 1n;
    let b = ((base % mod) + mod) % mod;
    let e = exp;
    while (e > 0n)
    {
        if ((e & 1n) === 1n)
        {
            result = (result * b) % mod;
        }
        e >>= 1n;
        b = (b * b) % mod;
    }
    return result;
}

/** @param {Uint8Array} bytes big-endian @returns {bigint} */
export const beToBigInt = bytes=>{
    let value = 0n;
    for (let i = 0; i < bytes.length; i++)
    {
        value = (value << 8n) | BigInt(bytes[i]);
    }
    return value;
};

/** @param {Uint8Array} bytes little-endian @returns {bigint} */
export const leToBigInt = bytes=>{
    let value = 0n;
    for (let i = bytes.length - 1; i >= 0; i--)
    {
        value = (value << 8n) | BigInt(bytes[i]);
    }
    return value;
};

/** @param {bigint} value @param {number} length @returns {Uint8Array} big-endian */
export const bigIntToBe = (value, length)=>{
    const out = new Uint8Array(length);
    let v = value;
    for (let i = length - 1; i >= 0; i--)
    {
        out[i] = Number(v & 0xffn);
        v >>= 8n;
    }
    return out;
};

/** @param {bigint} value @param {number} length @returns {Uint8Array} little-endian */
export const bigIntToLe = (value, length)=>{
    const out = new Uint8Array(length);
    let v = value;
    for (let i = 0; i < length; i++)
    {
        out[i] = Number(v & 0xffn);
        v >>= 8n;
    }
    return out;
};
