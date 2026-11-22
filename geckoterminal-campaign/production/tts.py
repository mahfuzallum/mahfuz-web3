import json,sys,soundfile as sf,numpy as np
from kokoro_onnx import Kokoro
T=sys.argv[1]
k=Kokoro(f'{T}/kokoro-v1.0.onnx',f'{T}/voices-v1.0.bin')
v=0.7*k.get_voice_style('am_michael')+0.3*k.get_voice_style('am_fenrir')
segs=json.load(open('script.json')); out={}
for s in segs:
    a,sr=k.create(s['text'],voice=v,speed=0.97,lang='en-us')
    # trim silence
    idx=np.where(np.abs(a)>0.01)[0]; a=a[max(idx[0]-240,0):idx[-1]+2400]
    sf.write(f"vo/{s['id']}.wav",a,sr); out[s['id']]=len(a)/sr; print(s['id'],round(len(a)/sr,2),sr,flush=True)
json.dump(out,open('vo/durations.json','w'),indent=1); print('total',round(sum(out.values()),1))
