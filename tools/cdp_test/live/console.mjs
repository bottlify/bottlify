/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */
/**
 * The launcher page's console as it happens, each line stamped with its time:
 * WebGPU's validation errors among them, which the page never shows and which
 * Chrome stops printing for a device after a few hundred ("too many warnings")
 * -- read from the start of a session, not after the fact. What the console
 * already held is printed first.
 *
 *   node tools/cdp_test/live/console.mjs [> dbg/console.log]
 */
import { connect } from './connect.mjs';

const page = await connect();
/** @param {number} time @param {string} level @param {string} text */
const print = (time, level, text)=>{
    console.log(`${new Date(time).toISOString().slice(11, 23)} [${level}] ${text}`);
};
page.cdp.on('Log.entryAdded', (/** @type {any} */ { entry })=>{
    print(entry.timestamp, entry.level, entry.text);
});
page.cdp.on('Runtime.consoleAPICalled', (/** @type {any} */ call)=>{
    print(call.timestamp, call.type, call.args
        .map((/** @type {any} */ arg)=>arg.value ?? arg.description ?? '').join(' '));
});
page.cdp.on('Runtime.exceptionThrown', (/** @type {any} */ { timestamp, exceptionDetails })=>{
    print(timestamp, 'exception', exceptionDetails.exception?.description ?? exceptionDetails.text);
});
await page.cdp.send('Log.enable', {}, page.sessionId);
await page.cdp.send('Runtime.enable', {}, page.sessionId);
