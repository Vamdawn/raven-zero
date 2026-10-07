#!/usr/bin/env python3
"""THROWAWAY: descriptor copy, snapshot-local links, crash checkpoints.
No whole-tree point-in-time or power-loss guarantee. No production implementation.
"""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import signal
import stat
import tempfile

MARKER = '.raven-manifest.json'


def inventory(root):
    result = {}
    for path in sorted(root.rglob('*')):
        relative = path.relative_to(root).as_posix()
        if relative == MARKER: continue
        if path.is_symlink(): result[relative] = {'link': os.readlink(path)}
        elif path.is_dir(): result[relative] = {'directory': True}
        else: result[relative] = {'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'executable': bool(path.stat().st_mode & 0o111)}
    return result


def resolve_link(name, entries):
    pending = list(PurePosixPath(name).parts); stack = []; count = 0
    while pending:
        part = pending.pop(0)
        if part in ('', '.'): continue
        if part == '..':
            if not stack: raise ValueError('link escapes snapshot')
            stack.pop(); continue
        current = '/'.join([*stack, part])
        entry = entries[current]
        if 'link' in entry:
            target = entry['link']; count += 1
            if target.startswith('/') or count > 40: raise ValueError('absolute link or cycle')
            pending = list(PurePosixPath(target).parts) + pending
        else:
            if pending and not entry.get('directory'): raise ValueError('non-directory intermediate')
            stack.append(part)
    return '/'.join(stack)


def publish(source, delivery, generation, checkpoint=lambda phase: None):
    destination = delivery / generation; stage = delivery / (generation+'.partial'); stage.mkdir()
    root_fd = os.open(source, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    links = []
    def walk(fd, output, prefix=''):
        for name in os.listdir(fd):
            if name == '.git': continue
            if not prefix and name == MARKER: raise ValueError('reserved manifest path')
            relative = prefix + name
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISLNK(info.st_mode):
                target = os.readlink(name, dir_fd=fd)
                links.append((relative,target)); continue
            descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
            try:
                actual = os.fstat(descriptor)
                if stat.S_ISDIR(actual.st_mode):
                    (output/name).mkdir(); walk(descriptor,output/name,relative+'/')
                else:
                    if not stat.S_ISREG(actual.st_mode): raise ValueError('unsupported entry')
                    with (output/name).open('xb') as writer:
                        while block := os.read(descriptor,65536): writer.write(block)
                        os.fchmod(writer.fileno(),0o755 if actual.st_mode & 0o111 else 0o644)
                        writer.flush(); os.fsync(writer.fileno())
                    checkpoint('after_file')
            finally: os.close(descriptor)
    try: walk(root_fd,stage)
    finally: os.close(root_fd)
    entries = inventory(stage)
    entries.update({name:{'link':target} for name,target in links})
    for name,_ in links: resolve_link(name,entries)
    for name,target in links: (stage/name).symlink_to(target)
    checkpoint('after_tree')
    with (stage/MARKER).open('x') as writer:
        json.dump({'generation':generation,'entries':inventory(stage)},writer,sort_keys=True)
        writer.flush();os.fsync(writer.fileno())
    checkpoint('after_manifest')
    stage.rename(destination)
    checkpoint('after_rename')
    with (delivery/(generation+'.record.json')).open('x') as writer:
        json.dump({'generation':generation,'published':True},writer)
        writer.flush();os.fsync(writer.fileno())
    checkpoint('after_record')


def recover(delivery,generation):
    destination=delivery/generation
    if not destination.is_dir() or not (destination/MARKER).is_file(): return {'decision':'ignore_partial'}
    marker=json.loads((destination/MARKER).read_text())
    if marker['generation']!=generation or marker['entries']!=inventory(destination): return {'decision':'pending_verification'}
    # Revalidate links before checks/artifact reads; a hash alone is insufficient.
    for name,entry in marker['entries'].items():
        if 'link' in entry: resolve_link(name,marker['entries'])
    return {'decision':'resume_same_version','recordPresent':(delivery/(generation+'.record.json')).exists()}


def run():
    result={'scope':'safe snapshot-local links and process-crash checkpoints; not power loss'}
    with tempfile.TemporaryDirectory(prefix='rv-publish-') as temporary:
        root=Path(temporary).resolve(); source=root/'work';delivery=root/'delivery';source.mkdir();delivery.mkdir()
        (source/'report').write_text('candidate');(source/'nested').mkdir()
        (source/'nested'/'file-link').symlink_to('../report')
        (source/'directory-link').symlink_to('nested',target_is_directory=True)
        (source/'chain').symlink_to('nested/file-link')
        (source/'.git').write_text('gitdir: /external/metadata')
        os.link(source/'report',source/'alias')
        publish(source,delivery,'v1')
        result['internalFileDirectoryAndChainLinksPreserved']=all((delivery/'v1'/name).read_text()=='candidate' for name in ('nested/file-link','directory-link/file-link','chain'))
        result['gitPointerExcluded']=not (delivery/'v1'/'.git').exists()
        result['sourceHardlinkSeparated']=(source/'report').stat().st_ino!=(delivery/'v1'/'report').stat().st_ino
        result['validV1']=recover(delivery,'v1')['decision']=='resume_same_version'
        old=inventory(delivery/'v1')
        (source/'report').write_text('v2')
        result['crashCheckpoints']={}
        for index,phase in enumerate(('after_file','after_tree','after_manifest','after_rename','after_record')):
            generation='crash'+str(index)
            child=os.fork()
            if child==0:
                publish(source,delivery,generation,lambda observed:os.kill(os.getpid(),signal.SIGKILL) if observed==phase else None)
                os._exit(1)
            _,status=os.waitpid(child,0);assert os.WIFSIGNALED(status)
            decision=recover(delivery,generation)
            result['crashCheckpoints'][phase]=decision
            assert decision['decision']==('resume_same_version' if phase in ('after_rename','after_record') else 'ignore_partial')
        result['lostRecordResumesSameCapturedBytes']=(delivery/'crash3'/'report').read_text()=='v2' and not (delivery/'crash3.record.json').exists()
        result['v1PreservedAfterSourceChange']=inventory(delivery/'v1')==old
        for index,target in enumerate(('/external/report','../outside','missing','loop')):
            (source/'bad').symlink_to(target)
            if target=='loop': (source/'loop').symlink_to('bad')
            try: publish(source,delivery,'bad'+str(index))
            except (ValueError,KeyError): pass
            else: raise AssertionError('unsafe link accepted')
            (source/'bad').unlink()
            if target=='loop': (source/'loop').unlink()
        result['absoluteEscapeDanglingAndCycleRejected']=True
        # Lexical normalization would wrongly accept root-alias/../outside.
        (source/'root-alias').symlink_to('.',target_is_directory=True)
        (source/'outside').write_text('internal decoy')
        (source/'tricky').symlink_to('root-alias/../outside')
        try: publish(source,delivery,'tricky')
        except ValueError: result['directoryAliasDotDotEscapeRejected']=True
        else: raise AssertionError('dot-dot escape accepted')
        (delivery/'v1'/'report').write_text('tampered')
        result['tamperedVersionRequiresVerification']=recover(delivery,'v1')['decision']=='pending_verification'
        assert all(result[k] for k in ('internalFileDirectoryAndChainLinksPreserved','gitPointerExcluded','sourceHardlinkSeparated','validV1','lostRecordResumesSameCapturedBytes','v1PreservedAfterSourceChange','absoluteEscapeDanglingAndCycleRejected','directoryAliasDotDotEscapeRejected','tamperedVersionRequiresVerification')),result
    result['passed']=True
    (Path(__file__).parent/'evidence'/'publication.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result,indent=2))


if __name__=='__main__': run()
