/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The three-letter codes a locale answers that the platform's locale data
 * does not carry: Windows' own language abbreviation (LOCALE_SABBREVLANGNAME,
 * "ENU" for en-US, "CHS" for zh-CN), and the ISO 3166 and ISO 639-2 codes of
 * its region and language (LOCALE_SABBREVCTRYNAME and
 * LOCALE_SISO3166CTRYNAME2, LOCALE_SISO639LANGNAME2).
 *
 * The C runtime's setlocale finds a locale by these: "american" is the
 * locale whose abbreviation is "ENU", "chs" the one whose is "CHS". The
 * abbreviations are Windows' as .NET's culture table records them
 * (THIRD-PARTY-NOTICES.md); a neutral locale answers its specific locale's,
 * and is listed only where Windows gives it its own ("es" is "ESP", es-ES
 * "ESN"). The ISO codes are CLDR's (`supplementalData.xml` territory codes,
 * `supplementalMetadata.xml` three-letter language aliases); a region ISO
 * gives no three-letter code (029, the Caribbean) answers its own.
 */

/** @param {string} text "key value key value ..." */
const pairs = text=>{
    const words = text.trim().split(/\s+/);
    /** @type {Map<string, string>} */
    const map = new Map();
    for (let at = 0; at < words.length; at += 2)
    {
        map.set(words[at], words[at + 1]);
    }
    return map;
};

/** LOCALE_SABBREVLANGNAME by locale name. */
export const LANGUAGE_ABBREVIATIONS = pairs(`
    es ESP mn MON ar-SA ARA bg-BG BGR ca-ES CAT zh-TW CHT cs-CZ CSY da-DK DAN de-DE DEU
    el-GR ELL en-US ENU fi-FI FIN fr-FR FRA he-IL HEB hu-HU HUN is-IS ISL it-IT ITA ja-JP JPN
    ko-KR KOR nl-NL NLD nb-NO NOR pl-PL PLK pt-BR PTB rm-CH RMC ro-RO ROM ru-RU RUS hr-HR HRV
    sk-SK SKY sq-AL SQI sv-SE SVE th-TH THA tr-TR TRK ur-PK URD id-ID IND uk-UA UKR be-BY BEL
    sl-SI SLV et-EE ETI lv-LV LVI lt-LT LTH tg-Cyrl-TJ TAJ fa-IR FAR vi-VN VIT hy-AM HYE
    az-Latn-AZ AZE eu-ES EUQ hsb-DE HSB mk-MK MKI tn-ZA TSN xh-ZA XHO zu-ZA ZUL af-ZA AFK
    ka-GE KAT fo-FO FOS hi-IN HIN mt-MT MLT se-NO SME ms-MY MSL kk-KZ KKZ ky-KG KYR sw-KE SWK
    tk-TM TUK uz-Latn-UZ UZB tt-RU TTT bn-IN BNG pa-IN PAN gu-IN GUJ or-IN ORI ta-IN TAI
    te-IN TEL kn-IN KDI ml-IN MYM as-IN ASM mr-IN MAR sa-IN SAN mn-MN MNN bo-CN BOB cy-GB CYM
    km-KH KHM lo-LA LAO my-MM MYA gl-ES GLC kok-IN KNK syr-SY SYR si-LK SIN iu-Cans-CA IUS
    am-ET AMH ne-NP NEP fy-NL FYN ps-AF PAS fil-PH FPO dv-MV DIV ha-Latn-NG HAU yo-NG YOR
    quz-BO QUB nso-ZA NSO ba-RU BAS lb-LU LBX kl-GL KAL ig-NG IBO ti-ET TIE ii-CN III arn-CL MPD
    moh-CA MWK br-FR BRE ug-CN UIG mi-NZ MRI oc-FR OCI co-FR COS gsw-FR GSW sah-RU SAH rw-RW KIN
    wo-SN WOL prs-AF PRS gd-GB GLA ku-Arab-IQ KUR ar-IQ ARI zh-CN CHS de-CH DES en-GB ENG
    es-MX ESM fr-BE FRB it-CH ITS nl-BE NLB nn-NO NON pt-PT PTG sr-Latn-CS SRL sv-FI SVF
    az-Cyrl-AZ AZC dsb-DE DSB se-SE SMF ga-IE IRE ms-BN MSB uz-Cyrl-UZ UZC bn-BD BNB
    pa-Arab-PK PAP sd-Arab-PK SIP iu-Latn-CA IUK tzm-Latn-DZ TZA ff-Latn-SN FUL quz-EC QUE
    ti-ER TIR ar-EG ARE zh-HK ZHH de-AT DEA en-AU ENA es-ES ESN fr-CA FRC sr-Cyrl-CS SRB
    se-FI SMG quz-PE QUP ar-LY ARL zh-SG ZHI de-LU DEL en-CA ENC es-GT ESG fr-CH FRS hr-BA HRB
    smj-NO SMJ ar-DZ ARG zh-MO ZHM de-LI DEC en-NZ ENZ es-CR ESC fr-LU FRL bs-Latn-BA BSB
    smj-SE SMK ar-MA ARM en-IE ENI es-PA ESA fr-MC FRM sr-Latn-BA SRS sma-NO SMA ar-TN ART
    en-ZA ENS es-DO ESD sr-Cyrl-BA SRN sma-SE SMB ar-OM ARO en-JM ENJ es-VE ESV bs-Cyrl-BA BSC
    sms-FI SMS ar-YE ARY en-029 ENB es-CO ESO sr-Latn-RS SRM smn-FI SMN ar-SY ARS en-BZ ENL
    es-PE ESR sr-Cyrl-RS SRO ar-JO ARJ en-TT ENT es-AR ESS sr-Latn-ME SRP ar-LB ARB en-ZW ENW
    es-EC ESF sr-Cyrl-ME SRQ ar-KW ARK en-PH ENP es-CL ESL ar-AE ARU es-UY ESY ar-BH ARH
    es-PY ESZ ar-QA ARQ en-IN ENN es-BO ESB en-MY ENM es-SV ESE en-SG ENE es-HN ESH es-NI ESI
    es-PR ESU es-US EST sr SRB`);

/** ISO 3166 alpha-3 by alpha-2 (or UN M.49) region. */
export const REGION_ALPHA3 = pairs(`
    AE ARE AF AFG AL ALB AM ARM AR ARG AT AUT AU AUS AZ AZE BA BIH BD BGD BE BEL BG BGR BH BHR
    BN BRN BO BOL BR BRA BY BLR BZ BLZ CA CAN CH CHE CL CHL CN CHN CO COL CR CRI CS SCG CZ CZE
    DE DEU DK DNK DO DOM DZ DZA EC ECU EE EST EG EGY ER ERI ES ESP ET ETH FI FIN FO FRO FR FRA
    GB GBR GE GEO GL GRL GR GRC GT GTM HK HKG HN HND HR HRV HU HUN ID IDN IE IRL IL ISR IN IND
    IQ IRQ IR IRN IS ISL IT ITA JM JAM JO JOR JP JPN KE KEN KG KGZ KH KHM KR KOR KW KWT KZ KAZ
    LA LAO LB LBN LI LIE LK LKA LT LTU LU LUX LV LVA LY LBY MA MAR MC MCO ME MNE MK MKD MM MMR
    MN MNG MO MAC MT MLT MV MDV MX MEX MY MYS NG NGA NI NIC NL NLD NO NOR NP NPL NZ NZL OM OMN
    PA PAN PE PER PH PHL PK PAK PL POL PR PRI PT PRT PY PRY QA QAT RO ROU RS SRB RU RUS RW RWA
    SA SAU SE SWE SG SGP SI SVN SK SVK SN SEN SV SLV SY SYR TH THA TJ TJK TM TKM TN TUN TR TUR
    TT TTO TW TWN UA UKR US USA UY URY UZ UZB VE VEN VN VNM YE YEM ZA ZAF ZW ZWE`);

/** ISO 639-2 by ISO 639-1 language. */
export const LANGUAGE_ALPHA3 = pairs(`
    af afr am amh ar ara as asm az aze ba bak be bel bg bul bn ben bo bod br bre bs bos ca cat
    co cos cs ces cy cym da dan de deu dv div el ell en eng es spa et est eu eus fa fas ff ful
    fi fin fo fao fr fra fy fry ga gle gd gla gl glg gu guj ha hau he heb hi hin hr hrv hu hun
    hy hye id ind ig ibo ii iii is isl it ita iu iku ja jpn ka kat kk kaz kl kal km khm kn kan
    ko kor ku kur ky kir lb ltz lo lao lt lit lv lav mi mri mk mkd ml mal mn mon mr mar ms msa
    mt mlt my mya nb nob ne nep nl nld nn nno no nor oc oci or ori pa pan pl pol ps pus pt por
    rm roh ro ron ru rus rw kin sa san sd snd se sme si sin sk slk sl slv sq sqi sr srp sv swe
    sw swa ta tam te tel tg tgk th tha ti tir tk tuk tn tsn tr tur tt tat ug uig uk ukr ur urd
    uz uzb vi vie wo wol xh xho yo yor zh zho zu zul`);
