/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
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
    for (const candidate of CANDIDATES)
    {
        if (candidate && existsSync(candidate))
        {
            return candidate;
        }
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
    return start(browser, [
        '--disable-gpu',
        '--autoplay-policy=no-user-gesture-required',
    ]);
}

/**
 * Launches a headless browser that will hand out a GPU.
 *
 * The acceptance probe launches with `--disable-gpu`, which is right for it and
 * fatal for anything that draws, so a scenario needing a device asks for one
 * here. Two of these flags were each the difference between a device and none,
 * and both were found by measurement: `--enable-unsafe-webgpu` stops the
 * browser refusing every adapter it has not blessed -- without it
 * `requestAdapter` answers null and Dawn reports "no available adapters", which
 * reads as a machine with no WebGPU at all -- and `--enable-unsafe-swiftshader`
 * leaves a software adapter available where there is no hardware one. Which
 * adapter answered is worth reporting, because a software rasteriser and a real
 * one are not the same measurement.
 *
 * @param {Object} [options]
 * @param {string} [options.browser]
 * @returns {Promise<BrowserHandle>}
 */
export function launchWithGpu({ browser = findBrowser() } = {}){
    return start(browser, [
        '--enable-unsafe-webgpu',
        '--enable-unsafe-swiftshader',
    ]);
}

/**
 * Spawns the browser and waits for it to say where its CDP endpoint is.
 *
 * @param {string} browser
 * @param {string[]} flags   What this scenario needs on top of the common set.
 * @returns {Promise<BrowserHandle>}
 */
function start(browser, flags){
    const profileRoot = mkdtempSync(join(tmpdir(), 'bottlify-cdp_test-'));
    const proc = spawn(
        browser,
        [
            '--headless=new',
            '--no-sandbox',
            '--no-proxy-server',
            '--proxy-bypass-list=*',
            '--window-size=1280,720',
            ...flags,
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
        if (match)
        {
            browserWs = match[1];
        }
    });

    const waitForEndpoint = ()=>
        new Promise((resolve, reject)=>{
            const started = Date.now();
            const timer = setInterval(()=>{
                if (browserWs)
                {
                    clearInterval(timer);
                    resolve(browserWs);
                    return;
                }
                if (proc.exitCode != null)
                {
                    clearInterval(timer);
                    reject(new Error(
                        `browser exited early (${proc.exitCode}): ${stderr.slice(0, 400)}`));
                    return;
                }
                if (Date.now() - started > 15000)
                {
                    clearInterval(timer);
                    reject(new Error(
                        `timed out waiting for the CDP endpoint: ${stderr.slice(0, 400)}`));
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

    // The parent exiting is not the browser being gone: its renderer and zygote
    // children outlive it and go on writing the profile, so a recursive remove
    // can lose the race however long it retries.
    //
    // Which is why this cannot throw. What the harness answers is whether the
    // worker came up and replied; a temporary directory that outlives the run
    // is not part of that answer, and letting its removal fail turned three
    // successful probes into a red build.
    try
    {
        rmSync(handle.profileRoot,
            { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    catch (e){
        console.error(`left ${handle.profileRoot} behind: ${e.message}`);
    }
}
