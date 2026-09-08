/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The network beyond this runtime, as a contract the embedder supplies.
 *
 * The address space in loopback.js answers for what this runtime holds. Nothing
 * else is reachable without help, because a browser tab has no sockets: it can
 * open a WebSocket and nothing more. So everything past the local address space
 * is a callback the embedding application provides, and this file is the shape
 * those callbacks have.
 *
 * The split is deliberate and is what keeps the registry testable. Outbound
 * verbs are calls *into* the transport; anything arriving is a call *back* into
 * the registry through TransportInbound, which only ever appends to a socket's
 * queue and wakes it. That means a remote socket and a local one are the same
 * socket to every call above -- recv, select and FIONREAD read one queue and
 * neither knows nor cares which side filled it.
 *
 * Four properties are load-bearing:
 *
 * A stream is named by an id this runtime allocates, not by an address pair. An
 * address pair is not unique -- two connections to the same peer and port exist
 * at once -- and keying on one delivers a peer's bytes to the wrong socket.
 *
 * Bytes handed to the transport are the transport's own copy. The guest owns the
 * buffer it passed and may overwrite it the moment the call returns, so a
 * transport that queues the array it was given sends whatever is there later.
 * The registry copies before calling; a transport must not undo that by keeping
 * a view onto a frame it will reuse.
 *
 * A refusal has to arrive as a refusal. A dial that fails must settle its
 * promise with an error rather than never settling, and the error is recorded on
 * the socket as well as returned, because a non-blocking connect reads it from
 * getsockopt(SO_ERROR) and never sees the return value.
 *
 * Losing the connection to the network is not silence. Every stream that was
 * open has to be told, or a guest thread parked in recv waits for the rest of
 * the run for bytes that cannot come.
 */

import { INADDR_LOOPBACK, WSAENETDOWN, WSAENETUNREACH } from './constants.js';
import { createLoopbackAdapter } from './loopback.js';

/**
 * @typedef {import('./sockaddr.js').Address} Address
 */

/**
 * What a transport calls when something arrives. Supplied by the registry.
 *
 * @typedef {Object} TransportInbound
 * @property {(port: number, streamId: number, remote: Address) => void} accepted
 *      A peer opened a stream to a port this runtime is listening on.
 * @property {(streamId: number, bytes: Uint8Array) => void} received
 * @property {(streamId: number, error?: number) => void} disconnected
 * @property {(port: number, from: Address, bytes: Uint8Array) => void} datagram
 * @property {(error: number) => void} lost
 *      The network itself went away. Every open stream is finished with this.
 */

/**
 * @typedef {Object} StreamOpened
 * @property {Address} [local]  What this end was given, for getsockname.
 * @property {number} [error]
 */

/**
 * The verbs an embedder implements. Every one is optional: what is not supplied
 * behaves as though there were no network, so a host can plug in only the part
 * it has -- datagrams for a LAN, say, without a stream relay.
 *
 * @typedef {Object} NetworkTransport
 * @property {(inbound: TransportInbound) => void} [attach]
 * @property {() => number} [localAddress]
 *      The address this runtime answers to, host order. Ports bind under it and
 *      getsockname reports it, so a guest that shows the player an address shows
 *      the one peers can actually reach.
 * @property {(streamId: number, to: Address) => Promise<StreamOpened>} [connect]
 * @property {(streamId: number, bytes: Uint8Array) => void} [send]
 * @property {(streamId: number, half: boolean) => void} [disconnect]
 *      `half` is shutdown(SD_SEND): this end sends no more, and still reads.
 * @property {(from: Address, to: Address, bytes: Uint8Array) => void} [sendTo]
 * @property {(stream: boolean, port: number) => void} [listen]
 * @property {(stream: boolean, port: number) => void} [release]
 * @property {((name: string) => Promise<number[]>) | null} [resolve]
 *      Absent means there is no resolver, which is not the same as a name that
 *      does not resolve: gethostbyname stays synchronous and answers for the
 *      names this host is, rather than suspending a thread to learn nothing.
 * @property {() => Record<string, unknown>} [diagnostics]
 */

/**
 * A transport with every verb present, so no call site has to test for one.
 *
 * @param {NetworkTransport} supplied
 * @returns {Required<Omit<NetworkTransport, 'resolve'>>
 *          & { resolve: ((name: string) => Promise<number[]>) | null }}
 */
export function asTransport(supplied){
    return {
        attach: supplied.attach ?? (()=>{}),
        localAddress: supplied.localAddress ?? (()=>INADDR_LOOPBACK),
        // Unreachable rather than refused: nothing answered because there is no
        // route to that network at all, and a caller told "refused" would retry.
        connect: supplied.connect ?? (()=>Promise.resolve({ error: WSAENETUNREACH })),
        send: supplied.send ?? (()=>{}),
        disconnect: supplied.disconnect ?? (()=>{}),
        // A datagram that goes nowhere is not an error; that is what unreliable
        // means, and it is what a send to an unbound local port already does.
        sendTo: supplied.sendTo ?? (()=>{}),
        listen: supplied.listen ?? (()=>{}),
        release: supplied.release ?? (()=>{}),
        resolve: supplied.resolve ?? null,
        diagnostics: supplied.diagnostics ?? (()=>({ transport: 'offline' })),
    };
}

/**
 * @typedef {ReturnType<typeof asTransport>} BoundTransport
 */

/**
 * What the registry was configured with, sorted into the two things it needs.
 *
 * One configuration slot carries either of two unrelated notions -- the address
 * space this runtime's sockets live in, or a transport to everything outside it
 * -- so they are told apart by shape. An address space binds; a transport
 * connects. Supplying a transport keeps the ordinary local address space, which
 * is what a guest connecting to its own loopback still has to find.
 *
 * @param {import('./loopback.js').Adapter | NetworkTransport | undefined} supplied
 * @returns {{ adapter: import('./loopback.js').Adapter, transport: BoundTransport }}
 */
export function asNetwork(supplied){
    if (supplied && 'bind' in supplied && typeof supplied.bind === 'function')
    {
        return {
            adapter: /** @type {import('./loopback.js').Adapter} */ (supplied),
            transport: asTransport({}),
        };
    }
    return {
        adapter: createLoopbackAdapter(),
        transport: asTransport(/** @type {NetworkTransport} */ (supplied ?? {})),
    };
}

/** The error a transport reports when the link it needed has gone. */
export const TRANSPORT_LOST = WSAENETDOWN;
