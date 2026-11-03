import importlib.util
import json
import os
from pathlib import Path
import pwd
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('heavy_slot', HERE / 'heavy_slot.py')
slot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(slot)


def builder():
    return {'Id': 'a' * 64, 'Name': '/' + slot.BUILDER_NAME, 'Image': 'sha256:' + 'b' * 64,
            'Config': {'Image': 'moby/buildkit@sha256:' + 'c' * 64}, 'State': {'Running': True},
            'HostConfig': {'Memory': 3 * 1024**3, 'MemorySwap': 3 * 1024**3, 'NanoCpus': 2_000_000_000,
                           'PidsLimit': 256, 'NetworkMode': 'bridge', 'PortBindings': {}},
            'Mounts': [{'Type': 'volume', 'Name': slot.BUILDER_VOLUME, 'Destination': '/var/lib/buildkit'}]}


class Docker:
    def __init__(self):
        self.info = builder()
        self.unavailable = False
        self.refuse_stop = False
        self.calls = []

    def __call__(self, argv, **kwargs):
        self.calls.append(argv)
        if self.unavailable:
            return subprocess.CompletedProcess(argv, 1, '', 'unavailable')
        if 'inspect' in argv:
            return subprocess.CompletedProcess(argv, 0, json.dumps([self.info]), '')
        if 'stop' in argv or 'kill' in argv:
            if not self.refuse_stop:
                self.info['State']['Running'] = False
            return subprocess.CompletedProcess(argv, 0, '', '')
        raise AssertionError(argv)


class Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.directory = self.root / 'control'
        self.directory.mkdir(mode=0o755)
        self.spool = self.root / 'spool'
        self.spool.mkdir(mode=0o700)
        self.lock = self.spool / 'heavy.lock'
        self.fd = os.open(self.lock, os.O_CREAT | os.O_RDWR, 0o600)
        self.identity = (self.lock.stat().st_dev, self.lock.stat().st_ino)
        self.queue = HERE / 'imon-job.py'
        protocol = {'protocol': 1, 'lock': str(self.lock), 'lockIdentity': list(self.identity),
                    'queue': str(self.queue), 'queueSha256': slot.hashlib.sha256(self.queue.read_bytes()).hexdigest()}
        slot._json_write(self.directory / 'protocol.json', protocol)
        self.docker = Docker()
        self.control = slot.Control(self.directory, self.lock, self.queue, owner_uid=os.getuid(), docker=self.docker)

    def tearDown(self):
        os.close(self.fd)
        self.temp.cleanup()

    def test_valid_protocol_preserves_original_inode(self):
        self.control.validate(self.fd, verify_queue=True)
        self.assertFalse(self.control.blocked())
        self.assertEqual(self.identity, (self.lock.stat().st_dev, self.lock.stat().st_ino))

    def test_canonical_queue_home_ignores_connector_home(self):
        code = "import importlib.util; p=importlib.util.spec_from_file_location('q',%r); m=importlib.util.module_from_spec(p);p.loader.exec_module(m);print(m.BASE)" % str(self.queue)
        result = subprocess.run([sys.executable, '-c', code], env={**os.environ, 'HOME': str(self.root / 'false-home')}, text=True, capture_output=True, check=True)
        self.assertEqual(result.stdout.strip(), str(Path(pwd.getpwuid(os.getuid()).pw_dir) / '.local/state/imon-jobs'))

    def test_partial_marker_is_admission_block(self):
        self.control.marker.write_text('{partial')
        self.assertTrue(self.control.blocked())
        with self.assertRaises(json.JSONDecodeError):
            self.control.recover_candidate(self.fd)
        self.assertTrue(self.control.blocked())

    def test_marker_symlink_is_blocked_and_not_read(self):
        outside = self.root / 'outside'; outside.write_text('{}')
        self.control.marker.symlink_to(outside)
        self.assertTrue(self.control.blocked())
        with self.assertRaises(OSError): self.control.recover_candidate(self.fd)
        self.assertEqual(outside.read_text(), '{}')

    def test_no_silent_overwrite_of_existing_quarantine(self):
        first = self.control.arm_candidate(self.fd)
        with self.assertRaises(slot.SlotFailure): self.control.arm_candidate(self.fd)
        self.assertEqual(self.control._read(self.control.marker), first)

    def test_old_runner_blocks_candidate_without_stopping_job(self):
        job = self.spool / 'old'; job.mkdir()
        state = {'state': 'queued', 'id': 'old'}
        (job / 'status.json').write_text(json.dumps(state))
        with self.assertRaisesRegex(slot.SlotFailure, 'Pre-protocol'): self.control.arm_candidate(self.fd)
        self.assertFalse(self.control.blocked())
        self.assertEqual(json.loads((job / 'status.json').read_text()), state)
        state['state'] = 'succeeded'; (job / 'status.json').write_text(json.dumps(state))
        self.control.arm_candidate(self.fd)
        self.assertTrue(self.control.blocked())

    def test_daemon_unavailable_keeps_quarantine(self):
        self.control.arm_candidate(self.fd)
        self.docker.unavailable = True
        with self.assertRaises(slot.SlotFailure): self.control.recover_candidate(self.fd)
        self.assertTrue(self.control.blocked())

    def test_cleanup_exception_keeps_quarantine(self):
        self.control.arm_candidate(self.fd)
        def fail(receipt): raise RuntimeError('manifest write failure')
        with self.assertRaisesRegex(RuntimeError, 'manifest write failure'):
            self.control.recover_candidate(self.fd, before_clear=fail)
        self.assertTrue(self.control.blocked())
        self.assertFalse(self.docker.info['State']['Running'])

    def test_changed_builder_is_never_stopped(self):
        self.control.arm_candidate(self.fd)
        self.docker.info['Id'] = 'd' * 64
        with self.assertRaisesRegex(slot.SlotFailure, 'identity changed'): self.control.recover_candidate(self.fd)
        self.assertFalse(any('stop' in call or 'kill' in call for call in self.docker.calls))
        self.assertTrue(self.control.blocked())

    def test_unconfirmed_stop_never_releases_admission(self):
        self.control.arm_candidate(self.fd)
        self.docker.refuse_stop = True
        with self.assertRaisesRegex(slot.SlotFailure, 'stop unconfirmed'): self.control.recover_candidate(self.fd)
        self.assertTrue(self.control.blocked())

    def test_confirmed_exact_stop_records_recovery_and_releases(self):
        armed = self.control.arm_candidate(self.fd)
        recovered = self.control.recover_candidate(self.fd)
        self.assertFalse(self.control.blocked())
        self.assertEqual(recovered['operationId'], armed['operationId'])
        self.assertFalse(self.docker.info['State']['Running'])
        self.assertTrue((self.directory / ('recovered-' + armed['operationId'] + '.json')).exists())
        self.assertEqual(self.identity, (self.lock.stat().st_dev, self.lock.stat().st_ino))

    def test_retry_after_record_before_unlink_is_idempotent(self):
        armed = self.control.arm_candidate(self.fd)
        self.docker.info['State']['Running'] = False
        prior = {**armed, 'stoppedAt': '2026-11-03T00:00:00Z'}
        slot._json_write(self.directory / ('recovered-' + armed['operationId'] + '.json'), prior)
        self.assertEqual(self.control.recover_candidate(self.fd), prior)
        self.assertFalse(self.control.blocked())

    def test_queue_source_drift_refuses_candidate(self):
        protocol = self.control._read(self.directory / 'protocol.json')
        protocol['queueSha256'] = '0' * 64
        slot._json_write(self.directory / 'protocol.json', protocol)
        with self.assertRaisesRegex(slot.SlotFailure, 'differs'): self.control.arm_candidate(self.fd)
        self.assertFalse(self.control.blocked())

    def test_unbounded_builder_refuses_arm(self):
        self.docker.info['HostConfig']['Memory'] = 0
        with self.assertRaisesRegex(slot.SlotFailure, 'bounds changed'): self.control.arm_candidate(self.fd)
        self.assertFalse(self.control.blocked())

    def test_sigkill_then_actual_queue_cannot_admit_until_recovery(self):
        # Real process and flock, actual queue.run implementation; Docker alone
        # is explicit in-memory test transport. This is not a daemon E2E claim.
        worker_code = '''import sys,fcntl,os,time
sys.path.insert(0,sys.argv[1])
from test_heavy_slot import slot,Docker
control=slot.Control(sys.argv[2],sys.argv[3],sys.argv[4],owner_uid=os.getuid(),docker=Docker())
fd=os.open(sys.argv[3],os.O_RDWR)
fcntl.flock(fd,fcntl.LOCK_EX)
control.arm_candidate(fd)
print('armed',flush=True)
time.sleep(20)
'''
        worker = subprocess.Popen([sys.executable, '-c', worker_code, str(HERE), str(self.directory), str(self.lock), str(self.queue)], stdout=subprocess.PIPE, text=True)
        runner = None
        try:
            self.assertEqual(worker.stdout.readline().strip(), 'armed')
            os.kill(worker.pid, signal.SIGKILL); worker.wait(timeout=5)
            self.assertTrue(self.control.blocked())
            job_id = '20261103T000000-1234567890'
            job = self.spool / job_id; job.mkdir()
            boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
            output = self.root / 'admitted'
            request = {'cwd': str(self.root), 'argv': [sys.executable, '-c', 'from pathlib import Path;Path(' + repr(str(output)) + ').write_text("yes")'], 'timeout': 5, 'bootId': boot, 'env': {}}
            (job / 'request.json').write_text(json.dumps(request))
            (job / 'status.json').write_text(json.dumps({'state': 'queued', 'id': job_id}))
            runner_code = '''import sys,importlib.util,os
sys.path.insert(0,sys.argv[1])
from test_heavy_slot import slot,Docker
from pathlib import Path
spec=importlib.util.spec_from_file_location('queue',sys.argv[4]);q=importlib.util.module_from_spec(spec);spec.loader.exec_module(q)
q.BASE=Path(sys.argv[3]).parent
q.RESERVE=0
control=slot.Control(sys.argv[2],sys.argv[3],sys.argv[4],owner_uid=os.getuid(),docker=Docker())
q.heavy_control=lambda: control
sys.exit(q.run(sys.argv[5]))
'''
            runner = subprocess.Popen([sys.executable, '-c', runner_code, str(HERE), str(self.directory), str(self.lock), str(self.queue), job_id])
            deadline = time.monotonic() + 5
            while json.loads((job / 'status.json').read_text()).get('heavySlotProtocol') != 1 and time.monotonic() < deadline:
                time.sleep(.01)
            time.sleep(.3)
            self.assertIsNone(runner.poll())
            self.assertFalse(output.exists())
            self.docker.unavailable = True
            with self.assertRaises(slot.SlotFailure): self.control.recover_candidate(self.fd)
            time.sleep(.3)
            self.assertFalse(output.exists())
            self.docker.unavailable = False
            import fcntl
            fcntl.flock(self.fd, fcntl.LOCK_EX)
            self.control.recover_candidate(self.fd)
            fcntl.flock(self.fd, fcntl.LOCK_UN)
            self.assertEqual(runner.wait(timeout=5), 0)
            self.assertEqual(output.read_text(), 'yes')
            self.assertEqual(json.loads((job / 'status.json').read_text())['state'], 'succeeded')
        finally:
            if worker.poll() is None: worker.kill(); worker.wait(timeout=5)
            if worker.stdout: worker.stdout.close()
            if runner is not None and runner.poll() is None: runner.kill(); runner.wait(timeout=5)


if __name__ == '__main__':
    unittest.main(verbosity=2)
