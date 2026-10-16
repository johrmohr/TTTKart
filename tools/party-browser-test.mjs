import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import puppeteer from 'puppeteer-core';
import {io} from 'socket.io-client';
const url=process.env.TEST_URL||'http://localhost:3110';
mkdirSync('work',{recursive:true});
const server=process.env.TEST_URL?null:spawn(process.execPath,['server.js'],{env:{...process.env,PORT:'3110',HTTPS_PORT:'3550',NO_OPEN:'1'},stdio:'ignore'});
if(server)for(let i=0;i<100;i++){try{if((await fetch(url+'/api/info')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const b=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist','--autoplay-policy=no-user-gesture-required']});
const pads=[],errors=[];let stream;
try{
 const p=await b.newPage();await p.setViewport({width:1440,height:900});p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await p.goto(url);await p.waitForFunction(()=>window.__game?.state==='title'&&__game.party.links.every(l=>l.room),{timeout:60000});
 const rooms=await p.evaluate(()=>__game.party.links.map(l=>l.room));assert.equal(new Set(rooms).size,4);
 for(let i=0;i<4;i++){
   const socket=io(url);await new Promise(r=>socket.on('connect',r));
   const ack=await socket.emitWithAck('pad:hello',{room:rooms[i],id:`party-test-${i}`});assert.ok(!ack.error,JSON.stringify(ack));
   const pad={socket,s:0,g:0,d:0,i:0,p:0,state:null};socket.on('host:state',s=>pad.state=s);pads.push(pad);
 }
 stream=setInterval(()=>pads.forEach(pad=>pad.socket.connected&&pad.socket.emit('pad:input',{s:pad.s,g:pad.g,d:pad.d,b:0,i:pad.i,p:pad.p,t:Date.now()})),30);
 await p.waitForFunction(()=>__game.party.links.every(l=>l.connected));
 await p.evaluate(()=>__game.party.show('lobby'));await p.screenshot({path:'work/lobby.png'});
 await p.evaluate(()=>__game.party.next());await p.waitForFunction(()=>__game.party.stage==='character');
 for(let step=0;step<4;step++){
   for(let i=0;i<4;i++){
     const index=step===0?i:step===3?1:i%3;
     pads[i].socket.emit('pad:menu',{action:'select',index});await sleep(100);
     pads[i].socket.emit('pad:menu',{action:'go'});await sleep(160);
   }
   console.log('setup',step,await p.evaluate(()=>({stage:__game.party.stage,ready:__game.party.active.map(s=>s.ready),state:__game.state})));
   if(step<3)await p.waitForFunction(stage=>__game.party.stage===stage,{},['body','wheels','map'][step]);
 }
 await p.waitForFunction(()=>__game.state==='race'&&__game.players.length===4);assert.equal(await p.evaluate(()=>__game.track.name),'Sahur Speedway');
 assert.deepEqual(await p.evaluate(()=>__game.players.map(p=>p.kart.character.id)),['sahur','tralalero','patapim','crocodilo']);
 await p.evaluate(()=>__game.skipIntro());await p.waitForFunction(()=>__game.race.state==='racing',{timeout:15000});
 pads[0].g=1;pads[1].s=.35;pads[1].g=1;pads[2].s=-.35;pads[2].g=1;
 await sleep(1300);
 assert.deepEqual(await p.evaluate(()=>__game.players.map(p=>Math.sign(p.kart.input.steer))),[0,1,-1,0]);
 await p.screenshot({path:'work/four-player.png'});
 await p.evaluate(()=>{const k=__game.player;k.item='beer';k.itemCount=1;__game.items.useItem(k);});
 assert.equal(await p.evaluate(()=>__game.players.filter(p=>p.kart.drunkTimer>0).length),3);
 await sleep(400);assert.ok(pads[1].state.race.drunkSeconds>0);
 pads[2].socket.disconnect();await p.waitForFunction(()=>__game.state==='paused');
 pads[2].socket.connect();await new Promise(r=>pads[2].socket.once('connect',r));
 const rejoin=await pads[2].socket.emitWithAck('pad:hello',{room:rooms[2],id:'party-test-2'});assert.ok(rejoin.ok);
 await p.waitForFunction(()=>__game.party.links[2].connected);assert.equal(await p.evaluate(()=>__game.players[2].kart.character.id),'patapim');
 pads[2].socket.emit('pad:menu',{action:'resume'});await p.waitForFunction(()=>__game.state==='race');
 pads[2].socket.disconnect();await p.waitForFunction(()=>__game.state==='paused');
 await p.evaluate(()=>__game.action('quit'));await p.waitForFunction(()=>__game.party.stage==='title');
 // Three players, then two, each through the full lobby and ready sequence.
 for(const n of [3,2]){
   if(n===2)pads[3].socket.disconnect();
   await sleep(200);await p.evaluate(()=>{__game.party.show('lobby');__game.party.next();});
   assert.equal(await p.evaluate(()=>__game.party.active.length),n);
   for(let step=0;step<4;step++)await p.evaluate(()=>{const q=__game.party;for(const s of q.active)q.confirm(s);q.next();});
   await p.waitForFunction(n=>__game.state==='race'&&__game.players.length===n,{},n);
   await p.evaluate(()=>__game.skipIntro());await sleep(500);
   assert.equal(await p.evaluate(()=>document.querySelector('.split-hud').children.length),n===3?4:n);
   await p.screenshot({path:`work/${n}-player.png`});
   await p.evaluate(()=>{__game.action('pause');__game.action('quit');});
 }
 await p.evaluate(()=>__game.party.quick());assert.equal(await p.evaluate(()=>__game.players.length),1);assert.equal(await p.evaluate(()=>__game.player.character.id),'sahur');assert.equal(await p.evaluate(()=>__game.track.name),'Breezy Bay Circuit');
 assert.deepEqual(errors,[]);console.log('PASS: four independent real socket controllers; phone-driven setup; kart/wheels; new map; beer state; disconnect pause; 2/3/4 viewports; return home; Quick Play.');
}finally{clearInterval(stream);pads.forEach(p=>p.socket.disconnect());await b.close();server?.kill();}
