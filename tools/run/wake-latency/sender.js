/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

// The sending side of `wake-latency.mjs`: a batch every 8 ms, timed.
const clock = ()=>performance.timeOrigin + performance.now();
onmessage = async({ data: { mode, port, shared, count } })=>{
    const words = new Int32Array(shared, 0, 4);
    const bytes = new Uint8Array(shared, 16);
    const sendMs = [];
    const sentAt = [];
    for (let batch = 0; batch < count; batch++)
    {
        await new Promise(done=>setTimeout(done, 8));
        const payload = new Uint8Array(mode === 'post64' ? 65536 : 2048);
        payload[0] = batch;
        const began = performance.now();
        sentAt.push(clock());
        if (mode === 'ring')
        {
            bytes.set(payload.subarray(0, 2048));
            Atomics.store(words, 0, batch + 1);
            Atomics.notify(words, 0);
        }
        else
        {
            port.postMessage({ type: 'calls', buffer: payload.buffer, length: 2048 },
                [payload.buffer]);
        }
        sendMs.push(performance.now() - began);
    }
    postMessage({ sendMs, sentAt });
};
