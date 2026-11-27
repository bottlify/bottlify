/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The directories the standard DIRIDs stand for, as an INF names them with
 * `%N%`: Windows' own directories and the shell's common folders. Shared by
 * setupapi and advpack, which read INFs the same way.
 *
 * DIRID 0 is the empty string; a standard DIRID this machine has no
 * directory for is the system directory's `unknown`, as Windows answers it.
 * A user DIRID (0x8000 and up) is the INF's own, and none until it is set.
 *
 * @param {Readonly<Record<string, string>>} folders  The shell's folders.
 * @returns {(id: number) => string | null} null for a user DIRID
 */
export function standardDirids(folders){
    const windows = folders.Windows;
    const system = folders.System;
    return id=>(id >= DIRID_USER ? null : ({
        0: '',
        10: windows, 11: system, 12: `${system}\\drivers`, 17: `${windows}\\inf`,
        18: `${windows}\\Help`, 20: folders.Fonts, 24: `${windows.slice(0, 2)}\\`,
        25: windows, 30: `${windows.slice(0, 2)}\\`, 50: `${windows}\\system`,
        16406: folders['Common Start Menu'], 16407: folders['Common Programs'],
        16408: folders['Common Startup'], 16409: folders['Common Desktop'],
        16419: folders['Common AppData'], 16422: folders.ProgramFiles,
        16427: folders.CommonFiles, 16430: folders['Common Documents'],
    })[id] ?? `${system}\\unknown`);
}

/** The first DIRID an INF's own: SetupSetDirectoryId assigns these. */
const DIRID_USER = 0x8000;
