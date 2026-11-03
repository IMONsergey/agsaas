#!/usr/bin/python3
"""Local, non-root job spool supervised by user systemd. No shell evaluation."""
import argparse
import contextlib
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import pwd
import re
import selectors
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid

BASE = Path.home() / ".local/state/imon-jobs"
RESERVE = 8 * 1024**3
DISK_CHECK_INTERVAL = 1.0
LOG_LIMIT = 20 * 1024**2
LOG_MARKER = b"\n[imon-job: output truncated at 20 MiB; remaining output drained]\n"
TERMINAL = {"succeeded", "failed", "cancelled", "interrupted"}
ID_RE = re.compile(r"^[0-9]{8}T[0-9]{6}-[0-9a-f]{10}$")
ENV_KEYS = ("LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "CI", "NO_COLOR", "FORCE_COLOR", "PLAYWRIGHT_BROWSERS_PATH")


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def boot_id():
    return Path("/proc/sys/kernel/random/boot_id").read_text().strip()


def ensure():
    BASE.mkdir(parents=True, mode=0o700, exist_ok=True)
    if BASE.is_symlink() or BASE.stat().st_uid != os.getuid():
        raise ValueError("Job directory must belong to the current user and not be a symlink")
    BASE.chmod(0o700)


def job_dir(job_id):
    if not ID_RE.fullmatch(job_id):
        raise ValueError("Invalid job ID")
    path = BASE / job_id
    if not path.is_dir() or path.is_symlink():
        raise ValueError("Job not found")
    return path


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def atomic_json(path, data):
    fd, tmp = tempfile.mkstemp(prefix=".write-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            json.dump(data, out, ensure_ascii=False, indent=2)
            out.write("\n")
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp, path)
        dfd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


@contextlib.contextmanager
def locked(path):
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield fd
    finally:
        os.close(fd)


def update(path, **fields):
    with locked(path / "status.lock"):
        state = read_json(path / "status.json")
        state.update(fields, updatedAt=now())
        atomic_json(path / "status.json", state)
    return state


def systemctl(*args):
    env = os.environ.copy()
    runtime = Path(f"/run/user/{os.getuid()}")
    if (runtime / "bus").is_socket():
        env.setdefault("XDG_RUNTIME_DIR", str(runtime))
        env.setdefault("DBUS_SESSION_BUS_ADDRESS", f"unix:path={runtime}/bus")
    return subprocess.run(["systemctl", "--user", *args], env=env, text=True,
                          capture_output=True, timeout=40)


def unit(job_id):
    return f"imon-job@{job_id}.service"


def properties(job_id):
    result = systemctl("show", unit(job_id), "-p", "LoadState,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus")
    if result.returncode:
        raise RuntimeError("Cannot read user systemd status; no job state changed")
    return dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)


def check_disk(cwd):
    for path in {BASE, Path(cwd)}:
        if shutil.disk_usage(path).free < RESERVE:
            raise RuntimeError(f"Less than 8 GiB free on filesystem containing {path}")


def parse_env(path):
    values = {}
    if not path.is_absolute() or not path.is_file():
        raise ValueError("--env-file requires an absolute existing file")
    for number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, separator, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if not separator or not re.fullmatch(r"[A-Za-z_][A-Za-z_0-9]*", key):
            raise ValueError(f"Invalid env-file entry on line {number}")
        try:
            if value.startswith('"'):
                value = json.loads(value)
                if not isinstance(value, str):
                    raise ValueError()
            elif value.startswith("'"):
                if len(value) < 2 or not value.endswith("'"):
                    raise ValueError()
                value = value[1:-1]
            if "\0" in value:
                raise ValueError()
        except (ValueError, TypeError):
            raise ValueError(f"Invalid env-file value on line {number}") from None
        values[key] = value
    return values


def submit(args):
    cwd = Path(args.cwd)
    if not cwd.is_absolute() or not cwd.is_dir():
        raise ValueError("--cwd requires an absolute existing directory")
    cwd = cwd.resolve()
    argv = args.argv[1:] if args.argv[:1] == ["--"] else args.argv
    if not argv or args.timeout <= 0:
        raise ValueError("Provide a command after -- and a positive timeout")
    extra_env = parse_env(Path(args.env_file)) if args.env_file else None
    check_disk(cwd)
    with locked(BASE / "submit.lock"):
        waiting = sum(read_json(p).get("state") == "queued" for p in BASE.glob("*/status.json"))
        if waiting >= 10:
            raise RuntimeError("Queue already has 10 waiting jobs; inspect or reconcile it")
        job_id = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:10]
        path = BASE / job_id
        path.mkdir(mode=0o700)
        (path / "artifacts").mkdir(mode=0o700)
        request = {"id": job_id, "cwd": str(cwd), "argv": argv, "timeout": args.timeout,
                   "createdAt": now(), "bootId": boot_id(),
                   "env": {key: os.environ[key] for key in ENV_KEYS if key in os.environ},
                   "envFile": str(Path(args.env_file).resolve()) if args.env_file else None}
        atomic_json(path / "request.json", request)
        if extra_env is not None:
            atomic_json(path / "environment.json", extra_env)
        atomic_json(path / "status.json", {"id": job_id, "state": "queued", "createdAt": request["createdAt"],
                    "bootId": request["bootId"], "unit": unit(job_id), "exitCode": None})
        try:
            result = systemctl("start", unit(job_id))
        except (OSError, subprocess.TimeoutExpired):
            print(job_id)
            raise RuntimeError("Start outcome unknown; inspect this same job ID, do not resubmit") from None
        if result.returncode:
            update(path, state="failed", finishedAt=now(), reason="systemd-start-failed")
            raise RuntimeError(f"User systemd could not start job {job_id}: {result.stderr.strip()}")
    print(job_id)


def run(job_id):
    path = job_dir(job_id)
    request = read_json(path / "request.json")
    if read_json(path / "status.json")["state"] != "queued":
        return 125
    if request["bootId"] != boot_id():
        update(path, state="interrupted", finishedAt=now(), reason="host-reboot")
        return 125
    update(path, invocationId=os.environ.get("INVOCATION_ID"))
    stop = [False]
    previous = {sig: signal.signal(sig, lambda *_: stop.__setitem__(0, True)) for sig in (signal.SIGTERM, signal.SIGINT)}
    lock_fd = os.open(BASE / "heavy.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    child = None
    try:
        while not stop[0]:
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                time.sleep(0.2)
        if stop[0] or read_json(path / "status.json").get("cancelRequestedAt"):
            cancelled = bool(read_json(path / "status.json").get("cancelRequestedAt"))
            update(path, state="cancelled" if cancelled else "interrupted", finishedAt=now(), exitCode=130)
            return 130
        check_disk(request["cwd"])
        name = pwd.getpwuid(os.getuid()).pw_name
        env = {"HOME": str(Path.home()), "USER": name, "LOGNAME": name,
               "PATH": f"/opt/imon-runtime/node/bin:{Path.home()}/.local/bin:/usr/local/bin:/usr/bin:/bin"}
        env.update(request["env"])
        if (path / "environment.json").exists():
            env.update(read_json(path / "environment.json"))
        update(path, state="running", startedAt=now(), runnerPid=os.getpid())
        if stop[0]:
            return 130  # ExecStopPost records interrupted/cancelled without starting the command.
        started = time.monotonic()
        child = subprocess.Popen(request["argv"], cwd=request["cwd"], env=env, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
        os.set_blocking(child.stdout.fileno(), False)
        selector = selectors.DefaultSelector()
        selector.register(child.stdout, selectors.EVENT_READ)
        written, truncated, timeout_hit, term_at, exit_at = 0, False, False, None, None
        disk_breached, disk_free = False, None
        next_disk_check = started + DISK_CHECK_INTERVAL
        with open(path / "output.log", "xb", buffering=0) as output:
            os.chmod(path / "output.log", 0o600)
            while True:
                tick = time.monotonic()
                elapsed = tick - started
                timeout_hit = timeout_hit or elapsed >= request["timeout"]
                if tick >= next_disk_check and term_at is None and child.poll() is None:
                    next_disk_check = tick + DISK_CHECK_INTERVAL
                    free = shutil.disk_usage(request["cwd"]).free
                    if free < RESERVE:
                        disk_breached, disk_free = True, free
                        update(path, diskReserveBreached=True, diskFreeBytesAtStop=free,
                               diskReserveBytes=RESERVE, diskCheckPath=request["cwd"],
                               reason="disk-reserve-breached")
                if (stop[0] or timeout_hit or disk_breached) and term_at is None:
                    term_at = time.monotonic()
                    with contextlib.suppress(ProcessLookupError):
                        os.killpg(child.pid, signal.SIGTERM)
                if term_at is not None and time.monotonic() - term_at >= 10:
                    with contextlib.suppress(ProcessLookupError):
                        os.killpg(child.pid, signal.SIGKILL)
                for key, _ in selector.select(0.1):
                    try:
                        chunk = os.read(key.fd, 65536)
                    except BlockingIOError:
                        continue
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    amount = min(len(chunk), max(0, LOG_LIMIT - len(LOG_MARKER) - written))
                    if amount:
                        output.write(chunk[:amount])
                        written += amount
                    if amount < len(chunk) and not truncated:
                        output.write(LOG_MARKER)
                        truncated = True
                if child.poll() is not None:
                    exit_at = exit_at or time.monotonic()
                    if not selector.get_map() or time.monotonic() - exit_at > 1:
                        break
            selector.close()
            child.stdout.close()
        code = child.wait()
        cancelled = bool(read_json(path / "status.json").get("cancelRequestedAt"))
        state = "failed" if disk_breached else "cancelled" if stop[0] and cancelled else "interrupted" if stop[0] else "failed" if timeout_hit or code else "succeeded"
        update(path, state=state, finishedAt=now(), exitCode=code, timedOut=timeout_hit, logTruncated=truncated,
               diskReserveBreached=disk_breached, diskFreeBytesAtStop=disk_free,
               reason="disk-reserve-breached" if disk_breached else "timeout" if timeout_hit else "cancel-requested" if cancelled and stop[0] else None)
        return 125 if disk_breached else 124 if timeout_hit else 130 if stop[0] else code if code >= 0 else 128 - code
    except Exception as exc:
        update(path, state="failed", finishedAt=now(), exitCode=1, reason=type(exc).__name__, error=str(exc))
        return 1
    finally:
        if child is not None and child.poll() is None:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(child.pid, signal.SIGKILL)
            child.wait()
        os.close(lock_fd)
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def finalize(job_id, values=None):
    path = job_dir(job_id)
    state = read_json(path / "status.json")
    invocation = os.environ.get("INVOCATION_ID")
    if values is None and invocation and state.get("invocationId") and state["invocationId"] != invocation:
        return state  # A refused replay must not replace the previous execution result.
    values = values if values is not None else {key: os.environ.get(key) for key in ("SERVICE_RESULT", "EXIT_CODE", "EXIT_STATUS")}
    result, code, exit_status = (values.get(key) for key in ("SERVICE_RESULT", "EXIT_CODE", "EXIT_STATUS"))
    fields = {"systemdResult": result, "systemdExitCode": code, "systemdExitStatus": exit_status, "finalizedAt": now()}
    if state["state"] not in TERMINAL:
        outcome = "cancelled" if state.get("cancelRequestedAt") else "succeeded" if result == "success" and code == "exited" and str(exit_status) == "0" else "failed" if result in {"oom-kill", "exit-code", "timeout", "resources", "protocol", "exec-condition"} else "interrupted"
        fields.update(state=outcome, finishedAt=now(), reason=result or "unit-not-running")
        if code == "exited" and str(exit_status).isdigit():
            fields["exitCode"] = int(exit_status)
    elif state["state"] == "succeeded" and result not in {None, "success"}:
        fields.update(state="failed", reason=result)
    return update(path, **fields)


def cancel(job_id):
    path = job_dir(job_id)
    with locked(path / "status.lock"):
        state = read_json(path / "status.json")
        if state["state"] in TERMINAL:
            print(json.dumps(state, ensure_ascii=False))
            return
        state.update(cancelRequestedAt=now(), updatedAt=now())
        atomic_json(path / "status.json", state)
    result = systemctl("stop", unit(job_id))
    if result.returncode:
        raise RuntimeError("Cancellation requested, but stop is unconfirmed; inspect the same job")
    if read_json(path / "status.json")["state"] not in TERMINAL:
        props = properties(job_id)
        if props.get("ActiveState") in {"inactive", "failed"}:
            finalize(job_id, {"SERVICE_RESULT": props.get("Result"), "EXIT_CODE": "exited" if props.get("ExecMainCode") == "1" else "killed", "EXIT_STATUS": props.get("ExecMainStatus")})
    print(json.dumps(read_json(path / "status.json"), ensure_ascii=False))


def reconcile():
    results = []
    for file in sorted(BASE.glob("*/status.json")):
        state = read_json(file)
        if state["state"] in TERMINAL:
            continue
        if state.get("bootId") != boot_id():
            update(file.parent, state="interrupted", finishedAt=now(), reason="host-reboot")
        else:
            try:
                props = properties(state["id"])
            except RuntimeError:
                results.append({"id": state["id"], "state": "unknown", "reason": "systemd-unavailable"})
                continue
            if props.get("ActiveState") in {"active", "activating", "deactivating", "reloading"}:
                continue
            finalize(state["id"], {"SERVICE_RESULT": props.get("Result"), "EXIT_CODE": "exited" if props.get("ExecMainCode") == "1" else None, "EXIT_STATUS": props.get("ExecMainStatus")})
        results.append(read_json(file))
    print(json.dumps(results, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    submit_parser = commands.add_parser("submit")
    submit_parser.add_argument("--cwd", required=True)
    submit_parser.add_argument("--timeout", type=int, default=3600)
    submit_parser.add_argument("--env-file")
    submit_parser.add_argument("argv", nargs=argparse.REMAINDER)
    for action in ("status", "logs", "cancel", "run", "finalize"):
        command = commands.add_parser(action)
        command.add_argument("id")
        if action == "logs":
            command.add_argument("--lines", type=int, default=100)
            command.add_argument("--bytes", type=int, default=65536)
    commands.add_parser("list")
    commands.add_parser("reconcile")
    args = parser.parse_args()
    if os.geteuid() == 0:
        parser.error("Run imon-job as the ordinary workstation user, never root")
    os.umask(0o077)
    ensure()
    if args.action == "submit":
        submit(args)
    elif args.action == "run":
        return run(args.id)
    elif args.action == "finalize":
        finalize(args.id)
    elif args.action == "cancel":
        cancel(args.id)
    elif args.action == "reconcile":
        reconcile()
    elif args.action == "status":
        print(json.dumps(read_json(job_dir(args.id) / "status.json"), ensure_ascii=False, indent=2))
    elif args.action == "list":
        for path in sorted(BASE.glob("*/status.json"), reverse=True):
            state = read_json(path)
            print(state["id"], state["state"], "exit=" + str(state.get("exitCode")), sep="\t")
    elif args.action == "logs":
        if args.lines < 1 or not 1 <= args.bytes <= 262144:
            raise ValueError("--lines must be positive; --bytes must be between 1 and 262144")
        path = job_dir(args.id) / "output.log"
        if path.exists():
            with path.open("rb") as source:
                source.seek(max(0, path.stat().st_size - args.bytes))
                print("\n".join(source.read(args.bytes).decode("utf-8", errors="replace").splitlines()[-args.lines:]))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, RuntimeError, OSError, subprocess.TimeoutExpired) as error:
        print(f"imon-job: {error}", file=sys.stderr)
        sys.exit(1)
