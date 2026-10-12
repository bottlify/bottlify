/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The launcher in a browser that stays up and takes orders -- headless, or a
 * window a person plays in (DRIVE_HEADED=1) -- for
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
 * http://127.0.0.1:9401 (DRIVE_PORT; DRIVE_PROFILE names another profile):
 *
 *   /shot?file=PATH      the picture, cut to the canvas, as a PNG; answers the path
 *   /click?x=&y=         a left click at the program's own pixels
 *   /move?x=&y=          the pointer moved there, no button
 *   /drag?x=&y=&to=X,Y&steps=N   the left button held from one point to another,
 *                        through N moves (10 by default) -- a window dragged
 *   /key?code=Enter      a key press, by KeyboardEvent.code
 *   /type?text=123       characters typed one after another
 *   /eval?js=EXPR        the value of an expression in the launcher tab, as JSON
 *   /report?file=PATH    the running title's report, as Download report saves it;
 *                        answers the path (dbg/live-downloads by default)
 *   /dump?frames=N&file=PATH  the next N frames with draws written down by the
 *                        running devices (app.debug.dumpFrames), then the last of
 *                        them as text: every draw with its shaders, stages (an
 *                        empty one says placeholder) and state, each shader's
 *                        bytecode, and every texture -- uploaded, dirty, resident.
 *                        Answers the path (dbg/live-downloads by default)
 *   /stack               where the tab's own code is running when it answers nothing else
 *   /upload?file=PATH    a file handed to the page's file input (`selector`, the
 *                        first one by default) -- the library's Add, for an installer
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
import { pausedStack } from '../timeout-report.mjs';

// Another session's walk may hold the defaults: DRIVE_PORT and DRIVE_PROFILE
// give this one its own, since two browsers cannot share a profile.
const PORT = Number(process.env.DRIVE_PORT ?? 9401);
const [pattern = '', query = ''] = process.argv.slice(2);

/** @param {number} ms */
const sleep = ms=>new Promise(done=>setTimeout(done, ms));

// DRIVE_HEADED=1 shows the window: a person plays in it while the endpoints
// below look inside the same tab. DRIVE_FLAGS adds Chrome flags, space
// separated: `--use-webgpu-adapter=swiftshader` draws in software, where a
// virtual machine's GPU driver adds glitches of its own to the picture.
const browser = await launchWithGpu({
    headed: process.env.DRIVE_HEADED === '1',
    profileDir: process.env.DRIVE_PROFILE ?? 'dbg/chrome-profile',
    extraFlags: (process.env.DRIVE_FLAGS ?? '').split(' ').filter(Boolean) });
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
        else if (url.pathname === '/move')
        {
            const at = await canvas();
            await send('Input.dispatchMouseEvent', { type: 'mouseMoved',
                x: at.x + Number(arg('x')) * at.w / at.cw, y: at.y + Number(arg('y')) * at.h / at.ch });
        }
        else if (url.pathname === '/drag')
        {
            const at = await canvas();
            /** @param {number} x @param {number} y */
            const page = (x, y)=>({ x: at.x + x * at.w / at.cw, y: at.y + y * at.h / at.ch });
            const from = page(Number(arg('x')), Number(arg('y')));
            const [toX, toY] = arg('to').split(',').map(Number);
            const to = page(toX, toY);
            const steps = Math.max(1, Number(arg('steps')) || 10);
            await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...from });
            await send('Input.dispatchMouseEvent',
                { type: 'mousePressed', ...from, button: 'left', clickCount: 1 });
            for (let step = 1; step <= steps; step++)
            {
                await sleep(30);
                await send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left',
                    buttons: 1, x: from.x + (to.x - from.x) * step / steps,
                    y: from.y + (to.y - from.y) * step / steps });
            }
            await send('Input.dispatchMouseEvent',
                { type: 'mouseReleased', ...to, button: 'left', clickCount: 1 });
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
        else if (url.pathname === '/report')
        {
            // What the launcher's Download report saves, taken from the running
            // engine at once: every layer's diagnostics, the phase profile, the
            // threads, the hottest guest code, and the journal ring.
            const report = await evaluate(`(async()=>{
                const app = globalThis.app;
                if (!app) { return { error: 'no title is running' }; }
                const [records, presented, engine] = await Promise.all([
                    app.log.recent(${Number(arg('records') || 20000)}), app.presented(),
                    typeof app.report === 'function' ? app.report()
                        : app.diagnostics().then(diagnostics=>({ diagnostics }))]);
                return { at: new Date().toISOString(), presented, engine, journal: records };
            })()`);
            const file = resolve(arg('file') || `${downloads}/live-report-${Date.now()}.json`);
            await writeFile(file, JSON.stringify(report));
            out = file;
        }
        else if (url.pathname === '/dump')
        {
            // The devices answer what they wrote down a report later, and the
            // frames have to be drawn first: asked, waited for, and read twice.
            const frames = Math.max(1, Number(arg('frames') || 1));
            await evaluate(`globalThis.app.debug.dumpFrames(${frames})`);
            await sleep(Number(arg('waitMs') || 1500));
            const read = `(async()=>{
                const report = await globalThis.app.report();
                const graphics = report.engine?.diagnostics?.find(d=>d.name === 'graphics')
                    ?? report.diagnostics?.find(d=>d.name === 'graphics');
                const device = graphics?.metrics?.seam?.device ?? {};
                return { frames: (device.recentFrames ?? []).slice(-3),
                    lines: device.lastDump ?? [], shaders: device.shaderBytecode ?? [],
                    textures: device.textureRecords ?? [] };
            })()`;
            await evaluate(read);
            const dumped = await evaluate(read);
            const text = [
                '== frames', ...dumped.frames.map((/** @type {any} */ f)=>JSON.stringify(f)),
                '', '== draws of the last frame written down', ...dumped.lines,
                '', '== shaders', ...dumped.shaders,
                '', '== textures',
                ...dumped.textures.map((/** @type {any} */ t)=>`${t.id} ${t.width}x${t.height}`
                    + ` fmt=${t.format} levels=${t.levels} uploads=${t.uploads}`
                    + ` dirty=${t.dirty} resident=${t.resident}`
                    + ` written=${(t.written ?? []).join(',')}`),
            ].join('\n');
            const file = resolve(arg('file') || `${downloads}/live-dump-${Date.now()}.txt`);
            await writeFile(file, text);
            out = `${file} (${dumped.lines.length} lines)`;
        }
        else if (url.pathname === '/stack')
        {
            out = await pausedStack(cdp, sessionId);
        }
        else if (url.pathname === '/upload')
        {
            const { root } = await send('DOM.getDocument', { depth: 0 });
            const { nodeId } = await send('DOM.querySelector',
                { nodeId: root.nodeId, selector: arg('selector') || 'input[type=file]' });
            await send('DOM.setFileInputFiles', { nodeId, files: [resolve(arg('file'))] });
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
