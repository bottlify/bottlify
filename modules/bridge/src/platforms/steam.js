/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Steam, as the bridge answers a page for it (protocol.js, its `steam.` ops),
 * run in the content script's isolated world: the page's code shares the DOM
 * with it but none of its variables, so the connection to Steam and the
 * session's refresh token stay here, and the page is given only what each op
 * answers.
 *
 * One connection, logged on with the kept session or anonymously, is held for
 * the page's life and made again when it closes. A sign-in uses connections of
 * its own: the logon it ends in is the next op's.
 */

/** @typedef {{ accountName: string, refreshToken: string }} Session */

/**
 * The content servers' domains the steam ruleset lets a page read
 * (rules/steam.json, rule 2): a server elsewhere would be refused by CORS.
 */
export const CDN_DOMAINS = Object.freeze(['steamcontent.com', 'steampipe.akamaized.net']);

/** @param {string} host */
const reachable = host=>CDN_DOMAINS.some(domain=>host === domain || host.endsWith(`.${domain}`));

/** How long an account's games, and what Steam tells anyone of an app, are taken as read. */
const LIBRARY_KEPT_MS = 10 * 60_000;

/** Apps asked of Steam in one request: an account's whole library is hundreds. */
const PRODUCT_INFO_BATCH = 500;

/**
 * @typedef {Object} Held
 * @property {any} connection
 * @property {bigint} steamId
 * @property {Session | null} session  Null for an anonymous logon.
 * @property {Array<Record<string, any>>} licenses
 */

/**
 * @param {Object} options
 * @param {Record<string, any>} options.steam  `@bottlify/core/steam`.
 * @param {{ get(): Promise<Session | null>, set(session: Session | null): Promise<void> }}
 *     options.store  Where the session is kept: the extension's own storage.
 * @param {() => Promise<string[]>} options.managers  Connection managers'
 *     host:port, the best first.
 */
export function steamPlatform({ steam, store, managers }){
    /** @type {Promise<Held> | null} */
    let held = null;
    /** @type {{ at: number, apps: number[] } | null} */
    let library = null;
    /**
     * An anonymous logon of its own, for what Steam tells anyone while an
     * account is signed in: an account's logon is answered most apps' product
     * info as a hash and a size with no data, as a client that has it already.
     *
     * @type {Promise<Held> | null}
     */
    let anonymous = null;
    /** What Steam told anyone of each app, by app id. @type {Map<number, { at: number, info: any }>} */
    const apps = new Map();

    async function connect(){
        let failure = 'none is listed';
        for (const endpoint of (await managers()).slice(0, 8))
        {
            try
            {
                return await steam.connectCm({ endpoint });
            }
            catch (e){
                failure = String(/** @type {Error} */ (e)?.message ?? e);
            }
        }
        throw new Error(`steam: no connection manager answered (${failure})`);
    }

    /** @param {Session | null} session @returns {Promise<Held>} */
    async function logOn(session){
        const connection = await connect();
        try
        {
            if (!session)
            {
                const { steamId } = await steam.logOnAnonymously(connection);
                return { connection, steamId, session: null, licenses: [] };
            }
            const { steamId, licenses } = await steam.logOn(connection, session);
            return { connection, steamId, session, licenses };
        }
        catch (e){
            connection.close();
            throw e;
        }
    }

    /**
     * The logged-on connection, made again when it closed or the kept session
     * is no longer the one it logged on with -- another page of this browser
     * signed in or out. Each caller is chained after the last, so two ops at
     * once share one logon.
     *
     * @returns {Promise<Held>}
     */
    function loggedOn(){
        const last = held ?? Promise.resolve(null);
        held = last.catch(()=>null).then(async now=>{
            const session = await store.get();
            if (now && !now.connection.closed
                && now.session?.refreshToken === session?.refreshToken)
            {
                return now;
            }
            now?.connection.close();
            library = null;
            return logOn(session);
        });
        return held;
    }

    /** The session changed: what was logged on with the old one goes. */
    function drop(){
        held?.then(now=>now.connection.close(), ()=>{});
        held = null;
        library = null;
    }

    /** @type {import('../bridge.js').PlatformOps} */
    const ops = {
        signIn: async(_args, emit, signal)=>{
            /** @type {any} */
            let connection = null;
            // A manager drops a connection that has not logged on after a
            // minute or so; the sign-in, which Steam keeps, goes on over the next.
            const next = async()=>{
                if (!connection || connection.closed)
                {
                    connection = await connect();
                }
                return connection;
            };
            signal.addEventListener('abort', ()=>connection?.close(), { once: true });
            try
            {
                const { accountName, refreshToken } = await steam.signInWithQr(next, {
                    deviceName: 'Bottlify',
                    signal,
                    onChallenge: (/** @type {string} */ url)=>emit('challenge', { url }),
                    onScanned: ()=>emit('scanned', {}),
                });
                await store.set({ accountName, refreshToken });
                drop();
                return { accountName };
            }
            finally
            {
                connection?.close();
            }
        },

        signOut: async()=>{
            await store.set(null);
            drop();
            return {};
        },

        // Nobody signed in is an answer, not a failure, and needs no logon to give.
        // Fresh: the licences as Steam has them now, over a new logon -- one
        // added since is among them.
        account: async({ fresh })=>{
            if (!await store.get())
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
            if (!library || Date.now() - library.at > LIBRARY_KEPT_MS)
            {
                // Every app the licences grant: which are games the page asks
                // of what Steam tells anyone, which this session's product
                // info would mostly leave out (core's ownedApps).
                library = { at: Date.now(),
                    apps: await steam.ownedApps(now.connection, now.licenses) };
            }
            return { steamId: String(now.steamId), accountName: now.session.accountName,
                apps: library.apps, licenses: now.licenses.length };
        },

        depotKey: async({ app, depot })=>steam.depotKey((await loggedOn()).connection, app, depot),

        // The signed-in account's ownership ticket for an app, as Steam signs
        // it; null signed out (no account owns anything) or for an app the
        // account does not own. The session stays here; only the ticket goes.
        appOwnershipTicket: async({ app })=>{
            const now = await loggedOn();
            return now.session ? steam.appOwnershipTicket(now.connection, app) : null;
        },

        manifestCode: async({ app, depot, gid, branch })=>String(await steam.manifestRequestCode(
            (await loggedOn()).connection, app, depot, BigInt(gid), branch)),

        contentServers: async()=>(await steam.contentServers((await loggedOn()).connection))
            .filter((/** @type {{ vhost: string }} */ server)=>reachable(server.vhost)),

        productInfo: async({ apps: wanted })=>{
            const ids = [...new Set(/** @type {number[]} */ (wanted))];
            const stale = ids.filter(id=>!(Date.now() - (apps.get(id)?.at ?? 0) < LIBRARY_KEPT_MS));
            if (stale.length > 0)
            {
                const connection = await anonymousConnection();
                for (let at = 0; at < stale.length; at += PRODUCT_INFO_BATCH)
                {
                    const batch = stale.slice(at, at + PRODUCT_INFO_BATCH);
                    const answer = await steam.productInfo(connection, { apps: batch });
                    for (const id of batch)
                    {
                        const info = answer.apps.get(id);
                        apps.set(id,
                            { at: Date.now(), info: info ? steam.publicAppInfo(info) : null });
                    }
                }
            }
            return Object.fromEntries(ids.flatMap(id=>(apps.get(id)?.info
                ? [[id, apps.get(id)?.info]] : [])));
        },
    };

    /**
     * A connection logged on anonymously: the one held when nobody is signed
     * in, or one of its own beside an account's.
     */
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

    return ops;
}
