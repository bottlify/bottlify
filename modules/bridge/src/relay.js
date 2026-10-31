/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Sockets the worker speaks over and the page opens: each looks to the
 * worker's protocol code like a WebSocket (core's connection.js CmSocket), and
 * is opened, written and closed by the content script at the other end of the
 * port (pipe.js), which carries its frames as they are.
 */

/** @typedef {import('./stores/steam/connection.js').CmSocket} CmSocket */

/**
 * @param {(message: Record<string, any>) => void} send  Onto the port.
 */
export function createRelay(send){
    let next = 0;
    /** @type {Map<number, CmSocket>} */
    const sockets = new Map();

    /** @param {number} id */
    const end = (id, code = 1006)=>{
        const socket = sockets.get(id);
        sockets.delete(id);
        socket?.onclose?.({ code });
    };

    return {
        /**
         * A socket to `url`, opened by the page.
         *
         * @param {string} url
         * @returns {CmSocket}
         */
        socket(url){
            const id = ++next;
            /** @type {CmSocket} */
            const socket = {
                binaryType: 'arraybuffer',
                onopen: null,
                onmessage: null,
                onclose: null,
                onerror: null,
                send: data=>send({ send: { socket: id, data } }),
                close: ()=>send({ close: { socket: id } }),
            };
            sockets.set(id, socket);
            send({ open: { socket: id, url } });
            return socket;
        },

        /**
         * A message from the port: true when it was a socket's.
         *
         * @param {Record<string, any>} message
         */
        heard(message){
            if (message.opened)
            {
                sockets.get(message.opened.socket)?.onopen?.({});
            }
            else if (message.frame)
            {
                const bytes = /** @type {Uint8Array} */ (message.frame.data);
                sockets.get(message.frame.socket)?.onmessage?.({ data: /** @type {ArrayBuffer} */ (
                    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) });
            }
            else if (message.failed)
            {
                sockets.get(message.failed.socket)?.onerror?.({});
            }
            else if (message.closed)
            {
                end(message.closed.socket, message.closed.code);
            }
            else
            {
                return false;
            }
            return true;
        },

        /** The port dropped: every socket is closed with it. */
        closeAll(){
            for (const id of [...sockets.keys()])
            {
                end(id);
            }
        },
    };
}
