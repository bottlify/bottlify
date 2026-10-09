/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Plays a bottle in the browser from this checkout, with nothing else set up:
 * serves the player page (`tools/play/index.html`), the engine's build
 * (`modules/core/dist`, `npm run build` first) at /bottlify/, and the bottles
 * at /bundles/ -- every file answering HTTP Range, every response
 * cross-origin isolated unless `--compatible`. A bottle without its
 * program's image beside it has it extracted first (`make-btl.mjs extract`).
 *
 *   node tools/play.mjs <bundle-id> [--bundles bundles] [--port 8080] [--compatible]
 *
 * then open the address it prints. What it serves is what a page on any static
 * host needs: the same three paths.
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBundle } from './btl.mjs';
import { serveStatic } from './cdp_test/server.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PAGE = join(ROOT, 'tools', 'play');
const DIST = join(ROOT, 'modules', 'core', 'dist');

/**
 * The program's image at `<bottle>/entry`, out of the bundle by the manifest's
 * `entry`, unless it is there already.
 *
 * @param {string} directory
 */
export async function ensureEntry(directory){
    const out = join(directory, 'entry');
    if (existsSync(out))
    {
        return out;
    }
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    if (typeof manifest.entry !== 'string' || manifest.entry === '')
    {
        throw new Error(`${directory}: the manifest names no entry`);
    }
    const bundle = await openBundle(join(directory, 'bundle.btl'));
    try
    {
        await writeFile(out, await bundle.read(manifest.entry.replace(/\//g, '\\')));
    }
    finally
    {
        await bundle.close();
    }
    return out;
}

/**
 * @param {{ bundles: string, port?: number, coi?: boolean }} options
 */
export function servePlayer({ bundles, port = 0, coi = true }){
    return serveStatic({
        sandboxDir: PAGE, srcDir: PAGE, coi, port,
        extra: [
            { prefix: '/bottlify/', root: DIST },
            { prefix: '/bundles/', root: bundles },
            { prefix: '/', root: PAGE },
        ],
    });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    const args = process.argv.slice(2);
    /** @param {string} name @param {string} fallback */
    const option = (name, fallback)=>{
        const at = args.indexOf(`--${name}`);
        return at >= 0 ? args[at + 1] : fallback;
    };
    const id = args.find((arg, at)=>!arg.startsWith('--')
        && !['--bundles', '--port'].includes(args[at - 1]));
    if (!id)
    {
        console.error('usage: node tools/play.mjs <bundle-id> [--bundles bundles] [--port 8080]'
            + ' [--compatible]');
        process.exit(2);
    }
    if (!existsSync(join(DIST, 'core.js')))
    {
        console.error(`${DIST} has no build: run npm run build first`);
        process.exit(1);
    }
    const bundles = resolve(option('bundles', join(ROOT, 'bundles')));
    await ensureEntry(join(bundles, id));
    const server = await servePlayer({ bundles, port: Number(option('port', '8080')),
        coi: !args.includes('--compatible') });
    console.log(`http://127.0.0.1:${server.port}/?bottle=${encodeURIComponent(id)}`);
}
