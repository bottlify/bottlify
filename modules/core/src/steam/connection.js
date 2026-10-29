/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A connection to a Steam connection manager (CM) over WebSocket.
 *
 * Each frame is one message: its EMsg (top bit set for a protobuf message),
 * the length of its header, the header -- a CMsgProtoBufHeader carrying the
 * session, the Steam ID and the job ids that pair a request with its answer
 * -- and the body. A Multi message is several messages in one, gzipped when
 * it says how large it is unzipped. Service methods (Authentication.*, and
 * later the content system's) are messages too: a call names its method in
 * the header and the answer comes back with the call's job id as its target.
 */

import { decode, encode } from './protobuf.js';
import {
    ClientHeartBeat, ClientHello, EMsg, EResult, Multi, PROTO_MASK, PROTOCOL_VERSION,
    ProtoBufHeader, REALM_GLOBAL,
} from './messages.js';

/** @typedef {import('./protobuf.js').Schema} Schema */

/**
 * What the connection needs of a socket: a browser WebSocket has it.
 *
 * @typedef {Object} CmSocket
 * @property {string} binaryType
 * @property {(data: Uint8Array) => void} send
 * @property {() => void} close
 * @property {((event: any) => void) | null} onopen
 * @property {((event: { data: ArrayBuffer | string }) => void) | null} onmessage
 * @property {((event: any) => void) | null} onclose
 * @property {((event: any) => void) | null} onerror
 */

/**
 * A message as it arrived.
 *
 * @typedef {Object} Received
 * @property {number} emsg
 * @property {Record<string, any>} header
 * @property {Uint8Array} body
 */

/** The Steam ID a logon starts from: an individual account, not yet known. */
export const ANONYMOUS_INDIVIDUAL = 0x0110000100000000n;

/** No job: the value the header's job ids default to. */
const NO_JOB = 0xFFFFFFFFFFFFFFFFn;

/** @param {Uint8Array} bytes */
async function gunzip(bytes){
    const part = /** @type {Uint8Array<ArrayBuffer>} */ (bytes);
    const stream = new Blob([part]).stream()
        .pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Splits a frame into its message.
 *
 * @param {Uint8Array} frame
 * @returns {Received | null}  null for a message that is not a protobuf one,
 *          which no message this client reads is.
 */
export function parseFrame(frame){
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const raw = view.getUint32(0, true);
    if (!(raw & PROTO_MASK))
    {
        return null;
    }
    const length = view.getUint32(4, true);
    return {
        emsg: (raw & ~PROTO_MASK) >>> 0,
        header: decode(ProtoBufHeader, frame.subarray(8, 8 + length)),
        body: frame.subarray(8 + length),
    };
}

/**
 * Builds a frame.
 *
 * @param {number} emsg
 * @param {Record<string, any>} header
 * @param {Uint8Array} body
 */
export function buildFrame(emsg, header, body){
    const head = encode(ProtoBufHeader, header);
    const frame = new Uint8Array(8 + head.length + body.length);
    const view = new DataView(frame.buffer);
    view.setUint32(0, (emsg | PROTO_MASK) >>> 0, true);
    view.setUint32(4, head.length, true);
    frame.set(head, 8);
    frame.set(body, 8 + head.length);
    return frame;
}

/**
 * The messages a Multi carries.
 *
 * @param {Uint8Array} body
 * @returns {Promise<Uint8Array[]>}
 */
export async function unpackMulti(body){
    const multi = decode(Multi, body);
    let payload = /** @type {Uint8Array} */ (multi.message_body ?? new Uint8Array());
    if (multi.size_unzipped)
    {
        payload = await gunzip(payload);
    }
    /** @type {Uint8Array[]} */
    const frames = [];
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    for (let at = 0; at + 4 <= payload.length;)
    {
        const length = view.getUint32(at, true);
        frames.push(payload.subarray(at + 4, at + 4 + length));
        at += 4 + length;
    }
    return frames;
}

/**
 * Opens a connection and says hello.
 *
 * @param {Object} options
 * @param {string} options.endpoint  host:port, from the CM list.
 * @param {(url: string) => CmSocket} [options.socket]  How a socket is made;
 *        a browser's WebSocket unless given.
 * @param {number} [options.timeout]  Milliseconds a call waits for its answer.
 */
export function connectCm({ endpoint, socket, timeout = 30000 }){
    const url = `wss://${endpoint}/cmsocket/`;
    const ws = socket ? socket(url) : /** @type {CmSocket} */ (/** @type {unknown} */ (new WebSocket(url)));
    ws.binaryType = 'arraybuffer';

    let steamId = ANONYMOUS_INDIVIDUAL;
    let sessionId = 0;
    let nextJob = 1n;
    let closed = false;
    /** @type {ReturnType<typeof setInterval> | undefined} */
    let heartbeat;
    /**
     * Jobs waiting for answers; a job takes each answer and says whether it
     * was the last.
     *
     * @type {Map<bigint, {
     *     take: (m: Received) => boolean, reject: (e: Error) => void, timer: any,
     * }>}
     */
    const jobs = new Map();
    /** @type {Map<number, Set<(m: Received) => void>>} */
    const listeners = new Map();
    /** @type {Set<(reason: string) => void>} */
    const closers = new Set();
    // Messages are handled in the order they came even when a Multi has to be
    // unzipped first.
    let queue = Promise.resolve();

    /** @param {Received} message */
    const dispatch = async message=>{
        if (message.emsg === EMsg.Multi)
        {
            for (const frame of await unpackMulti(message.body))
            {
                const inner = parseFrame(frame);
                if (inner)
                {
                    await dispatch(inner);
                }
            }
            return;
        }
        const target = message.header.jobid_target;
        if (target !== undefined && target !== NO_JOB && jobs.has(target))
        {
            const job = /** @type {NonNullable<ReturnType<typeof jobs.get>>} */ (jobs.get(target));
            if (job.take(message))
            {
                jobs.delete(target);
                clearTimeout(job.timer);
            }
            return;
        }
        for (const listener of listeners.get(message.emsg) ?? [])
        {
            listener(message);
        }
    };

    /** @param {string} reason */
    const shut = reason=>{
        if (closed)
        {
            return;
        }
        closed = true;
        clearInterval(heartbeat);
        for (const job of jobs.values())
        {
            clearTimeout(job.timer);
            job.reject(new Error(`steam: the connection closed (${reason})`));
        }
        jobs.clear();
        for (const closer of closers)
        {
            closer(reason);
        }
    };

    const connection = {
        get steamId(){ return steamId; },
        get sessionId(){ return sessionId; },
        get closed(){ return closed; },

        /**
         * The session a logon answered with: every message after carries it.
         *
         * @param {bigint} id @param {number} session
         */
        setSession(id, session){
            steamId = id;
            sessionId = session;
        },

        /**
         * Sends a message.
         *
         * @param {number} emsg @param {Schema} schema @param {Record<string, any>} body
         * @param {Record<string, any>} [header]  Fields beyond the session's.
         */
        send(emsg, schema, body, header = {}){
            if (closed)
            {
                throw new Error('steam: the connection is closed');
            }
            ws.send(buildFrame(emsg, { steamid: steamId, client_sessionid: sessionId, ...header },
                encode(schema, body)));
        },

        /**
         * Sends a message as a job and waits for the answer that targets it.
         *
         * @param {number} emsg @param {Schema} schema @param {Record<string, any>} body
         * @param {Record<string, any>} [header]
         * @returns {Promise<Received>}
         */
        async request(emsg, schema, body, header = {}){
            const [answer] = await connection.requestAll(emsg, schema, body, ()=>true, header);
            return answer;
        },

        /**
         * Sends a message as a job and gathers its answers -- a large answer
         * comes in parts -- until one is the last.
         *
         * @param {number} emsg @param {Schema} schema @param {Record<string, any>} body
         * @param {(m: Received) => boolean} isLast
         * @param {Record<string, any>} [header]
         * @returns {Promise<Received[]>}
         */
        requestAll(emsg, schema, body, isLast, header = {}){
            const job = nextJob++;
            return new Promise((resolve, reject)=>{
                /** @type {Received[]} */
                const answers = [];
                const timer = setTimeout(()=>{
                    jobs.delete(job);
                    reject(new Error(`steam: no answer to message ${emsg} in ${timeout} ms`));
                }, timeout);
                jobs.set(job, {
                    take: message=>{
                        answers.push(message);
                        const last = isLast(message);
                        if (last)
                        {
                            resolve(answers);
                        }
                        return last;
                    },
                    reject,
                    timer,
                });
                try
                {
                    connection.send(emsg, schema, body, { ...header, jobid_source: job });
                }
                catch (e){
                    jobs.delete(job);
                    clearTimeout(timer);
                    reject(e);
                }
            });
        },

        /**
         * Calls a unified service method, as "Service.Method#1".
         *
         * @param {string} method
         * @param {Schema} requestSchema @param {Record<string, any>} request
         * @param {Schema} responseSchema
         * @param {{ authed?: boolean }} [options]  A method called before a
         *        logon goes as a non-authenticated call: from no one (Steam ID
         *        and session zero) in the global realm. Sent from the account
         *        a logon would start with, the Authentication service took an
         *        approved sign-in's poll for another session and answered
         *        FileNotFound.
         * @returns {Promise<{ eresult: number, body: Record<string, any>, message?: string }>}
         */
        async call(method, requestSchema, request, responseSchema, { authed = false } = {}){
            const answer = await connection.request(
                authed ? EMsg.ServiceMethodCallFromClient
                    : EMsg.ServiceMethodCallFromClientNonAuthed,
                requestSchema, request, authed ? { target_job_name: method } : {
                    target_job_name: method, steamid: 0n, client_sessionid: 0, realm: REALM_GLOBAL,
                });
            const eresult = answer.header.eresult ?? EResult.Fail;
            return {
                eresult,
                body: decode(responseSchema, answer.body),
                message: answer.header.error_message,
            };
        },

        /**
         * Calls a handler for every message of a kind.
         *
         * @param {number} emsg @param {(m: Received) => void} handler
         * @returns {() => void}  Stops it.
         */
        on(emsg, handler){
            let set = listeners.get(emsg);
            if (!set)
            {
                set = new Set();
                listeners.set(emsg, set);
            }
            set.add(handler);
            return ()=>set.delete(handler);
        },

        /**
         * The next message of a kind.
         *
         * @param {number} emsg
         * @returns {Promise<Received>}
         */
        next(emsg){
            return new Promise((resolve, reject)=>{
                const stopClose = connection.onClose(reason=>{
                    stop();
                    reject(new Error(`steam: the connection closed (${reason})`));
                });
                const stop = connection.on(emsg, message=>{
                    stop();
                    stopClose();
                    resolve(message);
                });
            });
        },

        /** @param {(reason: string) => void} handler */
        onClose(handler){
            closers.add(handler);
            return ()=>closers.delete(handler);
        },

        /** Keeps the session alive, as often as the logon said. @param {number} seconds */
        startHeartbeat(seconds){
            clearInterval(heartbeat);
            heartbeat = setInterval(()=>{
                if (!closed)
                {
                    connection.send(EMsg.ClientHeartBeat, ClientHeartBeat, {});
                }
            }, Math.max(5, seconds) * 1000);
        },

        close(){
            ws.close();
            shut('closed here');
        },
    };

    /** @type {Promise<typeof connection>} */
    const opened = new Promise((resolve, reject)=>{
        ws.onopen = ()=>{
            connection.send(EMsg.ClientHello, ClientHello, { protocol_version: PROTOCOL_VERSION });
            resolve(connection);
        };
        ws.onmessage = event=>{
            if (typeof event.data === 'string')
            {
                return;
            }
            const message = parseFrame(new Uint8Array(event.data));
            if (message)
            {
                queue = queue.then(()=>dispatch(message)).catch(error=>{
                    // A message that cannot be read leaves the session in a
                    // state nobody knows: it ends, saying why.
                    ws.close();
                    shut(`a message could not be read: ${error.message}`);
                });
            }
        };
        ws.onerror = ()=>{
            reject(new Error(`steam: could not connect to ${endpoint}`));
            shut('socket error');
        };
        ws.onclose = event=>{
            reject(new Error(`steam: ${endpoint} closed before it opened`));
            shut(`closed by the server${event?.code ? `, code ${event.code}` : ''}`);
        };
    });
    return opened;
}

/** @typedef {Awaited<ReturnType<typeof connectCm>>} CmConnection */
