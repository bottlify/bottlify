/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The relay, on a port.
 *
 * Two pieces meet here and neither knows about the other: a WebSocket server
 * that turns a socket into messages, and a router that turns messages into
 * network. Keeping them apart is what lets the whole of the routing be tested
 * without a port, and what would let the relay run over some other carrier
 * without the routing noticing.
 */

import { createRelay } from './relay.js';
import { createWebSocketServer } from './websocket.js';

export { createRelay } from './relay.js';
export { createWebSocketServer, Connection } from './websocket.js';
// Whether the relay may open a connection to a host outside its rooms, for a
// server that hosts the relay itself.
export { permits } from './cli.js';
// A relay whose only way out is an HTTP proxy dials through it.
export { connectThrough, proxyDialer } from './tunnel.js';

/**
 * @typedef {import('./relay.js').RelayOptions & {
 *     port?: number,
 *     host?: string,
 *     server?: import('node:http').Server,
 *     path?: string,
 *     origins?: string[] | ((request: import('node:http').IncomingMessage) => boolean),
 *     maxConnections?: number,
 *     maxConnectionsPerAddress?: number,
 *     addressOf?: (request: import('node:http').IncomingMessage) => string,
 * }} RelayServerOptions
 *     `server` and `path` attach the relay to an existing HTTP or HTTPS
 *     server at one path instead of listening on a port of its own.
 *     `origins` lists the pages that may open a link, or answers for a
 *     request: a relay inside a launcher admits its own pages, whatever address
 *     it was reached at (`request.headers.host`).
 *     `maxConnections` (1024) and `maxConnectionsPerAddress` (16) bound the
 *     links at once, the second by the address `addressOf` names: the socket's
 *     own by default, or a header a proxy in front sets, such as Cloudflare's
 *     `cf-connecting-ip` -- trusted only when nothing but that proxy can
 *     reach the relay.
 */

/**
 * @param {RelayServerOptions} [options]
 */
export function createRelayServer(options = {}){
    const relay = createRelay(options);
    const origins = options.origins;
    const maxConnections = options.maxConnections ?? 1024;
    const maxPerAddress = options.maxConnectionsPerAddress ?? 16;
    const addressOf = options.addressOf ?? (request=>String(request.socket.remoteAddress ?? ''));
    /** @type {Map<string, number>} */
    const open = new Map();
    let total = 0;

    const server = createWebSocketServer({
        port: options.port,
        host: options.host,
        server: options.server,
        path: options.path,
        // An unlisted origin is refused at the handshake rather than after
        // joining: a browser will happily open a WebSocket cross-origin, so the
        // only place to decide whose pages may use this relay is here.
        // The bounds are checked here too, so one address opening links in a
        // loop is refused before a handshake rather than after a join.
        allow: request=>(!origins || (typeof origins === 'function' ? origins(request) === true
            : origins.includes(String(request.headers.origin ?? ''))))
            && total < maxConnections && (open.get(addressOf(request)) ?? 0) < maxPerAddress,
    }, (connection, request)=>{
        const address = addressOf(request);
        open.set(address, (open.get(address) ?? 0) + 1);
        total++;
        const session = relay.connect({
            sendBinary: bytes=>connection.sendBinary(bytes),
            sendText: text=>connection.sendText(text),
            disconnect: ()=>connection.close(),
            buffered: ()=>connection.waiting,
        });
        connection.on('message', (data, binary)=>session.message(data, binary));
        connection.on('drain', ()=>session.drained());
        connection.on('close', ()=>{
            total--;
            const left = (open.get(address) ?? 1) - 1;
            if (left === 0)
            {
                open.delete(address);
            }
            else
            {
                open.set(address, left);
            }
            session.close();
        });
    });

    return {
        listen: ()=>server.listen(),
        close: ()=>server.close(),
        diagnostics: ()=>({ ...relay.diagnostics(), links: total }),
    };
}
