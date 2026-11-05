/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The taskbar's list of buttons, CLSID_TaskbarList: the object a program asks
 * to add its window to the taskbar, take it off, or mark it as the one in
 * front. The shell here is Windows XP's (`DllGetVersion`), whose object answers
 * ITaskbarList and ITaskbarList2; ITaskbarList3 and 4 (progress, thumbnail
 * buttons, overlay icons) came with Windows 7's taskbar, and a query for them
 * is answered E_NOINTERFACE, as XP answers it.
 *
 * There is no taskbar: every call is taken and answered S_OK, which is what a
 * program sees on Windows -- none of the calls reports whether a button was
 * drawn. HrInit is the one a program must make first, and it succeeds.
 */

const S_OK = 0;

export const CLSID_TASKBAR_LIST = '{56FDF344-FD6D-11D0-958A-006097C9A090}';
const IID_ITASKBAR_LIST = '{56FDF342-FD6D-11D0-958A-006097C9A090}';
const IID_ITASKBAR_LIST2 = '{602D4995-B13A-429B-A66E-1935E44F4317}';

/**
 * Methods in vtable order, by the argument words each takes after `this`.
 *
 * @param {[name: string, words: number][]} slots
 * @returns {import('../ole32/objects.js').ComMethod[]}
 */
const accepting = slots=>slots.map(([name, words])=>({
    name, argBytes: 4 + words * 4, invoke: ()=>S_OK,
}));

/** ITaskbarList: HrInit, AddTab(hwnd), DeleteTab(hwnd), ActivateTab(hwnd), SetActiveAlt(hwnd). */
const TASKBAR_LIST = Object.freeze(accepting([['HrInit', 0], ['AddTab', 1], ['DeleteTab', 1],
    ['ActivateTab', 1], ['SetActiveAlt', 1]]));
/** ITaskbarList2: ITaskbarList's, then MarkFullscreenWindow(hwnd, fFullscreen). */
const TASKBAR_LIST2 = Object.freeze([...TASKBAR_LIST,
    ...accepting([['MarkFullscreenWindow', 2]])]);

/**
 * Puts the taskbar list where CoCreateInstance will find it.
 *
 * @param {import('../ole32/objects.js').ComRegistry} registry
 */
export function registerTaskbarListClass(registry){
    registry.registerClass(CLSID_TASKBAR_LIST, ()=>({
        interfaces: [
            { id: IID_ITASKBAR_LIST, methods: [...TASKBAR_LIST] },
            { id: IID_ITASKBAR_LIST2, methods: [...TASKBAR_LIST2] },
        ],
    }));
}
