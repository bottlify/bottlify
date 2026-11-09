/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * ieframe - Internet Explorer's frame library, as a program embedding the
 * WebBrowser control reaches it: the control's two classes registered with
 * COM (`browser.js`), its three window classes, and the exports a program
 * calls by name. shdocvw.dll, where the control lived before IE 7, answers
 * the same.
 */

import { BROWSER_CLASSES, WM_BROWSER_NAVIGATED, createBrowsers } from './browser.js';
import { CLSID_WEB_BROWSER, CLSID_WEB_BROWSER_V1 } from './layout.js';

/** S_FALSE: DllCanUnloadNow's answer while the library is in use. */
const S_FALSE = 1;

/** COLOR_WINDOW + 1: the classes' background, the white a page is drawn on. */
const WINDOW_BACKGROUND = 6;

/**
 * @typedef {import('./browser.js').BrowserHost & {
 *     registry: { registerClass: (clsid: string, factory: () => any) => void } }} IeframeHost
 */

/**
 * @param {IeframeHost} host
 */
export function createIeframe(host){
    const browsers = createBrowsers(host);
    host.registry.registerClass(CLSID_WEB_BROWSER, ()=>browsers.definition(false));
    host.registry.registerClass(CLSID_WEB_BROWSER_V1, ()=>browsers.definition(true));

    /** @type {Record<string, { argBytes: number, handler: (args: number[]) => any }>} */
    const functions = {
        // The count of browser sessions IE keeps for the process, one for each
        // control with a site: the shell asks it whether a browser is still
        // open before it lets go of the library.
        SetQueryNetSessionCount: { argBytes: 4,
            handler: ([command])=>browsers.sessionCount(command >>> 0) },
        DllCanUnloadNow: { argBytes: 0, handler: ()=>S_FALSE },
    };

    /**
     * The window classes: each a plain window in the white of an empty page,
     * whose outer one finishes the navigations the control posted it.
     *
     * @param {{ defWindowProc: (record: any, message: any, thread?: unknown)
     *     => number | Promise<number> }} controlHost
     * @returns {{ name: string, procedure: any, background: number }[]}
     */
    const controls = controlHost=>BROWSER_CLASSES.map(name=>({
        name, background: WINDOW_BACKGROUND,
        /**
         * @param {any} record
         * @param {{ hwnd: number, message: number, wParam: number, lParam: number }} message
         * @param {unknown} [thread]
         */
        procedure: (record, message, thread)=>(message.message === WM_BROWSER_NAVIGATED
            ? browsers.navigated(record.hwnd, thread).then(()=>0)
            : controlHost.defWindowProc(record, message, thread)),
    }));

    return { functions, controls };
}
