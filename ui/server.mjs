/*
 * Copyright Bottlify Project 2026
 * Licenses and contributions: THIRD-PARTY-NOTICES.md
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Dev server for the UI.
 *
 * Serves the repository root rather than a curated set of directories, so the
 * engine's own relative imports (`./core.js`, `../vendor/prebuilt/libv86.mjs`)
 * resolve in the browser exactly as they do under the test runner. Local only.
 */

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.wasm': 'application/wasm',
};

const server = createServer(async(req, res)=>{
    const url = new URL(req.url ?? '/', 'http://localhost');

    // Redirect rather than serve the page at `/`: the document's base URL is what
    // its own relative imports resolve against, so serving ui/index.html from the
    // root would send `./main.js` to `/main.js`.
    if (url.pathname === '/')
    {
        res.writeHead(302, { Location: '/ui/' }).end();
        return;
    }

    const path = url.pathname.endsWith('/') ? `${url.pathname}index.html` : url.pathname;
    const abs = resolve(ROOT, `.${decodeURIComponent(path)}`);

    if (abs !== ROOT && !abs.startsWith(ROOT + sep))
    {
        res.writeHead(403).end();
        return;
    }

    try {
        const data = await readFile(abs);
        res.writeHead(200, {
            'Content-Type': MIME[extname(abs)] ?? 'application/octet-stream',
            // The engine may reach for SharedArrayBuffer as later phases land;
            // without cross-origin isolation the browser withholds it.
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'credentialless',
        });
        res.end(data);
    } catch {
        res.writeHead(404).end(`not found: ${path}`);
    }
});

const port = Number(process.env.PORT ?? 5180);
server.listen(port, '127.0.0.1', ()=>console.log(`ui: http://127.0.0.1:${port}/`));
