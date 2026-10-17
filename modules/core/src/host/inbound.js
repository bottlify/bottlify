/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What the page sends the engine, through a ring rather than the event loop:
 * the inbound channel with `concurrency` above 1.
 *
 * A message posted to a worker is delivered only when the worker returns to
 * its event loop, so a thread running a program has had to give itself away
 * every few milliseconds just to find out whether the page said anything,
 * and an idle one has had to look again on a timer. Written here, input and
 * requests are read between two guest turns where they are, and an idle
 * engine sleeps on the ring's doorbell until the page writes or its own next
 * deadline comes.
 *
 * Input and visibility go this way, the stream that arrives while a program
 * runs. Requests are still posted: one sent when no program runs -- a report
 * after it exited -- has no turn boundary to be read at, and a post wakes the
 * engine where a record would not. The engine reads the ring before each
 * posted message, so the two channels keep the page's order.
 */

import { openRing } from '../system/ring.js';
import { textOf } from '../system/codec.js';

/** The inbound ring's size: input arrives in bursts of a few hundred bytes a message. */
export const INBOUND_BYTES = 1 << 20;

const encoder = new TextEncoder();

/**
 * The page's side: input and visibility through the ring, everything else
 * posted -- in one order.
 *
 * A message the ring refuses waits, and so does anything posted after it,
 * until room appears: a post that overtook a queued record would reach the
 * engine before what the page sent first.
 *
 * @param {import('../system/ring.js').RingMemory} memory
 * @param {(retry: () => void) => void} [later]  how a full ring is looked at again
 */
export function createInboundWriter(memory, later = retry=>setTimeout(retry, 1)){
    const ring = openRing(memory);
    /** @type {(Uint8Array | (() => void))[]} */
    const queued = [];
    let retrying = false;
    const flush = ()=>{
        retrying = false;
        while (queued.length > 0)
        {
            const next = queued[0];
            if (typeof next === 'function')
            {
                next();
            }
            else if (!ring.write(next))
            {
                break;
            }
            queued.shift();
        }
        if (queued.length > 0 && !retrying)
        {
            retrying = true;
            later(flush);
        }
    };
    return {
        /**
         * @param {any} message
         * @param {() => void} post  how the message goes when it does not go through the ring
         */
        send(message, post){
            const bytes = message.type === 'input' || message.type === 'visibility'
                ? encoder.encode(JSON.stringify(message)) : null;
            queued.push(bytes && bytes.length <= ring.maxRecord ? bytes : post);
            flush();
        },
        /** Messages still waiting for room. */
        waiting: ()=>queued.length,
    };
}

/**
 * The engine's side: every message in the ring, handed on in order.
 *
 * @param {import('../system/ring.js').RingMemory} memory
 * @param {(message: any) => void} receive
 */
export function createInboundReader(memory, receive){
    const ring = openRing(memory);
    return {
        bell: ring.bell,
        /** @returns {number} how many messages there were */
        drain: ()=>ring.drain(bytes=>receive(JSON.parse(textOf(bytes)))),
    };
}
