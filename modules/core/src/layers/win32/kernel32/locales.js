/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The locales Windows has: each one's LCID, its name, and the code pages its
 * text is in -- the identity every NLS call starts from. kernel32 answers
 * from here and the C runtime reads it through kernel32's calls; there is
 * one copy.
 *
 * The LCIDs and names are [MS-LCID]'s; the pages are each locale's
 * LOCALE_IDEFAULTANSICODEPAGE, LOCALE_IDEFAULTCODEPAGE (OEM) and
 * LOCALE_IDEFAULTMACCODEPAGE as Windows reports them. A locale whose script
 * has no ANSI page -- Hindi, Georgian, Armenian and the like -- has none: 0,
 * with CP_OEMCP and CP_MACCP standing for the other two, as Windows answers.
 *
 * What a locale says beyond its identity -- names of its language, months
 * and days -- is not carried here (`locale.js`).
 */

/**
 * @typedef {Object} Locale
 * @property {number} lcid
 * @property {string} name      LOCALE_SNAME.
 * @property {number} ansi
 * @property {number} oem
 * @property {number} mac
 * @property {boolean} neutral  A language with no region.
 * @property {number} specific  The specific locale it stands for: itself,
 *           or for a neutral one the locale Windows answers in its place.
 */

/**
 * Specific locales by their code pages, "ANSI OEM MAC": each entry its LCID
 * in hex and its name, an OEM page of its own after a slash.
 */
const SPECIFIC = [
    ['1252 850 10000', `
        0403 ca-ES 0406 da-DK 0407 de-DE 0409 en-US/437 040a es-ES_tradnl 040b fi-FI 040c fr-FR
        040f is-IS 0410 it-IT 0413 nl-NL 0414 nb-NO 0416 pt-BR 0417 rm-CH 041d sv-SE 0421 id-ID
        042d eu-ES 0432 tn-ZA 0434 xh-ZA 0435 zu-ZA 0436 af-ZA 0438 fo-FO 043b se-NO 043e ms-MY
        0441 sw-KE/437 0452 cy-GB 0456 gl-ES 0462 fy-NL 0464 fil-PH/437 0468 ha-Latn-NG/437
        046a yo-NG/437 046b quz-BO 046c nso-ZA 046e lb-LU 046f kl-GL 0470 ig-NG/437 047a arn-CL
        047c moh-CA 047e br-FR 0482 oc-FR 0483 co-FR 0484 gsw-FR 0486 qut-GT 0487 rw-RW/437
        0488 wo-SN 0491 gd-GB 0807 de-CH 0809 en-GB 080a es-MX 080c fr-BE 0810 it-CH 0813 nl-BE
        0814 nn-NO 0816 pt-PT 081d sv-FI 083b se-SE 083c ga-IE 083e ms-BN 085d iu-Latn-CA/437
        085f tzm-Latn-DZ 0867 ff-Latn-SN 086b quz-EC 0c07 de-AT 0c09 en-AU 0c0a es-ES 0c0c fr-CA
        0c3b se-FI 0c6b quz-PE 1007 de-LU 1009 en-CA 100a es-GT 100c fr-CH 103b smj-NO 1407 de-LI
        1409 en-NZ 140a es-CR 140c fr-LU 143b smj-SE 1809 en-IE 180a es-PA 180c fr-MC 183b sma-NO
        1c09 en-ZA/437 1c0a es-DO 1c3b sma-SE 2009 en-JM 200a es-VE 203b sms-FI 2409 en-029
        240a es-CO 243b smn-FI 2809 en-BZ 280a es-PE 2c09 en-TT 2c0a es-AR 3009 en-ZW/437
        300a es-EC 3409 en-PH/437 340a es-CL 380a es-UY 3c0a es-PY 4009 en-IN/437 400a es-BO
        4409 en-MY/437 440a es-SV 4809 en-SG/437 480a es-HN 4c0a es-NI 500a es-PR 540a es-US`],
    ['1250 852 10029', `
        0405 cs-CZ 040e hu-HU 0415 pl-PL 0418 ro-RO 041a hr-HR 041b sk-SK 041c sq-AL 0424 sl-SI
        042e hsb-DE 0442 tk-TM 081a sr-Latn-CS 082e dsb-DE 101a hr-BA 141a bs-Latn-BA
        181a sr-Latn-BA 241a sr-Latn-RS 2c1a sr-Latn-ME`],
    ['1251 866 10007', `
        0402 bg-BG 0419 ru-RU 0422 uk-UA 0423 be-BY 0428 tg-Cyrl-TJ 042f mk-MK 043f kk-KZ
        0440 ky-KG 0444 tt-RU 0450 mn-MN 046d ba-RU 0485 sah-RU 082c az-Cyrl-AZ 0843 uz-Cyrl-UZ
        0c1a sr-Cyrl-CS/855 1c1a sr-Cyrl-BA/855 201a bs-Cyrl-BA/855 281a sr-Cyrl-RS/855
        301a sr-Cyrl-ME/855`],
    ['1253 737 10006', '0408 el-GR'],
    ['1254 857 10081', '041f tr-TR 042c az-Latn-AZ 0443 uz-Latn-UZ'],
    ['1255 862 10005', '040d he-IL'],
    ['1256 720 10004', `
        0401 ar-SA 0420 ur-PK 0429 fa-IR 0463 ps-AF 0480 ug-CN 048c prs-AF 0492 ku-Arab-IQ
        0801 ar-IQ 0846 pa-Arab-PK 0859 sd-Arab-PK 0c01 ar-EG 1001 ar-LY 1401 ar-DZ 1801 ar-MA
        1c01 ar-TN 2001 ar-OM 2401 ar-YE 2801 ar-SY 2c01 ar-JO 3001 ar-LB 3401 ar-KW 3801 ar-AE
        3c01 ar-BH 4001 ar-QA`],
    ['1257 775 10029', '0425 et-EE 0426 lv-LV 0427 lt-LT'],
    ['1258 1258 10000', '042a vi-VN'],
    ['874 874 10021', '041e th-TH'],
    ['932 932 10001', '0411 ja-JP'],
    ['949 949 10003', '0412 ko-KR'],
    ['936 936 10008', '0804 zh-CN 1004 zh-SG'],
    ['950 950 10002', '0404 zh-TW 0c04 zh-HK 1404 zh-MO'],
    ['0 1 2', `
        042b hy-AM 0437 ka-GE 0439 hi-IN 043a mt-MT 0445 bn-IN 0446 pa-IN 0447 gu-IN 0448 or-IN
        0449 ta-IN 044a te-IN 044b kn-IN 044c ml-IN 044d as-IN 044e mr-IN 044f sa-IN 0451 bo-CN
        0453 km-KH 0454 lo-LA 0455 my-MM 0457 kok-IN 045a syr-SY 045b si-LK 045d iu-Cans-CA
        045e am-ET 0461 ne-NP 0465 dv-MV 0473 ti-ET 0478 ii-CN 0481 mi-NZ 0845 bn-BD 0873 ti-ER`],
];

/**
 * The neutral locales, a language with no region: each one's LCID, its name
 * and the specific locale it stands for. A language's own LCID with
 * SUBLANG_NEUTRAL stands for its SUBLANG_DEFAULT locale unless this says
 * otherwise; the higher neutral LCIDs name a script.
 */
const NEUTRAL = `
    0001 ar 0002 bg 0003 ca 0004 zh-Hans:0804 0005 cs 0006 da 0007 de 0008 el 0009 en 000a es:0c0a
    000b fi 000c fr 000d he 000e hu 000f is 0010 it 0011 ja 0012 ko 0013 nl 0014 no 0015 pl 0016 pt
    0017 rm 0018 ro 0019 ru 001a hr 001b sk 001c sq 001d sv 001e th 001f tr 0020 ur 0021 id 0022 uk
    0023 be 0024 sl 0025 et 0026 lv 0027 lt 0028 tg 0029 fa 002a vi 002b hy 002c az 002d eu
    002e hsb 002f mk 0032 tn 0034 xh 0035 zu 0036 af 0037 ka 0038 fo 0039 hi 003a mt 003b se
    003c ga:083c 003e ms 003f kk 0040 ky 0041 sw 0042 tk 0043 uz 0044 tt 0045 bn:0845 0046 pa
    0047 gu 0048 or 0049 ta 004a te 004b kn 004c ml 004d as 004e mr 004f sa 0050 mn 0051 bo 0052 cy
    0053 km 0054 lo 0055 my 0056 gl 0057 kok 0059 sd:0859 005a syr 005b si 005d iu:085d 005e am
    005f tzm:085f 0061 ne 0062 fy 0063 ps 0064 fil 0065 dv 0067 ff:0867 0068 ha 006a yo 006b quz
    006c nso 006d ba 006e lb 006f kl 0070 ig 0073 ti:0873 0078 ii 007a arn 007c moh 007e br 0080 ug
    0081 mi 0082 oc 0083 co 0084 gsw 0085 sah 0086 qut 0087 rw 0088 wo 008c prs 0091 gd 0092 ku
    641a bs-Cyrl:201a 681a bs-Latn:141a 6c1a sr-Cyrl:281a 701a sr-Latn:241a 703b smn:243b
    742c az-Cyrl:082c 743b sms:203b 7804 zh:0804 7814 nn:0814 781a bs:141a 782c az-Latn:042c
    783b sma:1c3b 7843 uz-Cyrl:0843 785d iu-Cans:045d 7c04 zh-Hant:0c04 7c14 nb:0414 7c1a sr:241a
    7c28 tg-Cyrl:0428 7c2e dsb:082e 7c3b smj:143b 7c43 uz-Latn:0443 7c46 pa-Arab:0846
    7c50 mn-Cyrl:0450 7c59 sd-Arab:0859 7c5d iu-Latn:085d 7c5f tzm-Latn:085f 7c68 ha-Latn:0468
    7c92 ku-Arab:0492`;

/** @type {Locale[]} */
const ALL = [];
for (const [pages, entries] of SPECIFIC)
{
    const [ansi, oem, mac] = pages.split(' ').map(Number);
    const words = entries.trim().split(/\s+/);
    for (let at = 0; at < words.length; at += 2)
    {
        const lcid = parseInt(words[at], 16);
        const [name, ownOem] = words[at + 1].split('/');
        ALL.push({ lcid, name, ansi, oem: ownOem === undefined ? oem : Number(ownOem), mac,
            neutral: false, specific: lcid });
    }
}

/** @type {Map<number, Locale>} */
const BY_LCID = new Map(ALL.map(locale=>[locale.lcid, locale]));

{
    const words = NEUTRAL.trim().split(/\s+/);
    for (let at = 0; at < words.length; at += 2)
    {
        const lcid = parseInt(words[at], 16);
        const [name, stands] = words[at + 1].split(':');
        const specific = stands === undefined ? lcid | 0x400 : parseInt(stands, 16);
        const of = BY_LCID.get(specific);
        if (of === undefined)
        {
            continue;
        }
        const locale = { lcid, name, ansi: of.ansi, oem: of.oem, mac: of.mac, neutral: true,
            specific };
        ALL.push(locale);
        BY_LCID.set(lcid, locale);
    }
}

ALL.sort((a, b)=>a.lcid - b.lcid);

/** @type {Map<string, Locale>} */
const BY_NAME = new Map(ALL.map(locale=>[locale.name.toLowerCase(), locale]));

/** Every locale, neutral and specific, in LCID order. */
export const LOCALES = Object.freeze(ALL);

/** SORT_GERMAN_PHONE_BOOK and the other sorts a locale may name, by its LCID. */
export const ALTERNATE_SORTS = Object.freeze(new Map([
    [0x10407, 'de-DE_phoneb'], [0x1040e, 'hu-HU_technl'], [0x10437, 'ka-GE_modern'],
    [0x20804, 'zh-CN_stroke'], [0x21004, 'zh-SG_stroke'], [0x30404, 'zh-TW_pronun'],
    [0x40404, 'zh-TW_radstr'], [0x40411, 'ja-JP_radstr'], [0x40c04, 'zh-HK_radstr'],
    [0x41404, 'zh-MO_radstr'], [0x21404, 'zh-MO_stroke'], [0x50804, 'zh-CN_phoneb'],
    [0x51004, 'zh-SG_phoneb'],
]));

/**
 * A locale by its LCID: its language and sublanguage, and a sort it has.
 *
 * @param {number} lcid
 * @returns {Locale | null}
 */
export const localeByLcid = lcid=>((lcid >>> 16) !== 0 && !ALTERNATE_SORTS.has(lcid >>> 0) ? null
    : BY_LCID.get(lcid & 0xffff) ?? null);

/**
 * A locale by its name, in any case, a sort after an underscore ignored.
 *
 * @param {string} name
 * @returns {Locale | null}
 */
export const localeByName = name=>BY_NAME.get(name.toLowerCase())
    ?? BY_NAME.get(name.split('_')[0].toLowerCase()) ?? null;

/** @type {Map<string, number>} */
const SORTED_NAMES = new Map([...ALTERNATE_SORTS].map(([lcid, name])=>[name.toLowerCase(), lcid]));

/**
 * The LCID LocaleNameToLCID answers for a name, 0 for none: an alternate
 * sort's own, and a neutral name's specific locale's unless neutral LCIDs
 * are asked for.
 *
 * @param {string} name @param {boolean} neutral
 */
export function lcidOfName(name, neutral){
    const sorted = SORTED_NAMES.get(name.toLowerCase());
    if (sorted !== undefined)
    {
        return sorted;
    }
    const found = BY_NAME.get(name.toLowerCase());
    if (found === undefined)
    {
        return 0;
    }
    return found.neutral && !neutral ? found.specific : found.lcid;
}
