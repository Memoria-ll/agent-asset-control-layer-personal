import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { normalizeAssetRecord } from './schema.ts';
import type { Stamp } from './schema.ts';

export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > 1) throw new Error('このBackupのschema versionには対応していません。');
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
  get<T>(id: string, kind?: string): T {
    const row = this.db.prepare('SELECT kind,data FROM records WHERE id=?').get(id) as { kind: string; data: string } | undefined;
    if (!row || (kind && row.kind !== kind)) throw new Error(`対象が見つかりません: ${id}`);
    return this.normalize<T>(row.kind, JSON.parse(row.data));
  }
  maybe<T>(id: string): T | undefined {
    const row = this.db.prepare('SELECT kind,data FROM records WHERE id=?').get(id) as { kind: string; data: string } | undefined;
    return row ? this.normalize<T>(row.kind, JSON.parse(row.data)) : undefined;
  }
  list<T>(kind: string, scope?: string): T[] {
    const rows = scope === undefined
      ? this.db.prepare('SELECT data FROM records WHERE kind=? ORDER BY rowid DESC').all(kind)
      : this.db.prepare('SELECT data FROM records WHERE kind=? AND scope=? ORDER BY rowid DESC').all(kind, scope);
    return rows.map(r => {
      const row = r as { data: string };
      return this.normalize<T>(kind, JSON.parse(row.data));
    });
  }
  put<T extends object>(kind: string, input: T & { id?: string }, scope = 'global'): T & Stamp {
    const normalized = this.normalize<T>(kind, input);
    const id = input.id ?? randomUUID(), old = this.maybe<Stamp>(id), now = new Date().toISOString();
    const data = { ...normalized, id, revision: (old?.revision ?? 0) + 1, createdAt: old?.createdAt ?? now, updatedAt: now };
    const serialized = JSON.stringify(data);
    this.db.prepare('INSERT INTO records VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,scope=excluded.scope').run(id, kind, scope, serialized);
    this.db.prepare('INSERT INTO revisions(id,revision,kind,data) VALUES(?,?,?,?)').run(id, data.revision, kind, serialized);
    return data;
  }
  revision<T>(id: string, revision: number): T {
    const row = this.db.prepare('SELECT kind,data FROM revisions WHERE id=? AND revision=?').get(id, revision) as { kind: string; data: string } | undefined;
    if (!row) throw new Error(`revisionが見つかりません: ${id}@${revision}`);
    return this.normalize<T>(row.kind, JSON.parse(row.data));
  }
  revisions<T>(id: string): T[] {
    return this.db.prepare('SELECT kind,data FROM revisions WHERE id=? ORDER BY revision DESC').all(id).map(r => {
      const row = r as { kind: string; data: string };
      return this.normalize<T>(row.kind, JSON.parse(row.data));
    });
  }
  private normalize<T>(kind: string, value: unknown): T {
    if (kind === 'asset') return normalizeAssetRecord(value) as T;
    if (kind === 'run' && value && typeof value === 'object' && !Array.isArray(value)) {
      const { taskType: _taskType, ...rest } = value as Record<string, unknown>;
      return rest as T;
    }
    return value as T;
  }
  boundary(): number { return Number(this.db.prepare('SELECT COALESCE(MAX(sequence),0) n FROM revisions').get()!.n); }
  atomic<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  write<T>(operationId: string, name: string, request: unknown, fn: () => T): { result: T; duplicate: boolean } {
    return this.atomic(() => {
      const requestText = JSON.stringify(request);
      const old = this.db.prepare('SELECT * FROM operations WHERE id=?').get(operationId);
      if (old) {
        if (old.name !== name || old.request !== requestText) throw new Error('operation IDが別の操作で使われています。新しいIDを指定してください。');
        return { result: JSON.parse(old.result as string) as T, duplicate: true };
      }
      const result = fn();
      this.db.prepare('INSERT INTO operations VALUES(?,?,?,?)').run(operationId, name, requestText, JSON.stringify(result));
      return { result, duplicate: false };
    });
  }
  close() { this.db.close(); }
}
