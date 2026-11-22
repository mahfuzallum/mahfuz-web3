const { chromium } = require('playwright');const http=require('http'),fs=require('fs'),path=require('path');
const root=process.argv[2], times=process.argv[3].split(',').map(Number), out=process.argv[4];
const srv=http.createServer((q,r)=>{const f=path.join(root,decodeURIComponent(q.url.split('?')[0]));fs.readFile(f,(e,d)=>{if(e){r.writeHead(404);r.end();return;}
 const ext=path.extname(f);r.writeHead(200,{'Content-Type':{'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.woff2':'font/woff2'}[ext]||'application/octet-stream'});r.end(d);});}).listen(0,async()=>{
 const port=srv.address().port;const b=await chromium.launch();const p=await b.newPage({viewport:{width:1920,height:1080}});
 p.on('console',m=>console.log('console:',m.text()));p.on('pageerror',e=>console.log('ERR',e.message));
 await p.goto(`http://127.0.0.1:${port}/index.html?s=1`);await p.evaluate(()=>window.ready);
 for(const t of times){await p.evaluate(t=>window.renderFrame(t),t);await p.screenshot({path:`${out}/p_${String(t).padStart(5,'0')}.png`});}
 await b.close();srv.close();});
