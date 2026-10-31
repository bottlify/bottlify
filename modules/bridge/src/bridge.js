/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The bridge's answers to a page (protocol.js), run in the content script's
 * isolated world: the page's code shares the DOM with it but none of its
 * variables, so the connection to Steam and the session's refresh token stay
 * here, and the page is given only what each op answers.
 *
 * One connection, logged on with the kept session or anonymously, is held for
 * the page's life and made again when it closes. A sign-in uses connections of
 * its own: the logon it ends in is the next op's.
 */

/** @typedef {import('./protocol.js').Request} Request */
/** @typedef {{ accountName: string, refreshToken: string }} Session */

/**
 * The content servers' domains the steam ruleset lets a page read
 * (rules/steam.json, rule 2): a server elsewhere would be refused by CORS.
 */
export const CDN_DOMAINS = Object.freeze(['steamcontent.com', 'steampipe.akamaized.net']);

/** @param {string} host */
const reachable = host=>CDN_DOMAINS.some(domain=>host === domain || host.endsWith(`.${domain}`));

/** How long an account's games are taken as read. */
const LIBRARY_KEPT_MS = 10 * 60_000;

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
 * @param {string} options.version
 * @param {Record<string, boolean>} options.platforms  What the site has switched on.
 */
export function createBridge({ steam, store, managers, version, platforms }){
    /** @type {Promise<Held> | null} */
    let held = null;
    /** @type {{ at: number, apps: number[] } | null} */
    let library = null;
    /** Sign-ins going on, by the id they were asked with. @type {Map<number, AbortController>} */
    const signIns = new Map();

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

    /** @typedef {(event: string, data: object) => void} Emit */
    /** @type {Record<string, (args: Record<string, any>, emit: Emit, id: number) => Promise<any>>} */
    const ops = {
        hello: async()=>({ version, platforms: { ...platforms } }),

        signIn: async(_args, emit, id)=>{
            const stop = new AbortController();
            signIns.set(id, stop);
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
            stop.signal.addEventListener('abort', ()=>connection?.close(), { once: true });
            try
            {
                const { accountName, refreshToken } = await steam.signInWithQr(next, {
                    deviceName: 'Bottlify',
                    signal: stop.signal,
                    onChallenge: (/** @type {string} */ url)=>emit('challenge', { url }),
                    onScanned: ()=>emit('scanned', {}),
                });
                await store.set({ accountName, refreshToken });
                drop();
                return { accountName };
            }
            finally
            {
                signIns.delete(id);
                connection?.close();
            }
        },

        cancel: async({ target })=>{
            signIns.get(target)?.abort(new Error('the sign-in was cancelled'));
            return {};
        },

        signOut: async()=>{
            await store.set(null);
            drop();
            return {};
        },

        // Nobody signed in is an answer, not a failure, and needs no logon to give.
        account: async()=>{
            if (!await store.get())
            {
                return null;
            }
            const now = await loggedOn();
            if (!now.session)
            {
                return null;
            }
            if (!library || Date.now() - library.at > LIBRARY_KEPT_MS)
            {
                const games = await steam.library(now.connection, now.licenses);
                library = { at: Date.now(),
                    apps: games.map((/** @type {any} */ game)=>game.appid)
                        .sort((/** @type {number} */ a, /** @type {number} */ b)=>a - b) };
            }
            return { steamId: String(now.steamId), accountName: now.session.accountName,
                apps: library.apps };
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
    };

    return {
        /**
         * Answers a request; `emit` sends an op's events before its answer.
         *
         * @param {Request} request
         * @param {(event: string, data: object) => void} emit
         */
        async handle({ id, op, args }, emit){
            // Switched off, Steam is not spoken to at all: the site's
            // configuration is how a platform's request to stop is honoured
            // (roadmap/decisions.md).
            if (op !== 'hello' && !platforms.steam)
            {
                throw new Error('Steam is switched off for this site');
            }
            return ops[op](args, emit, id);
        },
    };
}
