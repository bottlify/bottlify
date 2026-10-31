/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/** A WebSocket, made up for a test of a store's connection. */

/** A WebSocket as the page has one, its frames kept. */
export class FakeSocket {
    /** @param {string} url */
    constructor(url){
        this.url = url;
        this.binaryType = 'blob';
        /** @type {Uint8Array[]} */
        this.sent = [];
        this.closed = false;
        /** @type {any} */ this.onopen = null;
        /** @type {any} */ this.onmessage = null;
        /** @type {any} */ this.onclose = null;
        /** @type {any} */ this.onerror = null;
        setTimeout(()=>this.onopen?.({}), 0);
    }

    /** @param {Uint8Array} data */
    send(data){
        this.sent.push(new Uint8Array(data));
    }

    close(){
        this.closed = true;
        setTimeout(()=>this.onclose?.({ code: 1000 }), 0);
    }
}
