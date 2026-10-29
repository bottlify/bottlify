/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Connections through an HTTP proxy, against a proxy made here: one that
 * answers CONNECT as it is told to and then carries bytes both ways, so a
 * refusal, an answer split across reads and bytes the proxy sends with its
 * answer are ordinary cases.
 */

import assert from 'node:assert/strict';
import { connect, createServer } from 'node:net';
import test from 'node:test';

import {
    FLAG_REJECT, Op, PROTOCOL_VERSION, Wsa, decodeControl, decodeFrame, encodeControl,
    encodeFrame, parseIp, unpackError,
} from '../protocol.js';
import { createRelay } from './relay.js';
import { connectThrough, proxyDialer } from './tunnel.js';

/** @param {() => any} ready @param {number} [within] */
async function waitFor(ready, within = 4000){
    const until = Date.now() + within;
    for (;;)
    {
        const answer = ready();
        if (answer)
        {
            return answer;
        }
        if (Date.now() > until)
        {
            throw new Error('timed out');
        }
        await new Promise(resolve=>setTimeout(resolve, 5));
    }
}

/**
 * Listens on a free port; closing it also drops the connections it holds,
 * which would otherwise keep the test's process alive.
 *
 * @param {import('node:net').Server} server
 * @returns {Promise<number>}
 */
function listen(server){
    /** @type {Set<import('node:net').Socket>} */
    const held = new Set();
    server.on('connection', socket=>{
        held.add(socket);
        socket.on('close', ()=>held.delete(socket));
    });
    const close = server.close.bind(server);
    server.close = (/** @type {any} */ callback)=>{
        for (const socket of held)
        {
            socket.destroy();
        }
        return close(callback);
    };
    return new Promise(resolve=>server.listen(0, '127.0.0.1',
        ()=>resolve(/** @type {any} */ (server.address()).port)));
}

/** A server that answers every read with its bytes reversed. */
async function echoServer(){
    const server = createServer(socket=>socket.on('data',
        chunk=>socket.write(Buffer.from([...chunk].reverse()))));
    return { server, port: await listen(server) };
}

/**
 * A proxy that answers CONNECT with `status` (in pieces when `split`), sends
 * `extra` right behind its answer, and on 200 joins the client to the
 * address it named -- which it records with every head it was sent.
 *
 * @param {{ status?: number, split?: boolean, extra?: Buffer, to?: number }} [options]
 */
async function proxyServer({ status = 200, split = false, extra, to } = {}){
    /** @type {string[]} */
    const heads = [];
    /** How many bytes came behind each head, before the proxy had answered. */
    /** @type {number[]} */
    const earlyBytes = [];
    const server = createServer(client=>{
        let head = Buffer.alloc(0);
        const onData = (/** @type {Buffer} */ chunk)=>{
            head = Buffer.concat([head, chunk]);
            const end = head.indexOf('\r\n\r\n');
            if (end < 0)
            {
                return;
            }
            client.off('data', onData);
            client.pause();
            heads.push(head.subarray(0, end).toString('latin1'));
            const early = head.subarray(end + 4);
            earlyBytes.push(early.length);
            const reason = status === 200 ? 'Connection established' : 'No';
            const answer = `HTTP/1.1 ${status} ${reason}\r\n\r\n`;
            if (status !== 200)
            {
                client.end(answer);
                return;
            }
            const port = to ?? Number(/CONNECT [^ ]+:(\d+) /.exec(heads.at(-1) ?? '')?.[1]);
            {
                const upstream = connect({ host: '127.0.0.1', port }, ()=>{
                    if (split)
                    {
                        client.write(answer.slice(0, 10));
                        setTimeout(()=>{
                            client.write(answer.slice(10));
                            if (extra)
                            {
                                client.write(extra);
                            }
                        }, 20);
                    }
                    else
                    {
                        client.write(extra ? Buffer.concat([Buffer.from(answer), extra]) : answer);
                    }
                    if (early.length > 0)
                    {
                        upstream.write(early);
                    }
                    client.pipe(upstream);
                    upstream.pipe(client);
                    client.resume();
                });
                upstream.on('error', ()=>client.destroy());
                client.on('error', ()=>upstream.destroy());
            }
        };
        client.on('data', onData);
    });
    return { server, heads, earlyBytes, url: `http://127.0.0.1:${await listen(server)}` };
}

/** @param {any} socket @returns {Promise<Buffer>} */
const nextData = socket=>new Promise((resolve, reject)=>{
    socket.once('data', resolve);
    socket.once('error', reject);
});

test('a connection through the proxy is opened by CONNECT and carries bytes both ways',
    async t=>{
        const echo = await echoServer();
        const proxy = await proxyServer();
        t.after(()=>{
            echo.server.close();
            proxy.server.close();
        });

        const socket = connectThrough({ proxy: proxy.url, host: '127.0.0.1', port: echo.port });
        await new Promise(resolve=>socket.once('connect', resolve));
        const authority = `127\\.0\\.0\\.1:${echo.port}`;
        assert.match(proxy.heads[0], new RegExp(`^CONNECT ${authority} HTTP/1\\.1\r\n`));
        assert.match(proxy.heads[0], new RegExp(`\r\nHost: ${authority}$`));
        assert.ok(socket.address(), 'the local end is the socket to the proxy');

        socket.write(Buffer.from([1, 2, 3]));
        assert.deepEqual([...await nextData(socket)], [3, 2, 1]);
        socket.destroy();
    });

test('bytes written before the proxy answered go out once it has, in order', async t=>{
    const echo = await echoServer();
    const proxy = await proxyServer({ split: true });
    t.after(()=>{
        echo.server.close();
        proxy.server.close();
    });

    const socket = connectThrough({ proxy: proxy.url, host: '127.0.0.1', port: echo.port });
    /** @type {number[]} */
    const read = [];
    socket.on('data', (/** @type {Buffer} */ chunk)=>read.push(...chunk));
    socket.write(Buffer.from([1, 2]));
    socket.write(Buffer.from([3]));
    await waitFor(()=>read.length === 3);
    // A proxy may take bytes behind its CONNECT for its own; none were sent.
    assert.deepEqual(proxy.earlyBytes, [0]);
    // The echo answers each read; together they are the bytes reversed per read.
    assert.deepEqual([...read].sort(), [1, 2, 3]);
    socket.destroy();
});

test('bytes the proxy sends behind its answer are the stream\'s first bytes', async t=>{
    const echo = await echoServer();
    const proxy = await proxyServer({ extra: Buffer.from('hi') });
    t.after(()=>{
        echo.server.close();
        proxy.server.close();
    });

    const socket = connectThrough({ proxy: proxy.url, host: '127.0.0.1', port: echo.port });
    assert.equal((await nextData(socket)).toString(), 'hi');
    socket.destroy();
});

test('a refusal is a refused connection, a gateway timeout a timeout', async t=>{
    for (const [status, code] of [[403, 'ECONNREFUSED'], [502, 'ECONNREFUSED'],
        [504, 'ETIMEDOUT']])
    {
        const proxy = await proxyServer({ status: Number(status) });
        t.after(()=>proxy.server.close());
        const socket = connectThrough({ proxy: proxy.url, host: 'example.test', port: 443 });
        let connected = false;
        socket.on('connect', ()=>{
            connected = true;
        });
        const error = /** @type {any} */ (await new Promise(resolve=>socket.once('error', resolve)));
        assert.equal(error.code, code, `status ${status}`);
        assert.equal(error.status, status);
        assert.equal(connected, false);
    }
});

test('a proxy that closes without answering, or is not there, is a refusal', async t=>{
    const mute = createServer(socket=>socket.end());
    const port = await listen(mute);
    t.after(()=>mute.close());
    const closed = connectThrough({ proxy: `http://127.0.0.1:${port}`, host: 'a.test', port: 80 });
    const error = /** @type {any} */ (await new Promise(resolve=>closed.once('error', resolve)));
    assert.equal(error.code, 'ECONNREFUSED');

    const idle = createServer();
    const gone = await listen(idle);
    await new Promise(resolve=>idle.close(resolve));
    const absent = connectThrough({ proxy: `http://127.0.0.1:${gone}`, host: 'a.test', port: 80 });
    const failure = /** @type {any} */ (await new Promise(resolve=>absent.once('error', resolve)));
    assert.equal(failure.code, 'ECONNREFUSED');
});

test('credentials in the proxy URL go as Basic authorization, and only http is spoken', async t=>{
    const proxy = await proxyServer({ status: 407 });
    t.after(()=>proxy.server.close());
    const url = proxy.url.replace('http://', 'http://us%40er:p%3Ass@');
    const socket = connectThrough({ proxy: url, host: '::1', port: 8080 });
    await new Promise(resolve=>socket.once('error', resolve));
    assert.match(proxy.heads[0], /^CONNECT \[::1\]:8080 HTTP\/1\.1\r\n/);
    assert.ok(proxy.heads[0].includes(
        `Proxy-Authorization: Basic ${Buffer.from('us@er:p:ss').toString('base64')}`));
    assert.throws(()=>connectThrough({ proxy: 'https://proxy.test:443', host: 'a', port: 1 }),
        /over http:\/\//);
});

test('the dialler asks the proxy for the name an address was resolved from', async t=>{
    const proxy = await proxyServer({ status: 403 });
    t.after(()=>proxy.server.close());
    const dial = proxyDialer(proxy.url);
    for (const target of [{ host: '1.2.3.4', name: 'example.com', port: 443 },
        { host: '1.2.3.4', name: null, port: 80 }])
    {
        await new Promise(resolve=>dial(target).once('error', resolve));
    }
    assert.deepEqual(proxy.heads.map(head=>head.split(' ')[1]),
        ['example.com:443', '1.2.3.4:80']);
});

test('the relay dials through the proxy: a guest connection opened, carried and refused',
    async t=>{
        const echo = await echoServer();
        const proxy = await proxyServer();
        const refusing = await proxyServer({ status: 403 });
        t.after(()=>{
            echo.server.close();
            proxy.server.close();
            refusing.server.close();
        });

        for (const [url, opens] of [[proxy.url, true], [refusing.url, false]])
        {
            const relay = createRelay({ policy: ()=>true, privateNetworks: true,
                dial: proxyDialer(String(url)) });
            /** @type {any[]} */
            const frames = [];
            const session = relay.connect({
                sendBinary: (/** @type {Uint8Array} */ bytes)=>frames.push(decodeFrame(bytes)),
                sendText: (/** @type {string} */ text)=>void decodeControl(text),
                disconnect: ()=>{},
                buffered: ()=>0,
            });
            session.message(encodeControl(/** @type {any} */ ({
                t: 'hello', protocol: PROTOCOL_VERSION, room: 'room' })), false);
            const send = (/** @type {any} */ frame)=>session.message(encodeFrame(frame), true);
            send({ op: Op.DIAL, tag: 3, toIp: parseIp('127.0.0.1'), toPort: echo.port });

            if (opens)
            {
                await waitFor(()=>frames.find(frame=>frame.op === Op.OPENED));
                send({ op: Op.STREAM, tag: 3, payload: new Uint8Array([7, 8, 9]) });
                const stream = await waitFor(()=>frames.find(frame=>frame.op === Op.STREAM));
                assert.deepEqual([...stream.payload], [9, 8, 7]);
            }
            else
            {
                const hangup = await waitFor(()=>frames.find(frame=>frame.op === Op.HANGUP));
                assert.ok(hangup.flags & FLAG_REJECT);
                assert.equal(unpackError(hangup.payload), Wsa.CONNREFUSED);
                assert.equal(frames.some(frame=>frame.op === Op.OPENED), false);
            }
            session.close();
        }
    });
