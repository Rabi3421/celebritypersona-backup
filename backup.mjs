/**
 * Export the whole celebritypersona database to out/backup-<UTC stamp>.json.gz,
 * plus out/manifest.json (counts and hashes only, no data).
 *
 *   MONGODB_URI=... node backup.mjs
 *
 * Read-only: it only lists collections and indexes and reads documents. Run it with the
 * read-only `cp-backup` user. It fails (exit 1), so the nightly job is marked failed, when:
 *   - it cannot connect or read;
 *   - the database has no `outfits` or they are empty (the wrong database, or data loss);
 *   - a collection's document count changed while it was being read twice in a row
 *     would make the copy inconsistent (it retries that collection once first).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { MongoClient } from "mongodb";
import { EJSON } from "./lib.mjs";
import { collectionHash, DATABASE, docText, FORMAT, hostOf, safeMessage } from "./lib.mjs";

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("MONGODB_URI is not set.");
  process.exit(1);
}

const REQUIRED = ["outfits", "celebrities", "occasions", "brands"];

async function exportCollection(db, info) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const coll = db.collection(info.name);
    const before = await coll.countDocuments({});
    const docs = await coll.find({}, { sort: { _id: 1 } }).toArray();
    const after = await coll.countDocuments({});
    if (before === docs.length && after === docs.length) {
      const texts = docs.map(docText);
      const indexes = (await coll.indexes()).filter((ix) => ix.name !== "_id_");
      return {
        name: info.name,
        options: info.options ?? {},
        indexes,
        count: docs.length,
        sha256: collectionHash(texts),
        docs,
      };
    }
    if (attempt === 2) throw new Error(`${info.name} kept changing while it was read (${before} → ${docs.length} → ${after}).`);
  }
}

const started = Date.now();
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 30000, readPreference: "secondaryPreferred", appName: "cp-backup" });
try {
  await client.connect();
  const db = client.db(DATABASE);
  const infos = (await db.listCollections({}, { nameOnly: false }).toArray())
    .filter((c) => c.type === "collection" && !c.name.startsWith("system."))
    .sort((a, b) => a.name.localeCompare(b.name));

  const names = infos.map((c) => c.name);
  const missing = REQUIRED.filter((n) => !names.includes(n));
  if (missing.length) throw new Error(`Database "${DATABASE}" on ${hostOf(uri)} has no ${missing.join(", ")}: refusing to save what looks like the wrong database.`);

  const collections = [];
  for (const info of infos) collections.push(await exportCollection(db, info));
  const outfits = collections.find((c) => c.name === "outfits");
  if (!outfits.count) throw new Error("outfits is empty: refusing to overwrite good history with an empty backup.");

  const createdAt = new Date().toISOString();
  const stamp = createdAt.replace(/[:.]/g, "-").slice(0, 19) + "Z";
  const body = gzipSync(Buffer.from(EJSON.stringify({ format: FORMAT, database: DATABASE, createdAt, collections }, { relaxed: false })), { level: 9 });
  const file = `backup-${stamp}.json.gz`;
  const manifest = {
    format: FORMAT,
    database: DATABASE,
    host: hostOf(uri),
    createdAt,
    file,
    bytes: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
    seconds: Math.round((Date.now() - started) / 100) / 10,
    collections: collections.map(({ name, count, sha256, indexes }) => ({ name, count, sha256, indexes: indexes.length })),
  };
  mkdirSync("out", { recursive: true });
  writeFileSync(`out/${file}`, body);
  writeFileSync("out/manifest.json", JSON.stringify(manifest, null, 2) + "\n");

  console.log(`Backed up ${collections.length} collections, ${collections.reduce((n, c) => n + c.count, 0)} documents, from ${manifest.host} in ${manifest.seconds}s → out/${file} (${body.length} bytes).`);
  for (const c of manifest.collections) console.log(`  ${c.name.padEnd(20)} ${String(c.count).padStart(6)} docs  ${c.indexes} indexes`);
} catch (err) {
  console.error(`Backup FAILED: ${safeMessage(err, uri)}`);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
