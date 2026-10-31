/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What opens a depot, asked of a connection manager for a logged-on account:
 * the depot's key, the code that unlocks a manifest for a while, and the
 * content servers -- what the page then downloads from (core's depot.js).
 */

import { decode } from '../../../../core/src/steam/protobuf.js';

/** @typedef {import('../../../../core/src/steam/protobuf.js').Schema} Schema */
/** @typedef {import('./connection.js').CmConnection} CmConnection */
/** @typedef {import('../../../../core/src/steam/depot.js').ContentServer} ContentServer */

const EMSG_GET_DEPOT_KEY = 5438;

/** @type {Schema} */
const GetDepotDecryptionKey = { depot_id: [1, 'uint32'], app_id: [2, 'uint32'] };
/** @type {Schema} */
const GetDepotDecryptionKeyResponse = {
    eresult: [1, 'int32'],
    depot_id: [2, 'uint32'],
    depot_encryption_key: [3, 'bytes'],
};
/** @type {Schema} */
const GetManifestRequestCode = {
    app_id: [1, 'uint32'],
    depot_id: [2, 'uint32'],
    manifest_id: [3, 'uint64'],
    app_branch: [4, 'string'],
};
/** @type {Schema} */
const GetManifestRequestCodeResponse = { manifest_request_code: [1, 'uint64'] };
/** @type {Schema} */
const GetServersForSteamPipe = { cell_id: [1, 'uint32'], max_servers: [2, 'uint32'] };
/** @type {Schema} */
const GetServersForSteamPipeResponse = {
    servers: [1, {
        type: [1, 'string'],
        cell_id: [3, 'int32'],
        load: [4, 'int32'],
        weighted_load: [5, 'float'],
        steam_china_only: [7, 'bool'],
        host: [8, 'string'],
        vhost: [9, 'string'],
        use_as_proxy: [10, 'bool'],
        https_support: [12, 'string'],
        allowed_app_ids: [13, 'uint32', 'repeated'],
    }, 'repeated'],
};

/**
 * The depot's AES-256 key, which the account's licence for the app grants.
 *
 * @param {CmConnection} connection @param {number} app @param {number} depot
 * @returns {Promise<Uint8Array>}
 */
export async function depotKey(connection, app, depot){
    const answer = await connection.request(EMSG_GET_DEPOT_KEY, GetDepotDecryptionKey,
        { depot_id: depot, app_id: app });
    const body = decode(GetDepotDecryptionKeyResponse, answer.body);
    if (body.eresult !== 1)
    {
        throw new Error(`steam: no key for depot ${depot} (EResult ${body.eresult})`);
    }
    return body.depot_encryption_key;
}

/**
 * The content servers the CM offers this client, the least loaded first:
 * those that serve every app, and over HTTPS.
 *
 * @param {CmConnection} connection @param {number} [cell]
 * @returns {Promise<ContentServer[]>}
 */
export async function contentServers(connection, cell = 0){
    const answer = await connection.call('ContentServerDirectory.GetServersForSteamPipe#1',
        GetServersForSteamPipe, { cell_id: cell, max_servers: 20 },
        GetServersForSteamPipeResponse, { authed: true });
    if (answer.eresult !== 1)
    {
        throw new Error(`steam: no content servers (EResult ${answer.eresult})`);
    }
    return answer.body.servers
        .filter((/** @type {any} */ s)=>!s.steam_china_only && !s.use_as_proxy
            && !(s.allowed_app_ids?.length) && s.https_support !== 'unavailable'
            && (s.type === 'SteamCache' || s.type === 'CDN'))
        .sort((/** @type {any} */ a, /** @type {any} */ b)=>(a.weighted_load ?? 0) - (b.weighted_load ?? 0))
        .map((/** @type {any} */ s)=>({ host: s.host, vhost: s.vhost || s.host, type: s.type }));
}

/**
 * The code that unlocks a manifest on the content servers for a while.
 *
 * @param {CmConnection} connection
 * @param {number} app @param {number} depot @param {bigint} gid @param {string} [branch]
 * @returns {Promise<bigint>}
 */
export async function manifestRequestCode(connection, app, depot, gid, branch = 'public'){
    const answer = await connection.call('ContentServerDirectory.GetManifestRequestCode#1',
        GetManifestRequestCode,
        { app_id: app, depot_id: depot, manifest_id: gid, app_branch: branch },
        GetManifestRequestCodeResponse, { authed: true });
    const code = answer.body.manifest_request_code;
    if (answer.eresult !== 1 || !code)
    {
        throw new Error(`steam: no request code for manifest ${gid} of depot ${depot}`
            + ` (EResult ${answer.eresult})`);
    }
    return code;
}

/**
 * @typedef {Object} DepotAccess  What opens one depot at one manifest without a
 *     logon: the depot's key and a request code for the manifest, both granted to
 *     an account that owns the app (depotKey, manifestRequestCode). The chunks
 *     ask for nothing more.
 * @property {number} depot @property {bigint} gid
 * @property {Uint8Array} key @property {bigint} code
 */

/** @param {unknown} value */
const isU64 = value=>typeof value === 'string' && /^[0-9]{1,20}$/.test(value)
    && BigInt(value) < 2n ** 64n;

/**
 * Depots' access as JSON carries it from the account's side to a process that
 * downloads: `[{ depot, gid, key, code }]`, the gid and the code decimal
 * strings, the key 64 hex digits.
 *
 * @param {DepotAccess[]} list
 * @returns {Array<{ depot: number, gid: string, key: string, code: string }>}
 */
export function writeDepotAccess(list){
    return list.map(({ depot, gid, key, code })=>({ depot, gid: String(gid), code: String(code),
        key: Array.from(key, byte=>byte.toString(16).padStart(2, '0')).join('') }));
}

/**
 * writeDepotAccess's JSON read back and checked, a depot at most once: it
 * comes from another process or the network. A refusal names the entry, never
 * a key or a code.
 *
 * @param {unknown} value
 * @returns {DepotAccess[]}
 */
export function readDepotAccess(value){
    if (!Array.isArray(value) || value.length === 0 || value.length > 1024)
    {
        throw new Error('steam: depot access is a list of { depot, gid, key, code }');
    }
    /** @type {Set<number>} */
    const seen = new Set();
    return value.map((entry, at)=>{
        const { depot, gid, key, code } = entry ?? {};
        if (!Number.isInteger(depot) || depot <= 0 || depot > 0xFFFFFFFF || seen.has(depot)
            || !isU64(gid) || !isU64(code) || code === '0'
            || typeof key !== 'string' || !/^[0-9a-fA-F]{64}$/.test(key))
        {
            throw new Error(`steam: depot access entry ${at} is not { depot, gid, key, code }`);
        }
        seen.add(depot);
        return { depot, gid: BigInt(gid), code: BigInt(code),
            key: Uint8Array.from(key.match(/../g) ?? [], pair=>parseInt(pair, 16)) };
    });
}
