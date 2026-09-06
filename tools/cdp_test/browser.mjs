/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Finds and launches a Chromium-based browser with a CDP endpoint.
 */

const CANDIDATES = [
    process.env.CDP_TEST_CHROME,
    process.env.CHROME_BIN,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
].filter(Boolean);

/**
 * @returns {string} path to a usable browser executable
 */
export function findBrowser(){
    for (const candidate of CANDIDATES){
        if (candidate && existsSync(candidate)) return candidate;
    }
    throw new Error(
        'No Chromium-based browser found. Set CDP_TEST_CHROME to the executable path.',
    );
}

/**
 * @typedef {Object} BrowserHandle
 * @property {import("node:child_process").ChildProcess} proc
 * @property {string} browserWs    Browser-level CDP WebSocket URL.
 * @property {string} profileRoot  Temporary user-data dir, removed on shutdown.
 */

/**
 * Launches a headless browser exposing a CDP endpoint.
 *
 * @param {Object} [options]
 * @param {string} [options.browser] Path to the browser executable.
 * @returns {Promise<BrowserHandle>}
 */
export function launch({ browser = findBrowser() } = {}){
    const profileRoot = mkdtempSync(join(tmpdir(), 'bottlify-cdp_test-'));
    const proc = spawn(
        browser,
        [
            '--headless=new',
            '--no-sandbox',
            '--disable-gpu',
            '--no-proxy-server',
            '--proxy-bypass-list=*',
            '--autoplay-policy=no-user-gesture-required',
            '--window-size=1280,720',
            `--user-data-dir=${profileRoot}`,
            '--remote-debugging-port=0',
            'about:blank',
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] },
    );

    let stderr = '';
    let browserWs = '';
    proc.stderr.on('data', chunk=>{
        stderr += chunk.toString();
        const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) browserWs = match[1];
    });

    const waitForEndpoint = ()=>
        new Promise((resolve, reject)=>{
            const started = Date.now();
            const timer = setInterval(()=>{
                if (browserWs){
                    clearInterval(timer);
                    resolve(browserWs);
                    return;
                }
                if (proc.exitCode != null){
                    clearInterval(timer);
                    reject(new Error(`browser exited early (${proc.exitCode}): ${stderr.slice(0, 400)}`));
                    return;
                }
                if (Date.now() - started > 15000){
                    clearInterval(timer);
                    reject(new Error(`timed out waiting for the CDP endpoint: ${stderr.slice(0, 400)}`));
                }
            }, 50);
        });

    /** @type {BrowserHandle} */
    const handle = { proc, browserWs: '', profileRoot };
    return waitForEndpoint().then(ws=>{
        handle.browserWs = ws;
        return handle;
    });
}

/**
 * Stops the browser and removes its temporary profile.
 * @param {BrowserHandle} handle
 * @returns {Promise<void>}
 */
export async function shutdown(handle){
    handle.proc.kill();
    await new Promise(resolve=>handle.proc.once('exit', resolve));
    rmSync(handle.profileRoot, { recursive: true, force: true });
}
