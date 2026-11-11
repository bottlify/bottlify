/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Opens the shared headed browser on the launcher and holds it open, with a
 * profile kept between starts so the bundle cache in OPFS survives. Nothing
 * here drives the page: a person does, and the other scripts watch. The
 * GameHub extension is always loaded (unpacked, from `GAMEHUB_DIR`, by default
 * the launcher repository's `gamehub/dist/dev`): a store's sign-in, its games
 * and their installs all go through it, and the library without it offers
 * none. A browser that could not load it says so and closes.
 *
 *   node tools/cdp_test/live/browser.mjs [url] [chrome flags]
 *
 * `BROWSER_PROFILE` names the profile directory (default `dbg/chrome-profile`):
 * the one a store is signed in under keeps that sign-in and its bottles.
 *
 * The default address is the launcher over TLS on the VM's address, the origin
 * the person's saves live under (see the launcher's own README).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { BACKGROUND_OFF, findBrowser } from '../browser.mjs';
import { CdpEndpoint } from '../cdp.mjs';
import { PORT } from './connect.mjs';

const url = process.argv[2] ?? 'https://192.168.100.22:5180/library';
// Throwaway by nature and large (OPFS holds whole bundles): under dbg/, never
// in the tree.
const profile = resolve(process.env.BROWSER_PROFILE ?? 'dbg/chrome-profile');
const gamehub = resolve(process.env.GAMEHUB_DIR ?? '../bottlify-ui/gamehub/dist/dev');
if (!existsSync(resolve(gamehub, 'manifest.json')))
{
    console.error(`no GameHub at ${gamehub}: build it (npm run build in bottlify-ui) `
        + 'or set GAMEHUB_DIR');
    process.exit(1);
}
const browser = spawn(findBrowser(), [
    '--no-first-run', '--no-default-browser-check', '--disable-search-engine-choice-screen',
    '--disable-sync',
    '--disable-features=SigninPromo,SignInProfileCreation,PrivacySandboxSettings4',
    '--no-proxy-server', '--proxy-bypass-list=*',
    '--enable-unsafe-webgpu', '--enable-unsafe-swiftshader',
    '--autoplay-policy=no-user-gesture-required',
    // What lets Extensions.loadUnpacked load GameHub over the port.
    '--enable-unsafe-extension-debugging',
    // Covered or on a screen that is off, the page would run at idle priority.
    ...BACKGROUND_OFF,
    `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
    // Flags after the url, for a run that needs them: the software adapter
    // (`--use-webgpu-adapter=swiftshader`) is the one that tells a defect of
    // ours from the machine's GPU driver.
    ...process.argv.slice(3),
    url,
], { stdio: ['ignore', 'ignore', 'inherit'] });
browser.on('exit', code=>{
    console.log('browser exited', code);
    process.exit(0);
});
for (let attempt = 0; attempt < 60; attempt++)
{
    await new Promise(done=>setTimeout(done, 500));
    /** @type {Response | null} */
    const answer = await fetch(`http://127.0.0.1:${PORT}/json/version`).catch(()=>null);
    if (!answer?.ok)
    {
        continue;
    }
    console.log('CDP up on', PORT, 'at', url);
    const cdp = new CdpEndpoint((await answer.json()).webSocketDebuggerUrl);
    await cdp.open();
    try
    {
        const { id } = await cdp.send('Extensions.loadUnpacked', { path: gamehub });
        console.log('GameHub loaded', id);
    }
    catch (e){
        console.error('GameHub did not load:', e instanceof Error ? e.message : e);
        browser.kill();
        process.exit(1);
    }
    break;
}
setInterval(()=>{}, 1 << 30);
