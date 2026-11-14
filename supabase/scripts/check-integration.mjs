// Read-only frontend/hosting/project consistency check. Does not edit frontend-owned files.
import { readFile,access } from 'node:fs/promises';
import { resolve } from 'node:path';
const root=resolve(import.meta.dirname,'../..');
const read=async path=>JSON.parse(await readFile(resolve(root,path),'utf8'));
const firebase=await read('firebase.json');const project=await read('.firebaserc');
if(project.projects?.default!=='repairpassport-utkrisht')throw new Error('Unexpected Firebase project; inspect existing intended project before deployment');
let pkg;try{pkg=await read('package.json');}catch{throw new Error('Frontend package.json is not committed yet; frontend integration/build is pending');}
const build=pkg.scripts?.build||'';
const expected=build.includes('vite')?'dist':build.includes('react-scripts')?'build':null;
if(!expected)throw new Error('Unknown frontend build output; coordinator must specify it before deployment');
if(firebase.hosting?.public!==expected)throw new Error(`Backend hosting mismatch: frontend builds to ${expected}, firebase.json points to ${firebase.hosting?.public}`);
if(!firebase.hosting.rewrites?.some(r=>r.source==='**'&&r.destination==='/index.html'))throw new Error('Missing SPA fallback');
await access(resolve(root,expected,'index.html'));
console.log(`Integration preflight passed: ${expected}/index.html, SPA fallback, Firebase project ${project.projects.default}`);
