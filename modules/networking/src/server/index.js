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

/**
 * @typedef {import('./relay.js').RelayOptions & {
 *     port?: number,
 *     host?: string,
 *     server?: import('node:http').Server,
 *     path?: string,
 *     origins?: string[],
 * }} RelayServerOptions
 *     `server` and `path` attach the relay to an existing HTTP or HTTPS
 *     server at one path instead of listening on a port of its own.
 */

/**
 * @param {RelayServerOptions} [options]
 */
export function createRelayServer(options = {}){
    const relay = createRelay(options);
    const origins = options.origins;

    const server = createWebSocketServer({
        port: options.port,
        host: options.host,
        server: options.server,
        path: options.path,
        // An unlisted origin is refused at the handshake rather than after
        // joining: a browser will happily open a WebSocket cross-origin, so the
        // only place to decide whose pages may use this relay is here.
        allow: request=>!origins
            || origins.includes(String(request.headers.origin ?? '')),
    }, connection=>{
        const session = relay.connect({
            sendBinary: bytes=>connection.sendBinary(bytes),
            sendText: text=>connection.sendText(text),
            disconnect: ()=>connection.close(),
        });
        connection.on('message', (data, binary)=>session.message(data, binary));
        connection.on('close', ()=>session.close());
    });

    return {
        listen: ()=>server.listen(),
        close: ()=>server.close(),
        diagnostics: ()=>relay.diagnostics(),
    };
}
