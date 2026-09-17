/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

/**
 * Tiny static file server for the probe pages and the core sources.
 */

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json',
    '.css': 'text/css',
    '.wasm': 'application/wasm',
    '.bin': 'application/octet-stream',
    '.map': 'application/json',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
};

/**
 * @typedef {Object} StaticServer
 * @property {number} port
 * @property {() => Promise<void>} close
 */

/**
 * Serves `sandboxDir` under /sandbox/ and `srcDir` under /src/, plus any extra
 * prefix a caller names.
 *
 * Every response is streamed and every file is range-addressable, because one
 * of the things served this way is a game bundle: a gigabyte that must never be
 * read whole to answer a request for one block of it.
 *
 * @param {Object} roots
 * @param {string} roots.sandboxDir
 * @param {string} roots.srcDir
 * @param {{ prefix: string, root: string }[]} [roots.extra]
 * @param {boolean} [roots.coi]
 *        Cross-Origin-Opener-Policy/Cross-Origin-Embedder-Policy on every
 *        response, so the page comes up `crossOriginIsolated` and
 *        `SharedArrayBuffer` exists -- what the shared-table audio backend
 *        and its worklet need, which this server does not offer by default
 *        because the game bundle route often serves another origin's ranges
 *        that would need `Cross-Origin-Resource-Policy` of their own.
 * @returns {Promise<StaticServer>}
 */
export async function serveStatic({ sandboxDir, srcDir, extra = [], coi = false }){
    const routes = [
        { prefix: '/sandbox/', root: sandboxDir },
        { prefix: '/src/', root: srcDir },
        ...extra,
    ];

    const server = createServer(async(req, res)=>{
        if (coi)
        {
            res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
            res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        }
        const url = new URL(req.url ?? '/', 'http://localhost');
        const route = routes.find(entry=>url.pathname.startsWith(entry.prefix));
        if (!route)
        {
            res.writeHead(404).end();
            return;
        }
        let rel = url.pathname.slice(route.prefix.length);
        if (!rel || rel.endsWith('/'))
        {
            rel += 'index.html';
        }

        const abs = resolve(route.root, '.', rel);
        if (!abs.startsWith(resolve(route.root)))
        {
            res.writeHead(403).end();
            return;
        }
        /** @type {import("node:fs").Stats} */
        let stats;
        try {
            stats = await stat(abs);
        } catch {
            res.writeHead(404).end();
            return;
        }
        if (!stats.isFile())
        {
            res.writeHead(404).end();
            return;
        }

        const type = MIME[extname(abs)] ?? 'application/octet-stream';
        const asked = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ''));
        if (!asked)
        {
            res.writeHead(200, {
                'Content-Type': type,
                'Content-Length': stats.size,
                'Accept-Ranges': 'bytes',
            });
            createReadStream(abs).pipe(res);
            return;
        }

        const start = Number(asked[1]);
        const end = Math.min(
            asked[2] === '' ? stats.size - 1 : Number(asked[2]), stats.size - 1);
        if (start > end)
        {
            res.writeHead(416, { 'Content-Range': `bytes */${stats.size}` }).end();
            return;
        }
        res.writeHead(206, {
            'Content-Type': type,
            'Content-Length': end - start + 1,
            'Content-Range': `bytes ${start}-${end}/${stats.size}`,
            'Accept-Ranges': 'bytes',
        });
        createReadStream(abs, { start, end }).pipe(res);
    });

    const port = await new Promise(resolvePort=>{
        server.listen(0, '127.0.0.1', ()=>resolvePort(server.address().port));
    });

    return {
        port,
        // The browser's renderers outlive the process that was killed and keep
        // their keep-alive sockets open, and close() waits for every one of
        // them: measured at four minutes after a report that took two. The
        // sockets are dropped first, so closing takes as long as closing.
        close: ()=>new Promise(resolveClose=>{
            server.closeAllConnections();
            server.close(()=>resolveClose());
        }),
    };
}
