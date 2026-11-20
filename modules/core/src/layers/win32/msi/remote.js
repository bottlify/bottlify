/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A library custom action of the other width, run in a custom action server:
 * a process of the library's own width (msiexec.exe -Embedding, as Windows
 * Installer starts one) that loads it and calls its entry, while the session
 * stays in the installing process.
 *
 * The two talk through the server's standard input and output - a pair of
 * anonymous pipes the installation hands it, which reach a process in a
 * worker of its own as well as one beside it. Each message is its length, four
 * bytes, and that much JSON. The installation opens with the library and the
 * entry; the server answers with each call the action makes on its session
 * (`{ call, args }`, answered `{ result }`) and ends with `{ done }`, the
 * entry's answer. What crosses is values only: a property's text, a record's
 * fields - a stream field as its bytes - and the numbers that name the views
 * the installation keeps open for the server, as Windows' remote API keeps
 * them in the service.
 */

/** How long a side waits between looks at a pipe with nothing in it, in milliseconds. */
const POLL_MS = 2;

/**
 * @typedef {Object} PipeIo  Two pipe ends, used from the host on a thread's behalf.
 * @property {(bytes: Uint8Array) => Promise<boolean>} write
 * @property {() => Promise<number>} available  bytes waiting; -1 once the other end is gone
 * @property {(count: number) => Promise<Uint8Array | null>} read
 * @property {() => Promise<void>} close
 */

/**
 * A record's fields as values that cross: a stream's bytes in place of the
 * stream, read whole.
 *
 * @param {import('./record.js').Record} record
 * @returns {Promise<any[]>}
 */
export async function fieldsOf(record){
    return Promise.all(record.fields.map(async field=>(field === null || typeof field !== 'object'
        ? field : { bytes: [...await field.stream.read(0, field.stream.size)] })));
}

/**
 * A record from fields that crossed (`fieldsOf`).
 *
 * @param {any[]} fields
 * @returns {import('./record.js').Record}
 */
export function recordFrom(fields){
    return { fields: fields.map(field=>{
        if (field === null || typeof field !== 'object')
        {
            return field;
        }
        const bytes = Uint8Array.from(field.bytes);
        return { stream: { size: bytes.length,
            read: (/** @type {number} */ at, /** @type {number} */ length)=>
                bytes.subarray(at, at + length) }, position: 0 };
    }) };
}

/**
 * Messages over two pipe ends: each its length and its JSON.
 *
 * @param {PipeIo} io
 */
export function createChannel(io){
    /** @type {Uint8Array} */
    let held = new Uint8Array(0);
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    return {
        /** @param {any} message @returns {Promise<boolean>} */
        send: async message=>{
            const body = encoder.encode(JSON.stringify(message));
            const framed = new Uint8Array(4 + body.length);
            new DataView(framed.buffer).setUint32(0, body.length, true);
            framed.set(body, 4);
            return io.write(framed);
        },
        /**
         * The next message, or null once the other side is gone.
         *
         * @returns {Promise<any>}
         */
        receive: async()=>{
            for (;;)
            {
                if (held.length >= 4)
                {
                    const length = new DataView(held.buffer, held.byteOffset).getUint32(0, true);
                    if (held.length >= 4 + length)
                    {
                        const message = JSON.parse(decoder.decode(held.subarray(4, 4 + length)));
                        held = held.slice(4 + length);
                        return message;
                    }
                }
                const waiting = await io.available();
                if (waiting < 0)
                {
                    return null;
                }
                if (waiting === 0)
                {
                    await new Promise(resolve=>setTimeout(resolve, POLL_MS));
                    continue;
                }
                const bytes = await io.read(waiting);
                if (bytes === null)
                {
                    return null;
                }
                const joined = new Uint8Array(held.length + bytes.length);
                joined.set(held);
                joined.set(bytes, held.length);
                held = joined;
            }
        },
        close: ()=>io.close(),
    };
}

/** @typedef {ReturnType<typeof createChannel>} Channel */

/**
 * The installation's side: hands the server its library and entry, answers
 * every call it makes from `calls`, and gives back the entry's answer - null
 * when the server ended without one.
 *
 * @param {Channel} channel
 * @param {{ library: string, entry: string }} start
 * @param {Record<string, (...args: any[]) => any>} calls
 * @param {(detail: string) => void} say
 * @returns {Promise<number | null>}
 */
export async function serveCustomAction(channel, start, calls, say){
    if (!await channel.send(start))
    {
        return null;
    }
    for (;;)
    {
        const message = await channel.receive();
        if (message === null)
        {
            return null;
        }
        if ('done' in message)
        {
            return message.done >>> 0;
        }
        const call = Object.hasOwn(calls, message.call) ? calls[message.call] : null;
        if (!call)
        {
            say(`a custom action server asked for ${message.call}, which is not carried`);
        }
        const result = call ? await call(...message.args) : null;
        await channel.send({ result: result ?? null });
    }
}

/**
 * The server's side of one call: asked of the installation, answered with
 * its result, or null when the installation is gone.
 *
 * @param {Channel} channel
 */
export function sessionClient(channel){
    return {
        /** @param {string} call @param {...any} args @returns {Promise<any>} */
        ask: async(call, ...args)=>{
            if (!await channel.send({ call, args }))
            {
                return null;
            }
            const reply = await channel.receive();
            return reply === null ? null : reply.result;
        },
    };
}
