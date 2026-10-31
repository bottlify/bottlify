/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * One page's port, at the service worker's end: the page's requests read
 * (protocol.js) and answered by the hub, the sockets the stores speak over
 * relayed through the page (relay.js). The port's first message says what the
 * site switches on; what the port held goes with it when it drops.
 */

import { createHub } from './hub.js';
import { createRelay } from './relay.js';
import { createWire } from './wire.js';
import { FROM, readRequest } from './protocol.js';

/** @typedef {import('./pipe.js').Port} Port */

/**
 * @param {Port & { disconnect?: () => void }} port
 * @param {Object} options
 * @param {string} options.version
 * @param {(wanted: Record<string, unknown>) => Promise<Record<string, boolean>>} options.switch
 *     Applies the site's switches to the rulesets; answers what is on.
 * @param {(socket: (url: string) => any) => Record<string, import('./hub.js').Store>}
 *     options.stores  The stores, speaking over the page's sockets.
 */
export function servePort(port, { version, switch: switchRulesets, stores }){
    const wire = createWire(raw=>port.postMessage(raw));
    const relay = createRelay(message=>wire.send(message));
    const made = stores(url=>relay.socket(url));
    /** @type {ReturnType<typeof createHub> | null} */
    let hub = null;
    /** @type {(value?: unknown) => void} */
    let start = ()=>{};
    const started = new Promise(resolve=>{
        start = resolve;
    });

    /** @param {Record<string, any>} reply */
    const answer = reply=>wire.send({ reply: { from: FROM, ...reply } });

    /** @param {unknown} data */
    const asked = async data=>{
        const request = readRequest(data);
        if (!request)
        {
            return;
        }
        if ('error' in request)
        {
            answer(request);
            return;
        }
        await started;
        try
        {
            const result = await /** @type {NonNullable<typeof hub>} */ (hub).handle(request,
                (event, body)=>answer({ id: request.id, event, data: body }));
            answer({ id: request.id, result: result ?? null });
        }
        catch (e){
            answer({ id: request.id, error: String(/** @type {Error} */ (e)?.message ?? e) });
        }
    };

    port.onMessage.addListener(raw=>{
        const message = wire.receive(raw);
        if (!message || relay.heard(message))
        {
            return;
        }
        if (message.hello && !hub)
        {
            const wanted = typeof message.hello.platforms === 'object' && message.hello.platforms
                ? message.hello.platforms : {};
            // A switch that failed leaves every store off: GameHub then refuses
            // rather than talk past a rule that may not hold.
            switchRulesets(wanted).catch(()=>null).then(on=>{
                hub = createHub({ version, stores: made, platforms: Object.fromEntries(
                    Object.keys(made).map(id=>[id, on ? on[id] !== false : false])) });
                start();
            });
        }
        else if (message.request)
        {
            asked(message.request);
        }
    });
    port.onDisconnect.addListener(()=>{
        relay.closeAll();
        hub?.close();
    });
}
