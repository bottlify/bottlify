/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The root certificates the verifier trusts unless it is configured with others.
 *
 * Microsoft's "Microsoft Root Authority" (1997-01-10 to 2020-12-31, SHA-1
 * thumbprint A43489159A520F0D93D032CCAF37E7FE20A8B419), the root the code
 * signing and timestamping certificates of software Microsoft signed in those
 * years chain to. It is Microsoft's certificate, taken unmodified from the root
 * certificates Windows Update publishes (see THIRD-PARTY-NOTICES.md); it is
 * data here, and only its names and public key are used. Its expiry does not
 * retire it: an Authenticode signature is judged at the time its timestamp
 * states, when the root was valid.
 *
 * And Thawte's "Thawte Timestamping CA" (1997-01-01 to 2020-12-31, SHA-1
 * thumbprint BE36A4562FB2EE05DBB3D32323ADF445084ED656), which XP's root store
 * carries and which VeriSign's time-stamping service of the 2000s chains to --
 * the countersignature on files Microsoft signed in those years.
 *
 * And Microsoft's three roots after it, as a Windows 7 machine whose roots are
 * kept up to date has them: "Microsoft Root Certificate Authority" (2001 to
 * 2021, CDD4EEAE6000AC7F40C3802C171E30148030C072), "... 2010" (2010 to 2035,
 * 3B1EFD3A66EA28B16697394703A72CA340A05BD5) and "... 2011" (2011 to 2036,
 * 8F43288AD272F3103B6FB1428485EA3014C0BCFE), to which the code signing and
 * timestamping certificates of the .NET Framework 4 and later chain -- without
 * them its setups refuse their own packages, CERT_E_CHAINING. Each is taken
 * unmodified from Microsoft's PKI publication (see THIRD-PARTY-NOTICES.md).
 */

const MICROSOFT_ROOT_AUTHORITY = [
    'MIIEEjCCAvqgAwIBAgIPAMEAizw8iBHRPvZj7N9AMA0GCSqGSIb3DQEBBAUAMHAxKzApBgNVBAsT',
    'IkNvcHlyaWdodCAoYykgMTk5NyBNaWNyb3NvZnQgQ29ycC4xHjAcBgNVBAsTFU1pY3Jvc29mdCBD',
    'b3Jwb3JhdGlvbjEhMB8GA1UEAxMYTWljcm9zb2Z0IFJvb3QgQXV0aG9yaXR5MB4XDTk3MDExMDA3',
    'MDAwMFoXDTIwMTIzMTA3MDAwMFowcDErMCkGA1UECxMiQ29weXJpZ2h0IChjKSAxOTk3IE1pY3Jv',
    'c29mdCBDb3JwLjEeMBwGA1UECxMVTWljcm9zb2Z0IENvcnBvcmF0aW9uMSEwHwYDVQQDExhNaWNy',
    'b3NvZnQgUm9vdCBBdXRob3JpdHkwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCpAr3B',
    'cOY78k4bKJ+XeF4w6qKpjSVf+P6VTKO3/p2iID58UaKboo9gMmvRQmR57qx2yVTa8uuchhyPn4Rm',
    's8VremIj1h083g8BkuiWxL8tZpqaaCaZ0Dosvwy1WCbBRucKPjiWLKkoOajsSYNC44QPu5psVWGs',
    'gnyhYC13TOmZtGQ7mlAcMQgkFJ+p55ErGOY9mGMUYFgFZZ8dN1KH96fvlALGG9O/VUWziYC/OuxU',
    'lE6u/ad6bXROrxjMlgkoIQBXkGBpN7tLEgc8Vv9b+6RmCgim0oFWV++2O14WgXcE2va+roCV/rDN',
    'f9anGnJcPMq88AijIjCzBoXJsyB3E4XfAgMBAAGjgagwgaUwgaIGA1UdAQSBmjCBl4AQW9Bw72ly',
    'niNRfhSyTY7/y6FyMHAxKzApBgNVBAsTIkNvcHlyaWdodCAoYykgMTk5NyBNaWNyb3NvZnQgQ29y',
    'cC4xHjAcBgNVBAsTFU1pY3Jvc29mdCBDb3Jwb3JhdGlvbjEhMB8GA1UEAxMYTWljcm9zb2Z0IFJv',
    'b3QgQXV0aG9yaXR5gg8AwQCLPDyIEdE+9mPs30AwDQYJKoZIhvcNAQEEBQADggEBAJXoC8CN85cY',
    'Ne24ASTYdxHzXGAyn54Lyz4FkYiPyTrmIfLwV5MstaBHyGLv/NfMOztaqTZUaf4kbT/JzKreBXzd',
    'MY09nxBwarv+Ek8YacD80EPjEVogT+pie6+qGcgrNyUtvmWhEoolD2Oj91Qc+SHJ1hXzUqxuQzIH',
    '/YIX+OVnbA1R9r3xUse958Qw/CAxCYgdlSkaTdUdAqXxgOADtFv0sd3IV+5lScdSVLa0AygS/5DW',
    '8AiPfriXxas3LOR65Kh343agANBqP8HSNorgQRKoNWobats14dQcBOSoRQTIWjM4bk0cDWK3CqKM',
    '09VUP0bNHFWmcNsSOoeTdZ+n0qA=',
].join('');

const THAWTE_TIMESTAMPING_CA = [
    'MIICoTCCAgqgAwIBAgIBADANBgkqhkiG9w0BAQQFADCBizELMAkGA1UEBhMCWkExFTATBgNVBAgT',
    'DFdlc3Rlcm4gQ2FwZTEUMBIGA1UEBxMLRHVyYmFudmlsbGUxDzANBgNVBAoTBlRoYXd0ZTEdMBsG',
    'A1UECxMUVGhhd3RlIENlcnRpZmljYXRpb24xHzAdBgNVBAMTFlRoYXd0ZSBUaW1lc3RhbXBpbmcg',
    'Q0EwHhcNOTcwMTAxMDAwMDAwWhcNMjAxMjMxMjM1OTU5WjCBizELMAkGA1UEBhMCWkExFTATBgNV',
    'BAgTDFdlc3Rlcm4gQ2FwZTEUMBIGA1UEBxMLRHVyYmFudmlsbGUxDzANBgNVBAoTBlRoYXd0ZTEd',
    'MBsGA1UECxMUVGhhd3RlIENlcnRpZmljYXRpb24xHzAdBgNVBAMTFlRoYXd0ZSBUaW1lc3RhbXBp',
    'bmcgQ0EwgZ8wDQYJKoZIhvcNAQEBBQADgY0AMIGJAoGBANYrWHhhRYZT6jR7UZztsOYuGA7+4F+o',
    'J9O0yeB8WU4WDnNUYMF/9p8u6TqFJBU820cEY8OexJQaWt9MevPZQx08EHp5JduQ/vBR5zDWQQD9',
    'nyjfeb6Uu522FOMjhdepQeBMpHmwKxqL8vg7ij5FrHGSALSQQZj7X+36ty6K+Ig3AgMBAAGjEzAR',
    'MA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQEEBQADgYEAZ9viwuaHPUCDhjc1fR/OmsMMZiCo',
    'uqoEiYbC9RAIDb/LogWK0E02PvTX72nGXuSwlG9KuefeW4i2e9vjJ+V2w/A1wcu1J5szedyQpgCe',
    'd/r8zSeUQhac0xxo7L9c3eWpexAKMnRUEzGLhQOEkbdYATAUOK8oyvyxUBkZCayJSdM=',
].join('');

const MICROSOFT_ROOT_CERTIFICATE_AUTHORITY = [
    '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',
    'nUr90aGdmUN3P7Da',
].join('');

const MICROSOFT_ROOT_2010 = [
    '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',
].join('');

const MICROSOFT_ROOT_2011 = [
    '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',
].join('');

/** @param {string} text */
const fromBase64 = text=>Uint8Array.from(atob(text), ch=>ch.charCodeAt(0));

/** The default root store, as DER. @returns {Uint8Array[]} */
export const defaultTrustedRoots = ()=>[MICROSOFT_ROOT_AUTHORITY, THAWTE_TIMESTAMPING_CA,
    MICROSOFT_ROOT_CERTIFICATE_AUTHORITY, MICROSOFT_ROOT_2010, MICROSOFT_ROOT_2011]
    .map(fromBase64);
