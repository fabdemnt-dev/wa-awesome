import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OWNER_JOURNAL_DIRECTORY, OWNER_JOURNAL_FILES } from '../../scripts/floating-garden-owner-readonly-policy.mjs';
const ROOT=fileURLToPath(new URL('../../',import.meta.url));
export async function createSyntheticOwnerJournal(home) {
  const parent=join(home,'.garden-trust-renewal-9223b52d'); await mkdir(parent,{mode:0o700});
  execFileSync('python3',['-I','-c',`import importlib.util,pathlib,sys
sys.dont_write_bytecode=True
p=pathlib.Path(sys.argv[1]);spec=importlib.util.spec_from_file_location('fixture',p/'tests/floating-garden-ci-trust-renewal.test.py');f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)
f.NEW_SHA='9223b52de65a3a393e5aec197ea7190b69c35c83'
s=f.m.State(pathlib.Path(sys.argv[2]));fake=f.Fake()
assert f.m.execute(fake,s,f.NEW_SHA,confirm=lambda prompt:'RENEW '+f.m.digest(f.m.make_plan(f.m.collect(fake,f.NEW_SHA),f.NEW_SHA)),emit=lambda x:None,now=lambda:f.b.EXPIRY-86400000)==0
`,ROOT,join(home,OWNER_JOURNAL_DIRECTORY)],{encoding:'utf8'});
  const pins={}; for(const name of OWNER_JOURNAL_FILES)pins[name]=createHash('sha256').update(await readFile(join(home,OWNER_JOURNAL_DIRECTORY,name))).digest('hex'); return pins;
}
