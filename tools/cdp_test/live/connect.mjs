/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The shared headed browser a person is using (CDP on port 9333), and the
 * launcher tab in it: what every script in this folder attaches to.
 *
 * A worker is reached through the page's auto-attach, not by attaching to the
 * worker's target directly: a cross-origin-isolated page runs its workers in a
 * process of its own, and a direct attach there answers nothing.
 */
import { CdpEndpoint } from '../cdp.mjs';

export const PORT = Number(process.env.CDP_PORT ?? 9333);

/** @param {string} [match]  Text the launcher tab's URL contains. */
export async function connect(match = '5180'){
    const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    const cdp = new CdpEndpoint(version.webSocketDebuggerUrl);
    await cdp.open();
    const { targetInfos } = await cdp.send('Target.getTargets');
    const page = targetInfos.find((/** @type {any} */ t)=>t.type === 'page' && t.url.includes(match));
    if (!page)
    {
        throw new Error(`no tab whose address contains ${match}`);
    }
    const { sessionId } = await cdp.send('Target.attachToTarget',
        { targetId: page.targetId, flatten: true });
    /** @param {string} expression */
    const evaluate = async expression=>{
        const answer = await cdp.send('Runtime.evaluate',
            { expression, returnByValue: true, awaitPromise: true }, sessionId);
        if (answer.exceptionDetails)
        {
            throw new Error(answer.exceptionDetails.exception?.description
                ?? answer.exceptionDetails.text);
        }
        return answer.result?.value;
    };
    /**
     * The page's workers, each with its script URL.
     *
     * @returns {Promise<{ sessionId: string, url: string }[]>}
     */
    const workers = async()=>{
        /** @type {{ sessionId: string, url: string }[]} */
        const found = [];
        cdp.on('Target.attachedToTarget', (/** @type {any} */ params)=>{
            if (params.targetInfo?.type === 'worker')
            {
                found.push({ sessionId: params.sessionId, url: String(params.targetInfo.url) });
            }
        });
        await cdp.send('Target.setAutoAttach',
            { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
        await new Promise(resolve=>setTimeout(resolve, 1500));
        return found;
    };
    /**
     * The engine's own worker, or the first worker when none is named so. Of
     * several -- a run restarted on the page can leave the last one's alive and
     * idle -- the newest, the last the page attaches.
     */
    const engineWorker = async()=>{
        const all = await workers();
        return all.filter(worker=>/engine\.worker/.test(worker.url)).at(-1) ?? all[0] ?? null;
    };
    return { cdp, sessionId, evaluate, workers, engineWorker };
}
