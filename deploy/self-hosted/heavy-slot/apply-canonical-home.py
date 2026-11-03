#!/usr/bin/env python3
"""UID1000 source-only queue HOME fix; default check, no job or lock changes."""
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

def require(value, message):
    if not value:
        raise RuntimeError(message)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    require(os.getuid() == pwd.getpwnam('sergey').pw_uid, 'Run as ordinary workstation user')
    before, after = ((HERE / name).read_bytes() for name in ('imon-job.observed.py', 'imon-job.canonical-home.py'))
    current = QUEUE.read_bytes()
    info = QUEUE.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o022,
            'Queue owner or mode changed')
    require(current in (before, after), 'Queue differs from observed base and canonical HOME patch')
    lock = LOCK.lstat()
    require(stat.S_ISREG(lock.st_mode) and lock.st_uid == os.getuid() and lock.st_nlink == 1 and not lock.st_mode & 0o077,
            'Original shared lock is unsafe')
    receipt = {'mode': 'apply' if args.apply else 'check', 'alreadyApplied': current == after,
               'beforeSha256': hashlib.sha256(current).hexdigest(), 'afterSha256': hashlib.sha256(after).hexdigest(),
               'heavyLockIdentity': [lock.st_dev, lock.st_ino], 'existingRunnersRestarted': False}
    if args.apply and current != after:
        backup = Path('/home/sergey/Work/Reports/agsaas-completion-20261103') / ('queue-canonical-home-' + time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()))
        backup.mkdir(mode=0o700, exist_ok=False)
        saved = backup / 'imon-job.before.py'; saved.write_bytes(current); saved.chmod(0o600)
        (backup / 'receipt.json').write_text(json.dumps(receipt, indent=2))
        print(json.dumps({'backup': str(backup), 'state': 'prepared'}), flush=True)
        require(QUEUE.read_bytes() == current, 'Queue changed after preflight')
        require((LOCK.lstat().st_dev, LOCK.lstat().st_ino) == (lock.st_dev, lock.st_ino), 'Original lock identity changed')
        fd, name = tempfile.mkstemp(prefix='.canonical-home-', dir=QUEUE.parent)
        try:
            with os.fdopen(fd, 'wb') as output:
                output.write(after); output.flush(); os.fsync(output.fileno())
            os.chmod(name, info.st_mode & 0o777)
            os.replace(name, QUEUE)
            dfd = os.open(QUEUE.parent, os.O_RDONLY | os.O_DIRECTORY)
            try: os.fsync(dfd)
            finally: os.close(dfd)
        finally:
            Path(name).unlink(missing_ok=True)
    print(json.dumps(receipt, indent=2))

if __name__ == '__main__':
    main()
