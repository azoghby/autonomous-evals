// Current immutable release series; UI runner applies its two corrections separately.
import {stageRelease} from '../stage.mjs';
import {fileURLToPath} from 'node:url';
export function stageSeries(){return stageRelease({uiCorrections:false});}
if(process.argv[1]===fileURLToPath(import.meta.url))console.log(JSON.stringify(stageSeries()));
