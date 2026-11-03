# Shared heavy-slot quarantine, 2026-11-03

## Exact operational state

The **minimal canonical-home correction is installed** in the user-owned
`/home/sergey/.local/bin/imon-job`. It resolves the canonical user directory from
the UID account record instead of inheriting Desktop Commander's changed HOME.
Observed source SHA-256 is
`dae43b73d2d74a5cd090c89f75e1759eb522a08ed2512b43be54114a78f51404`.
The original heavy lock remains device **2049**, inode **7190787**. Existing
jobs were not restarted or canceled. Its private source backup is
`/home/sergey/Work/Reports/agsaas-completion-20261103/queue-canonical-home-20261103T085352Z`.

The **full quarantine protocol below is source only**. It is not installed.
Desktop Commander's current administrative execution restriction blocks the
required root-owned installation; no alternate remote execution or policy
change was used. Candidate launch remains blocked. No runtime image, Docker
daemon setting, active deployment, provider grant or mail recipient was changed.

## What changes

| File | Function |
| --- | --- |
| `imon-job.observed.py` | Exact original queue bytes, including the canonical existing disk/log/cgroup behavior |
| `imon-job.canonical-home.py` | Installed minimal HOME fix, no quarantine dependency |
| `apply-canonical-home.py` | UID-owned source-only application with default check, backup and compare-before-write |
| `imon-job.py` | Full proposed queue: original lock, root protocol validation, quarantine-aware admission |
| `heavy_slot.py` | Root-owned shared control, durable marker, exact builder inspection and recovery |
| `install-heavy-slot.py` | Default read-only preflight; installs only exact reviewed versions, no unit restarts |
| `test_heavy_slot.py` | Protocol, failure and real process/lock/admission tests using an explicit fake Docker transport |
| `test_install_heavy_slot.py` | Read-only preflight, unknown revision refusal, interrupted installation and idempotence |

The application adapter remains `scripts/self-hosted-admin-job.py` and the
candidate entry point remains `scripts/self-hosted-candidate.mts`. The shared
module installs to `/usr/local/lib/imon/heavy_slot.py`; protected protocol,
quarantine and recovery records live in `/var/lib/imon-heavy-slot`.

The queue and adapter both check the durable marker after acquiring the same
existing heavy lock. A quarantined ordinary job releases the flock and stays
queued; it does not run its command. This permits independent recovery to take
the slot. Any marker, including a partial or malformed one, blocks admission.

The adapter validates the reviewed installed queue hash and waits for earlier
queued/running interpreter versions to drain naturally before a candidate can
arm. It records the exact bounded builder container and image, publishes and
fsyncs quarantine, then starts only that container and candidate child. The
child requires the matching parent PID and operation token. A killed adapter
loses its flock but cannot remove the marker. No timeout or age clears it.

Recovery acquires the same original lock, independently inspects the recorded
container/image and its bounds, requests stop/kill only for that exact identity,
and confirms stopped state. Candidate manifest cleanup completes before marker
clear. Docker errors, ambiguous stop, replacement identity or manifest failure
leave quarantine intact. The recovery receipt is durable before marker removal.

## Installation contract and source freeze

`install-heavy-slot.py` accepts only the exact observed original queue, the
minimal canonical-home queue, or its own full final queue. Existing module and
protocol files must be absent or exactly this reviewed revision. It refuses an
unknown installed version instead of overwriting it. All known previous bytes
are backed up. It does not create, replace or chown the heavy lock and does not
change systemd units, cgroup limits, sudo policy or Docker socket permissions.

Run the installer without `--apply` first, as the deployment owner, with all
source files in this directory unchanged. After review, `--apply` is the one
concrete privileged installation step. Freeze other queue source writers while
it runs. Compare-before-write preserves an unexpected concurrent queue edit;
the candidate hash guard rejects an incomplete installation. Do not copy the
full `imon-job.py` alone: it depends on the protected module and protocol.

When installed, observe all old queued/running jobs finishing normally; the
candidate refuses them until their state is terminal. Stale state requires the
existing ordinary queue reconciliation, not invented completion or cancellation.
The read-only/metadata commands keep working, and ordinary jobs can proceed
while there is no quarantine.

## Actual verification and remaining acceptance

Local Python verification passed **15 protocol tests and 5 installer tests**.
The protocol suite kills a real holder process, exercises the actual proposed
`imon-job.run` with an ordinary competing subprocess, verifies that the command
does not start while quarantined or while Docker is unavailable, and releases
it only after recovery. Docker behavior is explicitly a test implementation.
Installer tests run only under the already-root local test runtime and never
escalate privileges. No server Docker behavior is claimed by these tests.

Server acceptance must still verify:

1. Exact installed module/queue/control hashes, preserved lock inode, ordinary
   queued command success, and no old runner admission while a candidate is armed.
2. A real, harmless bounded BuildKit operation, termination of the adapter,
   a competing ordinary sentinel still queued, and exact stopped-builder recovery.
3. Docker-daemon-unavailable and cleanup-exception cases. These must leave
   quarantine and must not admit the sentinel; restore access before recovery.
   Do not stop the shared production daemon to simulate this. Use an isolated
   test transport/fault injection in the dedicated acceptance process.
4. Successful normal cleanup, recovery replay after interruption, changed
   builder identity refusal, and no change to other projects' containers.
5. A resource receipt from the actual builder: approved image digest and ID,
   3 GiB memory maximum, no extra swap, 2 CPU maximum, 256 PIDs, its own volume
   and local bridge. The root Docker CLI currently has no Buildx plugin and no
   dedicated candidate builder was observed.

Real host inventory: x86_64 Linux, Docker CLI **29.1.3**. Docker's official
[Buildx releases](https://github.com/docker/buildx/releases/tag/v0.38.1) and
[driver documentation](https://docs.docker.com/build/builders/drivers/docker-container/)
are the approved source for a pinned CLI and driver options. The
[official image build recipe](https://github.com/docker-library/repo-info/blob/master/repos/docker/remote/dind.md)
records Linux amd64 Buildx v0.38.1 SHA-256
`e25d5cd675092bb5d1d03632fdc46cdf3fede7b514dc5f023a105e00d3ce5ad4`.
This is a reference, not an installed binary or approved BuildKit image digest.
Reverify the download bytes and actual daemon-side image digest before use.

## Complete database acceptance

The existing synthetic `midday_test` fixture was created with Drizzle push and
targeted migrations. It must not be labeled as a canonical installation or
assigned invented baseline history. The small `migration-chain-postgres` suite
tests the transaction mechanism with two synthetic upgrades, not the real chain.

The dedicated candidate bootstrap already has the required real-chain sequence:

1. Fresh, pinned platform creates its real Auth and Storage catalogs, with no
   users, objects, application tables or `agsaas_app` role; application writers
   remain stopped. No preview or stage data/config is copied.
2. Read the immutable baseline and every upgrade from the same clean exact source
   SHA. `migrationChain` sorts unique versions, hashes SQL and rejects transaction
   control statements. Required new order includes 094000, 095000, 100000,
   101000, 102000, 103000 after their reviewed earlier prerequisites.
3. In one rollback rehearsal, run provisioning, baseline, all upgrades and their
   actual migration-history INSERTs. Inspect absence of application tables,
   role and history after rollback. Inject a final failure in a fresh disposable
   acceptance transaction to prove the whole chain rolls back.
4. Commit the exact same complete string in one transaction with ON_ERROR_STOP,
   then verify baseline checksum, ordered statement metadata, extension schemas,
   grants/RLS, actual Auth sessions, Storage catalog and all domain functions.
5. Run the real PostgreSQL business suites and native Auth/Storage HTTP tests
   against the accepted isolated installation, using explicit session/role
   fixtures. Do not apply Drizzle push over this catalog or fake history to make
   tests pass. Repeat against the exact final source only after meaningful fixes.

Current access restrictions prevent the fresh protected platform creation and
real daemon acceptance. The reviewed scripts and source are ready for the
corresponding administrative step; no accepted release is implied.
