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
 * @param {Readonly<Record<string, string>>} folders  The shell's folders.
 * @returns {(id: number) => string | null} null for a DIRID this machine has no directory for
 */
export function standardDirids(folders){
    const windows = folders.Windows;
    const system = folders.System;
    return id=>({
        10: windows, 11: system, 12: `${system}\\drivers`, 17: `${windows}\\inf`,
        18: `${windows}\\Help`, 20: folders.Fonts, 24: `${windows.slice(0, 2)}\\`,
        25: windows, 30: `${windows.slice(0, 2)}\\`, 50: `${windows}\\system`,
        16406: folders['Common Start Menu'], 16407: folders['Common Programs'],
        16408: folders['Common Startup'], 16409: folders['Common Desktop'],
        16419: folders['Common AppData'], 16422: folders.ProgramFiles,
        16427: folders.CommonFiles, 16430: folders['Common Documents'],
    })[id] ?? null;
}
