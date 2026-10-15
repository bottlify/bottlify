#!/usr/bin/env node
/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a finished installation in the live launcher would put in its bottle,
 * by directory and size, before anybody presses Save: the files the run left
 * are taken off the page through the driver and put through the rule a bottle
 * is collected by (`@bottlify/installer`'s `collect`), so a cache or a
 * temporary directory the rule still lets through is seen while it can be
 * added to it.
 *
 *   node tools/cdp_test/live/bottle-contents.mjs [depth] [port]
 */

import { DRIVE_ROOT, collect } from '../../../modules/installer/src/prefix.js';

const depth = Number(process.argv[2] ?? 4);
const port = Number(process.argv[3] ?? process.env.DRIVE_PORT ?? 9401);
const probe = `(async()=>JSON.stringify((await window.app.session.export())
    .map(file=>[file.path, file.size ?? file.bytes?.length ?? 0])))()`;
const answer = await fetch(`http://127.0.0.1:${port}/eval?js=${encodeURIComponent(probe)}`);
const text = JSON.parse(await answer.text());
if (typeof text !== 'string' || !text.startsWith('['))
{
    console.error(`the page answered: ${String(text).slice(0, 300)}`);
    process.exit(1);
}
/** @type {[string, number][]} */
const files = JSON.parse(text);
const sizes = new Map(files.map(([path, size])=>[path.slice(DRIVE_ROOT.length), size]));
const prefix = collect({
    files: files.map(([path])=>({ path, bytes: new Uint8Array(0) })),
});

/** @param {[string, number][]} entries @param {string} title */
const show = (entries, title)=>{
    /** @type {Map<string, { files: number, bytes: number }>} */
    const groups = new Map();
    for (const [path, size] of entries)
    {
        const key = path.split('\\').slice(0, depth).join('\\');
        const group = groups.get(key) ?? { files: 0, bytes: 0 };
        group.files += 1;
        group.bytes += size;
        groups.set(key, group);
    }
    const total = entries.reduce((sum, [, size])=>sum + size, 0);
    console.log(`${title}: ${entries.length} files, ${(total / 1048576).toFixed(1)} MB`);
    for (const [key, group] of [...groups].sort((a, b)=>b[1].bytes - a[1].bytes))
    {
        console.log(`${(group.bytes / 1048576).toFixed(1).padStart(9)} MB ${String(group.files)
            .padStart(5)}  ${key}`);
    }
};
show(prefix.files.map(file=>[file.path, sizes.get(file.path) ?? 0]), 'carried');
const outsideSizes = new Map(files);
show(prefix.outside.map(path=>[path, outsideSizes.get(path) ?? 0]), 'left out');
console.log(`entry: ${prefix.entry ?? 'none'}`);
