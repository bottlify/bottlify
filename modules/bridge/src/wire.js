/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Messages over a runtime port between the content script and the service
 * worker. A port carries JSON, so bytes and big integers are written in it as
 * `{ $b: base64 }` and `{ $n: decimal }`; bytes of more than a few mebibytes
 * (a product-info frame, Valve's client DLLs) go ahead of their message in
 * pieces, since a port refuses a message past its limit (64 MiB in Chrome's
 * documentation; where a message of ours would reach it: not measured). Both
 * ends use the same wire; neither reads what it carries.
 */

/** Bytes a piece. */
const PIECE = 1 << 22;

/** @param {Uint8Array} bytes */
export function toBase64(bytes){
    let text = '';
    for (let at = 0; at < bytes.length; at += 0x8000)
    {
        text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    }
    return btoa(text);
}

/** @param {string} text */
export function fromBase64(text){
    const raw = atob(text);
    const bytes = new Uint8Array(raw.length);
    for (let at = 0; at < raw.length; at++)
    {
        bytes[at] = raw.charCodeAt(at);
    }
    return bytes;
}

/**
 * One end of the wire.
 *
 * @param {(raw: any) => void} post  The port's postMessage.
 */
export function createWire(post){
    let next = 0;
    /** Bytes coming in pieces, by id. @type {Map<number, Uint8Array>} */
    const coming = new Map();

    /** @param {any} value @returns {any} */
    const pack = value=>{
        if (value instanceof Uint8Array)
        {
            if (value.length <= PIECE)
            {
                return { $b: toBase64(value) };
            }
            const id = ++next;
            post({ $blob: { id, size: value.length } });
            for (let at = 0; at < value.length; at += PIECE)
            {
                post({ $piece: { id, at, data: toBase64(value.subarray(at, at + PIECE)) } });
            }
            return { $ref: id };
        }
        if (typeof value === 'bigint')
        {
            return { $n: String(value) };
        }
        if (Array.isArray(value))
        {
            return value.map(pack);
        }
        if (value !== null && typeof value === 'object')
        {
            return Object.fromEntries(Object.entries(value).map(([key, one])=>[key, pack(one)]));
        }
        return value;
    };

    /** @param {any} value @returns {any} */
    const unpack = value=>{
        if (Array.isArray(value))
        {
            return value.map(unpack);
        }
        if (value === null || typeof value !== 'object')
        {
            return value;
        }
        if (typeof value.$b === 'string')
        {
            return fromBase64(value.$b);
        }
        if (typeof value.$n === 'string')
        {
            return BigInt(value.$n);
        }
        if (typeof value.$ref === 'number')
        {
            const bytes = coming.get(value.$ref) ?? new Uint8Array(0);
            coming.delete(value.$ref);
            return bytes;
        }
        return Object.fromEntries(Object.entries(value).map(([key, one])=>[key, unpack(one)]));
    };

    return {
        /** @param {Record<string, any>} message */
        send(message){
            post({ $message: pack(message) });
        },
        /**
         * A raw message from the port: the message it completes, or null for
         * a piece of one still coming.
         *
         * @param {any} raw
         * @returns {Record<string, any> | null}
         */
        receive(raw){
            if (raw?.$blob)
            {
                coming.set(raw.$blob.id, new Uint8Array(raw.$blob.size));
                return null;
            }
            if (raw?.$piece)
            {
                coming.get(raw.$piece.id)?.set(fromBase64(raw.$piece.data), raw.$piece.at);
                return null;
            }
            return raw?.$message ? unpack(raw.$message) : null;
        },
    };
}
