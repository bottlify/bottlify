/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The shaders a running title compiled, taken from the live launcher tab, in
 * the directory layout a harness run writes (`game.mjs`'s
 * `game-<stamp>-shaders/`): `NNN-<profile>-<entry>.hlsl` with the program's
 * macros at the top, every file its includes handed over beside it, and
 * `NNN-...txt` with what our compiler said. `tools/shader-diff.mjs` reads that
 * directory, and so does `--build` below.
 *
 * A title that builds its effects in memory -- generated sources, includes
 * read out of its own archives, decrypted -- has no files to compile offline;
 * the engine's `shader-compiled` event carries the text it was given, and this
 * keeps it. The journal's copy is cut short.
 *
 *   node tools/effect-capture.mjs hook [--all]
 *       starts keeping, in the tab, every compile that failed (or, with --all,
 *       every one) -- before the title compiles what is wanted; a reload of
 *       the tab forgets it
 *   node tools/effect-capture.mjs save DIR
 *       writes what was kept to DIR
 *   node tools/effect-capture.mjs build DIR
 *       compiles every saved .hlsl again with our compiler, as an effect when
 *       its profile is fx, and prints what still fails -- seconds, not a run
 *
 * The tab is reached through the live driver (`tools/cdp_test/live/drive.mjs`,
 * DRIVE_PORT, default 9401).
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildEffect } from '../modules/core/src/layers/win32/d3dx9/effect-model.js';
import { compileShader } from '../modules/core/src/layers/win32/d3dx9/hlsl-compile.js';

const PORT = Number(process.env.DRIVE_PORT ?? 9401);
const [command, target, ...flags] = process.argv.slice(2);

/** @param {string} js */
const evaluate = async js=>{
    const text = await (await fetch(`http://127.0.0.1:${PORT}/eval?js=${encodeURIComponent(js)}`))
        .text();
    return JSON.parse(text);
};

/** A file name a volume takes. @param {string} name */
const safe = name=>name.replace(/[\\/:*?"<>|]/g, '_');

if (command === 'hook')
{
    const all = flags.includes('--all') || target === '--all';
    console.log(await evaluate(`(()=>{
        const kept = window.__effectCapture = [];
        window.__bottlify__.app.on('shader-compiled', r=>{
            if (${all} || /error/.test(r.messages ?? '')) kept.push(r);
        });
        return 'keeping ' + (${all} ? 'every compile' : 'failed compiles');
    })()`));
}
else if (command === 'save' && target)
{
    const kept = JSON.parse(await evaluate('JSON.stringify(window.__effectCapture ?? [])'));
    mkdirSync(target, { recursive: true });
    kept.forEach((/** @type {any} */ shader, /** @type {number} */ index)=>{
        const name = `${String(index).padStart(3, '0')}-${shader.profile}-${
            String(shader.entry).replace(/[^\w]/g, '_')}`;
        writeFileSync(join(target, `${name}.hlsl`), `${(shader.defines ?? [])
            .map((/** @type {string[]} */ [key, value])=>`#define ${key} ${value}\n`)
            .join('')}// flags 0x${(shader.flags ?? 0).toString(16)}\n${shader.source}`);
        for (const [file, body] of Object.entries(shader.included ?? {}))
        {
            writeFileSync(join(target, safe(file)), String(body));
        }
        writeFileSync(join(target, `${name}.txt`), String(shader.messages ?? ''));
    });
    console.log(`${kept.length} compiles in ${target}`);
}
else if (command === 'build' && target)
{
    const files = new Map(readdirSync(target).map(name=>[name.toLowerCase(), name]));
    /** @param {string} name */
    const include = name=>{
        const found = files.get(safe(name).toLowerCase());
        return found ? readFileSync(join(target, found), 'latin1') : null;
    };
    let failed = 0;
    for (const name of [...files.values()].filter(file=>file.endsWith('.hlsl')).sort())
    {
        const [, profile, entry] = /^\d+-([^-]+)-(.*)\.hlsl$/.exec(name) ?? [];
        const source = readFileSync(join(target, name), 'latin1');
        const result = profile === 'fx'
            ? await buildEffect(source, { include })
            : await compileShader(source, { entry, profile, include });
        const errors = String(result.messages ?? '').split('\n').filter(line=>/error/.test(line));
        const bad = profile === 'fx' ? !result.model : !result.ok;
        if (bad || errors.length > 0)
        {
            failed++;
            console.log(`${name}: ${errors[0] ?? 'failed'}`);
        }
    }
    console.log(`${failed} still failing`);
}
else
{
    console.log('usage: node tools/effect-capture.mjs hook [--all] | save DIR | build DIR');
    process.exitCode = 1;
}
