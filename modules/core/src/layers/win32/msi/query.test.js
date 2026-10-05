/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyDatabase } from './database.js';
import {
    ERROR_BAD_QUERY_SYNTAX, ERROR_FUNCTION_FAILED, ERROR_SUCCESS, MSIMODIFY, columnInfo, openView,
} from './query.js';
import { createRecord, getString } from './record.js';

/** @param {import('./database.js').Database} db @param {string} text @param {any[]} [params] */
const run = (db, text, params)=>{
    const opened = openView(db, text);
    if ('error' in opened)
    {
        return { code: opened.error, rows: [] };
    }
    /** @type {import('./record.js').Record | null} */
    let record = null;
    if (params)
    {
        record = createRecord(params.length);
        params.forEach((value, index)=>{
            /** @type {any} */ (record).fields[index + 1] = value;
        });
    }
    const code = opened.view.execute(record);
    /** @type {any[][]} */
    const rows = [];
    for (let fetched = opened.view.fetch(); fetched; fetched = opened.view.fetch())
    {
        rows.push(fetched.fields.slice(1));
    }
    return { code, rows, view: opened.view };
};

const phonebook = ()=>{
    const db = createEmptyDatabase();
    assert.equal(run(db, 'CREATE TABLE `phone` ( `id` INT, `name` CHAR(32), `number` CHAR(32) '
        + 'PRIMARY KEY `id`)').code, ERROR_SUCCESS);
    for (const [id, name, number] of [[1, 'Abe', '8675309'], [2, 'Cindy', '2937550'],
        [3, 'Wack', '2328']])
    {
        assert.equal(run(db, 'INSERT INTO `phone` ( `id`, `name`, `number` ) VALUES ( ?, ?, ? )',
            [id, name, number]).code, ERROR_SUCCESS);
    }
    return db;
};

test('statements this dialect does not have are a syntax error when the view is opened', ()=>{
    const db = phonebook();
    for (const bad of ['select * from', 'select * from c', 'select * from `phone` where',
        'select * from `phone` where id = \'x', 'select * from \'phone\'', 'CREATE TABLE `phone` '
        + '( `id` INT PRIMARY KEY `id`)', 'SELECT `nothere` FROM `phone`', 'DROP TABLE `none`',
        'INSERT INTO `phone` ( `id` ) VALUES ( 1, 2 )', 'SELECT * FROM `phone` ORDER `id`'])
    {
        assert.equal(run(db, bad).code, ERROR_BAD_QUERY_SYNTAX, bad);
    }
    assert.equal(run(db, 'select * from `phone` WHERE `id` = 1').code, ERROR_SUCCESS,
        'keywords in either case');
});

test('a clause compares integers as integers and strings for equality only', ()=>{
    const db = phonebook();
    assert.deepEqual(run(db, 'SELECT `name` FROM `phone` WHERE `id` > 1').rows,
        [['Cindy'], ['Wack']]);
    assert.deepEqual(run(db, 'SELECT `id` FROM `phone` WHERE `name` = \'Wack\' OR `id` = 1').rows,
        [[1], [3]]);
    assert.deepEqual(run(db, 'SELECT `id` FROM `phone` WHERE `name` < \'Z\'').rows, [],
        'no ordering of strings');
    assert.deepEqual(run(db, 'SELECT `id` FROM `phone` WHERE `name`=? AND `id`<>?',
        ['Abe', 2]).rows, [[1]], 'parameters in the order the clause names them');
    assert.deepEqual(run(db, 'SELECT `id` FROM `phone` WHERE ( `id` = 1 OR `id` = 3 ) AND '
        + '`number` <> \'2328\'').rows, [[1]]);
});

test('null strings equal empty ones, and a null integer sorts below every value', ()=>{
    const db = phonebook();
    run(db, 'INSERT INTO `phone` ( `id` ) VALUES ( 4 )');
    assert.deepEqual(run(db, 'SELECT `id` FROM `phone` WHERE `name` = \'\'').rows, [[4]]);
    assert.deepEqual(run(db, 'SELECT `id` FROM `phone` WHERE `name` IS NULL').rows, [[4]]);
    assert.deepEqual(run(db, 'SELECT `id` FROM `phone` WHERE `name` IS NOT NULL').rows,
        [[1], [2], [3]]);
    run(db, 'CREATE TABLE `T` ( `k` CHAR(8), `n` SHORT PRIMARY KEY `k`)');
    run(db, 'INSERT INTO `T` ( `k`, `n` ) VALUES ( \'a\', -5 )');
    run(db, 'INSERT INTO `T` ( `k` ) VALUES ( \'b\' )');
    assert.deepEqual(run(db, 'SELECT `k` FROM `T` WHERE `n` < -4').rows, [['a'], ['b']],
        'null is the encoding\'s zero: below -5');
});

test('ORDER BY a string orders by its place in the pool, DISTINCT drops repeats', ()=>{
    const db = createEmptyDatabase();
    run(db, 'CREATE TABLE `T` ( `k` INT, `s` CHAR(8) PRIMARY KEY `k`)');
    // The pool numbers strings as they arrive: "zebra" first.
    for (const [k, s] of [[1, 'zebra'], [2, 'apple'], [3, 'zebra'], [4, 'mango']])
    {
        run(db, 'INSERT INTO `T` ( `k`, `s` ) VALUES ( ?, ? )', [k, s]);
    }
    assert.deepEqual(run(db, 'SELECT `k` FROM `T` ORDER BY `s`').rows, [[1], [3], [2], [4]]);
    assert.deepEqual(run(db, 'SELECT DISTINCT `s` FROM `T`').rows,
        [['zebra'], ['apple'], ['mango']]);
});

test('rows join across tables, and a column can be named with its table', ()=>{
    const db = phonebook();
    run(db, 'CREATE TABLE `owner` ( `pid` INT, `who` CHAR(8) PRIMARY KEY `pid`)');
    run(db, 'INSERT INTO `owner` ( `pid`, `who` ) VALUES ( 3, \'me\' )');
    assert.deepEqual(run(db, 'SELECT `phone`.`name`, `who` FROM `phone`, `owner` '
        + 'WHERE `phone`.`id` = `owner`.`pid`').rows, [['Wack', 'me']]);
});

test('a view\'s rows are changed through the view, by the modes MsiViewModify takes', ()=>{
    const db = phonebook();
    const { view } = /** @type {any} */ (run(db, 'SELECT `id`, `name` FROM `phone`'));
    view.execute(null);
    const first = view.fetch();
    first.fields[2] = 'Abraham';
    assert.equal(view.modify(MSIMODIFY.UPDATE, first), ERROR_SUCCESS);
    assert.deepEqual(run(db, 'SELECT `name` FROM `phone` WHERE `id` = 1').rows, [['Abraham']]);
    first.fields[1] = 9;
    assert.equal(view.modify(MSIMODIFY.UPDATE, first), ERROR_FUNCTION_FAILED,
        'a key is not changed by an update');

    const fresh = createRecord(2);
    fresh.fields[1] = 2;
    assert.equal(view.modify(MSIMODIFY.SEEK, fresh), ERROR_SUCCESS);
    assert.equal(getString(fresh, 2), 'Cindy');
    assert.equal(view.modify(MSIMODIFY.UPDATE, createRecord(2)), ERROR_FUNCTION_FAILED,
        'only a record the view fetched');

    const added = createRecord(2);
    added.fields[1] = 7;
    added.fields[2] = 'Neo';
    assert.equal(view.modify(MSIMODIFY.INSERT, added), ERROR_SUCCESS);
    assert.equal(view.modify(MSIMODIFY.INSERT, added), ERROR_FUNCTION_FAILED, 'the key is taken');
    assert.equal(view.modify(MSIMODIFY.MERGE, added), ERROR_SUCCESS, 'the same row merges');
    added.fields[2] = 'Trinity';
    assert.equal(view.modify(MSIMODIFY.MERGE, added), ERROR_FUNCTION_FAILED);
    assert.equal(view.modify(MSIMODIFY.ASSIGN, added), ERROR_SUCCESS);
    assert.deepEqual(run(db, 'SELECT `name` FROM `phone` WHERE `id` = 7').rows, [['Trinity']]);
    assert.equal(view.modify(MSIMODIFY.DELETE, added), ERROR_SUCCESS);
    assert.deepEqual(run(db, 'SELECT `id` FROM `phone`').rows, [[1], [2], [3]]);
});

test('a session\'s database changes only in temporary rows and tables', ()=>{
    const db = phonebook();
    db.readOnly = true;
    assert.equal(run(db, 'INSERT INTO `phone` ( `id` ) VALUES ( 5 )').code, ERROR_FUNCTION_FAILED);
    assert.equal(run(db, 'INSERT INTO `phone` ( `id` ) VALUES ( 5 ) TEMPORARY').code,
        ERROR_SUCCESS);
    assert.equal(run(db, 'UPDATE `phone` SET `name` = \'x\' WHERE `id` = 5').code, ERROR_SUCCESS);
    assert.equal(run(db, 'UPDATE `phone` SET `name` = \'x\' WHERE `id` = 1').code,
        ERROR_FUNCTION_FAILED);
    assert.equal(run(db, 'DELETE FROM `phone` WHERE `id` = 5').code, ERROR_SUCCESS);
    assert.equal(run(db, 'CREATE TABLE `t` ( `a` INT PRIMARY KEY `a`)').code,
        ERROR_FUNCTION_FAILED);
    assert.equal(run(db, 'CREATE TABLE `t` ( `a` INT TEMPORARY PRIMARY KEY `a`) HOLD').code,
        ERROR_SUCCESS);
    assert.equal(run(db, 'INSERT INTO `t` ( `a` ) VALUES ( 1 )').code, ERROR_SUCCESS);
    assert.equal(run(db, 'ALTER TABLE `t` FREE').code, ERROR_SUCCESS);
    assert.equal(db.table('t'), null, 'freed for the last time, a temporary table goes');
});

test('column information spells each type as a letter and a size', ()=>{
    const db = createEmptyDatabase();
    run(db, 'CREATE TABLE `T` ( `a` CHAR(255) NOT NULL, `b` SHORT NOT NULL, `c` INT, '
        + '`d` LONG NOT NULL, `e` LONG, `f` CHAR(255), `g` LONGCHAR LOCALIZABLE, '
        + '`h` OBJECT PRIMARY KEY `a`)');
    const { view } = /** @type {any} */ (openView(db, 'SELECT * FROM `T`'));
    const types = columnInfo(view.columns, null, 'types').fields.slice(1);
    assert.deepEqual(types, ['s255', 'i2', 'I2', 'i4', 'I4', 'S255', 'L0', 'V0']);
    assert.deepEqual(columnInfo(view.columns, null, 'names').fields.slice(1),
        ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
});

test('UPDATE takes its SET values before the clause\'s parameters', ()=>{
    const db = phonebook();
    assert.equal(run(db, 'UPDATE `phone` SET `name` = ? WHERE `id` = ?', ['Bea', 2]).code,
        ERROR_SUCCESS);
    assert.deepEqual(run(db, 'SELECT `name` FROM `phone` WHERE `id` = 2').rows, [['Bea']]);
});
