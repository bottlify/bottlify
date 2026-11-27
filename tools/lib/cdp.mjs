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
     * @param {number} [timeoutMs]  30 s unless the command is known to take longer
     *     (a heap snapshot of a worker holding gigabytes)
     * @returns {Promise<any>} result payload
     */
    send(method, params = {}, sessionId = null, timeoutMs = 30000){
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
            }, timeoutMs);
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

/**
 * A page a harness drives, opened so that it cannot take the pointer.
 *
 * A launcher or a game page asks for pointer lock when its canvas is clicked,
 * and a scripted click is one. On Windows the browser then confines the
 * machine's own cursor, headless or not, and the person at the machine cannot
 * use it while the harness plays. The page is opened blank, told that a lock
 * request does nothing, and only then sent where it was going; without the
 * lock the engine still has relative motion through movementX/Y
 * (`layers/input/dom.js`).
 *
 * @param {CdpEndpoint} cdp
 * @param {string} url
 * @returns {Promise<{ targetId: string, sessionId: string }>}
 */
export async function openPage(cdp, url){
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: 'Element.prototype.requestPointerLock = function(){ return Promise.resolve(); };',
    }, sessionId);
    await cdp.send('Page.navigate', { url }, sessionId);
    return { targetId, sessionId };
}
