/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * App ownership tickets for a signed-in session, as a launcher's bridge gets
 * them (EMsg 857/858): for the node runs and the cdp harness, which hand them
 * to the engine's Steam client (`win32.steam.ownershipTickets`). Kept in
 * memory for the one run; never written to a file, a log or a report.
 *
 * --session is { accountName, refreshToken }, as tools/steam-signin.mjs
 * --token writes it; `-` reads it from stdin.
 */

import { readFileSync } from 'node:fs';
import { connectCm } from '../modules/bridge/src/stores/steam/connection.js';
import { appOwnershipTicket, logOn } from '../modules/bridge/src/stores/steam/session.js';

/**
 * Each app's ownership ticket the session's account is given: none for an
 * app it does not own.
 *
 * @param {string} sessionPath @param {number[]} apps
 * @returns {Promise<Record<number, Uint8Array>>}
 */
export async function ownershipTickets(sessionPath, apps){
    const session = JSON.parse(readFileSync(sessionPath === '-' ? 0 : sessionPath, 'utf8'));
    const directory = await (await fetch('https://api.steampowered.com/ISteamDirectory/'
        + 'GetCMListForConnect/v1/?cellid=0&cmtype=websockets')).json();
    /** @type {any} */
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
    try
    {
        await logOn(connection, session);
        /** @type {Record<number, Uint8Array>} */
        const tickets = {};
        for (const app of apps)
        {
            const ticket = await appOwnershipTicket(connection, app);
            if (ticket)
            {
                tickets[app] = ticket;
            }
        }
        return tickets;
    }
    finally
    {
        connection.close?.();
    }
}
