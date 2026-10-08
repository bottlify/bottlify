/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A major upgrade: the Upgrade table names earlier products by their upgrade
 * code, a range of versions and languages. FindRelatedProducts puts the
 * installed ones that match into each row's property, MigrateFeatureStates
 * carries their features' states over to the new installation, and
 * RemoveExistingProducts removes them -- each a removal of its own, run from
 * the package the machine kept for it.
 */

import { INSTALLSTATE } from './session.js';
import { ERROR_INSTALL_FAILURE, ERROR_SUCCESS, schedule } from './steps.js';

/** @typedef {import('./engine.js').Engine} Engine */

/** The Upgrade table's Attributes. */
const UPGRADE = Object.freeze({
    MIGRATE_FEATURES: 0x1, ONLY_DETECT: 0x2, IGNORE_REMOVE_FAILURE: 0x4,
    VERSION_MIN_INCLUSIVE: 0x100, VERSION_MAX_INCLUSIVE: 0x200, LANGUAGES_EXCLUSIVE: 0x400,
});

/**
 * A version as Windows compares a product's: major, minor and build packed
 * into one number, the fourth field not counted.
 *
 * @param {string} text @returns {number}
 */
export function packedVersion(text){
    const [major = 0, minor = 0, build = 0] = text.split('.').map(part=>Number.parseInt(part, 10)
        || 0);
    return ((major & 0xff) * 0x1000000) + ((minor & 0xff) * 0x10000) + (build & 0xffff);
}

/**
 * Whether an installed product falls in an Upgrade row's range: its version
 * between the bounds, each inclusive only when the row says so, and its
 * language in the list -- or out of it, for an exclusive list.
 *
 * @param {import('./database.js').Row} row
 * @param {{ version: number, language: number }} product
 */
export function inRange(row, product){
    const attributes = Number(row[4] ?? 0);
    if (row[1] !== null && String(row[1]) !== '')
    {
        const min = packedVersion(String(row[1]));
        if (product.version < min || (product.version === min
            && (attributes & UPGRADE.VERSION_MIN_INCLUSIVE) === 0))
        {
            return false;
        }
    }
    if (row[2] !== null && String(row[2]) !== '')
    {
        const max = packedVersion(String(row[2]));
        if (product.version > max || (product.version === max
            && (attributes & UPGRADE.VERSION_MAX_INCLUSIVE) === 0))
        {
            return false;
        }
    }
    const languages = row[3] === null ? [] : String(row[3]).split(',')
        .map(part=>Number.parseInt(part, 10)).filter(value=>!Number.isNaN(value));
    if (languages.length > 0)
    {
        const listed = languages.includes(product.language);
        return (attributes & UPGRADE.LANGUAGES_EXCLUSIVE) !== 0 ? !listed : listed;
    }
    return true;
}

/**
 * An installed product's version and language, as its registration keeps them.
 *
 * @param {Engine} engine @param {string} productCode
 */
function installedProduct(engine, productCode){
    const info = (/** @type {string} */ name)=>{
        const answer = engine.host.registration.productInfo(productCode, name);
        return 'value' in answer ? answer.value : '';
    };
    return { version: packedVersion(info('VersionString')),
        language: Number.parseInt(info('Language'), 10) || 0 };
}

/**
 * FindRelatedProducts: each installed product of a row's upgrade code that
 * falls in its range, added to the row's property -- this product never
 * among them.
 *
 * @param {Engine} engine
 */
async function findRelatedProducts(engine){
    const { session, host } = engine;
    const self = session.getProperty('ProductCode').toUpperCase();
    for (const row of session.db.table('Upgrade')?.rows ?? [])
    {
        if (row[6] === null)
        {
            continue;
        }
        const found = host.registration.relatedProducts(String(row[0] ?? ''))
            .filter(product=>product.toUpperCase() !== self)
            .filter(product=>inRange(row, installedProduct(engine, product)));
        if (found.length === 0)
        {
            continue;
        }
        const property = String(row[6]);
        const existing = session.getProperty(property).split(';').filter(Boolean);
        session.setProperty(property, [...new Set([...existing, ...found])].join(';'));
    }
    return ERROR_SUCCESS;
}

/**
 * The products a row's property found, for rows that do more than detect.
 *
 * @param {Engine} engine
 * @returns {{ row: import('./database.js').Row, products: string[] }[]}
 */
function upgrading(engine){
    const { session } = engine;
    return (session.db.table('Upgrade')?.rows ?? [])
        .filter(row=>row[6] !== null && (Number(row[4] ?? 0) & UPGRADE.ONLY_DETECT) === 0)
        .map(row=>({ row, products: session.getProperty(String(row[6])).split(';')
            .filter(Boolean) }))
        .filter(entry=>entry.products.length > 0);
}

/**
 * MigrateFeatureStates: on a first installation with no features asked for,
 * each feature an earlier product had installed is installed again, and the
 * states settle from there.
 *
 * @param {Engine} engine
 */
async function migrateFeatureStates(engine){
    const { session, host } = engine;
    const asked = ['ADDLOCAL', 'ADDSOURCE', 'ADDDEFAULT', 'REMOVE', 'REINSTALL']
        .some(name=>session.getProperty(name) !== '');
    if (session.getProperty('Installed') !== '' || asked)
    {
        return ERROR_SUCCESS;
    }
    let migrated = false;
    for (const { row, products } of upgrading(engine))
    {
        if ((Number(row[4] ?? 0) & UPGRADE.MIGRATE_FEATURES) === 0)
        {
            continue;
        }
        for (const product of products)
        {
            for (const feature of session.features.values())
            {
                if (host.registration.featureInstalled(product, feature.key))
                {
                    feature.request = INSTALLSTATE.LOCAL;
                    migrated = true;
                }
            }
        }
    }
    if (migrated)
    {
        session.settleStates();
    }
    return ERROR_SUCCESS;
}

/**
 * RemoveExistingProducts: each earlier product removed -- the features the
 * row's Remove column names, every one when it names none -- and the
 * installation stopped by a removal that fails, unless the row ignores it.
 *
 * @param {Engine} engine
 */
async function removeExistingProducts(engine){
    const { session, host } = engine;
    for (const { row, products } of upgrading(engine))
    {
        const remove = row[5] === null ? 'ALL' : session.formatText(String(row[5])) || 'ALL';
        const ignore = (Number(row[4] ?? 0) & UPGRADE.IGNORE_REMOVE_FAILURE) !== 0;
        for (const product of products)
        {
            const code = await schedule(engine, 'RemoveExistingProducts', async()=>{
                const answer = await host.removeProduct?.(product, remove) ?? null;
                if (answer === null)
                {
                    host.divergence?.('RemoveExistingProducts', 'no installer to remove with');
                    return ERROR_SUCCESS;
                }
                return answer === ERROR_SUCCESS || ignore ? ERROR_SUCCESS : ERROR_INSTALL_FAILURE;
            });
            if (code !== ERROR_SUCCESS)
            {
                return code;
            }
        }
    }
    return ERROR_SUCCESS;
}

/**
 * The upgrade actions, by name, for the table of standard actions.
 *
 * @type {Record<string, (engine: Engine) => Promise<number>>}
 */
export const UPGRADE_ACTIONS = {
    FindRelatedProducts: findRelatedProducts,
    MigrateFeatureStates: migrateFeatureStates,
    RemoveExistingProducts: removeExistingProducts,
};
