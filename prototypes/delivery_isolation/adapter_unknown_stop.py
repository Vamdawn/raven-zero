#!/usr/bin/env python3
"""THROWAWAY negative acceptance. Supply this probe's previously owned RUNTIME."""
import json,os,pathlib,shutil,subprocess,sys
HERE=pathlib.Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent/'codex_native'))
import probe as native
ADAPTER='/Users/chen/Repository/raven-zero/packages/codex-adapter/dist/src/index.js'
WORK=pathlib.Path('/private/var/folders/g9/ms8ny2mx7pjd9rc0657154140000gq/T/rv-freeze-413bepgg/work')
THREAD='01a11731-3810-7c33-b4cd-da9f690f6802'
ROOT=pathlib.Path(sys.argv[1]).resolve();assert ROOT.name.startswith('rv1-')
HOME=pathlib.Path(os.environ.get('CODEX_HOME',str(pathlib.Path.home()/'.codex'))).resolve()
EVIDENCE=HERE/'evidence'/'production-adapter';result={};journal=None;original=None;rpc=None
config=(HOME/'config.toml').read_bytes()
bridge=subprocess.Popen(['node',str(HERE/'adapter_bridge.mjs'),ADAPTER],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
def call(operation,**params):
 bridge.stdin.write(json.dumps({'operation':operation,**params})+'\n');bridge.stdin.flush()
 response=json.loads(bridge.stdout.readline());assert 'error' not in response,response
 return response.get('result')
try:
 options={'run':'issue1-production-acceptance','generation':5,'work':str(WORK),'root':str(ROOT),'home':str(HOME),'thread':THREAD,'codex':shutil.which('codex'),'model':'gpt-6-astra'}
 if os.environ.get('HTTPS_PROXY'):options['upstreamProxy']=os.environ['HTTPS_PROXY']
 info=call('open',options=options)
 rpc=native.Rpc(pathlib.Path(info['endpoint']),'observer5',ROOT)
 rpc.call('thread/resume',{'threadId':THREAD})
 after=len(rpc.messages)
 call('turn',params={'input':[{'type':'text','text':'Run exactly `printf production-v5 > report.txt` with exec_command. Then finish.','text_elements':[]}]})
 event=native.wait_until(lambda:rpc.event('turn/completed',THREAD,after),'negative acceptance turn completed',120)
 assert event['params']['turn']['status']=='completed'
 call('archive')
 journal=pathlib.Path(info['scope']['directory'])/'membership.json';original=journal.read_bytes()
 damaged=json.loads(original);damaged['coalition']='999999999999';journal.write_text(json.dumps(damaged))
 pending=call('finish');assert pending['status']=='pending_verification',pending
 assert not (ROOT/'delivery'/'v5').exists()
 assert subprocess.run(['/bin/launchctl','print',info['modelScope']['target']],capture_output=True).returncode==0
 result.update({'finish':pending,'uncertainScopeDoesNotPublish':True,'modelListenerRetained':True,'workspacePreserved':WORK.exists()})
 journal.write_bytes(original)
 stopped=call('cancel');assert stopped['status']=='confirmed',stopped
 result['repairAndCancelConfirmed']=stopped
 assert not (ROOT/'delivery'/'v5').exists()
 assert (ROOT/'delivery'/'v1'/'report.txt').read_text()=='production-v1'
 assert (ROOT/'delivery'/'v2'/'report.txt').read_text()=='production-v2'
 result['priorVersionsPreserved']=True;result['passed']=True
finally:
 if journal and original:journal.write_bytes(original)
 if rpc:rpc.close()
 bridge.stdin.close();bridge.wait(timeout=15)
 result['personalConfigUnchanged']=(HOME/'config.toml').read_bytes()==config
 if result.get('passed'):shutil.rmtree(ROOT/'codex-state',ignore_errors=True)
 p=ROOT/'observer5.jsonl'
 if p.exists():
  rows=[line for line in p.read_text().splitlines() if not json.loads(line)['message'].get('method','').startswith(('account/','thread/tokenUsage/'))]
  (EVIDENCE/'observer5.jsonl').write_text(('\n'.join(rows)+'\n').replace(str(ROOT),'<RUNTIME>').replace(str(WORK),'<WORK>').replace(str(pathlib.Path.home()),'<HOME>'))
 (EVIDENCE/'unknown-stop.json').write_text(json.dumps(result,indent=2)+'\n')
 print(json.dumps(result,indent=2),flush=True)
assert result.get('passed') and result['personalConfigUnchanged']
