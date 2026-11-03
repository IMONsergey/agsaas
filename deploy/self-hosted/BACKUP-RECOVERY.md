# Application-consistent backup and isolated recovery

This is a **cold backup with a maintenance window**. It is not continuous backup,
PITR or high availability. Installation of the timer and any first live snapshot
must be coordinated with the release operator. Merely adding these files does not
establish working scheduled backup or independent disaster recovery.

## Recovery contract

`scripts/self-hosted-backup.py` snapshots one exact Compose project and its owned
mounts. It blocks new gateway/application work, drains writers, gracefully stops
Redis/PostgreSQL, and copies the complete runtime, Storage bytes, PostgreSQL data
and WAL, Redis queue AOF/RDB, the database configuration volume and pgsodium root
key. The owned control directory includes its isolated Certbot/TLS state, private
keys and deployment/renewal receipts; safe internal Certbot symlinks are preserved.
The private runtime includes the persistent application encryption/signing
keys, Auth signing material, database passwords and deployment configuration.
The manifest contains key names and hashes, never their values. The disposable
Redis cache and Deno download cache are explicitly excluded.

The tool exports the exact clean source revision and, by default, **all runtime
images** before stopping services. The manifest records immutable image IDs,
repository digests, source SHA, service/mount identity, size/hash for every
artifact and the measured stop/resume interval. Physical PostgreSQL recovery
requires the same image and compatible CPU architecture; a major PostgreSQL
upgrade is a separate migration. `includeImages: none` or `application` is a
deliberately incomplete image contract and is always reported as such.

Root-owned local archives have private permissions. Offsite uses the existing
encrypted restic repository and its existing host credential. No repository is
initialized, no new remote account is created, no SSH host key is changed and no
credential is printed. The encrypted host credential can be used inside the
budgeted root job through `systemd-creds`; plaintext exists only in a private
temporary `/run` directory for each restic invocation.

## Installation and dry plan

Install `backup.config.example.json` as `/etc/agsaas/backup.json`, owned by root
with mode `0600`, after verifying each path and project. The tool rejects a
different Compose working directory, unowned mount or unexpected durable volume.
The source checkout must be clean and root-owned. Keep the configuration outside
the repository. Do not copy environment values into documentation or logs.

First run the bounded read-only administrative plan:

```sh
sudo -n python3 /opt/agsaas/preview-20261101/source/scripts/self-hosted-backup.py \
  plan --config /etc/agsaas/backup.json --require-offsite-capacity
```

The plan lists the exact project, services, paths, image inventory, approximate
uncompressed payload and stop/start order. It never stops containers or uploads
anything. Source files and image layers can compress or deduplicate, but capacity
planning assumes no such saving. Every upload rechecks its **actual** artifact
size against `ceil(payload × 1.15) + 8 GiB` free space. No cleanup is attempted to
make an upload fit. The existing SFTP identity and `StrictHostKeyChecking=yes`
are mandatory.

Read-only capacity on 2026-11-03 at 05:52 UTC reported 9,323,128 KiB available
(about 8.89 GiB). This permits roughly 0.77 GiB of new payload after the mandated
reserve and overhead. Current runtime state was about 97 MB; all saved images
require substantially more. A full first offsite image set is therefore an
acceptance gate, not a claim made by this implementation. Increase approved
capacity, separately retain the immutable image set, or select an explicitly
reviewed reduced image contract. The tool does not delete another project's
backups or silently omit images to claim success.

## First snapshot and measured restore

After the maintenance window is accepted, run the bounded root adapter using the same private
configuration. `--require-offsite-capacity` also checks the conservative remote
budget before any service stops. Without it a successful local snapshot remains
possible when offsite capacity is insufficient; offsite still fails closed.

```sh
sudo -n systemd-run --unit=agsaas-backup-reviewed --collect --wait \
  --property=CPUQuota=50% --property=MemoryMax=2G --property=MemorySwapMax=0 \
  --property=TasksMax=128 --property=TimeoutStartSec=4h --property=TimeoutStopSec=45min \
  /usr/bin/python3 /opt/agsaas/preview-20261101/source/scripts/self-hosted-admin-job.py \
  snapshot --config /etc/agsaas/backup.json
```

Use the completed snapshot path returned by that command:

```sh
sudo -n systemd-run --unit=agsaas-restore-reviewed --collect --wait \
  --property=CPUQuota=50% --property=MemoryMax=2G --property=MemorySwapMax=0 \
  --property=TasksMax=128 --property=TimeoutStartSec=4h --property=TimeoutStopSec=45min \
  /usr/bin/python3 /opt/agsaas/preview-20261101/source/scripts/self-hosted-admin-job.py \
  restore --config /etc/agsaas/backup.json \
  --bundle /var/backups/agsaas/preview/ACTUAL_SNAPSHOT_ID \
  --name reviewed-recovery-20261103 --boot-database
```

Restore refuses existing directories or containers. It validates all checksums,
archive paths, links and types before extraction; preserves numeric ownership;
checks the durable database key; starts the exact PostgreSQL image with **network
none and no published ports**; proves SQL readiness; then stops it. It never
replaces the live data directory, changes the original credentials, enables the
public application or silently retargets production. Files and the stopped
labelled database container remain for review. Promotion into a complete owned
stack requires a separate release procedure and full application acceptance.

For synthetic validation, `scripts/self-hosted-backup-integration.py` creates its
own network-none PostgreSQL/Redis/storage fixtures using already installed image
IDs, writes known fixture data, runs the real cold snapshot and restore, queries
the restored row and Redis AOF value, compares Storage bytes/key hashes, verifies
no published ports and checks automatic recovery after an injected archive
failure. It also rejects a corrupt bundle and an existing restore destination.
No production dataset is read or copied by this test. Run it as a bounded root
administrative unit only after reserving the existing heavy slot, with explicit
image IDs and a private receipt path; the script removes only containers and
named volumes it created. It leaves synthetic files for review.

## Independent copy and retention

Use the same bounded root adapter for `offsite --bundle ACTUAL_SNAPSHOT_PATH` after local verification. A successful
upload is not enough: the tool downloads **every artifact** from the remote
snapshot and checks every SHA before it writes `offsite-receipts.json`. This is
the acceptance receipt for the independent payload. A new host can use `retrieve
--snapshot-id ACTUAL_RESTIC_ID` with the same configured owned backup path, then
run the same isolated restore. Retrieval refuses local overwrite and foreign
snapshot paths/tags.

The namespace is host `imon-workstation` and tag
`agsaas-cold-v1:agsaas-preview-20261101`; the generic host backup's retention tag is
not reused. `retention` defaults to a dry plan. `retention --apply` keeps at least
seven local and fourteen remote points by the example policy, never fewer than
two. Local deletion requires a matching fully retrieved offsite receipt. Remote
forget uses explicit verified IDs only. Unknown snapshots fail closed. There is
no global prune, repository initialization or deletion of generic host backups.
Forgotten restic data requires a separately coordinated repository maintenance
operation before free space can be reclaimed.

## Scheduling, interrupted jobs and monitoring

The supplied timer schedules 02:45 UTC with up to five minutes of jitter. Its
bounded root service uses `self-hosted-admin-job.py`, an explicitly authorized
administrative adapter. The ordinary queue has NoNewPrivileges and cannot run
sudo; no ACL, Docker group, queue setting or sandbox is changed to bypass that.
The adapter opens the **existing** `/home/sergey/.local/state/imon-jobs/heavy.lock`
with O_NOFOLLOW, checks its regular-file/owner/inode identity, takes the same
exclusive flock as imon-job, preserves the 8 GiB disk reserve, enforces a timeout
and releases the lock in finally. The root service supplies CPU50%, memory2GiB,
no swap and128PID limits. It cannot accept arbitrary executable commands.
`scheduled-status.json`, service exit and the full offsite receipt determine the
outcome. The daily job keeps a valid local snapshot if independent upload fails
and exits unsuccessfully so the failure remains visible. Timer activation remains
a release-coordination action after the actual recovery test.
Install the matching resume service/timer together. A durable journal is written
before the first stop. Python `finally` resumes the exact originally running set
after errors, timeouts, TERM or INT; deliberately stopped services stay stopped.
The resume watchdog handles a killed Python process or host restart by acquiring
the same exclusive lock. It defers while a backup still owns the lock, refuses
changed container IDs and never creates replacements. A failed restart is a real
failure requiring operator attention; the tool never reports success solely
because copying finished.

Before enabling the schedule, prove the full synthetic test, one approved live
snapshot, one independent payload retrieval and an isolated restore. Record the
measured outage/RTO and agreed RPO. Alert on missing or stale scheduled receipts,
failed job state, unverified offsite payload, low capacity and an unresolved
resume journal using the installation's real alert channel. No fake mail or
unconfigured alert delivery is treated as a working monitor.

The host's global Nginx configuration and operating-system recovery remain in
the existing host backup contract. AGSaaS's own TLS/control state under `/opt`
is explicitly included here, along with its previously missing application and
Docker-volume state. This bundle does not replace the host recovery plan.
