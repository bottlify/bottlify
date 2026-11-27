/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

// The reading side of `wake-latency.mjs`: when each batch arrived.
const clock = ()=>performance.timeOrigin + performance.now();
onmessage = async({ data: { mode, port, shared, count } })=>{
    const words = new Int32Array(shared, 0, 4);
    const bytes = new Uint8Array(shared, 16);
    const arrived = [];
    let sum = 0;
    if (mode === 'ring')
    {
        let seen = 0;
        while (seen < count)
        {
            const wait = Atomics.waitAsync(words, 0, seen);
            if (wait.async)
            {
                await wait.value;
            }
            const now = Atomics.load(words, 0);
            if (now !== seen)
            {
                arrived.push(clock());
                sum += bytes[0];
                seen = now;
            }
        }
    }
    else
    {
        await new Promise(done=>{
            port.onmessage = ({ data })=>{
                arrived.push(clock());
                sum += new Uint8Array(data.buffer)[0];
                if (arrived.length === count)
                {
                    done(undefined);
                }
            };
        });
    }
    postMessage({ arrived, sum });
};
