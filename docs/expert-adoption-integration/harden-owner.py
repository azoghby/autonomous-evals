def harden(source):
 s=source.replace("import { reviewDigest }", "import { inspectDataSafety } from '@ae/core/evals/data/quality';\nimport { redactSecrets } from '@ae/core/agents/redact';\nimport { reviewDigest }")
 s=s.replace('knownSecrets?: readonly string[];', 'knownSecrets?: readonly string[] | (() => readonly string[] | Promise<readonly string[]>);')
 s=s.replace('day_scope:string };', 'day_scope:string; knownSecrets:readonly string[] };')
 s=s.replace('const scope=structuredClone(options.scope), secrets=options.knownSecrets??[];', '''const scope=structuredClone(options.scope);
 async function currentSecrets():Promise<readonly string[]> {
  const value=typeof options.knownSecrets==='function'?await options.knownSecrets():options.knownSecrets??[];
  if(!Array.isArray(value)||value.some(secret=>typeof secret!=='string'||secret.length<4))denied();
  return [...value];
 }
 function safe(value:unknown,secrets:readonly string[]) { if(!inspectDataSafety(value,secrets).safe)denied(); }''')
 s=s.replace('  same(s);\n  const r=', '  same(s);\n  const secrets=await currentSecrets();safe(s,secrets);\n  const r=')
 s=s.replace('AND s.topic=$6 AND s.enabled', "AND j.state NOT IN ('cancelled','failed','delivered','paused_budget','payment_review')\n   AND s.topic=$6 AND s.enabled")
 s=s.replace('if(!r)denied();return r;\n }\n async function operation', 'if(!r)denied();return {...r,knownSecrets:secrets};\n }\n async function operation')
 s=s.replace('await authority(tx,s);return {allowed:true,knownSecrets:secrets};', 'const a=await authority(tx,s);return {allowed:true,knownSecrets:a.knownSecrets};')
 s=s.replace('knownSecrets:secrets};}),', 'knownSecrets:a.knownSecrets};}),')
 s=s.replace('const a=await authority(tx,s),c=await contact(tx,input.contactId),inv=retainedInvitation;', 'const a=await authority(tx,s),c=await contact(tx,input.contactId),inv=retainedInvitation;safe(inv,a.knownSecrets);')
 s=s.replace('  invite:async(s,inv,key)=>{', '  invite:async(s,inv,key)=>{\n   await store.get(s.operationId);')
 s=s.replace('const a=await authority(tx,s),c=await contact(tx,inv.contactId);await operation(tx);', 'const a=await authority(tx,s),c=await contact(tx,inv.contactId);safe(inv,a.knownSecrets);await operation(tx);')
 s=s.replace("   try {const receipt=await", "   try {await sql.transaction(async tx=>{const a=await authority(tx,s);safe(inv,a.knownSecrets);if(redactSecrets(JSON.stringify({subject:claim.subject,text:claim.body}),a.knownSecrets).redactions>0)denied();});const receipt=await")
 s=s.replace("  recoverDelivery:async(s,key)=>sql.transaction(async tx=>", "  recoverDelivery:async(s,key)=>{await store.get(s.operationId);return sql.transaction(async tx=>")
 s=s.replace("deliveryId:r.engagement_id}:null;}),", "deliveryId:r.engagement_id}:null;});},")
 s=s.replace('return options.contributions(s,deliveryId);', 'const values=await options.contributions(s,deliveryId);await sql.transaction(async tx=>{const a=await authority(tx,s);safe(values,a.knownSecrets);});return values;')
 return s
