/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/** A runtime port and a page's WebSocket, made up for a test of the pipe. */

/**
 * Two ends of a port: each message JSON-copied, as a runtime port carries it,
 * and kept.
 */
export function portPair(){
    /** @type {{ to: 'worker' | 'page', raw: any }[]} */
    const carried = [];
    const ends = ['page', 'worker'].map(()=>({ heard: /** @type {Function[]} */ ([]),
        dropped: /** @type {Function[]} */ ([]) }));
    /** @param {number} self @param {'worker' | 'page'} to */
    const end = (self, to)=>({
        postMessage: (/** @type {any} */ raw)=>{
            const copy = JSON.parse(JSON.stringify(raw));
            carried.push({ to, raw: copy });
            queueMicrotask(()=>ends[1 - self].heard.forEach(listener=>listener(copy)));
        },
        onMessage: { addListener: (/** @type {Function} */ listener)=>ends[self].heard.push(listener) },
        onDisconnect: { addListener: (/** @type {Function} */ listener)=>ends[self].dropped.push(listener) },
        disconnect: ()=>ends[1 - self].dropped.forEach(listener=>listener()),
    });
    /** The worker stopped: both ends hear it. */
    const drop = ()=>ends.forEach(one=>one.dropped.forEach(listener=>listener()));
    return { page: end(0, 'worker'), worker: end(1, 'page'), carried, drop };
}

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
