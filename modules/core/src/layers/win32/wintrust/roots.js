/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The root certificates the verifier trusts unless it is configured with others.
 *
 * One: Microsoft's "Microsoft Root Authority" (1997-01-10 to 2020-12-31, SHA-1
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

/** @param {string} text */
const fromBase64 = text=>Uint8Array.from(atob(text), ch=>ch.charCodeAt(0));

/** The default root store, as DER. @returns {Uint8Array[]} */
export const defaultTrustedRoots = ()=>[MICROSOFT_ROOT_AUTHORITY, THAWTE_TIMESTAMPING_CA]
    .map(fromBase64);
