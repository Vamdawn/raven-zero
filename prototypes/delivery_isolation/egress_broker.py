"""THROWAWAY CONNECT-only broker: chatgpt.com:443 via existing local HTTP proxy.
No credentials or HTTP/TLS payloads are logged. Not a production network proxy.
"""
import os
import select
import socket
import socketserver
import threading
from urllib.parse import urlsplit


class Broker:
    def __init__(self):
        upstream = urlsplit(os.environ['HTTPS_PROXY'])
        assert upstream.scheme == 'http' and upstream.hostname in ('127.0.0.1', 'localhost') and not upstream.username
        self.allowed, self.rejected = [], []
        broker = self
        class Handler(socketserver.BaseRequestHandler):
            def handle(self):
                data = b''
                self.request.settimeout(10)
                while b'\r\n\r\n' not in data:
                    block = self.request.recv(4096)
                    if not block: return
                    data += block
                    if len(data)>16384: return
                line = data.split(b'\r\n',1)[0].decode('ascii')
                parts = line.split(' ')
                if len(parts)!=3 or parts[0]!='CONNECT' or parts[1].lower()!='chatgpt.com:443':
                    broker.rejected.append('non-allowlisted request')
                    self.request.sendall(b'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); return
                broker.allowed.append('chatgpt.com:443')
                with socket.create_connection((upstream.hostname,upstream.port),timeout=10) as connection:
                    connection.sendall(b'CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\n\r\n')
                    response=b''
                    while b'\r\n\r\n' not in response:
                        block=connection.recv(4096)
                        if not block: return
                        response+=block
                        if len(response)>16384: return
                    if b' 200 ' not in response.split(b'\r\n',1)[0]: return
                    self.request.sendall(b'HTTP/1.1 200 Connection Established\r\n\r\n')
                    for channel in (self.request,connection): channel.settimeout(10)
                    while not broker.stopped.is_set():
                        readers,_,_=select.select([self.request,connection],[],[],1)
                        for reader in readers:
                            block=reader.recv(65536)
                            if not block:return
                            (connection if reader is self.request else self.request).sendall(block)
        self.stopped=threading.Event()
        self.server=socketserver.ThreadingTCPServer(('127.0.0.1',0),Handler)
        self.server.daemon_threads=True
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.port=self.server.server_address[1]

    def close(self):
        self.stopped.set();self.server.shutdown();self.server.server_close();self.thread.join()
