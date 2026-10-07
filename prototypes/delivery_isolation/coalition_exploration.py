# THROWAWAY discovery probe, not a production PID supervisor.
# Production acceptance uses generation-safe kernel signals in the adapter.
import ctypes, json, os, pathlib, plistlib, signal, subprocess, sys, tempfile, time, uuid
lib=ctypes.CDLL('/usr/lib/libproc.dylib',use_errno=True)
kernel=ctypes.CDLL('/usr/lib/libSystem.B.dylib',use_errno=True)
def membership(pid):
 data=(ctypes.c_uint64*5)();assert lib.proc_pidinfo(pid,20,0,ctypes.byref(data),ctypes.sizeof(data))==ctypes.sizeof(data)
 return data[0]
def usage(cid):
 ident=ctypes.c_uint64(cid);data=(ctypes.c_uint64*64)();size=ctypes.c_uint64(ctypes.sizeof(data))
 kernel.coalition_info_resource_usage.argtypes=[ctypes.c_uint64,ctypes.c_void_p,ctypes.c_uint64]
 rc=kernel.coalition_info_resource_usage(cid,ctypes.byref(data),ctypes.sizeof(data))
 if rc:raise OSError(ctypes.get_errno(), 'coalition usage')
 return {'started':data[0],'exited':data[1],'returnedSize':size.value}
print('usage readable',usage(membership(os.getpid())),flush=True)
with tempfile.TemporaryDirectory(prefix='rv-coal-') as tmp:
 root=pathlib.Path(tmp);label='dev.raven-zero.probe.'+uuid.uuid4().hex;target=f'gui/{os.getuid()}/{label}'
 script=root/'worker.py'
 script.write_text('import os,signal,time,json,pathlib\np=pathlib.Path('+repr(tmp)+')\np.joinpath("parent").write_text(str(os.getpid()))\nc=os.fork()\nif c: \n while not p.joinpath("exit-parent").exists():time.sleep(.02)\n os._exit(0)\nos.setsid();signal.signal(signal.SIGTERM,signal.SIG_IGN)\np.joinpath("child").write_text(str(os.getpid()))\nwhile True:time.sleep(1)\n')
 config={'Label':label,'ProgramArguments':[sys.executable,str(script)],'RunAtLoad':True,'KeepAlive':False,'AbandonProcessGroup':True,'StandardOutPath':str(root/'out'),'StandardErrorPath':str(root/'err')}
 plist=root/'job.plist';plist.write_bytes(plistlib.dumps(config));child=None
 try:
  subprocess.run(['launchctl','bootstrap',f'gui/{os.getuid()}',str(plist)],check=True,capture_output=True)
  deadline=time.monotonic()+10
  while time.monotonic()<deadline and not (root/'child').exists():time.sleep(.02)
  assert (root/'child').exists(),(root/'err').read_text()
  parent=int((root/'parent').read_text());child=int((root/'child').read_text())
  cid=membership(parent);assert membership(child)==cid and cid!=membership(os.getpid())
  print('unique job coalition',{'parentMatchesChild':True,'differsFromManager':True,'usage':usage(cid)},flush=True)
  (root/'exit-parent').touch();time.sleep(.2)
  print('orphan accounted',usage(cid),flush=True)
  os.kill(child,signal.SIGTERM);time.sleep(.05);print('TERM still active',usage(cid),flush=True)
  os.kill(child,signal.SIGKILL);time.sleep(.2);print('KILL empty',usage(cid),flush=True)
 finally:
  if child:
   try:os.kill(child,signal.SIGKILL)
   except ProcessLookupError:pass
  subprocess.run(['launchctl','bootout',target],capture_output=True)
  assert subprocess.run(['launchctl','print',target],capture_output=True).returncode!=0
  print('owned job removed',flush=True)
