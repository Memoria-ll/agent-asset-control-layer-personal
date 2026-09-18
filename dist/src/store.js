import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
export class Store {
    db;
    constructor(path) {
        this.db = new DatabaseSync(path);
        this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
        const version = this.db.prepare('PRAGMA user_version').get().user_version;
        if (version > 1)
            throw new Error('このBackupのschema versionには対応していません。');
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, scope TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS records_kind_scope ON records(kind, scope);
      CREATE TABLE IF NOT EXISTS revisions (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, revision INTEGER NOT NULL,
        kind TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(id,revision)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS revisions_entity ON revisions(id,revision);
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, request TEXT NOT NULL, result TEXT NOT NULL
      ) STRICT;
      CREATE TRIGGER IF NOT EXISTS revisions_no_update BEFORE UPDATE ON revisions BEGIN SELECT RAISE(ABORT,'immutable revision'); END;
      CREATE TRIGGER IF NOT EXISTS revisions_no_delete BEFORE DELETE ON revisions BEGIN SELECT RAISE(ABORT,'immutable revision'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_records BEFORE UPDATE ON records
      WHEN OLD.kind IN ('snapshot','delivery','event','history','provenance','decision','changeset')
      BEGIN SELECT RAISE(ABORT,'immutable record'); END;
      PRAGMA user_version=1;
    `);
    }
    get(id, kind) {
        const row = this.db.prepare('SELECT kind,data FROM records WHERE id=?').get(id);
        if (!row || (kind && row.kind !== kind))
            throw new Error(`対象が見つかりません: ${id}`);
        return JSON.parse(row.data);
    }
    maybe(id) {
        const row = this.db.prepare('SELECT data FROM records WHERE id=?').get(id);
        return row ? JSON.parse(row.data) : undefined;
    }
    list(kind, scope) {
        const rows = scope === undefined
            ? this.db.prepare('SELECT data FROM records WHERE kind=? ORDER BY rowid DESC').all(kind)
            : this.db.prepare('SELECT data FROM records WHERE kind=? AND scope=? ORDER BY rowid DESC').all(kind, scope);
        return rows.map(r => JSON.parse(r.data));
    }
    put(kind, input, scope = 'global') {
        const id = input.id ?? randomUUID(), old = this.maybe(id), now = new Date().toISOString();
        const data = { ...input, id, revision: (old?.revision ?? 0) + 1, createdAt: old?.createdAt ?? now, updatedAt: now };
        const serialized = JSON.stringify(data);
        this.db.prepare('INSERT INTO records VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,scope=excluded.scope').run(id, kind, scope, serialized);
        this.db.prepare('INSERT INTO revisions(id,revision,kind,data) VALUES(?,?,?,?)').run(id, data.revision, kind, serialized);
        return data;
    }
    revision(id, revision) {
        const row = this.db.prepare('SELECT data FROM revisions WHERE id=? AND revision=?').get(id, revision);
        if (!row)
            throw new Error(`revisionが見つかりません: ${id}@${revision}`);
        return JSON.parse(row.data);
    }
    revisions(id) {
        return this.db.prepare('SELECT data FROM revisions WHERE id=? ORDER BY revision DESC').all(id).map(r => JSON.parse(r.data));
    }
    boundary() { return Number(this.db.prepare('SELECT COALESCE(MAX(sequence),0) n FROM revisions').get().n); }
    atomic(fn) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = fn();
            this.db.exec('COMMIT');
            return result;
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    write(operationId, name, request, fn) {
        return this.atomic(() => {
            const requestText = JSON.stringify(request);
            const old = this.db.prepare('SELECT * FROM operations WHERE id=?').get(operationId);
            if (old) {
                if (old.name !== name || old.request !== requestText)
                    throw new Error('operation IDが別の操作で使われています。新しいIDを指定してください。');
                return { result: JSON.parse(old.result), duplicate: true };
            }
            const result = fn();
            this.db.prepare('INSERT INTO operations VALUES(?,?,?,?)').run(operationId, name, requestText, JSON.stringify(result));
            return { result, duplicate: false };
        });
    }
    close() { this.db.close(); }
}
