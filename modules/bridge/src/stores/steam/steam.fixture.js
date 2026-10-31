/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A Steam that answers from memory at the protocol's level -- logons, product
 * info, keys, codes, tickets, client files -- for the store's tests, and the
 * account token it takes.
 */

export const TOKEN = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiI3NjU2MTE5Nzk2MDI2NTcyOSJ9.secret-signature';

/** What Steam tells anyone of an app. @param {number} app */
const appInfo = app=>({
    common: { type: app === 228980 ? 'Config' : 'Game', name: `App ${app}`, icon: 'x' },
    config: app === 70 ? { launch: { 0: { executable: 'bin/game.exe', arguments: '-w' } } } : {},
    extended: app === 70 ? { installscript: 'install.vdf' } : {},
    depots: app === 228980 ? { 228990: { manifests: { public: { gid: '2222', size: '9' } } } }
        : { 1: { manifests: { public: { gid: '5', size: '1000' }, beta: { gid: '6' } } },
            228990: { depotfromapp: '228980' } },
    ufs: { quota: 1 },
});

/** A Steam that answers from memory, and what was asked of it. */
export function fakeSteam(){
    const asked = /** @type {string[]} */ ([]);
    const connection = ()=>({ closed: false, anonymous: false, close(){
        this.closed = true;
    } });
    return {
        asked,
        connectCm: async()=>connection(),
        logOnAnonymously: async(/** @type {any} */ link)=>{
            link.anonymous = true;
            asked.push('anonymous');
            return { steamId: 90071992547409920n };
        },
        logOn: async(/** @type {any} */ _c, /** @type {any} */ session)=>{
            asked.push(`logOn ${session.accountName} ${session.refreshToken === TOKEN}`);
            return { steamId: 76561197960265729n, licenses: [{ package_id: 1 }] };
        },
        ownedApps: async()=>[70, 400, 999],
        depotKey: async(/** @type {any} */ _c, /** @type {number} */ app, /** @type {number} */ depot)=>{
            asked.push(`key ${app} ${depot}`);
            return new Uint8Array(32).fill(depot & 0xff);
        },
        appOwnershipTicket: async(/** @type {any} */ _c, /** @type {number} */ app)=>{
            asked.push(`ticket ${app}`);
            return app === 400 ? Uint8Array.of(4, 0, 0, 0) : null;
        },
        manifestRequestCode: async(/** @type {any} */ _c, /** @type {number} */ _app,
            /** @type {number} */ _depot, /** @type {bigint} */ gid)=>gid + 1n,
        /** What Steam tells each logon of apps: an account's, a hash and no data. */
        productInfo: async(/** @type {any} */ link, /** @type {{ apps: number[] }} */ { apps })=>{
            asked.push(`info ${link.anonymous ? 'anonymous' : 'account'} ${apps.join(',')}`);
            return { apps: new Map(apps.filter(app=>app !== 999 && link.anonymous)
                .map(app=>[app, appInfo(app)])) };
        },
        contentServers: async()=>[
            { host: 'a:443', vhost: 'cache1-fra1.steamcontent.com', type: 'CDN' },
            { host: 'b', vhost: 'steampipe.akamaized.net', type: 'CDN' },
            { host: 'c', vhost: 'lancache.example.org', type: 'SteamCache' },
        ],
        fetchClientFiles: async()=>({ version: '1',
            files: { 'steamclient.dll': Uint8Array.of(77, 90) } }),
    };
}
