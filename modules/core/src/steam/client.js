/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Steam client's own files, from Valve's public client distribution --
 * the manifest and package zips the real client updates itself from. Only
 * the files a program reads as the installed client's are taken (its
 * `steamclient.dll` and `steamclient64.dll`): they stand in Steam's folder as
 * data, for a program -- a DRM wrapper -- that opens the client it loaded and
 * checks it is Valve's. They are never run; the engine's own client answers
 * every call. Fetched where the program runs, on its user's machine, and kept
 * in that machine's storage beside the rest of its Steam data.
 *
 * Through `fetch`, WebCrypto and the platform's decompression streams, so it
 * runs in a page (the bridge adds the CDN's CORS headers) as in Node.
 */

import { parseText } from './keyvalues.js';

/** Valve's client CDN, where the client's manifest and packages are. */
export const CLIENT_CDN = 'https://client-update.akamai.steamstatic.com';

/** The client's manifest for Windows, and the package its own DLLs are in. */
const MANIFEST = 'steam_client_win32';
const BINARIES = 'bins_win32';

/** The files taken, by their name in the package (its root). */
export const CLIENT_FILES = Object.freeze(['steamclient.dll', 'steamclient64.dll']);

/** @param {Uint8Array} bytes */
const hex = bytes=>[...bytes].map(byte=>byte.toString(16).padStart(2, '0')).join('');

/** @param {Uint8Array} bytes */
const asBuffer = bytes=>/** @type {ArrayBuffer} */ (
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
async function inflateRaw(bytes){
    const stream = new Blob([asBuffer(bytes)]).stream()
        .pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * The entries of a zip archive named in `wanted`, by name: read through its
 * central directory (the local headers of the client's packages leave their
 * sizes to it), stored or deflated.
 *
 * @param {Uint8Array} zip @param {readonly string[]} wanted
 * @returns {Promise<Record<string, Uint8Array>>}
 */
export async function zipEntries(zip, wanted){
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    let end = zip.byteLength - 22;
    while (end >= 0 && view.getUint32(end, true) !== 0x06054b50)
    {
        end--;
    }
    if (end < 0)
    {
        throw new Error('steam client: not a zip archive');
    }
    const count = view.getUint16(end + 10, true);
    let at = view.getUint32(end + 16, true);
    const names = new Set(wanted.map(name=>name.toLowerCase()));
    /** @type {Record<string, Uint8Array>} */
    const found = {};
    for (let index = 0; index < count; index++)
    {
        if (view.getUint32(at, true) !== 0x02014b50)
        {
            throw new Error('steam client: a damaged central directory');
        }
        const method = view.getUint16(at + 10, true);
        const compressed = view.getUint32(at + 20, true);
        const nameLength = view.getUint16(at + 28, true);
        const extraLength = view.getUint16(at + 30, true);
        const commentLength = view.getUint16(at + 32, true);
        const local = view.getUint32(at + 42, true);
        const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength));
        at += 46 + nameLength + extraLength + commentLength;
        if (!names.has(name.toLowerCase()))
        {
            continue;
        }
        const start = local + 30 + view.getUint16(local + 26, true)
            + view.getUint16(local + 28, true);
        const body = zip.subarray(start, start + compressed);
        if (method !== 0 && method !== 8)
        {
            throw new Error(`steam client: ${name} is compressed with method ${method}`);
        }
        found[name] = method === 0 ? body.slice() : await inflateRaw(body);
    }
    return found;
}

/**
 * The client's version and its DLLs, fetched from Valve's CDN: the manifest,
 * then the binaries' package, its SHA-256 checked against the manifest's.
 *
 * @param {{ fetch?: typeof fetch, cdn?: string }} [options]
 * @returns {Promise<{ version: string, files: Record<string, Uint8Array> }>}
 */
export async function fetchClientFiles({ fetch: get = globalThis.fetch, cdn = CLIENT_CDN } = {}){
    /** @param {string} path */
    const fetchBytes = async path=>{
        const response = await get(`${cdn}/${path}`);
        if (!response.ok)
        {
            throw new Error(`steam client: ${path} answered ${response.status}`);
        }
        return new Uint8Array(await response.arrayBuffer());
    };
    const manifest = /** @type {any} */ (parseText(
        new TextDecoder().decode(await fetchBytes(MANIFEST))))?.win32;
    const listed = manifest?.[BINARIES];
    if (!listed?.file)
    {
        throw new Error(`steam client: the manifest names no ${BINARIES} package`);
    }
    const zip = await fetchBytes(listed.file);
    const digest = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', asBuffer(zip))));
    if (listed.sha2 && digest !== String(listed.sha2).toLowerCase())
    {
        throw new Error(`steam client: ${listed.file} is not the package the manifest names`);
    }
    return { version: String(manifest.version ?? ''), files: await zipEntries(zip, CLIENT_FILES) };
}
