#!/usr/bin/env python3
"""PROTOTYPE: real filesystem boundaries; no production adapter or security claim."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time


def wait_for(path, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if path.exists():
            return
        time.sleep(0.1)
    raise TimeoutError(str(path))


def manifest(root):
    result = {}
    for path in sorted(root.rglob('*')):
        relative = str(path.relative_to(root))
        if '.git' in path.relative_to(root).parts:
            continue
        if path.is_symlink():
            result[relative] = {'link': os.readlink(path)}
        elif path.is_file():
            result[relative] = {'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                                'executable': bool(path.stat().st_mode & 0o111)}
    return result


def freeze(source, destination):
    # Only these fixture outputs are candidates. Never copy a live .git pointer.
    for path in source.rglob('*'):
        if path.is_symlink() and not path.resolve().is_relative_to(source.resolve()):
            raise ValueError('output symlink escapes task workspace')
    shutil.copytree(source, destination, symlinks=True)
    return manifest(destination)


def profile(delivery, state):
    return '(version 1)\n(allow default)\n' + f'(deny file-write-unlink (literal {json.dumps(str(delivery.parent.resolve()))}))\n' + ''.join(
        f'(deny file-write* (subpath {json.dumps(str(p.resolve()))}))\n'
        for p in (delivery, state))


WORKER = r'''
import errno, json, os, sys, time
from pathlib import Path
work, delivery, state = map(Path, sys.argv[1:4])
held = (work / 'report.txt').open('r+')
(work / 'ready').write_text(str(os.getpid()))
deadline = time.monotonic() + 90
while not (work / 'release').exists():
    if time.monotonic() > deadline:
        sys.exit(2)
    time.sleep(0.1)
held.seek(0); held.write('late-held-fd'); held.truncate(); held.flush()
attempts = {}
def ancestor_rename():
    root = work.parent
    moved = root.with_name(root.name + '-moved')
    os.rename(root, moved)
    try:
        (moved / 'delivery' / 'v1' / 'report.txt').write_text('ancestor late')
    finally:
        os.rename(moved, root)
def hardlink_alias():
    alias = work / 'protected-alias'
    os.link(delivery / 'v1' / 'report.txt', alias)
    alias.write_text('hardlink late')
operations = {
    'ancestorRename': ancestor_rename,
    'hardlinkAlias': hardlink_alias,
    'absolute': lambda: (delivery / 'v1' / 'report.txt').write_text('absolute late'),
    'relative': lambda: Path('../delivery/v1/report.txt').write_text('relative late'),
    'symlink': lambda: (work / 'delivery-link').write_text('symlink late'),
    'rename': lambda: os.replace(work / 'replacement', delivery / 'v1' / 'report.txt'),
    'chmod': lambda: os.chmod(delivery / 'v1' / 'report.txt', 0o777),
    'unlink': lambda: (delivery / 'v1' / 'report.txt').unlink(),
    'metadata': lambda: (state / 'run.json').write_text('corrupt'),
}
for name, operation in operations.items():
    try:
        operation(); attempts[name] = 'allowed'
    except OSError as error:
        attempts[name] = errno.errorcode.get(error.errno, str(error.errno))
(work / 'attempts.json').write_text(json.dumps(attempts))
held.close()
'''

LINUX_WORKER = r'''
const fs = require('fs');
const fd = fs.openSync('/work/report.txt', 'r+');
fs.writeFileSync('/work/ready', String(process.pid));
const deadline = Date.now() + 90000;
const timer = setInterval(() => {
  if (Date.now() > deadline) process.exit(2);
  if (!fs.existsSync('/work/release')) return;
  clearInterval(timer);
  fs.writeSync(fd, 'late-held-fd', 0, 'utf8'); fs.ftruncateSync(fd, 12); fs.closeSync(fd);
  const attempts = {};
  const actions = {
    ancestorRename: () => fs.renameSync('/delivery', '/renamed-delivery'),
    hardlinkAlias: () => { fs.linkSync('/delivery/v1/report.txt', '/work/protected-alias'); fs.writeFileSync('/work/protected-alias', 'hardlink late'); },
    absolute: () => fs.writeFileSync('/delivery/v1/report.txt', 'absolute late'),
    relative: () => fs.writeFileSync('../delivery/v1/report.txt', 'relative late'),
    symlink: () => fs.writeFileSync('/work/delivery-link', 'symlink late'),
    rename: () => fs.renameSync('/work/replacement', '/delivery/v1/report.txt'),
    chmod: () => fs.chmodSync('/delivery/v1/report.txt', 0o777),
    unlink: () => fs.unlinkSync('/delivery/v1/report.txt'),
    metadata: () => fs.writeFileSync('/state/run.json', 'corrupt'),
  };
  for (const [name, action] of Object.entries(actions)) {
    try { action(); attempts[name] = 'allowed'; }
    catch (error) { attempts[name] = error.code; }
  }
  fs.writeFileSync('/work/attempts.json', JSON.stringify(attempts));
}, 100);
'''


def prepare(root):
    work, delivery, state = (root / name for name in ('work', 'delivery', 'state'))
    for path in (work, delivery, state):
        path.mkdir()
    (work / 'report.txt').write_text('candidate-v1')
    os.link(work / 'report.txt', work / 'report-alias.txt')
    (work / 'report-link.txt').symlink_to('report.txt')
    (work / 'tool.sh').write_text('#!/bin/sh\nprintf checked\n')
    (work / 'tool.sh').chmod(0o755)
    (state / 'run.json').write_text('{"phase":"working"}')
    return work, delivery, state


def filesystem(case, evidence):
    root = Path(tempfile.mkdtemp(prefix='raven-FS-PROTOTYPE-')).resolve()
    work, delivery, state = prepare(root)
    target = delivery / 'v1'
    command = None
    container = None
    result = {'case': case, 'platform': sys.platform}
    if case == 'linux':
        result['executionPlatform'] = 'Linux container; controller on macOS'
    try:
        if case == 'linux':
            (work / 'delivery-link').symlink_to('/delivery/v1/report.txt')
            (root / 'worker.cjs').write_text(LINUX_WORKER)
            container = 'raven-prototype-' + root.name.rsplit('-', 1)[-1]
            subprocess.run(['docker', 'run', '-d', '--name', container, '--network', 'none',
                '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                '--pids-limit', '64', '--workdir', '/work',
                '--mount', f'type=bind,source={work},target=/work',
                '--mount', f'type=bind,source={delivery},target=/delivery,readonly',
                '--mount', f'type=bind,source={state},target=/state,readonly',
                '--mount', f'type=bind,source={root / "worker.cjs"},target=/fixture.cjs,readonly',
                'node:24.15.0-bookworm-slim', 'node', '/fixture.cjs'], check=True,
                stdout=subprocess.DEVNULL)
        else:
            (work / 'delivery-link').symlink_to(target / 'report.txt')
            (root / 'worker.py').write_text(WORKER)
            # Launcher exits; the new process group is outside the launcher's group.
            launcher = 'import subprocess,sys; subprocess.Popen(sys.argv[1:], start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)'
            command = [sys.executable, '-c', launcher, sys.executable, str(root / 'worker.py'),
                       str(work), str(delivery), str(state)]
            if case == 'macos':
                (root / 'boundary.sb').write_text(profile(delivery, state))
                command = ['sandbox-exec', '-f', str(root / 'boundary.sb'), *command]
            subprocess.run(command, cwd=work, check=True)
        wait_for(work / 'ready')
        result['writerReadyBeforeFreeze'] = True
        result['launcherExitedBeforeFreeze'] = case != 'linux'
        # Attack link is deliberately outside the output selection.
        (work / 'delivery-link').unlink()
        result['v1Manifest'] = freeze(work, target)
        (work / 'delivery-link').symlink_to('/delivery/v1/report.txt' if case == 'linux' else target / 'report.txt')
        (work / 'replacement').write_text('rename late')
        result['hardlinkBroken'] = (work / 'report.txt').stat().st_ino != (target / 'report.txt').stat().st_ino
        (work / 'release').touch()
        wait_for(work / 'attempts.json')
        result['attempts'] = json.loads((work / 'attempts.json').read_text())
        result['heldSourceFdChangedSource'] = (work / 'report.txt').read_text() == 'late-held-fd'
        result['v1Unchanged'] = manifest(target) == result['v1Manifest']
        result['metadataUnchanged'] = (state / 'run.json').read_text() == '{"phase":"working"}'
        if case == 'control':
            result['expectedCounterexample'] = not result['v1Unchanged'] and not result['metadataUnchanged']
            assert result['expectedCounterexample']
        else:
            assert result['v1Unchanged'] and result['metadataUnchanged']
            assert result['heldSourceFdChangedSource'] and result['hardlinkBroken']
            assert all(value != 'allowed' for value in result['attempts'].values())
            result['checkOutput'] = subprocess.check_output([str(target / 'tool.sh')], text=True)
            git_env = dict(os.environ, GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_NOSYSTEM='1')
            git = ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Raven Prototype', '-c', 'user.email=prototype@example.invalid']
            remote = delivery / 'remote.git'
            for args, cwd in [(['init', '--bare', str(remote)], root),
                              (['init', '--initial-branch=codex/prototype-v1', '--template='], target),
                              (['add', '.'], target), (['commit', '-m', 'Frozen prototype v1'], target),
                              (['push', str(remote), 'HEAD:refs/heads/codex/prototype-v1'], target)]:
                subprocess.run([*git, *args], cwd=cwd, env=git_env, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            result['deliveredCommit'] = subprocess.check_output([*git, 'rev-parse', 'HEAD'], cwd=target, env=git_env, text=True).strip()
            result['remoteContainsFrozenReport'] = subprocess.check_output([*git, '--git-dir', str(remote), 'show', 'refs/heads/codex/prototype-v1:report.txt'], env=git_env, text=True) == 'candidate-v1'
            (work / 'delivery-link').unlink()
            # Explicit recovery changes the original workspace and publishes a new version.
            (work / 'report.txt').write_text('explicit-resume-v2')
            freeze(work, delivery / 'v2')
            result['recoveryPreservesV1'] = manifest(target) == result['v1Manifest']
            result['recoveryPublishesV2'] = (delivery / 'v2' / 'report.txt').read_text() == 'explicit-resume-v2'
            result['recoveryPreservesDeliveredCommit'] = subprocess.check_output([*git, '--git-dir', str(remote), 'rev-parse', 'refs/heads/codex/prototype-v1'], env=git_env, text=True).strip() == result['deliveredCommit']
            (work / 'escape-link').symlink_to(state / 'run.json')
            try:
                freeze(work, delivery / 'bad')
                raise AssertionError('escaping symlink accepted')
            except ValueError:
                result['escapingOutputLinkRejected'] = True
            assert result['recoveryPreservesV1'] and result['recoveryPublishesV2'] and result['remoteContainsFrozenReport'] and result['recoveryPreservesDeliveredCommit']
        result['passed'] = True
    finally:
        if container:
            subprocess.run(['docker', 'rm', '-f', container], stdout=subprocess.DEVNULL, check=True)
        elif (work / 'ready').exists():
            pid = int((work / 'ready').read_text())
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                result['writerExited'] = True
            else:
                os.kill(pid, 15)
                result['writerStoppedInCleanup'] = True
        evidence.mkdir(parents=True, exist_ok=True)
        (evidence / f'{case}.json').write_text(json.dumps(result, indent=2) + '\n')
        shutil.rmtree(root)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('case', choices=['control', 'macos', 'linux'])
    parser.add_argument('--evidence', type=Path, default=Path(__file__).parent / 'evidence')
    args = parser.parse_args()
    filesystem(args.case, args.evidence)
