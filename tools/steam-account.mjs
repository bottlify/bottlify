/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The account a signed-in session is, and the games its licences grant: what
 * the engine's Steam client answers a game with (createApp's `win32.steam`).
 * The session's refresh token is used to sign in and is not written out.
 *
 *   node tools/steam-account.mjs --session <file> --out <account.json>
 *
 * --session is { accountName, refreshToken }, as the launcher's /steam page
 * keeps it in bottlify-ui/.steam/session.json.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { connectCm, library, logOn } from '../modules/core/src/steam/index.js';

const args = process.argv.slice(2);
/** @param {string} name */
const option = name=>(args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const sessionPath = option('--session');
const out = option('--out');
if (!sessionPath || !out)
{
    throw new Error('usage: node tools/steam-account.mjs --session <file> --out <account.json>');
}

const directory = await (await fetch('https://api.steampowered.com/ISteamDirectory/'
    + 'GetCMListForConnect/v1/?cellid=0&cmtype=websockets')).json();
/** @type {import('../modules/core/src/steam/connection.js').CmConnection | undefined} */
let connection;
for (const server of directory.response.serverlist.slice(0, 8))
{
    try
    {
        connection = await connectCm({ endpoint: server.endpoint });
        break;
    }
    catch (e){
        void e;
    }
}
if (!connection)
{
    throw new Error('no Steam connection manager answered');
}
const session = JSON.parse(readFileSync(sessionPath, 'utf8'));
const { steamId, licenses } = await logOn(connection, session);
const games = await library(connection, licenses);
connection.close();
const account = { steamId: String(steamId), accountName: session.accountName,
    apps: games.map(game=>game.appid).sort((a, b)=>a - b), language: 'english' };
writeFileSync(out, `${JSON.stringify(account, null, 2)}\n`);
console.log(`${account.accountName}: ${account.apps.length} games`);
