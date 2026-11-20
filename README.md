# celebritypersona-backup

A nightly, encrypted copy of the `celebritypersona` MongoDB database (Atlas Cluster0, free tier,
which has no backups of its own), and a restore that proves the copy is complete.

## How it works

1. **02:00 IST every night**, GitHub Actions runs `backup.mjs` with the read-only Atlas user
   (role `readAnyDatabase`, one cluster only). It exports every collection of
   `celebritypersona`: documents in canonical Extended JSON (every type kept exactly), collection
   options and indexes, with a SHA-256 per collection.
2. The file is **encrypted with `keys/backup-public.asc`** before it is stored. The unencrypted copy
   is deleted on the runner. GitHub never holds the key that opens it.
3. The encrypted file is kept as a workflow artifact for **30 days**.

**This repository is public** (GitHub runs Actions on private repositories only while the account's
billing is in good standing). Nothing in it is secret: the code, the schedule and the public key.
The backups are readable only with the private key; on GitHub the job logs say only whether it
worked, the collection count and the size, never the server or the data, and the summary file
(`out/manifest.json`, with counts and the server name) is deleted before upload. Forks never get
the secret, and only the owner can start a run.

**GitHub disables scheduled workflows in a public repository after 60 days without activity.**
A Slack alert for a missed night is planned (the monitor Worker); until then, check the Actions tab.

The job fails, and GitHub emails the repository owner, if it cannot connect, if `outfits`,
`celebrities`, `occasions` or `brands` is missing, if `outfits` is empty, or if a collection kept
changing while it was read.

## Keys and secrets

| What | Where | Secret? |
|---|---|---|
| Public key (locks backups) | `keys/backup-public.asc`, fingerprint `BCE4 4AEF E139 5657 D4B1 C8D7 4782 6AF9 CAFD A1EF` | No |
| Private key (opens backups) | `%USERPROFILE%\.celebritypersona-monitor\backup-private-key.asc`, readable only by your Windows user. **Keep a second copy offline** (USB stick or password manager). Without it no backup can be opened. | **Yes** |
| `MONGODB_BACKUP_URI` | GitHub → repo Settings → Secrets and variables → Actions | **Yes** |

## Restore

Download the artifact from the run (Actions → the run → Artifacts), unzip it, then:

```bash
npm ci
# A restore test into an empty database. Never overwrites: the target must be empty.
node restore.mjs backup-<stamp>.json.gz.gpg --to "<connection string>" --db celebritypersona_restore_test
```

It decrypts in memory with a throwaway GnuPG home, inserts every collection, recreates the indexes,
then reads everything back and compares counts, indexes and the SHA-256 of the content with the
backup. Restoring into a database named `celebritypersona` on a server other than this computer
also requires `--allow-production`.

Verified on 20 Nov 2026: a real backup (15 collections, 149 documents, 28 KB) restored into a local
MongoDB 7.0 with every collection identical; a second run into the full database, a wrong key and
the live database name were all refused.
