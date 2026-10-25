/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The server half of RFC 6455, over node:http.
 *
 * Written rather than depended upon because the relay needs one direction of one
 * protocol and nothing else: accept an upgrade, read masked frames, write
 * unmasked ones, answer a ping, close cleanly. A dependency for that is a
 * dependency in the deployment, in the lockfile and in the audit surface of a
 * server whose whole job is to be reachable from the open internet.
 *
 * Four parts of the specification are where implementations go wrong, and each
 * is handled deliberately below.
 *
 * A client always masks and a server never does. Unmasking is not optional and a
 * server that skips it reads noise; masking a server frame breaks every client.
 *
 * A message may be fragmented across frames, and a fragment is not a message.
 * Continuation frames carry no opcode of their own, so the opcode of the first
 * fragment has to be remembered until the FIN arrives.
 *
 * A control frame may be interleaved between the fragments of a message. It is
 * never fragmented itself and its payload is capped at 125 bytes, which is what
 * makes that legal -- so a ping in the middle of a large send must be answered
 * without disturbing the message being assembled.
 *
 * A socket delivers bytes, not frames. Two frames arrive in one read and one
 * frame arrives over three, so everything is buffered until a whole frame is
 * present and nothing may assume a read boundary means anything.
 */

import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';

/** The constant the handshake hashes with. It is in the specification verbatim. */
const HANDSHAKE_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

/** Beyond this a message is refused rather than assembled. */
const MAX_MESSAGE = 1024 * 1024;

/**
 * What may wait to go out to a client before it is taken for one that stopped
 * reading. The relay pauses the sockets feeding a link long before this; what
 * reaches it is traffic nothing can pause, such as a peer flooding another.
 */
const MAX_BUFFERED = 16 * 1024 * 1024;

/** A control frame's payload cannot be fragmented and cannot exceed this. */
const MAX_CONTROL = 125;

const CLOSE_NORMAL = 1000;
const CLOSE_PROTOCOL_ERROR = 1002;
const CLOSE_TOO_LARGE = 1009;

/** @param {string} key */
const accept = key=>createHash('sha1').update(key + HANDSHAKE_GUID).digest('base64');

/**
 * Lays out one frame. Server frames are never masked, so there is no mask here.
 *
 * @param {number} opcode @param {Uint8Array} payload
 */
function frame(opcode, payload){
    const length = payload.length;
    const header = length < 126 ? 2 : length < 0x10000 ? 4 : 10;
    const bytes = Buffer.allocUnsafe(header + length);
    bytes[0] = 0x80 | opcode;
    if (length < 126)
    {
        bytes[1] = length;
    }
    else if (length < 0x10000)
    {
        bytes[1] = 126;
        bytes.writeUInt16BE(length, 2);
    }
    else
    {
        bytes[1] = 127;
        // The field is 64 bits; Node cannot allocate anything needing the high
        // half, so it is written as zero rather than pretending otherwise.
        bytes.writeUInt32BE(0, 2);
        bytes.writeUInt32BE(length, 6);
    }
    bytes.set(payload, header);
    return bytes;
}

/**
 * One accepted connection.
 *
 * Emits `message` with `(data, isBinary)`, `drain` when what was waiting to
 * go out has gone, and `close`. Errors on the socket are
 * a close and nothing else -- there is no recovering a WebSocket whose transport
 * has failed, and treating it as a distinct event only means two code paths for
 * one outcome.
 */
export class Connection extends EventEmitter {
    /** @param {import('node:net').Socket} socket */
    constructor(socket){
        super();
        this.id = randomUUID();
        this.socket = socket;
        this.closed = false;
        /** @type {Buffer} */
        this.buffered = Buffer.alloc(0);
        /** @type {Buffer[]} */
        this.fragments = [];
        this.fragmentOpcode = 0;
        this.fragmentLength = 0;

        socket.on('data', chunk=>this.#feed(chunk));
        socket.on('drain', ()=>this.emit('drain'));
        socket.on('error', ()=>this.#finish());
        socket.on('close', ()=>this.#finish());
    }

    /** Bytes written and not yet sent. */
    get waiting(){
        return this.socket.writableLength;
    }

    /** @param {Uint8Array} payload */
    sendBinary(payload){
        this.#write(OPCODE_BINARY, payload);
    }

    /** @param {string} text */
    sendText(text){
        this.#write(OPCODE_TEXT, Buffer.from(text, 'utf8'));
    }

    /**
     * @param {number} [code]
     * @param {string} [reason]
     */
    close(code = CLOSE_NORMAL, reason = ''){
        if (this.closed)
        {
            return;
        }
        const body = Buffer.from(reason, 'utf8').subarray(0, MAX_CONTROL - 2);
        const payload = Buffer.allocUnsafe(2 + body.length);
        payload.writeUInt16BE(code, 0);
        payload.set(body, 2);
        this.#write(OPCODE_CLOSE, payload);
        // Ended rather than destroyed: the close frame has to reach the peer,
        // and destroy() drops whatever is still in the kernel's send buffer.
        this.socket.end();
        this.#finish();
    }

    /** @param {number} opcode @param {Uint8Array} payload */
    #write(opcode, payload){
        if (this.closed || this.socket.destroyed)
        {
            return;
        }
        this.socket.write(frame(opcode, payload));
        if (this.socket.writableLength > MAX_BUFFERED)
        {
            this.socket.destroy();
        }
    }

    #finish(){
        if (this.closed)
        {
            return;
        }
        this.closed = true;
        this.emit('close');
    }

    /** @param {Buffer} chunk */
    #feed(chunk){
        this.buffered = this.buffered.length === 0
            ? chunk
            : Buffer.concat([this.buffered, chunk]);
        for (;;)
        {
            const taken = this.#takeFrame();
            if (!taken)
            {
                return;
            }
        }
    }

    /** @returns {boolean} whether a whole frame was consumed */
    #takeFrame(){
        const bytes = this.buffered;
        if (this.closed || bytes.length < 2)
        {
            return false;
        }
        const fin = (bytes[0] & 0x80) !== 0;
        const reserved = bytes[0] & 0x70;
        const opcode = bytes[0] & 0x0f;
        const masked = (bytes[1] & 0x80) !== 0;
        let length = bytes[1] & 0x7f;
        let at = 2;

        if (reserved !== 0 || !masked)
        {
            // No extension was negotiated, so a reserved bit means the peer is
            // speaking something else; an unmasked client frame is forbidden
            // outright and is the shape a proxy-poisoning attempt takes.
            this.close(CLOSE_PROTOCOL_ERROR, 'bad frame');
            return false;
        }
        if (length === 126)
        {
            if (bytes.length < at + 2)
            {
                return false;
            }
            length = bytes.readUInt16BE(at);
            at += 2;
        }
        else if (length === 127)
        {
            if (bytes.length < at + 8)
            {
                return false;
            }
            const high = bytes.readUInt32BE(at);
            length = bytes.readUInt32BE(at + 4);
            at += 8;
            if (high !== 0 || length > MAX_MESSAGE)
            {
                this.close(CLOSE_TOO_LARGE, 'frame too large');
                return false;
            }
        }
        const isControl = (opcode & 0x8) !== 0;
        if (isControl && (length > MAX_CONTROL || !fin))
        {
            this.close(CLOSE_PROTOCOL_ERROR, 'bad control frame');
            return false;
        }
        if (bytes.length < at + 4 + length)
        {
            return false;
        }

        const mask = bytes.subarray(at, at + 4);
        at += 4;
        const payload = Buffer.allocUnsafe(length);
        for (let index = 0; index < length; index++)
        {
            payload[index] = bytes[at + index] ^ mask[index & 3];
        }
        this.buffered = bytes.subarray(at + length);
        this.#dispatch(fin, opcode, payload);
        return true;
    }

    /** @param {boolean} fin @param {number} opcode @param {Buffer} payload */
    #dispatch(fin, opcode, payload){
        if (opcode === OPCODE_CLOSE)
        {
            this.close(CLOSE_NORMAL);
            return;
        }
        if (opcode === OPCODE_PING)
        {
            this.#write(OPCODE_PONG, payload);
            return;
        }
        if (opcode === OPCODE_PONG)
        {
            return;
        }

        if (opcode === OPCODE_CONTINUATION)
        {
            if (this.fragmentOpcode === 0)
            {
                this.close(CLOSE_PROTOCOL_ERROR, 'continuation without a start');
                return;
            }
        }
        else if (opcode === OPCODE_TEXT || opcode === OPCODE_BINARY)
        {
            if (this.fragmentOpcode !== 0)
            {
                this.close(CLOSE_PROTOCOL_ERROR, 'message inside a message');
                return;
            }
            this.fragmentOpcode = opcode;
        }
        else
        {
            this.close(CLOSE_PROTOCOL_ERROR, 'unknown opcode');
            return;
        }

        this.fragmentLength += payload.length;
        if (this.fragmentLength > MAX_MESSAGE)
        {
            this.close(CLOSE_TOO_LARGE, 'message too large');
            return;
        }
        this.fragments.push(payload);
        if (!fin)
        {
            return;
        }

        const whole = this.fragments.length === 1
            ? this.fragments[0]
            : Buffer.concat(this.fragments, this.fragmentLength);
        const binary = this.fragmentOpcode === OPCODE_BINARY;
        this.fragments = [];
        this.fragmentLength = 0;
        this.fragmentOpcode = 0;
        this.emit('message', binary ? new Uint8Array(whole) : whole.toString('utf8'), binary);
    }
}

/**
 * @typedef {Object} WebSocketServerOptions
 * @property {number} [port]
 * @property {string} [host]
 * @property {import('node:http').Server} [server]
 *      An existing HTTP or HTTPS server to answer upgrades on, instead of one
 *      of this file's own: a page served over TLS may only open `wss://`, and
 *      the server that already holds the certificate is the one to open it
 *      on. `listen` and `close` then leave that server to its owner.
 * @property {string} [path]
 *      With `server`, the request path this answers; any other upgrade on
 *      that server is refused here and left alone.
 * @property {(request: import('node:http').IncomingMessage) => boolean} [allow]
 *      Called before the handshake; false refuses the upgrade.
 */

/**
 * Listens, and hands each accepted connection to `onConnection`.
 *
 * @param {WebSocketServerOptions} options
 * @param {(connection: Connection, request: import('node:http').IncomingMessage) => void}
 *      onConnection
 */
export function createWebSocketServer(options, onConnection){
    const attached = options.server ?? null;
    const http = attached ?? createServer((request, response)=>{
        // A plain GET is what a health check does, and answering it is cheaper
        // than explaining to an orchestrator why the port refuses HTTP.
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('bottlify relay\n');
    });

    /** @type {Set<Connection>} */
    const live = new Set();

    // Typed as a Duplex by the event, but an upgrade only ever arrives on a real
    // TCP socket, and setNoDelay below is not on the narrower type.
    http.on('upgrade', (request, /** @type {any} */ socket)=>{
        if (options.path !== undefined
            && String(request.url ?? '').split('?')[0] !== options.path)
        {
            // Somebody else's upgrade on a shared server; not this one's to
            // refuse, unless nobody answers it at all.
            if (attached && attached.listenerCount('upgrade') > 1)
            {
                return;
            }
            socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
            return;
        }
        const key = request.headers['sec-websocket-key'];
        const version = request.headers['sec-websocket-version'];
        const wanted = String(request.headers.upgrade ?? '').toLowerCase();
        if (wanted !== 'websocket' || typeof key !== 'string' || version !== '13'
            || (options.allow && !options.allow(request)))
        {
            socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
            return;
        }
        // Nagle would hold a small frame back waiting for company, which on this
        // path is a guest thread parked for tens of milliseconds per packet.
        socket.setNoDelay(true);
        socket.write([
            'HTTP/1.1 101 Switching Protocols',
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Accept: ${accept(key)}`,
            '', '',
        ].join('\r\n'));
        const connection = new Connection(socket);
        live.add(connection);
        connection.on('close', ()=>live.delete(connection));
        onConnection(connection, request);
    });

    return {
        /** @returns {Promise<number>} the port actually listening */
        listen(){
            if (attached)
            {
                const address = attached.address();
                return Promise.resolve(
                    typeof address === 'object' && address ? address.port : 0);
            }
            return new Promise((resolve, reject)=>{
                http.once('error', reject);
                http.listen(options.port ?? 0, options.host ?? '127.0.0.1', ()=>{
                    const address = http.address();
                    resolve(typeof address === 'object' && address ? address.port : 0);
                });
            });
        },

        /**
         * Stops listening, and hangs up whoever is still connected.
         *
         * An upgraded socket is a connection that never ends by itself, so
         * http.close() alone waits for it forever -- a shutdown that hangs
         * until something kills the process.
         *
         * @returns {Promise<void>}
         */
        close(){
            for (const connection of [...live])
            {
                connection.close();
                connection.socket.destroy();
            }
            live.clear();
            if (attached)
            {
                return Promise.resolve();
            }
            return new Promise(resolve=>http.close(()=>resolve()));
        },
    };
}
