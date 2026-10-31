#!/usr/bin/env node
/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Steam client's own DLLs (`steamclient.dll`, `steamclient64.dll`), fetched
 * from Valve's public client CDN into a cache on this machine, outside the
 * repository -- what a page keeps in its own storage, for the node runs and
 * the cdp harness. They are data a program reads as the installed client's,
 * never run (`@bottlify/core/steam`'s fetchClientFiles); never committed,
 * never put in a bottle.
 *
 *   node tools/steam-client.mjs [--refresh]   prints the cache's folder
 *
 * Importable: `clientFilesCached()` answers the files, fetching them once.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CLIENT_FILES, fetchClientFiles } from '../modules/core/src/steam/client.js';

/** Where the files are kept: one folder per client version. */
export const CACHE = join(homedir(), '.bottlify', 'steam-client');

/**
 * The client's DLLs by name, from the cache or fetched into it.
 *
 * @param {{ refresh?: boolean }} [options]
 * @returns {Promise<{ folder: string, files: Record<string, Uint8Array> }>}
 */
export async function clientFilesCached({ refresh = false } = {}){
    if (!refresh)
    {
        const versions = (await readdir(CACHE).catch(()=>[])).sort();
        const newest = versions.at(-1);
        if (newest)
        {
            const folder = join(CACHE, newest);
            const read = await Promise.all(CLIENT_FILES.map(async name=>[name,
                new Uint8Array(await readFile(join(folder, name)).catch(()=>new Uint8Array()))]));
            if (read.every(([, bytes])=>bytes.length > 0))
            {
                return { folder, files: Object.fromEntries(read) };
            }
        }
    }
    const { version, files } = await fetchClientFiles();
    const folder = join(CACHE, version || 'unknown');
    await mkdir(folder, { recursive: true });
    for (const [name, bytes] of Object.entries(files))
    {
        await writeFile(join(folder, name), bytes);
    }
    return { folder, files };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
{
    const refresh = process.argv.includes('--refresh');
    const { folder, files } = await clientFilesCached({ refresh });
    console.log(folder);
    for (const [name, bytes] of Object.entries(files))
    {
        console.log(`  ${name} ${bytes.length} bytes`);
    }
}
