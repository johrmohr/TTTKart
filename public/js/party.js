import { CHARACTERS } from './characters.js';
import { ITEM_INFO } from './config.js';

export const BODIES = [
  {id:'standard',name:'Classic',emoji:'🏎️',tagline:'Balanced • your everyday drift machine',mods:{}},
  {id:'speedster',name:'Speedster',emoji:'🏁',tagline:'More speed • less acceleration and handling',mods:{speed:1,accel:-.5,handling:-.5}},
  {id:'buggy',name:'Bubble Buggy',emoji:'🚙',tagline:'Quick launches • slightly lower top speed',mods:{speed:-.5,accel:1,weight:-.5}},
];
export const WHEELS = [
  {id:'standard',name:'Street',emoji:'🛞',tagline:'Balanced grip and pace',mods:{}},
  {id:'roller',name:'Rollers',emoji:'🔵',tagline:'Lighter wheels • better handling, less speed',mods:{handling:1,accel:.5,speed:-.5}},
  {id:'offroad',name:'All-terrain',emoji:'⚙️',tagline:'Grass grip • heavier, slower launches',mods:{weight:.5,accel:-.5}},
];
export const MAPS = [
  {id:'bay',name:'Breezy Bay',emoji:'🌊',tagline:'The original • bridge, lighthouse hairpin & coastal sweep'},
  {id:'sahur',name:'Sahur Speedway',emoji:'🌙',tagline:'A new flowing oval • wide corners, long drifts & boost lanes'},
];
export function equippedCharacter(slot) {
  const base=CHARACTERS[slot.character], body=BODIES[slot.body], wheels=WHEELS[slot.wheels];
  const ratings={...base.ratings};
  for(const part of [body,wheels]) for(const [key,delta] of Object.entries(part.mods)) ratings[key]=Math.max(1,Math.min(5,ratings[key]+delta));
  return {...base, ratings, body:body.id,wheelType:wheels.id};
}
export function viewports(count,w,h) {
  if(count===1)return [{x:0,y:0,w,h}];
  if(count===2)return [{x:0,y:Math.floor(h/2),w,h:h-Math.floor(h/2)},{x:0,y:0,w,h:Math.floor(h/2)}];
  const hw=Math.floor(w/2),hh=Math.floor(h/2);
  return [{x:0,y:hh,w:hw,h:h-hh},{x:hw,y:hh,w:w-hw,h:h-hh},{x:0,y:0,w:hw,h:hh},{x:hw,y:0,w:w-hw,h:hh}];
}
const make=(tag,cls,text,parent)=>{const e=document.createElement(tag);e.className=cls;if(text)e.textContent=text;if(parent)parent.append(e);return e;};
export class Party {
  constructor(links,{launch,sync,preview}) {
    this.links=links;this.launch=launch;this.sync=sync;this.preview=preview;
    this.slots=links.map((link,i)=>({link,index:i,character:i,body:0,wheels:0,ready:false,enabled:false}));
    this.stage='title';this.visible=true;this.map=0;this.active=[];this.thumbnails=new Map();
    this.root=make('section','party',null,document.body);this.root.setAttribute('aria-label','Race setup');
    this.overlay=make('div','split-hud',null,document.body);this.overlay.hidden=true;
    for(const link of links) for(const event of ['join','leave','info','status']) link.on(event,()=>{if(this.visible)this.render();});
    this.render();
  }
  show(stage='title'){this.visible=true;this.stage=stage;this.root.hidden=false;this.overlay.hidden=true;this.render();this.sync();}
  hide(){this.visible=false;this.root.hidden=true;}
  choices(){return this.stage==='character'?CHARACTERS:this.stage==='body'?BODIES:this.stage==='wheels'?WHEELS:MAPS;}
  title(){return ({title:'CHAOS. CORNERED.',lobby:'Bring your crew.',character:'Pick your brainrot.',body:'Build your ride.',wheels:'Find your grip.',map:'Choose your playground.'})[this.stage];}
  selected(s){return this.stage==='map'?this.map:s[this.stage]||0;}
  setChoice(s,index){if(!Number.isInteger(index)||index<0||index>=this.choices().length)return;
    if(this.stage==='map'){if(this.map!==index){this.map=index;for(const p of this.active)p.ready=false;}} else {s[this.stage]=index;s.ready=false;}
    this.preview?.(s.character);this.render();this.sync();}
  confirm(s){if(!this.active.includes(s)||!s.link.connected)return;s.ready=true;this.render();this.sync();}
  next(){
    if(this.stage==='lobby'){
      this.active=this.slots.filter(s=>s.link.connected);
      if(!this.active.length)return;
      for(const s of this.active){s.enabled=true;s.ready=false;}
      this.stage='character';
    } else {
      if(!this.active.length||!this.active.every(s=>s.ready&&s.link.connected))return;
      const stages=['character','body','wheels','map'];const i=stages.indexOf(this.stage);
      if(i===3){this.hide();this.launch(this.active,MAPS[this.map].id);return;}
      this.stage=stages[i+1];for(const s of this.active)s.ready=false;
    }
    this.render();this.sync();
  }
  quick(){const s=this.slots[0];s.character=0;s.body=0;s.wheels=0;this.active=[s];this.map=0;this.hide();this.launch([s],'bay');}
  back(){const stages=['title','lobby','character','body','wheels','map'];this.stage=stages[Math.max(0,stages.indexOf(this.stage)-1)];for(const s of this.slots)s.ready=false;this.render();this.sync();}
  menu(slot,m){if(!this.visible)return false;const s=this.slots[slot];
    if(m.action==='quit'||m.action==='menu'){this.show('title');return true;}
    if(this.stage==='title'){if(m.action==='start'||m.action==='go')this.show('lobby');return true;}
    if(this.stage==='lobby'){if(m.action==='go'||m.action==='start')this.next();return true;}
    if(!this.active.includes(s))return true;
    if(m.action==='select')this.setChoice(s,Number(m.index));
    if(m.action==='go'){this.confirm(s);if(this.active.every(p=>p.ready))this.next();}
    return true;
  }
  phoneState(slot){const s=this.slots[slot];
    if(this.stage==='title'||this.stage==='lobby')return {screen:'title',setupTitle:'Join your player slot, then continue on the display.'};
    if(!this.active.includes(s))return {screen:'loading',setupTitle:'Waiting for the next race'};
    return {screen:'select',characters:this.choices().map(c=>({id:c.id,name:c.name,cssColor:c.cssColor||'#ffd356'})),selected:this.selected(s),setupTitle:`P${slot+1} · ${this.title()}`,setupReady:s.ready};
  }
  render(){if(!this.visible)return;this.root.replaceChildren();
    const top=make('header','party-top',null,this.root);make('b','brand','TTT / KART',top);make('span','eyebrow','PHONE-CONTROLLED MAYHEM · 1–4 PLAYERS',top);
    const main=make('div','party-main',null,this.root);
    make('p','eyebrow',this.stage==='title'?'THE BRAINROT GRAND PRIX':`SETUP / ${this.stage.toUpperCase()}`,main);
    make('h1','',this.title(),main);
    if(this.stage==='title'){
      make('p','party-lead','Tung Tung Tung Sahur leads the grid. Tilt into the turn. Hold the drift. Release the chaos.',main);
      const actions=make('div','party-actions',null,main);
      this.button(actions,'Quick Play ↗',()=>this.quick(),'primary');this.button(actions,'Regular play →',()=>this.show('lobby'));
      make('p','party-note','QUICK PLAY  /  Solo · Tung Tung Tung Sahur · Classic kart · Breezy Bay',main);
      make('p','party-note','REGULAR  /  Connect phones → Character → Kart → Wheels → Map',main);
      const strip=make('div','roster-strip',null,main);
      for(const c of CHARACTERS){const card=make('div','roster-tile',null,strip);const src=this.thumbnails.get(c.id);if(src){const im=make('img','',null,card);im.src=src;im.alt=c.name;}else make('span','roster-emoji',c.emoji,card);make('span','',c.name,card);}
      make('p','party-note','Keyboard: WASD / arrows · Shift drift · Space item · Esc pause. Phone: scan your slot in Regular play.',main);
    }else if(this.stage==='lobby'){
      make('p','party-lead','One phone per slot. Scan a different QR for each player. Everyone stays connected through the race.',main);
      const grid=make('div','lobby-grid',null,main);
      for(const s of this.slots){const card=make('article','lobby-card',null,grid);make('h2','',`PLAYER ${s.index+1}`,card);make('span',s.link.connected?'connected':'waiting',s.link.connected?'● Connected':'○ Waiting for phone',card);
        if(s.link.qrSvg){const qr=make('div','lobby-qr',null,card);qr.innerHTML=s.link.qrSvg;const a=make('a','pad-link',s.link.padUrl,card);a.href=s.link.padUrl;a.target='_blank';a.rel='noopener';}
        else make('p','',s.link.socketConnected?'Creating room…':'Connecting to server…',card);
        make('b','room-code',s.link.room||'…',card);
      }
      make('p','party-note','Use the same Wi-Fi. On the phone, accept the local HTTPS certificate once, then enable motion. Touch steering works too.',main);
      const bar=make('div','party-actions',null,main);this.button(bar,'← Start screen',()=>this.back());const next=this.button(bar,`Continue with ${this.slots.filter(s=>s.link.connected).length} players →`,()=>this.next(),'primary');next.disabled=!this.slots.some(s=>s.link.connected);
    }else{
      make('p','party-lead',this.stage==='map'?'Choose a course together. Every player confirms before the race starts.':'Choose on your phone or below, then confirm each player. Parts change both the model and its handling.',main);
      const panels=make('div','player-panels',null,main);
      for(const s of this.active){const panel=make('article','player-panel',null,panels);make('h2','',`P${s.index+1} / ${CHARACTERS[s.character].name}`,panel);
        if(!s.link.connected)make('p','waiting','Disconnected — reconnect this slot or go back to the lobby.',panel);
        const grid=make('div','choice-grid',null,panel);
        this.choices().forEach((c,i)=>{const b=this.button(grid,'',()=>this.setChoice(s,i),'choice'+(this.selected(s)===i?' selected':''));b.setAttribute('aria-pressed',String(this.selected(s)===i));const src=this.stage==='character'&&this.thumbnails.get(c.id);if(src){const img=make('img','choice-image',null,b);img.src=src;img.alt=c.name;}else make('span','choice-emoji',c.emoji,b);make('strong','',c.name,b);make('small','',c.tagline,b);});
        const b=this.button(panel,s.ready?'Ready ✓':'Confirm choice',()=>this.confirm(s),s.ready?'ready':'primary');b.disabled=!s.link.connected;
      }
      const bar=make('div','party-actions',null,main);this.button(bar,'← Back',()=>this.back());const b=this.button(bar,this.stage==='map'?'Start race →':'Next step →',()=>this.next(),'primary');b.disabled=!this.active.every(s=>s.ready&&s.link.connected);
    }
  }
  button(parent,text,fn,cls=''){const b=make('button',cls,text,parent);b.type='button';b.onclick=fn;return b;}
  updateHUD(players,race,paused){this.overlay.hidden=false;const count=players.length;this.overlay.dataset.count=count;
    if(this.overlay.children.length!== (count===3?4:count)){this.overlay.replaceChildren();for(let i=0;i<(count===3?4:count);i++)make('div','viewport-hud',null,this.overlay);}
    [...this.overlay.children].forEach((e,i)=>{const p=players[i];if(!p){e.textContent='TTT / KART\nTHE NEXT LEGEND COULD BE YOU';e.className='viewport-hud empty-view';return;}
      const k=p.kart;const phase=race?.state==='countdown'?String(Math.ceil(race.countdown)):race?.state==='intro'?'GET READY':paused?'PAUSED':'';
      const item=k.rolling?'🎲':ITEM_INFO[k.item]?.icon||'—';
      const status=k.drunkTimer>0?`🍺 WOBBLY · ${k.drunkTimer.toFixed(1)}s`:k.drift.active?`DRIFT ${['○','🔵','🟠','🟣'][k.drift.tier]}  RELEASE TO BOOST`:k.boostTimer>0?'BOOST!':'';
      if(count===1){e.textContent=k.drunkTimer>0?status:'';return;}
      e.textContent=`P${p.slot.index+1}  ${k.character.name}\n${k.finished?'FINISHED':`#${k.place||'–'}  ·  LAP ${Math.min(k.lap||1,3)}/3  ·  ${Math.round(Math.abs(k.speed)*3.6)} km/h`}   ${item}\n${k.wrongWay?'↩ WRONG WAY':status}\n${phase}`;
    });
  }
}
