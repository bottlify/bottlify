/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Minimal CDP (Chrome DevTools Protocol) client over WebSocket.
 */

/**
 * @typedef {Object} CdpMessage
 * @property {number} [id]
 * @property {string} [method]
 * @property {Object} [params]
 * @property {Object} [result]
 * @property {Object} [error]
 */

export class CdpEndpoint {
    /**
     * @param {string} wsUrl
     */
    constructor(wsUrl){
        this.wsUrl = wsUrl;
        /** @type {WebSocket} */
        this.ws = null;
        /** @type {Map<number, { resolve: Function, reject: Function }>} */
        this.pending = new Map();
        /** @type {Map<string, Set<Function>>} */
        this.listeners = new Map();
        this.nextId = 1;
    }

    /** @returns {Promise<void>} */
    async open(){
        this.ws = new WebSocket(this.wsUrl);
        this.ws.addEventListener('message', event=>{
            let message;
            try {
                message = JSON.parse(event.data);
            } catch {
                return;
            }
            this.dispatch(message);
        });
        await new Promise((resolve, reject)=>{
            this.ws.addEventListener('open', resolve, { once: true });
            this.ws.addEventListener('error',
                ()=>reject(new Error('WebSocket error while connecting to CDP')),
                { once: true });
        });
        this.ws.addEventListener('close', ()=>{
            for (const { reject } of this.pending.values())
            {
                reject(new Error('CDP connection closed'));
            }
            this.pending.clear();
        });
    }

    /**
     * @param {CdpMessage} message
     */
    dispatch(message){
        if (message.id != null)
        {
            const pending = this.pending.get(message.id);
            if (!pending)
            {
                return;
            }
            this.pending.delete(message.id);
            if (message.error)
            {
                pending.reject(new Error(`${message.error.message}`));
            }
            else pending.resolve(message.result);
            return;
        }
        if (message.method)
        {
            const listeners = this.listeners.get(message.method);
            if (listeners)
            {
                for (const listener of listeners)
                {
                    listener(message.params ?? {});
                }
            }
        }
    }

    /**
     * Sends a CDP command.
     *
     * @param {string} method
     * @param {Object} [params]
     * @param {string | null} [sessionId]
     * @returns {Promise<any>} result payload
     */
    send(method, params = {}, sessionId = null){
        /** @type {CdpMessage} */
        const message = { id: this.nextId++, method, params };
        if (sessionId)
        {
            message.sessionId = sessionId;
        }
        return new Promise((resolve, reject)=>{
            this.pending.set(message.id, { resolve, reject });
            this.ws.send(JSON.stringify(message));
            setTimeout(()=>{
                if (this.pending.has(message.id))
                {
                    this.pending.delete(message.id);
                    reject(new Error(`CDP command timed out: ${method}`));
                }
            }, 30000);
        });
    }

    /**
     * Subscribes to CDP events.
     *
     * @param {string} method
     * @param {(params: Object) => void} listener
     * @returns {() => void} unsubscribe
     */
    on(method, listener){
        if (!this.listeners.has(method))
        {
            this.listeners.set(method, new Set());
        }
        this.listeners.get(method).add(listener);
        return ()=>this.listeners.get(method)?.delete(listener);
    }

    /** @returns {void} */
    close(){
        this.ws?.close();
    }
}
