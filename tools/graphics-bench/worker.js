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
 */

self.onmessage = async({ data: { scene, draws, frames, warm, root, modelOnly } })=>{
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
        const run = SCENES[scene](draws, gpu);
        /** @type {number[][]} */
        const rows = [];
        for (let frame = 0; frame < warm + frames; frame++)
        {
            marks = {};
            const start = performance.now();
            await run.frame();
            const end = performance.now();
            await device.queue.onSubmittedWorkDone();
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
