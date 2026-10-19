/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

// Rewrites the relative links of a package's READMEs to the repository on
// GitHub at one commit, before the package is packed. npmjs.com shows the
// README from the tarball and resolves a relative link against the repository's
// root, not the package's folder, so `../../docs/architecture.md` from
// modules/core led nowhere. Run in the publish workflow's checkout only: it
// edits the files in place.
//
//   node tools/readme-links.mjs <ref> <package dir>...

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'https://github.com/bottlify/bottlify';
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * @param {string} text  Markdown.
 * @param {string} dir   The README's folder, relative to the repository root, with `/`.
 * @param {string} ref   A commit or branch the links point at.
 * @returns {string}
 */
export function absoluteLinks(text, dir, ref){
    const fix = (/** @type {string} */ url)=>{
        if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(url))
        {
            return url;
        }
        const [path, anchor = ''] = url.split(/(?=#)/);
        const target = posix.normalize(posix.join(dir, path));
        return `${REPO}/blob/${ref}/${target.replace(/\/$/, '')}${anchor}`;
    };
    // Code is left as written: a link inside it is an example, not a link.
    return text.split(/(```[\s\S]*?```|`[^`\n]*`)/).map((part, i)=>i % 2 ? part : part
        .replace(/(\]\()([^)\s]+)(\))/g, (_, a, url, b)=>a + fix(url) + b)
        .replace(/(<img[^>]*\ssrc=")([^"]+)(")/g, (_, a, url, b)=>a + fix(url) + b)).join('');
}

if (process.argv[1] === fileURLToPath(import.meta.url))
{
    const [ref, ...dirs] = process.argv.slice(2);
    if (!ref || dirs.length === 0)
    {
        console.error('usage: node tools/readme-links.mjs <ref> <package dir>...');
        process.exit(2);
    }
    for (const dir of dirs)
    {
        for (const name of ['README.md', 'README.ru.md'])
        {
            const file = join(dir, name);
            if (!existsSync(file))
            {
                continue;
            }
            const rel = relative(ROOT, resolve(dir)).split('\\').join('/');
            writeFileSync(file, absoluteLinks(readFileSync(file, 'utf8'), rel, ref));
            console.log(`${file}: links point at ${ref}`);
        }
    }
}
