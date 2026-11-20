from pathlib import Path
import json,hashlib,sys
p=Path(sys.argv[1])
files=[f'{i:02d}-turn.json' for i in range(1,6)]+['check.json','check-v2.json']
turns=[json.loads((p/f).read_text()) for f in files[:5]]
checks=[json.loads((p/f).read_text()) for f in files[5:]]
sid=turns[0]['run']['session_id'];last=turns[-1]['dialogue']
sources=last['analysis']['behavior']['sources'];entries=[]
for n,t in enumerate(turns):
 text=t['request']['text'];source=next((s for s in sources if s['text']==text),None)
 # The receipt preserves run identity and order, but no message timestamps/ids.
 entries.append({'id':f"recorded:{t['run']['run_id']}:user",'sequence':2*n,'created_at':'','kind':'user','text':text,'source_id':source['id'] if source else None,'question_id':t['request'].get('question_id'),'status':'processed'})
 entries.append({'id':f"recorded:{t['run']['run_id']}:assistant",'sequence':2*n+1,'created_at':'','kind':'assistant','text':t['dialogue']['reply'],'questions':[q for q in t['dialogue']['questions'] if q['status']=='open']})
v1=checks[0]['version'];m2=turns[-1]['dialogue']['model'];v2={'id':m2['version_id'],'model_id':m2['model_id'],'session_id':sid,'number':m2['number'],'parent_id':v1['id'],'spec':last['analysis']['behavior'],'spec_hash':m2['spec_hash'],'approved':False}
for c,after in zip(checks,[entries[5]['id'],entries[9]['id']]):c['check']['events']=c['check_events'];c['check']['after_entry_id']=after
result={'_meta':{'label':'Запись GPT subscription + TLC · 31.10.2026; без новых вызовов','source':'backend-acceptance/receipt.md','source_sha256':{f:hashlib.sha256((p/f).read_bytes()).hexdigest() for f in files},'entry_identity':'Recorded run_id + role are local transport IDs; original message IDs/timestamps were not captured. sequence follows recorded turns. All text, questions, specs, report IDs and hashes are original.'},'session':{'id':sid,'title':'Живой диалог: запись прогона','mode':'analyzer','created_at':'','recording_label':'Запись GPT subscription + TLC · 31.10.2026','messages':[],'sources':sources,'requirements':[],'documents':[]},'dialogue':{**last,'entries':entries},'models':[{'id':v1['model_id'],'session_id':sid,'name':v1['spec']['name']}],'versions':[v1,v2],'checks':[c['check'] for c in checks]}
(Path(__file__).resolve().parents[1]/'src/fixtures/recorded-dialogue.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print('entries',len(entries),'versions',[v['id'] for v in result['versions']],'bytes',len(json.dumps(result)))
