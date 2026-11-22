import json
d=json.load(open('vo/durations.json'))
order=['hook','problem','platform','method','subject','turnover','wallets','safety','watchlist','mobile','cta']
gap={'hook':0.7,'problem':1.1,'platform':0.9,'method':0.9,'subject':1.0,'turnover':0.9,'wallets':0.9,'safety':1.7,'watchlist':1.1,'mobile':1.1,'cta':0.0}
t=1.4; tl=[]
for k in order:
    tl.append({'id':k,'vo':round(t,3),'dur':round(d[k],3),'start':round(t-0.5 if k!='hook' else 0,3)})
    t+=d[k]+gap[k]
end_start=t+0.3; total=end_start+6.0
for i,s in enumerate(tl): s['end']=tl[i+1]['start'] if i+1<len(tl) else round(end_start,3)
tl.append({'id':'endcard','start':round(end_start,3),'end':round(total,3),'vo':None,'dur':0})
json.dump({'total':round(total,3),'scenes':tl},open('timeline.json','w'),indent=1)
for s in tl: print(s)
print('TOTAL',round(total,2))
