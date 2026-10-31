/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A headless Chrome over a DevTools pipe, for the extension's integration
 * tests. A branded Chrome ignores --load-extension: the extension is loaded
 * over the pipe (Extensions.loadUnpacked), which needs
 * --enable-unsafe-extension-debugging.
 */

import { spawn } from 'node:child_process';
import { findBrowser } from '../../../tools/cdp_test/browser.mjs';

/**
 * @param {string} profile  Kept short: Windows' MAX_PATH is 260, and a
 *     profile deep in a temp tree fails to open its databases.
 */
export function chrome(profile){
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
    /** @type {Set<(event: { method: string, params: any, sessionId?: string }) => void>} */
    const listeners = new Set();
    inp.on('data', data=>{
        buffered += data;
        for (let end; (end = buffered.indexOf('\0')) >= 0;)
        {
            const message = JSON.parse(buffered.slice(0, end));
            buffered = buffered.slice(end + 1);
            if (message.id)
            {
                waiting.get(message.id)?.(message);
            }
            else
            {
                listeners.forEach(listener=>listener(message));
            }
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
    /** @param {(event: { method: string, params: any, sessionId?: string }) => void} listener */
    const on = listener=>listeners.add(listener);
    return { proc, send, on };
}
