/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Where a shader's token stream ends. The stream carries no length, so it is
 * walked an instruction at a time from its version token: a comment by the
 * length in its token, a model 2 or 3 instruction by the length in bits 24-27
 * of its token, a model 1 one by its parameters, each with bit 31 set, but
 * `def`, whose four literals are any floats. Telling a comment or the end by
 * a token's low word alone took a literal such as 0.99999988 (0x3f7ffffe) for
 * a comment sixteen thousand tokens long, ran past the shader and refused it.
 */

import { END_TOKEN } from '../d3d9/shader.js';

const COMMENT = 0xfffe;
/** D3DSIO_DEF: a destination and four literals. */
const DEF = 0x51;

/**
 * A walker fed a shader's tokens one at a time, from the version token on,
 * answering true at the end token.
 *
 * @returns {(token: number) => boolean}
 */
export function shaderEnd(){
    let major = -1;
    let skip = 0;
    return token=>{
        if (major < 0)
        {
            major = (token >>> 8) & 0xff;
            return false;
        }
        if (skip > 0)
        {
            skip--;
            return false;
        }
        if (token === END_TOKEN)
        {
            return true;
        }
        const opcode = token & 0xffff;
        if (opcode === COMMENT && (token & 0x80000000) === 0)
        {
            skip = (token >>> 16) & 0x7fff;
            return false;
        }
        if (major >= 2)
        {
            skip = (token >>> 24) & 0x0f;
        }
        else if ((token & 0x80000000) === 0 && opcode === DEF)
        {
            skip = 5;
        }
        return false;
    };
}
