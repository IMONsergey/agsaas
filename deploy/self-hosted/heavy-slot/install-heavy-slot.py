#!/usr/bin/env python3
"""Install reviewed queue admission without replacing the existing heavy lock.

Default is read-only. Does not stop/restart/cancel an existing unit or runner.
Candidate remains refused while any old queued/running interpreter survives.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import stat
import tempfile
import time

HERE = Path(__file__).resolve().parent
QUEUE = Path('/home/sergey/.local/bin/imon-job')
LOCK = Path('/home/sergey/.local/state/imon-jobs/heavy.lock')
MODULE = Path('/usr/local/lib/imon/heavy_slot.py')
CONTROL = Path('/var/lib/imon-heavy-slot')
BACKUP_ROOT = Path('/var/backups/imon-heavy-slot')


def require(value, message):
    if not value:
        raise RuntimeError(message)


def root_owned(metadata):
    return metadata.st_uid == 0


def atomic(path, body, mode, uid, gid):
    fd, temporary = tempfile.mkstemp(prefix='.heavy-slot-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(body)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, mode)
        os.chown(temporary, uid, gid)
        os.replace(temporary, path)
        dfd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    finally:
        Path(temporary).unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    require(os.geteuid() == 0, 'Run the installation preflight as the deployment owner')
    user = pwd.getpwnam('sergey')
    before = (HERE / 'imon-job.observed.py').read_bytes()
    after = (HERE / 'imon-job.py').read_bytes()
    canonical = (HERE / 'imon-job.canonical-home.py').read_bytes()
    module = (HERE / 'heavy_slot.py').read_bytes()
    current = QUEUE.read_bytes()
    info = QUEUE.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == user.pw_uid and not info.st_mode & 0o022,
            'Queue owner or mode changed')
    require(current in (before, canonical, after), 'Queue differs from the observed base and reviewed final version')
    lock = LOCK.lstat()
    require(stat.S_ISREG(lock.st_mode) and lock.st_uid == user.pw_uid and lock.st_nlink == 1 and not lock.st_mode & 0o077,
            'Original heavy lock is unsafe')
    require(not os.path.lexists(CONTROL / 'quarantine.json'), 'Existing quarantine must be recovered before an installation')
    for path in (MODULE.parent, CONTROL):
        if path.exists():
            metadata = path.lstat()
            require(stat.S_ISDIR(metadata.st_mode) and root_owned(metadata) and not metadata.st_mode & 0o022 and path.resolve() == path,
                    'Existing protocol directory is unsafe')
    protocol = {'protocol': 1, 'lock': str(LOCK), 'lockIdentity': [lock.st_dev, lock.st_ino],
                'queue': str(QUEUE), 'queueSha256': hashlib.sha256(after).hexdigest()}
    protocol_bytes = (json.dumps(protocol, indent=2) + '\n').encode()
    # No unknown installed revision is overwritten. This installer supports a
    # fresh install and completion/replay of exactly these reviewed bytes only.
    existing = {}
    for path, expected in ((MODULE, module), (CONTROL / 'protocol.json', protocol_bytes)):
        if os.path.lexists(path):
            metadata = path.lstat()
            require(stat.S_ISREG(metadata.st_mode) and root_owned(metadata) and metadata.st_nlink == 1 and
                    not metadata.st_mode & 0o022, 'Existing protocol file is unsafe')
            value = path.read_bytes()
            require(value == expected, 'Unknown installed protocol/module revision; review and preserve it before upgrade')
            existing[path] = value
    already = current == after and len(existing) == 2
    receipt = {'mode': 'apply' if args.apply else 'check', 'lockPreserved': protocol['lockIdentity'],
               'queueBeforeSha256': hashlib.sha256(current).hexdigest(), 'queueAfterSha256': protocol['queueSha256'],
               'moduleSha256': hashlib.sha256(module).hexdigest(), 'existingRunnersRestarted': False,
               'alreadyApplied': already}
    if args.apply and not already:
        backup = BACKUP_ROOT / time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
        backup.mkdir(mode=0o700, parents=True, exist_ok=False)
        (backup / 'imon-job.before.py').write_bytes(current)
        (backup / 'installation.json').write_text(json.dumps(receipt, indent=2))
        for path, value in existing.items():
            saved = backup / (path.name + '.before')
            saved.write_bytes(value)
            saved.chmod(0o600)
        os.chmod(backup / 'imon-job.before.py', 0o600)
        os.chmod(backup / 'installation.json', 0o600)
        print(json.dumps({'backup': str(backup), 'state': 'preparing'}), flush=True)
        MODULE.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        CONTROL.mkdir(mode=0o755, parents=True, exist_ok=True)
        atomic(MODULE, module, 0o644, 0, 0)
        atomic(CONTROL / 'protocol.json', protocol_bytes, 0o644, 0, 0)
        require(QUEUE.read_bytes() == current, 'Queue changed during protocol installation; no queue replacement performed')
        require((LOCK.lstat().st_dev, LOCK.lstat().st_ino) == (lock.st_dev, lock.st_ino), 'Lock identity changed')
        atomic(QUEUE, after, info.st_mode & 0o777, info.st_uid, info.st_gid)
    print(json.dumps(receipt, indent=2))


if __name__ == '__main__':
    main()
