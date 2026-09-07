/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
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
 * Serves `sandboxDir` under /sandbox/ and `srcDir` under /src/.
 *
 * @param {Object} roots
 * @param {string} roots.sandboxDir
 * @param {string} roots.srcDir
 * @returns {Promise<StaticServer>}
 */
export async function serveStatic({ sandboxDir, srcDir }){
    const routes = [
        { prefix: '/sandbox/', root: sandboxDir },
        { prefix: '/src/', root: srcDir },
    ];

    const server = createServer(async(req, res)=>{
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
        try {
            const data = await readFile(abs);
            res.writeHead(200,
                { 'Content-Type': MIME[extname(abs)] ?? 'application/octet-stream' });
            res.end(data);
        } catch {
            res.writeHead(404).end();
        }
    });

    const port = await new Promise(resolvePort=>{
        server.listen(0, '127.0.0.1', ()=>resolvePort(server.address().port));
    });

    return {
        port,
        close: ()=>new Promise(resolveClose=>server.close(()=>resolveClose())),
    };
}
