/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The sign-in and the library in a page: opened in a person's own browser,
 * the connection to Steam leaves from their address, as it will in Bottlify,
 * and the token stays in the page. tools/steam-page.mjs builds it into one
 * HTML file with the connection managers' addresses written in, since the
 * directory that lists them does not answer a page from another origin.
 */

import { connectCm, encodeQr, library, logOn, qrToSvg, signInWithQr } from '../index.js';

/** @type {string[]} */
const ENDPOINTS = JSON.parse(document.getElementById('endpoints')?.textContent ?? '[]');

/** @param {string} id */
const element = id=>/** @type {HTMLElement} */ (document.getElementById(id));
/** @param {string} text */
const status = text=>{
    element('status').textContent = text;
};

/** @type {import('../connection.js').CmConnection | undefined} */
let connection;
/** The open connection, or a new one: a manager drops one not logged on. */
async function connect(){
    if (connection && !connection.closed)
    {
        return connection;
    }
    for (const endpoint of ENDPOINTS)
    {
        try
        {
            connection = await connectCm({ endpoint });
            return connection;
        }
        catch (e){
            void e;
        }
    }
    throw new Error('no Steam connection manager answered');
}

async function run(){
    // A page opened from disk has the origin "null", which the managers turn
    // away (403); served from any http(s) origin, localhost included, it is let in.
    if (location.protocol === 'file:')
    {
        status('Steam turns away a page opened from disk. Serve this folder, e.g. '
            + '`python3 -m http.server 8000`, and open http://localhost:8000/steam.html');
        return;
    }
    status('Connecting to Steam…');
    for (;;)
    {
        try
        {
            const signedIn = await signInWithQr(connect, {
                deviceName: 'Bottlify',
                onChallenge: url=>{
                    element('qr').innerHTML = qrToSvg(encodeQr(url), 6);
                    status('Scan with the Steam app: Steam Guard → the QR scanner.');
                },
                onScanned: ()=>status('Scanned. Approve the sign-in in the Steam app.'),
            });
            element('qr').innerHTML = '';
            status(`Signed in as ${signedIn.accountName}. Logging on…`);
            const session = await logOn(await connect(), signedIn);
            status(`Logged on: ${session.licenses.length} licences. Reading the library…`);
            const games = await library(await connect(), session.licenses);
            status(`${signedIn.accountName}: ${games.length} games`);
            const list = element('games');
            for (const game of games)
            {
                const item = document.createElement('li');
                item.textContent = `${game.name} (${game.appid})`;
                list.append(item);
            }
            return;
        }
        catch (e){
            status(`${/** @type {Error} */ (e).message} — starting again`);
        }
    }
}

run();
