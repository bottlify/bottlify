/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Whether a connection manager takes a short-lived access token for a logon
 * where a client gives its refresh token. The access token is minted from the
 * refresh token over HTTPS (IAuthenticationService GenerateAccessTokenForApp),
 * as an extension's service worker would ask it, and each token is tried in a
 * ClientLogon over a connection of its own. Then a renewal: whether Steam
 * gives a new refresh token, and whether the old one still logs on after it.
 * Prints what each token is for (the JWT's `aud`, its lifetime) and each
 * answer; never a token.
 *
 *   node tools/steam-access-logon.mjs --qr <file.png> [--minutes 5]
 *   node tools/steam-access-logon.mjs --token <file>
 *
 * --qr signs in by QR code (scan <file.png> with the Steam app; the link is
 * beside it in <file.png>.txt) and keeps the token in memory only. --token
 * reads what `tools/steam-signin.mjs --token` kept, and writes a renewed
 * token back to it.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { connectCm } from '../modules/bridge/src/stores/steam/connection.js';
import { signInWithQr } from '../modules/bridge/src/stores/steam/auth.js';
import { logOn, steamIdOfToken } from '../modules/bridge/src/stores/steam/session.js';
import { decode, encode } from '../modules/core/src/steam/protobuf.js';
import { encodeQr } from '../modules/core/src/steam/qr.js';
import { qrPng } from './qr-png.mjs';

const argv = process.argv.slice(2);
/** @param {string} name */
const option = name=>(argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const tokenPath = option('--token');
const qrPath = option('--qr');
const minutes = Number(option('--minutes') ?? 5);
if (!tokenPath && !qrPath)
{
    console.error('usage: node tools/steam-access-logon.mjs --qr <file.png> | --token <file>');
    process.exit(2);
}

/** CAuthentication_AccessToken_GenerateForApp_Request and its response. */
const GenerateRequest = { refresh_token: [1, 'string'], steamid: [2, 'fixed64'],
    renewal_type: [3, 'int32'] };
const GenerateResponse = { access_token: [1, 'string'], refresh_token: [2, 'string'] };
/** ETokenRenewalType. */
const RENEWAL_NONE = 0;
const RENEWAL_ALLOW = 1;

/** What a JWT says of itself, its signature left out. @param {string} token */
function claims(token){
    const json = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
    const left = Math.round((json.exp - Date.now() / 1000) / 60);
    return `aud ${JSON.stringify(json.aud)}, ${left} minutes left`;
}

/** @param {string} refreshToken @param {number} renewal */
async function mint(refreshToken, renewal){
    const body = encode(GenerateRequest, { refresh_token: refreshToken,
        steamid: steamIdOfToken(refreshToken), renewal_type: renewal });
    const form = new URLSearchParams(
        { input_protobuf_encoded: Buffer.from(body).toString('base64') });
    const answer = await fetch('https://api.steampowered.com/IAuthenticationService/'
        + 'GenerateAccessTokenForApp/v1/', { method: 'POST', body: form });
    const bytes = new Uint8Array(await answer.arrayBuffer());
    console.log(`GenerateAccessTokenForApp (renewal ${renewal}) over HTTPS: HTTP ${answer.status},`
        + ` EResult ${answer.headers.get('x-eresult')}, ${bytes.length} bytes`);
    return /** @type {{ access_token?: string, refresh_token?: string }} */ (
        decode(GenerateResponse, bytes));
}

const directory = await (await fetch('https://api.steampowered.com/ISteamDirectory/'
    + 'GetCMListForConnect/v1/?cellid=0&cmtype=websockets')).json();
/** @type {string[]} */
const endpoints = directory.response.serverlist.map((/** @type {any} */ one)=>one.endpoint)
    .filter((/** @type {string} */ one)=>one.endsWith(':443'));
const connect = ()=>connectCm({ endpoint: endpoints[0] });

/** A logon over a connection of its own. @param {string} what @param {any} session */
async function tryLogOn(what, session){
    const link = await connect();
    try
    {
        const { steamId, licenses } = await logOn(link, session);
        const whose = steamId === steamIdOfToken(session.refreshToken) ? 'the token\'s' : 'another';
        console.log(`logon with the ${what}: accepted, ${licenses.length} licences,`
            + ` ${whose} Steam ID`);
    }
    catch (e){
        console.log(`logon with the ${what}: ${/** @type {Error} */ (e).message}`);
    }
    finally
    {
        link.close();
    }
}

/** @type {{ accountName: string, refreshToken: string }} */
let kept;
if (tokenPath)
{
    kept = JSON.parse(readFileSync(tokenPath, 'utf8'));
}
else
{
    /** @type {any} */
    let link = null;
    const signal = AbortSignal.timeout(minutes * 60_000);
    kept = await signInWithQr(async()=>{
        if (!link || link.closed)
        {
            link = await connect();
        }
        return link;
    }, { signal, deviceName: 'Bottlify probe',
        onScanned: ()=>console.log('scanned, awaiting approval'),
        onChallenge: url=>{
            writeFileSync(/** @type {string} */ (qrPath), qrPng(encodeQr(url), 8));
            writeFileSync(`${qrPath}.txt`, `${url}\n`);
            console.log(`QR code written to ${qrPath} at ${new Date().toISOString()}`);
        } });
    link?.close();
    console.log('signed in');
}

console.log(`refresh token: ${claims(kept.refreshToken)}`);
const minted = await mint(kept.refreshToken, RENEWAL_NONE);
if (minted.access_token)
{
    console.log(`access token: ${claims(minted.access_token)}`
        + `${minted.refresh_token ? '; a refresh token came too' : ''}`);
    await tryLogOn('access token', { accountName: kept.accountName,
        refreshToken: minted.access_token });
}
else
{
    console.log('no access token was given');
}
await tryLogOn('refresh token', kept);

const renewed = await mint(kept.refreshToken, RENEWAL_ALLOW);
if (renewed.refresh_token && renewed.refresh_token !== kept.refreshToken)
{
    console.log(`renewal: a new refresh token, ${claims(renewed.refresh_token)}`);
    await tryLogOn('renewed refresh token', { ...kept, refreshToken: renewed.refresh_token });
    await tryLogOn('refresh token it replaced', kept);
    if (tokenPath)
    {
        writeFileSync(tokenPath, JSON.stringify({ ...kept, refreshToken: renewed.refresh_token }),
            { mode: 0o600 });
        console.log(`the renewed token kept in ${tokenPath}`);
    }
}
else
{
    console.log('renewal: no new refresh token (Steam renews one near its expiry)');
}
process.exit(0);
