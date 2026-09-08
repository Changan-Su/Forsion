# 首 token 延迟(TTFT)重建(2026-09-07 调研补查 ①):从本机引擎 SQLite(~/.forsion{,-dev}/tangu/state.db)的 agent_run_events 时间戳重建,1s 分辨率。
# 注意:agentLoop 的 ttftMs/uploadMs/llmMs 真仪器 2026-09-06 才加,旧 run 无该字段才需要本脚本。用法: python3 scripts/research/ttft-reconstruct.py
import sqlite3, json, os, statistics as st
rows=[]
for home in ['.forsion','.forsion-dev']:
    p=os.path.expanduser(f'~/{home}/tangu/state.db')
    if not os.path.exists(p): continue
    c=sqlite3.connect(f'file:{p}?mode=ro',uri=True)
    for run_id, in c.execute("select distinct run_id from agent_run_events where type='usage'"):
        evs=list(c.execute("select seq,type,payload,created_at from agent_run_events where run_id=? order by seq",(run_id,)))
        t0=None; first=None
        for seq,t,pl,ts in evs:
            if t=='status':
                try: d=json.loads(pl or '{}')
                except: d={}
                if set(d.keys())=={'iteration'}:
                    t0=ts; first=None
                elif d.get('phase')=='llm_call' and d.get('stage')=='sending':
                    t0=ts; first=None
            elif t in ('token','reasoning','tool_stream'):
                if t0 and first is None: first=ts
            elif t=='usage':
                try: u=json.loads(pl or '{}')
                except: u={}
                if t0 and first:
                    from datetime import datetime
                    f='%Y-%m-%d %H:%M:%S'
                    try:
                        dt=(datetime.strptime(first,f)-datetime.strptime(t0,f)).total_seconds()
                    except: dt=None
                    if dt is not None and 0<=dt<600:
                        rows.append({'ttft':dt,'prompt':u.get('prompt',0),'cached':u.get('cached',0),'home':home,'ts':t0})
                t0=None; first=None
    c.close()
print('samples',len(rows))
def bucket(r):
    p=r['prompt'] or 1
    return r['cached']/p
hit=[r for r in rows if bucket(r)>=0.5 and r['prompt']>=2000]
miss=[r for r in rows if bucket(r)<0.05 and r['prompt']>=2000]
for name,g in (('cache-hit >=50%',hit),('cache-miss <5%',miss)):
    if not g: print(name,'none'); continue
    t=sorted(x['ttft'] for x in g); pr=[x['prompt'] for x in g]
    print(f"{name}: n={len(g)} median_ttft={st.median(t):.1f}s mean={st.mean(t):.1f}s p90={t[int(len(t)*0.9)-1]:.1f}s median_prompt={st.median(pr):.0f}")
# regression-ish: ttft vs uncached tokens
import math
buckets={}
for r in rows:
    if r['prompt']<1000: continue
    un=r['prompt']-r['cached']
    k = '0-2k' if un<2000 else '2-5k' if un<5000 else '5-10k' if un<10000 else '10-20k' if un<20000 else '>20k'
    buckets.setdefault(k,[]).append(r['ttft'])
print('\nTTFT by UNCACHED prompt tokens:')
for k in ['0-2k','2-5k','5-10k','10-20k','>20k']:
    v=sorted(buckets.get(k,[]))
    if v: print(f"  {k}: n={len(v)} median={st.median(v):.1f}s mean={st.mean(v):.1f}s p90={v[int(len(v)*0.9)-1]:.1f}s")
print('\nTTFT by TOTAL prompt tokens:')
b2={}
for r in rows:
    p=r['prompt']
    if p<1000: continue
    k='1-5k' if p<5000 else '5-10k' if p<10000 else '10-20k' if p<20000 else '20-50k' if p<50000 else '>50k'
    b2.setdefault(k,[]).append(r['ttft'])
for k in ['1-5k','5-10k','10-20k','20-50k','>50k']:
    v=sorted(b2.get(k,[]))
    if v: print(f"  {k}: n={len(v)} median={st.median(v):.1f}s mean={st.mean(v):.1f}s p90={v[int(len(v)*0.9)-1]:.1f}s")
