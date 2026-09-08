/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Where a shared bottle is assembled.
 *
 * The browser did the packing, so almost nothing happens here: block bytes
 * arrive in order and are appended, and a final request carries the two parts
 * that could not be known until the last block was packed -- the header and the
 * index. The server writes them where they belong and never parses either. A
 * container format understood in two places is a container format that will
 * disagree with itself.
 *
 * The one thing it does compute is the whole-bundle digest, over the block
 * region as it passes through, because a browser cannot hash incrementally and
 * this side can.
 *
 * Private from the start. An upload belongs to whoever owns the bottle;
 * publishing is a separate act, and an endpoint accepting arbitrary game data
 * from anyone is both a storage bill and a legal surface. A server started
 * without a token refuses every request rather than opening by default.
 */

import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
// The one thing this side knows about the container: where the block region
// starts, so it can leave room for a header it writes last and never reads.
import { HEADER_SIZE }
    from '../../../core/src/layers/filesystem/internal/bundle/format.js';

/** Nothing larger is read into memory for one request. */
const MAX_PART = 64 << 20;

/** An id names a directory, so it may not name a path. */
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/**
 * @typedef {Object} BottleUpload
 * @property {import('node:fs/promises').FileHandle} handle
 * @property {import('node:crypto').Hash} digest
 * @property {number} written   Bytes of the block region so far.
 * @property {string} partial   Where it is being written.
 */

/**
 * Compares two tokens without telling an attacker how much of one was right.
 *
 * @param {string} a @param {string} b
 */
function sameToken(a, b){
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
}

/** @param {import('node:http').IncomingMessage} request @param {number} limit */
function readBody(request, limit){
    return new Promise((settle, fail)=>{
        /** @type {Buffer[]} */
        const parts = [];
        let total = 0;
        request.on('data', chunk=>{
            total += chunk.length;
            if (total > limit)
            {
                fail(new Error(`body over ${limit} bytes`));
                request.destroy();
                return;
            }
            parts.push(chunk);
        });
        request.on('end', ()=>settle(Buffer.concat(parts, total)));
        request.on('error', fail);
    });
}

/**
 * @param {Object} options
 * @param {string} options.root    Directory bottles are written under.
 * @param {string} options.token   Shared secret every request must carry.
 * @param {number} [options.port]
 * @param {string} [options.host]
 */
export function createBottleServer({ root, token, port = 8788, host = '127.0.0.1' }){
    if (!token)
    {
        throw new Error('a bottle server needs a token: the endpoint is not public');
    }
    const base = resolve(root);
    /** @type {Map<string, BottleUpload>} */
    const uploads = new Map();

    /** @param {string} id */
    const directoryFor = id=>join(base, id);

    /** @param {string} id */
    const beginOrContinue = async id=>{
        const held = uploads.get(id);
        if (held)
        {
            return held;
        }
        const directory = directoryFor(id);
        await mkdir(directory, { recursive: true });
        const partial = join(directory, 'bundle.btl.part');
        const upload = {
            handle: await open(partial, 'w'),
            digest: createHash('sha256'),
            written: 0,
            partial,
        };
        uploads.set(id, upload);
        return upload;
    };

    const server = createServer((request, response)=>{
        /** @param {number} status @param {any} body */
        const answer = (status, body)=>{
            const text = typeof body === 'string' ? body : JSON.stringify(body);
            response.writeHead(status, {
                'Content-Type': typeof body === 'string'
                    ? 'text/plain; charset=utf-8'
                    : 'application/json',
                'Content-Length': Buffer.byteLength(text),
            }).end(text);
        };

        handle(request, answer).catch(e=>answer(400, e.message));
    });

    /**
     * @param {import('node:http').IncomingMessage} request
     * @param {(status: number, body: any) => void} answer
     */
    async function handle(request, answer){
        const offered = /^Bearer (.+)$/.exec(String(request.headers.authorization ?? ''));
        if (!offered || !sameToken(offered[1], token))
        {
            answer(401, 'this endpoint is private');
            return;
        }

        const url = new URL(request.url ?? '/', 'http://bottles');
        const route = /^\/bottles\/([^/]+)\/(blocks|finish)$/.exec(url.pathname);
        if (!route || request.method !== 'POST')
        {
            answer(404, `no route for ${request.method} ${url.pathname}`);
            return;
        }

        const id = decodeURIComponent(route[1]);
        if (!SAFE_ID.test(id))
        {
            answer(400, `"${id}" is not a usable bottle id`);
            return;
        }

        if (route[2] === 'blocks')
        {
            const upload = await beginOrContinue(id);
            const at = Number(url.searchParams.get('at') ?? 0);
            // Sequential, and said so rather than silently leaving a hole: the
            // digest is taken as the bytes pass, so a part out of order would
            // produce a bundle whose recorded digest is of something else.
            if (at !== upload.written)
            {
                answer(409, `expected the part at ${upload.written}, not ${at}`);
                return;
            }
            const body = await readBody(request, MAX_PART);
            await upload.handle.write(body, 0, body.length, HEADER_SIZE + upload.written);
            upload.digest.update(body);
            upload.written += body.length;
            answer(200, { received: body.length, at: upload.written });
            return;
        }

        const upload = uploads.get(id);
        if (!upload)
        {
            answer(409, `nothing has been uploaded for "${id}"`);
            return;
        }
        const finished = JSON.parse((await readBody(request, MAX_PART)).toString('utf8'));
        const header = Buffer.from(finished.header, 'base64');
        const index = Buffer.from(finished.index, 'base64');
        if (finished.blockBytes !== upload.written)
        {
            answer(409,
                `the bottle says ${finished.blockBytes} block bytes; ${upload.written} arrived`);
            return;
        }

        await upload.handle.write(index, 0, index.length, HEADER_SIZE + upload.written);
        await upload.handle.write(header, 0, header.length, 0);
        await upload.handle.close();
        uploads.delete(id);

        const directory = directoryFor(id);
        await rename(upload.partial, join(directory, 'bundle.btl'));

        const manifest = {
            id,
            ...finished.manifest,
            bundle: {
                ...finished.manifest?.bundle,
                format: `btl/${header.readUInt32LE(4)}`,
                // Over the block region only, matching what the Node writer
                // records: the header and the index vouch for themselves.
                sha256: upload.digest.digest('hex'),
            },
        };
        await writeFile(join(directory, 'manifest.json'),
            `${JSON.stringify(manifest, null, 4)}\n`);
        answer(200, { id, manifest });
    }

    return {
        listen: ()=>new Promise(settle=>{
            server.listen(port, host, ()=>settle(
                /** @type {any} */ (server.address()).port));
        }),
        async close(){
            for (const [id, upload] of uploads)
            {
                await upload.handle.close();
                await rm(upload.partial, { force: true });
                uploads.delete(id);
            }
            await new Promise(settle=>server.close(()=>settle(undefined)));
        },
        diagnostics: ()=>({ pending: [...uploads.keys()] }),
    };
}
