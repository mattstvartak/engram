#!/usr/bin/env node
/**
 * engram-migrate — apply postgres schema migrations.
 *
 * Reads SQL files from `migrations/postgres/` (sorted by filename),
 * applies each in a transaction, records applied filenames in a
 * `_migrations` table. Idempotent on re-run — already-applied files
 * are skipped.
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx przm-memory-migrate
 *
 * Kept deliberately tiny — no node-pg-migrate dependency, no fancy
 * features. If you need rollbacks or down-migrations, reach for a
 * real migration tool. For przm Memory's small fixed schema this is enough.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
async function main() {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
        console.error('engram-migrate: DATABASE_URL is required.');
        process.exit(2);
    }
    const dir = findMigrationsDir();
    if (!existsSync(dir)) {
        console.error(`engram-migrate: migrations directory not found at ${dir}`);
        process.exit(3);
    }
    const files = readdirSync(dir)
        .filter((f) => f.endsWith('.sql'))
        .sort();
    if (files.length === 0) {
        console.error(`engram-migrate: no .sql files in ${dir}`);
        process.exit(0);
    }
    // String-variable dynamic import — pg is an optionalDependency, so
    // we don't want TypeScript to require its types at compile time.
    const pgModuleName = 'pg';
    let pgModule;
    try {
        pgModule = await import(pgModuleName);
    }
    catch {
        console.error("engram-migrate: the 'pg' package is required. Install with: npm install pg");
        process.exit(4);
    }
    const { Client } = pgModule.default ?? pgModule;
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
        // Bootstrap the bookkeeping table itself.
        await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT NOW()
      )
    `);
        const { rows: appliedRows } = await client.query(`SELECT filename FROM _migrations`);
        const applied = new Set(appliedRows.map((r) => r.filename));
        let appliedCount = 0;
        for (const file of files) {
            if (applied.has(file)) {
                console.log(`engram-migrate: skip ${file} (already applied)`);
                continue;
            }
            const sql = readFileSync(join(dir, file), 'utf-8');
            console.log(`engram-migrate: apply ${file}`);
            try {
                await client.query('BEGIN');
                await client.query(sql);
                await client.query(`INSERT INTO _migrations (filename) VALUES ($1)`, [file]);
                await client.query('COMMIT');
                appliedCount += 1;
            }
            catch (err) {
                await client.query('ROLLBACK').catch(() => { });
                console.error(`engram-migrate: FAILED on ${file}:`, err.message);
                process.exit(5);
            }
        }
        console.log(`engram-migrate: done (${appliedCount} applied, ${files.length - appliedCount} skipped)`);
    }
    finally {
        await client.end().catch(() => { });
    }
}
/**
 * Find the migrations directory regardless of whether we're running
 * from `src/` (tsx), `dist/`, or as an installed package.
 *
 * Layout candidates, in priority order:
 *   1. <package-root>/migrations/postgres   — installed package
 *   2. <cwd>/migrations/postgres             — local dev / monorepo
 */
function findMigrationsDir() {
    const here = dirname(fileURLToPath(import.meta.url));
    // From dist/migrate.js => ../migrations/postgres
    // From src/migrate.ts  => ../migrations/postgres
    const candidates = [
        resolve(here, '..', 'migrations', 'postgres'),
        resolve(here, '..', '..', 'migrations', 'postgres'),
        resolve(process.cwd(), 'migrations', 'postgres'),
    ];
    for (const c of candidates) {
        if (existsSync(c))
            return c;
    }
    return candidates[0];
}
main().catch((err) => {
    console.error('engram-migrate: unexpected error', err);
    process.exit(1);
});
//# sourceMappingURL=migrate.js.map