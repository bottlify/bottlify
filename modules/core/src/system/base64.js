/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Bytes as base64 and back: RFC 4648's alphabet, padded with `=`, no line
 * breaks (a caller that wants them - PEM, CryptBinaryToString - folds the
 * text itself). btoa and atob speak in characters of one byte; the bytes
 * reach them a piece at a time, since spreading a whole buffer into
 * String.fromCharCode runs out of stack past some hundred thousand bytes.
 */

/** Bytes a piece of the text is made from: a multiple of three, so no piece is padded. */
const PIECE = 0x7ffe;

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function toBase64(bytes){
    let text = '';
    for (let at = 0; at < bytes.length; at += PIECE)
    {
        text += btoa(String.fromCharCode(...bytes.subarray(at, at + PIECE)));
    }
    return text;
}

/**
 * The bytes base64 text stands for. Whitespace is passed over, as atob does;
 * anything else outside the alphabet, or a length no padding makes whole,
 * throws.
 *
 * @param {string} text
 * @returns {Uint8Array<ArrayBuffer>}
 */
export function fromBase64(text){
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let at = 0; at < binary.length; at++)
    {
        bytes[at] = binary.charCodeAt(at);
    }
    return bytes;
}
