/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The launcher in a headless browser that stays up and takes orders, for
 * walking a title's screens a step at a time: a screenshot of the picture, a
 * person says what to press, the press goes in, the next screenshot comes.
 * The run is never restarted to get past a screen, and the engine is there to
 * be asked at any moment (`globalThis.app` in the launcher tab).
 *
 *   node tools/cdp_test/live/drive.mjs [card] [query]
 *
 * opens https://127.0.0.1:5180/library (the launcher running over TLS, as the
 * person's own browser has it), starts the bottle whose card matches the
 * regular expression `card` if one is given, and listens on
 * http://127.0.0.1:9401:
 *
 *   /shot?file=PATH      the picture, cut to the canvas, as a PNG; answers the path
 *   /click?x=&y=         a left click at the program's own pixels
 *   /key?code=Enter      a key press, by KeyboardEvent.code
 *   /type?text=123       characters typed one after another
 *   /eval?js=EXPR        the value of an expression in the launcher tab, as JSON
 *   /quit                closes the browser and ends
 *
 * `query` is put on the library's URL (`hook=...`, the launcher's knobs).
 * Downloads -- the launcher's report -- land in dbg/live-downloads. The
 * profile is dbg/chrome-profile, so the bottle store and saves are kept
 * between runs.
 */

import { createServer } from 'node:http';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { launchWithGpu, shutdown } from '../browser.mjs';
import { CdpEndpoint } from '../cdp.mjs';

const PORT = 9401;
const [pattern = '', query = ''] = process.argv.slice(2);

/** @param {number} ms */
const sleep = ms=>new Promise(done=>setTimeout(done, ms));

const browser = await launchWithGpu({ headed: false, profileDir: 'dbg/chrome-profile' });
const cdp = new CdpEndpoint(browser.browserWs);
await cdp.open();
const downloads = resolve('dbg/live-downloads');
await mkdir(downloads, { recursive: true });
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
const { targetId } = await cdp.send('Target.createTarget',
    { url: `https://127.0.0.1:5180/library${query ? `?${query}` : ''}` });
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

/** @param {string} method @param {Record<string, unknown>} [params] */
const send = (method, params = {})=>cdp.send(method, params, sessionId);
await send('Runtime.enable');

/** @param {string} js */
const evaluate = async js=>{
    const answer = await send('Runtime.evaluate',
        { expression: js, returnByValue: true, awaitPromise: true });
    return answer.exceptionDetails
        ? `exception: ${answer.exceptionDetails.exception?.description}`
        : answer.result?.value;
};

if (pattern)
{
    await sleep(6000);
    console.log('card:', await evaluate(`(()=>{
        const c=[...document.querySelectorAll('.MuiCard-root')].find(o=>/${pattern}/i.test(o.textContent));
        if(!c) return 'none'; c.click(); return c.textContent;})()`));
    await sleep(1500);
    console.log('play:', await evaluate(`(()=>{
        const b=[...document.querySelectorAll('button')].find(o=>o.textContent.trim()==='Play');
        if(!b) return 'none'; b.click(); return 'ok';})()`));
}

/** Where the picture is on the page, and how many of the program's pixels it holds. */
const canvas = async()=>evaluate(`(()=>{
    const c=document.querySelector('canvas'); if(!c) return null;
    const r=c.getBoundingClientRect();
    return {x:r.left,y:r.top,w:r.width,h:r.height,cw:c.width,ch:c.height};})()`);

/** @type {Record<string, number>} */
const VIRTUAL_KEYS = { Enter: 13, Escape: 27, Space: 32, Tab: 9, Backspace: 8,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };
/** @param {string} code */
const keyOf = code=>(code.startsWith('Key') ? code.slice(3).toLowerCase()
    : code.startsWith('Digit') ? code.slice(5) : code === 'Space' ? ' ' : code);
/** @param {string} code */
const virtualKeyOf = code=>VIRTUAL_KEYS[code] ?? keyOf(code).toUpperCase().charCodeAt(0);
/** @param {string} ch */
const codeOfChar = ch=>(/[0-9]/.test(ch) ? `Digit${ch}` : /[a-z]/i.test(ch)
    ? `Key${ch.toUpperCase()}` : ch === ' ' ? 'Space' : ch);

/** @param {string} code @param {string} [text] */
const press = async(code, text)=>{
    const key = text ?? keyOf(code);
    const base = { code, key, windowsVirtualKeyCode: virtualKeyOf(code),
        nativeVirtualKeyCode: virtualKeyOf(code) };
    await send('Input.dispatchKeyEvent',
        { type: 'keyDown', ...base, ...key.length === 1 ? { text: key } : {} });
    await sleep(80);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
};

let shots = 0;
createServer(async(request, answer)=>{
    const url = new URL(request.url ?? '/', 'http://x');
    /** @param {string} name */
    const arg = name=>url.searchParams.get(name) ?? '';
    try
    {
        let out = 'ok';
        if (url.pathname === '/shot')
        {
            const at = await canvas();
            const clip = at ? { x: at.x, y: at.y, width: at.w, height: at.h, scale: 1 } : undefined;
            const { data } = await send('Page.captureScreenshot',
                { format: 'png', ...clip ? { clip } : {} });
            const file = resolve(arg('file') || `dbg/live-shot-${++shots}.png`);
            await writeFile(file, Buffer.from(data, 'base64'));
            out = file;
        }
        else if (url.pathname === '/click')
        {
            const at = await canvas();
            const x = at.x + Number(arg('x')) * at.w / at.cw;
            const y = at.y + Number(arg('y')) * at.h / at.ch;
            await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
            await sleep(60);
            await send('Input.dispatchMouseEvent',
                { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
            await sleep(120);
            await send('Input.dispatchMouseEvent',
                { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        }
        else if (url.pathname === '/key')
        {
            await press(arg('code'));
        }
        else if (url.pathname === '/type')
        {
            for (const ch of arg('text'))
            {
                await press(codeOfChar(ch), ch);
                await sleep(120);
            }
        }
        else if (url.pathname === '/eval')
        {
            out = JSON.stringify(await evaluate(arg('js')));
        }
        else if (url.pathname === '/quit')
        {
            answer.end('bye\n');
            await shutdown(browser);
            process.exit(0);
        }
        answer.end(`${out}\n`);
    }
    catch (e){
        answer.end(`error: ${/** @type {Error} */ (e).message}\n`);
    }
}).listen(PORT, '127.0.0.1', ()=>console.log(`listening on ${PORT}`));
