// Pass secrets through an owner-readable temporary file, never argv or logs.
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
assert.equal(process.env.SUPABASE_PROJECT_REF,'xhkjqtknjwxzbabnirsy');
const values={ALLOWED_ORIGINS:'https://repairpassport-utkrisht.web.app,https://repairpassport-utkrisht.firebaseapp.com,http://localhost:5173'};
for(const name of ['TINYFISH_API_KEY','OPENAI_API_KEY','OPENAI_MODEL']){
 const value=process.env[name];
 if(value){if(/[\r\n\0]/.test(value))throw new Error(`Invalid single-line value for ${name}`);values[name]=value;}
}
const dir=await mkdtemp(join(tmpdir(),'rp-deploy-'));
try{
 const file=join(dir,'secrets.env');
 await writeFile(file,Object.entries(values).map(([k,v])=>`${k}=${JSON.stringify(v)}`).join('\n')+'\n',{mode:0o600});
 const run=spawnSync('supabase',['secrets','set','--env-file',file,'--project-ref',process.env.SUPABASE_PROJECT_REF],{stdio:'pipe',encoding:'utf8',timeout:60000});
 // Suppress CLI output in this step so even unexpected vendor diagnostics cannot print secret values.
 if(run.error||run.status!==0)throw new Error('Function secret deployment failed; verify Supabase token permissions. Secret values were not printed.');
 console.log('Function origin settings and any supplied optional provider credentials applied. Missing optional values leave remote settings unchanged.');
}finally{await rm(dir,{recursive:true,force:true});}
