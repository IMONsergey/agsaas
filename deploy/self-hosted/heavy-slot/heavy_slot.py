"""Shared heavy-slot quarantine protocol; installed root-owned, no queue replacement.

Admission callers already own the original flock. A quarantine survives process
death and can be cleared only after independent exact Docker identity/stop proof.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import time
import uuid

PROTOCOL = 1
ROOT = Path('/var/lib/imon-heavy-slot')
LOCK = Path('/home/sergey/.local/state/imon-jobs/heavy.lock')
QUEUE = Path('/home/sergey/.local/bin/imon-job')
BUILDER_NAME = 'buildx_buildkit_agsaas-candidate-202611030'
BUILDER_VOLUME = BUILDER_NAME + '_state'
DOCKER = ['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock']


class SlotFailure(RuntimeError):
    pass


def require(value, message):
    if not value:
        raise SlotFailure(message)


def _json_write(path: Path, value: dict, *, exclusive: bool = False):
    """Durable publication. A partial write can only leave admission blocked."""
    data = (json.dumps(value, indent=2) + '\n').encode()
    if exclusive:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
        try:
            with os.fdopen(fd, 'wb', closefd=False) as output:
                output.write(data)
                output.flush()
                os.fsync(fd)
        finally:
            os.close(fd)
    else:
        temporary = path.with_name(path.name + '.next-' + uuid.uuid4().hex)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
        try:
            with os.fdopen(fd, 'wb') as output:
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)
    dfd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(dfd)
    finally:
        os.close(dfd)


class Control:
    def __init__(self, directory=ROOT, lock=LOCK, queue=QUEUE, *, owner_uid=0, docker=subprocess.run):
        self.directory, self.lock, self.queue = map(Path, (directory, lock, queue))
        self.owner_uid = owner_uid
        self.docker = docker

    @property
    def marker(self):
        return self.directory / 'quarantine.json'

    def _read(self, path):
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            info = os.fstat(fd)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == self.owner_uid and
                    info.st_nlink == 1 and not info.st_mode & 0o022 and info.st_size <= 65536,
                    'Unsafe shared heavy-slot control file')
            with os.fdopen(fd, 'r', closefd=False) as source:
                return json.load(source)
        finally:
            os.close(fd)

    def validate(self, fd, *, verify_queue=False):
        info = self.directory.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == self.owner_uid and not info.st_mode & 0o022 and
                self.directory.resolve() == self.directory, 'Shared heavy-slot protocol is not installed safely')
        protocol = self._read(self.directory / 'protocol.json')
        lock = os.fstat(fd)
        current = self.lock.lstat()
        require(stat.S_ISREG(lock.st_mode) and lock.st_nlink == 1 and not lock.st_mode & 0o077 and
                (lock.st_dev, lock.st_ino) == (current.st_dev, current.st_ino) and
                protocol.get('protocol') == PROTOCOL and protocol.get('lock') == str(self.lock) and
                protocol.get('lockIdentity') == [lock.st_dev, lock.st_ino],
                'Shared heavy-slot protocol or original lock identity changed')
        if verify_queue:
            require(protocol.get('queue') == str(self.queue) and self.queue.is_file() and not self.queue.is_symlink() and
                    hashlib.sha256(self.queue.read_bytes()).hexdigest() == protocol.get('queueSha256'),
                    'Installed queue differs from the reviewed quarantine protocol')
        return protocol

    def blocked(self):
        # Do not parse to decide admission: malformed/partial/symlink markers
        # also quarantine the slot. Only the audited recovery may parse/clear.
        try:
            self.marker.lstat()
            return True
        except FileNotFoundError:
            return False

    def compatible_runners(self):
        """Old interpreters retain old code after replacement; wait for drain."""
        for path in self.lock.parent.glob('*/status.json'):
            require(path.is_file() and not path.is_symlink(), 'Unsafe queue status while checking protocol drain')
            state = json.loads(path.read_text())
            if state.get('state') in ('queued', 'running'):
                require(state.get('heavySlotProtocol') == PROTOCOL,
                        'Pre-protocol queued/running job remains; let existing jobs finish or reconcile their status')

    def inspect_builder(self, expected=None):
        result = self.docker(DOCKER + ['container', 'inspect', BUILDER_NAME], capture_output=True, text=True, timeout=30)
        require(result.returncode == 0, 'Cannot independently verify candidate builder; heavy slot remains quarantined')
        values = json.loads(result.stdout)
        require(isinstance(values, list) and len(values) == 1, 'Ambiguous candidate builder identity')
        info = values[0]
        require(info.get('Name') == '/' + BUILDER_NAME and re.fullmatch('[a-f0-9]{64}', info.get('Id', '')) and
                re.fullmatch('sha256:[a-f0-9]{64}', info.get('Image', '')) and
                re.fullmatch('moby/buildkit@sha256:[a-f0-9]{64}', info.get('Config', {}).get('Image', '')),
                'Candidate builder image or identity is not pinned')
        identity = {'containerId': info['Id'], 'imageId': info['Image'], 'image': info['Config']['Image']}
        if expected is not None:
            require(identity == expected, 'Candidate builder identity changed; manual review required before recovery')
        limits = info.get('HostConfig', {})
        memory, swap = limits.get('Memory', 0), limits.get('MemorySwap', 0)
        nano, period, quota = limits.get('NanoCpus', 0), limits.get('CpuPeriod', 0), limits.get('CpuQuota', 0)
        cpus = nano / 1e9 if nano > 0 else quota / period if period > 0 and quota > 0 else 0
        pids = limits.get('PidsLimit', 0)
        mounts = info.get('Mounts', [])
        require(0 < memory <= 3 * 1024**3 and swap == memory and 0 < cpus <= 2 and
                isinstance(pids, int) and 0 < pids <= 256 and
                limits.get('NetworkMode') in ('bridge', 'default') and not limits.get('PortBindings') and
                len(mounts) == 1 and mounts[0].get('Type') == 'volume' and
                mounts[0].get('Name') == BUILDER_VOLUME and mounts[0].get('Destination') == '/var/lib/buildkit',
                'Candidate builder resource or namespace bounds changed')
        require(isinstance(info.get('State', {}).get('Running'), bool), 'Unknown candidate builder running state')
        return info, identity

    def arm_candidate(self, fd):
        require(os.geteuid() == self.owner_uid, 'Only the deployment owner can arm heavy-slot quarantine')
        self.validate(fd, verify_queue=True)
        self.compatible_runners()
        require(not self.blocked(), 'Previous shared heavy-slot quarantine requires recovery')
        _, identity = self.inspect_builder()
        receipt = {'protocol': PROTOCOL, 'operationId': uuid.uuid4().hex,
                   'project': 'agsaas-candidate-20261103', 'builder': identity,
                   'armedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'adapterPid': os.getpid()}
        _json_write(self.marker, receipt, exclusive=True)
        return receipt

    def recover_candidate(self, fd, *, before_clear=None):
        """Only exact stopped container proof releases quarantine; no age timeout."""
        require(os.geteuid() == self.owner_uid, 'Only the deployment owner can recover heavy-slot quarantine')
        self.validate(fd, verify_queue=True)
        receipt = self._read(self.marker)
        require(receipt.get('protocol') == PROTOCOL and receipt.get('project') == 'agsaas-candidate-20261103' and
                re.fullmatch('[a-f0-9]{32}', receipt.get('operationId', '')) and
                isinstance(receipt.get('builder'), dict), 'Malformed quarantine receipt; manual review required')
        info, _ = self.inspect_builder(receipt['builder'])
        if info['State']['Running']:
            try:
                self.docker(DOCKER + ['stop', '--time', '30', info['Id']], capture_output=True, text=True, timeout=90)
            except subprocess.TimeoutExpired:
                pass
            info, _ = self.inspect_builder(receipt['builder'])
            if info['State']['Running']:
                self.docker(DOCKER + ['kill', info['Id']], capture_output=True, text=True, timeout=30)
                info, _ = self.inspect_builder(receipt['builder'])
        require(not info['State']['Running'], 'Candidate builder stop unconfirmed; heavy slot remains quarantined')
        # Re-read the same operation before destructive cleanup, even under the
        # shared lock, so recovery cannot remove a replaced operator receipt.
        require(self._read(self.marker) == receipt, 'Quarantine changed during recovery')
        if before_clear is not None:
            before_clear(receipt)
        completed = {**receipt, 'stoppedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
        archive = self.directory / ('recovered-' + receipt['operationId'] + '.json')
        if archive.exists():
            previous = self._read(archive)
            require({key: value for key, value in previous.items() if key != 'stoppedAt'} == receipt,
                    'Recovery receipt conflicts with this operation')
            completed = previous
        else:
            _json_write(archive, completed, exclusive=True)
        self.marker.unlink()
        dfd = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
        return completed
