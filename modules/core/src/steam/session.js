/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A signed-in session: the logon with a refresh token, the licences the
 * account holds, and what they grant -- the library.
 *
 * Right after a logon the CM sends the account's licence list. Each licence
 * is a package; a package's info (binary KeyValues, through PICS) names the
 * apps and depots it grants; an app's info (text KeyValues) gives its name,
 * its type, how it is launched and its depots. A game in the library is an
 * app of type game that some licence grants.
 */

import {
    ClientLicenseList, ClientLoggedOff, ClientLogon, ClientLogonResponse, EMsg, EResult,
    OS_WINDOWS_10, PICSAccessTokenRequest, PICSAccessTokenResponse, PICSProductInfoRequest,
    PICSProductInfoResponse, PROTOCOL_VERSION,
} from './messages.js';
import { decode } from './protobuf.js';
import { parseBinary, parseText } from './keyvalues.js';

/** @typedef {import('./connection.js').CmConnection} CmConnection */
/** @typedef {import('./keyvalues.js').KeyValues} KeyValues */

/**
 * The Steam ID a refresh token was issued to: the subject of the JWT.
 *
 * @param {string} token
 * @returns {bigint}
 */
export function steamIdOfToken(token){
    const part = token.split('.')[1];
    if (!part)
    {
        throw new Error('steam: the refresh token is not a JWT');
    }
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const json = new TextDecoder().decode(Uint8Array.from(atob(base64), c=>c.charCodeAt(0)));
    return BigInt(JSON.parse(json).sub);
}

/** What every logon says of this client. */
const CLIENT = {
    protocol_version: PROTOCOL_VERSION,
    cell_id: 0,
    client_package_version: 1771,
    client_language: 'english',
    client_os_type: OS_WINDOWS_10,
    // No private address to tell: zero, obfuscated as the protocol has it.
    obfuscated_private_ip: { v4: 0xBAADF00D },
};

/** An anonymous user in the public universe: the Steam ID an anonymous logon asks as. */
const ANONYMOUS_USER = 0x01A0000000000000n;

/**
 * Sends a logon and waits for it to be accepted; the session and the
 * heartbeat are the connection's from then on.
 *
 * @param {CmConnection} connection @param {bigint} steamId
 * @param {Record<string, any>} fields  What this logon says beyond `CLIENT`.
 */
async function logOnAs(connection, steamId, fields){
    const response = connection.next(EMsg.ClientLogOnResponse);
    const loggedOff = connection.next(EMsg.ClientLoggedOff);
    // Each is awaited only on the path that needs it. A logon refused, or a
    // token that is not one, leaves the rest to reject when the connection
    // closes -- unheard, that rejection ends a Node process.
    for (const waiting of [response, loggedOff])
    {
        waiting.catch(()=>{});
    }
    connection.setSession(steamId, 0);
    connection.send(EMsg.ClientLogon, ClientLogon, { ...CLIENT, ...fields });
    const answer = await Promise.race([response, loggedOff.then(message=>{
        const { eresult } = decode(ClientLoggedOff, message.body);
        throw new Error(`steam: logged off during the logon (EResult ${eresult})`);
    })]);
    const body = decode(ClientLogonResponse, answer.body);
    if (body.eresult !== EResult.OK)
    {
        throw new Error(`steam: the logon was refused (EResult ${body.eresult})`);
    }
    connection.setSession(answer.header.steamid, answer.header.client_sessionid);
    connection.startHeartbeat(body.heartbeat_seconds ?? 9);
    return { steamId: /** @type {bigint} */ (answer.header.steamid), body };
}

/**
 * Logs on with a refresh token; resolves with the licences once the CM has
 * sent them.
 *
 * @param {CmConnection} connection
 * @param {Object} options
 * @param {string} options.accountName
 * @param {string} options.refreshToken
 * @param {string} [options.machineName]
 * @returns {Promise<{ steamId: bigint, licenses: Array<Record<string, any>>, country?: string }>}
 */
export async function logOn(connection, { accountName, refreshToken, machineName = 'Bottlify' }){
    // The licence list follows the logon response at once: listened for first.
    const licensesMessage = connection.next(EMsg.ClientLicenseList);
    licensesMessage.catch(()=>{});
    const { steamId, body } = await logOnAs(connection, steamIdOfToken(refreshToken), {
        should_remember_password: true,
        account_name: accountName,
        machine_name: machineName,
        supports_rate_limit_response: true,
        access_token: refreshToken,
    });
    const list = decode(ClientLicenseList, (await licensesMessage).body);
    return { steamId, licenses: list.licenses, country: body.user_country };
}

/**
 * Logs on as nobody: enough for what Steam gives everyone -- the content
 * servers, product info of public apps, the keys of depots free to all.
 *
 * @param {CmConnection} connection
 * @returns {Promise<{ steamId: bigint }>}
 */
export async function logOnAnonymously(connection){
    const { steamId } = await logOnAs(connection, ANONYMOUS_USER, {});
    return { steamId };
}

/**
 * Product info for packages and apps, with the access tokens it needs.
 *
 * @param {CmConnection} connection
 * @param {{
 *     packages?: Array<{ packageid: number, access_token?: bigint }>, apps?: number[],
 * }} request
 * @returns {Promise<{ packages: Map<number, KeyValues>, apps: Map<number, KeyValues> }>}
 */
export async function productInfo(connection, { packages = [], apps = [] }){
    /** @type {Array<{ appid: number, access_token?: bigint }>} */
    let appRequests = [];
    if (apps.length)
    {
        const tokens = decode(PICSAccessTokenResponse, (await connection.request(
            EMsg.ClientPICSAccessTokenRequest, PICSAccessTokenRequest, { appids: apps })).body);
        const byApp = new Map(tokens.app_access_tokens.map((/** @type {any} */ t)=>[t.appid, t.access_token]));
        appRequests = apps.map(appid=>({ appid, access_token: byApp.get(appid) ?? 0n }));
    }
    const answers = await connection.requestAll(EMsg.ClientPICSProductInfoRequest,
        PICSProductInfoRequest, { packages, apps: appRequests },
        message=>!decode(PICSProductInfoResponse, message.body).response_pending);
    /** @type {Map<number, KeyValues>} */
    const packageInfo = new Map();
    /** @type {Map<number, KeyValues>} */
    const appInfo = new Map();
    for (const answer of answers)
    {
        const body = decode(PICSProductInfoResponse, answer.body);
        for (const pkg of body.packages)
        {
            if (!pkg.buffer)
            {
                continue;
            }
            // A package's buffer starts with its id, then the KeyValues.
            const info = parseBinary(pkg.buffer.subarray(4));
            packageInfo.set(pkg.packageid, /** @type {KeyValues} */ (Object.values(info)[0] ?? {}));
        }
        for (const app of body.apps)
        {
            if (!app.buffer)
            {
                continue;
            }
            const text = new TextDecoder().decode(app.buffer);
            appInfo.set(app.appid, /** @type {KeyValues} */ (parseText(text).appinfo ?? {}));
        }
    }
    return { packages: packageInfo, apps: appInfo };
}

/**
 * A game in the library.
 *
 * @typedef {Object} LibraryGame
 * @property {number} appid
 * @property {string} name
 * @property {KeyValues} info  The app's whole info: launch options, depots.
 */

/** @param {KeyValues | undefined} node @param {string} key */
const field = (node, key)=>{
    if (!node)
    {
        return undefined;
    }
    const found = Object.keys(node).find(name=>name.toLowerCase() === key);
    return found === undefined ? undefined : node[found];
};

/**
 * The games a session's licences grant, by name.
 *
 * @param {CmConnection} connection
 * @param {Array<Record<string, any>>} licenses
 * @returns {Promise<LibraryGame[]>}
 */
export async function library(connection, licenses){
    const { packages } = await productInfo(connection, {
        packages: licenses.map(license=>({
            packageid: license.package_id, access_token: license.access_token ?? 0n,
        })),
    });
    const appids = new Set();
    for (const info of packages.values())
    {
        const granted = /** @type {KeyValues | undefined} */ (field(info, 'appids'));
        for (const appid of Object.values(granted ?? {}))
        {
            appids.add(Number(appid));
        }
    }
    const { apps } = await productInfo(connection, { apps: [...appids] });
    /** @type {LibraryGame[]} */
    const games = [];
    for (const [appid, info] of apps)
    {
        const common = /** @type {KeyValues | undefined} */ (field(info, 'common'));
        const type = String(field(common, 'type') ?? '').toLowerCase();
        if (type === 'game')
        {
            games.push({ appid, name: String(field(common, 'name') ?? appid), info });
        }
    }
    return games.sort((a, b)=>a.name.localeCompare(b.name));
}
