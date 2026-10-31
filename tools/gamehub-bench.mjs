/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * How long Steam's product info for 704 apps takes through GameHub, against
 * the same done in a page: GameHub's dev build in a headless Chrome (its own
 * short-pathed profile, never a person's browser), a cross-origin isolated
 * page, an anonymous logon, then PICS for the apps -- in Steam's session frame,
 * the extension's page the launcher embeds, and in the page itself over a
 * socket of its own. `--load N` keeps N cores busy meanwhile, as a game running
 * in the browser does: Chrome keeps an extension's service worker at a low
 * priority, and on a busy machine its work waits; a frame shown in the page
 * runs at the page's. `--hidden` embeds the frame with `display: none`, which
 * may not count as shown.
 *
 * The frame is asked through an op this tool writes into the built copy alone
 * (`bench`), so nothing in the extension carries it. Printed for each run:
 * GameHub's `hello` (the content script and the worker), the frame's loading,
 * the logon and the product info in it, all of it, and the page's own.
 *
 *     node tools/gamehub-bench.mjs [--runs 3] [--load 0] [--hidden]
 *
 * Each run is a fresh page: a new frame and a new store, nothing cached.
 */

import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { build } from '../modules/bridge/scripts/build.mjs';
import { chrome } from '../modules/bridge/src/chrome.fixture.js';
import { PAGE_CLIENT } from '../modules/bridge/src/page.fixture.js';
import { steamManagers } from '../modules/bridge/src/stores/steam/store.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
/** @param {string} name @param {number} fallback */
const number = (name, fallback)=>(argv.includes(name)
    ? Number(argv[argv.indexOf(name) + 1]) : fallback);
const RUNS = number('--runs', 3);
const LOAD = number('--load', 0);
const APPS = 'Array.from({ length: 704 }, (_, i)=>200000 + i * 10)';

/** @param {string} dir @param {string} file @param {string} from @param {string} to */
function patch(dir, file, from, to){
    const path = join(dir, file);
    const text = readFileSync(path, 'utf8');
    if (!text.includes(from))
    {
        throw new Error(`${file} no longer has the line the bench is written beside`);
    }
    writeFileSync(path, text.replace(from, to));
}

const HIDDEN = argv.includes('--hidden');
const PAGE = `<!doctype html><script>
${HIDDEN ? "window.frameStyle = 'display:none';" : ''}
${PAGE_CLIENT}
</script>`;

// A short profile path: Windows' MAX_PATH is 260, and a profile deep in a temp
// tree fails to open its databases.
const base = process.env.LOCALAPPDATA ?? resolve('.');
const scratch = mkdtempSync(join(base, 'ghb-'));
const { dev } = await build(join(scratch, 'x'));
patch(dev, 'bridge/src/protocol.js', "    runData: { store: 'store', game: 'game' },",
    "    runData: { store: 'store', game: 'game' },\n    bench: { store: 'store' },");
patch(dev, 'bridge/src/stores/steam/store.js', '        ops: {', `        ops: {
            bench: async()=>{
                const t0 = Date.now();
                await anonymousConnection();
                const t1 = Date.now();
                const found = await productInfo(${APPS});
                return { logon: t1 - t0, info: Date.now() - t1, found: found.size };
            },`);
const [endpoint] = await steamManagers();
const inPage = `(async () => {
    const { connectCm } = await import('/m/bridge/src/stores/steam/connection.js');
    const { logOnAnonymously, productInfo } = await import('/m/bridge/src/stores/steam/session.js');
    const t0 = Date.now();
    const link = await connectCm({ endpoint: ${JSON.stringify(endpoint)} });
    await logOnAnonymously(link);
    const t1 = Date.now();
    const ids = ${APPS};
    let found = 0;
    for (let at = 0; at < ids.length; at += 500)
        found += (await productInfo(link, { apps: ids.slice(at, at + 500) })).apps.size;
    link.close();
    return { logon: t1 - t0, info: Date.now() - t1, found };
})().catch(e => ({ error: String(e.message) }))`;

const isolated = { 'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp' };
const server = createServer((request, response)=>{
    const path = new URL(request.url ?? '/', 'http://x').pathname;
    if (path === '/')
    {
        response.writeHead(200, { ...isolated, 'Content-Type': 'text/html' }).end(PAGE);
    }
    else if (/^\/m\/[a-z0-9/]+\.js$/.test(path))
    {
        response.writeHead(200, { ...isolated, 'Content-Type': 'text/javascript' })
            .end(readFileSync(join(ROOT, 'modules', path.slice(3))));
    }
    else
    {
        response.writeHead(404, isolated).end();
    }
});
await new Promise(done=>server.listen(0, '127.0.0.1', ()=>done(undefined)));
const url = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}/`;
const burners = Array.from({ length: LOAD }, ()=>new Worker(
    'for (;;) { let x = 0; for (let i = 0; i < 1e7; i++) x += i; }', { eval: true }));
const browser = chrome(join(scratch, 'p'));
try
{
    await browser.send('Extensions.loadUnpacked', { path: dev });
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    /** @param {string} expression */
    const page = async expression=>(await browser.send('Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true }, sessionId)).result.value;
    console.log(`product info for 704 apps, anonymous; ${LOAD} cores kept busy;`
        + ` the frame ${HIDDEN ? 'display: none' : 'a pixel, shown'}`);
    for (let run = 1; run <= RUNS; run++)
    {
        await browser.send('Page.navigate', { url }, sessionId);
        await new Promise(done=>setTimeout(done, 1500));
        const started = Date.now();
        // GameHub's first answer: the content script, and the worker's switch.
        await page('ask("hello")');
        const hello = Date.now() - started;
        // The frame loaded and listening: an op it answers at once.
        await page('ask("cover", { store: "steam", game: "440", kind: "header" })');
        const frame = Date.now() - started - hello;
        const hub = await page(
            'ask("bench", { store: "steam" }).catch(e => ({ error: String(e.message) }))');
        const wall = Date.now() - started;
        const own = await page(inPage);
        console.log(`run ${run}: GameHub ${JSON.stringify(hub)} (hello ${hello} ms, frame`
            + ` ${frame} ms, ${wall} ms in all); page ${JSON.stringify(own)}`);
    }
}
finally
{
    burners.forEach(one=>one.terminate());
    browser.proc.kill();
    server.close();
    await new Promise(done=>setTimeout(done, 1000));
    try
    {
        rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    }
    catch {
        console.log(`not removed, Chrome still holds it: ${scratch}`);
    }
}
process.exit(0);
