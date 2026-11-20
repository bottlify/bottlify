/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * WOW64's file system redirection: what a 32-bit process on a 64-bit Windows
 * reaches when it names the system folder.
 *
 * The 64-bit system folder (`System32`) holds the 64-bit libraries and
 * programs, the 32-bit ones are in `SysWOW64`; a 32-bit process naming
 * `%windir%\System32` reaches `SysWOW64`, and names the 64-bit folder as
 * `%windir%\Sysnative`. A few of System32's folders are shared by both widths
 * and not redirected: catroot, catroot2, driverstore, drivers\etc, logfiles and
 * spool ("File System Redirector", Microsoft's WOW64 documentation). A thread
 * turns redirection off and on for itself with Wow64DisableWow64FsRedirection
 * and its siblings (`system.js`).
 */

/** System32's folders both widths share, lower case. */
const SHARED = new Set(['catroot', 'catroot2', 'driverstore', 'logfiles', 'spool']);

/**
 * The view of the volume a 32-bit process on a 64-bit machine has: the
 * components a path reaches, or null when it is not redirected.
 *
 * @param {string} windows  The Windows folder, `C:\WINDOWS`.
 * @returns {(drive: string, components: string[]) => string[] | null}
 */
export function wow64View(windows){
    const [, letter = 'C', rest = ''] = /^([A-Za-z]):\\?(.*)$/.exec(windows) ?? [];
    const home = rest.split('\\').filter(Boolean).map(part=>part.toLowerCase());
    return (drive, components)=>{
        if (drive.toUpperCase() !== letter.toUpperCase()
            || components.length <= home.length
            || home.some((part, at)=>components[at].toLowerCase() !== part))
        {
            return null;
        }
        const folder = components[home.length].toLowerCase();
        const inside = components.slice(home.length + 1);
        const first = inside[0]?.toLowerCase();
        const shared = first !== undefined && (SHARED.has(first)
            || (first === 'drivers' && inside[1]?.toLowerCase() === 'etc'));
        const base = components.slice(0, home.length);
        if (folder === 'system32' && !shared)
        {
            return [...base, 'SysWOW64', ...inside];
        }
        if (folder === 'sysnative')
        {
            return [...base, 'system32', ...inside];
        }
        return null;
    };
}
