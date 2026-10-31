/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Signs in to Steam by QR code from Node, as @bottlify/core/steam does in a page,
 * and lists the library: the way to try the sign-in, the logon and the
 * library without a browser.
 *
 *   NODE_USE_ENV_PROXY=1 node tools/steam-signin.mjs --qr <file.png>
 *       [--token <file>] [--library <file.json>] [--minutes N]
 *
 * --qr is rewritten each time the code changes; scan it with the Steam
 * mobile app. --token keeps the refresh token (mode 600) for a later run,
 * which then logs on with it and shows no code; it is a credential -- keep
 * it out of the repository and delete it when done. Nothing here prints it.
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { connectCm } from '../modules/bridge/src/stores/steam/connection.js';
import { signInWithQr } from '../modules/bridge/src/stores/steam/auth.js';
import { library, logOn } from '../modules/bridge/src/stores/steam/session.js';
import { encodeQr } from '../modules/core/src/steam/qr.js';
import { qrPng } from './qr-png.mjs';

const argv = process.argv.slice(2);
/** @param {string} name */
const option = name=>{
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
};
const qrPath = option('--qr');
const tokenPath = option('--token');
const libraryPath = option('--library');
const minutes = Number(option('--minutes') ?? 5);

const directory = await (await fetch(
    'https://api.steampowered.com/ISteamDirectory/GetCMListForConnect/v1/?cellid=0&cmtype=websockets')).json();
/** @type {string[]} */
const endpoints = directory.response.serverlist.map((/** @type {any} */ s)=>s.endpoint);
// Port 443 first: the one a firewall least often closes.
endpoints.sort((a, b)=>Number(!a.endsWith(':443')) - Number(!b.endsWith(':443')));
/** A connection to the first manager that answers. */
async function connect(){
    for (const endpoint of endpoints.slice(0, 6))
    {
        try
        {
            const connection = await connectCm({ endpoint });
            console.log(`connected to ${endpoint}`);
            connection.onClose(reason=>console.log(`connection closed: ${reason}`));
            return connection;
        }
        catch (e){
            console.log(`${endpoint}: ${/** @type {Error} */ (e).message}`);
        }
    }
    throw new Error('no connection manager answered');
}

let connection = await connect();
/** @type {{ accountName: string, refreshToken: string } | undefined} */
let signedIn;
if (tokenPath && existsSync(tokenPath))
{
    signedIn = JSON.parse(readFileSync(tokenPath, 'utf8'));
    console.log(`using the kept token for ${signedIn?.accountName}`);
}
const deadline = Date.now() + minutes * 60000;
/** The open connection, or a new one when it has closed. */
const current = async()=>{
    if (connection.closed)
    {
        connection = await connect();
    }
    return connection;
};
// A code that expires or is turned down ends the sign-in: a new one begins,
// with a new code, until the time is up.
while (!signedIn)
{
    const abort = new AbortController();
    const timer = setTimeout(()=>abort.abort(new Error(`not approved within ${minutes} minutes`)),
        Math.max(0, deadline - Date.now()));
    try
    {
        signedIn = await signInWithQr(current, {
            signal: abort.signal,
            onScanned: ()=>console.log(`scanned, awaiting approval, ${new Date().toISOString()}`),
            onChallenge: url=>{
                if (qrPath)
                {
                    writeFileSync(qrPath, qrPng(encodeQr(url), 8));
                    // The link too: opened on the phone, the app takes it as a scan.
                    writeFileSync(`${qrPath}.txt`, `${url}\n`);
                }
                const where = qrPath ? `written to ${qrPath}` : url;
                console.log(`QR code ${where} at ${new Date().toISOString()}`);
            },
        });
    }
    catch (e){
        if (Date.now() >= deadline)
        {
            throw e;
        }
        console.log(`sign-in ended (${/** @type {Error} */ (e).message}); beginning again`);
    }
    finally
    {
        clearTimeout(timer);
    }
}
if (!tokenPath || !existsSync(tokenPath))
{
    console.log(`approved: ${signedIn.accountName}`);
    if (tokenPath)
    {
        writeFileSync(tokenPath, JSON.stringify(signedIn), { mode: 0o600 });
        chmodSync(tokenPath, 0o600);
    }
}
if (connection.closed)
{
    connection = await connect();
}

const session = await logOn(connection, signedIn);
console.log(`logged on as ${session.steamId}, ${session.licenses.length} licences`);
const games = await library(connection, session.licenses);
console.log(`${games.length} games:`);
for (const game of games)
{
    console.log(`  ${game.appid}\t${game.name}`);
}
if (libraryPath)
{
    writeFileSync(libraryPath, JSON.stringify(games, (_, value)=>(typeof value === 'bigint'
        ? value.toString() : value), 2));
}
connection.close();
