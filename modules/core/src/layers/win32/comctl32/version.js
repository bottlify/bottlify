/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * CCM_SETVERSION and CCM_GETVERSION, which every common control answers
 * alike, by the library its class belongs to (`record.controlsVersion`).
 * The 5.82 library keeps the version a program sets, 0 until it sets one,
 * and refuses one past its own 5 with -1, keeping the old; Common Controls 6
 * is version 6 whatever is asked (Wine's misc test, test_CCM_SETVERSION).
 */

export const CCM_SETVERSION = 0x2007;
export const CCM_GETVERSION = 0x2008;

/** The newest version the 5.82 library takes. */
const LIBRARY_5 = 5;

/**
 * @param {{ controlsVersion?: number }} record
 * @param {{ version?: number }} held  the control's own state
 * @param {number} message @param {number} wParam
 * @returns {number}
 */
export function answerVersion(record, held, message, wParam){
    if ((record.controlsVersion ?? 5) >= 6)
    {
        return 6;
    }
    const current = held.version ?? 0;
    if (message === CCM_GETVERSION)
    {
        return current;
    }
    if ((wParam | 0) > LIBRARY_5 || (wParam | 0) < 0)
    {
        return -1;
    }
    held.version = wParam | 0;
    return current;
}
