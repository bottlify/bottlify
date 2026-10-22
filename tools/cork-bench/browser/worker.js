/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

// cork-bench in a dedicated worker, as `bench.mjs` and `pair.mjs` run it in node:
// one arm's runs (a cold iteration, the warm ones, then the timed ones), or every
// arm paired in this one thread (`paired.js`).

/** @param {string} root */
const engineOf = async root=>({
    ...await import(`${root}modules/core/src/layers/cpu/internal/cork-host.js`),
    engine: await import(`${root}modules/cork/src/index.js`),
});

/** @param {string} root @param {string} name */
const imageOf = async(root, name)=>new Uint8Array(await (await fetch(
    `${root}tools/cork-bench/images/${name}.bin`)).arrayBuffer());

/** @param {any} data */
async function answer(data){
    const { hostOf, paired } = await import(
        `${data.arms?.[0].root ?? data.root}tools/cork-bench/paired.js`);
    if (data.arms !== undefined)
    {
        const arms = [];
        for (const { root, cork, executors } of data.arms)
        {
            arms.push({ ...await engineOf(root), cork, executors });
        }
        return paired(arms, await imageOf(data.arms[0].root, data.name), data);
    }
    const { root, name, warm, iters, cork, executors } = data;
    const { host, iteration } = hostOf({ ...await engineOf(root), cork, executors },
        await imageOf(root, name));
    const coldAt = performance.now();
    iteration();
    const coldMs = performance.now() - coldAt;
    for (let i = 1; i < warm; i++)
    {
        iteration();
    }
    const startedAt = performance.now();
    let retired = 0;
    for (let i = 0; i < iters; i++)
    {
        retired += iteration();
    }
    return { usPerIter: (performance.now() - startedAt) * 1000 / iters, coldMs,
        instructions: retired / iters, regions: host.cork().counters().regions,
        eax: (host.readReg32('eax') >>> 0).toString(16) };
}

self.onmessage = async({ data })=>{
    try
    {
        self.postMessage(await answer(data));
    }
    catch (e){
        self.postMessage({ error: String(/** @type {any} */ (e)?.stack ?? e) });
    }
};
