/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Builds the Steam sign-in and library page (modules/steam/demo) into one
 * HTML file to open in a browser, from disk or any server:
 *
 *   NODE_USE_ENV_PROXY=1 node tools/steam-page.mjs <out.html>
 *
 * The connection managers' WebSocket addresses are fetched now and written
 * in: Steam's directory does not answer a page from another origin.
 */

import { writeFileSync } from 'node:fs';
import { build } from 'esbuild';

const out = process.argv[2];
if (!out)
{
    throw new Error('usage: node tools/steam-page.mjs <out.html>');
}
const directory = await (await fetch(
    'https://api.steampowered.com/ISteamDirectory/GetCMListForConnect/v1/?cellid=0&cmtype=websockets')).json();
/** @type {string[]} */
const endpoints = directory.response.serverlist.map((/** @type {any} */ s)=>s.endpoint);
// Port 443 first: the one a firewall least often closes.
endpoints.sort((a, b)=>Number(!a.endsWith(':443')) - Number(!b.endsWith(':443')));
const bundle = await build({
    entryPoints: [new URL('../modules/steam/demo/page.js', import.meta.url).pathname],
    bundle: true, format: 'esm', write: false, target: 'es2022',
});
const script = bundle.outputFiles[0].text.replace(/<\/script/g, '<\\/script');
writeFileSync(out, `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Bottlify · Steam</title>
<style>
body { font: 15px system-ui, sans-serif; margin: 2rem auto; max-width: 40rem; padding: 0 1rem;
  background: #fff; color: #111; }
#qr svg { display: block; margin: 1rem 0; }
#games { columns: 2; padding-left: 1.2rem; }
</style></head>
<body>
<h1>Steam</h1>
<p id="status"></p>
<div id="qr"></div>
<ul id="games"></ul>
<script type="application/json" id="endpoints">${JSON.stringify(endpoints.slice(0, 12))}</script>
<script type="module">${script}</script>
</body></html>
`);
console.log(`${out}: ${endpoints.length} managers known, the first 12 written in`);
