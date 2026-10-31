/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The dev build in a real headless Chrome, against Steam itself, on a
 * cross-origin isolated page as the launcher's: the page reaches a connection
 * manager and the content servers through the rules, never sees the session,
 * and a site that switches Steam off is refused by Steam again.
 *
 * Signed in anonymously -- no account's token is at hand here -- so the QR
 * sign-in and an account's library are not exercised against Steam.
 *
 * A branded Chrome ignores --load-extension: the extension is loaded over the
 * DevTools pipe (Extensions.loadUnpacked), which needs
 * --enable-unsafe-extension-debugging.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../scripts/build.mjs';
import { findBrowser } from '../../../tools/cdp_test/browser.mjs';
import { connectCm } from './stores/steam/connection.js';
import { logOnAnonymously, productInfo } from './stores/steam/session.js';
import { STEAM_ART } from './stores/steam/apps.js';

const CORE = fileURLToPath(new URL('../../core/src/', import.meta.url));
/** Steamworks Common Redistributables: a depot whose key Steam gives anyone. */
const APP = 228980;
const DEPOT = 228990;
/** A token in the shape of Steam's, which Steam will refuse. */
const FAKE_TOKEN = `eyJhbGciOiJFZERTQSJ9.${Buffer.from('{"sub":"76561197960287930"}')
    .toString('base64url')}.not-a-signature-but-a-secret`;

/** The page's side of the protocol, as a launcher would write it. */
const PAGE = `<!doctype html><script>
window.presence = document.documentElement.dataset.bottlifyBridge ?? null;
window.seen = [];
addEventListener('message', e => { if (e.data?.from === 'bottlify-bridge') seen.push(e.data); });
let n = 0;
window.ask = (op, args) => new Promise((resolve, reject) => {
    const id = ++n;
    const heard = e => {
        if (e.origin !== location.origin || e.data?.from !== 'bottlify-bridge' || e.data.id !== id
            || e.data.event) return;
        removeEventListener('message', heard);
        'error' in e.data ? reject(new Error(e.data.error)) : resolve(e.data.result);
    };
    addEventListener('message', heard);
    postMessage({ to: 'bottlify-bridge', id, op, args }, location.origin);
});
window.outcome = promise => promise.then(result => ({ result }),
    e => ({ error: String(e.message ?? e) }));
window.picture = src => new Promise(done => {
    const image = new Image();
    image.onload = () => done('shown');
    image.onerror = () => done('refused');
    image.src = src;
});
window.rawSocket = endpoint => new Promise(done => {
    const socket = new WebSocket('wss://' + endpoint + '/cmsocket/');
    socket.onopen = () => { socket.close(); done('open'); };
    socket.onerror = () => done('refused');
});
</script>`;

/** Steam's managers and the depot's current manifest, asked from Node. */
async function fromSteam(){
    const directory = await (await fetch('https://api.steampowered.com/ISteamDirectory/'
        + 'GetCMListForConnect/v1/?cellid=0&cmtype=websockets')).json();
    const endpoints = directory.response.serverlist.map((/** @type {any} */ s)=>s.endpoint);
    const connection = await connectCm({ endpoint: endpoints[0] });
    try
    {
        await logOnAnonymously(connection);
        const { apps } = await productInfo(connection, { apps: [APP] });
        const gid = /** @type {any} */ (apps.get(APP))?.depots?.[DEPOT]?.manifests?.public?.gid;
        assert.ok(gid, 'the redistributables depot has a public manifest');
        return { endpoint: endpoints[0], gid: String(gid) };
    }
    finally
    {
        connection.close();
    }
}

/**
 * A Chrome over a DevTools pipe.
 *
 * @param {string} profile
 */
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

const pause = (/** @type {number} */ ms)=>new Promise(done=>setTimeout(done, ms));
/** @param {boolean} steam */
const hello = steam=>({ version: '0.1.0', stores: [{ id: 'steam', name: 'Steam', on: steam }] });

test('the dev build carries a page to Steam and keeps the session from it', async t=>{
    const scratch = mkdtempSync(join(tmpdir(), 'bridge-itest-'));
    const { dev } = await build(join(scratch, 'dist'));
    const steam = await fromSteam();
    let config = {};
    const isolated = { 'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp' };
    const server = createServer((request, response)=>{
        const path = new URL(request.url ?? '/', 'http://x').pathname;
        if (path === '/')
        {
            response.writeHead(200, { ...isolated, 'Content-Type': 'text/html' }).end(PAGE);
        }
        else if (path === '/config.json')
        {
            response.writeHead(200, { ...isolated, 'Content-Type': 'application/json' })
                .end(JSON.stringify(config));
        }
        else if (/^\/core\/[a-z0-9/]+\.js$/.test(path))
        {
            // Core's own modules, for the page's downloads: what the engine does.
            response.writeHead(200, { ...isolated, 'Content-Type': 'text/javascript' })
                .end(readFileSync(resolve(CORE, path.slice('/core/'.length))));
        }
        else
        {
            response.writeHead(404, isolated).end();
        }
    });
    await new Promise(done=>server.listen(0, '127.0.0.1', ()=>done(undefined)));
    const url = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}/`;
    const browser = chrome(join(scratch, 'profile'));
    try
    {
        const { id: extension } = await browser.send('Extensions.loadUnpacked', { path: dev });
        const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
        const { sessionId } = await browser.send('Target.attachToTarget',
            { targetId, flatten: true });
        /** @param {string} expression */
        const page = async expression=>{
            const answer = await browser.send('Runtime.evaluate',
                { expression, awaitPromise: true, returnByValue: true }, sessionId);
            if (answer.exceptionDetails)
            {
                const { exception, text } = answer.exceptionDetails;
                throw new Error(exception?.description ?? text);
            }
            return answer.result.value;
        };
        const open = async()=>{
            await browser.send('Page.navigate', { url }, sessionId);
            for (let tries = 0; tries < 100; tries++)
            {
                await pause(100);
                if (await page('document.readyState === "complete" && typeof ask').catch(()=>null)
                    === 'function')
                {
                    return;
                }
            }
            throw new Error('the page did not load');
        };
        /** The extension's worker, where its storage is read and written. */
        const worker = async()=>{
            const { targetInfos } = await browser.send('Target.getTargets');
            const found = targetInfos.find((/** @type {any} */ info)=>info.type === 'service_worker'
                && info.url.startsWith(`chrome-extension://${extension}/`));
            assert.ok(found, 'the extension\'s worker runs');
            const attached = await browser.send('Target.attachToTarget',
                { targetId: found.targetId, flatten: true });
            return async(/** @type {string} */ expression)=>(await browser.send('Runtime.evaluate',
                { expression, awaitPromise: true, returnByValue: true }, attached.sessionId))
                .result.value;
        };

        await open();

        await t.test('GameHub is there before the page\'s scripts, and Steam is on', async()=>{
            assert.equal(await page('crossOriginIsolated'), true);
            assert.equal(await page('ask("account", { store: "steam" })'), null);
            assert.equal(await page('presence'), '0.1.0');
            assert.deepEqual(await page('ask("hello")'), hello(true));
        });

        await t.test('GameHub in the tab speaks to Steam over the page\'s socket', async()=>{
            assert.equal(await page(`rawSocket(${JSON.stringify(steam.endpoint)})`), 'open');
            const download = await page(`ask("download", { store: "steam", game: "${APP}" })
                .then(answer => ({ ...answer, depots: answer.depots.map(one =>
                    ({ ...one, key: one.key.length })) }))`);
            assert.ok(download.servers.length > 0, 'content servers');
            const depot = download.depots.find((/** @type {any} */ one)=>one.depot === DEPOT);
            assert.deepEqual([depot.gid, depot.key], [steam.gid, 32]);
            assert.match(depot.code, /^[0-9]+$/);
        });

        await t.test('a store\'s art shown on an isolated page', async()=>{
            const cover = await page(
                'ask("cover", { store: "steam", game: "440", kind: "header" })');
            assert.equal(cover, `${STEAM_ART}/440/header.jpg`);
            assert.equal(await page(`picture(${JSON.stringify(cover)})`), 'shown');
        });

        await t.test('the page reads a manifest and a chunk from the content servers', async()=>{
            const read = await page(`(async () => {
                const { manifest, downloadChunk } = await import('/core/steam/depot.js');
                const answer = await ask('download', { store: 'steam', game: '${APP}' });
                const [server] = answer.servers;
                const one = answer.depots.find(d => d.depot === ${DEPOT});
                const listed = await manifest(server,
                    { depot: ${DEPOT}, gid: BigInt(one.gid), code: BigInt(one.code),
                        key: one.key });
                const chunk = listed.files.find(file => file.chunks.length).chunks[0];
                const bytes = await downloadChunk(server, ${DEPOT}, chunk, one.key);
                return { files: listed.files.length, chunk: bytes.length === chunk.size };
            })()`);
            assert.ok(read.files > 0);
            assert.equal(read.chunk, true);
        });

        await t.test('a sign-in in the worker, over HTTPS, streams its QR code', async()=>{
            const signIn = await page(`(async () => {
                const going = outcome(ask('signIn', { store: 'steam' }));
                const id = n;
                const challenge = () => seen.find(m => m.id === id && m.event === 'challenge');
                for (let i = 0; i < 300 && !challenge(); i++)
                    await new Promise(r => setTimeout(r, 100));
                await ask('cancel', { target: id });
                return { url: challenge()?.data.url ?? null, ended: await going };
            })()`);
            assert.match(signIn.url ?? '', /^https:\/\/s\.team\/q\//);
            assert.match(signIn.ended.error, /cancelled/);
        });

        await t.test('the session is the worker\'s, out of a content script\'s storage', async()=>{
            const storage = await worker();
            assert.equal(await page('typeof chrome?.storage'), 'undefined');
            // Where an earlier version kept it, which a content script can read.
            await storage(`chrome.storage.local.set({ steam: { accountName: 'probe',
                refreshToken: ${JSON.stringify(FAKE_TOKEN)} } })`);
            const account = await page('outcome(ask("account", { store: "steam", fresh: true }))');
            assert.ok(account.error, 'Steam refuses a made-up token');
            t.diagnostic(`account with a made-up token: ${account.error}`);
            assert.deepEqual(await storage('chrome.storage.local.get(null)'), {},
                'gone from the storage the content script could read');
            const kept = ()=>storage(`new Promise(done => {
                const request = indexedDB.open('gamehub');
                request.onsuccess = () => {
                    const read = request.result.transaction('sessions')
                        .objectStore('sessions').get('steam');
                    read.onsuccess = () => done(read.result?.accountName ?? null);
                };
            })`);
            assert.equal(await kept(), 'probe', 'kept in the worker\'s own database');
            const record = await storage(`new Promise(done => {
                const request = indexedDB.open('gamehub');
                request.onsuccess = () => {
                    const read = request.result.transaction('sessions')
                        .objectStore('sessions').get('steam');
                    read.onsuccess = () => done({ fields: Object.keys(read.result).sort(),
                        sealed: new TextDecoder('latin1').decode(read.result.sealed) });
                };
            })`);
            assert.deepEqual(record.fields, ['accountName', 'iv', 'sealed'], 'its token sealed');
            assert.doesNotMatch(record.sealed, /not-a-signature|eyJ/);
            assert.doesNotMatch(await page('JSON.stringify(seen)'), /not-a-signature|eyJ/);
            assert.deepEqual(await page('ask("signOut", { store: "steam" })'), {});
            assert.equal(await kept(), null);
        });

        await t.test('Steam switched off by the site: Steam refuses the page again', async()=>{
            config = { bridge: { steam: false } };
            await open();
            assert.deepEqual(await page('ask("hello")'), hello(false));
            assert.equal(await page(`rawSocket(${JSON.stringify(steam.endpoint)})`), 'refused');
            assert.match((await page('outcome(ask("account", { store: "steam" }))')).error, /switched off/);
            const blocked = await page(`fetch('https://api.steampowered.com/ISteamDirectory/`
                + `GetCMListForConnect/v1/').then(() => 'read', () => 'refused')`);
            assert.equal(blocked, 'refused');
            assert.equal(await page(`picture(${JSON.stringify(`${STEAM_ART}/440/header.jpg?off`)})`),
                'refused', 'Steam\'s art is not let into the isolated page either');
            config = {};
            await open();
            assert.deepEqual(await page('ask("hello")'), hello(true));
        });
    }
    finally
    {
        browser.proc.kill();
        server.close();
        await pause(1000);
        rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    }
});
