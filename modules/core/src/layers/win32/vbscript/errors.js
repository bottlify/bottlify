/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * VBScript's errors: the numbers it reports, the English descriptions it
 * reports them with, and how a failed COM call becomes one.
 *
 * A script reads an error of its own as a small number -- Err.Number is 13
 * for a type mismatch -- and a COM caller is told the same error as an
 * HRESULT of FACILITY_CONTROL with that number in the low word, 0x800A000D.
 * The numbers below 1000 are Visual Basic's runtime errors, 1001 to 1058
 * VBScript's compilation errors, and 5016 to 5021 its regular expressions'.
 */

import {
    DISP_E_BADPARAMCOUNT, DISP_E_MEMBERNOTFOUND, DISP_E_PARAMNOTFOUND,
    DISP_E_TYPEMISMATCH, DISP_E_UNKNOWNNAME, E_NOTIMPL, ExternalError,
} from '../script/external.js';

/** @type {Readonly<Record<number, string>>} */
export const MESSAGES = Object.freeze({
    5: 'Invalid procedure call or argument',
    6: 'Overflow',
    7: 'Out of memory',
    9: 'Subscript out of range',
    10: 'This array is fixed or temporarily locked',
    11: 'Division by zero',
    13: 'Type mismatch',
    14: 'Out of string space',
    17: 'Can\'t perform requested operation',
    28: 'Out of stack space',
    35: 'Sub or Function not defined',
    48: 'Error in loading DLL',
    51: 'Internal error',
    52: 'Bad file name or number',
    53: 'File not found',
    54: 'Bad file mode',
    55: 'File already open',
    57: 'Device I/O error',
    58: 'File already exists',
    61: 'Disk full',
    62: 'Input past end of file',
    67: 'Too many files',
    68: 'Device unavailable',
    70: 'Permission denied',
    71: 'Disk not ready',
    74: 'Can\'t rename with different drive',
    75: 'Path/File access error',
    76: 'Path not found',
    91: 'Object variable not set',
    92: 'For loop not initialized',
    94: 'Invalid use of Null',
    322: 'Can\'t create necessary temporary file',
    424: 'Object required',
    429: 'ActiveX component can\'t create object',
    430: 'Class doesn\'t support Automation',
    432: 'File name or class name not found during Automation operation',
    438: 'Object doesn\'t support this property or method',
    440: 'Automation error',
    445: 'Object doesn\'t support this action',
    446: 'Object doesn\'t support named arguments',
    447: 'Object doesn\'t support current locale setting',
    448: 'Named argument not found',
    449: 'Argument not optional',
    450: 'Wrong number of arguments or invalid property assignment',
    451: 'Object not a collection',
    453: 'Specified DLL function not found',
    457: 'This key is already associated with an element of this collection',
    458: 'Variable uses an Automation type not supported in VBScript',
    462: 'The remote server machine does not exist or is unavailable',
    500: 'Variable is undefined',
    501: 'Illegal assignment',
    502: 'Object not safe for scripting',
    503: 'Object not safe for initializing',
    504: 'Object not safe for creating',
    505: 'Invalid or unqualified reference',
    506: 'Class not defined',
    507: 'An exception occurred',
    1001: 'Out of memory',
    1002: 'Syntax error',
    1003: 'Expected \':\'',
    1005: 'Expected \'(\'',
    1006: 'Expected \')\'',
    1007: 'Expected \']\'',
    1010: 'Expected identifier',
    1011: 'Expected \'=\'',
    1012: 'Expected \'If\'',
    1013: 'Expected \'To\'',
    1014: 'Expected \'End\'',
    1015: 'Expected \'Function\'',
    1016: 'Expected \'Sub\'',
    1017: 'Expected \'Then\'',
    1018: 'Expected \'Wend\'',
    1019: 'Expected \'Loop\'',
    1020: 'Expected \'Next\'',
    1021: 'Expected \'Case\'',
    1022: 'Expected \'Select\'',
    1023: 'Expected expression',
    1024: 'Expected statement',
    1025: 'Expected end of statement',
    1026: 'Expected integer constant',
    1027: 'Expected \'While\' or \'Until\'',
    1028: 'Expected \'While\', \'Until\' or end of statement',
    1029: 'Expected \'With\'',
    1030: 'Identifier too long',
    1031: 'Invalid number',
    1032: 'Invalid character',
    1033: 'Unterminated string constant',
    1034: 'Unterminated comment',
    1037: 'Invalid use of \'Me\' keyword',
    1038: '\'loop\' without \'do\'',
    1039: 'Invalid \'exit\' statement',
    1040: 'Invalid \'for\' loop control variable',
    1041: 'Name redefined',
    1042: 'Must be first statement on the line',
    1043: 'Cannot assign to non-ByVal argument',
    1044: 'Cannot use parentheses when calling a Sub',
    1045: 'Expected literal constant',
    1046: 'Expected \'In\'',
    1047: 'Expected \'Class\'',
    1048: 'Must be defined inside a Class',
    1049: 'Expected Let or Set or Get in property declaration',
    1050: 'Expected \'Property\'',
    1051: 'Number of arguments must be consistent across properties specification',
    1052: 'Cannot have multiple default property/method in a Class',
    1053: 'Class initialize or terminate do not have arguments',
    1054: 'Property set or let must have at least one argument',
    1055: 'Unexpected \'Next\'',
    1056: '\'Default\' can be specified only on \'Property\' or \'Function\' or \'Sub\'',
    1057: '\'Default\' specification must also specify \'Public\'',
    1058: '\'Default\' specification can only be on Property Get',
    5016: 'Regular Expression object expected',
    5017: 'Syntax error in regular expression',
    5018: 'Unexpected quantifier',
    5019: 'Expected \']\' in regular expression',
    5020: 'Expected \')\' in regular expression',
    5021: 'Invalid range in character set',
});

/** What the engine calls itself in an error's source, by kind. */
export const SOURCE_RUNTIME = 'Microsoft VBScript runtime error';
export const SOURCE_COMPILATION = 'Microsoft VBScript compilation error';

/** The description of a number VBScript has none for. */
export const UNKNOWN_ERROR = 'Unknown runtime error';

/** The HRESULT facility VBScript's own numbers are reported in. */
const FACILITY_CONTROL = 0x800a0000;

/**
 * An error number as a COM caller is told it: a number of VBScript's own in
 * FACILITY_CONTROL, anything else -- an HRESULT a COM object answered, a
 * number a script raised past 65535 -- as it is.
 *
 * @param {number} number @returns {number}
 */
export const hresultOf = number=>(number > 0 && number <= 0xffff
    ? (FACILITY_CONTROL | number) | 0 : number | 0);

/**
 * A runtime error a script can catch with On Error Resume Next: the number
 * Err.Number reads, its description and source. `where` is the statement it
 * stopped, which the engine fills in the first time the error leaves one.
 */
export class VBRuntimeError extends Error
{
    /**
     * @param {number} number @param {string} [description] @param {string} [source]
     */
    constructor(number, description, source = SOURCE_RUNTIME){
        const text = description ?? MESSAGES[number] ?? UNKNOWN_ERROR;
        super(text);
        this.name = 'VBRuntimeError';
        this.number = number;
        this.description = text;
        this.source = source;
        /** @type {{ source: SourceText, offset: number } | null} */
        this.where = null;
    }
}

/**
 * A script's text as a parsed node remembers it, for an error's position.
 *
 * @typedef {Object} SourceText
 * @property {string} text
 * @property {number} line  The line the text starts on in its document.
 * @property {number} context  The host's cookie for it.
 */

/** A script that does not parse: the code, and where. */
export class SyntaxFailure extends Error
{
    /**
     * @param {number} code  1001 and up.
     * @param {number} position  Offset into the text.
     */
    constructor(code, position){
        super(MESSAGES[code] ?? 'Syntax error');
        this.name = 'SyntaxFailure';
        this.code = code;
        this.position = position;
    }
}

/**
 * The HRESULTs a COM call answers in that VBScript reports as an error of
 * its own number.
 *
 * @type {ReadonlyMap<number, number>}
 */
const HRESULT_ERRORS = new Map([
    [DISP_E_UNKNOWNNAME, 438],
    [DISP_E_MEMBERNOTFOUND, 438],
    [DISP_E_TYPEMISMATCH, 13],
    [DISP_E_BADPARAMCOUNT, 450],
    [DISP_E_PARAMNOTFOUND, 448],
    [0x8002000a | 0, 6], // DISP_E_OVERFLOW
    [0x80020012 | 0, 11], // DISP_E_DIVBYZERO
    [0x8002000b | 0, 9], // DISP_E_BADINDEX
    [0x80020008 | 0, 458], // DISP_E_BADVARTYPE
    [0x80020007 | 0, 446], // DISP_E_NONAMEDARGS
    [E_NOTIMPL, 445],
    [0x8007000e | 0, 7], // E_OUTOFMEMORY
    [0x80070005 | 0, 70], // E_ACCESSDENIED
    [0x80040154 | 0, 429], // REGDB_E_CLASSNOTREG
    [0x800401f3 | 0, 429], // CO_E_CLASSSTRING
    [0x80004002 | 0, 430], // E_NOINTERFACE
]);

/** What the system says of an HRESULT VBScript has no number for, as Err.Description. */
const SYSTEM_MESSAGES = new Map([
    [0x80004005 | 0, 'Unspecified error'], // E_FAIL
    [0x8000ffff | 0, 'Catastrophic failure'], // E_UNEXPECTED
    [0x80070057 | 0, 'The parameter is incorrect.'], // E_INVALIDARG
    [0x80004004 | 0, 'Operation aborted'], // E_ABORT
]);

/**
 * What a failed call on an external object is to a script: an HRESULT
 * VBScript has a number for as that error, a number of FACILITY_CONTROL --
 * an exception a VBScript object raised -- read back as VBScript's own, and
 * anything else as the HRESULT itself, which Err.Number reads signed. The
 * description and source are the object's where it gave them.
 *
 * @param {ExternalError} failure @returns {VBRuntimeError}
 */
export function fromExternalError(failure){
    const number = failure.number | 0;
    const own = HRESULT_ERRORS.get(number) ?? ((number & 0xffff0000) === (FACILITY_CONTROL | 0)
        ? number & 0xffff : number);
    const description = failure.description || MESSAGES[own] || SYSTEM_MESSAGES.get(own)
        || UNKNOWN_ERROR;
    return new VBRuntimeError(own, description, failure.source || SOURCE_RUNTIME);
}

export { ExternalError };
