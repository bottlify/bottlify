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

/**
 * The locale name -- the language and region tag -- of each LANGID above,
 * as LCIDToLocaleName answers for its default sort.
 *
 * @type {ReadonlyMap<number, string>}
 */
export const LOCALE_TAGS = new Map([
    [0x0401, 'ar-SA'], [0x0402, 'bg-BG'], [0x0403, 'ca-ES'], [0x0404, 'zh-TW'], [0x0405, 'cs-CZ'],
    [0x0406, 'da-DK'], [0x0407, 'de-DE'], [0x0408, 'el-GR'], [0x0409, 'en-US'],
    [0x040a, 'es-ES_tradnl'], [0x040b, 'fi-FI'], [0x040c, 'fr-FR'], [0x040d, 'he-IL'],
    [0x040e, 'hu-HU'], [0x040f, 'is-IS'], [0x0410, 'it-IT'], [0x0411, 'ja-JP'], [0x0412, 'ko-KR'],
    [0x0413, 'nl-NL'], [0x0414, 'nb-NO'], [0x0415, 'pl-PL'], [0x0416, 'pt-BR'], [0x0418, 'ro-RO'],
    [0x0419, 'ru-RU'], [0x041a, 'hr-HR'], [0x041b, 'sk-SK'], [0x041c, 'sq-AL'], [0x041d, 'sv-SE'],
    [0x041e, 'th-TH'], [0x041f, 'tr-TR'], [0x0421, 'id-ID'], [0x0422, 'uk-UA'], [0x0423, 'be-BY'],
    [0x0424, 'sl-SI'], [0x0425, 'et-EE'], [0x0426, 'lv-LV'], [0x0427, 'lt-LT'], [0x042a, 'vi-VN'],
    [0x042d, 'eu-ES'], [0x0436, 'af-ZA'], [0x0804, 'zh-CN'], [0x0807, 'de-CH'], [0x0809, 'en-GB'],
    [0x080a, 'es-MX'], [0x080c, 'fr-BE'], [0x0810, 'it-CH'], [0x0813, 'nl-BE'], [0x0814, 'nn-NO'],
    [0x0816, 'pt-PT'], [0x0c04, 'zh-HK'], [0x0c07, 'de-AT'], [0x0c09, 'en-AU'], [0x0c0a, 'es-ES'],
    [0x0c0c, 'fr-CA'], [0x1004, 'zh-SG'], [0x1009, 'en-CA'], [0x100c, 'fr-CH'], [0x1409, 'en-NZ'],
    [0x1809, 'en-IE'],
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
