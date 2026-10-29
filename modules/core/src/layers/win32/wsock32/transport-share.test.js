/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * One transport under several processes' sockets. The transport is a
 * recorder with an inbound of its own to drive; each view is what one
 * process's registry is handed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shareTransport } from './transport.js';

/** A transport that records what it is asked and can be answered through `inbound`. */
function recorder(){
    /** @type {any} */
    const state = { inbound: null, dialled: [], sent: [], hung: [], listened: [], released: [] };
    return {
        state,
        transport: {
            attach: (/** @type {any} */ inbound)=>{
                state.inbound = inbound;
            },
            localAddress: ()=>0x0a560001,
            connect: (/** @type {number} */ id, /** @type {any} */ to)=>{
                state.dialled.push({ id, to });
                return Promise.resolve(to.port === 1
                    ? { error: 10061 } : { local: { host: 1, port: 2 } });
            },
            send: (/** @type {number} */ id, /** @type {Uint8Array} */ bytes)=>
                state.sent.push({ id, bytes: [...bytes] }),
            disconnect: (/** @type {number} */ id, /** @type {boolean} */ half)=>
                state.hung.push({ id, half }),
            listen: (/** @type {boolean} */ stream, /** @type {number} */ port)=>
                state.listened.push({ stream, port }),
            release: (/** @type {boolean} */ stream, /** @type {number} */ port)=>
                state.released.push({ stream, port }),
            resolve: async(/** @type {string} */ name)=>(name === 'a.test' ? [5] : []),
        },
    };
}

/** An inbound that records what reached it. */
function listener(){
    /** @type {any[]} */
    const seen = [];
    return {
        seen,
        inbound: {
            accepted: (/** @type {any[]} */ ...args)=>seen.push(['accepted', ...args]),
            received: (/** @type {number} */ id, /** @type {Uint8Array} */ bytes)=>
                seen.push(['received', id, [...bytes]]),
            disconnected: (/** @type {any[]} */ ...args)=>seen.push(['disconnected', ...args]),
            datagram: (/** @type {number} */ port, /** @type {any} */ from, /** @type {Uint8Array} */ bytes)=>
                seen.push(['datagram', port, [...bytes]]),
            lost: (/** @type {number} */ error)=>seen.push(['lost', error]),
        },
    };
}

test('two processes\' first streams are two streams, and each one\'s bytes come back to it',
    async()=>{
        const { state, transport } = recorder();
        const share = shareTransport(transport);
        const first = share.view();
        const second = share.view();
        const one = listener();
        const two = listener();
        first.attach?.(one.inbound);
        // The process that loads Winsock last does not take the others' bytes.
        second.attach?.(two.inbound);

        await first.connect?.(1, { host: 9, port: 443 });
        await second.connect?.(1, { host: 9, port: 443 });
        const [a, b] = state.dialled.map((/** @type {any} */ dial)=>dial.id);
        assert.notEqual(a, b, 'the transport sees two ids');
        first.send?.(1, Uint8Array.of(1));
        second.send?.(1, Uint8Array.of(2));
        assert.deepEqual(state.sent, [{ id: a, bytes: [1] }, { id: b, bytes: [2] }]);

        state.inbound.received(a, Uint8Array.of(7));
        state.inbound.received(b, Uint8Array.of(8));
        assert.deepEqual(one.seen, [['received', 1, [7]]]);
        assert.deepEqual(two.seen, [['received', 1, [8]]]);

        // A half close keeps the stream; the end forgets it.
        state.inbound.disconnected(a);
        state.inbound.received(a, Uint8Array.of(9));
        state.inbound.disconnected(a, 0);
        state.inbound.received(a, Uint8Array.of(10));
        assert.deepEqual(one.seen.slice(1), [['disconnected', 1], ['received', 1, [9]],
            ['disconnected', 1, 0]]);
        second.disconnect?.(1, false);
        assert.deepEqual(state.hung, [{ id: b, half: false }]);
        second.send?.(1, Uint8Array.of(3));
        assert.equal(state.sent.length, 2, 'a stream let go sends nothing');
    });

test('a refused dial is forgotten; accepted streams and datagrams go to the listener', async()=>{
    const { state, transport } = recorder();
    const share = shareTransport(transport);
    const first = share.view();
    const second = share.view();
    const one = listener();
    const two = listener();
    first.attach?.(one.inbound);
    second.attach?.(two.inbound);

    assert.deepEqual(await first.connect?.(4, { host: 9, port: 1 }), { error: 10061 });
    first.send?.(4, Uint8Array.of(1));
    assert.equal(state.sent.length, 0);

    second.listen?.(true, 6112);
    first.listen?.(false, 6112);
    assert.deepEqual(state.listened, [{ stream: true, port: 6112 }, { stream: false, port: 6112 }]);
    state.inbound.accepted(6112, 0x80000001, { host: 3, port: 4 });
    state.inbound.received(0x80000001, Uint8Array.of(5));
    state.inbound.datagram(6112, { host: 3, port: 4 }, Uint8Array.of(6));
    assert.deepEqual(two.seen, [['accepted', 6112, 0x80000001, { host: 3, port: 4 }],
        ['received', 0x80000001, [5]]]);
    assert.deepEqual(one.seen, [['datagram', 6112, [6]]]);
    second.send?.(0x80000001, Uint8Array.of(7));
    assert.deepEqual(state.sent, [{ id: 0x80000001, bytes: [7] }]);

    first.release?.(true, 6112);
    assert.deepEqual(state.released, [], 'a port another process listens on stays');
    second.release?.(true, 6112);
    assert.deepEqual(state.released, [{ stream: true, port: 6112 }]);
    state.inbound.accepted(6112, 0x80000002, { host: 3, port: 4 });
    assert.deepEqual(state.hung, [{ id: 0x80000002, half: false }], 'nobody listening: hung up');

    state.inbound.lost(10050);
    assert.deepEqual([one.seen.at(-1), two.seen.at(-1)], [['lost', 10050], ['lost', 10050]]);
    assert.deepEqual(await first.resolve?.('a.test'), [5]);
    assert.equal(first.localAddress?.(), 0x0a560001);
});
