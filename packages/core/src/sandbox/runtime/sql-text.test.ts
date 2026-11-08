import { describe, expect, it } from 'vitest';
import {
  SqlTextError,
  assertReadOnlySql,
  assertSafeScript,
  compileNamedParams,
  splitTopLevelStatements,
  stripCommentsAndStrings,
} from './sql-text.js';

describe('compileNamedParams', () => {
  it('converts named params to positional and collects values in order', () => {
    const r = compileNamedParams('select * from t where a = :a and b = :b', { a: 1, b: 'x' });
    expect(r.text).toBe('select * from t where a = $1 and b = $2');
    expect(r.values).toEqual([1, 'x']);
    expect(r.names).toEqual(['a', 'b']);
  });

  it('reuses the same index for repeated names', () => {
    const r = compileNamedParams('select :a, :b, :a', { a: 1, b: 2 });
    expect(r.text).toBe('select $1, $2, $1');
    expect(r.values).toEqual([1, 2]);
    expect(r.names).toEqual(['a', 'b']);
  });

  it('returns null for missing args', () => {
    const r = compileNamedParams('select :nope', {});
    expect(r.values).toEqual([null]);
  });

  it('does not read inherited properties as args', () => {
    const r = compileNamedParams('select :toString', {});
    expect(r.values).toEqual([null]);
  });

  it('leaves :: casts alone', () => {
    expect(compileNamedParams('select x::int from t', {}).text).toBe('select x::int from t');
    expect(compileNamedParams('select :a::text', { a: 1 }).text).toBe('select $1::text');
    expect(compileNamedParams('select :a::text::varchar', { a: 1 }).text).toBe('select $1::text::varchar');
  });

  it('does not treat array slices as params', () => {
    const r = compileNamedParams('select arr[1:2], arr[:3] from t where x = :x', { x: 1 });
    expect(r.text).toBe('select arr[1:2], arr[:3] from t where x = $1');
    expect(r.names).toEqual(['x']);
  });

  it('ignores params in single-quoted strings, including escaped quotes', () => {
    const r = compileNamedParams("select ':a', 'it''s :b', :c", { a: 1, b: 2, c: 3 });
    expect(r.text).toBe("select ':a', 'it''s :b', $1");
    expect(r.names).toEqual(['c']);
  });

  it('handles E-strings with backslash-escaped quotes', () => {
    const r = compileNamedParams("select E'it\\'s :a', :b", { a: 1, b: 2 });
    expect(r.text).toBe("select E'it\\'s :a', $1");
    expect(r.values).toEqual([2]);
  });

  it('does not treat a backslash as an escape in plain strings', () => {
    const r = compileNamedParams("select 'a\\', :b", { b: 2 });
    expect(r.text).toBe("select 'a\\', $1");
  });

  it('does not treat identifiers ending in e as E-string prefix', () => {
    const r = compileNamedParams("select name'x\\' , :b", { b: 2 });
    // name'x\' is a plain string 'x\' followed by ", :b"
    expect(r.names).toEqual(['b']);
  });

  it('ignores params in double-quoted identifiers', () => {
    const r = compileNamedParams('select "col:a" from t where x = :x', { x: 1 });
    expect(r.text).toBe('select "col:a" from t where x = $1');
  });

  it('ignores params in dollar-quoted bodies', () => {
    const r = compileNamedParams('select $$ :x $$, $tag$ :y $$ still $tag$, :z', { x: 1, y: 2, z: 3 });
    expect(r.text).toBe('select $$ :x $$, $tag$ :y $$ still $tag$, $1');
    expect(r.names).toEqual(['z']);
  });

  it('ignores params in line and block comments (nested)', () => {
    const sql = 'select 1 -- :a\n, :b /* :c /* :d */ :e */, :f';
    const r = compileNamedParams(sql, {});
    expect(r.text).toBe('select 1 -- :a\n, $1 /* :c /* :d */ :e */, $2');
    expect(r.names).toEqual(['b', 'f']);
  });

  it('throws on positional params outside strings and comments', () => {
    expect(() => compileNamedParams('select $1', {})).toThrow(SqlTextError);
    expect(() => compileNamedParams('select :a, $2', { a: 1 })).toThrow(SqlTextError);
  });

  it('allows $1 inside strings, comments and dollar quotes', () => {
    expect(() => compileNamedParams("select '$1', $$ $2 $$ -- $3\n/* $4 */", {})).not.toThrow();
  });

  it('converts values', () => {
    const date = new Date('2024-01-02T03:04:05.000Z');
    const r = compileNamedParams('select :u, :o, :arr, :d, :s, :n, :t, :nul, :big', {
      u: undefined,
      o: { a: 1 },
      arr: [1, 2],
      d: date,
      s: 'str',
      n: 4.5,
      t: true,
      nul: null,
      big: 12345678901234567890n,
    });
    expect(r.values).toEqual([
      null,
      '{"a":1}',
      '[1,2]',
      '2024-01-02T03:04:05.000Z',
      'str',
      4.5,
      true,
      null,
      '12345678901234567890',
    ]);
  });

  it('throws on unsupported value types and invalid dates', () => {
    expect(() => compileNamedParams('select :f', { f: () => 1 })).toThrow(SqlTextError);
    expect(() => compileNamedParams('select :d', { d: new Date('nope') })).toThrow(SqlTextError);
  });

  describe('injection attempts', () => {
    const attacks = [
      '1; DROP TABLE x; --',
      "' OR 1=1 --",
      'x :other y',
      '$1',
      "'; select pg_sleep(10); --",
      '$$ :a $$',
      '/* :a */',
    ];
    for (const attack of attacks) {
      it(`keeps ${JSON.stringify(attack)} only in values`, () => {
        const r = compileNamedParams('select * from t where a = :a and b = :other', { a: attack, other: 'z' });
        expect(r.text).toBe('select * from t where a = $1 and b = $2');
        expect(r.values).toEqual([attack, 'z']);
        expect(r.text).not.toContain('DROP');
        expect(r.text).not.toContain('OR 1=1');
      });
    }

    it('does not re-scan substituted values for params', () => {
      const r = compileNamedParams('select :a, :b', { a: ':b', b: 'real' });
      expect(r.text).toBe('select $1, $2');
      expect(r.values).toEqual([':b', 'real']);
    });
  });

  it('does not consume the colon of a lone trailing ":"', () => {
    expect(compileNamedParams('select a:', {}).text).toBe('select a:');
  });
});

describe('splitTopLevelStatements', () => {
  it('splits on semicolons, trims and drops empties', () => {
    expect(splitTopLevelStatements(' select 1 ;; select 2; ')).toEqual(['select 1', 'select 2']);
  });

  it('does not split inside strings, identifiers, dollar quotes or comments', () => {
    const sql = `select 'a;b', "c;d"; select $$ x; y $$; select $t$ ; $t$ -- ;\n; /* ; */ select 5`;
    expect(splitTopLevelStatements(sql)).toEqual([
      "select 'a;b', \"c;d\"",
      'select $$ x; y $$',
      'select $t$ ; $t$ -- ;',
      '/* ; */ select 5',
    ]);
  });

  it('drops comment-only statements', () => {
    expect(splitTopLevelStatements('select 1; -- done\n')).toEqual(['select 1']);
    expect(splitTopLevelStatements('')).toEqual([]);
  });

  it('respects E-string escapes', () => {
    expect(splitTopLevelStatements("select E'a\\';b'; select 2")).toEqual(["select E'a\\';b'", 'select 2']);
  });
});

describe('stripCommentsAndStrings', () => {
  it('blanks strings but keeps quotes', () => {
    expect(stripCommentsAndStrings("select 'drop table'")).toBe("select '          '");
  });

  it('blanks comments and keeps newlines', () => {
    const out = stripCommentsAndStrings('select 1 -- drop\n/* delete\n */ from t');
    expect(out).not.toMatch(/drop|delete/);
    expect(out.split('\n')).toHaveLength(3);
  });

  it('blanks dollar-quoted bodies', () => {
    expect(stripCommentsAndStrings('select $$ delete $$')).not.toMatch(/delete/);
  });

  it('turns quoted identifiers into a placeholder', () => {
    const out = stripCommentsAndStrings('select "update" from "Select Me"');
    expect(out).not.toMatch(/update/i);
    expect(out).toContain('"x"');
  });

  it('preserves length', () => {
    const sql = "select 'a''b', \"id\", $q$ body $q$ -- c\n from t";
    expect(stripCommentsAndStrings(sql)).toHaveLength(sql.length);
  });
});

describe('assertReadOnlySql', () => {
  it('accepts SELECT and WITH, returning the statement without trailing semicolon', () => {
    expect(assertReadOnlySql('SELECT 1;')).toBe('SELECT 1');
    expect(assertReadOnlySql('  select * from t where x = $1  ;  ')).toBe('select * from t where x = $1');
    expect(assertReadOnlySql('with a as (select 1) select * from a')).toBe('with a as (select 1) select * from a');
  });

  it('accepts leading comments', () => {
    expect(assertReadOnlySql('-- hi\nselect 1')).toBe('-- hi\nselect 1');
    expect(assertReadOnlySql('/* c */ /* d */ select 1;')).toBe('/* c */ /* d */ select 1');
  });

  it('does not trigger on keywords inside strings, identifiers or comments', () => {
    expect(() => assertReadOnlySql("select * from t where note = 'please delete me'")).not.toThrow();
    expect(() => assertReadOnlySql('select "update", "set" from t')).not.toThrow();
    expect(() => assertReadOnlySql('select 1 -- drop table\n')).not.toThrow();
    expect(() => assertReadOnlySql('select $$ insert into x $$')).not.toThrow();
    expect(() => assertReadOnlySql("select E'it\\'s delete'")).not.toThrow();
  });

  it('does not trigger on substrings of keywords', () => {
    expect(() => assertReadOnlySql('select updated_at, created_at, settings, dont from t')).not.toThrow();
  });

  it('rejects multiple statements', () => {
    expect(() => assertReadOnlySql('SELECT 1; DELETE FROM t')).toThrow(SqlTextError);
    expect(() => assertReadOnlySql('select 1; select 2')).toThrow(/exactly one/);
  });

  it('rejects empty input', () => {
    expect(() => assertReadOnlySql('')).toThrow(SqlTextError);
    expect(() => assertReadOnlySql('-- nothing')).toThrow(SqlTextError);
  });

  it('rejects non SELECT/WITH first keyword', () => {
    for (const sql of ['delete from t', 'insert into t values (1)', 'explain select 1', '(select 1)', 'show all']) {
      expect(() => assertReadOnlySql(sql)).toThrow(SqlTextError);
    }
  });

  it('rejects data-modifying CTEs', () => {
    expect(() => assertReadOnlySql('WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d')).toThrow(/DELETE/);
    expect(() => assertReadOnlySql('with d as (update t set a = 1 returning *) select * from d')).toThrow(SqlTextError);
  });

  it('rejects FOR UPDATE and SELECT INTO-style hazards', () => {
    expect(() => assertReadOnlySql('select * from t for update')).toThrow(/UPDATE/);
  });

  it('rejects forbidden functions, case-insensitively', () => {
    expect(() => assertReadOnlySql('select pg_sleep(10)')).toThrow(/pg_sleep/);
    expect(() => assertReadOnlySql('SELECT PG_SLEEP(10)')).toThrow(SqlTextError);
    expect(() => assertReadOnlySql("select set_config('a','b',false)")).toThrow(SqlTextError);
    expect(() => assertReadOnlySql('select pg_terminate_backend(1)')).toThrow(SqlTextError);
    expect(() => assertReadOnlySql("select dblink('x','y')")).toThrow(SqlTextError);
    expect(() => assertReadOnlySql("select pg_read_file('/etc/passwd')")).toThrow(SqlTextError);
    expect(() => assertReadOnlySql("select lo_import('/etc/passwd')")).toThrow(SqlTextError);
  });

  it.each([
    'select 1 where true; drop table t',
    'select 1; copy t to stdout',
    'with x as (select 1) insert into t select * from x',
    'select 1; begin',
    'select 1; commit',
    'select 1; set role x',
    'select 1; truncate t',
    'select 1; create table t()',
    'select 1; grant all on t to x',
    'select 1; vacuum',
    'select 1; lock t',
    'select 1; notify c',
    'select 1; execute p',
    'select 1; prepare p as select 1',
    'select 1; call p()',
    'select 1; do $$ begin end $$',
  ])('rejects %s', (sql) => {
    expect(() => assertReadOnlySql(sql)).toThrow(SqlTextError);
  });

  it('is not fooled by comment tricks hiding statements', () => {
    expect(() => assertReadOnlySql('select 1 /* ; */; delete from t')).toThrow(SqlTextError);
    expect(() => assertReadOnlySql('select 1 -- x\n; delete from t')).toThrow(SqlTextError);
  });
});

describe('assertSafeScript', () => {
  const rejects = (sql: string): void => {
    expect(() => assertSafeScript(sql, 'seed')).toThrow(SqlTextError);
  };

  it('names the context in the error', () => {
    expect(() => assertSafeScript('create extension x', 'fixture:users')).toThrow(/fixture:users/);
  });

  it('rejects dangerous object DDL', () => {
    rejects('CREATE EXTENSION dblink');
    rejects('create extension if not exists pg_stat_statements');
    rejects('drop database world');
    rejects('DROP DATABASE IF EXISTS world');
    rejects('alter role postgres with superuser');
    rejects('create user bob');
    rejects('create role bob');
    rejects('create tablespace ts location \'/x\'');
    rejects('create subscription s connection \'x\' publication p');
    rejects('create publication p for all tables');
    rejects('create server s foreign data wrapper w');
  });

  it('rejects COPY, ALTER SYSTEM, GRANT, REVOKE, SET ROLE, LOAD', () => {
    rejects('copy t from program \'curl evil\'');
    rejects('COPY t TO \'/tmp/x\'');
    rejects('alter system set work_mem = 1');
    rejects('grant all on t to public');
    rejects('revoke all on t from public');
    rejects('set role postgres');
    rejects('SET SESSION AUTHORIZATION postgres');
    rejects('set local role x');
    rejects("load '$libdir/plugins/x'");
    rejects("select 1; LOAD 'x'");
  });

  it('rejects forbidden functions and psql meta-commands', () => {
    rejects('select pg_terminate_backend(1)');
    rejects('select pg_cancel_backend(1)');
    rejects("select dblink_connect('x')");
    rejects("select lo_export(1, '/x')");
    rejects("select pg_read_binary_file('/x')");
    rejects("select pg_ls_dir('/')");
    rejects('select pg_reload_conf()');
    rejects('\\! rm -rf /');
    rejects('select 1;\n  \\copy t from x');
  });

  it('scans dollar-quoted bodies including inner string literals', () => {
    rejects("DO $$ BEGIN EXECUTE 'DROP DATABASE x'; END $$");
    rejects("do $body$ begin execute 'copy t to program ''x'''; end $body$");
    rejects("create function f() returns void as $$ begin execute 'create extension x'; end $$ language plpgsql");
    rejects("DO $a$ BEGIN EXECUTE $b$ grant all on t to x $b$; END $a$");
    rejects("DO 'begin execute ''drop role x''; end'");
  });

  it('ignores forbidden text inside plain string literals and comments', () => {
    expect(() => assertSafeScript("insert into notes values ('please drop database x')", 'seed')).not.toThrow();
    expect(() => assertSafeScript('select 1 -- drop database x\n', 'seed')).not.toThrow();
    expect(() => assertSafeScript('select 1 /* copy t */', 'seed')).not.toThrow();
    expect(() => assertSafeScript("insert into t values ('\\copy')", 'seed')).not.toThrow();
  });

  it('allows typical DDL and seeds', () => {
    const script = `
      CREATE TABLE users (id serial primary key, name text not null, role text, "user" text);
      CREATE INDEX idx_users_name ON users (name);
      CREATE VIEW v AS SELECT * FROM users;
      CREATE TYPE mood AS ENUM ('sad', 'ok');
      CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END $$ LANGUAGE plpgsql;
      INSERT INTO users (name, role) VALUES ('O''Brien', 'admin'), ('Anne''s', 'member');
      UPDATE users SET role = 'x' WHERE name = 'O''Brien';
      DELETE FROM users WHERE id = 99;
      ALTER TABLE users ADD COLUMN load int;
      INSERT INTO users (id) VALUES (1) ON CONFLICT DO NOTHING;
      SELECT 'it''s fine';
    `;
    expect(() => assertSafeScript(script, 'schema')).not.toThrow();
  });

  it('allows benign plpgsql bodies', () => {
    const script = `CREATE FUNCTION g() RETURNS void AS $fn$
      BEGIN
        EXECUTE 'INSERT INTO t VALUES (1)';
      END
    $fn$ LANGUAGE plpgsql;`;
    expect(() => assertSafeScript(script, 'schema')).not.toThrow();
  });
});
