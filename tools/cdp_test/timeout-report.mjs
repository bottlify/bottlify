/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a run that timed out leaves behind.
 *
 * The profiles go first because they are already in hand; the screenshot is a
 * last question to a page that has just failed to answer one, so it is asked
 * for and allowed to fail -- its failure is added to the reason, never put in
 * place of it.
 *
 * @param {Object} what
 * @param {string} what.reason  Why the run is being given up on.
 * @param {() => void} what.save  Writes the profiles collected so far.
 * @param {() => Promise<string>} what.capture  The page's screenshot, base64.
 * @param {(data: string) => void} what.write  Keeps a screenshot that came.
 * @param {() => Promise<string>} [what.stack]  Where the page's own code is
 *     running, when it holds the thread: the debugger interrupts a page that
 *     answers nothing else.
 * @returns {Promise<string>} the reason, with what could not be kept
 */
export async function reportTimeout({ reason, save, capture, write, stack }){
    save();
    if (stack)
    {
        try
        {
            reason += `\nthe page was running:\n${await stack()}`;
        }
        catch (e){
            reason += ` (no stack: ${e instanceof Error ? e.message : String(e)})`;
        }
    }
    try
    {
        write(await capture());
        return reason;
    }
    catch (e){
        return `${reason} (no screenshot: ${e instanceof Error ? e.message : String(e)})`;
    }
}

/**
 * Where a page that answers nothing is running: the debugger's pause
 * interrupts the thread even inside a loop that never yields, and the frames
 * it stops in are named, then the page is let go again.
 *
 * @param {import('./cdp.mjs').CdpEndpoint} cdp
 * @param {string} sessionId
 * @returns {Promise<string>}
 */
export async function pausedStack(cdp, sessionId){
    /** @type {(frames: any[]) => void} */
    let paused = ()=>{};
    /** @type {Promise<any[]>} */
    const frames = new Promise(settle=>{
        paused = settle;
    });
    // Enabling the debugger announces every script, which a paused frame
    // names only by id.
    /** @type {Map<string, string>} */
    const scripts = new Map();
    cdp.on('Debugger.scriptParsed', params=>scripts.set(params.scriptId, params.url));
    cdp.on('Debugger.paused', params=>paused(params.callFrames));
    await cdp.send('Debugger.enable', {}, sessionId);
    await cdp.send('Debugger.pause', {}, sessionId);
    const stack = await Promise.race([frames, new Promise((_, reject)=>
        setTimeout(()=>reject(new Error('the page did not pause')), 10000))]);
    await cdp.send('Debugger.resume', {}, sessionId).catch(()=>{});
    return stack.slice(0, 25).map(frame=>`  ${frame.functionName || '(anonymous)'} `
        + `${(scripts.get(frame.location.scriptId) ?? '').split('/').slice(-3).join('/')}:${frame.location.lineNumber + 1}`).join('\n');
}
