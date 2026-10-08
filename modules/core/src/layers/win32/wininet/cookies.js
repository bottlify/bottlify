/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The cookie jar InternetSetCookie fills and InternetGetCookie reads, and that
 * a request sends from and a response stores into.
 *
 * It lives as long as the run. A real machine keeps persistent cookies on
 * disk between sessions, but a program cannot tell a jar that was emptied
 * from one on a machine that never visited the site, and the second is what
 * a fresh run is.
 *
 * Matching follows the system's rules rather than a browser's: the domain
 * attribute widens a cookie to the domain's hosts, and a cookie's path is
 * compared with the *directory* of the URL asked about -- "/foo" is sent for
 * "/foobar/" (whose directory starts with it) but not for "/foobar" (whose
 * directory is "/").
 */

import { crackUrl } from './url.js';
import { parseInternetTime, timeValue } from './time.js';

const ERROR_INVALID_PARAMETER = 87;
const ERROR_NO_MORE_ITEMS = 259;
const ERROR_INTERNET_UNRECOGNIZED_SCHEME = 12006;

/**
 * @typedef {Object} Cookie
 * @property {string} name
 * @property {string} value
 * @property {string} domain    Lowercase, without a leading dot.
 * @property {boolean} hostOnly No domain attribute: this host and no other.
 * @property {string} path
 * @property {boolean} secure
 */

/** @typedef {{ error: number } | { text: string }} CookieAnswer */

/**
 * The parts of a URL a cookie is matched against, or the error a cookie call
 * answers for a URL that has none: no scheme is "unrecognized scheme", a
 * scheme that carries no cookies or a URL with no host is a bad parameter.
 *
 * @param {string} url
 * @returns {{ host: string, path: string, secure: boolean } | { error: number }}
 */
function placeOf(url){
    const cracked = crackUrl(url);
    if (!cracked)
    {
        return { error: ERROR_INTERNET_UNRECOGNIZED_SCHEME };
    }
    const scheme = cracked.scheme.text.toLowerCase();
    if ((scheme !== 'http' && scheme !== 'https') || cracked.host.text === '')
    {
        return { error: ERROR_INVALID_PARAMETER };
    }
    return {
        host: cracked.host.text.toLowerCase(),
        path: cracked.path.text || '/',
        secure: scheme === 'https',
    };
}

/** The directory of a URL path: everything up to and including its last "/". @param {string} path */
const directoryOf = path=>path.slice(0, path.lastIndexOf('/') + 1) || '/';

/**
 * @param {Object} [options]
 * @param {() => number} [options.now]  The guest's wall clock in milliseconds.
 *        Without it an expiry date is kept but never acted on: a cookie whose
 *        date has passed by the host's clock may not have by the guest's.
 */
export function createCookieJar({ now } = {}){
    /** @type {Cookie[]} */
    const cookies = [];

    /**
     * Stores, replaces or -- for a date already past -- removes one cookie.
     *
     * @param {string} url
     * @param {string | null} name  The cookie's name, when the caller gave it
     *        apart from the data rather than as "name=value" within it.
     * @param {string} data         "value; attribute=...; ..." or "name=value; ...".
     * @returns {{ error: number } | null} null when stored.
     */
    const set = (url, name, data)=>{
        const place = placeOf(url);
        if ('error' in place)
        {
            return place;
        }
        const [pair, ...attributes] = data.split(';');
        const equals = pair.indexOf('=');
        /** @type {Cookie} */
        const cookie = name !== null
            ? { name, value: pair.trim(), domain: place.host, hostOnly: true, path: '',
                secure: false }
            : {
                // A pair with no "=" is a name with an empty value.
                name: (equals === -1 ? pair : pair.slice(0, equals)).trim(),
                value: equals === -1 ? '' : pair.slice(equals + 1).trim(),
                domain: place.host, hostOnly: true, path: '', secure: false,
            };
        let expires = Number.NaN;
        for (const attribute of attributes)
        {
            const split = attribute.indexOf('=');
            const key = (split === -1 ? attribute : attribute.slice(0, split)).trim().toLowerCase();
            const value = split === -1 ? '' : attribute.slice(split + 1).trim();
            if (key === 'domain' && value !== '')
            {
                const domain = value.replace(/^\./, '').toLowerCase();
                // A site may widen a cookie to its own domain, never hand one
                // to another.
                if (place.host !== domain && !place.host.endsWith(`.${domain}`))
                {
                    return { error: ERROR_INVALID_PARAMETER };
                }
                cookie.domain = domain;
                cookie.hostOnly = false;
            }
            else if (key === 'path' && value !== '')
            {
                cookie.path = value;
            }
            else if (key === 'secure')
            {
                cookie.secure = true;
            }
            else if (key === 'expires' && value !== '')
            {
                expires = timeValue(parseInternetTime(value));
            }
        }
        cookie.path ||= directoryOf(place.path);

        const existing = cookies.findIndex(held=>held.name === cookie.name
            && held.domain === cookie.domain && held.hostOnly === cookie.hostOnly
            && held.path === cookie.path);
        // Setting a cookie with a date already gone is how a site deletes one.
        if (now && !Number.isNaN(expires) && expires <= now())
        {
            if (existing !== -1)
            {
                cookies.splice(existing, 1);
            }
            return null;
        }
        if (existing === -1)
        {
            cookies.push(cookie);
        }
        else
        {
            cookies[existing] = cookie;
        }
        return null;
    };

    /**
     * The Cookie header's value for a URL: every cookie that applies, in the
     * order they were first set, "name=value" joined by "; ". A cookie with an
     * empty value is written as its name alone.
     *
     * @param {string} url
     * @returns {CookieAnswer}
     */
    const get = url=>{
        const place = placeOf(url);
        if ('error' in place)
        {
            return place;
        }
        const directory = directoryOf(place.path);
        const sent = cookies.filter(cookie=>(cookie.hostOnly
            ? place.host === cookie.domain
            : place.host === cookie.domain || place.host.endsWith(`.${cookie.domain}`))
            && directory.startsWith(cookie.path)
            && (!cookie.secure || place.secure));
        if (sent.length === 0)
        {
            return { error: ERROR_NO_MORE_ITEMS };
        }
        return {
            text: sent.map(cookie=>(cookie.value === '' ? cookie.name
                : `${cookie.name}=${cookie.value}`)).join('; '),
        };
    };

    return { set, get };
}
