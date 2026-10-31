/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The redistributables a Steam app declares, installed into a directory it
 * was installed in: @bottlify/core/steam's redist.js -- the one install a
 * browser runs over the bottle it writes -- over the files of a directory.
 *
 *   node tools/redist.mjs <installed directory> --script <path-in-directory>...
 *       [--machine x86|amd64]
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as redist from '../modules/core/src/steam/redist.js';

export {
    DRIVE_PATH, INSTALL_DIRECTORY, REGISTRY_PATH, applyPackage, compareVersions,
    embeddedCabinets, imageMachine, parseInstallScript, registryValue,
    unpackRedistributable, writeRegistry,
} from '../modules/core/src/steam/redist.js';

/**
 * A directory as redist.js reaches an installed app.
 *
 * @param {string} directory
 * @returns {import('../modules/core/src/steam/redist.js').AppTree}
 */
export function directoryTree(directory){
    /** @param {string} path */
    const onDisk = path=>join(directory, ...path.split('\\'));
    return {
        list: async()=>(await readdir(directory, { recursive: true, withFileTypes: true }))
            .filter(entry=>entry.isFile())
            .map(entry=>relative(directory, join(entry.parentPath, entry.name))
                .split(sep).join('\\')),
        read: async path=>new Uint8Array(await readFile(onDisk(path))),
        write: async(path, bytes)=>{
            await mkdir(dirname(onDisk(path)), { recursive: true });
            await writeFile(onDisk(path), bytes);
        },
    };
}

/**
 * redist.js's installRedistributables over a directory.
 *
 * @param {string} directory @param {string[]} scripts @param {'x86' | 'amd64'} machine
 */
export const installRedistributables = (directory, scripts, machine)=>
    redist.installRedistributables(directoryTree(directory), scripts, machine);

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
{
    const argv = process.argv.slice(2);
    const directory = argv[0];
    const scripts = argv.flatMap((arg, at)=>(argv[at - 1] === '--script' ? [arg] : []));
    const machine = argv[argv.indexOf('--machine') + 1] === 'amd64' ? 'amd64' : 'x86';
    if (!directory || scripts.length === 0)
    {
        console.error('usage: node tools/redist.mjs <directory> --script <path>...'
            + ' [--machine amd64]');
        process.exit(1);
    }
    for (const line of await installRedistributables(directory, scripts, machine))
    {
        console.log(line);
    }
}
