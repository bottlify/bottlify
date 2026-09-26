/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * RC4, the stream cipher the CryptoAPI provider derives and imports keys for:
 * encryption and decryption are one routine with no block padding, and the
 * keystream carries on across calls until a final one resets it, as it does on
 * Windows.
 */

/**
 * @typedef {Object} StreamCipher
 * @property {(data: Uint8Array) => Uint8Array} transform
 * @property {() => void} reset
 */

/** @param {Uint8Array} key @returns {StreamCipher} */
export function createRc4(key){
    const init = ()=>{
        const s = new Uint8Array(256);
        for (let i = 0; i < 256; i++)
        {
            s[i] = i;
        }
        let j = 0;
        for (let i = 0; i < 256; i++)
        {
            j = (j + s[i] + key[i % key.length]) & 0xff;
            const t = s[i];
            s[i] = s[j];
            s[j] = t;
        }
        return s;
    };
    let s = init();
    let a = 0;
    let b = 0;
    /** @param {Uint8Array} data */
    const transform = data=>{
        const out = new Uint8Array(data.length);
        for (let k = 0; k < data.length; k++)
        {
            a = (a + 1) & 0xff;
            b = (b + s[a]) & 0xff;
            const t = s[a];
            s[a] = s[b];
            s[b] = t;
            out[k] = data[k] ^ s[(s[a] + s[b]) & 0xff];
        }
        return out;
    };
    const reset = ()=>{
        s = init();
        a = 0;
        b = 0;
    };
    return { transform, reset };
}
