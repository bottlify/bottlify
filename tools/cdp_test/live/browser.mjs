/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Opens the shared headed browser on the launcher and holds it open, with a
 * profile kept between starts so the bundle cache in OPFS survives. Nothing
 * here drives the page: a person does, and the other scripts watch.
 *
 *   node tools/cdp_test/live/browser.mjs [url]
 *
 * The default address is the launcher over TLS on the VM's address, the origin
 * the person's saves live under (see the launcher's own README).
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { findBrowser } from '../browser.mjs';
import { PORT } from './connect.mjs';

const url = process.argv[2] ?? 'https://192.168.100.22:5180/library';
// Throwaway by nature and large (OPFS holds whole bundles): under dbg/, never
// in the tree.
const profile = resolve('dbg/chrome-profile');
const browser = spawn(findBrowser(), [
    '--no-first-run', '--no-default-browser-check', '--disable-search-engine-choice-screen',
    '--disable-sync',
    '--disable-features=SigninPromo,SignInProfileCreation,PrivacySandboxSettings4',
    '--no-proxy-server', '--proxy-bypass-list=*',
    '--enable-unsafe-webgpu', '--enable-unsafe-swiftshader',
    '--autoplay-policy=no-user-gesture-required',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
    url,
], { stdio: ['ignore', 'ignore', 'inherit'] });
browser.on('exit', code=>{
    console.log('browser exited', code);
    process.exit(0);
});
for (let attempt = 0; attempt < 60; attempt++)
{
    await new Promise(done=>setTimeout(done, 500));
    try
    {
        if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok)
        {
            console.log('CDP up on', PORT, 'at', url);
            break;
        }
    }
    catch {
        // not yet
    }
}
setInterval(()=>{}, 1 << 30);
