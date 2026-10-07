/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Windows Installer each Windows shipped or could take, at its newest:
 * 4.5 is the last for XP and Server 2003, 5.0 came with 7.
 *
 * @param {import('../kernel32/versions.js').WindowsVersion} windows
 * @returns {[number, number, number, number]}
 */
export function installerVersion(windows){
    if (windows.major < 6)
    {
        return [4, 5, 6001, 22159];
    }
    if (windows.major === 6 && windows.minor === 0)
    {
        return [4, 5, 6002, 18005];
    }
    return [5, 0, windows.build, windows.release?.ubr ?? 0];
}
