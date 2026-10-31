/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * How long Steam's product info for 704 apps takes through GameHub, against
 * the same done in a page: GameHub's dev build in a headless Chrome (its own
 * short-pathed profile, never a person's browser), a cross-origin isolated
 * page, an anonymous logon, then PICS for the apps -- in the extension's
 * service worker over the page's socket, and in the page itself over a socket
 * of its own. `--load N` keeps N cores busy meanwhile, as a game running in
 * the browser does: Chrome keeps an extension's service worker at a low
 * priority, and on a busy machine its work waits.
 *
 * The worker is asked through an op this tool writes into the built copy
 * alone (`bench`), so nothing in the extension carries it.
 *
 *     node tools/gamehub-bench.mjs [--runs 3] [--load 0]
 *
 * Each run is a fresh page: a new port and a new store, nothing cached.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { build } from '../modules/bridge/scripts/build.mjs';
import { findBrowser } from './cdp_test/browser.mjs';
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

/** @param {string} profile */
function chrome(profile){
    const proc = spawn(findBrowser(), ['--headless=new', '--no-first-run',
        '--no-default-browser-check', `--user-data-dir=${profile}`, '--remote-debugging-pipe',
        '--enable-unsafe-extension-debugging', 'about:blank'],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
    const out = /** @type {import('node:stream').Writable} */ (proc.stdio[3]);
    const inp = /** @type {import('node:stream').Readable} */ (proc.stdio[4]);
    let buffered = '';
    let next = 0;
    /** @type {Map<number, (message: any) => void>} */
    const waiting = new Map();
    inp.on('data', data=>{
        buffered += data;
        for (let end; (end = buffered.indexOf('\0')) >= 0;)
        {
            const message = JSON.parse(buffered.slice(0, end));
            buffered = buffered.slice(end + 1);
            waiting.get(message.id)?.(message);
        }
    });
    /** @param {string} method @param {object} [params] @param {string} [sessionId] */
    const send = (method, params = {}, sessionId)=>new Promise((done, fail)=>{
        const id = ++next;
        waiting.set(id, message=>{
            waiting.delete(id);
            if (message.error)
            {
                fail(new Error(`${method}: ${message.error.message}`));
            }
            else
            {
                done(message.result);
            }
        });
        out.write(`${JSON.stringify({ id, method, params, ...sessionId ? { sessionId } : {} })}\0`);
    });
    return { proc, send };
}

const PAGE = `<!doctype html><script>
let n = 0;
window.ask = (op, args) => new Promise((resolve, reject) => {
    const id = ++n;
    const heard = e => {
        if (e.data?.from !== 'bottlify-bridge' || e.data.id !== id || e.data.event) return;
        removeEventListener('message', heard);
        'error' in e.data ? reject(new Error(e.data.error)) : resolve(e.data.result);
    };
    addEventListener('message', heard);
    postMessage({ to: 'bottlify-bridge', id, op, args }, location.origin);
});
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
    console.log(`product info for 704 apps, anonymous; ${LOAD} cores kept busy`);
    for (let run = 1; run <= RUNS; run++)
    {
        await browser.send('Page.navigate', { url }, sessionId);
        await new Promise(done=>setTimeout(done, 1500));
        const started = Date.now();
        const worker = await page(
            'ask("bench", { store: "steam" }).catch(e => ({ error: String(e.message) }))');
        const wall = Date.now() - started;
        const own = await page(inPage);
        console.log(`run ${run}: worker ${JSON.stringify(worker)} (${wall} ms in all);`
            + ` page ${JSON.stringify(own)}`);
    }
}
finally
{
    burners.forEach(one=>one.terminate());
    browser.proc.kill();
    server.close();
    await new Promise(done=>setTimeout(done, 1000));
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
process.exit(0);
