/** Registry identities and applied states must not use JSON's last-key-wins ambiguity. */
export function parseUniqueJson(bytes) {
  const text=typeof bytes==='string'?bytes:new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  const parsed=JSON.parse(text); // Validate the complete standard grammar first.
  let offset=0;
  const token=/"(?:\\.|[^"\\])*"|[{}\[\]:,]|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const next=()=>{
    while(offset<text.length && /[\x20\t\r\n]/.test(text[offset]))offset++;
    token.lastIndex=offset;
    const match=token.exec(text);
    if(!match)throw Error('Invalid registry JSON token');
    offset=token.lastIndex;return match[0];
  };
  const walk=(first,depth)=>{
    if(depth>128)throw Error('Registry JSON nesting exceeds supported depth');
    if(first==='['){
      let value=next();if(value===']')return;
      for(;;){walk(value,depth+1);const end=next();if(end===']')return;value=next();}
    }
    if(first==='{'){
      const keys=new Set();let key=next();if(key==='}')return;
      for(;;){
        const decoded=JSON.parse(key);
        if(keys.has(decoded))throw Error('Duplicate JSON object key');
        keys.add(decoded);next();walk(next(),depth+1);
        const end=next();if(end==='}')return;key=next();
      }
    }
  };
  walk(next(),0);
  return parsed;
}
