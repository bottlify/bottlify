/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A census of the large buffers every worker of a page makes: each
 * ArrayBuffer, SharedArrayBuffer, typed array and WebAssembly.Memory of a
 * mebibyte or more (a memory's grows counted on the memory), by where it was
 * made, live bytes being those made and not yet collected. What a browser's
 * memory dump shows only as one sum (Chrome's `partition_alloc/array_buffer`)
 * is named here by the code that asked for it.
 *
 * Each worker is caught at its first instruction (`waitForDebuggerOnStart`)
 * and given the census before its own code runs; `read` asks every worker
 * still alive for its rows.
 */

/** The census as it runs inside a worker: plain script, no imports. */
const CENSUS_SOURCE = `(()=>{
    if (self.__census) return;
    const MIN = 1 << 20;
    const live = new Map();
    const site = ()=>(new Error().stack || '').split('\\n').slice(3, 10)
        .map(line=>line.trim().replace(/^at /, '').replace(/https?:\\/\\/[^/]+\\//, ''))
        .filter(line=>!line.includes('__census')).slice(0, 4).join(' < ');
    const gone = new FinalizationRegistry(({ key, bytes })=>{
        const row = live.get(key);
        if (row) { row.bytes -= bytes; row.count--; }
    });
    const note = (object, bytes, key = site())=>{
        if (!(bytes >= MIN)) return key;
        const row = live.get(key) || { bytes: 0, count: 0, made: 0 };
        row.bytes += bytes; row.count++; row.made += bytes;
        live.set(key, row);
        gone.register(object, { key, bytes });
        return key;
    };
    const wrap = (Base, sizeOf)=>{
        const Wrapped = new Proxy(Base, { construct(target, args, newTarget){
            const made = Reflect.construct(target, args,
                newTarget === Wrapped ? target : newTarget);
            note(made, sizeOf(args, made));
            return made;
        } });
        return Wrapped;
    };
    self.ArrayBuffer = wrap(ArrayBuffer, args=>Number(args[0]));
    if (typeof SharedArrayBuffer === 'function')
        self.SharedArrayBuffer = wrap(SharedArrayBuffer, args=>Number(args[0]));
    for (const name of ['Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array',
        'Int32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
        'Uint8ClampedArray'])
        self[name] = wrap(self[name],
            (args, made)=>(typeof args[0] === 'number' ? made.byteLength : 0));
    const Memory = WebAssembly.Memory;
    const memorySites = new WeakMap();
    WebAssembly.Memory = new Proxy(Memory, { construct(target, args, newTarget){
        const made = Reflect.construct(target, args, newTarget);
        const key = site();
        memorySites.set(made, key);
        const bytes = (args[0] && args[0].initial || 0) * 65536;
        const row = live.get(key) || { bytes: 0, count: 0, made: 0 };
        row.bytes += bytes; row.count++; row.made += bytes;
        live.set(key, row);
        gone.register(made, { key, bytes: 0 });
        return made;
    } });
    const grow = Memory.prototype.grow;
    Memory.prototype.grow = function(pages){
        const key = memorySites.get(this);
        const row = key && live.get(key);
        if (row) { row.bytes += pages * 65536; row.made += pages * 65536; }
        return grow.call(this, pages);
    };
    self.__census = ()=>JSON.stringify([...live].filter(([, row])=>row.bytes > 0)
        .map(([key, row])=>({ bytes: row.bytes, count: row.count, made: row.made, site: key })));
})();`;

/**
 * Gives every worker the page makes from now on the census, at its first
 * instruction.
 *
 * @param {import('./cdp.mjs').CdpEndpoint} cdp
 * @param {string} pageSessionId
 */
export async function censusWorkers(cdp, pageSessionId){
    /** @type {Map<string, string>} */
    const sessions = new Map();
    const attach = (/** @type {string} */ sessionId)=>cdp.send('Target.setAutoAttach',
        { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
    cdp.on('Target.attachedToTarget', async params=>{
        const info = params.targetInfo ?? {};
        const worker = params.sessionId;
        if (info.type !== 'worker' || typeof worker !== 'string')
        {
            return;
        }
        sessions.set(worker, String(info.url ?? '').replace(/^https?:\/\/[^/]+\//, ''));
        try
        {
            await attach(worker);
            await cdp.send('Runtime.evaluate', { expression: CENSUS_SOURCE }, worker);
        }
        catch {
            // A worker gone between the two: nothing to count.
        }
        finally
        {
            await cdp.send('Runtime.runIfWaitingForDebugger', {}, worker).catch(()=>{});
        }
    });
    cdp.on('Target.detachedFromTarget', params=>{
        sessions.delete(String(params.sessionId));
    });
    for (let attempt = 0; ; attempt++)
    {
        try
        {
            await attach(pageSessionId);
            break;
        }
        catch (e){
            if (attempt >= 20)
            {
                throw e;
            }
            await new Promise(done=>setTimeout(done, 250));
        }
    }
    return {
        /**
         * Every live worker's rows, the largest first, each with the worker's
         * script; a worker that does not answer is named in `silent`.
         *
         * @returns {Promise<{ rows: { worker: string, bytes: number, count: number,
         *     made: number, site: string }[], silent: string[] }>}
         */
        async read(){
            const rows = [];
            const silent = [];
            for (const [session, url] of sessions)
            {
                const answer = await cdp.send('Runtime.evaluate', {
                    expression: 'self.__census ? self.__census() : null', returnByValue: true,
                }, session).catch(()=>null);
                const value = answer?.result?.value;
                if (typeof value !== 'string')
                {
                    silent.push(url);
                    continue;
                }
                for (const row of JSON.parse(value))
                {
                    rows.push({ worker: url, ...row });
                }
            }
            rows.sort((a, b)=>b.bytes - a.bytes);
            return { rows, silent };
        },
    };
}
