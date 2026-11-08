"""Pin an executed stage's complete application source plus generated test harness inputs."""
from pathlib import Path
import json,hashlib,sys
stage=Path(sys.argv[1]);output=Path(sys.argv[2]);manifest=stage/'CURRENT-COMPOSITION.json';m=json.loads(manifest.read_text());files={}
for kind in ['preserved','changes','additions']:
 for p,v in m[kind].items():
  b=(stage/p).read_bytes();h=hashlib.sha256(b).hexdigest()
  if h!=v['sha256']:raise ValueError('Source drift: '+p)
  files[p]={'sha256':h,'bytes':len(b),'kind':kind}
extras=['combined-vitest.config.mjs','tsconfig.combined-tests.json','review-vitest.config.mjs','review-acceptance-vitest.config.mjs','tsconfig.review.json','offline.cjs','offline-fonts.cjs','empty-server-only.mjs','packages/core/tsconfig.current-main-production.json']
for p in extras:
 q=stage/p
 if q.exists():
  b=q.read_bytes();files[p]={'sha256':hashlib.sha256(b).hexdigest(),'bytes':len(b),'kind':'generated-harness'}
seven=['tests/track-b/current-autonomy-integration/data-dispatch.test.ts','tests/track-b/current-autonomy-integration/release-capability.test.ts','tests/track-b/current-autonomy-calendar/calendar.test.ts']+['tests/track-b/current-autonomy-payment-startup/'+n+'.test.ts'for n in ['bridge','composition','startup-webhook','startup']]
for p in seven:
 if p not in files:raise ValueError('Missing supplemental: '+p)
obj={'stage':str(stage),'parent':m['parent'],'sourceInventorySha256':hashlib.sha256(manifest.read_bytes()).hexdigest(),'files':files,'sevenPreviouslyUnboundTests':seven,'allDeclaredSourceVerified':True}
output.write_text(json.dumps(obj,indent=2)+'\n')
