/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * COM between processes in workers of their own: the
 * run's class table (`ole32/remote.js`'s `createClassTable`, the service
 * control manager's) stays with the system, and a process across a link is
 * handed one of the same shape that asks it.
 *
 * The table already speaks in values. An endpoint is a number, a
 * registration names its class, its endpoint and its object by number, and
 * what one process sends another is a message of numbers, strings and bytes
 * the marshaler made (`oleaut32/marshal.js`). So a process's endpoint is
 * stood for on the system's side by one whose `deliver` asks the process
 * across its link, and a process asks the system for the endpoints of every
 * other: a call from one worker to a server in another goes through the
 * system's thread and back out, answered when the server answers. Each of
 * those is a call that does not block -- the caller's threads park as they do
 * for the network, and its link is looked at meanwhile -- so a call the server
 * makes back into its client while the client waits (a callback, COM's modal
 * loop) reaches the client the same way.
 *
 * A server a process asks to start is started by the run in a worker of its
 * own while the run has room, and otherwise beside the process that asked, in
 * its worker, as before.
 */

const RPC_E_DISCONNECTED = 0x80010108 | 0;

/** What a call to an endpoint that is gone answers. */
const GONE = Object.freeze({ hr: RPC_E_DISCONNECTED, disconnected: true });

/**
 * The link's handlers that answer for the run's class table, for one process
 * across the link.
 *
 * @param {ReturnType<typeof import('./layers/win32/ole32/remote.js').createClassTable>} table
 * @param {Object} side
 * @param {(method: string, args: any[]) => Promise<any>} side.call
 *     a call to the process, which does not block
 * @param {((request: { command: string, clsid: string }) =>
 *     { exited: Promise<unknown> } | null) | null} [side.launch]
 *     starts a server the process asked for in a worker of its own, or says
 *     there is no room
 */
export function comHandlers(table, side){
    /** The process's endpoints here, each with the key the table knows it by. @type {Map<number, object>} */
    const mine = new Map();
    /** Servers started for the process, by the number it waits on them by. @type {Map<number, Promise<unknown>>} */
    const launched = new Map();
    let nextLaunch = 1;

    /** @param {number} id */
    const end = async id=>{
        const key = mine.get(id);
        mine.delete(id);
        if (key)
        {
            await table.ended(key);
        }
    };

    return {
        handlers: {
            /** A process's endpoint, stood for here: what it exports is delivered to it. */
            attach(){
                // One process may hold several endpoints, each ended on its own.
                const key = {};
                /** @type {import('./layers/win32/ole32/remote.js').Endpoint} */
                const endpoint = {
                    process: key,
                    alive: true,
                    deliver: message=>side.call('deliver', [id, message]),
                    // What its proxies held it gave back itself, as it ended.
                    rundown: async()=>{},
                };
                const id = table.attach(endpoint);
                mine.set(id, key);
                return id;
            },
            /** @param {number} id */
            alive: id=>table.endpoint(id)?.alive === true,
            /** @param {number} id @param {any} message */
            deliver(id, message){
                const endpoint = table.endpoint(id);
                return endpoint?.alive ? endpoint.deliver(message) : GONE;
            },
            /** @param {any} entry */
            register: entry=>table.register(entry),
            /** @param {number} endpoint @param {number} cookie */
            revoke: (endpoint, cookie)=>table.revoke(endpoint, cookie),
            /** @param {number} endpoint */
            resume: endpoint=>table.resume(endpoint),
            /** @param {number} endpoint */
            suspend: endpoint=>table.suspend(endpoint),
            // The running object table, the run's: entries are values.
            /** @param {any} entry */
            rotRegister: entry=>table.rotRegister(entry),
            /** @param {number} cookie */
            rotRevoke: cookie=>table.rotRevoke(cookie),
            /** @param {string} key */
            rotFind: key=>table.rotFind(key),
            /** @param {number} cookie @param {number[]} time */
            rotNoteChange: (cookie, time)=>table.rotNoteChange(cookie, time),
            rotEntries: ()=>table.rotEntries(),
            /** @param {string} clsid */
            take: clsid=>table.take(clsid),
            // The RPC endpoints processes listen on, the run's.
            /** @param {string} key @param {number} endpoint */
            rpcListen: (key, endpoint)=>table.rpcListen(key, endpoint),
            /** @param {string} key */
            rpcServer: key=>table.rpcServer(key),
            /** @param {number} endpoint @param {string} [key] */
            rpcUnlisten: (endpoint, key)=>table.rpcUnlisten(endpoint, key),
            /**
             * Starts a server, and names it by a number to wait on: 0 when the
             * run has no room for one.
             *
             * @param {{ command: string, clsid: string }} request
             */
            launch(request){
                const started = side.launch?.(request) ?? null;
                if (!started)
                {
                    return 0;
                }
                const number = nextLaunch++;
                launched.set(number, started.exited);
                started.exited.finally(()=>launched.delete(number)).catch(()=>{});
                return number;
            },
            /** @param {number} number */
            exited: number=>launched.get(number) ?? null,
            /** @param {string} clsid @param {number} number */
            whenRegistered: (clsid, number)=>table.whenRegistered(clsid,
                launched.get(number) ?? new Promise(()=>{})),
            /** @param {number[]} ids */
            ended: async ids=>{
                for (const id of ids)
                {
                    await end(id);
                }
            },
        },
        /** The process is gone: whatever of it is still in the table goes. */
        async gone(){
            for (const id of [...mine.keys()])
            {
                await end(id);
            }
        },
    };
}

/**
 * The run's class table as a process across a link sees it: the shape
 * `ole32/remote.js` takes as `host.table`.
 *
 * @param {{ ask: (method: string, args: any[]) => any,
 *     call: (method: string, args: any[]) => Promise<any>,
 *     handlers: Record<string, any> }} link
 *     `ask` blocks for `comHandlers`' answer, `call` does not; the process's
 *     own handlers are where what is delivered to it arrives
 * @param {import('./layers/win32/ole32/remote.js').ClassTableHooks} [hooks]
 *     how a server is started beside the process, for when the run has no
 *     room for one in a worker of its own
 */
export function remoteClassTable(link, hooks = {}){
    /** The endpoints of this process's own. @type {Map<number, import('./layers/win32/ole32/remote.js').Endpoint>} */
    const local = new Map();
    /** A server the run started, by the promise of its end. @type {WeakMap<Promise<unknown>, number>} */
    const started = new WeakMap();
    link.handlers.com = {
        /** @param {number} id @param {any} message */
        deliver: (id, message)=>local.get(id)?.deliver(message) ?? GONE,
    };
    return {
        hooks: {
            /**
             * @param {{ command: string, clsid: string }} request @param {unknown} process
             */
            launch(request, process){
                const number = link.ask('launch', [request]);
                if (number)
                {
                    const exited = link.call('exited', [number]);
                    started.set(exited, number);
                    return { exited };
                }
                return hooks.launch?.(request, process) ?? null;
            },
        },

        /** @param {import('./layers/win32/ole32/remote.js').Endpoint} endpoint */
        attach(endpoint){
            const id = link.ask('attach', []);
            local.set(id, endpoint);
            return id;
        },

        /** @param {number} id */
        endpoint(id){
            const own = local.get(id);
            if (own)
            {
                return own;
            }
            return {
                process: null,
                get alive(){
                    return link.ask('alive', [id]) === true;
                },
                deliver: (/** @type {any} */ message)=>link.call('deliver', [id, message]),
                rundown: async()=>{},
            };
        },

        /** @param {any} entry */
        register: entry=>link.ask('register', [entry]),
        /** @param {number} endpoint @param {number} cookie */
        revoke: (endpoint, cookie)=>link.ask('revoke', [endpoint, cookie]),
        /** @param {number} endpoint */
        resume: endpoint=>link.ask('resume', [endpoint]),
        /** @param {number} endpoint */
        suspend: endpoint=>link.ask('suspend', [endpoint]),
        /** @param {any} entry */
        rotRegister: entry=>link.ask('rotRegister', [entry]),
        /** @param {number} cookie */
        rotRevoke: cookie=>link.ask('rotRevoke', [cookie]),
        /** @param {string} key */
        rotFind: key=>link.ask('rotFind', [key]),
        /** @param {number} cookie @param {number[]} time */
        rotNoteChange: (cookie, time)=>link.ask('rotNoteChange', [cookie, time]),
        rotEntries: ()=>link.ask('rotEntries', []),
        /** @param {string} clsid */
        take: clsid=>link.ask('take', [clsid]),
        /** @param {string} key @param {number} endpoint */
        rpcListen: (key, endpoint)=>link.ask('rpcListen', [key, endpoint]),
        /** @param {string} key */
        rpcServer: key=>link.ask('rpcServer', [key]),
        /** @param {number} endpoint @param {string} [key] */
        rpcUnlisten: (endpoint, key)=>link.ask('rpcUnlisten', [endpoint, key]),

        /**
         * @param {string} clsid @param {Promise<unknown>} ended
         * @returns {Promise<boolean>}
         */
        whenRegistered(clsid, ended){
            const number = started.get(ended);
            if (number)
            {
                return link.call('whenRegistered', [clsid, number]);
            }
            // A server started beside this process: the run is told it is
            // waited on, and the wait ends with the server whichever comes first.
            return Promise.race([link.call('whenRegistered', [clsid, 0]),
                ended.then(()=>false, ()=>false)]);
        },

        /**
         * A process of this worker has ended: its endpoints are gone, and what
         * its proxies held goes back to the processes that lent it.
         *
         * @param {unknown} process
         */
        async ended(process){
            /** @type {number[]} */
            const gone = [];
            for (const [id, endpoint] of local)
            {
                if (endpoint.process !== process)
                {
                    continue;
                }
                endpoint.alive = false;
                await endpoint.rundown();
                local.delete(id);
                gone.push(id);
            }
            if (gone.length > 0)
            {
                await link.call('ended', [gone]);
            }
        },
    };
}
