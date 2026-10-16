/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Sending a packed bottle to a server that will assemble it.
 *
 * Packed on the way out rather than after: the tree is compressed and cut into
 * blocks here, and what crosses the wire is the container's block region. That
 * is less than the installed tree, and nothing is written to this machine at
 * all -- so the doubled storage a local export needs never happens.
 *
 * Sent as a sequence of ordinary requests rather than one streamed body. A
 * streaming request body needs HTTP/2 in the browsers that support it at all,
 * which is a deployment constraint an upload should not carry; a part at a time
 * holds no more than one part in memory and says where it goes, which is also
 * what makes a retry cost one part rather than the bottle.
 *
 * The endpoint is private. An upload belongs to whoever owns the bottle, and
 * publishing it is a separate act -- so every request carries a token and a
 * server with none configured refuses them all.
 */

/** How much goes in one request. Bounded by what a request may hold, not by the format. */
export const PART_BYTES = 32 << 20;

/**
 * What the server says once a bottle is assembled.
 *
 * @typedef {Object} BottleAnswer
 * @property {string} id
 * @property {Record<string, unknown>} manifest
 */

/**
 * @typedef {Object} Endpoint
 * @property {string} url      Base address of the bottle server.
 * @property {string} token    Bearer token; the endpoint is not public.
 * @property {typeof fetch} [fetch]  For a test, or for a caller with its own transport.
 */

/**
 * @param {Endpoint} endpoint
 * @param {string} path
 * @param {RequestInit} init
 */
async function request(endpoint, path, init){
    const send = endpoint.fetch ?? fetch;
    const response = await send(`${endpoint.url.replace(/\/+$/, '')}${path}`, {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${endpoint.token}` },
    });
    if (!response.ok)
    {
        const said = (await response.text()).slice(0, 200);
        throw new Error(`${path} answered ${response.status}: ${said}`);
    }
    return response;
}

/**
 * A sink that posts what it is given, a part at a time.
 *
 * Buffers to the part size rather than sending every block: a block is a
 * quarter of a mebibyte and a request per block would be thousands of round
 * trips for one bottle.
 *
 * @param {Endpoint} endpoint
 * @param {string} id
 * @param {(sent: number) => void} [onProgress]
 * @returns {{ write: (bytes: Uint8Array) => Promise<void>, flush: () => Promise<number> }}
 */
export function partSink(endpoint, id, onProgress){
    /** @type {Uint8Array[]} */
    let pending = [];
    let pendingBytes = 0;
    let sent = 0;

    const post = async()=>{
        if (pendingBytes === 0)
        {
            return;
        }
        const body = new Uint8Array(pendingBytes);
        let at = 0;
        for (const part of pending)
        {
            body.set(part, at);
            at += part.length;
        }
        pending = [];
        pendingBytes = 0;

        await request(endpoint, `/bottles/${encodeURIComponent(id)}/blocks?at=${sent}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body,
        });
        sent += body.length;
        onProgress?.(sent);
    };

    return {
        /** @param {Uint8Array} bytes */
        async write(bytes){
            pending.push(bytes);
            pendingBytes += bytes.length;
            if (pendingBytes >= PART_BYTES)
            {
                await post();
            }
        },
        async flush(){
            await post();
            return sent;
        },
    };
}

/** @param {Uint8Array} bytes */
export function toBase64(bytes){
    let text = '';
    for (const byte of bytes)
    {
        text += String.fromCharCode(byte);
    }
    return btoa(text);
}

/**
 * Tells the server the bottle is complete, and what it is.
 *
 * The header and the index go in this request rather than the stream because
 * neither exists until the last block has been packed. The server writes them
 * where they belong and never has to know what is in them.
 *
 * @param {Endpoint} endpoint
 * @param {string} id
 * @param {import('./pack.js').PackedSummary} packed
 * @param {Record<string, unknown>} manifest  What is said about the title, not about the bytes.
 * @returns {Promise<BottleAnswer>}
 */
export async function finish(endpoint, id, packed, manifest){
    const response = await request(endpoint, `/bottles/${encodeURIComponent(id)}/finish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            header: toBase64(packed.header),
            index: toBase64(packed.index),
            blockBytes: packed.blockBytes,
            manifest: bundleManifest(packed, manifest),
        }),
    });
    return response.json();
}

/**
 * A bottle's manifest: what is said about the title, and what its packing
 * says about the bytes -- the same wherever the bottle is kept.
 *
 * @param {import('./pack.js').PackedSummary} packed
 * @param {Record<string, unknown>} manifest
 * @returns {Record<string, unknown>}
 */
export function bundleManifest(packed, manifest){
    return {
        ...manifest,
        bundle: {
            file: 'bundle.btl',
            blockSize: packed.blockSize,
            files: packed.files,
            directories: packed.directories,
            uncompressedBytes: packed.uncompressedBytes,
            bytes: packed.bytes,
            indexSha256: packed.indexSha256,
        },
    };
}
