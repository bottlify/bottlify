/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The calls sscanf's gates are made of: seeded formats of every conversion,
 * width and modifier msvcrt reads, each over an input that follows it most
 * of the way - the numbers and words a scan meets, the ones that end it and
 * the ones its code in the guest leaves to the host among them.
 */

/** @template T @param {() => number} next @param {T[]} from */
export const pick = (next, from)=>from[next() % from.length];

const INTEGERS = ['0', '7', '-12', '+7', '42', '0x1F', '0X7fffffff', '077', '08', '4294967295',
    '-2147483648', '123456789012', 'ff', 'DEADbeef', '-0x', '0x', '0xg', '-', '+',
    '18446744073709551615', '99999999999999999999', '0000000000000000000012', '1234567890123456789',
    '-9223372036854775808', '12abc', '0x12345678abcdef01'];
const REALS = ['1.5', '-0.25', '.5', '3.', '1e5', '1.5e-3', '1e', '1e+', '0.1', '-0', '0.000',
    '1e30', '1e22', '1e23', '1e-22', '1e-23', '3.14159265358979', '3.141592653589793',
    '100000001490116', '1000000000000000', '-.', '.', '+.5e1', '2.5E+2', '1.e2', '0e999', '1e999',
    '123456789.123456', '0.333333343267441', '16777217', '1..2', '5d2', 'inf', 'nan', '0x1p3',
    '-1.17549435e-38', '9.999999', '1.0000001'];
const WORDS = ['abc', 'Hello', 'caf\x80', 'path\\to\\file.dds', 'x', 'a,b', 'true', '%', 'q',
    'n=1'];
const GAPS = ['', '', ' ', '  ', '\t', '\n', ',', ', ', '=', 'x'];

/**
 * A random format and an input made to follow it most of the way: for each
 * specification a text of its kind (or, now and then, of another), with the
 * gaps a format and an input have between them, alike or not.
 *
 * @param {() => number} next
 * @returns {{ format: string, input: string }}
 */
export function caseOf(next){
    let format = '';
    let input = pick(next, ['', '', '', ' ', '\n']);
    const pieces = 1 + next() % 4;
    for (let p = 0; p < pieces; p++)
    {
        if (next() % 5 === 0)
        {
            const literal = pick(next, ['x=', ' ', ',', '%%', '\xe9', 'ab', '% ']);
            format += literal;
            input += next() % 4 === 0 ? pick(next, GAPS) : literal.replace('%%', '%');
            continue;
        }
        format += '%';
        format += next() % 8 === 0 ? '*' : '';
        const width = pick(next, ['', '', '', '', '1', '2', '3', '5', '8', '12', '0', '02', '300']);
        const modifier = pick(next, ['', '', '', '', '', 'h', 'l', 'L', 'hh', 'll', 'I64', 'I32',
            'I', 'j', 'w', 'z', 't', 'F', 'N', 'hl', 'lh', 'lI32l', 'lIl']);
        // The digits of a width and the modifiers come in any order.
        format += next() % 6 === 0 ? modifier + width : width + modifier;
        const conversion = 'ddiiuxXoffgeEGsscCSpPaAn[q'[next() % 26];
        format += conversion === '[' ? pick(next, ['[a-z]', '[^,]', '[']) : conversion;
        const kind = next() % 7 === 0 ? next() % 3
            : 'diuxXopP'.includes(conversion) ? 0 : 'feEgGaA'.includes(conversion) ? 1 : 2;
        input += pick(next, kind === 0 ? INTEGERS : kind === 1 ? REALS : WORDS);
        const gap = pick(next, GAPS);
        input += gap;
        format += next() % 3 === 0 ? pick(next, GAPS) : gap;
    }
    if (next() % 40 === 0)
    {
        input += '\xe9';
    }
    return { format, input };
}
