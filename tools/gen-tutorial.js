'use strict';
// Builds tools/tutorial-build.html: embeds the real app screenshots (from --shoot) and
// a scene timeline that renders a 1920x1080 guided walkthrough (Ken Burns zoom, highlight
// boxes, captions, title chips). Rendered frame-by-frame by main.js --maketut.
const fs = require('fs');
const path = require('path');

const shotsDir = process.argv[2] || '/tmp/tut-shots';
const out = path.join(__dirname, 'tutorial-build.html');

const imgs = {
  E: 'editor-input.png',
  ES: 'editor-slice.png',
  EO: 'editor-output.png',
  X: 'export-input.png',
  XC: 'export-codec.png',
  XO: 'export-output.png',
};
const embedded = {};
for (const [k, f] of Object.entries(imgs)) {
  embedded[k] = 'data:image/png;base64,' + fs.readFileSync(path.join(shotsDir, f)).toString('base64');
}

// focus: [centerX, centerY, width] in image pixels (3200x1944). height derived 16:9.
// hl: [x,y,w,h] highlight box in image pixels. title / caption strings.
const F_FULL = [1600, 972, 3200];
const SCENES = [
  { dur: 6.5, card: 'intro' },
  { dur: 8.5, img: 'E', focus: F_FULL, title: '1 · THE MAPPING PAGE',
    caption: 'Build your input-to-output mapping — the same slice principle as Resolume Advanced Output.' },
  { dur: 9, img: 'E', focus: [2820, 440, 1550], hl: [2530, 150, 660, 560], title: 'INPUT & OUTPUT SIZE',
    caption: 'Set your stageview canvas resolution, and add one or more output screens.' },
  { dur: 9, img: 'E', focus: [950, 640, 2100], hl: [8, 150, 452, 360], title: 'SLICES',
    caption: 'Each slice samples a region of the input and places it on the output screen.' },
  { dur: 9.5, img: 'ES', focus: [2820, 900, 1450], hl: [2530, 560, 660, 900], title: 'ROTATION · FLIP · MASKS',
    caption: 'Per slice: input & output rectangles, 90° rotation, flip, and key-point input masks.' },
  { dur: 9, img: 'E', focus: [1850, 300, 1900], hl: [1628, 22, 474, 78], title: 'RESOLUME XML',
    caption: 'Import a Resolume Advanced Output XML directly — or export your mapping back to XML.' },
  { dur: 9, img: 'EO', focus: F_FULL, title: 'OUTPUT MAP',
    caption: 'Switch to Output Map to preview exactly how your content lands on each screen.' },

  { dur: 3.5, card: 'part2' },
  { dur: 9, img: 'X', focus: [1000, 640, 2100], hl: [8, 108, 452, 210], title: '2 · ADD FOOTAGE',
    caption: 'On the Export page, add your stageview footage — images or video.' },
  { dur: 9, img: 'X', focus: [1350, 1010, 2300], hl: [440, 900, 1660, 320], title: 'LIVE PREVIEW',
    caption: 'See it live on the input map, with slice outlines and masks drawn on top.' },
  { dur: 10, img: 'X', focus: [2820, 560, 1520], hl: [2530, 150, 660, 820], title: 'PER-CLIP ADJUST',
    caption: 'Fit, position, linked or per-axis scale, rotation and full colour control — all live.' },
  { dur: 9.5, img: 'X', focus: [1250, 1780, 2500], hl: [430, 1760, 1420, 96], title: 'TRIM',
    caption: 'Trim with draggable in / out points and an audio waveform — or type exact times.' },
  { dur: 10, img: 'XC', focus: [2820, 1330, 1520], hl: [2530, 1180, 660, 300], title: 'CODECS',
    caption: 'Export to DXV3, HAP, ProRes, ProRes 4444, HEVC, H.264, PNG or WAV.' },
  { dur: 9.5, img: 'XC', focus: [2820, 1480, 1520], hl: [2530, 1330, 660, 380], title: 'ALPHA · DEPTH · GPU',
    caption: 'Set alpha, bit depth and GPU acceleration — or match the source in one click.' },
  { dur: 9, img: 'XO', focus: F_FULL, title: 'OUTPUT CHECK',
    caption: 'Check the Output view, choose a destination folder, and hit Start export.' },

  { dur: 11, card: 'outro' },
];

// precompute same-as-prev/next by "img or card id"
function gid(s) { return s.card ? 'card:' + s.card : 'img:' + s.img; }
SCENES.forEach((s, i) => {
  s.samePrev = i > 0 && gid(SCENES[i - 1]) === gid(s);
  s.sameNext = i < SCENES.length - 1 && gid(SCENES[i + 1]) === gid(s);
  s.prevFocus = i > 0 ? SCENES[i - 1].focus : null;
});

const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:1920px;height:1080px;background:#0b0e10;overflow:hidden}
  canvas{display:block}
</style></head><body>
<canvas id="c" width="1920" height="1080"></canvas>
<script>
const IMGDATA = ${JSON.stringify(embedded)};
const SCENES = ${JSON.stringify(SCENES)};
const W=1920,H=1080;
const g=document.getElementById('c').getContext('2d');
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const lerp=(a,b,t)=>a+(b-a)*t;
const smooth=(t)=>{t=clamp(t,0,1);return t*t*(3-2*t);};

const images={}; let loaded=0; const keys=Object.keys(IMGDATA);
window.__ready=false;
keys.forEach(k=>{const im=new Image();im.onload=im.onerror=()=>{loaded++;if(loaded===keys.length)window.__ready=true;};im.src=IMGDATA[k];images[k]=im;});

let TOTAL=0; SCENES.forEach(s=>TOTAL+=s.dur); window.__DUR=TOTAL+0.1;

function roundRect(x,y,w,h,r){g.beginPath();g.moveTo(x+r,y);g.arcTo(x+w,y,x+w,y+h,r);g.arcTo(x+w,y+h,x,y+h,r);g.arcTo(x,y+h,x,y,r);g.arcTo(x,y,x+w,y,r);g.closePath();}

function drawLogo(cx,cy,scale,alpha){
  g.save();g.globalAlpha=alpha;g.translate(cx,cy);g.scale(scale,scale);g.textAlign='left';g.textBaseline='alphabetic';
  const fx=110,ft=84;g.font='900 '+fx+'px -apple-system,sans-serif';const wX=g.measureText('X').width;
  g.font='800 '+ft+'px -apple-system,sans-serif';const wT=g.measureText('TREME').width,wL=g.measureText('L').width,wD=g.measureText('D').width;
  const gap=28,barW=52,total=wX+wT+gap+wL+8+barW+8+wD;let x=-total/2;const base=ft*0.34;
  g.font='900 '+fx+'px -apple-system,sans-serif';g.fillStyle='#f7941e';g.fillText('X',x,base);x+=wX-2;
  g.font='800 '+ft+'px -apple-system,sans-serif';g.fillStyle='#c9cdd0';g.fillText('TREME',x,base);x+=wT+gap;
  g.fillText('L',x,base);x+=wL+8;
  const barsH=ft*0.70,bTop=base-barsH,cols=['#e8492e','#4caf50','#2196f3'],barGap=8,bh=(barsH-2*barGap)/3;
  for(let i=0;i<3;i++){g.fillStyle=cols[i];g.fillRect(x,bTop+i*(bh+barGap),barW,bh);}x+=barW+8;
  g.fillStyle='#c9cdd0';g.fillText('D',x,base);g.restore();
}

function wrap(text,maxW,font){g.font=font;const words=text.split(' ');const lines=[];let ln='';
  for(const w of words){const t=ln?ln+' '+w:w;if(g.measureText(t).width>maxW&&ln){lines.push(ln);ln=w;}else ln=t;}
  if(ln)lines.push(ln);return lines;}

function drawCaption(title,caption,alpha){
  if(alpha<=0)return;
  g.save();g.globalAlpha=alpha;
  // bottom gradient
  const grd=g.createLinearGradient(0,H-320,0,H);grd.addColorStop(0,'rgba(6,8,10,0)');grd.addColorStop(0.5,'rgba(6,8,10,0.82)');grd.addColorStop(1,'rgba(6,8,10,0.95)');
  g.fillStyle=grd;g.fillRect(0,H-320,W,320);
  // title chip
  if(title){g.font='800 30px -apple-system,sans-serif';const tw=g.measureText(title).width;
    roundRect(90,H-232,tw+52,58,29);g.fillStyle='#f7941e';g.fill();
    g.fillStyle='#241503';g.textAlign='left';g.textBaseline='middle';g.fillText(title,90+26,H-232+30);}
  // caption text
  const lines=wrap(caption,W-260,'500 40px -apple-system,sans-serif');
  g.fillStyle='#eef1f3';g.textAlign='left';g.textBaseline='alphabetic';
  lines.forEach((l,i)=>g.fillText(l,92,H-108+i*50));
  g.restore();
}

function drawCard(kind,lt,dur){
  const grd=g.createRadialGradient(W/2,360,120,W/2,540,1300);grd.addColorStop(0,'#1b2126');grd.addColorStop(1,'#0a0d0f');
  g.fillStyle=grd;g.fillRect(0,0,W,H);
  const a=smooth(clamp(lt/0.6,0,1))*(1-smooth(clamp((lt-(dur-0.6))/0.6,0,1)));
  if(kind==='intro'){
    drawLogo(W/2,430,1.15,a*smooth(clamp(lt/0.7,0,1)));
    g.globalAlpha=a*smooth(clamp((lt-0.5)/0.6,0,1));
    g.fillStyle='#f7941e';g.font='800 40px -apple-system,sans-serif';g.textAlign='center';g.textBaseline='middle';
    g.fillText('REMAP EXPORT',W/2,516);
    g.fillStyle='#ffffff';g.font='700 54px -apple-system,sans-serif';
    g.globalAlpha=a*smooth(clamp((lt-1.1)/0.6,0,1));g.fillText('Full walkthrough',W/2,640);
    g.fillStyle='#8b9195';g.font='500 32px -apple-system,sans-serif';
    g.fillText('Stageview content  →  output-mapped LED content',W/2,706);
    g.globalAlpha=1;
  }else if(kind==='part2'){
    g.globalAlpha=a;g.fillStyle='#ffffff';g.font='800 66px -apple-system,sans-serif';g.textAlign='center';g.textBaseline='middle';
    g.fillText('2 · Exporting your content',W/2,H/2);g.globalAlpha=1;
  }else if(kind==='outro'){
    drawLogo(W/2,360,0.9,a);
    g.globalAlpha=a*smooth(clamp((lt-0.4)/0.6,0,1));
    g.fillStyle='#ffffff';g.font='800 58px -apple-system,sans-serif';g.textAlign='center';g.textBaseline='middle';
    g.fillText('Play it on any device.',W/2,520);
    g.fillStyle='#35e0b2';g.font='800 40px -apple-system,sans-serif';
    g.globalAlpha=a*smooth(clamp((lt-0.9)/0.6,0,1));
    g.fillText('100% free & open source · macOS & Windows',W/2,600);
    // link pill
    g.font='bold 34px -apple-system,sans-serif';const link='github.com/MikeXtremeLED/xtremeled-remap-export';
    const lw=g.measureText(link).width+64;
    g.globalAlpha=a*smooth(clamp((lt-1.4)/0.6,0,1));
    roundRect(W/2-lw/2,668,lw,72,16);g.fillStyle='#f7941e';g.fill();
    g.fillStyle='#241503';g.fillText(link,W/2,706);
    g.globalAlpha=1;
  }
}

// cover-fit an image so region [cx,cy,w] maps to the frame
function drawImgFocus(img,cx,cy,w,alpha){
  const s=W/w; const iw=img.naturalWidth||3200, ih=img.naturalHeight||1944;
  g.save();g.globalAlpha=alpha;
  g.fillStyle='#0b0e10';g.fillRect(0,0,W,H);
  g.drawImage(img,0,0,iw,ih, W/2-cx*s, H/2-cy*s, iw*s, ih*s);
  g.restore();
  return s;
}

function drawScene(sc,lt){
  const dur=sc.dur;
  if(sc.card){drawCard(sc.card,lt,dur);return;}
  const img=images[sc.img];
  // camera focus: glide from prev focus if same image, plus slow ken-burns zoom
  let f=sc.focus.slice();
  if(sc.samePrev&&sc.prevFocus){const gp=smooth(clamp(lt/0.8,0,1));
    f=[lerp(sc.prevFocus[0],sc.focus[0],gp),lerp(sc.prevFocus[1],sc.focus[1],gp),lerp(sc.prevFocus[2],sc.focus[2],gp)];}
  const kb=lerp(1.0,0.94,clamp(lt/dur,0,1)); // subtle zoom-in
  const cw=f[2]*kb;
  // base alpha: fade through black only when image changes
  let a=1;
  if(!sc.samePrev)a*=smooth(clamp(lt/0.5,0,1));
  if(!sc.sameNext)a*=1-smooth(clamp((lt-(dur-0.5))/0.5,0,1));
  const s=drawImgFocus(img,f[0],f[1],cw,a);
  // highlight box
  if(sc.hl){
    const ha=smooth(clamp((lt-0.5)/0.5,0,1))*(sc.sameNext?1:(1-smooth(clamp((lt-(dur-0.5))/0.5,0,1))));
    const [hx,hy,hw,hh]=sc.hl;
    const fx=W/2+(hx-f[0])*s, fy=H/2+(hy-f[1])*s, fw=hw*s, fh=hh*s;
    g.save();g.globalAlpha=ha*a;
    // dim outside
    g.fillStyle='rgba(6,8,10,0.45)';
    g.beginPath();g.rect(0,0,W,H);roundRect(fx,fy,fw,fh,14);g.fill('evenodd');
    // glow border
    g.shadowColor='rgba(247,148,30,0.9)';g.shadowBlur=24;
    roundRect(fx,fy,fw,fh,14);g.lineWidth=5;g.strokeStyle='#f7941e';g.stroke();
    g.restore();
  }
  // caption
  let ca=1;
  if(!sc.samePrev)ca*=smooth(clamp((lt-0.35)/0.4,0,1)); else ca*=smooth(clamp(lt/0.4,0,1));
  if(!sc.sameNext)ca*=1-smooth(clamp((lt-(dur-0.4))/0.4,0,1)); else ca*=1-smooth(clamp((lt-(dur-0.3))/0.3,0,1));
  drawCaption(sc.title,sc.caption,ca*a);
}

function draw(t){
  let acc=0,idx=0,lt=0;
  for(let i=0;i<SCENES.length;i++){if(t<acc+SCENES[i].dur||i===SCENES.length-1){idx=i;lt=t-acc;break;}acc+=SCENES[i].dur;}
  g.clearRect(0,0,W,H);g.fillStyle='#0b0e10';g.fillRect(0,0,W,H);
  drawScene(SCENES[idx],clamp(lt,0,SCENES[idx].dur));
}

window.__seek=function(t){return new Promise(res=>{draw(t);requestAnimationFrame(()=>requestAnimationFrame(res));});};
if(!location.search.includes('capture')){let st=null;function loop(ts){if(st===null)st=ts;let t=((ts-st)/1000)%window.__DUR;draw(t);requestAnimationFrame(loop);}requestAnimationFrame(loop);}
</script></body></html>`;

fs.writeFileSync(out, html);
console.log('tutorial-build.html written,', SCENES.length, 'scenes,', Math.round(SCENES.reduce((a, s) => a + s.dur, 0)), 's');
