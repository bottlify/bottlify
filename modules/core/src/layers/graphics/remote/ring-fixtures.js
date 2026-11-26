/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A recording carried to its played twin through a root's two rings
 * (`ring.js`), both ends in one thread and driven by the test rather than by
 * their bells: every batch the sender publishes is played, and every answer
 * read back, before the call that sent it returns -- or, `held`, the batches
 * played only when the test pumps. What
 * crosses is what crosses to the graphics worker; only when is the test's.
 * Tests only.
 */

import { createReceiver, createSender } from './channel.js';
import { CALLS_BYTES, REPLIES_BYTES, createRingMemory } from './ring.js';

/**
 * @param {Parameters<typeof createReceiver>[0]['played']} played
 * @param {Omit<Parameters<typeof createSender>[0], 'rings' | 'serve'> & {
 *     calls?: number, replies?: number,
 *     receiver?: Omit<Parameters<typeof createReceiver>[0], 'played' | 'rings' | 'serve'>,
 *     held?: boolean, served?: boolean }} [options]
 *     the rings' sizes, the receiver's own options, `held`: nothing played until
 *     `pump` is called, and `served`: what is said back read as its bell rings,
 *     an answer the played device settles later too, until `close`
 */
export function carriedTo(played, options = {}){
    const { calls = CALLS_BYTES, replies = REPLIES_BYTES, receiver: receiverOptions = {},
        held = false, served = false, ...senderOptions } = options;
    const rings = { calls: createRingMemory(calls), replies: createRingMemory(replies) };
    const receiver = createReceiver({ played, rings, serve: false, ...receiverOptions });
    /** Plays what was sent and reads what was said back, until neither side has more. */
    const pump = ()=>{
        for (;;)
        {
            const moved = receiver.take() + sender.take();
            if (moved === 0)
            {
                return;
            }
        }
    };
    const after = held ? ()=>{} : pump;
    const sender = createSender({ rings, serve: served,
        later: send=>{
            send();
            after();
        },
        ...senderOptions });
    /** The sender as a recording writes to it, each send played at once unless held. */
    const transport = Object.create(sender, {
        called: { value: (/** @type {number} */ wait, /** @type {string} */ name)=>{
            const answer = sender.called(wait, name);
            after();
            return answer;
        } },
        recorded: { value: ()=>{
            sender.recorded();
            after();
        } },
        flush: { value: ()=>{
            sender.flush();
            after();
        } },
    });
    return {
        /** @type {ReturnType<typeof createSender>} */
        sender: transport,
        receiver,
        pump,
        close(){
            sender.close();
            receiver.close();
        },
    };
}
