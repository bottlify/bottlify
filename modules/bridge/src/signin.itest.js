/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Steam's sign-in page in a frame of a cross-origin isolated page, as the
 * launcher shows it, in a real headless Chrome with the dev build; the
 * service worker's requests to Steam answered by a made-up Steam
 * (https.fixture.js) through DevTools' request interception. A person's steps
 * are taken in the frame: a password with an email code, and a QR code. What
 * the page can reach -- what it is posted, its document, the frame's -- is
 * read for the password and the token; the worker's database for the token.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from '../scripts/build.mjs';
import { chrome } from './chrome.fixture.js';
import { CODES, PASSWORD, SECRET, fakeSteamHttps } from './stores/steam/https.fixture.js';

const PAGE = (/** @type {string} */ frame)=>`<!doctype html><script>
window.posted = [];
addEventListener('message', e => posted.push({ origin: e.origin, data: e.data }));
</script><iframe src="${frame}" width="420" height="520"></iframe>`;

const pause = (/** @type {number} */ ms)=>new Promise(done=>setTimeout(done, ms));

test('the sign-in page, framed, signs in and tells the page a name alone', async t=>{
    const scratch = mkdtempSync(join(process.env.LOCALAPPDATA ?? tmpdir(), 'ghs-'));
    const { dev } = await build(join(scratch, 'x'));
    const steam = await fakeSteamHttps();
    let frame = '';
    const isolated = { 'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp' };
    const server = createServer((_request, response)=>{
        response.writeHead(200, { ...isolated, 'Content-Type': 'text/html' }).end(PAGE(frame));
    });
    await new Promise(done=>server.listen(0, '127.0.0.1', ()=>done(undefined)));
    const url = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}/`;
    const browser = chrome(join(scratch, 'p'));
    try
    {
        const { id: extension } = await browser.send('Extensions.loadUnpacked', { path: dev });
        frame = `chrome-extension://${extension}/steam/signin.html`;
        /** @param {string} expression @param {string} sessionId */
        const evaluate = async(expression, sessionId)=>{
            const answer = await browser.send('Runtime.evaluate',
                { expression, awaitPromise: true, returnByValue: true }, sessionId);
            if (answer.exceptionDetails)
            {
                throw new Error(answer.exceptionDetails.exception?.description
                    ?? answer.exceptionDetails.text);
            }
            return answer.result.value;
        };
        /** @param {(info: any) => boolean} match */
        const attach = async match=>{
            for (let tries = 0; tries < 100; tries++)
            {
                const { targetInfos } = await browser.send('Target.getTargets');
                const found = targetInfos.find(match);
                if (found)
                {
                    return (await browser.send('Target.attachToTarget',
                        { targetId: found.targetId, flatten: true })).sessionId;
                }
                await pause(100);
            }
            throw new Error('no such target');
        };
        /** @param {() => Promise<boolean>} done @param {string} what */
        const until = async(done, what)=>{
            for (let tries = 0; tries < 200; tries++)
            {
                if (await done())
                {
                    return;
                }
                await pause(100);
            }
            throw new Error(`${what} did not come`);
        };

        // Steam, for the worker: its requests answered by the made-up one.
        const worker = await attach(info=>info.type === 'service_worker'
            && info.url.startsWith(`chrome-extension://${extension}/`));
        browser.on(async({ method, params, sessionId })=>{
            if (method !== 'Fetch.requestPaused' || sessionId !== worker)
            {
                return;
            }
            const { request, requestId } = params;
            const answer = await steam.fetch(request.url,
                { method: request.method, body: request.postData });
            const body = Buffer.from(await answer.arrayBuffer()).toString('base64');
            await browser.send('Fetch.fulfillRequest', { requestId, responseCode: answer.status,
                responseHeaders: [.../** @type {any} */ (answer.headers)]
                    .map(([name, value])=>({ name, value })),
                body }, worker);
        });
        await browser.send('Fetch.enable',
            { patterns: [{ urlPattern: 'https://api.steampowered.com/*' }] }, worker);

        const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
        const page = (await browser.send('Target.attachToTarget', { targetId, flatten: true }))
            .sessionId;
        await browser.send('Page.navigate', { url }, page);
        const signin = await attach(info=>info.type === 'iframe' && info.url === frame);
        await until(async()=>Boolean(await evaluate(
            'document.getElementById("qr-code")?.querySelector("svg")', signin)), 'the QR code');

        await t.test('the frame loads under the page\'s COEP, out of the page\'s reach', async()=>{
            assert.equal(await evaluate('crossOriginIsolated', page), true);
            assert.equal(await evaluate(`(() => {
                try { return frames[0].document ? 'reached' : 'none'; }
                catch (e) { return 'refused'; } })()`, page), 'refused');
        });

        await t.test('a QR code: Steam\'s challenge shown, the page told the name', async()=>{
            await until(async()=>(await evaluate('posted.length', page)) > 0, 'the outcome');
            assert.deepEqual(await evaluate('posted', page), [{
                origin: `chrome-extension://${extension}`,
                data: { from: 'bottlify-signin', store: 'steam', signedIn: { name: 'scanned' } },
            }]);
        });

        await t.test('a password and an email code, typed in the frame', async()=>{
            await evaluate('posted.length = 0', page);
            await evaluate(`(() => {
                document.getElementById('by-password').click();
                const form = document.getElementById('password');
                form.elements.account.value = 'email';
                form.elements.password.value = ${JSON.stringify(PASSWORD)};
                form.requestSubmit();
            })()`, signin);
            /** @param {string} id @param {string} what */
            const field = (id, what)=>evaluate(`document.getElementById("${id}").${what}`, signin);
            await until(async()=>!(await field('guard', 'hidden')), 'Steam Guard\'s step');
            assert.match(await field('guard-asks', 'textContent'),
                /code Steam sent to your email at example\.com/);
            await evaluate(`(() => { const form = document.getElementById('guard');
                form.elements.code.value = 'WRONG'; form.requestSubmit(); })()`, signin);
            await until(async()=>/not right/.test(await evaluate(
                'document.getElementById("status").textContent', signin)), 'the wrong code');
            await evaluate(`(() => { const form = document.getElementById('guard');
                form.elements.code.value = ${JSON.stringify(CODES.email)};
                form.requestSubmit(); })()`, signin);
            await until(async()=>(await evaluate('posted.length', page)) > 0, 'the outcome');
            assert.deepEqual((await evaluate('posted', page))[0].data,
                { from: 'bottlify-signin', store: 'steam', signedIn: { name: 'email' } });
            assert.deepEqual(steam.seen.passwords, [PASSWORD], 'Steam had it, sealed');
        });

        await t.test('neither the password nor the token is in what the page reaches', async()=>{
            const reached = await evaluate(`JSON.stringify({ posted,
                html: document.documentElement.outerHTML, storage: { ...localStorage },
                session: { ...sessionStorage }, name: window.name })`, page);
            assert.doesNotMatch(reached, new RegExp(`${PASSWORD}|${SECRET}|eyJ`));
            assert.doesNotMatch(await evaluate('document.documentElement.outerHTML', signin),
                new RegExp(`${PASSWORD}|${SECRET}`), 'nor left in the frame\'s own document');
            const kept = await evaluate(`new Promise(done => {
                const request = indexedDB.open('gamehub');
                request.onsuccess = () => {
                    const read = request.result.transaction('sessions').objectStore('sessions')
                        .get('steam');
                    read.onsuccess = () => done({ name: read.result.accountName,
                        sealed: new TextDecoder('latin1').decode(read.result.sealed) });
                };
            })`, worker);
            assert.equal(kept.name, 'email', 'kept by the worker');
            assert.doesNotMatch(kept.sealed, new RegExp(SECRET), 'sealed');
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
