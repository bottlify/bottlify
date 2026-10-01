/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * One scene of `tools/graphics-scenes.mjs` over the worker's own device,
 * frame after frame, as the engine's worker drives one: the medians of a
 * frame's parts, in milliseconds of this thread -- the calls before the
 * present (`record`), the present and the replay onto the device (`replay`),
 * what the frame did after (`tail`) -- and the wait for the device to finish
 * the frame's work (`gpu`), which a frame on this thread does not pay.
 *
 * `remote` records the Direct3D calls here and plays them in a worker of
 * their own (`played.js`) on its device: the replay is that worker's, and a
 * frame here is the calls and the present; `tail` is then the wait for the
 * played side to come within its bound of frames behind.
 */

self.onmessage = async({ data: { scene, draws, frames, warm, root, modelOnly, remote } })=>{
    try
    {
        const graphics = new URL(root, location.href).href;
        const { SCENES } = await import(
            `/tools/graphics-scenes.mjs?root=${encodeURIComponent(graphics)}`);
        const adapter = await navigator.gpu.requestAdapter();
        const features = ['texture-compression-bc', 'depth-clip-control']
            .filter(feature=>adapter.features.has(feature));
        const device = await adapter.requestDevice({ requiredFeatures: features });
        /** @type {Record<string, number>} */
        let marks = {};
        const gpu = {
            device,
            queue: device.queue,
            reset(){},
            modelOnly: modelOnly === true,
            mark(/** @type {string} */ name){
                marks[name] = performance.now();
            },
        };
        if (remote)
        {
            const { recordedDirect3D } = await import(`${graphics}/remote/direct3d.js`);
            const { createSender } = await import(`${graphics}/remote/channel.js`);
            const played = new Worker(new URL(`./played.js?root=${encodeURIComponent(graphics)}`,
                location.href), { type: 'module' });
            played.postMessage({ type: 'open' });
            /** @param {any} factory @param {any} services */
            const recordedRoot = (factory, services)=>{
                const { port1, port2 } = new MessageChannel();
                /** @type {Record<string, any>} */
                const options = {};
                for (const [key, value] of Object.entries(services))
                {
                    if (typeof value !== 'function' && key !== 'backend')
                    {
                        options[key] = value;
                    }
                }
                played.postMessage({ type: 'root', api: factory.name === 'createDirect3D8'
                    ? 'd3d8' : 'd3d9', options, port: port2 }, [port2]);
                const sender = createSender({
                    post: (/** @type {any} */ message, /** @type {any[]} */ transfer)=>
                        port1.postMessage(message, transfer),
                    on: { failed: (/** @type {string} */ message)=>{
                        throw new Error(`the played device stopped: ${message}`);
                    } },
                });
                port1.onmessage = event=>sender.receive(event.data);
                return recordedDirect3D(factory, services, sender);
            };
            /** @type {any} */ (gpu).root = recordedRoot;
        }
        const run = SCENES[scene](draws, gpu);
        /** @type {number[][]} */
        const rows = [];
        for (let frame = 0; frame < warm + frames; frame++)
        {
            marks = {};
            const start = performance.now();
            await run.frame();
            const end = performance.now();
            if (!remote)
            {
                await device.queue.onSubmittedWorkDone();
            }
            if (frame >= warm)
            {
                rows.push([marks.recorded - start, marks.replayed - marks.recorded,
                    end - marks.replayed, performance.now() - end]);
            }
        }
        const median = (/** @type {number} */ k)=>{
            const sorted = rows.map(row=>row[k]).sort((a, b)=>a - b);
            return sorted[sorted.length >> 1];
        };
        self.postMessage({ scene, draws, frames, adapter: adapter.info?.architecture ?? '',
            record: median(0), replay: median(1), tail: median(2), gpu: median(3) });
    }
    catch (e){
        self.postMessage({ error: String(e?.stack ?? e) });
    }
};
