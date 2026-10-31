/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Steam, as GameHub answers a page for it (hub.js), in the page's content
 * script (tab.js): every message to Steam built and read here, over a CM
 * socket the content script opens. The account's session is the service
 * worker's (`vault`), which signs in, and is asked what to log on with, which is
 * put into the logon and not kept here.
 *
 * One connection, logged on with the kept session or anonymously, is held
 * while the page is open, and made again when it closes. A sign-in uses
 * connections of its own: the logon it ends in is the next op's. What Steam
 * tells anyone of an app is asked over an anonymous logon: an account's is
 * answered most apps' product info as a hash and a size with no data.
 */

import * as connection from './connection.js';
import * as session from './session.js';
import * as keys from './keys.js';
import * as client from './client.js';
import {
    depotOwners, describeApp, publicAppInfo, sharedDepots, steamArt, storeGame,
} from './apps.js';

/** @typedef {{ accountName: string, refreshToken: string }} Session */
/**
 * The account as the worker tells it without its token: `id` is new with each
 * sign-in, so a logon made with another session is told from the one kept.
 *
 * @typedef {{ accountName: string, id?: string }} Account
 */
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
    ...connection, ...session, ...keys, fetchClientFiles: client.fetchClientFiles,
});

/**
 * Steam's connection managers, port 443 first: the one a firewall least often
 * closes. The directory answers the worker, not a page (GameHub's `fetch`).
 *
 * @param {typeof fetch} [get]
 * @returns {Promise<string[]>}
 */
export async function steamManagers(get = fetch){
    const directory = await (await get('https://api.steampowered.com/ISteamDirectory/'
        + 'GetCMListForConnect/v1/?cellid=0&cmtype=websockets')).json();
    /** @type {string[]} */
    const list = directory.response.serverlist.map((/** @type {any} */ server)=>server.endpoint);
    return list.sort((a, b)=>Number(!a.endsWith(':443')) - Number(!b.endsWith(':443')));
}

/**
 * @typedef {Object} Held
 * @property {any} connection
 * @property {bigint} steamId
 * @property {Account | null} session  Null for an anonymous logon.
 * @property {Array<Record<string, any>>} licenses
 */

/**
 * The session as the store asks it of the worker.
 *
 * @typedef {Object} Vault
 * @property {() => Promise<Account | null>} get  Who is signed in, without the token.
 * @property {() => Promise<(Session & Account) | null>} token  The session, for a logon.
 * @property {() => Promise<void>} signOut
 */

/**
 * @param {Object} options
 * @param {Vault} options.vault  The worker's.
 * @param {(url: string) => import('./connection.js').CmSocket} [options.socket]  A socket the
 *     page opens.
 * @param {typeof fetch} [options.fetch]  Steam's directory and Valve's client files: the
 *     worker's, which the ruleset does not open to a page.
 * @param {() => Promise<string[]>} [options.managers]
 * @param {Record<string, any>} [options.steam]  Steam's protocol (`STEAM`).
 * @returns {Store}
 */
export function steamStore({ vault, socket, fetch: get = fetch,
    managers = ()=>steamManagers(get), steam = STEAM })
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

    /** @param {boolean} anonymously @returns {Promise<Held>} */
    async function logOn(anonymously){
        const link = await connect();
        try
        {
            // Asked now and dropped with the logon: the token is the worker's.
            const kept = anonymously ? null : await vault.token();
            if (!kept)
            {
                const { steamId } = await steam.logOnAnonymously(link);
                return { connection: link, steamId, session: null, licenses: [] };
            }
            const { steamId, licenses } = await steam.logOn(link,
                { accountName: kept.accountName, refreshToken: kept.refreshToken });
            return { connection: link, steamId, licenses,
                session: { accountName: kept.accountName, id: kept.id } };
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
            if (now && !now.connection.closed && Boolean(now.session) === Boolean(kept)
                && now.session?.id === kept?.id)
            {
                return now;
            }
            now?.connection.close();
            library = null;
            return logOn(!kept);
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
            ? kept : logOn(true)));
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

            signOut: async()=>{
                await vault.signOut();
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
