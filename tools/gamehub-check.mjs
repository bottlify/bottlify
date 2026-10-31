/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A page that checks GameHub on its own, apart from the launcher: whether the
 * extension answers, which stores it has on, who is signed in, how many games
 * the account lists, and a store's sign-in page in a frame, as the launcher
 * shows it. Every answer is written to the page's log with how long it took;
 * nothing secret ever reaches a page, so nothing secret can be shown.
 *
 *     node tools/gamehub-check.mjs [--port 5199]
 *
 * then open http://127.0.0.1:5199/ in the browser that has the dev build of
 * GameHub (the dev build answers on 127.0.0.1).
 */

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const argv = process.argv.slice(2);
const port = Number(argv.includes('--port') ? argv[argv.indexOf('--port') + 1] : 5199);

const PAGE = readFileSync(new URL('./gamehub-check.html', import.meta.url));

createServer((_request, response)=>{
    response.writeHead(200,
        { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(PAGE);
}).listen(port, '127.0.0.1', ()=>console.log(`GameHub check: http://127.0.0.1:${port}/`));
