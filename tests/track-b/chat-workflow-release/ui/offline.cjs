// Inherited by Next's child Node processes. No outbound sockets during verification.
const net=require('node:net');const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
 const a=args[0];const options=Array.isArray(a)?a[0]:a;
 const host=typeof options==='object'?options.host:typeof args[1]==='string'?args[1]:undefined;
 if(host&&!['localhost','127.0.0.1','::1'].includes(host))throw Error('Offline verification blocked socket to '+host);
 return connect.apply(this,args);
};
