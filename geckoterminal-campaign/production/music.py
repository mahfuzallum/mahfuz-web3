import numpy as np, json, soundfile as sf
from scipy.signal import butter, sosfilt, fftconvolve
SR=48000; tl=json.load(open('timeline.json')); T=tl['total']; N=int(T*SR)
sc={s['id']:s for s in tl['scenes']}
t=np.arange(N)/SR; rng=np.random.default_rng(7)
BPM=100; beat=60/BPM
def lp(x,f,o=2): return sosfilt(butter(o,f,'low',fs=SR,output='sos'),x)
def hp(x,f,o=2): return sosfilt(butter(o,f,'high',fs=SR,output='sos'),x)
def bp(x,lo,hi): return sosfilt(butter(2,[lo,hi],'band',fs=SR,output='sos'),x)
def env_lin(points):  # [(time,val)...]
    ts,vs=zip(*points); return np.interp(t,ts,vs)
def midi(n): return 440*2**((n-69)/12)
# progression (2 bars each): Dm, Bb, F, C  -> root notes and voicings
prog=[[50,53,57,62],[46,50,53,58],[53,57,60,65],[48,52,55,60]]
bass=[38,34,41,36]
chord_len=8*beat
def chord_at(i): return prog[i%4], bass[i%4]
nch=int(np.ceil(T/chord_len))+1
# ---------- PAD ----------
padL=np.zeros(N); padR=np.zeros(N)
for ci in range(nch):
    s0=ci*chord_len; notes,_=chord_at(ci)
    a=int(max(0,(s0-1.2))*SR); b=min(N,int((s0+chord_len+1.2)*SR))
    if a>=N: break
    tt=t[a:b]-s0
    fade=np.clip((tt+1.2)/2.4,0,1)*np.clip((chord_len+1.2-tt)/2.4,0,1)
    fade=np.sin(fade*np.pi/2)**2
    for n in notes+[notes[0]+12]:
        f=midi(n)
        for d,pan in [(-7,0.2),(0,0.5),(6,0.8)]:
            ph=(f*2**(d/1200))*tt+rng.random()
            w=2*(ph%1)-1
            padL[a:b]+=w*fade*(1-pan)*0.05; padR[a:b]+=w*fade*pan*0.05
bright=env_lin([(0,0),(11,0.15),(24,0.35),(60,0.45),(66,0.9),(84,1.0),(90.4,0.6),(T,0.2)])
padL=lp(padL,700)*(1-bright)+lp(padL,2600)*bright; padR=lp(padR,700)*(1-bright)+lp(padR,2600)*bright
padvol=env_lin([(0,0),(3,0.9),(84,1.0),(88,0.7),(90.4,1.2),(T-3,0.8),(T,0)])
padL*=padvol; padR*=padvol
# ---------- BASS (8th pulses) ----------
bassS=np.zeros(N)
eighth=beat/2
for k in range(int(T/eighth)):
    s0=k*eighth
    if s0<sc['platform']['start'] or s0>sc['endcard']['start']-0.2: continue
    _,r=chord_at(int(s0//chord_len)); f=midi(r)
    a=int(s0*SR); b=min(N,a+int(eighth*SR))
    tt=t[a:b]-s0; e=np.exp(-tt*6)*(1-np.exp(-tt*300))*np.clip((eighth-tt)/0.02,0,1)
    bassS[a:b]+=(np.sin(2*np.pi*f*tt)+0.3*np.sin(2*np.pi*2*f*tt))*e
bassS=np.tanh(bassS*1.6)*0.22*env_lin([(0,0),(11.5,0),(14,1),(T,1)])
# ---------- KICK + sidechain ----------
kick=np.zeros(N); side=np.ones(N)
for k in range(int(T/beat)):
    s0=k*beat
    if not (sc['subject']['start']<=s0<sc['cta']['start']+2.5): continue
    a=int(s0*SR); L=int(0.58*SR); b=min(N,a+L); tt=t[a:b]-s0
    fr=45+90*np.exp(-tt*30); ph=2*np.pi*np.cumsum(fr)/SR
    kick[a:b]+=np.sin(ph)*np.exp(-tt*9)*(1-np.exp(-tt*2000))*np.clip((0.58-tt)/0.03,0,1)
    side[a:b]=np.minimum(side[a:b],1-0.55*np.exp(-tt*7)*(1-np.exp(-tt*250)))
kick*=0.42
# ---------- HATS ----------
hat=np.zeros(N); noise=rng.standard_normal(N)
for k in range(int(T/eighth)):
    s0=k*eighth+eighth*0.0
    if k%2==0 or not (sc['turnover']['start']<=s0<sc['cta']['start']+2.5): continue
    a=int(s0*SR); b=min(N,a+int(0.08*SR)); tt=t[a:b]-s0
    hat[a:b]+=noise[a:b]*np.exp(-tt*60)*np.clip(tt/0.002,0,1)
hat=hp(hat,7000)*0.07
# ---------- ARP ----------
arp=np.zeros(N); six=beat/4
pat=[0,1,2,3,2,1,3,2]
for k in range(int(T/six)):
    s0=k*six
    if not (sc['method']['start']<=s0<sc['endcard']['start']): continue
    notes,_=chord_at(int(s0//chord_len)); n=notes[pat[k%8]]+12+(12 if (k//8)%4==3 else 0)
    f=midi(n); a=int(s0*SR); b=min(N,a+int(0.35*SR)); tt=t[a:b]-s0
    arp[a:b]+=(np.sin(2*np.pi*f*tt)+0.25*np.sin(2*np.pi*3*f*tt))*np.exp(-tt*14)*(1-np.exp(-tt*800))*np.clip((0.35-tt)/0.02,0,1)
arp*=0.06*env_lin([(0,0),(24,0),(28,0.7),(66,0.8),(70,1.0),(T,1.0)])
# delay
def delay(x,dt,fb,n=4):
    y=x.copy(); d=int(dt*SR)
    for i in range(1,n+1): y[d*i:]+=x[:-d*i]*fb**i
    return y
arpL=delay(arp,beat*0.75,0.38); arpR=delay(arp,beat*0.5,0.4)
# ---------- FX: whooshes at scene changes, riser, impact ----------
fx=np.zeros(N)
for s in tl['scenes'][1:]:
    c=s['start']; a=int(max(0,c-0.9)*SR); b=min(N,int((c+0.5)*SR)); tt=t[a:b]-(c-0.9)
    e=np.sin(np.clip(tt/1.4,0,1)*np.pi)**2
    fx[a:b]+=bp(noise[a:b],600,5000)*e*0.05
r0=sc['cta']['start']; r1=sc['endcard']['start']
a=int(r0*SR); b=int(r1*SR); tt=(t[a:b]-r0)/(r1-r0)
riser=np.zeros(b-a)
for i,(lo,hi) in enumerate([(300,800),(800,2000),(2000,6000),(4000,12000)]):
    seg=bp(noise[a:b],lo,hi); riser+=seg*np.clip((tt*4-i),0,1)
fx[a:b]+=riser*tt**2*0.09
ai=int(r1*SR); L=int(4*SR); tt=t[ai:ai+L]-r1
fx[ai:ai+L]+=np.sin(2*np.pi*(38+40*np.exp(-tt*8))*tt)*np.exp(-tt*1.4)*0.55
fx[ai:ai+L]+=lp(noise[ai:ai+L],3000)*np.exp(-tt*3)*0.12
# shimmer texture intro
tex=lp(hp(noise,3000),9000)*0.012*(0.5+0.5*np.sin(2*np.pi*0.13*t))*env_lin([(0,0),(2,1),(12,0.6),(T,0.3)])
# ---------- MIX ----------
L=padL*side+bassS*side+kick+hat*0.9+arpL+fx+tex
R=padR*side+bassS*side+kick+hat*1.1+arpR+fx+tex
# reverb
irl=int(3.2*SR); ti=np.arange(irl)/SR
ir1=rng.standard_normal(irl)*np.exp(-ti*2.2); ir2=rng.standard_normal(irl)*np.exp(-ti*2.2)
ir1/=np.sqrt((ir1**2).sum()); ir2/=np.sqrt((ir2**2).sum())
wetsrc_L=padL+arpL+fx*0.5; wetsrc_R=padR+arpR+fx*0.5
L=L+fftconvolve(lp(wetsrc_L,5000),ir1)[:N]*0.35; R=R+fftconvolve(lp(wetsrc_R,5000),ir2)[:N]*0.35
L=hp(L,28); R=hp(R,28)
m=np.stack([L,R],1); m/=np.abs(m).max()/0.89
sf.write('music.wav',m.astype(np.float32),SR); print('music ok',T)
