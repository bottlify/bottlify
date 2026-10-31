/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Fails when a game store's protocol is spoken outside GameHub.
 *
 * Speaking to a store -- its connection managers, its sign-in, its keys and
 * codes -- is GameHub's (`modules/bridge/src/stores/`): its service worker
 * keeps the accounts and the page is given finished answers
 * (roadmap/gamehub.md). Core and the launcher keep only what reads a store's
 * file formats. A store's protocol found in either -- an import of GameHub's
 * store modules, a message or a service of Steam's by name, a CM socket, an
 * op of a store's protocol asked of GameHub -- is a step back to the design
 * that put the session in the page, and fails this check. Comments are not
 * read: a word in prose is not code.
 *
 *     node tools/check-store-protocol.mjs [--core DIR] [--launcher DIR]
 *
 * The launcher is a repository of its own, beside this one by default
 * (`../bottlify-ui`); where it is not there, it is reported not checked.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** What speaking a store's protocol looks like in code. */
export const MARKERS = Object.freeze([
    [/\bfrom\s+['"][^'"]*bridge\/src\/stores\//, 'imports GameHub\'s store modules'],
    [/\bconnectCm\b/, 'opens a CM connection'],
    [/\bEMsg\s*\.\s*\w+/, 'names a CM message'],
    [/\bClientLog[Oo]n\b/, 'names the CM logon'],
    [/\bClientPICS\w*/, 'names a PICS message'],
    [/ISteamDirectory|GetCMListForConnect/, 'asks Steam\'s directory for its managers'],
    [/steamserver\.net|\/cmsocket\//, 'reaches a connection manager'],
    [/BeginAuthSessionVia\w+|PollAuthSessionStatus|GenerateAccessTokenForApp/,
        'speaks Steam\'s authentication service'],
    [/GetDepotDecryptionKey|GetManifestRequestCode|GetServersForSteamPipe/,
        'asks for a depot\'s key, a manifest code or the content servers'],
    [/['"`]steam\.(?:[a-zA-Z]+['"`]|\$\{)/, 'asks GameHub a store\'s own op'],
]);

/** @param {string} code */
const withoutComments = code=>code.replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

/** @param {string} dir @returns {string[]} */
function sources(dir){
    if (!existsSync(dir))
    {
        return [];
    }
    return readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter(entry=>entry.isFile() && /\.(m?js|jsx)$/.test(entry.name)
            && !/[\\/](node_modules|dist)[\\/]/.test(join(entry.parentPath, entry.name)))
        .map(entry=>join(entry.parentPath, entry.name));
}

/**
 * Every place a store's protocol is spoken in the files given.
 *
 * @param {string[]} files
 * @param {string} base  What paths are said relative to.
 * @returns {string[]}
 */
export function storeProtocolIssues(files, base){
    /** @type {string[]} */
    const issues = [];
    for (const file of files)
    {
        const code = withoutComments(readFileSync(file, 'utf8'));
        for (const [pattern, what] of MARKERS)
        {
            const found = pattern.exec(code);
            if (found)
            {
                issues.push(`${relative(base, file).replace(/\\/g, '/')} ${what} (${found[0].trim()})`);
            }
        }
    }
    return issues;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
{
    const argv = process.argv.slice(2);
    /** @param {string} name @param {string} fallback */
    const option = (name, fallback)=>{
        const at = argv.indexOf(name);
        return at >= 0 ? resolve(argv[at + 1]) : fallback;
    };
    const core = option('--core', join(ROOT, 'modules', 'core'));
    const launcher = option('--launcher', resolve(ROOT, '..', 'bottlify-ui'));
    const coreFiles = sources(join(core, 'src'));
    const issues = storeProtocolIssues(coreFiles, core);
    let launcherSaid = 'not checked: no launcher at ' + launcher;
    if (existsSync(join(launcher, 'package.json')))
    {
        const launcherFiles = [...sources(join(launcher, 'src')),
            ...readdirSync(launcher).filter(name=>/\.m?js$/.test(name)).map(name=>join(launcher, name))];
        issues.push(...storeProtocolIssues(launcherFiles, launcher).map(line=>`launcher: ${line}`));
        launcherSaid = `${launcherFiles.length} files`;
    }
    if (issues.length > 0)
    {
        console.error(`A store's protocol outside GameHub:\n  - ${issues.join('\n  - ')}`);
        process.exit(1);
    }
    console.log(`store protocol: none in core (${coreFiles.length} files)`
        + ` or the launcher (${launcherSaid})`);
}
