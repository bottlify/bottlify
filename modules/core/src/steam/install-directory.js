/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A Steam app's depots installed into a directory on a host, in Node: the
 * install a page runs into a bottle in the browser (install.js, redist.js),
 * landed in files instead. A file already whole (its size and SHA-1) is kept,
 * so a run stopped part way is run again. Speaking to Steam for the depots'
 * keys, codes and servers is the caller's (GameHub's tools).
 */

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { depotManifest, downloadFiles, installedFiles } from './install.js';
import { installSteamRedistributables } from './redist.js';

/** @typedef {import('./install.js').DepotOpening} DepotOpening */
/** @typedef {import('./depot.js').ContentServer} ContentServer */

/**
 * A directory as redist.js reaches an installed app.
 *
 * @param {string} directory
 * @returns {import('./redist.js').AppTree}
 */
export function directoryTree(directory){
    /** @param {string} path */
    const onDisk = path=>join(directory, ...path.split('\\'));
    return {
        list: async()=>(await readdir(directory, { recursive: true, withFileTypes: true }))
            .filter(entry=>entry.isFile())
            .map(entry=>relative(directory, join(entry.parentPath, entry.name))
                .split(sep).join('\\')),
        read: async path=>new Uint8Array(await readFile(onDisk(path))),
        write: async(path, bytes)=>{
            await mkdir(dirname(onDisk(path)), { recursive: true });
            await writeFile(onDisk(path), bytes);
        },
    };
}

/** @param {string} path @returns {Promise<Buffer>} */
const sha1 = path=>new Promise((resolve, reject)=>{
    const hash = createHash('sha1');
    createReadStream(path).on('data', data=>hash.update(data)).on('end', ()=>resolve(hash.digest()))
        .on('error', reject);
});

/**
 * Installs depots into a directory: what the tool does once it has the
 * depots' keys and codes and the content servers.
 *
 * @param {Object} options
 * @param {string} options.out
 * @param {DepotOpening[]} options.depots  In the order they install.
 * @param {ContentServer[]} options.servers
 * @param {string} [options.installscript]  The app's own (`extended.installscript`).
 * @param {string} [options.executable]  The program Steam starts, as a path in the app.
 * @param {number} [options.jobs]
 * @param {Parameters<typeof downloadFiles>[0]['decode']} [options.decode]
 * @param {(line: string) => void} [options.log]
 */
export async function installToDirectory({ out, depots, servers, installscript, executable,
    jobs = 16, decode, log = ()=>{} })
{
    const listed = [];
    for (const opening of depots)
    {
        const one = await depotManifest(servers, opening).catch(e=>{
            throw new Error(`depot ${opening.depot}'s manifest was refused --`
                + ` its request code lasts minutes and may have expired; ask for the install again`
                + ` (${/** @type {Error} */ (e).message})`);
        });
        log(`depot ${opening.depot}: ${one.files.length} files,`
            + ` ${(one.size / 2 ** 20).toFixed(0)} MiB`);
        listed.push({ opening, manifest: one });
    }
    const { files, directories } = installedFiles(
        listed.map(({ opening, manifest: one })=>({ manifest: one, key: opening.key })));

    /** @param {string} path */
    const onDisk = path=>join(out, ...path.split('\\'));
    let done = 0;
    let kept = 0;
    const total = files.reduce((sum, file)=>sum + file.size, 0);
    for (const directory of directories)
    {
        await mkdir(onDisk(directory), { recursive: true });
    }
    /** @type {typeof files} */
    const wanted = [];
    for (const file of files)
    {
        const path = onDisk(file.path);
        await mkdir(dirname(path), { recursive: true });
        if (existsSync(path) && statSync(path).size === file.size
            && Buffer.compare(await sha1(path), Buffer.from(file.sha)) === 0)
        {
            kept += file.size;
            done += file.size;
        }
        else if (file.chunks.length === 0)
        {
            const handle = await open(path, 'w');
            await handle.truncate(file.size);
            await handle.close();
        }
        else
        {
            wanted.push(file);
        }
    }

    /** @type {Map<string, { handle: Promise<import('node:fs/promises').FileHandle>, left: number }>} */
    const opened = new Map();
    const started = Date.now();
    const progress = setInterval(()=>{
        const seconds = (Date.now() - started) / 1000;
        log(`  ${(done / 2 ** 20).toFixed(0)} of ${(total / 2 ** 20).toFixed(0)} MiB`
            + ` (${(done / 2 ** 20 / seconds).toFixed(1)} MiB/s), ${(kept / 2 ** 20).toFixed(0)} MiB kept`);
    }, 10_000);
    try
    {
        await downloadFiles({ files: wanted, servers, jobs, decode,
            write: async(file, chunk, bytes)=>{
                if (!opened.has(file.path))
                {
                    opened.set(file.path, { left: file.chunks.length,
                        handle: open(onDisk(file.path), 'w').then(async handle=>{
                            await handle.truncate(file.size);
                            return handle;
                        }) });
                }
                const entry = /** @type {{ handle: Promise<any>, left: number }} */ (
                    opened.get(file.path));
                const handle = await entry.handle;
                await handle.write(bytes, 0, bytes.length, chunk.offset);
                done += bytes.length;
                if (--entry.left === 0)
                {
                    await handle.close();
                }
            } });
    }
    finally
    {
        clearInterval(progress);
    }

    // What Steam does on the first start: the app's install script, then each
    // redistributable's, run against the bottle's machine -- its program's width;
    // and the prerequisites the app carries itself.
    for (const line of await installSteamRedistributables(directoryTree(out), { installscript,
        executable, shared: listed.filter(({ opening })=>opening.shared)
            .flatMap(({ manifest: one })=>one.files.map(file=>file.name)) }))
    {
        log(line);
    }
    return { files: files.length, bytes: total, seconds: (Date.now() - started) / 1000 };
}
