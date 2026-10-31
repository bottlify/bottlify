/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Steam, as GameHub's service worker answers a page for it (hub.js): the
 * account and its session, and every message to Steam, built and read here.
 * The CM socket is opened by the page's content script and carries frames as
 * they are (relay.js, pipe.js); the session's refresh token is read only here
 * and leaves only inside a logon.
 *
 * One connection, logged on with the kept session or anonymously, is held
 * while the page is open, and made again when it closes. A sign-in uses
 * connections of its own: the logon it ends in is the next op's. What Steam
 * tells anyone of an app is asked over an anonymous logon: an account's is
 * answered most apps' product info as a hash and a size with no data.
 */

import * as connection from './connection.js';
import * as auth from './auth.js';
import * as session from './session.js';
import * as keys from './keys.js';
import * as client from './client.js';
import {
    depotOwners, describeApp, publicAppInfo, sharedDepots, steamArt, storeGame,
} from './apps.js';

/** @typedef {{ accountName: string, refreshToken: string }} Session */
/** @typedef {import('../../hub.js').Store} Store */

/**
 * The content servers' domains the steam ruleset lets a page read
 * (rules/steam.json, rule 2): a server elsewhere would be refused by CORS.
 */
export const CDN_DOMAINS = Object.freeze(['steamcontent.com', 'steampipe.akamaized.net']);

/** @param {string} host */
const reachable = host=>CDN_DOMAINS.some(domain=>host === domain || host.endsWith(`.${domain}`));

/** How long an account's games, and what Steam tells anyone of an app, are taken as read. */
const KEPT_MS = 10 * 60_000;

/** Apps asked of Steam in one request: an account's whole library is hundreds. */
const PRODUCT_INFO_BATCH = 500;

/** Steam's own protocol, as the store speaks it; a test answers for Steam. */
export const STEAM = Object.freeze({
    ...connection, ...auth, ...session, ...keys, fetchClientFiles: client.fetchClientFiles,
});

/**
 * Steam's connection managers, port 443 first: the one a firewall least often
 * closes. Asked from the worker, which the directory answers.
 *
 * @returns {Promise<string[]>}
 */
export async function steamManagers(){
    const directory = await (await fetch('https://api.steampowered.com/ISteamDirectory/'
        + 'GetCMListForConnect/v1/?cellid=0&cmtype=websockets')).json();
    /** @type {string[]} */
    const list = directory.response.serverlist.map((/** @type {any} */ server)=>server.endpoint);
    return list.sort((a, b)=>Number(!a.endsWith(':443')) - Number(!b.endsWith(':443')));
}

/**
 * @typedef {Object} Held
 * @property {any} connection
 * @property {bigint} steamId
 * @property {Session | null} session  Null for an anonymous logon.
 * @property {Array<Record<string, any>>} licenses
 */

/**
 * Valve's client files, kept in the extension's cache: the package's name
 * carries its hash, so a kept one is the one the manifest names.
 *
 * @param {string | URL | Request} url
 */
async function cachedFetch(url){
    if (!String(url).endsWith('.zip') || typeof caches === 'undefined')
    {
        return fetch(url);
    }
    const cache = await caches.open('steam-client');
    const kept = await cache.match(url);
    if (kept)
    {
        return kept;
    }
    const fresh = await fetch(url);
    if (fresh.ok)
    {
        await cache.put(url, fresh.clone());
    }
    return fresh;
}

/**
 * @param {Object} options
 * @param {{ get(): Promise<Session | null>, set(session: Session | null): Promise<void> }}
 *     options.vault  Where the session is kept: the worker's own storage.
 * @param {(url: string) => import('./connection.js').CmSocket} options.socket  A socket the
 *     page opens.
 * @param {() => Promise<string[]>} [options.managers]
 * @param {Record<string, any>} [options.steam]  Steam's protocol (`STEAM`).
 * @param {typeof fetch} [options.fetch]  For Valve's client files.
 * @returns {Store}
 */
export function steamStore({ vault, socket, managers = steamManagers, steam = STEAM,
    fetch: get = cachedFetch })
{
    /** @type {Promise<Held> | null} */
    let held = null;
    /** @type {Promise<Held> | null} */
    let anonymous = null;
    /** @type {{ at: number, apps: number[] } | null} */
    let library = null;
    /** What Steam told anyone of each app, by app id. @type {Map<number, { at: number, info: any }>} */
    const apps = new Map();

    async function connect(){
        let failure = 'none is listed';
        for (const endpoint of (await managers()).slice(0, 8))
        {
            try
            {
                return await steam.connectCm({ endpoint, socket });
            }
            catch (e){
                failure = String(/** @type {Error} */ (e)?.message ?? e);
            }
        }
        throw new Error(`steam: no connection manager answered (${failure})`);
    }

    /** @param {Session | null} kept @returns {Promise<Held>} */
    async function logOn(kept){
        const link = await connect();
        try
        {
            if (!kept)
            {
                const { steamId } = await steam.logOnAnonymously(link);
                return { connection: link, steamId, session: null, licenses: [] };
            }
            const { steamId, licenses } = await steam.logOn(link, kept);
            return { connection: link, steamId, session: kept, licenses };
        }
        catch (e){
            link.close();
            throw e;
        }
    }

    /**
     * The logged-on connection, made again when it closed or the kept session
     * is no longer the one it logged on with -- another page signed in or out.
     * Each caller is chained after the last, so two ops at once share one logon.
     *
     * @returns {Promise<Held>}
     */
    function loggedOn(){
        const last = held ?? Promise.resolve(null);
        held = last.catch(()=>null).then(async now=>{
            const kept = await vault.get();
            if (now && !now.connection.closed
                && now.session?.refreshToken === kept?.refreshToken)
            {
                return now;
            }
            now?.connection.close();
            library = null;
            return logOn(kept);
        });
        return held;
    }

    /** The session changed: what was logged on with the old one goes. */
    function drop(){
        held?.then(now=>now.connection.close(), ()=>{});
        held = null;
        library = null;
    }

    /** An anonymous logon: the held one when nobody is signed in, or one of its own. */
    async function anonymousConnection(){
        const now = await loggedOn();
        if (!now.session)
        {
            return now.connection;
        }
        const last = anonymous ?? Promise.resolve(null);
        anonymous = last.catch(()=>null).then(kept=>(kept && !kept.connection.closed
            ? kept : logOn(null)));
        return (await anonymous).connection;
    }

    /**
     * The signed-in account: its Steam ID, name, every app its licences grant.
     *
     * @param {boolean} [fresh]  The licences as Steam has them now, over a new logon.
     */
    async function account(fresh = false){
        if (!await vault.get())
        {
            return null;
        }
        if (fresh)
        {
            drop();
        }
        const now = await loggedOn();
        if (!now.session)
        {
            return null;
        }
        if (!library || Date.now() - library.at > KEPT_MS)
        {
            library = { at: Date.now(), apps: await steam.ownedApps(now.connection, now.licenses) };
        }
        return { steamId: String(now.steamId), accountName: now.session.accountName,
            apps: library.apps, licenses: now.licenses.length };
    }

    /**
     * What Steam tells anyone of apps, by app id; an app it does not describe left out.
     *
     * @param {number[]} wanted
     * @returns {Promise<Map<number, any>>}
     */
    async function productInfo(wanted){
        const ids = [...new Set(wanted)];
        const stale = ids.filter(id=>!(Date.now() - (apps.get(id)?.at ?? 0) < KEPT_MS));
        if (stale.length > 0)
        {
            const link = await anonymousConnection();
            for (let at = 0; at < stale.length; at += PRODUCT_INFO_BATCH)
            {
                const batch = stale.slice(at, at + PRODUCT_INFO_BATCH);
                const answer = await steam.productInfo(link, { apps: batch });
                for (const id of batch)
                {
                    const info = answer.apps.get(id);
                    apps.set(id, { at: Date.now(), info: info ? publicAppInfo(info) : null });
                }
            }
        }
        return new Map(ids.flatMap(id=>(apps.get(id)?.info ? [[id, apps.get(id)?.info]] : [])));
    }

    /** @param {string} game */
    const appOf = game=>{
        const id = Number(game);
        if (!Number.isInteger(id) || id <= 0 || id > 0xFFFFFFFF)
        {
            throw new Error(`steam: ${game} is not an app id`);
        }
        return id;
    };

    return {
        name: 'Steam',

        ops: {
            // Nobody signed in is an answer, not a failure, and needs no logon to give.
            account: async({ fresh })=>{
                const now = await account(fresh);
                return now ? { name: now.accountName } : null;
            },

            signIn: async(_args, emit, signal)=>{
                /** @type {any} */
                let link = null;
                // A manager drops a connection that has not logged on after a
                // minute or so; the sign-in, which Steam keeps, goes on over the next.
                const next = async()=>{
                    if (!link || link.closed)
                    {
                        link = await connect();
                    }
                    return link;
                };
                signal.addEventListener('abort', ()=>link?.close(), { once: true });
                try
                {
                    const { accountName, refreshToken } = await steam.signInWithQr(next, {
                        deviceName: 'Bottlify',
                        signal,
                        onChallenge: (/** @type {string} */ url)=>emit('challenge', { url }),
                        onScanned: ()=>emit('scanned', {}),
                    });
                    await vault.set({ accountName, refreshToken });
                    drop();
                    return { name: accountName };
                }
                finally
                {
                    link?.close();
                }
            },

            signOut: async()=>{
                await vault.set(null);
                drop();
                return {};
            },

            // The account's games: every app its licences grant, of which the games.
            list: async({ fresh })=>{
                const now = await account(fresh);
                if (!now?.apps.length)
                {
                    return [];
                }
                const infos = await productInfo(now.apps);
                return now.apps.flatMap(id=>{
                    const game = storeGame(id, infos.get(id));
                    const { header, cover, hero } = steamArt(id);
                    return game ? [{ ...game, covers: { header, capsule: cover, hero } }] : [];
                }).sort((a, b)=>a.name.localeCompare(b.name));
            },

            cover: async({ game, kind })=>steamArt(appOf(game))[
                /** @type {'header' | 'cover' | 'hero'} */ (kind === 'capsule' ? 'cover' : kind)],

            // What the page's install needs: the app's depots and the
            // redistributables' depots of the apps it names, each with its key
            // and a request code asked under the app that owns it, and the
            // content servers the ruleset opens to the page.
            download: async({ game })=>{
                const appId = appOf(game);
                const info = (await productInfo([appId])).get(appId);
                if (!info)
                {
                    throw new Error(`Steam does not describe app ${appId}`);
                }
                const owners = await productInfo(depotOwners(info));
                const described = describeApp(info);
                const wanted = [
                    ...described.depots.map(({ id, gid })=>
                        ({ depot: id, gid, app: appId, shared: false })),
                    ...sharedDepots(info, owners).map(({ id, gid, app })=>
                        ({ depot: id, gid: String(gid), app, shared: true })),
                ];
                const { connection: link } = await loggedOn();
                const depots = await Promise.all(wanted.map(async({ depot, gid, app, shared })=>({
                    depot, gid, shared,
                    key: await steam.depotKey(link, app, depot),
                    code: String(await steam.manifestRequestCode(link, app, depot, BigInt(gid))),
                })));
                const servers = (await steam.contentServers(link))
                    .filter((/** @type {{ vhost: string }} */ server)=>reachable(server.vhost));
                return { name: String(info.common?.name ?? appId), launch: described.launch,
                    ...described.installscript ? { installscript: described.installscript } : {},
                    art: steamArt(appId), servers, depots };
            },

            // Steam running for the signed-in account: its apps, the app's
            // ownership ticket as Steam signs it (none for an app it does not
            // own), and Valve's own client DLLs, which a DRM wrapper reads to
            // check the client it loaded. Nobody signed in: nothing.
            runData: async({ game })=>{
                const appId = appOf(game);
                const now = await account();
                if (!now)
                {
                    return {};
                }
                const [ticket, files] = await Promise.all([
                    steam.appOwnershipTicket((await loggedOn()).connection, appId).catch(()=>null),
                    steam.fetchClientFiles({ fetch: get }).catch(()=>null),
                ]);
                return { win32: { steam: { ...now, appId,
                    ...ticket ? { ownershipTickets: { [appId]: ticket } } : {},
                    ...files ? { clientFiles: files.files } : {} } } };
            },
        },

        close(){
            drop();
            anonymous?.then(kept=>kept.connection.close(), ()=>{});
            anonymous = null;
        },
    };
}
