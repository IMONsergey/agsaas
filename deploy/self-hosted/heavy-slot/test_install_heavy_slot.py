import contextlib
import importlib.util
import io
import os
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('installer', HERE / 'install-heavy-slot.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


@unittest.skipUnless(os.getuid() == 0, 'Installer ownership fixture requires local root; never escalates')
class InstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.queue = self.root / 'queue'
        self.before = (HERE / 'imon-job.canonical-home.py').read_bytes()
        self.after = (HERE / 'imon-job.py').read_bytes()
        self.queue.write_bytes(self.before); self.queue.chmod(0o755)
        self.lock = self.root / 'heavy.lock'; self.lock.write_bytes(b''); self.lock.chmod(0o600)
        self.module = self.root / 'lib' / 'heavy_slot.py'
        self.control = self.root / 'control'
        self.patches = [patch.object(installer, 'QUEUE', self.queue), patch.object(installer, 'LOCK', self.lock),
                        patch.object(installer, 'MODULE', self.module), patch.object(installer, 'CONTROL', self.control),
                        patch.object(installer, 'BACKUP_ROOT', self.root / 'backups'),
                        patch.object(installer.pwd, 'getpwnam', lambda _: SimpleNamespace(pw_uid=0))]
        for item in self.patches: item.start()

    def tearDown(self):
        for item in reversed(self.patches): item.stop()
        self.temp.cleanup()

    def run_install(self, apply=True):
        with patch.object(installer.os, 'geteuid', lambda: 0), patch('sys.argv', ['installer'] + (['--apply'] if apply else [])), contextlib.redirect_stdout(io.StringIO()):
            installer.main()

    def test_check_is_read_only(self):
        self.run_install(False)
        self.assertEqual(self.queue.read_bytes(), self.before)
        self.assertFalse(self.module.exists())
        self.assertFalse(self.control.exists())

    def test_unknown_module_rejected_without_queue_or_module_write(self):
        self.module.parent.mkdir(); self.module.write_text('unknown revision')
        with self.assertRaisesRegex(RuntimeError, 'Unknown installed'): self.run_install()
        self.assertEqual(self.queue.read_bytes(), self.before)
        self.assertEqual(self.module.read_text(), 'unknown revision')

    def test_unknown_protocol_rejected_without_writes(self):
        self.control.mkdir(); (self.control / 'protocol.json').write_text('{}')
        with self.assertRaisesRegex(RuntimeError, 'Unknown installed'): self.run_install()
        self.assertFalse(self.module.exists())
        self.assertEqual(self.queue.read_bytes(), self.before)

    def test_partial_install_queue_cas_failure_preserves_foreign_queue(self):
        original = installer.atomic
        def changing_atomic(path, body, mode, uid, gid):
            original(path, body, mode, uid, gid)
            if path == self.module: self.queue.write_text('concurrent queue change')
        with patch.object(installer, 'atomic', changing_atomic):
            with self.assertRaisesRegex(RuntimeError, 'Queue changed'): self.run_install()
        self.assertEqual(self.queue.read_text(), 'concurrent queue change')
        self.assertTrue(self.module.exists())
        self.assertTrue((self.control / 'protocol.json').exists())
        import heavy_slot
        fd = os.open(self.lock, os.O_RDWR)
        try:
            with self.assertRaisesRegex(heavy_slot.SlotFailure, 'differs'):
                heavy_slot.Control(self.control, self.lock, self.queue).validate(fd, verify_queue=True)
        finally: os.close(fd)

    def test_install_and_replay_preserve_lock_and_do_not_rewrite(self):
        identity = self.lock.stat().st_ino
        self.run_install()
        self.assertEqual(self.queue.read_bytes(), self.after)
        self.assertEqual(self.lock.stat().st_ino, identity)
        queue_inode = self.queue.stat().st_ino
        self.run_install()
        self.assertEqual(self.queue.stat().st_ino, queue_inode)
        self.assertEqual(len(list((self.root / 'backups').iterdir())), 1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
