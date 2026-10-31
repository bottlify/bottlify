/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Installs a Steam app the account owns into a directory, as the Steam
 * client lays it out: the depots for Windows and one language, each file
 * put together from its chunks (@bottlify/core/steam's depot.js) -- and the
 * redistributables the app declares, as Steam installs them on a first start
 * (tools/redist.mjs): the depots of other apps it names (`depotfromapp`,
 * Steamworks Common Redistributables' Visual C++ and DirectX, which an
 * anonymous logon downloads), put in the app's directory, and its install
 * scripts' registry values and the packages their programs carry, put where
 * the bottle mounts them.
 *
 *   NODE_USE_ENV_PROXY=1 node tools/steam-install.mjs --session <file> --app <id> --out <dir>
 *       [--branch public] [--language english] [--depots 401,402] [--jobs 16]
 *   node tools/steam-install.mjs --keys <file> --app <id> --out <dir> [--jobs 16]
 *
 * --session is a signed-in session, { accountName, refreshToken }, as
 * tools/steam-signin.mjs --token writes it; `--session -` reads it from stdin,
 * which is how the launcher hands over a browser's session without writing
 * it to a file.
 *
 * --keys installs without the account: the depots to install, each with its
 * manifest's gid, its key and a manifest request code, as @bottlify/core/steam's
 * writeDepotAccess writes them (`--keys -`: on stdin). A browser whose session
 * the Bottlify bridge keeps asks the bridge for them; the content servers come
 * from an anonymous logon. A request code lasts minutes: one that has expired
 * fails the run, and the run is asked for again.
 *
 * A run stopped part way is run again: a file already whole (its size and
 * SHA-1) is kept.
 */

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, open, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { connectCm, logOn, logOnAnonymously, productInfo } from '../modules/core/src/steam/index.js';
import {
    depotOwners, imageMachine, installRedistributables, sharedDepots, wantedDepot,
} from './redist.mjs';
import {
    FILE_FLAG_DIRECTORY, contentServers, depotKey, downloadChunk, manifest, manifestRequestCode,
    readDepotAccess,
} from '../modules/core/src/steam/depot.js';

// A failure is one line, the last the run prints: the launcher shows it as the
// install's message, where a stack trace would show its last frame.
process.on('uncaughtException', e=>{
    console.error(`failed: ${e?.message ?? e}`);
    process.exit(1);
});

const argv = process.argv.slice(2);
/** @param {string} name */
const option = name=>{
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
};
const sessionPath = option('--session');
const keysPath = option('--keys');
const app = Number(option('--app'));
const out = option('--out');
const branch = option('--branch') ?? 'public';
const language = option('--language') ?? 'english';
const only = option('--depots')?.split(',').map(Number);
const jobs = Number(option('--jobs') ?? 16);
if (!sessionPath === !keysPath || !app || !out)
{
    throw new Error('usage: node tools/steam-install.mjs --session <file> | --keys <file>'
        + ' --app <id> --out <dir>');
}
/**
 * Read before Steam is asked anything: a list that is not one fails the run at
 * once -- with a message of its own, as JSON.parse's quotes the text, keys and all.
 */
const given = keysPath ? readDepotAccess((()=>{
    try
    {
        return JSON.parse(readFileSync(keysPath === '-' ? 0 : keysPath, 'utf8'));
    }
    catch {
        throw new Error('--keys is not JSON');
    }
})()) : null;

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
/**
 * The depots to download; `app` is the app that owns a shared one, whose id
 * its key and manifest code are asked under.
 *
 * @type {Array<{ id: number, gid: bigint, app?: number, key?: Uint8Array, code?: bigint }>}
 */
const chosen = [];
if (given)
{
    // The content servers and what Steam tells anyone of the app are all this
    // logon is for.
    await logOnAnonymously(connection);
    chosen.push(...given.map(({ depot, gid, key, code })=>({ id: depot, gid, key, code })));
}
else
{
    const session = JSON.parse(readFileSync(sessionPath === '-' ? 0 : String(sessionPath), 'utf8'));
    await logOn(connection, session);
    console.log(`logged on as ${session.accountName}`);
}
const info = /** @type {Record<string, any>} */ (
    (await productInfo(connection, { apps: [app] })).apps.get(app));
if (!given)
{
    for (const [id, depot] of Object.entries(info?.depots ?? {}))
    {
        const gid = depot?.manifests?.[branch]?.gid;
        if (/^\d+$/.test(id) && gid && (only ? only.includes(Number(id)) : wantedDepot(depot, language)))
        {
            chosen.push({ id: Number(id), gid: BigInt(gid) });
        }
    }
}
// The redistributables' depots, another app's: an anonymous logon opens them
// as well as the account's, so a bridged install is handed no key for them.
const owners = depotOwners(info);
const shared = owners.length === 0 ? []
    : sharedDepots(info, (await productInfo(connection, { apps: owners })).apps, language)
        .filter(depot=>!only || only.includes(depot.id));
chosen.push(...shared);
console.log(`${info?.common?.name ?? 'app'} (${app}), branch ${branch}:`
    + ` depots ${chosen.map(d=>(d.app ? `${d.id} (of ${d.app})` : d.id)).join(', ')}`);

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
    const owner = depot.app ?? app;
    const key = depot.key ?? await depotKey(connection, owner, depot.id);
    const code = depot.code ?? await manifestRequestCode(connection, owner, depot.id, depot.gid,
        depot.app ? 'public' : branch);
    const files = await manifest(servers[0], { depot: depot.id, gid: depot.gid, code, key })
        .catch(e=>{
            if (!depot.code)
            {
                throw e;
            }
            throw new Error(`depot ${depot.id}'s manifest was refused with the code given --`
                + ` it lasts minutes and may have expired; ask for the install again`
                + ` (${/** @type {Error} */ (e).message})`);
        });
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

// What Steam does on the first start: the app's install script, then each
// redistributable's, run against the bottle's machine -- its program's width;
// and the prerequisites the app carries itself (tools/redist.mjs).
/** @param {string} name  A path in the app, either separator. */
const inApp = name=>join(out, ...name.split(/[\\/]/));
const scripts = [
    ...info?.extended?.installscript ? [String(info.extended.installscript)] : [],
    ...planned.filter(({ depot })=>depot.app).flatMap(({ files })=>files.files
        .filter(file=>/(^|\\)installscript\.vdf$/i.test(file.name)).map(file=>file.name)),
].map(script=>script.replace(/\//g, '\\')).filter(script=>existsSync(inApp(script)));
const launch = Object.values(info?.config?.launch ?? {}).find(one=>one?.executable
    && (!one?.config?.oslist || String(one.config.oslist).split(',').includes('windows')));
const program = launch ? inApp(String(launch.executable)) : '';
const machine = program && existsSync(program)
    ? imageMachine(readFileSync(program).subarray(0, 4096)) : 'x86';
for (const line of await installRedistributables(out, scripts, machine))
{
    console.log(line);
}

const disk = [...onDisk.values()].reduce((sum, size)=>sum + size, 0);
console.log(`installed into ${out}: ${(disk / 2 ** 20).toFixed(0)} MiB on disk`
    + ` (${(total / 2 ** 20).toFixed(0)} MiB in the depots),`
    + ` ${((Date.now() - started) / 1000).toFixed(0)} s`);
process.exit(0);
