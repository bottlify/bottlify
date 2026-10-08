/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The installer's SQL: the small dialect MsiDatabaseOpenView parses.
 *
 * It is not SQL as a database server speaks it. A statement is one of
 * SELECT, INSERT, UPDATE, DELETE, CREATE TABLE, ALTER TABLE and DROP TABLE;
 * a WHERE clause compares a column with a value or another column and joins
 * comparisons with AND and OR; a value is an integer, a string in single
 * quotes, NULL or `?`, a parameter the execute call's record supplies; names
 * may be quoted in backquotes; keywords are matched without regard to case.
 * Anything else is a syntax error, which is what a program that builds a
 * query from pieces is told when a piece is wrong.
 */

/** Thrown for a statement this dialect does not have. */
export class SqlError extends Error {}

const KEYWORDS = new Set([
    'ADD', 'ALTER', 'AND', 'BY', 'CHAR', 'CHARACTER', 'CREATE', 'DELETE', 'DISTINCT', 'DROP',
    'FREE', 'FROM', 'HOLD', 'INSERT', 'INT', 'INTEGER', 'INTO', 'IS', 'KEY', 'LIKE',
    'LOCALIZABLE', 'LONG', 'LONGCHAR', 'NOT', 'NULL', 'OBJECT', 'OR', 'ORDER', 'PRIMARY',
    'SELECT', 'SET', 'SHORT', 'TABLE', 'TEMPORARY', 'UPDATE', 'VALUES', 'WHERE',
]);

/**
 * @typedef {{ kind: 'id' | 'string' | 'integer' | 'keyword' | 'symbol', text: string }} Token
 */

/** What may continue an unquoted name: letters, digits, `_` and anything past ASCII. */
// U+0005 begins the summary stream's name, which a query may spell.
const NAME_CHARACTER = {
    /** @param {string} character */
    test: character=>{
        const code = character.charCodeAt(0);
        return /[A-Za-z0-9_]/.test(character) || code === 5 || code >= 0x80;
    },
};

/**
 * @param {string} text @returns {Token[]}
 */
export function tokenize(text){
    /** @type {Token[]} */
    const tokens = [];
    let at = 0;
    while (at < text.length)
    {
        const character = text[at];
        if (' \t\n\f\r'.includes(character))
        {
            at++;
            continue;
        }
        if (character === '`' || character === '\'')
        {
            const end = text.indexOf(character, at + 1);
            if (end < 0)
            {
                throw new SqlError('an unterminated quote');
            }
            tokens.push({ kind: character === '`' ? 'id' : 'string',
                text: text.slice(at + 1, end) });
            at = end + 1;
            continue;
        }
        if (character === '[')
        {
            const end = text.indexOf(']', at);
            tokens.push({ kind: 'id', text: text.slice(at + 1, end < 0 ? text.length : end) });
            at = end < 0 ? text.length : end + 1;
            continue;
        }
        if (/[0-9]/.test(character))
        {
            let end = at + 1;
            while (end < text.length && /[0-9]/.test(text[end]))
            {
                end++;
            }
            tokens.push({ kind: 'integer', text: text.slice(at, end) });
            at = end;
            continue;
        }
        const two = text.slice(at, at + 2);
        if (two === '<=' || two === '>=' || two === '<>' || two === '!=')
        {
            tokens.push({ kind: 'symbol', text: two === '!=' ? '<>' : two });
            at += 2;
            continue;
        }
        if ('()*=<>?,.-'.includes(character))
        {
            tokens.push({ kind: 'symbol', text: character });
            at++;
            continue;
        }
        if (NAME_CHARACTER.test(character))
        {
            let end = at + 1;
            while (end < text.length && NAME_CHARACTER.test(text[end]))
            {
                end++;
            }
            const word = text.slice(at, end);
            tokens.push(KEYWORDS.has(word.toUpperCase())
                ? { kind: 'keyword', text: word.toUpperCase() } : { kind: 'id', text: word });
            at = end;
            continue;
        }
        throw new SqlError(`an unexpected ${JSON.stringify(character)}`);
    }
    return tokens;
}

/**
 * @typedef {{ table: string | null, name: string }} ColumnRef
 * @typedef {{ kind: 'integer', value: number } | { kind: 'string', value: string }
 *     | { kind: 'null' } | { kind: 'parameter' }} Constant
 * @typedef {{ kind: 'and' | 'or', left: Expression, right: Expression }
 *     | { kind: 'compare', op: '=' | '<>' | '<' | '>' | '<=' | '>=', left: ColumnRef,
 *         right: { column: ColumnRef } | { constant: Constant } }
 *     | { kind: 'null' | 'notnull', column: ColumnRef }} Expression
 * @typedef {{ name: string, type: number }} ColumnDefinition
 *     `type` in MSITYPE bits, as _Columns keeps it.
 * @typedef {{ kind: 'select', distinct: boolean,
 *         columns: (ColumnRef | { string: string })[] | null,
 *         tables: string[], where: Expression | null, order: ColumnRef[] }
 *     | { kind: 'insert', table: string, columns: string[], values: Constant[],
 *         temporary: boolean }
 *     | { kind: 'update', table: string, set: { column: string, value: Constant }[],
 *         where: Expression | null }
 *     | { kind: 'delete', tables: string[], where: Expression | null }
 *     | { kind: 'create', table: string, columns: ColumnDefinition[], keys: string[],
 *         hold: boolean, temporary: boolean }
 *     | { kind: 'alter', table: string, op: 'hold' | 'free' | 'add', column?: ColumnDefinition,
 *         hold: boolean }
 *     | { kind: 'drop', table: string }} Statement
 */

/** Column type bits, as the database module keeps them. */
const VALID = 0x0100;
const LOCALIZABLE = 0x0200;
const STRING = 0x0800;
const NULLABLE = 0x1000;
const KEY = 0x2000;
const TEMPORARY = 0x4000;
/** A bit stored tables set on every string and short column, and the parser with them. */
const SIZED = 0x0400;

/**
 * @param {string} text @returns {Statement}
 * @throws {SqlError}
 */
export function parseStatement(text){
    const tokens = tokenize(text);
    let at = 0;
    const peek = (offset = 0)=>tokens[at + offset];
    /** @param {string} word */
    const isKeyword = word=>peek()?.kind === 'keyword' && peek().text === word;
    /** @param {string} symbol */
    const isSymbol = symbol=>peek()?.kind === 'symbol' && peek().text === symbol;
    /** @param {string} word */
    const keyword = word=>{
        if (!isKeyword(word))
        {
            throw new SqlError(`expected ${word}`);
        }
        at++;
    };
    /** @param {string} wanted */
    const symbol = wanted=>{
        if (!isSymbol(wanted))
        {
            throw new SqlError(`expected ${wanted}`);
        }
        at++;
    };
    /** @param {string} word */
    const optionalKeyword = word=>{
        if (isKeyword(word))
        {
            at++;
            return true;
        }
        return false;
    };
    const name = ()=>{
        const token = peek();
        if (token?.kind !== 'id')
        {
            throw new SqlError('expected a name');
        }
        at++;
        return token.text;
    };
    /** @returns {ColumnRef} */
    const columnRef = ()=>{
        const first = name();
        if (isSymbol('.'))
        {
            at++;
            return { table: first, name: name() };
        }
        return { table: null, name: first };
    };
    /** @param {() => any} item */
    const list = item=>{
        const items = [item()];
        while (isSymbol(','))
        {
            at++;
            items.push(item());
        }
        return items;
    };
    /** @returns {Constant} */
    const constant = ()=>{
        const token = peek();
        if (isSymbol('-') && peek(1)?.kind === 'integer')
        {
            at += 2;
            return { kind: 'integer', value: -Number(tokens[at - 1].text) };
        }
        if (token?.kind === 'integer')
        {
            at++;
            return { kind: 'integer', value: Number(token.text) };
        }
        if (token?.kind === 'string')
        {
            at++;
            return { kind: 'string', value: token.text };
        }
        if (isSymbol('?'))
        {
            at++;
            return { kind: 'parameter' };
        }
        if (isKeyword('NULL'))
        {
            at++;
            return { kind: 'null' };
        }
        throw new SqlError('expected a value');
    };

    /** @returns {Expression} */
    const comparison = ()=>{
        if (isSymbol('('))
        {
            at++;
            const inner = expression();
            symbol(')');
            return inner;
        }
        const column = columnRef();
        if (isKeyword('IS'))
        {
            at++;
            const not = optionalKeyword('NOT');
            keyword('NULL');
            return { kind: not ? 'notnull' : 'null', column };
        }
        const op = peek();
        if (op?.kind !== 'symbol' || !['=', '<>', '<', '>', '<=', '>='].includes(op.text))
        {
            throw new SqlError('expected a comparison');
        }
        at++;
        const right = peek()?.kind === 'id' ? { column: columnRef() } : { constant: constant() };
        return { kind: 'compare', op: /** @type {any} */ (op.text), left: column, right };
    };
    /** @returns {Expression} */
    const conjunction = ()=>{
        let left = comparison();
        while (isKeyword('AND'))
        {
            at++;
            left = { kind: 'and', left, right: comparison() };
        }
        return left;
    };
    /** @returns {Expression} */
    const expression = ()=>{
        let left = conjunction();
        while (isKeyword('OR'))
        {
            at++;
            left = { kind: 'or', left, right: conjunction() };
        }
        return left;
    };

    /** FROM tables [WHERE expr] [ORDER BY columns], as SELECT and DELETE share it. */
    const from = ()=>{
        keyword('FROM');
        const tables = list(name);
        const where = optionalKeyword('WHERE') ? expression() : null;
        /** @type {ColumnRef[]} */
        let order = [];
        if (optionalKeyword('ORDER'))
        {
            keyword('BY');
            order = list(columnRef);
        }
        return { tables, where, order };
    };

    /**
     * A column's type as CREATE and ALTER spell it, in the bits `_Columns`
     * keeps: a string or short integer carries 0x400 as stored tables do, a
     * long does not, an object is a stream, and every type is nullable unless
     * NOT NULL says otherwise.
     *
     * @returns {ColumnDefinition}
     */
    const columnDefinition = ()=>{
        const column = name();
        let type;
        if (optionalKeyword('CHAR') || optionalKeyword('CHARACTER'))
        {
            type = STRING | SIZED;
            if (isSymbol('('))
            {
                at++;
                const count = peek();
                if (count?.kind !== 'integer')
                {
                    throw new SqlError('expected a length');
                }
                at++;
                type |= Number(count.text) & 0xff;
                symbol(')');
            }
        }
        else if (optionalKeyword('LONGCHAR'))
        {
            type = STRING | SIZED;
        }
        else if (optionalKeyword('SHORT') || optionalKeyword('INT') || optionalKeyword('INTEGER'))
        {
            type = SIZED | 2;
        }
        else if (optionalKeyword('LONG'))
        {
            type = 4;
        }
        else if (optionalKeyword('OBJECT'))
        {
            type = STRING | VALID;
        }
        else
        {
            throw new SqlError('expected a column type');
        }
        if (optionalKeyword('NOT'))
        {
            keyword('NULL');
        }
        else
        {
            type |= NULLABLE;
        }
        if (optionalKeyword('LOCALIZABLE'))
        {
            type |= LOCALIZABLE;
        }
        else if (optionalKeyword('TEMPORARY'))
        {
            type |= TEMPORARY;
        }
        return { name: column, type };
    };

    /** @returns {Statement} */
    const statement = ()=>{
        if (optionalKeyword('SELECT'))
        {
            const distinct = optionalKeyword('DISTINCT');
            /** @type {(ColumnRef | { string: string })[] | null} */
            let columns = null;
            if (isSymbol('*'))
            {
                at++;
            }
            else
            {
                columns = list(()=>{
                    const token = peek();
                    if (token?.kind === 'string')
                    {
                        at++;
                        return { string: token.text };
                    }
                    return columnRef();
                });
            }
            return { kind: 'select', distinct, columns, ...from() };
        }
        if (optionalKeyword('INSERT'))
        {
            keyword('INTO');
            const table = name();
            symbol('(');
            const columns = list(name);
            symbol(')');
            keyword('VALUES');
            symbol('(');
            const values = list(constant);
            symbol(')');
            const temporary = optionalKeyword('TEMPORARY');
            if (columns.length !== values.length)
            {
                throw new SqlError('as many values as columns');
            }
            return { kind: 'insert', table, columns, values, temporary };
        }
        if (optionalKeyword('UPDATE'))
        {
            const table = name();
            keyword('SET');
            const set = list(()=>{
                const column = name();
                symbol('=');
                return { column, value: constant() };
            });
            const where = optionalKeyword('WHERE') ? expression() : null;
            return { kind: 'update', table, set, where };
        }
        if (optionalKeyword('DELETE'))
        {
            const { tables, where } = from();
            return { kind: 'delete', tables, where };
        }
        if (optionalKeyword('CREATE'))
        {
            keyword('TABLE');
            const table = name();
            symbol('(');
            const columns = list(columnDefinition);
            keyword('PRIMARY');
            keyword('KEY');
            const keys = list(name);
            symbol(')');
            const hold = optionalKeyword('HOLD');
            for (const key of keys)
            {
                const column = columns.find(entry=>entry.name === key);
                if (!column)
                {
                    throw new SqlError(`no column ${key} to be a key`);
                }
                column.type |= KEY;
            }
            const temporary = columns.every(column=>(column.type & TEMPORARY) !== 0);
            return { kind: 'create', table, columns, keys, hold, temporary };
        }
        if (optionalKeyword('ALTER'))
        {
            keyword('TABLE');
            const table = name();
            if (optionalKeyword('HOLD'))
            {
                return { kind: 'alter', table, op: 'hold', hold: true };
            }
            if (optionalKeyword('FREE'))
            {
                return { kind: 'alter', table, op: 'free', hold: false };
            }
            keyword('ADD');
            const column = columnDefinition();
            return { kind: 'alter', table, op: 'add', column, hold: optionalKeyword('HOLD') };
        }
        if (optionalKeyword('DROP'))
        {
            keyword('TABLE');
            return { kind: 'drop', table: name() };
        }
        throw new SqlError('not a statement');
    };

    const parsed = statement();
    if (at !== tokens.length)
    {
        throw new SqlError('more after the statement');
    }
    return parsed;
}
