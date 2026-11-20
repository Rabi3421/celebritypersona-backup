/**
 * Shared by backup.mjs and restore.mjs.
 *
 * The backup is one JSON document, gzip-compressed:
 *   { format, database, createdAt, collections: [{ name, options, indexes, count, sha256, docs }] }
 * `docs` are MongoDB Extended JSON v2 in canonical mode, so every type survives the
 * round trip exactly: ObjectId, Date, Long, Decimal128, Binary. `sha256` is taken over
 * the collection's documents in _id order, so a restore can prove it put back exactly
 * what was exported.
 */
import { createHash } from "node:crypto";
import { BSON } from "mongodb";
export const { EJSON } = BSON;

export const FORMAT = 1;
export const DATABASE = "celebritypersona";

/** Canonical EJSON for one document: the unit both the export and the check hash. */
export const docText = (doc) => EJSON.stringify(doc, { relaxed: false });

/** One hash for a collection, over its documents sorted by _id (the export sorts them too). */
export function collectionHash(docTexts) {
  const h = createHash("sha256");
  for (const t of docTexts) h.update(t).update("\n");
  return h.digest("hex");
}

/** The host of a connection string, never its user or password. */
export function hostOf(uri) {
  try {
    return new URL(String(uri).replace(/^mongodb(\+srv)?:\/\//, "https://")).hostname;
  } catch {
    return "(unreadable connection string)";
  }
}

/** Print an error without ever echoing a connection string that might be inside it. */
export function safeMessage(err, uri) {
  let text = String(err?.message ?? err);
  if (uri) text = text.split(uri).join("<connection string>");
  return text.replace(/mongodb(\+srv)?:\/\/[^\s"']+/g, "<connection string>");
}
