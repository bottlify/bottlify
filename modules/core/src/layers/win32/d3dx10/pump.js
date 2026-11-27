/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * D3DX's thread pump, ID3DX10ThreadPump and ID3DX11ThreadPump: the work a
 * program hands it -- a data loader and a data processor (`loaders.js`, or
 * the program's own) -- is done in three stages on three kinds of thread.
 * The loader's Load runs on an IO thread; its Decompress and the processor's
 * Process on a processing thread; the processor's CreateDeviceObject on the
 * program's own thread, inside ProcessDeviceWorkItems or WaitForAllItems,
 * where the device is the program's to use. A stage that fails ends the work
 * there: its HRESULT is written where AddWorkItem was told and both objects
 * are destroyed, as at the end of work that went through.
 *
 * The contract is Wine's d3dx10 test: one IO thread, every load in turn;
 * several processing threads, so one Decompress that waits holds up no other
 * work; GetQueueStatus counts work waiting for a stage, never the work a
 * thread is in; GetWorkItemCount counts all that is not finished; a purge
 * destroys what waits and lets what runs finish its stage first.
 */

import { createComObject } from '../ole32/objects.js';
import { createDeviceCalls } from '../d3dx9/device.js';

const S_OK = 0;
const E_FAIL = 0x80004005 | 0;
const E_POINTER = 0x80004003 | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;

/** ID3DX10ThreadPump and ID3DX11ThreadPump: one interface, one IID (d3dx10core.h, d3dx11core.h). */
export const IID_ID3DX_THREAD_PUMP = '{C93FECFA-6967-478A-ABBC-402D90621FCB}';

/** A count of threads D3DX refuses to make. */
const THREADS_REFUSED = 1024;
/** The processing threads made when the program leaves the count to D3DX. */
const DEFAULT_PROCESS_THREADS = 2;

/** ID3DX10DataLoader's methods, by slot: no IUnknown before them. */
const LOADER = { Load: 0, Decompress: 1, Destroy: 2 };
/** ID3DX10DataProcessor's. */
const PROCESSOR = { Process: 0, CreateDeviceObject: 1, Destroy: 2 };

/**
 * @typedef {Object} PumpHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number) => number} [readU32]
 * @property {(address: number, value: number) => void} [writeU32]
 * @property {{ publish: (object: any, interfaceId: string) => number }} [vtables]
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => any }} [heap]
 * @property {(call: { entry: number, args: number[], thread?: any }) => Promise<number>}
 *     [callGuest]
 * @property {() => any} [currentThread]
 * @property {(name: string) => { run: (job: (thread: any) => Promise<void>) => void }}
 *     [serviceThread]  a thread of the program's that runs what it is handed, in turn
 */

/**
 * @typedef {Object} WorkItem
 * @property {number} loader
 * @property {number} processor
 * @property {number} result  where its HRESULT goes, or 0
 * @property {number} object  where its device object goes, or 0
 * @property {boolean} purged  a purge came while a thread was in it
 */

/**
 * The library's thread pumps, `${prefix}CreateThreadPump`.
 *
 * @param {PumpHost} host @param {string} prefix  D3DX10 or D3DX11
 */
export function createThreadPumps(host, prefix){
    const { u32, putU32s, method } = createDeviceCalls(host);

    /**
     * A pump with its threads.
     *
     * @param {number} ioThreads @param {number} processThreads
     */
    const make = (ioThreads, processThreads)=>{
        const serviceThread = /** @type {NonNullable<PumpHost['serviceThread']>} */ (
            host.serviceThread);
        /** Everything not finished, whatever stage it is at. @type {Set<WorkItem>} */
        const items = new Set();
        /** @type {WorkItem[]} */
        const loading = [];
        /** @type {WorkItem[]} */
        const processing = [];
        /** @type {WorkItem[]} */
        const device = [];
        /** What WaitForAllItems and a purge wait on: any work moving on. @type {(() => void)[]} */
        let waiters = [];
        const moved = ()=>{
            const woken = waiters;
            waiters = [];
            woken.forEach(wake=>wake());
        };
        const change = ()=>new Promise(resolve=>void waiters.push(()=>resolve(undefined)));

        /**
         * Work done, well or not: its HRESULT where it was asked, both its
         * objects destroyed, on the thread that ended it.
         *
         * @param {WorkItem} item @param {number} hr @param {any} thread
         */
        const finish = async(item, hr, thread)=>{
            if (item.result !== 0)
            {
                putU32s(item.result, [hr]);
            }
            await destroy(item, thread);
        };
        /** @param {WorkItem} item @param {any} thread */
        const destroy = async(item, thread)=>{
            await method(thread, item.loader, LOADER.Destroy, []);
            await method(thread, item.processor, PROCESSOR.Destroy, []);
            items.delete(item);
            moved();
        };

        /**
         * A stage's threads: each takes the stage's waiting work in turn.
         *
         * @param {string} name @param {number} count @param {WorkItem[]} queue
         * @param {(item: WorkItem, thread: any) => Promise<void>} stage
         */
        const lane = (name, count, queue, stage)=>{
            const threads = Array.from({ length: count }, ()=>({ busy: false,
                runner: serviceThread(name) }));
            const start = ()=>{
                for (const one of threads)
                {
                    if (one.busy || queue.length === 0)
                    {
                        continue;
                    }
                    const item = /** @type {WorkItem} */ (queue.shift());
                    one.busy = true;
                    one.runner.run(async thread=>{
                        try
                        {
                            await stage(item, thread);
                        }
                        finally
                        {
                            one.busy = false;
                            start();
                        }
                    });
                }
            };
            return start;
        };

        const startProcessing = lane(`${prefix} processing`, processThreads, processing,
            async(item, thread)=>{
                if (item.purged)
                {
                    await destroy(item, thread);
                    return;
                }
                const heap = /** @type {NonNullable<PumpHost['heap']>} */ (host.heap);
                const out = heap.allocate(8);
                if (out === 0)
                {
                    await finish(item, E_OUTOFMEMORY, thread);
                    return;
                }
                let hr;
                try
                {
                    putU32s(out, [0, 0]);
                    hr = await method(thread, item.loader, LOADER.Decompress, [out, out + 4]) | 0;
                    if (hr >= 0 && !item.purged)
                    {
                        hr = await method(thread, item.processor, PROCESSOR.Process,
                            [u32(out), u32(out + 4)]) | 0;
                    }
                }
                finally
                {
                    heap.free(out);
                }
                if (item.purged)
                {
                    await destroy(item, thread);
                }
                else if (hr < 0)
                {
                    await finish(item, hr, thread);
                }
                else
                {
                    device.push(item);
                    moved();
                }
            });
        const startLoading = lane(`${prefix} IO`, ioThreads, loading, async(item, thread)=>{
            if (item.purged)
            {
                await destroy(item, thread);
                return;
            }
            const hr = await method(thread, item.loader, LOADER.Load, []) | 0;
            if (item.purged)
            {
                await destroy(item, thread);
            }
            else if (hr < 0)
            {
                await finish(item, hr, thread);
            }
            else
            {
                processing.push(item);
                startProcessing();
            }
        });

        /**
         * Up to `count` works' last stage, on the calling thread: their device
         * objects made where they were asked for.
         *
         * @param {number} count @param {any} thread
         */
        const deviceWork = async(count, thread)=>{
            for (let done = 0; done < count && device.length > 0; done++)
            {
                const item = /** @type {WorkItem} */ (device.shift());
                // A work given nowhere for its object still has the processor
                // make one, somewhere it can write.
                const heap = /** @type {NonNullable<PumpHost['heap']>} */ (host.heap);
                const spare = item.object === 0 ? heap.allocate(4) : 0;
                try
                {
                    const hr = await method(thread, item.processor, PROCESSOR.CreateDeviceObject,
                        [item.object || spare]) | 0;
                    await finish(item, hr, thread);
                }
                finally
                {
                    if (spare !== 0)
                    {
                        heap.free(spare);
                    }
                }
            }
        };

        /**
         * Everything not started is destroyed here; what a thread is in
         * finishes its stage, then is destroyed there.
         *
         * @param {any} thread
         */
        const purge = async thread=>{
            for (const queue of [loading, processing, device])
            {
                for (const item of queue.splice(0))
                {
                    await destroy(item, thread);
                }
            }
            for (const item of items)
            {
                item.purged = true;
            }
            while (items.size > 0)
            {
                await change();
            }
        };

        const pump = createComObject(IID_ID3DX_THREAD_PUMP, {
            interfaces: [{ id: IID_ID3DX_THREAD_PUMP, methods: [
                /**
                 * HRESULT AddWorkItem(ID3DX10DataLoader*, ID3DX10DataProcessor*,
                 *     HRESULT *pHResult, void **ppDeviceObject)
                 */
                { name: 'AddWorkItem', argBytes: 20, invoke: (self, args)=>{
                    void self;
                    const [loader, processor, result, object] = args;
                    if ((loader >>> 0) === 0 || (processor >>> 0) === 0)
                    {
                        return E_POINTER;
                    }
                    if ((object >>> 0) !== 0)
                    {
                        putU32s(object >>> 0, [0]);
                    }
                    /** @type {WorkItem} */
                    const item = { loader: loader >>> 0, processor: processor >>> 0,
                        result: result >>> 0, object: object >>> 0, purged: false };
                    items.add(item);
                    loading.push(item);
                    startLoading();
                    return S_OK;
                } },
                /** UINT GetWorkItemCount() */
                { name: 'GetWorkItemCount', argBytes: 4, invoke: ()=>items.size },
                /** HRESULT WaitForAllItems(): the device stage done here as work reaches it. */
                { name: 'WaitForAllItems', argBytes: 4, invoke: async()=>{
                    const thread = host.currentThread?.();
                    for (;;)
                    {
                        await deviceWork(Infinity, thread);
                        if (items.size === 0)
                        {
                            return S_OK;
                        }
                        if (device.length === 0)
                        {
                            await change();
                        }
                    }
                } },
                /** HRESULT ProcessDeviceWorkItems(UINT iWorkItemCount) */
                { name: 'ProcessDeviceWorkItems', argBytes: 8, invoke: async(self, [count])=>{
                    void self;
                    await deviceWork(count >>> 0, host.currentThread?.());
                    return S_OK;
                } },
                /** HRESULT PurgeAllItems() */
                { name: 'PurgeAllItems', argBytes: 4, invoke: async()=>{
                    await purge(host.currentThread?.());
                    return S_OK;
                } },
                /** HRESULT GetQueueStatus(UINT *pIoQueue, UINT *pProcessQueue, UINT *pDeviceQueue) */
                { name: 'GetQueueStatus', argBytes: 16, invoke: (self, [io, process, made])=>{
                    void self;
                    for (const [at, count] of [[io, loading.length],
                        [process, processing.length], [made, device.length]])
                    {
                        if ((at >>> 0) !== 0)
                        {
                            putU32s(at >>> 0, [count]);
                        }
                    }
                    return S_OK;
                } },
            ] }],
            // The last Release waits for the work, as a purge does: no loader
            // or processor of the program's is left undestroyed.
            lastRelease: async()=>{
                await purge(host.currentThread?.());
            },
        });
        return host.vtables?.publish(pump, IID_ID3DX_THREAD_PUMP) ?? 0;
    };

    return {
        /**
         * HRESULT D3DX10CreateThreadPump(UINT cIoThreads, UINT cProcThreads,
         *     ID3DX10ThreadPump **ppThreadPump), and D3DX 11's
         *
         * A count of 0 is D3DX's choice: one IO thread, two processing threads.
         */
        [`${prefix}CreateThreadPump`]: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([ioThreads, processThreads, out])=>{
                if ((ioThreads >>> 0) >= THREADS_REFUSED
                    || (processThreads >>> 0) >= THREADS_REFUSED)
                {
                    return E_FAIL;
                }
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                if (!host.serviceThread || !host.callGuest || !host.heap || !host.vtables)
                {
                    return E_FAIL;
                }
                const pointer = make((ioThreads >>> 0) || 1,
                    (processThreads >>> 0) || DEFAULT_PROCESS_THREADS);
                putU32s(out >>> 0, [pointer]);
                return pointer === 0 ? E_OUTOFMEMORY : S_OK;
            },
        },
    };
}
