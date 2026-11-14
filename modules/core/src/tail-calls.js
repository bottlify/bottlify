/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a run asks of cork where the browser's wasm tail calls are not sound,
 * decided on the page from its agent string: the run (`app.js`) and the
 * translator's stand (`tools/bench/`) take the same settings from here.
 */

/**
 * HACK: a workaround for a WebKit defect, to be removed once an iOS release
 * carries the fix -- https://github.com/WebKit/WebKit/pull/76671 (WebKit bug
 * 325447): iOS 27's JavaScriptCore kills the page with a pointer-authentication
 * failure on a wasm tail call into another instance.
 *
 * Whether the page is an iPhone's WebKit: on an iPhone (iOS Safari 27.0.1,
 * 2026-10-25) the page's process died as cork's regions began to run, and
 * `tools/run/webkit-probe/tail-calls.html` found every tail call into another
 * instance fatal and every one inside an instance sound; Safari on an M4 Mac
 * runs them all. Every browser on iOS is WebKit. An iPad, not measured, keeps them.
 * The defect came with iOS 27: Safari's "Version/" is the system's (its "iPhone OS"
 * is frozen), and an earlier one keeps its tail calls; a browser that names no
 * version (Chrome's CriOS, Firefox's FxiOS) is taken for one that has the defect.
 *
 * @param {{ userAgent?: string }} [navigator]
 */
export function tailCallsFault(navigator = /** @type {any} */ (globalThis).navigator ?? {}){
    const agent = String(navigator.userAgent ?? '');
    const version = /Version\/(\d+)/.exec(agent);
    return /iPhone|iPod/.test(agent) && (version === null || Number(version[1]) >= 27);
}

/**
 * Whether the page is Safari on any machine (an iPad's among them, which names
 * itself a Mac), or any browser on a phone: Chromium says "Chrome/" beside its
 * "AppleWebKit".
 *
 * @param {{ userAgent?: string }} [navigator]
 */
export function mobileOrSafari(navigator = /** @type {any} */ (globalThis).navigator ?? {}){
    const agent = String(navigator.userAgent ?? '');
    return tailCallsFault(navigator) || /Android|Mobi/.test(agent)
        || /AppleWebKit\//.test(agent) && !/Chrome\/|Chromium\//.test(agent);
}

/**
 * HACK until iOS ships https://github.com/WebKit/WebKit/pull/76671, with
 * `withoutFaultingTailCalls`: how many of cork's calls made as wasm calls
 * (`callReturn`) may wait at once on an iPhone. Each waits as a region's frames
 * on the worker's stack, which on iOS is the system's 512 KB for a thread
 * other than the main one: the Doom 3 demo's load recursed through one region
 * 256 deep (cork's most, 9 KB of the game's own stack) and an iPhone 13 Pro
 * Max with iOS 27.0.1 ran out of it ("Maximum call stack size exceeded"),
 * three runs at one point. A deeper call goes through the runtime's loop and
 * its callers return through the entry hash.
 */
const IOS_CALL_DEPTH = 64;

/**
 * HACK until iOS ships https://github.com/WebKit/WebKit/pull/76671 (see
 * `tailCallsFault`). The run's tail calls kept inside one instance where a tail
 * call into another faults, in the interpreter tier every wasm function starts
 * in: cork's regions placed by module (`dispatch`), a
 * transfer within a module a direct tail call and one out of it entered by the
 * runtime's loop (`crossTailCalls`). With them fewer calls wait as wasm calls
 * (`IOS_CALL_DEPTH`). The caller's own settings win. Decided on the page and
 * carried to every worker in the options.
 *
 * @template {Record<string, any>} T
 * @param {T} options
 * @param {boolean} [fault]
 * @returns {T & { cork?: any }}
 */
export function withoutFaultingTailCalls(options, fault = tailCallsFault()){
    return fault ? { ...options,
        cork: { ...options.cork,
            config: { crossTailCalls: false, dispatch: true, callDepth: IOS_CALL_DEPTH,
                ...options.cork?.config } } } : options;
}
