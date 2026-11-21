/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A V8 CPU profile of the Node thread a tool runs the engine on, over a
 * window of the run: where host and translated code spend a phase that the
 * engine's own counters only total (a slice of guest time that runs few
 * instructions, a host call that waits on nothing).
 */

import { writeFileSync } from 'node:fs';

/**
 * A CPU profile of this thread from `from` seconds on for `for` seconds (to the
 * run's end when not given), written to the file when it stops.
 *
 * @param {string} spec  FILE[:FROM[:FOR]]
 */
export async function cpuProfiler(spec){
    const [file, from = '0', length = ''] = spec.split(':');
    const { Session } = await import('node:inspector');
    const session = new Session();
    session.connect();
    /** @param {string} method @param {object} [params] @returns {Promise<any>} */
    const post = (method, params = {})=>new Promise((resolve, reject)=>
        session.post(method, params, (error, result)=>(error ? reject(error) : resolve(result))));
    await post('Profiler.enable');
    await post('Profiler.setSamplingInterval', { interval: 1000 });
    let state = 'waiting';
    const stop = async()=>{
        if (state !== 'running')
        {
            state = 'done';
            return;
        }
        state = 'done';
        const { profile } = await post('Profiler.stop');
        writeFileSync(file, JSON.stringify(profile));
        console.log(`  cpu profile written to ${file}`);
        session.disconnect();
    };
    setTimeout(()=>{
        if (state !== 'waiting')
        {
            return;
        }
        state = 'running';
        post('Profiler.start').then(()=>{
            console.log(`  cpu profile started at ${from} s`);
            if (length !== '')
            {
                setTimeout(()=>{
                    stop();
                }, Number(length) * 1000).unref();
            }
        });
    }, Number(from) * 1000).unref();
    return { stop };
}
