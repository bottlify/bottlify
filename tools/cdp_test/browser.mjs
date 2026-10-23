/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';

/**
 * Finds and launches a Chromium-based browser with a CDP endpoint.
 */

/**
 * Ends a browser an earlier run left on this profile. A run whose node process
 * was killed outright (the host reclaiming memory) cannot close its browser,
 * and the orphan kept the profile's lock and seven gigabytes -- enough for the
 * next run to be killed the same way. Best effort: nothing to end is fine.
 *
 * @param {string} profileRoot
 */
function closeLeftBehind(profileRoot){
    try
    {
        if (process.platform === 'win32')
        {
            const needle = profileRoot.replace(/'/g, "''");
            execFileSync('powershell', ['-NoProfile', '-Command',
                `Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'"`
                + ` | Where-Object { $_.CommandLine -like '*${needle}*' }`
                + ' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force'
                + ' -ErrorAction SilentlyContinue }'], { stdio: 'ignore', timeout: 30_000 });
        }
        else
        {
            execFileSync('pkill', ['-f', `--user-data-dir=${profileRoot}`], { stdio: 'ignore' });
        }
    }
    catch {
        // Nothing left behind, or no way to ask: the launch goes on.
    }
}

/** The browser's backgrounding of a hidden page, off: a page measured runs as one in front. */
export const BACKGROUND_OFF = Object.freeze(['--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling']);

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
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
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
 * @property {string} profileRoot  The user-data dir in use.
 * @property {boolean} ownProfile  Whether it is a temporary dir this call made
 *     (removed on shutdown) rather than one the caller named (kept).
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
 * @param {boolean} [options.headed]  A window a person can watch, for a run they asked to see.
 * @param {string} [options.profileDir]  A user-data dir of the caller's own,
 *     kept rather than removed on shutdown -- what a warm-store measurement
 *     needs, since OPFS is scoped to the profile and a fresh one starts cold
 *     every time.
 * @param {string[]} [options.extraFlags]  Extra Chrome flags a scenario needs on
 *     top of the common GPU set, e.g. `--js-flags=--no-liftoff` for a V8-tiering
 *     diagnostic run.
 * @returns {Promise<BrowserHandle>}
 */
export function launchWithGpu(
    { browser = findBrowser(), headed = false, profileDir, extraFlags = [] } = {},
)
{
    return start(browser, [
        '--enable-unsafe-webgpu',
        '--enable-unsafe-swiftshader',
        // A scenario clicks Play through the protocol, and the browser does not
        // count that as a gesture: the audio context stays suspended, the
        // launcher switches sound off, and a run that was meant to measure
        // sound measures its absence. Nobody sits at this browser to click.
        '--autoplay-policy=no-user-gesture-required',
        ...extraFlags,
    ], headed, profileDir);
}

/**
 * Spawns the browser and waits for it to say where its CDP endpoint is.
 *
 * @param {string} browser
 * @param {string[]} flags   What this scenario needs on top of the common set.
 * @param {boolean} [headed]
 * @param {string} [profileDir]
 * @returns {Promise<BrowserHandle>}
 */
function start(browser, flags, headed = false, profileDir){
    const ownProfile = !profileDir;
    // Chrome on Windows does not reliably start a relative `--user-data-dir`
    // -- observed as a launch that never writes a byte to stderr and never
    // exits, rather than a clean error. Absolute is what both branches were
    // already handing it: `mkdtempSync` always answers one.
    const profileRoot = ownProfile
        ? mkdtempSync(join(tmpdir(), 'bottlify-cdp_test-'))
        : resolvePath(profileDir);
    if (!ownProfile)
    {
        closeLeftBehind(profileRoot);
    }
    const proc = spawn(
        browser,
        [
            ...(headed ? [] : ['--headless=new']),
            // Silent: a measurement's program plays its music through the
            // machine's speakers otherwise, over whatever the person at it is
            // doing; the audio path is still exercised, only not heard.
            '--mute-audio',
            // A fresh profile every launch, so without these a visible window
            // opens on the first-run questions -- a search engine to pick, an
            // account to sign into -- over the page a person came to watch.
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-search-engine-choice-screen',
            '--disable-sync',
            '--disable-features=SigninPromo,SignInProfileCreation,PrivacySandboxSettings4',
            '--no-sandbox',
            '--no-proxy-server',
            '--proxy-bypass-list=*',
            '--window-size=1280,720',
            // A window nobody sees -- covered, or on a screen that is off -- is
            // a background tab to the browser, whose renderer Windows then runs
            // at idle priority: the engine waited for a core a quarter of the
            // time, and the frame times measured were the scheduler's.
            ...BACKGROUND_OFF,
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
    const handle = { proc, browserWs: '', profileRoot, ownProfile };
    return waitForEndpoint().then(ws=>{
        handle.browserWs = ws;
        return handle;
    });
}

/**
 * Stops the browser and removes its profile, unless the caller named it --
 * a profile passed in for a warm-store run is the caller's to keep.
 * @param {BrowserHandle} handle
 * @returns {Promise<void>}
 */
export async function shutdown(handle){
    handle.proc.kill();
    await new Promise(resolve=>handle.proc.once('exit', resolve));

    if (!handle.ownProfile)
    {
        return;
    }

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
