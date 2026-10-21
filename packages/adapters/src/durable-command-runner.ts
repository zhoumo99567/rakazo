/** Runs inside a POSIX computer, independent of the worker and supervisor connection. */
export const DURABLE_COMMAND_RUNNER = String.raw`
import os, sys, json, time, hashlib, fcntl, subprocess, signal, selectors, codecs
from pathlib import Path
from datetime import datetime, timezone

def stamp():
    return datetime.now(timezone.utc).isoformat()

def identity(pid):
    try:
        stat = Path('/proc/%s/stat' % pid).read_text().rsplit(')', 1)[1].split()
        if stat[0] == 'Z': return None
        return Path('/proc/sys/kernel/random/boot_id').read_text().strip() + ':' + stat[19]
    except (OSError, IndexError):
        return None

def atomic(folder, data):
    temp = folder / ('state.%s.tmp' % os.getpid())
    with open(temp, 'w') as out:
        json.dump(data, out)
        out.flush()
        os.fsync(out.fileno())
    os.replace(temp, folder / 'state.json')

def snapshot(folder):
    try:
        value = json.loads((folder / 'state.json').read_text())
    except FileNotFoundError:
        return dict(state='not_found', stdout='', stderr='', code=None, observedAt=stamp())
    if value['state'] == 'running' and (not value.get('runnerIdentity') or identity(value.get('runnerPid', 0)) != value.get('runnerIdentity')):
        value['state'] = 'unknown'
        value['code'] = None
    value['observedAt'] = stamp()
    return value

req = json.loads(sys.argv[1])
root = Path.home() / '.local' / 'state' / 'rakazo-command-operations'
root.mkdir(parents=True, exist_ok=True, mode=0o700)
# Only hashes enter paths; status reads use the same run/bot/space namespace as starts.
folder = root / hashlib.sha256(req['scope'].encode()).hexdigest() / hashlib.sha256(req['operationId'].encode()).hexdigest()
folder.parent.mkdir(exist_ok=True, mode=0o700)
folder.mkdir(exist_ok=True, mode=0o700)
if folder.is_symlink() or folder.parent.is_symlink() or root.is_symlink():
    raise RuntimeError('Unsafe operation directory')
lockfd = os.open(folder / 'lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
fcntl.flock(lockfd, fcntl.LOCK_EX)
value = snapshot(folder)
if req['action'] == 'cancel':
    if value['state'] == 'running':
        (folder / 'cancel').touch(mode=0o600)
    print(json.dumps(value)); sys.exit(0)
if req['action'] == 'status' or value['state'] != 'not_found':
    if req['action'] == 'start' and value.get('fingerprint') != req.get('fingerprint'):
        raise RuntimeError('Operation request differs from its original command')
    print(json.dumps(value)); sys.exit(0)
# Publish the runner's identity before allowing a second request to inspect or launch.
r, w = os.pipe()
pid = os.fork()
if pid:
    os.close(w)
    os.read(r, 1)
    os.close(r)
    os.close(lockfd)
    print(json.dumps(snapshot(folder))); sys.exit(0)
os.close(r)
os.setsid()
null = os.open(os.devnull, os.O_RDWR)
for fd in (0, 1, 2): os.dup2(null, fd)
os.close(null)
command = req['command']
started = time.time()
monotonic_start = time.monotonic()
timeout = command['timeoutMs'] / 1000.0
value = dict(state='running', stdout='', stderr='', code=None, startedAt=stamp(),
    deadlineAt=datetime.fromtimestamp(started + timeout, timezone.utc).isoformat(),
    observedAt=stamp(), runnerPid=os.getpid(), runnerIdentity=identity(os.getpid()), fingerprint=req['fingerprint'])
atomic(folder, value)
os.write(w, b'1'); os.close(w)
fcntl.flock(lockfd, fcntl.LOCK_UN); os.close(lockfd)
child = None
try:
    child = subprocess.Popen(command['argv'], cwd=command.get('cwd') or None, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    streams = selectors.DefaultSelector()
    for name, stream in [('stdout', child.stdout), ('stderr', child.stderr)]:
        os.set_blocking(stream.fileno(), False)
        streams.register(stream, selectors.EVENT_READ, name)
    decoders = {name: codecs.getincrementaldecoder('utf-8')(errors='replace') for name in ('stdout', 'stderr')}
    last_write = 0
    terminal = None
    while True:
        if terminal is None and (folder / 'cancel').exists():
            terminal = 'cancelled'
        if terminal is None and time.monotonic() >= monotonic_start + timeout:
            terminal = 'timed_out'
        if terminal is not None and child.poll() is None:
            try: os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError: pass
        for key, mask in streams.select(0.1):
            data = os.read(key.fileobj.fileno(), 16384)
            if data:
                value[key.data] = (value[key.data] + decoders[key.data].decode(data))[-65536:]
            else:
                value[key.data] = (value[key.data] + decoders[key.data].decode(b'', final=True))[-65536:]
                streams.unregister(key.fileobj)
                key.fileobj.close()
        code = child.poll()
        if code is not None:
            value['state'] = terminal or 'completed'
            value['code'] = 124 if terminal == 'timed_out' else 130 if terminal == 'cancelled' else code
            # Descendants holding pipes do not prevent recording the shell's actual exit.
            if not streams.get_map() or terminal: break
            if time.monotonic() - monotonic_start > timeout: break
        if time.time() - last_write >= 1:
            value['observedAt'] = stamp(); atomic(folder, value); last_write = time.time()
    value['observedAt'] = stamp(); atomic(folder, value)
except BaseException as error:
    if child and child.poll() is None:
        try: os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError: pass
    value.update(state='unknown', code=None, stderr=(value['stderr'] + '\nOperation runner failed; verify the destination before retrying.')[-65536:], observedAt=stamp())
    atomic(folder, value)
os._exit(0)
`;
