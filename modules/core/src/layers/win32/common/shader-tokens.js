/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The extent of a Direct3D 8/9 shader function in its token stream, which
 * carries no length: everything up to its end token, walked an instruction at
 * a time.
 *
 * Only a token where an instruction begins can be the end or a comment. A
 * walk that took any word whose low half is 0xfffe for a comment read a `def`
 * literal as one: the float 9.999998 is 0x411ffffe, a "comment" of 16671
 * words that stepped over the end token, and the shader was refused.
 *
 * The documented layout (shader-asm.js says it in full): an instruction token
 * has bit 31 clear and its parameters set; from model 2 bits 24 to 27 count
 * the tokens that follow. Before model 2 the count is the run of parameter
 * tokens, but for `def`, `defi` and `defb`, whose literals are bare.
 */

export const END_TOKEN = 0x0000ffff;
export const COMMENT_OPCODE = 0xfffe;
const OP_DEFB = 47;
const OP_DEFI = 48;
const OP_DEF = 81;

/** The most tokens a walk reads: a pointer to anything but a shader ends here. */
export const MOST_TOKENS = 1 << 18;

/**
 * The tokens after the instruction (or comment) token at `at`.
 *
 * @param {(index: number) => number | undefined} token  the dword at an index, unsigned
 * @param {number} at
 * @param {number} major  the shader's model, from its version token
 * @returns {number}
 */
export function tokensAfter(token, at, major){
    const instruction = /** @type {number} */ (token(at));
    const opcode = instruction & 0xffff;
    if (opcode === COMMENT_OPCODE)
    {
        return (instruction >>> 16) & 0x7fff;
    }
    if (major >= 2)
    {
        return (instruction >>> 24) & 0xf;
    }
    if (opcode === OP_DEF || opcode === OP_DEFI)
    {
        return 5;
    }
    if (opcode === OP_DEFB)
    {
        return 2;
    }
    let length = 0;
    while (at + 1 + length < MOST_TOKENS
        && ((token(at + 1 + length) ?? 0) & 0x80000000) !== 0)
    {
        length++;
    }
    return length;
}

/**
 * How many tokens a shader function has, its end token included; 0 when the
 * first token is no shader version or the stream ends (`token` answers
 * undefined) or reaches `most` before an end token. Reads no token past the
 * end token, so a function at the very end of its memory is read whole.
 *
 * @param {(index: number) => number | undefined} token  the dword at an index, unsigned
 * @param {number} [most]
 * @returns {number}
 */
export function functionLength(token, most = MOST_TOKENS){
    const version = token(0);
    if (version === undefined || ((version >>> 16) !== 0xfffe && (version >>> 16) !== 0xffff))
    {
        return 0;
    }
    const major = (version >>> 8) & 0xff;
    for (let at = 1; at < most;)
    {
        const instruction = token(at);
        if (instruction === undefined)
        {
            return 0;
        }
        if (instruction === END_TOKEN)
        {
            return at + 1;
        }
        at += 1 + tokensAfter(token, at, major);
    }
    return 0;
}
