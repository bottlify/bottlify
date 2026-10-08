/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The names of languages a version resource can be in, as VerLanguageName
 * gives them: the English display name Windows XP shows for a LANGID -- the
 * "Language" line of a file's Version tab. kernel32 and version.dll both
 * export the call, and both answer from here.
 *
 * The machine has one locale (`locale.js`), but a file it is asked about can
 * be in any language, so the table is the common languages of the era's
 * version resources rather than the locales this machine has. A LANGID not
 * in it is named as the neutral language is.
 */

/** @type {ReadonlyMap<number, string>} */
export const LANGUAGE_NAMES = new Map([
    [0x0000, 'Language Neutral'],
    [0x0401, 'Arabic (Saudi Arabia)'],
    [0x0402, 'Bulgarian'],
    [0x0403, 'Catalan'],
    [0x0404, 'Chinese (Taiwan)'],
    [0x0405, 'Czech'],
    [0x0406, 'Danish'],
    [0x0407, 'German (Germany)'],
    [0x0408, 'Greek'],
    [0x0409, 'English (United States)'],
    [0x040a, 'Spanish (Traditional Sort)'],
    [0x040b, 'Finnish'],
    [0x040c, 'French (France)'],
    [0x040d, 'Hebrew'],
    [0x040e, 'Hungarian'],
    [0x040f, 'Icelandic'],
    [0x0410, 'Italian (Italy)'],
    [0x0411, 'Japanese'],
    [0x0412, 'Korean'],
    [0x0413, 'Dutch (Netherlands)'],
    [0x0414, 'Norwegian (Bokmal)'],
    [0x0415, 'Polish'],
    [0x0416, 'Portuguese (Brazil)'],
    [0x0418, 'Romanian'],
    [0x0419, 'Russian'],
    [0x041a, 'Croatian'],
    [0x041b, 'Slovak'],
    [0x041c, 'Albanian'],
    [0x041d, 'Swedish'],
    [0x041e, 'Thai'],
    [0x041f, 'Turkish'],
    [0x0421, 'Indonesian'],
    [0x0422, 'Ukrainian'],
    [0x0423, 'Belarusian'],
    [0x0424, 'Slovenian'],
    [0x0425, 'Estonian'],
    [0x0426, 'Latvian'],
    [0x0427, 'Lithuanian'],
    [0x042a, 'Vietnamese'],
    [0x042d, 'Basque'],
    [0x0436, 'Afrikaans'],
    [0x0804, 'Chinese (PRC)'],
    [0x0807, 'German (Switzerland)'],
    [0x0809, 'English (United Kingdom)'],
    [0x080a, 'Spanish (Mexico)'],
    [0x080c, 'French (Belgium)'],
    [0x0810, 'Italian (Switzerland)'],
    [0x0813, 'Dutch (Belgium)'],
    [0x0814, 'Norwegian (Nynorsk)'],
    [0x0816, 'Portuguese (Portugal)'],
    [0x0c04, 'Chinese (Hong Kong S.A.R.)'],
    [0x0c07, 'German (Austria)'],
    [0x0c09, 'English (Australia)'],
    [0x0c0a, 'Spanish (International Sort)'],
    [0x0c0c, 'French (Canada)'],
    [0x1004, 'Chinese (Singapore)'],
    [0x1009, 'English (Canada)'],
    [0x100c, 'French (Switzerland)'],
    [0x1409, 'English (New Zealand)'],
    [0x1809, 'English (Ireland)'],
]);

/** @param {number} language  A LANGID; only its low word is one. */
export const languageName = language=>LANGUAGE_NAMES.get(language & 0xffff)
    ?? /** @type {string} */ (LANGUAGE_NAMES.get(0));

/**
 * VerLanguageNameA and VerLanguageNameW, over whatever writes a string:
 *
 *     DWORD VerLanguageName(DWORD wLang, LPSTR szLang, DWORD cchLang)
 *
 * The name is copied as far as the buffer holds, always terminated, and the
 * answer is the whole name's length in characters without the terminator --
 * longer than the buffer when it was cut, which is how a caller learns to ask
 * again with more room.
 *
 * @param {(address: number, text: string) => void} write  Text and its terminator.
 */
export function verLanguageName(write){
    return {
        argBytes: 12,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [language, buffer, size])=>{
            const name = languageName(language >>> 0);
            const room = size >>> 0;
            if ((buffer >>> 0) !== 0 && room > 0)
            {
                write(buffer >>> 0, `${name.slice(0, room - 1)}\0`);
            }
            return name.length;
        },
    };
}
