/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Runs an installer in Node, unattended, and says what every process of it is
 * doing while it runs: each process's threads by state, what they wait on, the
 * host calls parked and for how long, the last call -- every `--every` seconds.
 * An install several processes deep that has stopped shows here which process
 * waits on which; the facade alone speaks for one of them.
 *
 *   node tools/install-watch.mjs <setup.exe> [--every 30] [--minutes 20]
 *       [--journal SECONDS] [--memory MB]
 *
 * `--journal S` prints, S seconds in, the last cross-process COM calls and
 * message waits from the call journal (every call area on).
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createApp } from '../modules/core/src/app.js';
import { prefixOptions } from '../modules/installer/src/index.js';

const argv = process.argv.slice(2);
/** @param {string} flag @param {number} fallback */
const number = (flag, fallback)=>{
    const at = argv.indexOf(flag);
    return at >= 0 ? Number(argv[at + 1]) : fallback;
};
const file = argv.find(argument=>!argument.startsWith('--') && !/^\d+$/.test(argument));
if (!file)
{
    console.log('usage: node tools/install-watch.mjs <setup.exe> [--every S] [--minutes M]'
        + ' [--journal S] [--memory MB]');
    process.exit(2);
}
const every = number('--every', 30);
const journalAt = number('--journal', 0);
const memory = number('--memory', 0);

const prefix = prefixOptions({ name: basename(file), bytes: new Uint8Array(readFileSync(file)) });
const started = Date.now();
const seconds = ()=>((Date.now() - started) / 1000).toFixed(1);
const app = await createApp({
    executable: prefix.executable,
    imagePath: prefix.imagePath,
    storage: prefix.storage,
    engine: 'cork',
    graphics: { raster: false },
    unattended: true,
    ...memory > 0 ? { memorySize: memory * 1048576 } : {},
    ...journalAt > 0 ? { log: { capacity: 100000, categories: {
        'call.cpu': 'trace', 'call.com': 'trace', 'call.gpu': 'trace', 'call.input': 'trace',
    } } } : {},
});
for (const name of ['process-create', 'process-started', 'process-resumed', 'process-server',
    'process-server-exit', 'error', 'exit', 'divergence', 'message-box'])
{
    app.on(name, (/** @type {any} */ event)=>console.log(seconds(), name,
        JSON.stringify(event, (key, value)=>(key === 'error' && value
            ? String(value.stack ?? value).slice(0, 800) : value))?.slice(0, 900)));
}

setInterval(async()=>{
    try
    {
        for (const { image, diagnostics } of await app.standing())
        {
            /** @param {string} layer */
            const metrics = layer=>diagnostics.find((/** @type {any} */ entry)=>
                entry.name === layer)?.metrics ?? {};
            const kernel = metrics('kernel');
            const bridge = metrics('bridge');
            const win32 = metrics('win32');
            console.log(seconds(), 'STATUS', image.split('\\').pop(), JSON.stringify({
                threads: kernel.byState, waiting: kernel.waiting, turns: kernel.turns,
                calls: bridge.calls, lastCall: bridge.lastCall,
                suspended: bridge.suspendedCalls, windows: win32.windows,
                procedures: win32.windowProcedures, messages: win32.messages,
            }).slice(0, 4000));
        }
    }
    catch (e){
        console.log('status failed:', e instanceof Error ? e.message : e);
    }
}, every * 1000);

if (journalAt > 0)
{
    setTimeout(()=>{
        const crossing = /OleMainThread|CoWait|MsgWait|PostMessage|PostThread|SendMessage|WaitFor/;
        const trail = app.log.recent(100000).filter((/** @type {any} */ entry)=>
            entry.category === 'call.com' || crossing.test(entry.text));
        for (const entry of trail.slice(-150))
        {
            console.log('JOURNAL', (entry.time / 1000).toFixed(2), entry.text.slice(0, 220));
        }
    }, journalAt * 1000);
}

try
{
    console.log('run ->', await app.run({ maxTurns: Number.MAX_SAFE_INTEGER,
        timeoutMs: number('--minutes', 20) * 60000 }));
}
catch (e){
    console.log('stopped:', e instanceof Error ? e.stack?.slice(0, 1500) : e);
}
console.log('seconds', seconds());
process.exit(0);
