/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What an app's product info says an install of it takes: its depots for
 * Windows and a language, the redistributables' depots of other apps it
 * names, how it starts -- read the same by the engine's tools, a page and the
 * Bottlify bridge, which answers a page the part of the info these read
 * (`publicAppInfo`).
 */

/**
 * Steam's own art for its apps, on its CDN: `${STEAM_ART}/<appid>/<file>`. A
 * cross-origin isolated page may show it only with the headers the Bottlify
 * bridge adds to its responses.
 */
export const STEAM_ART = 'https://shared.steamstatic.com/store_item_assets/steam/apps';

/**
 * An app's art as a library and a bottle's manifest name it: the store's wide
 * header, the library's tall cover and its wide background.
 *
 * @param {number} appId
 */
export const steamArt = appId=>({
    header: `${STEAM_ART}/${appId}/header.jpg`,
    cover: `${STEAM_ART}/${appId}/library_600x900.jpg`,
    hero: `${STEAM_ART}/${appId}/library_hero.jpg`,
});

/**
 * Whether a depot is one an install of the app takes: Windows' (or every
 * system's), the language's or every language's, and not a DLC's.
 *
 * @param {any} depot  Its entry in the app's `depots`.
 * @param {string} language  Steam's name of it: `english`, `german`, ...
 */
export function wantedDepot(depot, language){
    const os = String(depot?.config?.oslist ?? '');
    const lang = String(depot?.config?.language ?? '');
    return (!os || os.split(',').includes('windows')) && (!lang || lang === language)
        && !depot?.dlcappid;
}

/**
 * The depots of other apps an app declares it needs, at those apps' public
 * manifests: `{ id, app, gid }`, `app` the app that owns the depot -- whose
 * id a depot's key and manifest code are asked under.
 *
 * @param {any} info  The app's product info.
 * @param {Map<number, any>} owners  The owning apps' product info, by app id.
 * @param {string} [language]
 * @returns {{ id: number, app: number, gid: bigint }[]}
 */
export function sharedDepots(info, owners, language = 'english'){
    /** @type {{ id: number, app: number, gid: bigint }[]} */
    const found = [];
    for (const [id, depot] of Object.entries(info?.depots ?? {}))
    {
        const app = Number(/** @type {any} */ (depot)?.depotfromapp);
        if (!/^\d+$/.test(id) || !app || !wantedDepot(depot, language))
        {
            continue;
        }
        const gid = owners.get(app)?.depots?.[id]?.manifests?.public?.gid;
        if (gid)
        {
            found.push({ id: Number(id), app, gid: BigInt(gid) });
        }
    }
    return found;
}

/** The apps that own an app's shared depots. @param {any} info @returns {number[]} */
export function depotOwners(info){
    return [...new Set(Object.values(info?.depots ?? {})
        .map(depot=>Number(/** @type {any} */ (depot)?.depotfromapp)).filter(Boolean))];
}

/**
 * Steam's first launch option for Windows that names a program: how the app starts.
 *
 * @param {any} info  The app's product info.
 * @returns {{ executable: string, arguments?: string } | null}
 */
export function windowsLaunch(info){
    return /** @type {any} */ (Object.values(info?.config?.launch ?? {}).find(one=>one?.executable
        && (!one?.config?.oslist || String(one.config.oslist).split(',').includes('windows'))))
        ?? null;
}

/**
 * The part of an app's product info a library and an install read, which is
 * what the bridge hands a page: its type and name, its launch options, its
 * install script, and its depots with their public manifests -- a branch
 * other than public, and the rest of the info, stay where they are.
 *
 * @param {any} info
 * @returns {Record<string, any>}
 */
export function publicAppInfo(info){
    /** @type {Record<string, any>} */
    const depots = {};
    for (const [id, depot] of Object.entries(info?.depots ?? {}))
    {
        if (/^\d+$/.test(id))
        {
            const { config, depotfromapp, dlcappid, sharedinstall } = /** @type {any} */ (depot) ?? {};
            const kept = /** @type {any} */ (depot)?.manifests?.public;
            depots[id] = { ...config ? { config } : {}, ...depotfromapp ? { depotfromapp } : {},
                ...dlcappid ? { dlcappid } : {}, ...sharedinstall ? { sharedinstall } : {},
                ...kept ? { manifests: { public: kept } } : {} };
        }
    }
    const buildid = info?.depots?.branches?.public?.buildid;
    if (buildid !== undefined)
    {
        depots.branches = { public: { buildid } };
    }
    return {
        common: { type: info?.common?.type, name: info?.common?.name },
        config: { launch: info?.config?.launch ?? {} },
        ...info?.extended?.installscript
            ? { extended: { installscript: info.extended.installscript } } : {},
        depots,
    };
}
