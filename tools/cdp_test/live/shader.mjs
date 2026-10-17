/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */
/**
 * A shader the running program draws with, by the id a frame dump names it
 * (`ps585`, `vs31`): its Direct3D bytecode disassembled, then every WGSL
 * translation the graphics worker made of it, each under the variant it was
 * made for (fog, sampling, alpha test). A picture wrong in one shader is read
 * here, the instruction beside what it became.
 *
 *   node tools/cdp_test/live/shader.mjs ps585 [vs586 ...] [> dbg/ps585.txt]
 */
import { disassembleShader } from '../../../modules/core/src/layers/win32/d3dx9/shader-asm.js';
import { connect } from './connect.mjs';

const page = await connect();
for (const id of process.argv.slice(2))
{
    /** @type {any} */
    const text = await page.evaluate(`window.__bottlify__.app.debug.shader(${JSON.stringify(id)})`);
    if (!text)
    {
        console.log(`${id}: nothing drew with it yet -- does a dump name it?`);
        continue;
    }
    console.log(`==== ${id}: ${text.tokens.length} tokens`);
    try
    {
        console.log(disassembleShader(Uint32Array.from(text.tokens)));
    }
    catch (e){
        console.log(`(not disassembled: ${/** @type {Error} */ (e).message})`);
    }
    for (const made of text.translations)
    {
        console.log(`---- ${id} as ${made.tag}${made.error ? `: ${made.error}` : ''}`);
        console.log(made.wgsl);
    }
}
process.exit(0);
