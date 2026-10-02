/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The graphics worker of the graphics layer under the URL's `root`, as the
 * bench's scene thread sends its recorded calls to it: what arrives before
 * that layer is loaded waits for it.
 */

/** @type {MessageEvent[]} */
const early = [];
self.onmessage = event=>{
    early.push(event);
};
const root = new URL(location.href).searchParams.get('root');
const { serveGraphics } = await import(`${root}/remote/worker.js`);
serveGraphics(/** @type {any} */ (self), { gpu: navigator.gpu });
for (const event of early)
{
    /** @type {any} */ (self).onmessage(event);
}
