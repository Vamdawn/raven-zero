#include <spawn.h>
#include <stdint.h>
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
extern char **environ;
int main(int argc,char **argv) {
 if(argc!=2)return 2;
 typedef int (*set_fn)(const posix_spawnattr_t *,uint64_t,int,int);
 set_fn set=(set_fn)dlsym(RTLD_DEFAULT,"posix_spawnattr_setcoalition_np");
 if(!set)return 3;
 posix_spawnattr_t attr;int init=posix_spawnattr_init(&attr);
 int configured=set(&attr,strtoull(argv[1],0,10),0,0);
 pid_t child;char *args[]={"/usr/bin/true",NULL};
 int result=posix_spawn(&child,args[0],NULL,&attr,args,environ);
 if(!result)waitpid(child,NULL,0);
 printf("{\"init\":%d,\"configured\":%d,\"spawnError\":%d}\n",init,configured,result);
 return 0;
}
