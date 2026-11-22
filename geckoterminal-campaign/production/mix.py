import numpy as np, json, soundfile as sf
from scipy.signal import resample_poly, butter, sosfilt
SR=48000; tl=json.load(open('timeline.json')); N=int(tl['total']*SR)
mus,_=sf.read('music.wav'); vo=np.zeros(N); act=np.zeros(N)
for s in tl['scenes']:
    if s['vo'] is None: continue
    a,sr=sf.read(f"vo/{s['id']}.wav"); a=resample_poly(a,2,1)  # 24k->48k
    # gentle presence EQ + compression-ish
    a=a+0.25*sosfilt(butter(2,[2500,6000],'band',fs=SR,output='sos'),a)
    a=np.tanh(a*1.8)/np.tanh(1.8)
    i=int(s['vo']*SR); vo[i:i+len(a)]+=a[:N-i]; act[i:i+len(a)]=1
# smooth ducking envelope
k=int(0.25*SR); w=np.hanning(2*k); w/=w.sum()
env=np.convolve(act,w,'same'); duck=1-0.62*np.clip(env,0,1)
vo/=np.abs(vo).max(); 
out=np.stack([mus[:,0]*duck*0.55+vo*0.9, mus[:,1]*duck*0.55+vo*0.9],1)
out/=np.abs(out).max()/0.95
sf.write('mix_raw.wav',out.astype(np.float32),SR); print('ok')
