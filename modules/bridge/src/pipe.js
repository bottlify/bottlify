/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The content script's work, all of it a pipe: the page's requests go to the
 * service worker over a runtime port and its answers come back to the page;
 * and the sockets the worker asks for are opened here -- a socket opened by the
 * page is one the ruleset gives Steam's Origin, which a socket of the
 * extension's own does not get -- their frames carried both ways. Nothing
 * here reads a request, an answer or a frame.
 *
 * The port is made at the first request and made again after it drops (the
 * worker stopped): the sockets of a port that dropped are closed, and the
 * requests it had not answered are answered with an error.
 */

import { createWire } from './wire.js';

/**
 * @typedef {Object} Port  A runtime port, as the pipe uses one.
 * @property {(message: any) => void} postMessage
 * @property {{ addListener(listener: (message: any) => void): void }} onMessage
 * @property {{ addListener(listener: () => void): void }} onDisconnect
 */

/**
 * @param {Object} options
 * @param {() => Port} options.connect  A new port to the worker.
 * @param {(url: string) => WebSocket} options.socket  A socket the page opens.
 * @param {(answer: Record<string, any>) => void} options.toPage  Posts to the page.
 * @param {Record<string, unknown>} options.platforms  What the site switches on.
 */
export function startPipe({ connect, socket, toPage, platforms }){
    /** @type {{ port: Port, wire: ReturnType<typeof createWire> } | null} */
    let link = null;
    /** @type {Map<number, WebSocket>} */
    const sockets = new Map();
    /** Requests not answered yet, by id. @type {Set<number>} */
    const waiting = new Set();

    /** @param {Record<string, any>} message @param {ReturnType<typeof createWire>} wire */
    const heard = (message, wire)=>{
        if (message.reply)
        {
            if ('result' in message.reply || 'error' in message.reply)
            {
                waiting.delete(message.reply.id);
            }
            toPage(message.reply);
        }
        else if (message.open)
        {
            const id = message.open.socket;
            const ws = socket(message.open.url);
            ws.binaryType = 'arraybuffer';
            sockets.set(id, ws);
            ws.onopen = ()=>wire.send({ opened: { socket: id } });
            ws.onmessage = event=>{
                if (typeof event.data !== 'string')
                {
                    wire.send({ frame: { socket: id, data: new Uint8Array(event.data) } });
                }
            };
            ws.onerror = ()=>wire.send({ failed: { socket: id } });
            ws.onclose = event=>{
                sockets.delete(id);
                wire.send({ closed: { socket: id, code: event.code } });
            };
        }
        else if (message.send)
        {
            sockets.get(message.send.socket)?.send(message.send.data);
        }
        else if (message.close)
        {
            sockets.get(message.close.socket)?.close();
        }
    };

    const open = ()=>{
        if (link)
        {
            return link;
        }
        const port = connect();
        const wire = createWire(raw=>port.postMessage(raw));
        const now = { port, wire };
        link = now;
        port.onMessage.addListener(raw=>{
            const message = wire.receive(raw);
            if (message)
            {
                heard(message, wire);
            }
        });
        port.onDisconnect.addListener(()=>{
            if (link !== now)
            {
                return;
            }
            link = null;
            for (const ws of sockets.values())
            {
                ws.onclose = null;
                ws.close();
            }
            sockets.clear();
            for (const id of waiting)
            {
                toPage({ id, error: 'GameHub was restarted; ask again' });
            }
            waiting.clear();
        });
        wire.send({ hello: { platforms } });
        return now;
    };

    return {
        /**
         * A request the page posted, on its way to the worker.
         *
         * @param {{ id: number, [field: string]: unknown }} request
         */
        request(request){
            const { wire } = open();
            waiting.add(request.id);
            wire.send({ request });
        },
    };
}
