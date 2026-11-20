/**
 * Put a backup back into a database, then prove it matches the backup exactly.
 *
 *   node restore.mjs <backup-….json.gz[.gpg]> --to <connection string> --db <database name>
 *                    [--key <private key file>]   (default: %USERPROFILE%\.celebritypersona-monitor\backup-private-key.asc)
 *
 * Encrypted files (.gpg) are decrypted in memory with a throwaway GnuPG home; the key is
 * never added to your normal keyring and no decrypted file is written.
 *
 * Safety:
 *   - it never merges or overwrites: the target database must be empty (no collections);
 *   - restoring into a database named "celebritypersona" anywhere other than this computer
 *     also needs --allow-production, so a typo cannot touch the live site.
 *
 * After inserting, it reads every collection back and compares document counts and the
 * SHA-256 of the documents with the values recorded at backup time. Any difference fails.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { MongoClient } from "mongodb";
import { EJSON } from "./lib.mjs";
import { collectionHash, DATABASE, docText, FORMAT, hostOf, safeMessage } from "./lib.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const file = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const uri = flag("--to");
const dbName = flag("--db");
const keyFile = flag("--key") ?? join(homedir(), ".celebritypersona-monitor", "backup-private-key.asc");
const allowProduction = args.includes("--allow-production");

function fail(msg) {
  console.error(`Restore REFUSED: ${msg}`);
  process.exit(1);
}

if (!file || !uri || !dbName) fail("usage: node restore.mjs <backup file> --to <connection string> --db <database name>");
if (!existsSync(file)) fail(`no such file: ${file}`);
const host = hostOf(uri);
const local = ["localhost", "127.0.0.1", "::1"].includes(host);
if (dbName === DATABASE && !local && !allowProduction) fail(`"${DATABASE}" on ${host} is the live database. Restore into another name (e.g. ${DATABASE}_restore_test), or add --allow-production if you really mean it.`);

function decrypt(path) {
  if (!existsSync(keyFile)) fail(`private key not found: ${keyFile}`);
  const home = mkdtempSync(join(tmpdir(), "cp-restore-gnupg-"));
  // Git for Windows ships an MSYS gpg, which only understands its own /c/Users/… paths for
  // --homedir. A native gpg (Gpg4win, Linux) reports a normal home and takes paths as they are.
  const msys = process.platform === "win32" && /^Home: \/[a-z]\//im.test(execFileSync("gpg", ["--version"]).toString());
  const p = (x) => (msys ? x.replace(/^([A-Za-z]):[\\/]/, (_, d) => `/${d.toLowerCase()}/`).split("\\").join("/") : x);
  const gpg = (...a) => execFileSync("gpg", ["--homedir", p(home), "--batch", "--quiet", "--pinentry-mode", "loopback", "--passphrase", "", ...a], { maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "pipe"] });
  try {
    gpg("--import", p(keyFile));
    return gpg("--decrypt", p(path));
  } catch (err) {
    const lastLine = String(err.stderr ?? err.message).trim().split(/\r?\n/).pop();
    fail(`could not decrypt ${path}: ${lastLine}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const raw = file.endsWith(".gpg") ? decrypt(file) : readFileSync(file);
const backup = EJSON.parse(gunzipSync(raw).toString("utf8"), { relaxed: false });
if (Number(backup.format) !== FORMAT) fail(`unknown backup format ${backup.format}`);

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 30000, appName: "cp-restore" });
let failed = false;
try {
  await client.connect();
  const db = client.db(dbName);
  const existing = await db.listCollections({}, { nameOnly: true }).toArray();
  if (existing.length) fail(`database "${dbName}" on ${host} already has ${existing.length} collections. Restore only into an empty database.`);

  console.log(`Restoring backup of ${backup.createdAt} into "${dbName}" on ${host}…`);
  for (const c of backup.collections) {
    const coll = await db.createCollection(c.name, c.options);
    for (let i = 0; i < c.docs.length; i += 500) await coll.insertMany(c.docs.slice(i, i + 500), { ordered: true });
    for (const ix of c.indexes) {
      const { v, ns, key, ...options } = ix;
      await coll.createIndex(key, options);
    }
  }

  console.log("\nChecking every collection against the backup:");
  for (const c of backup.collections) {
    const coll = db.collection(c.name);
    const docs = await coll.find({}, { sort: { _id: 1 } }).toArray();
    const sha = collectionHash(docs.map(docText));
    const indexes = (await coll.indexes()).filter((ix) => ix.name !== "_id_").length;
    const ok = docs.length === Number(c.count) && sha === c.sha256 && indexes === c.indexes.length;
    if (!ok) failed = true;
    console.log(`  ${ok ? "OK  " : "FAIL"} ${c.name.padEnd(20)} ${String(docs.length).padStart(6)}/${Number(c.count)} docs  ${indexes}/${c.indexes.length} indexes  ${sha === c.sha256 ? "content identical" : "CONTENT DIFFERS"}`);
  }
  console.log(failed ? "\nRestore check FAILED." : `\nRestore verified: ${backup.collections.length} collections identical to the backup.`);
} catch (err) {
  failed = true;
  console.error(`Restore FAILED: ${safeMessage(err, uri)}`);
} finally {
  await client.close().catch(() => {});
}
process.exitCode = failed ? 1 : 0;
