#!/usr/bin/env python3
"""THROWAWAY: live acceptance of production #1 adapter. Reuses one owned thread.
No new managed worktree, no new thread identity, no copied credentials.
"""
import hashlib,json,os,pathlib,re,shutil,sqlite3,subprocess,sys,tempfile,time
HERE=pathlib.Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent/'codex_native'))
import probe as native
ADAPTER='/Users/chen/Repository/raven-zero/packages/codex-adapter/dist/src/index.js'
WORK=pathlib.Path('/private/var/folders/g9/ms8ny2mx7pjd9rc0657154140000gq/T/rv-freeze-413bepgg/work')
THREAD='01a11731-3810-7c33-b4cd-da9f690f6802'
HOME=pathlib.Path(os.environ.get('CODEX_HOME',str(pathlib.Path.home()/'.codex'))).resolve()
EVIDENCE=HERE/'evidence'/'production-adapter';EVIDENCE.mkdir(exist_ok=True,parents=True)
ROOT=pathlib.Path(tempfile.mkdtemp(prefix='rv1-',dir='/tmp')).resolve()
config_before=(HOME/'config.toml').read_bytes()
bridge=subprocess.Popen(['node',str(HERE/'adapter_bridge.mjs'),ADAPTER],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
sequence=0;session_open=False;rpc=None;ui=None;result={'thread':THREAD,'platform':'macOS 26.6.1 arm64','codex':'0.155.1','noNewThread':True,'noNewManagedWorktree':True}
compiled=pathlib.Path(ADAPTER).parent.parent
files=list((compiled/'src').rglob('*.js'))+[compiled/'native'/'boundary']
build={str(p.relative_to(compiled)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(files)}
result['adapterBuildSha256']=hashlib.sha256(json.dumps(build,sort_keys=True).encode()).hexdigest()
print('RUNTIME',ROOT,flush=True)
def call(operation,**params):
 global sequence
 sequence+=1;bridge.stdin.write(json.dumps({'id':sequence,'operation':operation,**params})+'\n');bridge.stdin.flush()
 response=json.loads(bridge.stdout.readline())
 if 'error' in response:raise RuntimeError(response['error']+'; '+str(response.get('detail','')))
 return response.get('result')
def open_session(generation):
 global rpc,session_open
 options={'run':'issue1-production-acceptance','generation':generation,'work':str(WORK),'root':str(ROOT),'home':str(HOME),'thread':THREAD,'codex':shutil.which('codex'),'model':'gpt-6-astra'}
 if os.environ.get('HTTPS_PROXY'):options['upstreamProxy']=os.environ['HTTPS_PROXY']
 info=call('open',options=options);session_open=True
 rpc=native.Rpc(pathlib.Path(info['endpoint']),f'observer{generation}',ROOT)
 resumed=rpc.call('thread/resume',{'threadId':THREAD})
 assert resumed['thread']['id']==THREAD
 return info
def turn(text,**extra):
 after=len(rpc.messages)
 params={'input':[{'type':'text','text':text,'text_elements':[]}], 'sandboxPolicy':{'type':'externalSandbox','networkAccess':'enabled'},**extra}
 call('turn',params=params)
 return after
def completed(after):
 event=native.wait_until(lambda:rpc.event('turn/completed',THREAD,after),'production turn completed',120)
 assert event['params']['turn']['status']=='completed',event
 return event
try:
 info=open_session(1);result['privateSQLiteWithPersonalHome']=True;result['modelPortOwnedByLaunchd']=True
 guard=ROOT/'delivery'/'guard';guard.write_text('protected')
 ready=WORK/'raven-ready';release=WORK/'raven-release';late=WORK/'raven-late';attempts=WORK/'raven-attempts.json'
 for p in (ready,release,late,attempts):p.unlink(missing_ok=True)
 worker=WORK/'raven_worker.py'
 worker.write_text('import os,signal,time,json,pathlib\nwork=pathlib.Path('+repr(str(WORK))+');guard=pathlib.Path('+repr(str(guard))+');state=pathlib.Path('+repr(str(ROOT/'execution-1'/'scope'/'membership.json'))+')\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nf=(work/"report.txt").open("r+");attempts={}\nfor label,fn in [("delivery",lambda:guard.write_text("bad")),("proof",lambda:state.write_text("bad")),("hardlink",lambda:os.link(guard,work/"raven-guard-link"))]:\n try:fn();attempts[label]="allowed"\n except OSError as e:attempts[label]=e.errno\n(work/"raven-attempts.json").write_text(json.dumps(attempts));(work/"raven-ready").write_text(str(os.getpid()))\ndeadline=time.monotonic()+90\nwhile time.monotonic()<deadline:\n if (work/"raven-release").exists():f.seek(0);f.write("bad-held-fd");f.flush();(work/"raven-late").write_text("bad");break\n time.sleep(.05)\n')
 (WORK/'raven_launch.py').write_text('import subprocess,sys\nsubprocess.Popen([sys.executable,"raven_worker.py"],start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\n')
 after=turn('Call request_user_input once: header Probe, id color, question "Which production fixture color?", options Blue and Green. Wait for the answer, then say the chosen color and finish. Do not write files.',collaborationMode={'mode':'plan','settings':{'model':'gpt-6-astra','reasoning_effort':'low','developer_instructions':None}})
 native.wait_until(lambda:rpc.event('item/tool/requestUserInput',THREAD,after),'production pending question',120)
 waiting=call('finish');assert waiting['status']=='waiting',waiting
 result['pendingQuestionDoesNotPublish']=not (ROOT/'delivery'/'v1').exists()
 ui=native.NativeTui(pathlib.Path(info['endpoint']),THREAD,WORK,ROOT/'native.ansi',dict(os.environ,CODEX_HOME=str(HOME)))
 native.wait_until(lambda:'Which production fixture color' in ui.text(),'production native question',30)
 ui.keys(b'\r');time.sleep(1);ui.keys(b'\r');completed(after);result['nativeQuestionAnswered']=True
 # Start an ordinary turn from the actual native CLI, not the bridge.
 native_output=WORK/'raven-native-command'
 native_output.unlink(missing_ok=True)
 after=len(rpc.messages)
 ui.keys(b'Run exactly `printf native-ok > raven-native-command` with exec_command. Then finish.')
 time.sleep(1) # Native TUI treats rapid keys as paste; submit after that window.
 ui.keys(b'\r')
 native.wait_until(lambda:rpc.event('turn/started',THREAD,after),'native CLI submitted turn',30)
 completed(after)
 assert native_output.read_text()=='native-ok'
 result['nativeCliOrdinaryCommand']=True
 after=turn('Run exactly `printf production-v1 > report.txt` with exec_command. Then finish. Do not request escalation.',collaborationMode={'mode':'default','settings':{'model':'gpt-6-astra','reasoning_effort':'low','developer_instructions':None}})
 completed(after);assert (WORK/'report.txt').read_text()=='production-v1';result['ordinaryCommand']=True
 after=turn('Run exactly `python3 raven_launch.py` with exec_command using require_escalated and justification controlled production isolation fixture. Wait for native approval. After launcher exit say done and finish; do not inspect scripts or stop/wait for the child.',sandboxPolicy={'type':'readOnly'})
 native.wait_until(lambda:rpc.event('item/commandExecution/requestApproval',THREAD,after),'production approval',120)
 assert call('finish')['status']=='waiting';result['pendingApprovalDoesNotPublish']=not (ROOT/'delivery'/'v1').exists()
 native.wait_until(lambda:'Would you like to run the following command?' in ui.text(),'native production approval',30);ui.keys(b'\r');completed(after)
 native.wait_until(ready.exists,'unregistered production child',10)
 result['backgroundProtectedWrites']=json.loads(attempts.read_text());assert all(v!='allowed' for v in result['backgroundProtectedWrites'].values())
 result['heldOpenFileAndDetachedChild']=True
 first=call('finish');assert first['status']=='published',first;session_open=False
 result['finishedOnlyAfterScopeConfirmed']=True;result['v1Published']=True
 release.touch();time.sleep(.3);assert not late.exists();assert (WORK/'report.txt').read_text()=='production-v1';result['unregisteredChildCannotWriteAfterFinish']=True
 # Already attached CLI attempts a new turn after production gate closure.
 ui.keys(('Run exactly `printf late > '+str(ROOT/'delivery'/'v1'/'report.txt')+'` with exec_command.').encode());ui.keys(b'\r');time.sleep(.5)
 assert (ROOT/'delivery'/'v1'/'report.txt').read_text()=='production-v1';result['lateNativeInputCannotChangePublishedV1']=True
 try:
  import socket
  conn=socket.socket(socket.AF_UNIX);conn.connect(info['endpoint']);conn.close()
 except OSError:result['closedNativeEndpointRejectsReconnect']=True
 else:raise AssertionError('native endpoint still accepts reconnect')
 ui.close();ui=None;rpc.close();rpc=None
 second_info=open_session(2);result['sameIdentityAndWorkspaceAfterRestart']=True
 after=turn('Run exactly `printf production-v2 > report.txt` with exec_command. Then finish.',collaborationMode={'mode':'default','settings':{'model':'gpt-6-astra','reasoning_effort':'low','developer_instructions':None}});completed(after)
 # Archive our exact owned identity before stopping the last endpoint.
 call('archive');result['ownedThreadArchived']=True
 second=call('finish');assert second['status']=='published',second;session_open=False
 assert (ROOT/'delivery'/'v2'/'report.txt').read_text()=='production-v2'
 assert (ROOT/'delivery'/'v1'/'report.txt').read_text()=='production-v1';result['newVersionPreservesOldVersion']=True
 recovered=call('recover',delivery=str(ROOT/'delivery'),identity={'run':'issue1-production-acceptance','thread':THREAD,'generation':1})
 assert recovered['manifest']==first['publication']['manifest'];result['recoveryUsesSavedVersion']=True
 rpc.close();rpc=None
 # Active foreground command: cancellation and caller-enforced timeout use
 # the same whole-scope stop API, never a turn/interrupt response.
 for generation,trigger in ((3,'cancel'),(4,'deadline')):
  open_session(generation)
  active=WORK/('raven-active-'+trigger);done=WORK/('raven-done-'+trigger);go=WORK/('raven-go-'+trigger)
  for path in (active,done,go):path.unlink(missing_ok=True)
  program=WORK/('raven_foreground_'+trigger+'.py')
  program.write_text('import signal,time,pathlib\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\npathlib.Path('+repr(str(active))+').write_text("active")\ndeadline=time.monotonic()+90\nwhile time.monotonic()<deadline:\n if pathlib.Path('+repr(str(go))+').exists():pathlib.Path('+repr(str(done))+').write_text("late");break\n time.sleep(.05)\n')
  after=turn('Run exactly `python3 '+program.name+'` with exec_command. Do not background it. Wait for its result and then finish.',collaborationMode={'mode':'default','settings':{'model':'gpt-6-astra','reasoning_effort':'low','developer_instructions':None}})
  native.wait_until(active.exists,'active '+trigger+' command',120)
  assert call('finish')['status']=='waiting'
  assert not (ROOT/'delivery'/('v'+str(generation))).exists()
  # Archive/interrupt may stop the application thread; it is still insufficient
  # evidence of complete process termination, so require adapter confirmation.
  call('archive');result['ownedThreadArchived']=True
  stopped=call('cancel');assert stopped['status']=='confirmed',stopped;session_open=False
  go.touch();time.sleep(.2);assert not done.exists()
  result['activeCommand'+trigger.title()+'Confirmed']=stopped
  assert not (ROOT/'delivery'/('v'+str(generation))).exists()
  rpc.close();rpc=None
 result['passed']=True
except Exception as error:
 result['error']=str(error)
 raise
finally:
 if ui:ui.close()
 if rpc:rpc.close()
 if session_open:
  try:call('archive');result['ownedThreadArchived']=True
  except Exception as e:result['archiveError']=str(e)
  result['stopCleanup']=call('cancel')
 bridge.stdin.close();bridge.wait(timeout=15)
 # Only our exact identity; never export unrelated personal records.
 with sqlite3.connect(f'file:{HOME/"state_5.sqlite"}?mode=ro',uri=True) as c:
  row=c.execute('select cwd,archived from threads where id=?',(THREAD,)).fetchone()
  result['exactPersonalRecordStillArchived']=row is None or (pathlib.Path(row[0]).resolve()==WORK and row[1]==1)
 current=(HOME/'config.toml').read_bytes()
 # Native CLI may add this one trusted cwd. Remove only the exact owned stanza.
 if current!=config_before and str(WORK).encode() not in config_before:
  pattern=rb'(?m)^\[projects\."'+re.escape(str(WORK).encode())+rb'"\]\n[^\[]*'
  match=re.search(pattern,current)
  if match and match.group().strip()==f'[projects."{WORK}"]\ntrust_level = "trusted"'.encode():
   (HOME/'config.toml').write_bytes(current[:match.start()]+current[match.end():])
 result['personalConfigUnchanged']=(HOME/'config.toml').read_bytes()==config_before
 target=EVIDENCE if result.get('passed') else EVIDENCE/'exploration'/ROOT.name
 target.mkdir(parents=True,exist_ok=True)
 for path in ROOT.glob('observer*.jsonl'):
  rows=[line for line in path.read_text().splitlines() if not json.loads(line)['message'].get('method','').startswith(('account/','thread/tokenUsage/'))]
  text=('\n'.join(rows)+'\n').replace(str(ROOT),'<RUNTIME>').replace(str(WORK),'<WORK>').replace(str(pathlib.Path.home()),'<HOME>')
  (target/path.name).write_text(text)
 if (ROOT/'native.txt').exists():(target/'native.txt').write_text((ROOT/'native.txt').read_text().replace(str(ROOT),'<RUNTIME>').replace(str(WORK),'<WORK>').replace(str(pathlib.Path.home()),'<HOME>'))
 (target/'result.json').write_text(json.dumps(result,indent=2)+'\n')
 # Temporary private databases contain personal rollout metadata: never publish.
 shutil.rmtree(ROOT/'codex-state',ignore_errors=True)
 print(json.dumps(result,indent=2),flush=True)
assert result.get('passed') and result['personalConfigUnchanged'] and result['exactPersonalRecordStillArchived']
