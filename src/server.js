import http from "node:http";
import * as store from "./store.js";
import { run, loadConfig } from "./pipeline.js";
import { buildKit, renderKit, writeKit } from "./apply.js";
import { createProvider } from "./providers/index.js";

/** Local dashboard. No framework, no build step, no dependency — one file. */

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch { resolve({}); } });
  });

let running = false;
let lastRun = null;

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");

    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(PAGE);
    }

    if (url.pathname === "/api/jobs") {
      const db = await store.load();
      const { rules } = await loadConfig();
      const jobs = Object.values(db.jobs)
        .filter((j) => typeof j.score === "number")
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      const counts = jobs.reduce((a, j) => ((a[j.status] = (a[j.status] || 0) + 1), a), {});
      return json(res, 200, {
        jobs: jobs.slice(0, 400),
        counts,
        total: jobs.length,
        running,
        lastRun,
        digests: Object.keys(db.digests).length,
        threshold: rules.digest.scoreThreshold,
        funnel: store.responseFunnel(db),
      });
    }

    if (url.pathname === "/api/status" && req.method === "POST") {
      const { id, status, note } = await readBody(req);
      // Reject an unknown status rather than writing it — a typo here would create a
      // phantom bucket that every count and filter silently ignores.
      if (!store.STATUSES.includes(status)) return json(res, 400, { error: "unknown status" });
      const db = await store.load();
      const row = store.setStatus(db, id, status, note);
      if (!row) return json(res, 404, { error: "no such job" });
      await store.save(db);
      return json(res, 200, { ok: true, id: row.id, status: row.status });
    }

    if (url.pathname === "/api/apply" && req.method === "POST") {
      const { id } = await readBody(req);
      const db = await store.load();
      const job = db.jobs[id];
      if (!job) return json(res, 404, { error: "no such job" });
      const provider = createProvider(process.env);
      if (!provider) return json(res, 400, { error: "no provider key set" });
      try {
        const { profile } = await loadConfig();
        const { kit } = await buildKit(job, { profile, provider });
        const file = writeKit(job, renderKit(job, kit, {
          model: `${provider.name}/${provider.model}`,
          date: new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }),
        }));
        return json(res, 200, { file, cover: kit.cover_letter });
      } catch (err) {
        return json(res, 500, { error: err.message });
      }
    }

    if (url.pathname === "/api/run" && req.method === "POST") {
      if (running) return json(res, 409, { error: "a run is already in progress" });
      running = true;
      // Fire and forget — the page polls /api/jobs for completion.
      run({ log: () => {}, llmBudget: Number(process.env.SHORTLIST_LLM_BUDGET || 150) })
        .then((r) => { lastRun = { at: new Date().toISOString(), ...r.meta, shortlisted: r.shortlist.length }; })
        .catch((e) => { lastRun = { at: new Date().toISOString(), error: e.message }; })
        .finally(() => { running = false; });
      return json(res, 202, { started: true });
    }

    res.writeHead(404).end("not found");
  });
}

const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Shortlist</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@100..125,400..800&family=DM+Mono:wght@400;500&family=Source+Serif+4:opsz,wght@8..60,400..600&display=swap" rel="stylesheet">
<style>
/* Ledger palette, inherited from the portfolio. Light is the source of truth;
   dark redefines the same tokens so nothing downstream needs a second rule. */
:root{
  --paper:#EEEDE3;--deep:#E5E4D8;--bar:rgba(217,227,209,.45);
  --ink:#191B18;--soft:#5B6058;--faint:#8A8F84;--rule:#C6C6B8;
  --credit:#2E6B4C;--debit:#8E3B2C;--warn:#8A6A1F;
  --wide:'Archivo',system-ui,sans-serif;--serif:'Source Serif 4',Georgia,serif;--mono:'DM Mono',ui-monospace,monospace;
}
@media (prefers-color-scheme:dark){
  :root{
    --paper:#14160F;--deep:#1B1E17;--bar:rgba(46,107,76,.10);
    --ink:#E7E6DB;--soft:#A8AC9F;--faint:#7C8175;--rule:#2E3228;
    --credit:#7FBF9B;--debit:#D98A76;--warn:#D9B45E;
  }
}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--serif);font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
.shell{max-width:1080px;margin:0 auto;padding:0 clamp(1rem,4vw,2.5rem)}
:focus-visible{outline:2px solid var(--credit);outline-offset:2px}

header{border-top:5px solid var(--ink);padding:1.4rem 0 1.1rem;border-bottom:1px solid var(--rule)}
.top{display:flex;justify-content:space-between;align-items:flex-end;gap:1rem;flex-wrap:wrap}
h1{font-family:var(--wide);font-variation-settings:'wdth' 120,'wght' 800;font-size:clamp(1.7rem,4vw,2.4rem);line-height:1;letter-spacing:-.02em;text-transform:uppercase;margin:.4rem 0 0}
.eyebrow{font-family:var(--mono);font-size:.66rem;letter-spacing:.16em;text-transform:uppercase;color:var(--faint);margin:0}
.stats{display:flex;gap:1.4rem;flex-wrap:wrap;font-family:var(--mono);font-size:.7rem;color:var(--soft);margin-top:.9rem}
.stats b{color:var(--ink);font-weight:500}
.stats .bad{color:var(--debit)}

button{font-family:var(--mono);font-size:.7rem;letter-spacing:.09em;text-transform:uppercase;padding:.6rem 1rem;border:1px solid var(--ink);background:transparent;color:var(--ink);cursor:pointer;transition:background .15s,color .15s,transform .06s}
button:hover:not(:disabled){background:var(--ink);color:var(--paper)}
button:active:not(:disabled){transform:translateY(1px)}
button:disabled{opacity:.45;cursor:default}
.run{background:var(--ink);color:var(--paper)}
.run:hover:not(:disabled){background:var(--credit);border-color:var(--credit);color:var(--paper)}

.controls{display:flex;gap:.4rem;flex-wrap:wrap;align-items:center;padding:1rem 0;border-bottom:1px solid var(--rule)}
.chip{font-family:var(--mono);font-size:.68rem;letter-spacing:.07em;text-transform:uppercase;padding:.4rem .75rem;border:1px solid var(--rule);color:var(--soft);cursor:pointer;background:transparent}
.chip[aria-pressed=true]{background:var(--ink);color:var(--paper);border-color:var(--ink)}
.spacer{flex:1}
.sort{font-family:var(--mono);font-size:.68rem;letter-spacing:.07em;text-transform:uppercase;color:var(--soft);background:transparent;border:1px solid var(--rule);padding:.4rem .5rem}

.row{display:grid;grid-template-columns:3.4rem 1fr 12rem;gap:1rem;padding:1.1rem .6rem;border-bottom:1px solid var(--rule);align-items:start}
.row:nth-child(even){background:var(--bar)}
.score{font-family:var(--mono);font-size:1.05rem;font-weight:500;text-align:right;padding-top:.15rem}
.s-hi{color:var(--credit)}.s-mid{color:var(--warn)}.s-lo{color:var(--faint)}
.title{font-family:var(--wide);font-variation-settings:'wdth' 112,'wght' 700;font-size:1.05rem;margin:0;line-height:1.25}
.title a{color:inherit;text-decoration:none}
.title a:hover{text-decoration:underline;text-decoration-color:var(--credit)}
.meta{font-family:var(--mono);font-size:.68rem;color:var(--faint);margin-top:.3rem;letter-spacing:.03em}
.reason{font-size:.92rem;color:var(--soft);margin:.5rem 0 0;max-width:62ch}
.against{font-size:.86rem;color:var(--debit);margin:.35rem 0 0;max-width:62ch}
.tags{display:flex;gap:.3rem;margin-top:.5rem;flex-wrap:wrap;align-items:center}
.tag{font-family:var(--mono);font-size:.6rem;letter-spacing:.06em;text-transform:uppercase;padding:.15rem .4rem;border:1px solid var(--rule);color:var(--faint)}
/* Age carries meaning, so it is coloured, not decorated. */
.age{border-color:currentColor}
.age-fresh{color:var(--credit)}.age-ok{color:var(--soft)}.age-stale{color:var(--debit)}.age-none{color:var(--warn)}
.flag{font-family:var(--mono);font-size:.66rem;color:var(--debit);margin-top:.45rem}
.flag.quiet{color:var(--faint)}

.actions{display:flex;flex-direction:column;gap:.3rem}
.actions button{padding:.35rem .5rem;font-size:.62rem;border-color:var(--rule);color:var(--soft)}
.actions button.on{background:var(--credit);border-color:var(--credit);color:var(--paper)}
.actions .draft{border-color:var(--ink);color:var(--ink);font-weight:500}
.actions .draft:hover:not(:disabled){background:var(--ink);color:var(--paper)}

.kit{grid-column:1/-1;margin-top:.8rem;padding:1rem;border:1px solid var(--credit);background:var(--deep)}
.kit h3{font-family:var(--mono);font-size:.64rem;letter-spacing:.14em;text-transform:uppercase;color:var(--credit);margin:0 0 .5rem}
.kit p{margin:0;font-size:.92rem;line-height:1.6;color:var(--ink);max-width:66ch}
.kit code{font-family:var(--mono);font-size:.7rem;color:var(--soft);display:block;margin-top:.7rem;word-break:break-all}

.empty{padding:3rem .6rem;color:var(--soft);font-size:.95rem;max-width:56ch}
.empty b{font-family:var(--mono);font-size:.8rem;color:var(--ink);display:block;margin-bottom:.4rem;text-transform:uppercase;letter-spacing:.08em}
/* Skeleton matches the real row shape so first paint does not jump. */
.skel{display:grid;grid-template-columns:3.4rem 1fr 12rem;gap:1rem;padding:1.1rem .6rem;border-bottom:1px solid var(--rule)}
.bone{background:var(--rule);opacity:.5;height:.7rem}
.bone.tall{height:1.1rem}
@media (prefers-reduced-motion:no-preference){
  .bone{animation:pulse 1.4s ease-in-out infinite}
  @keyframes pulse{50%{opacity:.22}}
}
footer{padding:1.2rem 0 2.5rem;border-top:1px solid var(--ink);margin-top:1.5rem;font-family:var(--mono);font-size:.66rem;color:var(--faint);letter-spacing:.06em}
@media(max-width:760px){
  .row,.skel{grid-template-columns:2.8rem 1fr}
  .actions{grid-column:1/-1;flex-direction:row;flex-wrap:wrap}
}
</style></head><body>
<div class="shell">
  <header>
    <div class="top">
      <div><p class="eyebrow">Job funnel</p><h1>Shortlist</h1></div>
      <button class="run" id="run">Run pipeline</button>
    </div>
    <div class="stats" id="stats"></div>
  </header>
  <div class="controls" id="controls"></div>
  <div id="list"></div>
  <footer id="foot"></footer>
</div>
<script>
var STATUSES=['new','interested','applied','screen','interview','offer','declined','rejected','closed'];
/* Shown as row actions. Split in two because the question "have they replied?" is
   different from "do I want this?", and one flat row of nine buttons hid that. */
var PRE_ACTS=['interested','applied','rejected','closed'];
var POST_ACTS=['screen','interview','offer','declined'];
var data={jobs:[],counts:{},threshold:60,total:0,digests:0};
var filter='new', minOnly=false, sort='score', kits={}, loaded=false;

function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}

function band(s){var t=data.threshold||60;return s>=t+10?'s-hi':s>=t-10?'s-mid':'s-lo';}

/* Age is recomputed on render, never read from the stored ageDays, which is
   frozen at the moment the row passed the filter and drifts every day after. */
function ageDays(job){
  if(!job.postedAt) return null;
  var t=new Date(job.postedAt).getTime();
  if(isNaN(t)) return null;
  return Math.floor((Date.now()-t)/86400000);
}
function ageTag(job){
  var d=ageDays(job);
  if(d===null) return '<span class="tag age age-none" title="No posting date, so freshness is unknown">undated</span>';
  var cls=d<=7?'age-fresh':d<=21?'age-ok':'age-stale';
  return '<span class="tag age '+cls+'" title="Posted '+d+' days ago">'+d+'d</span>';
}

function statLine(){
  var t=data.threshold||60;
  var over=data.jobs.filter(function(j){return j.score>=t;}).length;
  var out='<span><b>'+data.total+'</b> tracked</span>'
    +'<span><b>'+over+'</b> scoring '+t+'+</span>'
    +'<span><b>'+(data.counts.applied||0)+'</b> applied</span>';
  if(data.funnel&&data.funnel.applied){
    var f=data.funnel;
    out+='<span><b>'+f.responded+'</b> heard back'
      +(f.responseRate===null?'':' ('+Math.round(f.responseRate*100)+'%)')+'</span>';
  }
  out+='<span><b>'+data.digests+'</b> digests sent</span>';
  if(data.lastRun&&!data.lastRun.error){
    out+='<span>last run <b>'+data.lastRun.scanned+'</b> scanned · <b>'+data.lastRun.llmScored+'</b> read · '+esc(data.lastRun.cost)+'</span>';
  }
  if(data.lastRun&&data.lastRun.error){
    out+='<span class="bad">last run failed: '+esc(data.lastRun.error)+'</span>';
  }
  return out;
}

function controls(){
  var t=data.threshold||60;
  var out=STATUSES.map(function(s){
    return '<button class="chip" aria-pressed="'+(filter===s)+'" data-f="'+s+'">'+s+' '+(data.counts[s]||0)+'</button>';
  }).join('');
  out+='<button class="chip" aria-pressed="'+(filter==='all')+'" data-f="all">all</button>';
  out+='<button class="chip" aria-pressed="'+minOnly+'" data-min="1">'+t+'+ only</button>';
  out+='<span class="spacer"></span>';
  out+='<label class="sort" for="sort">Sort '
    +'<select id="sort" class="sort" style="border:0;padding:0 0 0 .4rem">'
    +'<option value="score"'+(sort==='score'?' selected':'')+'>score</option>'
    +'<option value="fresh"'+(sort==='fresh'?' selected':'')+'>newest</option>'
    +'<option value="seen"'+(sort==='seen'?' selected':'')+'>last seen</option>'
    +'</select></label>';
  return out;
}

/* Anything the verifier or the location rules decided gets said out loud —
   a closed row that only says "closed" makes the tool look broken. */
function flags(j){
  var out='';
  if(j.deadReason) out+='<p class="flag">Link dead: '+esc(j.deadReason)+'</p>';
  if(j.rejectReason) out+='<p class="flag quiet">Set aside: '+esc(j.rejectReason)+'</p>';
  /* The number that was missing entirely: how long this has been quiet. */
  if(j.status==='applied'&&j.appliedAt&&!j.respondedAt){
    var qd=Math.floor((Date.now()-new Date(j.appliedAt).getTime())/86400000);
    out+='<p class="flag quiet">Applied '+qd+'d ago — no reply recorded.</p>';
  }
  if(j.respondedAt&&j.appliedAt){
    var rd=Math.floor((new Date(j.respondedAt).getTime()-new Date(j.appliedAt).getTime())/86400000);
    out+='<p class="flag">Replied after '+rd+'d.</p>';
  }
  if(j.scoreSource==='prescore') out+='<p class="flag quiet">Keyword score only, not read by the model.</p>';
  return out;
}

function rowHtml(j){
  var meta=esc(j.company)+' · '+esc(j.location||'location not stated')
    +(j.salaryText?' · '+esc(j.salaryText):'');
  var tags=ageTag(j);
  if(j.remote_policy) tags+='<span class="tag">'+esc(j.remote_policy)+'</span>';
  if(j.seniority_label) tags+='<span class="tag">'+esc(j.seniority_label)+'</span>';
  if(j.tier&&j.tier!=='feed') tags+='<span class="tag">'+esc(j.tier)+'</span>';
  tags+='<span class="tag">'+esc(String(j.source||'').split(':')[0])+'</span>';

  var mkBtn=function(s){
    return '<button class="'+(j.status===s?'on':'')+'" data-id="'+j.id+'" data-s="'+s+'">'+s+'</button>';
  };
  var acts='<button class="draft" data-draft="'+j.id+'">Draft application</button>';
  acts+=PRE_ACTS.map(mkBtn).join('');
  /* The reply stages only appear once something was actually sent — before that they
     are noise, and after it they are the only buttons that matter. */
  if(j.appliedAt||j.status==='applied'||POST_ACTS.indexOf(j.status)>=0){
    acts+='<span class="spacer" style="width:.5rem"></span>'+POST_ACTS.map(mkBtn).join('');
  }

  var kit='';
  if(kits[j.id]){
    kit='<div class="kit"><h3>Draft cover letter</h3><p>'+esc(kits[j.id].cover)+'</p>'
      +'<code>'+esc(kits[j.id].file)+'</code></div>';
  }

  return '<div class="row">'
    +'<div class="score '+band(j.score)+'">'+j.score+'</div>'
    +'<div>'
      +'<h2 class="title"><a href="'+esc(j.url)+'" target="_blank" rel="noopener">'+esc(j.title)+'</a></h2>'
      +'<div class="meta">'+meta+'</div>'
      +(j.reason?'<p class="reason">'+esc(j.reason)+'</p>':'')
      +(j.against?'<p class="against">Against: '+esc(j.against)+'</p>':'')
      +'<div class="tags">'+tags+'</div>'
      +flags(j)
    +'</div>'
    +'<div class="actions">'+acts+'</div>'
    +kit
  +'</div>';
}

function skeleton(){
  var one='<div class="skel"><div class="bone tall"></div>'
    +'<div><div class="bone tall" style="width:52%"></div>'
    +'<div class="bone" style="width:34%;margin-top:.6rem"></div>'
    +'<div class="bone" style="width:76%;margin-top:.7rem"></div></div>'
    +'<div class="bone" style="height:5rem"></div></div>';
  return one+one+one+one;
}

function emptyHtml(){
  var t=data.threshold||60;
  if(filter==='new'&&data.total>0){
    return '<div class="empty"><b>Nothing new</b>'
      +'Everything tracked has been marked. Switch to <em>all</em> to review what you set aside, or run the pipeline for fresh postings.</div>';
  }
  if(minOnly){
    return '<div class="empty"><b>Nothing at '+t+' or above</b>'
      +'An empty list beats a padded one. Drop the score filter to see what came close.</div>';
  }
  return '<div class="empty"><b>Nothing here yet</b>'
    +'Run the pipeline to collect postings, or widen the filter.</div>';
}

function render(){
  var btn=document.getElementById('run');
  btn.disabled=!!data.running;
  btn.textContent=data.running?'Running…':'Run pipeline';

  document.getElementById('stats').innerHTML=statLine();
  document.getElementById('controls').innerHTML=controls();

  if(!loaded){document.getElementById('list').innerHTML=skeleton();return;}

  var t=data.threshold||60;
  var rows=data.jobs.filter(function(j){
    return (filter==='all'||j.status===filter)&&(!minOnly||j.score>=t);
  });

  if(sort==='fresh'){
    rows=rows.slice().sort(function(a,b){
      var x=ageDays(a), y=ageDays(b);
      if(x===null&&y===null) return (b.score||0)-(a.score||0);
      if(x===null) return 1;
      if(y===null) return -1;
      return x-y;
    });
  } else if(sort==='seen'){
    rows=rows.slice().sort(function(a,b){
      return String(b.lastSeenAt||'').localeCompare(String(a.lastSeenAt||''));
    });
  }

  document.getElementById('list').innerHTML=
    rows.length?rows.map(rowHtml).join(''):emptyHtml();

  var stale=rows.filter(function(j){var d=ageDays(j);return d!==null&&d>21;}).length;
  document.getElementById('foot').textContent=
    rows.length+' shown'+(stale?' · '+stale+' older than 21 days':'')+' · data/jobs.json';
}

async function load(){
  try{
    var r=await fetch('/api/jobs');
    data=await r.json();
    loaded=true;
    render();
    if(data.running) setTimeout(load,3000);
  }catch(err){
    loaded=true;
    document.getElementById('list').innerHTML=
      '<div class="empty"><b>Cannot reach the server</b>'
      +'The dashboard is running but /api/jobs did not answer. Check the terminal where you started it.</div>';
  }
}

document.addEventListener('change',function(e){
  if(e.target.id==='sort'){sort=e.target.value;render();}
});

document.addEventListener('click',async function(e){
  var f=e.target.closest('[data-f]');
  if(f){filter=f.dataset.f;return render();}

  var m=e.target.closest('[data-min]');
  if(m){minOnly=!minOnly;return render();}

  var b=e.target.closest('[data-id]');
  if(b){
    var cur=data.jobs.find(function(j){return j.id===b.dataset.id;});
    var next=cur.status===b.dataset.s?'new':b.dataset.s;
    await fetch('/api/status',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({id:b.dataset.id,status:next})});
    return load();
  }

  var d=e.target.closest('[data-draft]');
  if(d){
    d.disabled=true;d.textContent='Drafting…';
    var res=await fetch('/api/apply',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({id:d.dataset.draft})});
    var kit=await res.json();
    if(kit.error){d.disabled=false;d.textContent='Draft failed, retry';return;}
    kits[d.dataset.draft]=kit;
    return render();
  }

  if(e.target.id==='run'){
    await fetch('/api/run',{method:'POST'});
    data.running=true;render();setTimeout(load,3000);
  }
});

load();
</script></body></html>`;
