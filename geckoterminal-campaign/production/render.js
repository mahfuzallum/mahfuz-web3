const { chromium } = require('playwright');const http=require('http'),fs=require('fs'),path=require('path');
const [root,outDir,fps,startF,endF,scale]=[process.argv[2],process.argv[3],+process.argv[4],+process.argv[5],+process.argv[6],process.argv[7]||'2'];
const srv=http.createServer((q,r)=>{const f=path.join(root,decodeURIComponent(q.url.split('?')[0]));fs.readFile(f,(e,d)=>{if(e){r.writeHead(404);r.end();return;}
 const ext=path.extname(f);r.writeHead(200,{'Content-Type':{'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.woff2':'font/woff2'}[ext]||'application/octet-stream'});r.end(d);});}).listen(0,async()=>{
 const port=srv.address().port;const b=await chromium.launch();const p=await b.newPage({viewport:{width:1920,height:1080}});
 p.on('pageerror',e=>console.log('ERR',e.message));
 await p.goto(`http://127.0.0.1:${port}/index.html?s=${scale}`);await p.evaluate(()=>window.ready);
 const t0=Date.now();
 for(let f=startF;f<endF;f++){
   const data=await p.evaluate(t=>{window.renderFrame(t);return document.getElementById('c').toDataURL('image/jpeg',0.94).split(',')[1];},f/fps);
   fs.writeFileSync(`${outDir}/f_${String(f).padStart(5,'0')}.jpg`,Buffer.from(data,'base64'));
 }
 console.log(`frames ${startF}-${endF} done in ${((Date.now()-t0)/1000).toFixed(1)}s`);
 await b.close();srv.close();});
