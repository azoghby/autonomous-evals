import json,os,pathlib,subprocess
validation=pathlib.Path(__file__).resolve().parent
stage=pathlib.Path(json.loads((validation/'assembly.json').read_text())['stage'])
env={**os.environ,'NEXT_FONT_GOOGLE_MOCKED_RESPONSES':str(stage/'font-mock.cjs'),'NEXT_TELEMETRY_DISABLED':'1'}
commands=[('typegen',['node','../../node_modules/next/dist/bin/next','typegen'],stage/'apps/web'),('web-typecheck',['node','node_modules/typescript/bin/tsc','-p','apps/web','--noEmit'],stage),('core-typecheck',['node','node_modules/typescript/bin/tsc','-p','packages/core','--noEmit'],stage),('build',['node','../../node_modules/next/dist/bin/next','build','--webpack'],stage/'apps/web')]
statuses={}
for name,command,cwd in commands:
 with (validation/(name+'.log')).open('w') as log:result=subprocess.run(command,cwd=cwd,env=env,stdout=log,stderr=subprocess.STDOUT)
 statuses[name]={'command':command,'cwd':str(cwd),'exitCode':result.returncode}
 (validation/'build-status.json').write_text(json.dumps(statuses,indent=2)+'\n')
 print(name,result.returncode,flush=True)
 if result.returncode:raise SystemExit(result.returncode)
