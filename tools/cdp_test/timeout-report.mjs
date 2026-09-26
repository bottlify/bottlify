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
 * @returns {Promise<string>} the reason, with what could not be kept
 */
export async function reportTimeout({ reason, save, capture, write }){
    save();
    try
    {
        write(await capture());
        return reason;
    }
    catch (e){
        return `${reason} (no screenshot: ${e instanceof Error ? e.message : String(e)})`;
    }
}
