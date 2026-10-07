#!/usr/bin/env python3
"""THROWAWAY macOS probe: races, interrupted publishing, ancestors and IPC."""
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading

from probe import freeze, manifest, profile


def capture(source, destination, hook=lambda: None):
    """Regular-file-only mechanism probe. Internal symlinks are not implemented."""
    stage = destination.with_name(destination.name + '.partial')
    stage.mkdir()
    source_fd = os.open(source, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    hook()

    def walk(directory_fd, output):
        for name in os.listdir(directory_fd):
            descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
            try:
                info = os.fstat(descriptor)
                target = output / name
                if stat.S_ISDIR(info.st_mode):
                    target.mkdir()
                    walk(descriptor, target)
                else:
                    assert stat.S_ISREG(info.st_mode), 'unsupported entry'
                    with target.open('xb') as writer:
                        while block := os.read(descriptor, 65536):
                            writer.write(block)
                        os.fchmod(writer.fileno(), 0o755 if info.st_mode & 0o111 else 0o644)
            finally:
                os.close(descriptor)
    try:
        walk(source_fd, stage)
    finally:
        os.close(source_fd)
    (stage / '.published.json').write_text(json.dumps(manifest(stage), sort_keys=True))
    stage.rename(destination)


def valid(destination):
    marker = destination / '.published.json'
    if not destination.is_dir() or not marker.is_file() or destination.name.endswith('.partial'):
        return False
    current = manifest(destination)
    current.pop('.published.json')
    return current == json.loads(marker.read_text())


def run(evidence):
    result = {'platform': sys.platform, 'scope': 'controlled macOS feasibility; not production publisher'}
    with tempfile.TemporaryDirectory(prefix='rv-edge-') as temporary:
        root = Path(temporary).resolve()
        external = root / 'external'; external.mkdir()
        (external / 'secret-fixture').write_text('external canary')
        source = root / 'source'; source.mkdir()
        (source / 'report').write_text('candidate')
        original_copy = shutil.copytree
        def swap_then_copy(*args, **kwargs):
            (source / 'report').unlink()
            (source / 'report').symlink_to(external / 'secret-fixture')
            return original_copy(*args, **kwargs)
        shutil.copytree = swap_then_copy
        try:
            freeze(source, root / 'unsafe')
        finally:
            shutil.copytree = original_copy
        result['legacyFreezeAllowsLinkSwapEscape'] = (root / 'unsafe' / 'report').read_text() == 'external canary'
        (source / 'report').unlink(); (source / 'report').write_text('candidate')
        def swap_file():
            (source / 'report').unlink(); (source / 'report').symlink_to(external / 'secret-fixture')
        try:
            capture(source, root / 'file-race', swap_file)
        except OSError:
            result['descriptorCaptureRejectsFileSwap'] = not valid(root / 'file-race')
        (source / 'report').unlink(); (source / 'report').write_text('candidate')
        (source / 'nested').mkdir(); (source / 'nested' / 'report').write_text('nested')
        def swap_directory():
            (source / 'nested').rename(source / 'old-nested')
            (source / 'nested').symlink_to(external, target_is_directory=True)
        try:
            capture(source, root / 'directory-race', swap_directory)
        except OSError:
            result['descriptorCaptureRejectsDirectorySwap'] = not valid(root / 'directory-race')
        (source / 'nested').unlink()
        os.link(source / 'report', source / 'alias')
        (source / 'tool').write_text('#!/bin/sh\nexit 0\n'); (source / 'tool').chmod(0o755)
        capture(source, root / 'v1')
        result['publishedVersionVerified'] = valid(root / 'v1')
        result['hardlinkSeparated'] = (source / 'report').stat().st_ino != (root / 'v1' / 'report').stat().st_ino and (root / 'v1' / 'report').stat().st_ino != (root / 'v1' / 'alias').stat().st_ino
        result['executablePreserved'] = os.access(root / 'v1' / 'tool', os.X_OK)
        old_manifest = manifest(root / 'v1')
        (source / 'report').write_text('v2'); capture(source, root / 'v2')
        result['newVersionPreservesOld'] = valid(root / 'v2') and manifest(root / 'v1') == old_manifest
        (root / 'v2' / 'report').write_text('tampered')
        result['tamperDetected'] = not valid(root / 'v2')
        child = os.fork()
        if child == 0:
            capture(source, root / 'interrupted', lambda: os.kill(os.getpid(), signal.SIGKILL))
            os._exit(1)
        _, status = os.waitpid(child, 0)
        result['killedPublicationRejected'] = os.WIFSIGNALED(status) and (root / 'interrupted.partial').is_dir() and not valid(root / 'interrupted') and not valid(root / 'interrupted.partial')
        # A mutable ancestor above the old profile's immediate protected root.
        ancestor = root / 'ancestor'; ancestor.mkdir()
        controlled = ancestor / 'task'; controlled.mkdir()
        delivery = controlled / 'delivery'; delivery.mkdir()
        state = controlled / 'state'; state.mkdir()
        protected = delivery / 'report'; protected.write_text('original')
        policy = root / 'boundary.sb'; policy.write_text(profile(delivery, state))
        moved = root / 'moved'
        code = f'import os; os.rename({str(ancestor)!r}, {str(moved)!r}); open({str(moved / "task/delivery/report")!r}, "w").write("escaped"); os.rename({str(moved)!r}, {str(ancestor)!r})'
        attempt = subprocess.run(['sandbox-exec', '-f', str(policy), sys.executable, '-c', code], capture_output=True)
        if moved.exists(): moved.rename(ancestor)
        result['higherAncestorEscapeAllowed'] = attempt.returncode == 0 and protected.read_text() == 'escaped'
        protected.write_text('original')
        # Protect the fixture's complete mutable ancestor chain, then retry.
        policy.write_text(profile(delivery, state) + f'\n(deny file-write-unlink (literal "{ancestor}"))\n(deny file-write-unlink (literal "{root}"))\n')
        attempt = subprocess.run(['sandbox-exec', '-f', str(policy), sys.executable, '-c', code], capture_output=True)
        if moved.exists(): moved.rename(ancestor)
        result['completeFixtureAncestorChainBlocksRename'] = attempt.returncode != 0 and protected.read_text() == 'original'
        service = socket.socket(socket.AF_UNIX); endpoint = root / 'executor.sock'
        service.bind(str(endpoint)); service.listen(1); service.settimeout(10)
        def external_executor():
            connection, _ = service.accept()
            with connection:
                if connection.recv(64) == b'controlled-write':
                    protected.write_text('outside executor')
        worker = threading.Thread(target=external_executor); worker.start()
        code = f'import socket; s=socket.socket(socket.AF_UNIX); s.connect({str(endpoint)!r}); s.sendall(b"controlled-write"); s.close()'
        attempt = subprocess.run(['sandbox-exec', '-f', str(policy), sys.executable, '-c', code], capture_output=True)
        worker.join(12); service.close()
        result['externalIpcExecutorBypassesFileBoundary'] = attempt.returncode == 0 and protected.read_text() == 'outside executor'
        protected.write_text('original')
        service = socket.socket(socket.AF_UNIX); endpoint.unlink()
        service.bind(str(endpoint)); service.listen(1)
        policy.write_text(policy.read_text() + f'\n(deny network-outbound (remote unix-socket (path-literal "{endpoint}")))\n')
        attempt = subprocess.run(['sandbox-exec', '-f', str(policy), sys.executable, '-c', code], capture_output=True)
        result['explicitIpcDenialBlocksFixture'] = attempt.returncode != 0 and protected.read_text() == 'original'
        service.close()
        assert all(result.get(key) for key in ('legacyFreezeAllowsLinkSwapEscape', 'descriptorCaptureRejectsFileSwap', 'descriptorCaptureRejectsDirectorySwap', 'publishedVersionVerified', 'hardlinkSeparated', 'executablePreserved', 'newVersionPreservesOld', 'tamperDetected', 'killedPublicationRejected', 'completeFixtureAncestorChainBlocksRename', 'externalIpcExecutorBypassesFileBoundary', 'explicitIpcDenialBlocksFixture')), result
    evidence.parent.mkdir(parents=True, exist_ok=True)
    evidence.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    run(Path(__file__).parent / 'evidence' / 'macos-edges.json')
