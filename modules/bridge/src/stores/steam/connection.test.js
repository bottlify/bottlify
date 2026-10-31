/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A CM connection's wait for an answer that comes in parts: product info for
 * hundreds of apps is several, and a worker Chrome keeps at a low priority
 * reads them slowly when the machine is busy -- seconds apart, a minute in all.
 * The wait is for the next part, so a slow answer is never taken for none.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFrame, connectCm, parseFrame } from './connection.js';
import { EMsg, PICSProductInfoRequest, PICSProductInfoResponse } from './messages.js';
import { decode, encode } from '../../../../core/src/steam/protobuf.js';

/**
 * A server that answers each request in `parts` parts, `gap` ms apart, or not
 * at all.
 *
 * @param {{ parts: number, gap: number }} how
 */
function serverAnswering({ parts, gap }){
    return (/** @type {string} */ url)=>{
        const socket = /** @type {any} */ ({ url, binaryType: '', onopen: null, onmessage: null,
            onclose: null, onerror: null,
            close(){
                setTimeout(()=>socket.onclose?.({ code: 1000 }), 0);
            },
            send(/** @type {Uint8Array} */ data){
                const message = parseFrame(new Uint8Array(data));
                if (message?.emsg !== EMsg.ClientPICSProductInfoRequest)
                {
                    return;
                }
                for (let part = 1; part <= parts; part++)
                {
                    const frame = buildFrame(EMsg.ClientPICSProductInfoResponse,
                        { jobid_target: message.header.jobid_source },
                        encode(PICSProductInfoResponse, { response_pending: part < parts }));
                    setTimeout(()=>socket.onmessage?.({ data: frame.buffer }), part * gap);
                }
            } });
        setTimeout(()=>socket.onopen?.({}), 0);
        return socket;
    };
}

/** @param {any} connection */
const askInfo = connection=>connection.requestAll(EMsg.ClientPICSProductInfoRequest,
    PICSProductInfoRequest, { apps: [] },
    (/** @type {any} */ message)=>!decode(PICSProductInfoResponse, message.body).response_pending);

test('an answer in parts, slower in all than the wait, is taken whole', async()=>{
    const connection = await connectCm({ endpoint: 'cm.example:443', timeout: 120,
        socket: serverAnswering({ parts: 5, gap: 80 }) });
    try
    {
        const answers = await askInfo(connection);
        assert.equal(answers.length, 5, 'all of it, 400 ms where the wait is 120');
    }
    finally
    {
        connection.close();
    }
});

test('an answer that does not come is still given up after the wait', async()=>{
    const connection = await connectCm({ endpoint: 'cm.example:443', timeout: 60,
        socket: serverAnswering({ parts: 0, gap: 0 }) });
    try
    {
        await assert.rejects(askInfo(connection), /no answer to message 8903 in 60 ms/);
    }
    finally
    {
        connection.close();
    }
});
