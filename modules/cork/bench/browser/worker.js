/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The entry of a bundle `build.mjs` makes: one measured run in a worker of its
 * own, the engine bundled in as the product bundles it. `@app` is the checkout's
 * `modules/core/src/app.js`, named at build time.
 */

// @ts-ignore -- an alias the bundler resolves
import { createApp } from '@app';
import { measureOnce } from './measure.js';

self.onmessage = async(/** @type {MessageEvent} */ event)=>{
    const { exeUrl, options } = event.data;
    try
    {
        const executable = new Uint8Array(await (await fetch(exeUrl)).arrayBuffer());
        self.postMessage(JSON.stringify(await measureOnce(createApp, executable, options)));
    }
    catch (e){
        self.postMessage(JSON.stringify({ error: String(/** @type {any} */ (e)?.stack ?? e) }));
    }
};
