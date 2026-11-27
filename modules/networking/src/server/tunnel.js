/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A relay's real connections made through an HTTP proxy.
 *
 * A relay run where the only way out is a proxy (a corporate network, a
 * sandbox) cannot open a socket to the far host itself. HTTP's CONNECT asks
 * the proxy to open it instead and then carries the bytes both ways, so a
 * connection made that way is, once the proxy said yes, the same stream the
 * guest would have had. The proxy judges and resolves the name itself; it is
 * handed the name the guest resolved where the relay remembers one, since a
 * proxy that allows hosts by name cannot see a name behind an address.
 */

import { Duplex } from 'node:stream';
import { Socket } from 'node:net';

/** The most a proxy's answer to CONNECT may take before its blank line. */
const HEAD_LIMIT = 16 * 1024;

/**
 * The error a refused CONNECT is, coded as the socket error the relay maps to
 * a Winsock one: a gateway timeout a timeout, every other refusal a refused
 * connection.
 *
 * @param {number} status @param {string} line
 */
function refusal(status, line){
    const error = /** @type {Error & { code?: string, status?: number }} */ (
        new Error(`the proxy refused the connection: ${line}`));
    error.code = status === 504 ? 'ETIMEDOUT' : 'ECONNREFUSED';
    error.status = status;
    return error;
}

/**
 * A connection to `host`:`port` through the HTTP proxy at `proxy`.
 *
 * It behaves as a `net.Socket` does where the relay looks: 'connect' once
 * the proxy answered 200, then 'data', 'end', 'error' and 'close', with
 * `write`, `end`, `destroy`, `pause`, `resume`, `setNoDelay` and `address`.
 * Bytes written before the tunnel stands wait for it. User and password in
 * the proxy's URL go as Basic proxy authorization.
 *
 * @param {{ proxy: string | URL, host: string, port: number }} target
 */
export function connectThrough({ proxy, host, port }){
    const url = new URL(proxy);
    if (url.protocol !== 'http:')
    {
        throw new Error(`a proxy is spoken to over http://, not ${url.protocol}`);
    }
    const raw = new Socket();
    let open = false;
    let head = Buffer.alloc(0);
    let endWhenOpen = false;
    /** @type {[Buffer, (error?: Error | null) => void][]} */
    const waiting = [];

    const tunnel = /** @type {Duplex & { setNoDelay: (on?: boolean) => any,
     *     address: () => any }} */ (new Duplex({
            allowHalfOpen: false,
            write(chunk, _encoding, callback){
                if (open)
                {
                    raw.write(chunk, callback);
                }
                else
                {
                    waiting.push([chunk, callback]);
                }
            },
            final(callback){
                if (open)
                {
                    raw.end(callback);
                }
                else
                {
                    endWhenOpen = true;
                    callback();
                }
            },
            read(){
                raw.resume();
            },
            destroy(error, callback){
                raw.destroy();
                callback(error);
            },
        }));
    tunnel.setNoDelay = (on = true)=>{
        raw.setNoDelay(on);
        return tunnel;
    };
    tunnel.address = ()=>raw.address();

    /** @param {Buffer} chunk */
    const deliver = chunk=>{
        if (!tunnel.push(chunk))
        {
            raw.pause();
        }
    };

    raw.on('connect', ()=>{
        const authority = `${host.includes(':') ? `[${host}]` : host}:${port}`;
        const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`];
        if (url.username !== '')
        {
            const user = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
            lines.push(`Proxy-Authorization: Basic ${Buffer.from(user).toString('base64')}`);
        }
        raw.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    raw.on('data', chunk=>{
        if (open)
        {
            deliver(chunk);
            return;
        }
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf('\r\n\r\n');
        if (end < 0)
        {
            if (head.length > HEAD_LIMIT)
            {
                tunnel.destroy(refusal(0, 'an answer with no end to its head'));
            }
            return;
        }
        const line = head.subarray(0, head.indexOf('\r\n')).toString('latin1');
        const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(line)?.[1] ?? 0);
        if (status < 200 || status > 299)
        {
            tunnel.destroy(refusal(status, line));
            return;
        }
        open = true;
        const rest = head.subarray(end + 4);
        head = Buffer.alloc(0);
        tunnel.emit('connect');
        for (const [bytes, callback] of waiting.splice(0))
        {
            raw.write(bytes, callback);
        }
        if (endWhenOpen)
        {
            raw.end();
        }
        if (rest.length > 0)
        {
            deliver(rest);
        }
    });
    raw.on('end', ()=>tunnel.push(null));
    raw.on('error', error=>tunnel.destroy(error));
    raw.on('close', ()=>{
        if (!tunnel.destroyed)
        {
            tunnel.destroy(open ? undefined : refusal(0, 'the proxy closed before answering'));
        }
    });
    raw.connect({ host: url.hostname, port: Number(url.port || 80) });
    return tunnel;
}

/**
 * The relay's `dial` that goes through the HTTP proxy at `proxy`, asking for
 * the name the address was resolved from where there is one.
 *
 * @param {string | URL} proxy
 * @returns {import('./relay.js').RelayDial}
 */
export const proxyDialer = proxy=>({ host, name, port })=>
    connectThrough({ proxy, host: name ?? host, port });
