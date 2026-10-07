// THROWAWAY SDK activation probe; production code lives in the adapter.
#include <launch.h>
#include <stdio.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>
int main(void){int *fds;size_t count;int error=launch_activate_socket("Model",&fds,&count);if(error){printf("error:%d\n",error);return 1;}struct sockaddr_in addr;socklen_t size=sizeof(addr);getsockname(fds[0],(struct sockaddr*)&addr,&size);printf("port:%u count:%zu\n",ntohs(addr.sin_port),count);fflush(stdout);sleep(1);return 0;}
