from __future__ import annotations
import base64, io, re, threading, unicodedata, wave
from pathlib import Path
from typing import Any
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from piper import PiperVoice
from piper.config import SynthesisConfig
ROOT=Path(__file__).resolve().parents[1]; MODEL=ROOT/'models'/'ar_JO-kareem-medium.onnx'
app=FastAPI(title='Arabic Word Reader TTS',version='0.2.0')
app.add_middleware(CORSMiddleware,allow_origins=['https://localhost:3000','http://localhost:3000'],allow_methods=['*'],allow_headers=['*'])
_voice=None; _lock=threading.Lock()
def voice():
 global _voice
 if _voice is None:
  with _lock:
   if _voice is None:
    if not MODEL.exists(): raise RuntimeError(f'Model not found: {MODEL}')
    _voice=PiperVoice.load(MODEL,include_alignments=True)
 return _voice
class Req(BaseModel):
 text:str=Field(min_length=1,max_length=12000); speed:float=Field(default=1,ge=.5,le=2)
def cp(v:str)->str:
 v=unicodedata.normalize('NFD',v)
 return '' if v.isspace() or unicodedata.category(v).startswith('P') else v
def cw(v:str)->str:
 return ''.join(c for c in unicodedata.normalize('NFD',unicodedata.normalize('NFC',v)) if not unicodedata.category(c).startswith('M') and (c.isalnum() or '\u0600'<=c<='\u06ff')).casefold()
def words(text:str):
 out=[]
 for m in re.finditer(r'\S+',text,re.UNICODE):
  w=m.group(0).strip('،؛؟.,;:!?()[]{}"\'«»“”‘’')
  if w: out.append(w)
 return out
def fallback(ws,total,sr):
 if not ws or total<=0:return []
 weights=[max(1,len(cw(w))) for w in ws]; tw=sum(weights); cur=0; out=[]
 for i,(w,wt) in enumerate(zip(ws,weights)):
  end=total if i==len(ws)-1 else cur+round(total*wt/tw)
  out.append({'index':i,'text':w,'start_ms':round(cur*1000/sr),'end_ms':round(end*1000/sr),'alignment':'fallback'}); cur=end
 return out
def timings(v,text,ws,chunks):
 sr=v.config.sample_rate; aligned=[]; base=0
 for ch in chunks:
  if ch.phoneme_alignments:
   cur=0
   for a in ch.phoneme_alignments:
    aligned.append((a.phoneme,base+cur,base+cur+a.num_samples)); cur+=a.num_samples
  base+=len(ch.audio_float_array)
 if not aligned:return fallback(ws,base,sr)
 out=[]; cursor=0
 for i,w in enumerate(ws):
  exp=[]
  for s in v.phonemize(w): exp.extend(s)
  exp=[cp(x) for x in exp if cp(x)]
  found=None
  for c in range(cursor,min(len(aligned),cursor+300)):
   if cp(aligned[c][0])!=exp[0]: continue
   p=c;j=0
   while p<len(aligned) and j<len(exp):
    z=cp(aligned[p][0])
    if not z:p+=1;continue
    if z!=exp[j]:break
    j+=1;p+=1
   if j==len(exp): found=(c,p-1); break
  if found:
   a,b=found; out.append({'index':i,'text':w,'start_ms':round(aligned[a][1]*1000/sr),'end_ms':round(aligned[b][2]*1000/sr),'alignment':'phoneme'}); cursor=b+1
  else:
   start=aligned[cursor][1] if cursor<len(aligned) else base; remain=max(1,base-start)//max(1,len(ws)-i); end=min(base,start+remain); out.append({'index':i,'text':w,'start_ms':round(start*1000/sr),'end_ms':round(end*1000/sr),'alignment':'fallback'}); cursor=min(len(aligned),cursor+1)
 return out if len(out)==len(ws) else fallback(ws,base,sr)
def synth(text,speed):
 v=voice(); chunks=list(v.synthesize(text,SynthesisConfig(length_scale=1/speed),include_alignments=True))
 if not chunks:raise RuntimeError('Piper returned no audio')
 b=io.BytesIO()
 with wave.open(b,'wb') as w:
  w.setnchannels(chunks[0].sample_channels);w.setsampwidth(chunks[0].sample_width);w.setframerate(chunks[0].sample_rate)
  for ch in chunks:w.writeframes(ch.audio_int16_bytes)
 audio=b.getvalue(); dur=round(len(audio)/(chunks[0].sample_width*chunks[0].sample_channels*chunks[0].sample_rate)*1000)
 return audio,dur,timings(v,text,words(text),chunks)
@app.get('/health')
def health():return {'ok':MODEL.exists(),'voice_loaded':_voice is not None,'model':MODEL.name}
@app.post('/tts')
def tts(r:Req):
 text=unicodedata.normalize('NFC',r.text).replace('\u00a0',' ').strip()
 if not text:raise HTTPException(400,'النص فارغ')
 try:a,d,w=synth(text,r.speed)
 except Exception as e:raise HTTPException(500,f'TTS failed: {e}') from e
 return {'audio_base64':base64.b64encode(a).decode(),'mime_type':'audio/wav','duration_ms':d,'words':w}
