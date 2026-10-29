/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Signs in to Steam by QR code from Node, as @bottlify/steam does in a page,
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
import { deflateSync } from 'node:zlib';
import { connectCm, encodeQr, library, logOn, signInWithQr } from '../modules/steam/src/index.js';

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

const crcTable = Array.from({ length: 256 }, (_, n)=>{
    let c = n;
    for (let k = 0; k < 8; k++)
    {
        c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    }
    return c >>> 0;
});
/** @param {Buffer} bytes */
const crc32 = bytes=>{
    let c = 0xFFFFFFFF;
    for (const byte of bytes)
    {
        c = crcTable[(c ^ byte) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
};
/** @param {string} type @param {Buffer} data */
const chunk = (type, data)=>{
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, tail]);
};

/**
 * A QR code as a greyscale PNG, with its quiet zone.
 *
 * @param {boolean[][]} modules @param {number} scale
 */
function qrPng(modules, scale){
    const size = (modules.length + 8) * scale;
    const rows = [];
    for (let y = 0; y < size; y++)
    {
        const row = Buffer.alloc(size + 1);
        for (let x = 0; x < size; x++)
        {
            const dark = modules[Math.floor(y / scale) - 4]?.[Math.floor(x / scale) - 4];
            row[x + 1] = dark ? 0 : 255;
        }
        rows.push(row);
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header[8] = 8;
    header[9] = 0;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(Buffer.concat(rows))),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

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
// A manager drops a connection that has not logged on after a minute or so,
// and the sign-in with it: a new one begins, with a new code, until the time
// is up.
while (!signedIn)
{
    const abort = new AbortController();
    const timer = setTimeout(()=>abort.abort(new Error(`not approved within ${minutes} minutes`)),
        Math.max(0, deadline - Date.now()));
    try
    {
        if (connection.closed)
        {
            connection = await connect();
        }
        signedIn = await signInWithQr(connection, {
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
