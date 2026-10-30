/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Installs a Steam app the account owns into a directory, as the Steam
 * client lays it out: the depots for Windows and one language, each file
 * put together from its chunks (@bottlify/core/steam's depot.js).
 *
 *   NODE_USE_ENV_PROXY=1 node tools/steam-install.mjs --session <file> --app <id> --out <dir>
 *       [--branch public] [--language english] [--depots 401,402] [--jobs 16]
 *
 * --session is a signed-in session, { accountName, refreshToken }: the
 * launcher's /steam page keeps one in bottlify-ui/.steam/session.json, and
 * tools/steam-signin.mjs --token writes the same. A run stopped part way is
 * run again: a file already whole (its size and SHA-1) is kept.
 */

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, open, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { connectCm, logOn, productInfo } from '../modules/core/src/steam/index.js';
import {
    FILE_FLAG_DIRECTORY, contentServers, depotKey, downloadChunk, manifest, manifestRequestCode,
} from '../modules/core/src/steam/depot.js';

const argv = process.argv.slice(2);
/** @param {string} name */
const option = name=>{
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
};
const sessionPath = option('--session');
const app = Number(option('--app'));
const out = option('--out');
const branch = option('--branch') ?? 'public';
const language = option('--language') ?? 'english';
const only = option('--depots')?.split(',').map(Number);
const jobs = Number(option('--jobs') ?? 16);
if (!sessionPath || !app || !out)
{
    throw new Error('usage: node tools/steam-install.mjs --session <file> --app <id> --out <dir>');
}

const directory = await (await fetch('https://api.steampowered.com/ISteamDirectory/'
    + 'GetCMListForConnect/v1/?cellid=0&cmtype=websockets')).json();
/** @type {import('../modules/core/src/steam/connection.js').CmConnection | undefined} */
let connection;
for (const server of directory.response.serverlist.slice(0, 8))
{
    try
    {
        connection = await connectCm({ endpoint: server.endpoint });
        break;
    }
    catch (e){
        void e;
    }
}
if (!connection)
{
    throw new Error('no Steam connection manager answered');
}
const session = JSON.parse(readFileSync(sessionPath, 'utf8'));
await logOn(connection, session);
console.log(`logged on as ${session.accountName}`);

const { apps } = await productInfo(connection, { apps: [app] });
const info = /** @type {Record<string, any>} */ (apps.get(app));
const depots = /** @type {Record<string, any>} */ (info?.depots ?? {});
/** @type {Array<{ id: number, gid: bigint }>} */
const chosen = [];
for (const [id, depot] of Object.entries(depots))
{
    const gid = depot?.manifests?.[branch]?.gid;
    if (!/^\d+$/.test(id) || !gid)
    {
        continue;
    }
    const os = String(depot.config?.oslist ?? '');
    const lang = String(depot.config?.language ?? '');
    const wanted = only ? only.includes(Number(id))
        : (!os || os.split(',').includes('windows')) && (!lang || lang === language)
            && !depot.dlcappid;
    if (wanted)
    {
        chosen.push({ id: Number(id), gid: BigInt(gid) });
    }
}
console.log(`${info?.common?.name} (${app}), branch ${branch}:`
    + ` depots ${chosen.map(d=>d.id).join(', ')}`);

const servers = await contentServers(connection);
if (!servers.length)
{
    throw new Error('no content server offered');
}
console.log(`content servers: ${servers.slice(0, 3).map(s=>s.vhost).join(', ')}…`);

/** @param {string} path */
const sha1 = path=>new Promise((resolve, reject)=>{
    const hash = createHash('sha1');
    createReadStream(path).on('data', data=>hash.update(data)).on('end', ()=>resolve(hash.digest()))
        .on('error', reject);
});

let done = 0;
let total = 0;
/** What each path holds once installed: a later depot that ships a path replaces the earlier's. */
/** @type {Map<string, number>} */
const onDisk = new Map();
let skipped = 0;
const started = Date.now();
const progress = setInterval(()=>{
    const seconds = (Date.now() - started) / 1000;
    console.log(`  ${(done / 2 ** 20).toFixed(0)} of ${(total / 2 ** 20).toFixed(0)} MiB`
        + ` (${(done / 2 ** 20 / seconds).toFixed(1)} MiB/s), ${(skipped / 2 ** 20).toFixed(0)} MiB kept`);
}, 10_000);

/**
 * Runs the tasks `jobs` at a time.
 *
 * @param {Array<() => Promise<void>>} tasks
 */
async function pool(tasks){
    let next = 0;
    await Promise.all(Array.from({ length: jobs }, async()=>{
        while (next < tasks.length)
        {
            await tasks[next++]();
        }
    }));
}

/**
 * A chunk from the first server that gives it, the others in turn.
 *
 * @param {number} depot @param {import('../modules/core/src/steam/depot.js').ManifestChunk} piece
 * @param {Uint8Array} key @param {number} first
 */
async function fetchChunk(depot, piece, key, first){
    /** @type {unknown} */
    let last;
    for (let attempt = 0; attempt < servers.length * 2; attempt++)
    {
        try
        {
            const server = servers[(first + attempt) % servers.length];
            return await downloadChunk(server, depot, piece, key);
        }
        catch (e){
            last = e;
        }
    }
    throw last;
}

// Every key and manifest first: a manager drops the connection during a long
// download, and the chunks need none.
const planned = [];
for (const depot of chosen)
{
    const key = await depotKey(connection, app, depot.id);
    const code = await manifestRequestCode(connection, app, depot.id, depot.gid, branch);
    const files = await manifest(servers[0], { depot: depot.id, gid: depot.gid, code, key });
    console.log(`depot ${depot.id}: ${files.files.length} files,`
        + ` ${(files.size / 2 ** 20).toFixed(0)} MiB`);
    planned.push({ depot, key, files });
}
connection.close();

for (const { depot, key, files } of planned)
{
    /** @type {Array<() => Promise<void>>} */
    const tasks = [];
    for (const file of files.files)
    {
        const path = join(out, ...file.name.split('\\'));
        if (file.flags & FILE_FLAG_DIRECTORY)
        {
            await mkdir(path, { recursive: true });
            continue;
        }
        await mkdir(dirname(path), { recursive: true });
        if (file.link)
        {
            await symlink(file.link, path).catch(()=>{});
            continue;
        }
        total += file.size;
        onDisk.set(path.toLowerCase(), file.size);
        if (existsSync(path) && statSync(path).size === file.size
            && Buffer.compare(/** @type {Buffer} */ (await sha1(path)), Buffer.from(file.sha)) === 0)
        {
            skipped += file.size;
            done += file.size;
            continue;
        }
        const handle = await open(path, 'w');
        await handle.truncate(file.size);
        let left = file.chunks.length;
        if (left === 0)
        {
            await handle.close();
        }
        file.chunks.forEach((piece, index)=>tasks.push(async()=>{
            const bytes = await fetchChunk(depot.id, piece, key, index);
            await handle.write(bytes, 0, bytes.length, piece.offset);
            done += bytes.length;
            if (--left === 0)
            {
                await handle.close();
            }
        }));
    }
    await pool(tasks);
}

clearInterval(progress);
const disk = [...onDisk.values()].reduce((sum, size)=>sum + size, 0);
console.log(`installed into ${out}: ${(disk / 2 ** 20).toFixed(0)} MiB on disk`
    + ` (${(total / 2 ** 20).toFixed(0)} MiB in the depots),`
    + ` ${((Date.now() - started) / 1000).toFixed(0)} s`);
process.exit(0);
