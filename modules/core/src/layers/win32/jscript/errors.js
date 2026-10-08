/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * JScript's errors: the numbers it reports and the English descriptions it
 * reports them with.
 *
 * A JScript error number is an HRESULT of FACILITY_CONTROL with the code in
 * the low word -- 5009, "undefined identifier", is 0x800A1391 -- and a script
 * reads it back signed, as `e.number`. The codes below 1000 are the ones
 * JScript shares with Visual Basic; 1000 to 1999 are compilation errors and
 * 5000 and up runtime errors of its own.
 */

/** @type {Readonly<Record<number, string>>} */
export const MESSAGES = Object.freeze({
    5: 'Invalid procedure call or argument',
    6: 'Overflow',
    7: 'Out of memory',
    9: 'Subscript out of range',
    13: 'Type mismatch',
    28: 'Out of stack space',
    51: 'Internal error',
    424: 'Object required',
    429: 'Automation server can\'t create object',
    438: 'Object doesn\'t support this property or method',
    445: 'Object doesn\'t support this action',
    448: 'Named argument not found',
    449: 'Argument not optional',
    450: 'Wrong number of arguments or invalid property assignment',
    451: 'Object not a collection',
    458: 'Variable uses an Automation type not supported in JScript',
    1002: 'Syntax error',
    1003: 'Expected \':\'',
    1004: 'Expected \';\'',
    1005: 'Expected \'(\'',
    1006: 'Expected \')\'',
    1007: 'Expected \']\'',
    1008: 'Expected \'{\'',
    1009: 'Expected \'}\'',
    1010: 'Expected identifier',
    1011: 'Expected \'=\'',
    1012: 'Expected \'/\'',
    1013: 'Invalid number',
    1014: 'Invalid character',
    1015: 'Unterminated string constant',
    1016: 'Unterminated comment',
    1018: '\'return\' statement outside of function',
    1019: 'Can\'t have \'break\' outside of loop',
    1020: 'Can\'t have \'continue\' outside of loop',
    1023: 'Expected hexadecimal digit',
    1024: 'Expected \'while\'',
    1025: 'Label redefined',
    1026: 'Label not found',
    1027: '\'default\' can only appear once in a \'switch\' statement',
    1028: 'Expected identifier, string or number',
    1029: 'Expected \'@end\'',
    1030: 'Conditional compilation is turned off',
    1031: 'Expected constant',
    1032: 'Expected \'@\'',
    1033: 'Expected \'catch\'',
    1034: 'Expected \'var\'',
    1035: '\'throw\' must be followed by an expression on the same source line',
    5000: 'Cannot assign to \'this\'',
    5001: 'Number expected',
    5002: 'Function expected',
    5003: 'Cannot assign to a function result',
    5004: 'Cannot index object',
    5005: 'String expected',
    5006: 'Date object expected',
    5007: 'Object expected',
    5008: 'Illegal assignment',
    5009: 'Undefined identifier',
    5010: 'Boolean expected',
    5012: 'Object member expected',
    5013: 'VBArray expected',
    5014: 'JScript object expected',
    5015: 'Enumerator object expected',
    5016: 'Regular Expression object expected',
    5017: 'Syntax error in regular expression',
    5018: 'Unexpected quantifier',
    5019: 'Expected \']\' in regular expression',
    5020: 'Expected \')\' in regular expression',
    5021: 'Invalid range in character set',
    5022: 'Exception thrown and not caught',
    5023: 'Function does not have a valid prototype object',
    5024: 'The URI to be encoded contains an invalid character',
    5025: 'The URI to be decoded is not a valid encoding',
    5026: 'The number of fractional digits is out of range',
    5027: 'The precision is out of range',
    5028: 'Array or arguments object expected',
    5029: 'Array length must be a finite positive integer',
    5030: 'Array length must be assigned a finite positive number',
});

/** @param {number} code @returns {number} the signed HRESULT a script reads */
export const errorNumber = code=>(0x800a0000 | code) | 0;

/** What the engine calls itself in an error's source, by kind. */
export const SOURCE_RUNTIME = 'Microsoft JScript runtime error';
export const SOURCE_COMPILATION = 'Microsoft JScript compilation error';

/** A script that does not parse: the code, and where. */
export class SyntaxFailure extends Error
{
    /**
     * @param {number} code  1002 and up.
     * @param {number} position  Offset into the text.
     */
    constructor(code, position){
        super(MESSAGES[code] ?? 'Syntax error');
        this.name = 'SyntaxFailure';
        this.code = code;
        this.position = position;
    }
}
