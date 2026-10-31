/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Installs a Steam app the account owns into a directory, as the Steam
 * client lays it out: the depots for Windows and one language, each file
 * put together from its chunks -- and the redistributables the app declares,
 * as Steam installs them on a first start: the depots of other apps it names
 * (`depotfromapp`, Steamworks Common Redistributables' Visual C++ and
 * DirectX, which an anonymous logon downloads), put in the app's directory,
 * and its install scripts' registry values and the packages their programs
 * carry, put where the bottle mounts them. The install is
 * @bottlify/core/steam's (install.js, redist.js), which a page runs into a
 * bottle in the browser; this lands it in a directory.
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
 * writeDepotAccess writes them (`--keys -`: on stdin); the content servers come
 * from an anonymous logon. A request code lasts minutes: one that has expired
 * fails the run, and the run is asked for again.
 *
 * A run stopped part way is run again: a file already whole (its size and
 * SHA-1) is kept.
 */

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectCm, logOn, logOnAnonymously, productInfo } from '../modules/core/src/steam/index.js';
import { directoryTree } from './redist.mjs';
import {
    contentServers, depotKey, manifestRequestCode, readDepotAccess,
} from '../modules/core/src/steam/depot.js';
import {
    depotManifest, downloadFiles, installedFiles, windowsLaunch,
} from '../modules/core/src/steam/install.js';
import {
    depotOwners, installSteamRedistributables, sharedDepots, wantedDepot,
} from '../modules/core/src/steam/redist.js';

/** @typedef {import('../modules/core/src/steam/install.js').DepotOpening} DepotOpening */
/** @typedef {import('../modules/core/src/steam/depot.js').ContentServer} ContentServer */

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

/**
 * Asks Steam what to install and installs it: the tool as a command.
 *
 * @param {string[]} argv
 */
async function main(argv){
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
        const session = JSON.parse(
            readFileSync(sessionPath === '-' ? 0 : String(sessionPath), 'utf8'));
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
    // as well as the account's, so a run with keys is handed none for them.
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

    // Every key and manifest code first: a manager drops the connection during a
    // long download, and the chunks need none.
    /** @type {DepotOpening[]} */
    const depots = [];
    for (const depot of chosen)
    {
        const owner = depot.app ?? app;
        depots.push({ depot: depot.id, gid: depot.gid, shared: Boolean(depot.app),
            key: depot.key ?? await depotKey(connection, owner, depot.id),
            code: depot.code ?? await manifestRequestCode(connection, owner, depot.id, depot.gid,
                depot.app ? 'public' : branch) });
    }
    connection.close();

    const installed = await installToDirectory({ out, depots, servers, jobs, log: console.log,
        installscript: info?.extended?.installscript
            ? String(info.extended.installscript) : undefined,
        executable: windowsLaunch(info)?.executable });
    console.log(`installed into ${out}: ${installed.files} files,`
        + ` ${(installed.bytes / 2 ** 20).toFixed(0)} MiB, ${installed.seconds.toFixed(0)} s`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
{
    // A failure is one line, the last the run prints: the launcher shows it as
    // the install's message, where a stack trace would show its last frame.
    process.on('uncaughtException', e=>{
        console.error(`failed: ${e?.message ?? e}`);
        process.exit(1);
    });
    await main(process.argv.slice(2));
    process.exit(0);
}
