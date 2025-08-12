(() => {
  'use strict';

  /*───────────────────────────────────────────────────────────────────────────*
   * 0) testSOVA – perzistence + early console hook (stejné chování jako BE)
   *───────────────────────────────────────────────────────────────────────────*/
  const SOVA_LS_TEST = 'SOVA.testSOVA.enabled';
  (function sovaEarlyTestHook(){
    if (localStorage.getItem(SOVA_LS_TEST) !== '1') return;
    try{ 
      const orig = {};
      const types = ['log','info','warn','error','group','groupCollapsed','groupEnd'];
      const buf = [];
      types.forEach(t=>{
        orig[t] = console[t];
        console[t] = function(...args){
          try { buf.push({ t, args, ts: Date.now() }); } catch {}
          return orig[t].apply(console, args);
        };
      });
      window.__SOVA_TEST_PRELOG__ = {
        buf,
        restore(){ types.forEach(t => (console[t] = orig[t])); }
      };
    }catch(e){}
  })();

  /*───────────────────────────────────────────────────────────────────────────*
   * 1) SOVA root + BUS + URL helper
   *───────────────────────────────────────────────────────────────────────────*/
  const SOVA = (window.SOVA = window.SOVA || {});
  (function initBus(ns){
    if (ns.bus) return;
    const topics = new Map();
    function on(topic, fn){ if (!topics.has(topic)) topics.set(topic,new Set()); topics.get(topic).add(fn); return ()=>off(topic,fn); }
    function once(topic, fn){ const offOnce = on(topic, (...a)=>{ try{ fn(...a); } finally{ offOnce(); } }); return offOnce; }
    function off(topic, fn){ topics.get(topic)?.delete(fn); }
    function emit(topic, data){ const s=topics.get(topic); if(!s||!s.size) return; [...s].forEach(fn=>{ try{ fn(data); }catch(e){ console.error('[SOVA.bus]',topic,e); } }); }
    ns.bus = { on, once, off, emit };
  })(SOVA);

  (function initFnRegistry(ns){
    if (ns.fn) return;
    const _reg = Object.create(null);
    ns.fn = {
      register(name, fn){ if(!name||typeof fn!=='function') throw new Error('SOVA.fn.register invalid'); _reg[name]=fn; },
      has(name){ return !!_reg[name]; },
      list(){ return Object.keys(_reg); },
      run(name, params, ctx){
        if(!_reg[name]) return Promise.reject(new Error(`SOVA.fn.run: unknown "${name}"`));
        try{ const out=_reg[name](params,ctx); return (out&&typeof out.then==='function')?out:Promise.resolve(out); }
        catch(e){ return Promise.reject(e); }
      }
    };
  })(SOVA);

  (function initURL(ns){
    if (ns.url) return;
    function _escapeRegex(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }
    function _patternToRegexSrc(pat){ const esc=_escapeRegex(pat).replace(/\\\*/g,'.*'); return `^${esc}$`; }
    function _shouldIncludeQuery(pattern){ return pattern.includes('?'); }
    function _getTargetString(includeQuery){ const base=location.pathname; return includeQuery ? base+(location.search||'') : base; }
    function toRegex(pattern){ const includeQuery=_shouldIncludeQuery(pattern); const rx=new RegExp(_patternToRegexSrc(pattern)); return { rx, includeQuery }; }
    function match(patterns, opts={}){
      const arr = Array.isArray(patterns) ? patterns
        : (typeof patterns==='string' ? [patterns] : []);
      if (!arr.length) return true;
      for (const p of arr){
        const { rx, includeQuery } = toRegex(p);
        const target = _getTargetString(opts.includeQuery ?? includeQuery);
        if (rx.test(target)) return true;
      }
      return false;
    }
    ns.url = { match, toRegex };
  })(SOVA);

 /*───────────────────────────────────────────────────────────────────────────*
 * 2) SOVAL – BE jádro beze změny (vložené sem)
 *     POZN.: Logika/emitory se nemění. (Zachováno kvůli kompatibilitě.)
 *───────────────────────────────────────────────────────────────────────────*/
(function initSOVAL(){
  if (SOVA.calculateSOVAL) return;

/* ───────── Pomůcky ───────── */
const MS_MIN  = 60_000;
const MS_HOUR = 60 * MS_MIN;
const MS_DAY  = 24 * MS_HOUR;

function parseDate(v){
  if (v == null || v === '') return NaN;
  if (typeof v === 'number') return v;
  v = String(v).replace(/\u00A0/g,' ').replace(/\. /g,'.').trim();
  const [dpart, tpart = ''] = v.split(/\s+/, 2);
  const dPieces = dpart.split(/[.\-/]/);
  if (dPieces.length < 2) return NaN;
  let [day, mon, year] = dPieces.map(x => x.padStart(2,'0'));
  if (!year) year = String(new Date().getFullYear());
  else if (year.length === 2) year = '20' + year;
  let [h = '00', m = '00', s = '00'] = tpart.split(':').map(x => x.padStart(2,'0'));
  const iso = `${year}-${mon}-${day}T${h}:${m}:${s}Z`;
  const ms  = Date.parse(iso);
  return Number.isNaN(ms) ? NaN : ms;
}

function coerceNumber(v){
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v == null) return 0;
  const s = String(v).replace(/[^0-9,.-]/g,'').replace(/\s+/g,'').replace(',','.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}
function coerceString(v){ return v == null ? '' : String(v); }
function coerceBoolean(v){
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number')  return v !== 0;
  if (v == null) return false;
  if (typeof v === 'string'){
    const s = v.trim().toLowerCase();
    return !(s === '' || s === 'false' || s === '0');
  }
  return Boolean(v);
}
function resolvePath(path, ctx){
  if (path.includes(':')){
    const [tbl, col] = path.split(':', 2);
    const src = ctx[tbl];
    if (Array.isArray(src))             return src.map(r => r?.[col]);
    if (src && typeof src === 'object') return src[col];
    return undefined;
  }
  const parts = path.split('.');
  if (parts.length === 1)               return ctx[parts[0]];
  const [tbl, col] = parts;
  const src = ctx[tbl];
  if (Array.isArray(src))               return src.map(r => r?.[col]);
  if (src && typeof src === 'object')   return src[col];
  return undefined;
}
const median = arr => { if (!arr.length) return undefined; const s = [...arr].sort((a,b)=>a-b); const m = s.length>>1; return s.length%2 ? s[m] : (s[m-1]+s[m])/2; };
const mode   = arr => { const map = new Map(); arr.forEach(v => map.set(v,(map.get(v)||0)+1)); let top, best=-1; map.forEach((cnt,val)=>{ if(cnt>best){best=cnt;top=val;} }); return top; };

/* ───────── Test mód + striktní čísla ───────── */
function isTestMode(){ try{ return localStorage.getItem('SOVA.testSOVA.enabled') === '1'; }catch{ return false; } }
function warnTest(...args){ if (isTestMode()) { try{ console.warn('[SOVAL]', ...args); }catch{} } }

// Povolit jen číslice, tečku a úvodní mínus. Pokud nezůstane žádná číslice → NaN.
function parseNumberStrict(v){
  if (v == null) return NaN;
  const cleaned = String(v).replace(/[^\d.\-]/g,'');
  if (!/[0-9]/.test(cleaned)) return NaN;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

// "" (nebo whitespace) v ARITMETICE = 0 ; jinak striktní parsing
function toNumArith(v){
  if (v === '' || (typeof v === 'string' && v.trim() === '')) return 0;
  return parseNumberStrict(v);
}


/* ───────── Reg funkce + registry ───────── */
const fnRegistry = Object.create(null);
const aliasMap   = Object.create(null);
function reg(name, fn, ...aliases){
  fnRegistry[name.toLowerCase()] = fn;
  [...aliases, name].forEach(a=>aliasMap[a.toLowerCase()] = name.toLowerCase());
}
reg('tofunction', x => x, 'tofunc', 'evalexpr', 'nafunkci', 'vyhodnot');

// Aritmetika (nečíselný vstup → NaN + warning)
// Aritmetika ("" => 0, jinak strict; nečíselný vstup → NaN + warning)
reg('add',      (a,b)=>{ const na=toNumArith(a), nb=toNumArith(b);
  if(!Number.isFinite(na)||!Number.isFinite(nb)){ warnTest('ADD → NaN', a, b); return NaN; }
  return na+nb; }, '+','secti');

reg('subtract', (a,b)=>{ const na=toNumArith(a), nb=toNumArith(b);
  if(!Number.isFinite(na)||!Number.isFinite(nb)){ warnTest('SUBTRACT → NaN', a, b); return NaN; }
  return na-nb; }, '-','odecti');

reg('multiply', (a,b)=>{ const na=toNumArith(a), nb=toNumArith(b);
  if(!Number.isFinite(na)||!Number.isFinite(nb)){ warnTest('MULTIPLY → NaN', a, b); return NaN; }
  return na*nb; }, '*','vynasob');

reg('divide',   (a,b)=>{ const na=toNumArith(a), nb=toNumArith(b);
  if(!Number.isFinite(na)||!Number.isFinite(nb)){ warnTest('DIVIDE → NaN', a, b); return NaN; }
  return na/nb; }, '/','vydel');

reg('power',    (a,b)=>{ const na=toNumArith(a), nb=toNumArith(b);
  if(!Number.isFinite(na)||!Number.isFinite(nb)){ warnTest('POWER → NaN', a, b); return NaN; }
  return Math.pow(na, nb); }, '^','umocni');

reg('abs', n => Math.abs(coerceNumber(n)));
reg('randbetween',(a,b)=>Math.floor(Math.random()*(coerceNumber(b)-coerceNumber(a)+1))+coerceNumber(a),'nahoda','rnd');

// Text
reg('concat',(a,b)=>coerceString(a)+coerceString(b),'&','zretez');
reg('concatenate',(sep,...rest)=>rest.map(coerceString).join(coerceString(sep)),'concatwith','join');
reg('upper', s=>coerceString(s).toUpperCase(),'velka','uppercase');
reg('lower', s=>coerceString(s).toLowerCase(),'mala','lowercase');
reg('substitute',(txt,pat,repl='')=>coerceString(txt).replaceAll(coerceString(pat),coerceString(repl)),'dosadit','replace');
reg('normalizetext',(txt,repl='')=>{
  const R = coerceString(repl);
  let out = coerceString(txt)
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^\w-]+/gu, R);
  if (R) {
    const esc = R.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    out = out.replace(new RegExp(`${esc}{2,}`,'g'),R).replace(new RegExp(`^${esc}|${esc}$`,'g'),'');
  }
  return out;
},'normalize','normalizovattext');

// IF
reg('if',(c,a,b='')=>coerceBoolean(c)?a:b,'kdyz','když');

// Porovnání
function parseNumberLoose(v){
  if (typeof v === 'number') return Number.isFinite(v)?v:NaN;
  if (typeof v === 'boolean') return v?1:0;
  if (v == null) return NaN;
  const s = String(v).replace(/[^0-9,.-]/g,'').replace(/\s+/g,'').replace(',', '.');
  if (!/[0-9]/.test(s)) return NaN;
  const n = parseFloat(s);
  return Number.isFinite(n)?n:NaN;
}
function cmpString(a,b){
  const sa = coerceString(a), sb = coerceString(b);
  return sa.localeCompare(sb, 'cs', { sensitivity:'accent' });
}

// = a !=: číselně když obě strany číslo; když žádná strana číslo → textově; jinak false + warning
function equalsSmart(a,b){
  const na = parseNumberStrict(a), nb = parseNumberStrict(b);
  const aNum = Number.isFinite(na), bNum = Number.isFinite(nb);
  if (aNum && bNum) return na === nb;

  const aHasDigits = /[0-9]/.test(String(a));
  const bHasDigits = /[0-9]/.test(String(b));
  if (!aHasDigits && !bHasDigits) return cmpString(a,b) === 0;

  warnTest('EQUALS mixed numeric/text → false', a, b);
  return false;
}
reg('equals',    (a,b)=> equalsSmart(a,b), '=', '==','jerovno');
reg('notEquals', (a,b)=> !equalsSmart(a,b), '!=','<>','nenirovno');

// <, >, <=, >=: jen číselně (strict). Když aspoň jedna strana není číslo → false + warning
function cmpNumericOrFalse(a,b, op){
  const na = parseNumberStrict(a), nb = parseNumberStrict(b);
  if (!Number.isFinite(na) || !Number.isFinite(nb)){
    warnTest(`RELATIONAL ${op} – nečíselný operand → false`, a, b);
    return false;
  }
  switch(op){
    case '>':  return na >  nb;
    case '<':  return na <  nb;
    case '>=': return na >= nb;
    case '<=': return na <= nb;
    default: return false;
  }
}
reg('isGreater',          (a,b)=>cmpNumericOrFalse(a,b,'>'),  '>','jevetsi');
reg('isLess',             (a,b)=>cmpNumericOrFalse(a,b,'<'),  '<','jemensi');
reg('isGreaterOrEqual',   (a,b)=>cmpNumericOrFalse(a,b,'>='), '>=' ,'jevetsineborovno');
reg('isLessOrEqual',      (a,b)=>cmpNumericOrFalse(a,b,'<='), '<=', 'jemensinborovno');

// Regex funkce
reg('regextest',(text,pattern,case_sens)=>{ try{
  const t=coerceString(text), pat=coerceString(pattern), ic=coerceBoolean(case_sens)?'':'i';
  const rx=new RegExp(pat,'u'+ic); return rx.test(t);
} catch(e){ console.warn('[REGEXTEST] Invalid pattern:',pattern,e); return false; }},'~','regexTest');

reg('regexextract',(text,pattern,return_mode=0,case_sens)=>{ try{
  const t=coerceString(text), pat=coerceString(pattern),
        all=Number(coerceNumber(return_mode))===1, ic=coerceBoolean(case_sens)?'':'i';
  if(all){
    const rxg=new RegExp(pat,'ug'+ic);
    const out=[]; let m; while((m=rxg.exec(t))){ out.push(m[1]??m[0]); if(m[0]==='') rxg.lastIndex++; }
    return out;
  }
  const rx=new RegExp(pat,'u'+ic); const m=rx.exec(t); return m? (m[1]??m[0]) : '';
}catch(e){ console.warn('[REGEXEXTRACT] Invalid pattern:',pattern,e);
  return (Number(coerceNumber(return_mode))===1)?[]:''; }});

reg('regexreplace',(text,pattern,replacement,occurrence=0,case_sens)=>{ try{
  const t=coerceString(text), pat=coerceString(pattern), repl=coerceString(replacement),
        occ=Math.trunc(coerceNumber(occurrence)||0), ic=coerceBoolean(case_sens)?'':'i';
  const expand=(tpl,groupsArr,fullMatch)=> tpl.replace(/\$(\d+)/g,(_,$d)=>{
    const n=Number($d); if(n===0) return fullMatch??''; return groupsArr[n-1]??'';
  });
  if(occ===0){
    const rxg=new RegExp(pat,'ug'+ic);
    return t.replace(rxg, (match,...args)=>{ const groups=args.slice(0,args.length-2); return expand(repl,groups,match); });
  }
  const rxg=new RegExp(pat,'ug'+ic);
  const matches=[]; let m; while((m=rxg.exec(t))){ matches.push({index:m.index,full:m[0],groups:m.slice(1)}); if(m[0]==='') rxg.lastIndex++; }
  if(!matches.length) return t;
  const idx=(occ>0)?(occ-1):(matches.length+occ);
  if(idx<0||idx>=matches.length) return t;
  const hit=matches[idx], before=t.slice(0,hit.index), after=t.slice(hit.index+hit.full.length), rep=expand(repl, hit.groups, hit.full);
  return before+rep+after;
}catch(e){ console.warn('[REGEXREPLACE] Invalid pattern:',pattern,e); return coerceString(text); }});

// --- TEXT: prázdný vzor = false ---
reg('contains', (a,b) => {
  const hay = coerceString(a), needle = coerceString(b);
  if (needle === '') return false;
  return hay.includes(needle);
}, 'contains');

reg('startsWith', (a,b) => {
  const hay = coerceString(a), needle = coerceString(b);
  if (needle === '') return false;
  return hay.startsWith(needle);
}, 'startswith','zacinana');

reg('endsWith', (a,b) => {
  const hay = coerceString(a), needle = coerceString(b);
  if (needle === '') return false;
  return hay.endsWith(needle);
}, 'endswith','koncina');


// Logické
reg('NOT', x=>!coerceBoolean(x),'!','ne','not');
reg('AND',(a,b)=>coerceBoolean(a)&&coerceBoolean(b),'a','and','&&');
reg('OR', (a,b)=>coerceBoolean(a)||coerceBoolean(b),'nebo','or','||');

// Délky období
reg('now', ()=>Date.now(),'nyni','nyne','teď');
reg('days',    v=>+(parseDate(v)/MS_DAY ).toFixed(2),'dny');
reg('hours',   v=>+(parseDate(v)/MS_HOUR).toFixed(2),'hodiny');
reg('minutes', v=>+(parseDate(v)/MS_MIN ).toFixed(2),'minuty');

/* ───────── Preprocess/lexer/parser (beze změn) ───────── */
function preprocessOperators(src){
  const parts=[]; let i=0;
  const pushCode=(from,to)=>{ if(to>from) parts.push({type:'code',value:src.slice(from,to)}); };
  while(i<src.length){
    if(src.startsWith('$RAW$',i)){
      const start=i; i+=5; const end=src.indexOf('$RAW$',i);
      if(end===-1) throw new SyntaxError('Unterminated $RAW$ string');
      const fullEnd=end+5; parts.push({type:'string', value:src.slice(start, fullEnd)}); i=fullEnd; continue;
    }
    const c=src[i];
    if(c==='"'||c==="'"){
      const start=i; const quote=c; i++; let escaping=false;
      while(i<src.length){
        const ch=src[i];
        if(escaping){ escaping=false; i++; continue; }
        if(ch==='\\'){ escaping=true; i++; continue; }
        if(ch===quote){ i++; break; }
        i++;
      }
      if(i===src.length&&src[i-1]!==quote) throw new SyntaxError('Unterminated string literal');
      parts.push({type:'string', value:src.slice(start,i)}); continue;
    }
    const start=i; while(i<src.length && !(src.startsWith('$RAW$',i)||src[i]==='"'||src[i]==="'")) i++;
    pushCode(start,i);
  }
  const rewrite=s=>{
    s=s.replace(/&&/g,' __LOG_AND__ ')
      .replace(/>=/g,' isGreaterOrEqual ')
      .replace(/<=/g,' isLessOrEqual ')
      .replace(/!=|<>/g,' notEquals ')
      .replace(/(?<=\S)>(?=\S)/g,' isGreater ')
      .replace(/(?<=\S)<(?=\S)/g,' isLess ')
      .replace(/(?<=\S)=(?=\S)/g,' equals ')
      .replace(/(?<=\S)\+(?=\S)/g,' add ')
      .replace(/(?<=\S)-(?=\S)/g,' subtract ')
      .replace(/(?<=\S)\*(?=\S)/g,' multiply ')
      .replace(/(?<=\S)\/(?=\S)/g,' divide ')
      .replace(/\^/g,' power ')
      .replace(/&/g,' concat ')
      .replace(/\band\b/gi,' AND ')
      .replace(/\bor\b/gi,' OR ');
    s=s.replace(/__LOG_AND__/g,' && ');
    return s;
  };
  return parts.map(p=>p.type==='code'? rewrite(p.value) : p.value).join('');
}

const TT = { NUMBER:'number', STRING:'string', IDENT:'ident', OP:'op', LPAREN:'(', RPAREN:')', COMMA:',', EOF:'eof' };

function lex(src){
  const out=[]; let i=0; const push=(type,value)=>out.push({type,value});
  while(i<src.length){
    const c=src[i];
    if(/\s/.test(c)){ i++; continue; }
    if(/[0-9]/.test(c)){ let s=''; while(i<src.length && /[0-9.]/.test(src[i])){ s+=src[i++]; } push(TT.NUMBER,s); continue; }
    if(src.startsWith('$RAW$',i)){ i+=5; const end=src.indexOf('$RAW$',i); if(end===-1) throw new SyntaxError('Unterminated $RAW$ string'); const content=src.slice(i,end); i=end+5; push(TT.STRING,content); continue; }
    if(c==='"'||c==="'"){ const quote=c; i++; let s=''; let escaping=false; while(i<src.length){ const ch=src[i]; if(escaping){ s+=ch; escaping=false; i++; continue; } if(ch==='\\'){ s+=ch; escaping=true; i++; continue; } if(ch===quote){ i++; break; } s+=ch; i++; } if(i===src.length&&src[i-1]!==quote) throw new SyntaxError('Unterminated string literal'); push(TT.STRING,s); continue; }
    if(/[A-Za-z_\p{L}]/u.test(c)){ let s=''; while(i<src.length && /[A-Za-z0-9_.:\p{L}]/u.test(src[i])) s+=src[i++]; push(TT.IDENT,s); continue; }
    const two=src.slice(i,i+2);
    if(['>=','<=','!=','<>','&&','||'].includes(two)){ push(TT.OP,two); i+=2; continue; }
    if(['+','-','*','/','^','&','>','<','=','~'].includes(c)){ push(TT.OP,c); i++; continue; }
    if(c==='('){ push(TT.LPAREN,c); i++; continue; }
    if(c===')'){ push(TT.RPAREN,c); i++; continue; }
    if(c===','){ push(TT.COMMA ,c); i++; continue; }
    throw new SyntaxError('Neznámý znak: '+c);
  }
  push(TT.EOF,''); return out;
}

function parser(tokens){
  let pos=0; const peek=()=>tokens[pos]; const next=()=>tokens[pos++];
  const aggregateSet=new Set(['any','all','countif','count','sumif','suma','sum','averageif','medianif','modeif','lookup','filter','unique','sortby']);
  const isAgg=id => aggregateSet.has(aliasMap[id.toLowerCase()] ?? id.toLowerCase());
  const lbp=tok=>{
    if(tok.type!==TT.OP && tok.type!==TT.IDENT) return 0;
    const name = (aliasMap[tok.value.toLowerCase()] ?? tok.value.toLowerCase());
    switch(name){
      case 'power': return 40;
      case 'multiply': case 'divide': return 30;
      case 'add': case 'subtract': return 20;
      case 'concat': return 15;
      case 'equals': case 'notequals': case 'isgreater': case 'isless':
      case 'isgreaterorequal': case 'islessorequal': case 'regextest': case 'contains': case 'startswith': case 'endswith': return 14;
      case 'and': return 5;
      case 'or':  return 4;
      default: return 0;
    }
  };
  function nud(tok){
    if(tok.type===TT.NUMBER) return {type:'Literal', value:coerceNumber(tok.value)};
    if(tok.type===TT.STRING) return {type:'Literal', value:tok.value};
    if(tok.type===TT.IDENT){
      const name=tok.value;
      if(/^(not|ne)$/i.test(name)){ const right=expr(50); return {type:'Unary', op:'not', right}; }
      if(peek().type===TT.LPAREN){
        next();
        const args=[];
        if(peek().type!==TT.RPAREN){ args.push(expr(0)); while(peek().type===TT.COMMA && next()) args.push(expr(0)); }
        const nxt=next(); if(nxt.type!==TT.RPAREN) throw new SyntaxError(`Missing ) at token #${pos-1}: '${nxt.value}'`);
        const canon=aliasMap[name.toLowerCase()] ?? name.toLowerCase();
        if(isAgg(name)){
          return { type:'AggregateCall', name:canon, coll:args[0], pred: args[1], field: canon==='sumif'? args[2] : undefined };
        }
        return {type:'Call', name, args};
      }
      return {type:'Variable', name};
    }
    if(tok.type===TT.OP && ['+','-','!'].includes(tok.value)){ const right=expr(50); return {type:'Unary', op:tok.value, right}; }
    if(tok.type===TT.LPAREN){ const e=expr(0); const nxt=next(); if(nxt.type!==TT.RPAREN) throw new SyntaxError(`Missing ) at token #${pos-1}: '${nxt.value}'`); return e; }
    throw new SyntaxError(`Unexpected token ${tok.type} ('${tok.value}') at index ${pos-1}`);
  }
  function led(tok,left){ const opTok=(aliasMap[tok.value.toLowerCase()] ?? tok.value.toLowerCase()); const right=expr(lbp(tok)); return {type:'Binary', op:opTok, left, right}; }
  function expr(rbp=0){ let left=nud(next()); while(rbp<lbp(peek())) left=led(next(),left); return left; }
  const tree=expr();
  if(peek().type!==TT.EOF){ const pk=peek(); throw new SyntaxError(`Unexpected token at end (#${pos}): '${pk.value}'`); }
  return tree;
}

/* ───────── Evaluace + debug ───────── */
function reduceAggregates(node, ctx, hooks = {}){
  const { evalNode = evalAst, onEnterAgg=null, onLeaveAgg=null } = hooks;
  if(!node || typeof node!=='object') return node;
  for(const k in node){ if(node[k] && typeof node[k]==='object'){ node[k]=reduceAggregates(node[k], ctx, hooks); } }
  if(node.type!=='AggregateCall') return node;

  const path = node.coll?.type==='Variable' ? node.coll.name : '';
  let tblName='', colName=''; if(path.includes(':')) [tblName,colName]=path.split(':',2); else [tblName,colName]=path.split('.',2);
  const table = ctx[tblName]; const rows = Array.isArray(table)? table : [];
  onEnterAgg?.(node.name, tblName, colName, rows);

  const pred   = node.pred ? (r => evalNode(node.pred, { ...ctx, [tblName]: r })) : (()=>true);
  const select = colName ? (r => r?.[colName]) : (r => r);
  const matchedRows = rows.filter(pred);
  const values = matchedRows.map(select);

  let out;
  switch(node.name){
    case 'sumif': case 'sum': case 'suma': out = values.reduce((s,v)=>s+coerceNumber(v),0); break;
    case 'countif': case 'count': out = matchedRows.length; break;
    case 'any': out = node.pred ? rows.some(pred) : rows.some(r=>coerceBoolean(select(r))); break;
case 'all': {
  const base = node.pred ? rows.every(pred) : rows.every(r => coerceBoolean(select(r)));
  out = rows.length === 0 ? false : base;   // prázdné = false
} break;
    case 'averageif': out = matchedRows.length ? values.reduce((s,v)=>s+coerceNumber(v),0)/matchedRows.length : 0; break;
    case 'medianif': out = median(values.map(coerceNumber)); break;
    case 'modeif':   out = mode(values); break;
    case 'lookup':   out = values.find(()=>true); break;
    case 'filter':   out = values; break;
    case 'unique':   out = [...new Set(values)]; break;
    case 'sortby': { const keyString=node.pred?.value||''; const keys=keyString.split(',').map(s=>s.trim()).filter(Boolean);
      out=[...matchedRows].sort((a,b)=>{ for(const k of keys){ if(a[k]<b[k]) return -1; if(a[k]>b[k]) return 1; } return 0; }); } break;
    default: out = undefined;
  }
  onLeaveAgg?.(node.name, out);
  return { type:'Literal', value: out };
}

function evalAst(node, ctx){
  switch(node.type){
    case 'Literal': return node.value;
    case 'Variable': {
      const v=resolvePath(node.name, ctx);
      if (v === undefined){
        warnTest(`Neznámá proměnná '${node.name}' → ""`);
        return "";
      }
      return v;
    }
    case 'Unary': { const fn=fnRegistry[ aliasMap[node.op] ?? node.op ]; return fn( evalAst(node.right, ctx) ); }
    case 'Binary':{ const fn=fnRegistry[ aliasMap[node.op] ?? node.op ]; return fn( evalAst(node.left,ctx), evalAst(node.right,ctx) ); }
    case 'Call': {
      const fnName = aliasMap[node.name.toLowerCase()] ?? node.name.toLowerCase();
      if (fnName === 'tofunction') {
        if (node.args.length !== 1) throw new SyntaxError('TOFUNCTION očekává přesně 1 argument (string s výrazem).');
        const innerSrc = coerceString(evalAst(node.args[0], ctx));
        const innerFn  = calculateSOVAL.compile(innerSrc, { debug:true });
        return innerFn(ctx);
      }
      const fn = fnRegistry[fnName];
      return fn(...node.args.map(a=>evalAst(a,ctx)));
    }
    default: throw new Error('Unknown AST node '+node.type);
  }
}

function debugEvalAst(node, ctx, depth=0){
  const pad='  '.repeat(depth);
  if (node.type==='Literal'){ console.log(`${pad}Literal(${node.value})`); return node.value; }
  if (node.type==='Variable'){
    const v=resolvePath(node.name, ctx);
    if (v === undefined){
      console.log(`${pad}Variable ${node.name} → "" (UNDEFINED)`);
      return "";
    }
    console.log(`${pad}Variable ${node.name} →`, v); return v;
  }
  if (node.type==='Unary'){ console.log(`${pad}Unary ${node.op}`); const rv=debugEvalAst(node.right,ctx,depth+1); const res=fnRegistry[aliasMap[node.op] ?? node.op](rv); console.log(`${pad}→ ${node.op}(${rv}) =`, res); return res; }
  if (node.type==='Binary'){ console.log(`${pad}Binary ${node.op}`); const lv=debugEvalAst(node.left,ctx,depth+1); const rv=debugEvalAst(node.right,ctx,depth+1); const res=fnRegistry[aliasMap[node.op] ?? node.op](lv,rv); console.log(`${pad}→ ${node.op}(${lv},${rv}) =`, res); return res; }
  if (node.type==='Call'){
    console.log(`${pad}Call ${node.name}`);
    const fnName = aliasMap[node.name.toLowerCase()] ?? node.name.toLowerCase();
    if (fnName === 'tofunction') {
      if (node.args.length !== 1) throw new SyntaxError('TOFUNCTION očekává přesně 1 argument (string s výrazem).');
      const innerSrc = coerceString(debugEvalAst(node.args[0], ctx, depth+1));
      console.log(`${pad}→ TOFUNCTION source:`, innerSrc);
      const innerFn = calculateSOVAL.compile(innerSrc, { debug:true });
      const res = innerFn(ctx);
      console.log(`${pad}→ TOFUNCTION result =`, res);
      return res;
    }
    const args = node.args.map(a=>debugEvalAst(a,ctx,depth+1));
    const res = fnRegistry[aliasMap[node.name.toLowerCase()] ?? node.name.toLowerCase()](...args);
    console.log(`${pad}→ ${node.name}(${args.join(',')}) =`, res);
    return res;
  }
  throw new Error('Unknown node '+node.type);
}

/* ───────── Public API ───────── */
const _astCache = new Map();
function _getAst(src){
  const s = preprocessOperators(src||'');
  if (!_astCache.has(s)) _astCache.set(s, parser(lex(s)));
  return _astCache.get(s);
}
const calculateSOVAL = {
  compile(src, options = {}){
    const astOriginal = _getAst(src||'');
    const { debug=false, hooks={} } = options;
    const mergedHooks = {
      ...(hooks||{}),
      ...(debug ? {
        evalNode: (n,c) => debugEvalAst(n,c,2),
        onEnterAgg: (name,tbl,col,rows) => { console.groupCollapsed(`Aggregate ${name}  ←  ${tbl}:${col??''}`); console.log(`rows[${rows.length}]`, rows); },
        onLeaveAgg: (name,out) => { console.log(`  → ${name} =`, out); console.groupEnd(); }
      } : {})
    };
    return (ctx) => {
      const astClone = JSON.parse(JSON.stringify(astOriginal));
      const withAgg  = reduceAggregates(astClone, ctx, mergedHooks);
      return debug ? debugEvalAst(withAgg, ctx) : evalAst(withAgg, ctx);
    };
  },
  evaluate(expr, ctx, options){ return calculateSOVAL.compile(expr, options)(ctx); },
  register(name, fn, ...aliases){ reg(name, fn, ...aliases); }
};
calculateSOVAL.evalBool = function(expr, ctx, options){
  if (!expr || /^\s*$/.test(expr)) return true;
  const v = calculateSOVAL.compile(expr, options)(ctx);
  return !!(typeof v === 'boolean' ? v : (typeof v === 'number' ? v !== 0 : String(v).trim().toLowerCase() !== 'false' && String(v).trim() !== ''));
};
calculateSOVAL.evalText = function(expr, ctx, options){
  if (expr == null) return '';
  const v = calculateSOVAL.compile(expr, options)(ctx);
  return v == null ? '' : String(v);
};
calculateSOVAL.expandParams = function(spec, ctx, options){
  const ev = (s) => calculateSOVAL.compile(String(s), options)(ctx);
  if (spec == null) return undefined;
  if (Array.isArray(spec)) return spec.map(x => ev(x));
  if (typeof spec === 'object'){
    const out = {}; for (const [k,v] of Object.entries(spec)) out[k] = ev(v); return out;
  }
  return ev(spec);
};
SOVA.calculateSOVAL = calculateSOVAL;
window.SOVAL = window.SOVAL || {};
Object.assign(window.SOVAL, { calculateSOVAL });

})(); // end SOVAL


/*───────────────────────────────────────────────────────────────────────────*
 * 3) FE Context – tvůj kód s drobnými změnami:
 *    - přidán isTest()
 *    - přidán paralelní merge injectVariables (NOVÉ)
 *    - context:ready se vystřelí až po DL + DOM + VARS (NOVÉ)
 *───────────────────────────────────────────────────────────────────────────*/
(function initContextFrontend(){
  const bus = SOVA.bus;
  const DOM_READ_THROTTLE_MS = 200;
  const NBSP = '\u00A0';
  const $  = (q,root=document)=> root.querySelector(q);
  const $$ = (q,root=document)=> Array.from(root.querySelectorAll(q));
  const toNum = v => { if (v == null) return undefined; const n = Number(v); return Number.isFinite(n) ? n : undefined; };
  const toInt = v => { if (v == null) return undefined; const n = parseInt(v,10); return Number.isNaN(n) ? undefined : n; };
  const text = (el)=> (el?.textContent||'').replaceAll(NBSP,' ').trim();
  const html = (el)=> el ? el.innerHTML.trim() : '';
  const sanitizeId = s => String(s||'').replace(/[^A-Za-z0-9]/g,'');
  const safeKey = raw => String(raw||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^A-Za-z0-9]+/g,'').replace(/^([0-9])/,'_$1');
  const SEP_LONG_COMMA = /,(?:[ \u00A0]){6,}/;
  const splitParamValues = (raw)=> !raw ? [] : String(raw).split(SEP_LONG_COMMA).map(s => s.replace(/[ \t\r\n\u00A0]+/g,' ').trim()).filter(Boolean).filter((v,i,a)=>a.indexOf(v)===i);
  const deepEq=(a,b)=>{ if(a===b) return true; if(a&&b&&typeof a==='object'&&typeof b==='object'){ try{return JSON.stringify(a)===JSON.stringify(b);}catch{return false;} } return false; };
  const assignAndDiff=(target, patch)=>{ const changed=[]; for (const [k,v] of Object.entries(patch||{})){ const prev=target[k]; if (!deepEq(prev,v)){ target[k]=v; changed.push(k); } } return changed; };

  const isTest = () => localStorage.getItem('SOVA.testSOVA.enabled') === '1';  // NOVÉ

  const ctx = Object.create(null);
  let liveCartAmount;

  function getLatestShoptetLayer(){
    const dl = window.dataLayer || [];
    for (let i = dl.length - 1; i >= 0; i--) { const rec = dl[i]; if (rec && typeof rec === 'object' && rec.shoptet) return rec.shoptet; }
    return null;
  }
  function buildDataLayerPatch(){
    const sh = getLatestShoptetLayer() || {};
    const out = {};
    out.pageType   = sh.pageType;
    out.currency   = sh.currency;
    out.language   = sh.language;
    out.projectId  = sh.projectId;
    const ci = sh.currencyInfo || {};
    out.currencyInfoDecimalSeparator   = ci.decimalSeparator;
    out.currencyInfoExchangeRate       = toNum(ci.exchangeRate);
    out.currencyInfoPriceDecimalPlaces = toNum(ci.priceDecimalPlaces);
    out.currencyInfoSymbol             = ci.symbol;
    const c = sh.cartInfo || {};
    out.cartInfoId             = c.id;
    out.cartInfoFreeShipping   = !!c.freeShipping;
    out.cartInfoFreeGift       = !!c.freeGift;
    out.cartInfoDiscountCoupon = Array.isArray(c.discountCoupon) ? c.discountCoupon.slice() : c.discountCoupon;
    out.cartInfoTaxMode        = c.taxMode;
    if (c.leftToFreeGift){
      out.cartInfoLeftToFreeGiftFormatted = c.leftToFreeGift.formattedPrice;
      out.cartInfoLeftToFreeGift          = toNum(c.leftToFreeGift.priceLeft);
    }
    if (c.leftToFreeShipping){
      out.cartInfoLeftToFreeShipping          = toNum(c.leftToFreeShipping.priceLeft);
      out.cartInfoLeftToFreeShippingFormatted = c.leftToFreeShipping.formattedPrice;
    }
    if (c.getNoBillingShippingPrice){
      out.cartInfoNoBillingShippingPriceVat        = toNum(c.getNoBillingShippingPrice.vat);
      out.cartInfoNoBillingShippingPriceWithVat    = toNum(c.getNoBillingShippingPrice.withVat);
      out.cartInfoNoBillingShippingPriceWithoutVat = toNum(c.getNoBillingShippingPrice.withoutVat);
    }
    const rawItems = (Array.isArray(c.cartItems) && c.cartItems.length) ? c.cartItems : (Array.isArray(sh.cart) ? sh.cart : []);
    out.cartItems = rawItems.map(it => ({
      code: it.code, guid: it.guid, priceId: toInt(it.priceId), quantity: toNum(it.quantity),
      priceWithVat: toNum(it.priceWithVat), priceWithoutDiscount: toNum(it.priceWithoutDiscount),
      itemId: it.itemId, name: it.name, weight: toNum(it.weight)
    }));
    const cust = sh.customer || {};
    out.customerGuid        = cust.guid;
    out.customerEmail       = cust.email;
    out.customerFullName    = cust.fullName;
    out.customerPriceRatio  = toNum(cust.priceRatio);
    out.customerPriceListId = toInt(cust.priceListId);
    out.customerGroupId     = toInt(cust.groupId);
    out.customerRegistered  = !!cust.registered;
    out.customerMainAccount = !!cust.mainAccount;
    out.trafficType = sh.traffic_type || sh.trafficType;
    const p = sh.product || {};
    if (sh.pageType === 'productDetail' && p){
      out.productId                   = p.id;
      out.productGuid                 = p.guid;
      out.productHasVariants          = !!p.hasVariants;
      out.productCode                 = Array.isArray(p.codes) && p.codes[0] ? p.codes[0].code : undefined;
      out.productName                 = p.name;
      out.productAppendix             = p.appendix;
      out.productWeight               = toNum(p.weight);
      out.productManufacturer         = p.manufacturer;
      out.productManufacturerGuid     = p.manufacturerGuid;
      out.productCurrentCategory      = p.currentCategory;
      out.productCurrentCategoryGuid  = p.currentCategoryGuid;
      out.productDefaultCategory      = p.defaultCategory;
      out.productDefaultCategoryGuid  = p.defaultCategoryGuid;
      out.productCurrency             = p.currency || sh.currency;
      out.productPriceWithVat         = toNum(p.priceWithVat ?? p.priceWithVatMin ?? p.priceWithVatMax);
      out.productVariants = Array.isArray(p.codes) ? p.codes.map(row => {
        const r = { code: row.code, quantity: toNum(row.quantity) };
        (row.stocks || []).forEach(s => { const key = 'stock' + sanitizeId(s.id || ''); r[key] = toNum(s.quantity); });
        return r;
      }) : [];
      out.stocks = Array.isArray(sh.stocks) ? sh.stocks.map(s => ({ id: s.id, title: s.title, isDeliveryPoint: !!s.isDeliveryPoint, visibleOnEshop: !!s.visibleOnEshop })) : [];
    }
    return out;
  }
  function readDataLayer(reason='dl'){
    const patch = buildDataLayerPatch();
    assignAndDiff(ctx, patch);
    try { SOVA.bus.emit('contextDataLayerReady', { snapshot: { ...ctx }, reason }); } catch(e){}
  }
  function hook(path, after){
    try {
      const parts = path.split('.'); let host = window[parts[0]];
      for (let i=1;i<parts.length-1;i++){ if (!host) return; host = host[parts[i]]; }
      const name = parts[parts.length-1]; if (!host || !host[name] || host[name].__hooked) return;
      const orig = host[name];
      const wrap = function(){ const r = orig.apply(this, arguments); try{ after(`hook:${path}`); }catch(e){} return r; };
      wrap.__hooked = true; host[name] = wrap;
    } catch(e){}
  }

  function parsePrices_Product(){
    const root = $('.p-final-price-wrapper');
    return {
      standardPrice : text(root?.querySelector('.price-standard span')) || undefined,
      priceSave     : text(root?.querySelector('.price-save')) || undefined,
      finalPrice    : text(root?.querySelector('.price-final [data-testid="productCardPrice"], .price-final strong') || root?.querySelector('.price.price-final strong')) || undefined,
      additionalPrice: text(root?.querySelector('.price-additional')) || undefined,
    };
  }
  function parseDeliveryEstimate_Product(){
    const d = $('.detail-parameters .delivery-time [data-testid="deliveryTime"] .show-tooltip, .detail-parameters .delivery-time [data-testid="deliveryTime"], .detail-parameters .delivery-time');
    return { deliveryEstimate: text(d) || undefined };
  }
  function readCartAmount_Product(root=document){
    if (liveCartAmount !== undefined) return liveCartAmount;
    const input = root.querySelector('input.amount[data-testid="cartAmount"], input.amount[name="amount"]');
    return input ? toInt(input.value) : undefined;
  }
  function parseShortDescription_Product(){
    const el = $('.p-short-description [data-testid="productCardShortDescr"], .p-short-description');
    return { shortDescription: html(el) };
  }
  function parseProductList(containerSel){
    const out = [];
    $$(containerSel + ' .product').forEach(card => {
      const p = card.querySelector('.p');
      const data = {};
      data.code = text(card.querySelector('.p-code [data-micro="sku"]')) || undefined;
      data.id   = p?.getAttribute('data-micro-product-id') || undefined;
      const aImg= card.querySelector('a.image');
      data.url  = aImg?.getAttribute('href') || undefined;
      const img = aImg?.querySelector('img');
      data.img  = img?.getAttribute('src') || undefined;
      data.imgBig = img?.getAttribute('data-micro-image') || undefined;
      data.flags = $$('.flags span.flag', card).map(s=> s.className.split(/\s+/).find(c=>c.startsWith('flag-'))).filter(Boolean);
      data.name = text(card.querySelector('[data-testid="productCardName"]')) || undefined;
      const starsWrap = card.querySelector('.stars-wrapper');
      data.rating = starsWrap ? toNum(starsWrap.getAttribute('data-micro-rating-value')) : undefined;
      const av = card.querySelector('.availability');
      const avSpan = av?.querySelector('.show-tooltip');
      data.availability = text(avSpan) || undefined;
      data.availabilityTooltip = avSpan?.getAttribute('data-original-title') || '';
      const color = (avSpan?.getAttribute('style')||'').match(/color\s*:\s*([^;]+)/i);
      data.availabilityColor = color ? color[1].trim() : '';
      data.standardPrice  = text(card.querySelector('.flags .price-standard span')) || undefined;
      data.priceSave      = text(card.querySelector('.flags .price-save')) || undefined;
      data.finalPrice     = text(card.querySelector('.price.price-final strong')) || undefined;
      data.additionalPrice= html(card.querySelector('.price-additional')) || undefined;
      data.priceId   = toInt(card.querySelector('input[name="priceId"]')?.value);
      data.productId = toInt(card.querySelector('input[name="productId"]')?.value) || toInt(data.id);
      data.csrf      = card.querySelector('input[name="__csrf__"]')?.value || '';
      data.shortDescription = html(card.querySelector('[data-testid="productCardShortDescr"]')) || '';
      const offer = card.querySelector('[data-micro="offer"]');
      data.warranty = offer?.getAttribute('data-micro-warranty') || '';
      out.push(data);
    });
    return out;
  }
  function parseDetailParameters(){
    const tbl = document.querySelector('.extended-description .detail-parameters') || document.querySelector('.detail-parameters');
    const result = {};
    if (!tbl) return result;
    const catRow = Array.from(tbl.querySelectorAll('tr')).find(tr=>/Kategorie/i.test(tr.innerText));
    if (catRow){
      const a = catRow.querySelector('a[href]');
      result.category = text(a) || undefined;
      result.categoryURL = a?.getAttribute('href') || undefined;
    }
    const warrRow = Array.from(tbl.querySelectorAll('tr')).find(tr=>/Z[aá]ruka/i.test(tr.innerText));
    if (warrRow) result.warranty = text(warrRow.querySelector('td')) || undefined;
    const eanRow = tbl.querySelector('.productEan');
    if (eanRow) result.EAN = text(eanRow.querySelector('.productEan__value')) || undefined;
    Array.from(tbl.querySelectorAll('tr')).forEach(tr=>{
      const thTxt = (tr.querySelector('th')?.textContent || '').replaceAll(NBSP,' ').trim();
      const td = tr.querySelector('td');
      if (!thTxt || !td) return;
      if (/Kategorie|Z[aá]ruka|EAN/i.test(thTxt)) return;
      const key = 'parametr' + safeKey(thTxt);
      const rawVal = (td.textContent || '');
      result[key] = splitParamValues(rawVal);
    });
    return result;
  }
  function parseCartTable(){
    const rows = $$('.cart-table tbody tr.removeable');
    return rows.map(tr=>{
      const code = tr.getAttribute('data-micro-sku') || undefined;
      const a = tr.querySelector('.p-name a.main-link');
      const img = tr.querySelector('.cart-p-image img');
      const avLabel = tr.querySelector('.p-availability .availability-label.show-tooltip');
      const amountInput = tr.querySelector('input.amount[data-testid="cartAmount"]');
      const variant = a?.querySelector('.main-link-variant, [data-testid="cartWidgetVariantName"]')?.textContent?.trim();
      return {
        code,
        URL: a?.getAttribute('href') || undefined,
        IMG: img?.getAttribute('src') || undefined,
        name: text(a) || undefined,
        variant: variant || undefined,
        availability: text(avLabel) || undefined,
        availabilityTooltip: avLabel?.getAttribute('data-original-title') || '',
        availabilityAmount: text(tr.querySelector('[data-testid="numberAvailabilityAmount"]')) || undefined,
        amount: amountInput ? toInt(amountInput.value) : undefined,
        unitPrice: text(tr.querySelector('[data-testid="cartItemPrice"]')) || undefined,
        totalPrice: text(tr.querySelector('[data-testid="cartPrice"]')) || undefined,
      };
    });
  }
  function parseCartTotals(){
    return {
      deliveryEstimate: text($('.delivery-time [data-testid="deliveryTime"] strong, .delivery-time [data-testid="deliveryTime"], .delivery-time strong')) || undefined,
      priceTotal: text($('[data-testid="recapFullPrice"]')) || undefined,
      priceTotalNoWAT: text($('[data-testid="recapFullPriceNoVat"]')) || undefined,
    };
  }
  function parseCheckoutRecapItems(){
    const items = [];
    $$('.cart-items [data-testid="recapCartItem"]').forEach(ci=>{
      const a = ci.querySelector('[data-testid="cartProductName"]');
      const variant = a?.querySelector('.main-link-variant, [data-testid="cartWidgetVariantName"]')?.textContent?.trim();
      const amountStr = (text(ci.querySelector('[data-testid="recapItemAmount"]')) || '').replace(/\s+/g,' ').trim();
      const amountNum = toInt(amountStr.replace(/[^\d-]+/g,''));
      items.push({
        code: ci.getAttribute('data-micro-sku') || undefined,
        URL: a?.getAttribute('href') || undefined,
        name: text(a) || undefined,
        variant: variant || undefined,
        amount: Number.isFinite(amountNum) ? amountNum : undefined,
        price: text(ci.querySelector('[data-testid="recapItemPrice"]')) || undefined,
        totalPrice: text(ci.querySelector('[data-testid="recapItemPrice"]')) || undefined,
      });
    });
    return items;
  }
  function parseCheckoutSelectedMethods(){
    const billEl = $('[data-testid="paymentMethods"] ~ .recapitulation-shipping-billing-info, [data-testid="recapDeliveryMethod"]');
    const shipEl = billEl?.parentElement?.querySelectorAll('.recapitulation-shipping-billing-info')[1] ||
                   $$('[data-testid="recapDeliveryMethod"]').slice(-1)[0];
    const billPrice = billEl?.querySelector('[data-testid="recapItemPrice"]');
    const shipPrice = shipEl?.querySelector('[data-testid="recapItemPrice"]');
    return {
      selectedBilling: billEl ? billEl.childNodes[billEl.childNodes.length-1]?.textContent?.trim() : undefined,
      billingPrice: text(billPrice) || undefined,
      selectedShipping: shipEl ? shipEl.childNodes[shipEl.childNodes.length-1]?.textContent?.trim() : undefined,
      shippingPrice: text(shipPrice) || undefined,
    };
  }
  function parseCheckoutTotals(){
    return {
      priceTotal: text($('div.price-wrapper [data-testid="recapFullPrice"]')) || undefined,
      priceTotalNoWAT: text($('div.price-wrapper [data-testid="recapFullPriceNoVat"]')) || undefined,
    };
  }
  function parseItemsPrice(){
    const el = $('[data-testid="recapItemTotalPrice"]');
    return { itemsPrice: text(el) || undefined };
  }
  function parseContactAndAddresses(){
    const out = {};
    out.name  = document.querySelector('#billFullName')?.value || '';
    out.email = document.querySelector('#email')?.value || '';
    out.phone = document.querySelector('#phone')?.value || '';
    const phSel = document.querySelector('select.js-phone-code');
    if (phSel){
      const opt = phSel.querySelector('option:checked');
      try { const data = JSON.parse(opt?.value || '{}'); out.phoneCode = data.phoneCode || ''; } catch{ out.phoneCode = ''; }
    }
    out.billStreet = document.querySelector('#billStreet')?.value || '';
    out.billCity   = document.querySelector('#billCity')?.value || '';
    out.billZip    = document.querySelector('#billZip')?.value || '';
    out.billCountryId = document.querySelector('#billCountryIdInput')?.value || document.querySelector('#billCountryId')?.value || '';
    out.anotherShipping = !!document.querySelector('#another-shipping')?.checked;
    out.deliveryFullName = document.querySelector('#deliveryFullName')?.value || '';
    out.deliveryStreet   = document.querySelector('#deliveryStreet')?.value || '';
    out.deliveryCity     = document.querySelector('#deliveryCity')?.value || '';
    out.deliveryZip      = document.querySelector('#deliveryZip')?.value || '';
    out.deliveryCompany  = document.querySelector('#deliveryCompany')?.value || '';
    out.noteActive          = !!document.querySelector('#add-note')?.checked;
    out.doNotSendNewsletter = !!document.querySelector('#sendNewsletter')?.checked;
    out.setRegistration     = !!document.querySelector('#set-registration')?.checked;
    out.remark              = document.querySelector('#remark')?.value || '';
    return out;
  }

  const domMapFromRows = (rows)=>{ const map=new Map(); rows.forEach(r=>{ if(r.code) map.set(r.code,r); }); return map; };
  function mergeCartItems(baseDL=[], domMap=new Map()){
    const merged=[]; const seen=new Set();
    baseDL.forEach(dl=>{
      const m={...dl}; const d=domMap.get(dl.code);
      if(d){
        if (d.URL            != null) m.URL = d.URL;
        if (d.IMG            != null) m.IMG = d.IMG;
        if (d.variant        != null) m.variant = d.variant;
        if (d.amount         != null) m.quantity = toNum(d.amount);
        if (d.availabilityAmount != null) m.availabilityAmount = d.availabilityAmount;
        if (d.availabilityTooltip!= null) m.availabilityTooltip = d.availabilityTooltip;
        if (d.totalPrice     != null) m.totalPrice = d.totalPrice;
        if (d.unitPrice      != null) m.unitPriceText = d.unitPrice;
        if (d.price          != null && m.totalPrice == null) m.totalPrice = d.price;
      }
      merged.push(m); seen.add(dl.code);
    });
    domMap.forEach((d, code)=>{ if (seen.has(code)) return;
      merged.push({ code, URL:d.URL, IMG:d.IMG, name:d.name, variant:d.variant, quantity:toNum(d.amount), totalPrice:d.totalPrice??d.price, availabilityAmount:d.availabilityAmount, availabilityTooltip:d.availabilityTooltip });
    });
    return merged;
  }

  function attachProductDOMListeners(){
    const qty = document.querySelector('input.amount[data-testid="cartAmount"]');
    const inc = document.querySelector('button[data-testid="increase"]');
    const dec = document.querySelector('button[data-testid="decrease"]');
    const fire = ()=>{ liveCartAmount = toInt(qty?.value); scheduleDOM('pd:amount-change'); };
    if (qty){ qty.addEventListener('input',fire,true); qty.addEventListener('keyup',fire,true); liveCartAmount = toInt(qty.value); }
    if (inc){ inc.addEventListener('click', ()=> setTimeout(fire,0), true); }
    if (dec){ dec.addEventListener('click', ()=> setTimeout(fire,0), true); }
  }
  function attachCartDOMListeners(){
    $$('.cart-table tbody tr.removeable').forEach(tr=>{
      const qty = tr.querySelector('input.amount[data-testid="cartAmount"]');
      const inc = tr.querySelector('button[data-testid="increase"]');
      const dec = tr.querySelector('button[data-testid="decrease"]');
      const fire = (tag)=> ()=> setTimeout(()=> scheduleDOM(tag), 0);
      if (qty){ qty.addEventListener('input',  fire('cart:amount-input'),  true);
                qty.addEventListener('keyup',  fire('cart:amount-keyup'),  true); }
      if (inc){ inc.addEventListener('click',  fire('cart:amount-inc'),    true); }
      if (dec){ dec.addEventListener('click',  fire('cart:amount-dec'),    true); }
    });
  }
  function attachCheckoutDOMListeners(){
    const payWrap = document.querySelector('#order-billing-methods');
    const shipWrap= document.querySelector('#order-shipping-methods');
    if (payWrap){ payWrap.addEventListener('click', ()=> setTimeout(()=> scheduleDOM('checkout:click-billing'),0), true); }
    if (shipWrap){ shipWrap.addEventListener('click', ()=> setTimeout(()=> scheduleDOM('checkout:click-shipping'),0), true); }
    document.addEventListener('input',  e=>{ if(e.target.closest('.co-contact-information, .co-shipping-address, .header-billing, #note')) scheduleDOM('checkout:input'); },  true);
    document.addEventListener('change', e=>{ if(e.target.closest('.co-contact-information, .co-shipping-address, .header-billing, #note, .js-phone-code')) scheduleDOM('checkout:change'); }, true);
  }

  let domMs = 0, dlMs = 0;
  let dlDone = false, domDone = false;
  let readyEmitted = false;

  // ─── NOVÉ: gate pro variables ─────────────────────────────────────────────
  let varsDone = false;

  function mergeInjectVariables(reason='vars'){
    // preferuj settings z rules; fallback na window.injectVariables (objekt)
    let src = SOVA.rules?.featureSettings?.('injectVariables');
    if (!src && window.injectVariables && typeof window.injectVariables === 'object' && !Array.isArray(window.injectVariables)){
      src = window.injectVariables;
    }

    if (!src){
      varsDone = true;        // není co vkládat → gate hotová
      maybeEmitContextReady();
      return;
    }

    const patch = {};
    for (const [k,v] of Object.entries(src)){ patch[k] = v; }
    const changed = assignAndDiff(ctx, patch);
    varsDone = true;

    if (isTest()){
      console.groupCollapsed('[context] injectVariables merged →', reason);
      console.table(changed.map(key => ({ key, value: ctx[key] })));
      console.groupEnd();
    }

    maybeEmitContextReady();
  }
  // ──────────────────────────────────────────────────────────────────────────

  function readDOM(reason='dom'){
    const page = ctx.pageType || (document.body?.className?.match(/page-(\w+)/)?.[1]);
    const patch = {};
    if (page === 'productDetail'){
      Object.assign(patch, parsePrices_Product());
      Object.assign(patch, parseDeliveryEstimate_Product());
      patch.cartAmount = readCartAmount_Product();
      Object.assign(patch, parseShortDescription_Product());
      patch.relatedProducts    = parseProductList('.products-related');
      patch.alternativeProducts= parseProductList('.products-alternative');
      Object.assign(patch, parseDetailParameters());
      attachProductDOMListeners();
    } else if (page === 'cart'){
      const domRows = parseCartTable();
      Object.assign(patch, parseCartTotals());
      patch.cartItemsExtended = mergeCartItems(ctx.cartItems||[], domMapFromRows(domRows));
      attachCartDOMListeners();
    } else if (page === 'billingAndShipping'){
      const domRows = parseCheckoutRecapItems();
      Object.assign(patch, parseCheckoutSelectedMethods());
      Object.assign(patch, parseCheckoutTotals());
      Object.assign(patch, parseItemsPrice());
      patch.cartItemsExtended = mergeCartItems(ctx.cartItems||[], domMapFromRows(domRows));
      attachCheckoutDOMListeners();
    } else if (page === 'customerDetails'){
      const domRows = parseCheckoutRecapItems();
      Object.assign(patch, parseCheckoutTotals());
      Object.assign(patch, parseCheckoutSelectedMethods());
      Object.assign(patch, parseItemsPrice());
      Object.assign(patch, parseContactAndAddresses());
      patch.cartItemsExtended = mergeCartItems(ctx.cartItems||[], domMapFromRows(domRows));
      attachCheckoutDOMListeners();
    }
    assignAndDiff(ctx, patch);
  }

  let domTimer=null, lastDOMTrigger='';
  function scheduleDOM(reason){
    lastDOMTrigger = reason || lastDOMTrigger || 'dom';
    if (domTimer) return;
    domTimer = setTimeout(()=>{ domTimer=null; readDOM(lastDOMTrigger); domDone = true; maybeEmitContextReady(); }, DOM_READ_THROTTLE_MS);
  }
  function reparseDOMImmediate(reason){ readDOM(reason); domDone = true; maybeEmitContextReady(); }
  function maybeEmitContextReady(){
    // READY až když DL + DOM + VARS (NOVÉ)
    if (readyEmitted) return;
    if (dlDone && domDone && varsDone){
      readyEmitted = true;
      try { SOVA.bus.emit('context:ready', { snapshot: { ...ctx }, tookMsDL: dlMs, tookMsDOM: domMs }); } catch(e){}
    }
  }

  const SHOPTET_DOM_EVENTS = [
    'ShoptetDOMContentLoaded','ShoptetDOMPageContentLoaded','ShoptetDOMPageMoreProductsLoaded',
    'ShoptetDOMCartContentLoaded','ShoptetDOMSearchResultsLoaded','ShoptetDOMProductRatingsLoaded',
    'ShoptetDOMProductDiscussionsLoaded','ShoptetDOMAdvancedOrderLoaded'
  ];
  SHOPTET_DOM_EVENTS.forEach(ev=>{ document.addEventListener(ev, ()=> scheduleDOM(`evt:${ev}`), true); });

  (function attachGlobalMO(){
    const WHITELIST = ['.cart-table','.cart-items','#order-billing-methods','#order-shipping-methods','.co-contact-information','.co-shipping-address','.p-final-price-wrapper','.extended-description'];
    const roots = WHITELIST.map(sel => document.querySelector(sel)).filter(Boolean);
    const noisy = ['.toast', '.modal', '[aria-live]', '[data-testid="tooltip"]', '.cookie-bar'];
    const handle = (muts)=>{ const rel=muts.filter(m=>{ if(!m.target?.closest) return true; return !noisy.some(n=>m.target.closest(n)); }); if(!rel.length) return; scheduleDOM('mo'); };
    const mo = new MutationObserver(handle);
    if (!roots.length){ if(document.body) mo.observe(document.body,{childList:true,subtree:true}); return; }
    roots.forEach(r=> mo.observe(r,{childList:true,subtree:true}));
  })();

  function rerunDL(reason){ queueMicrotask(()=>{ readDataLayer(reason); dlDone = true; maybeEmitContextReady(); scheduleDOM('DL merge'); }); }
  hook('shoptet.tracking.updateDataLayerCartInfo', rerunDL);
  hook('shoptet.tracking.updateCartDataLayer',     rerunDL);
  document.addEventListener('ShoptetDataLayerUpdated', ()=>rerunDL('evt:ShoptetDataLayerUpdated'), true);

  function when(cond, cb, tries=100){ if (cond()) return cb(); const t=setInterval(()=>{ if(cond()){ clearInterval(t); cb(); } },50); setTimeout(()=>clearInterval(t), tries*50); }
  when(()=> !!window.dataLayer, ()=>{ readDataLayer('init:dl'); dlDone = true; maybeEmitContextReady(); });
  domMs = 0; reparseDOMImmediate('init:dom');

  // ─── start paralelního merge injectVariables (NOVÉ) ───────────────────────
  if (SOVA.rules?.sourceInfo) {
    mergeInjectVariables('init:rules-ready');
  } else {
    // pokus o okamžitý globál (když je v inline settings)
    if (window.injectVariables && typeof window.injectVariables === 'object' && !Array.isArray(window.injectVariables)){
      mergeInjectVariables('init:inline-glob');
    } else {
      // jinak počkej na rules:ready (zatím běží DL/DOM)
      SOVA.bus.once('rules:ready', ()=> mergeInjectVariables('evt:rules:ready'));
    }
  }
  // ──────────────────────────────────────────────────────────────────────────

  const getContext = {
    onUpdate(fn){ /* jednoduchý live diff: vždy celé snapshoty */ const off = SOVA.bus.on('context:ready', p=>fn({snapshot:p?.snapshot||{}, reason:'ready', changedKeys:Object.keys(p?.snapshot||{})})); return off; },
    snapshot(){ return { ...ctx }; },
    ensure(){}, ensureAll(){}, ensureTableNow(){}
  };
  SOVA.getContext = getContext;
  window.SOVAL = window.SOVAL || {};
  window.SOVAL.getContext = window.SOVAL.getContext || getContext;
})();


/*───────────────────────────────────────────────────────────────────────────*
 * 4) FE Rules loader (JS globály) + PROVIZORNÍ fallback fetch z GitHubu
 *     - Primárně čte window.injectFunctions a per-funkční bloky (např. window.additionalSale)
 *     - Přidána plná podpora window.injectVariables (OBJECT)  ← NOVÉ
 *     - Pokud chybí, stáhne FE-sova-settings.js a vyhodnotí v sandboxu
 *───────────────────────────────────────────────────────────────────────────*/
(function initRulesFE(ns){
let _currentData = null;  // { injectFunctions, features }
let _sourceInfo = null;

  const GITHUB_URL = 'https://raw.githubusercontent.com/Lukas-dotcom/sova/refs/heads/main/FE-sova-settings.js';

  // NOVÉ – robustní deep clone (rychlé při běžných objemech)
  function _deepClone(obj){
    try {
      if (typeof structuredClone === 'function') return structuredClone(obj);
      return JSON.parse(JSON.stringify(obj));
    } catch { return obj; }
  }

  function _fromInline(){
    if (!Array.isArray(window.injectFunctions)) return null;
    const injectFunctions = window.injectFunctions.slice();
    const features = Object.create(null);

    // nasbírej jen to, co dává smysl: pro každou funkci zkus stejnojmenný globální blok
    const names = [...new Set(injectFunctions.map(r=>(r?.function||'').trim()).filter(Boolean))];
    names.forEach(name=>{
      if (window[name] != null) {
        try { features[name] = _deepClone(window[name]); }
        catch { features[name] = window[name]; }
      }
    });

    // NOVÉ: injectVariables (objektový tvar)
    if (window.injectVariables && typeof window.injectVariables === 'object' && !Array.isArray(window.injectVariables)) {
      features.injectVariables = _deepClone(window.injectVariables);
    }

    return { injectFunctions, features, source:'inline', url:null };
  }

  async function _fromGithub(){
    const resp = await fetch(GITHUB_URL, { cache:'no-cache' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${GITHUB_URL}`);
    const code = await resp.text();

    // sandbox: nasimuluj "window" a přečti výsledky
    const fakeWin = {};
    const sandbox = Function('window','document','SOVA','"use strict";\n'+code+'\n;return window;');
    const outWin = sandbox(fakeWin, {}, ns);

    const injectFunctions = Array.isArray(outWin.injectFunctions) ? outWin.injectFunctions.slice() : [];
    const features = {};
    // vezmeme jen bloky, které odpovídají názvům funkcí
    const names = [...new Set(injectFunctions.map(r=>(r?.function||'').trim()).filter(Boolean))];
    names.forEach(n=>{ if(outWin[n]!=null) features[n] = outWin[n]; });

    // NOVÉ: injectVariables (objektový tvar i z GitHub settings)
    if (outWin.injectVariables && typeof outWin.injectVariables === 'object' && !Array.isArray(outWin.injectVariables)) {
      features.injectVariables = outWin.injectVariables;
    }

    return { injectFunctions, features, source:'github', url:GITHUB_URL };
  }

async function load(settingSource='FE'){
  // 1) Primárně z inline globálů
  let dataPack = _fromInline();

  // 2) Fallback: GitHub
  if (!dataPack || !Array.isArray(dataPack.injectFunctions) || dataPack.injectFunctions.length === 0){
    try {
      dataPack = await _fromGithub();
    } catch(e){
      console.error('[SOVA.rules.FE] GitHub fetch failed', e);
      dataPack = { injectFunctions:[], features:{}, source:'none', url:null };
    }
  }

  const now = Date.now();
  const data = { injectFunctions: dataPack.injectFunctions || [], features: dataPack.features || {} };

  _currentData = data;
  _sourceInfo  = { tsLoaded: now, source: dataPack.source, url: dataPack.url };

  ns.bus.emit('rules:ready', { source:_sourceInfo, settings:data });
  return data;
}


function rulesFor(featureName){
  if (!_currentData) return null;
  if (featureName === 'injectFunctions'){
    const rules = _currentData.injectFunctions || [];
    return { columns:null, rules };
  }
  return null;
}
function featureSettings(name){
  const via = _currentData?.features?.[name];
  if (via != null) return via;
  return window[name];
}
Object.defineProperty(ns, 'FE_settings', {
    get(){ return (_currentData?.features) || {}; }
  });

ns.rules = ns.rules || {};
  Object.assign(ns.rules, {
    load,                 // async funkce výše
    for: rulesFor,
    featureSettings,
    get sourceInfo(){ return _sourceInfo; }
  });
})(SOVA);

  /*───────────────────────────────────────────────────────────────────────────*
   * 5) injectFunctions (FE) – url → pageType → conditionsSOVAL → run fn
   *───────────────────────────────────────────────────────────────────────────*/
  ;(function initInjectFunctionsFE(ns){
    const TAG = '[injectFunctions:FE]';
    let didRun = false;

    const now = () => performance.now();
    const dur = t0 => `${(performance.now()-t0).toFixed(1)}ms`;
    const isTest = () => localStorage.getItem('SOVA.testSOVA.enabled') === '1' || !!document.getElementById('ruleTesterBox');
    const log = (...a) => { if (isTest()) console.log(TAG, ...a); };

    function pageTypeMatches(expected, ctxPage){
      if (!expected) return true;
      const want = String(expected).trim();
      return want === ctxPage;
    }

    function verboseUrlCheck(pattern){
      if (!pattern) return { ok:true };
      const ok = ns.url.match(pattern);
      return { ok, pattern };
    }

    async function runOncePerLoad(){
      if (didRun) return;
      didRun = true;

      const t0 = now();
      log('waiting for rules+context …');

      const waitRules = new Promise(res => {
        if (ns.rules?.sourceInfo) return res({ source: ns.rules.sourceInfo });
        ns.bus.once('rules:ready', res);
      });
      const waitCtx = new Promise(res => {
        try {
          const snap = ns.getContext?.snapshot?.() || {};
          if (Object.keys(snap).length) return res({ snapshot: snap });
        } catch {}
        ns.bus.once('context:ready', res);
      });

      const [{ source }, { snapshot:ctx }] = await Promise.all([waitRules, waitCtx]);
      log('ready → source:', source, 'ctx.pageType:', ctx?.pageType);

      const block = ns.rules.for('injectFunctions');
      if (!block || !Array.isArray(block.rules) || block.rules.length === 0){
        log('no injectFunctions rules – nothing to run');
        return;
      }

      for (let i=0;i<block.rules.length;i++){
        const rule = block.rules[i] || {};
        const rid  = rule.id || rule.name || `#${i+1}`;
        const fnName   = rule.function || rule.func || rule.fn;
        const urlSpec  = rule.url;
        const ptSpec   = rule.pageType;
        const cond     = rule.conditionsSOVAL || rule.condition || rule.when;
        const rawParams= rule.parameters;

        const label = `${TAG} rule ${rid} → ${fnName || '<?>'}`;
        if (!fnName || !ns.fn.has(fnName)){ log(label, 'SKIP (unknown function)'); continue; }

        // 1) URL
        const urlInfo = verboseUrlCheck(urlSpec);
        if (!urlInfo.ok){ log(label, 'SKIP (url mismatch)', urlSpec); continue; }

        // 2) pageType
        if (!pageTypeMatches(ptSpec, ctx?.pageType)){ log(label, 'SKIP (pageType mismatch)', ptSpec, '≠', ctx?.pageType); continue; }

        // 3) conditionsSOVAL
        let condOk = true;
        if (cond && String(cond).trim()){
          try { condOk = ns.calculateSOVAL.evalBool(String(cond), ctx, { debug: isTest() }); }
          catch(e){ console.error(TAG, 'conditionsSOVAL error:', cond, e); condOk = false; }
        }
        if (!condOk){ log(label, 'SKIP (conditionsSOVAL=false)'); continue; }

        // 4) parameters (SOVAL expand)
        let evalParams;
        try {
          evalParams = ns.calculateSOVAL.expandParams(rawParams, ctx, { debug: isTest() });
        } catch(e){
          console.error(TAG, 'parameters expand error', e);
          evalParams = rawParams;
        }

        // 5) feature-level settings (stejné jméno jako funkce)
        const featureCfg = ns.rules.featureSettings(fnName);

        try {
          const tRun = now();
          log(label, '→ RUN', { params: evalParams, featureCfg });
          await ns.fn.run(fnName, { params: evalParams, settings: featureCfg }, ctx);
          log(label, '← DONE', dur(tRun));
        } catch (e){
          console.error(label, 'rejected:', e);
        }
      }

      log('all rules processed in', dur(t0));
    }

    ns.injectFunctionsFE = { runOncePerLoad };

    // Auto attach
    try {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => runOncePerLoad());
      } else {
        runOncePerLoad();
      }
    } catch(e){ console.error(TAG, 'auto attach failed', e); }
  })(SOVA);

  /*───────────────────────────────────────────────────────────────────────────*
 * 6) Tester menu (admin bar) + lehký testSOVA UI (lze nahradit plným)
 *───────────────────────────────────────────────────────────────────────────*/
;(function initTesterMenuAndUI(){
  // --- Mini tester UI (lehčí; můžeš nahradit plným z BE 1:1) ---
  if (!window.testSOVA){
    window.testSOVA = function(){
      const id='ruleTesterBox';
      if (document.getElementById(id)) return;

      const box = document.createElement('div');
      box.innerHTML = `
<style>
  #ruleTesterBox{
    position:fixed;bottom:10px;left:10px; /* vlevo dole */
    z-index:999999;background:#222;color:#eee;
    padding:6px 8px;border-radius:6px;font:12px monospace;
    display:flex;gap:6px;align-items:flex-start;
    max-width:90vw;min-width:260px
  }
  #rtb{
    flex:1 1 auto;min-width:420px;max-width:640px;height:18px;
    overflow:hidden;resize:none;background:#333;border:1px solid #555;
    color:#eee;padding:3px 4px;border-radius:4px;line-height:1.35
  }
  #ruleTesterBox button{
    background:#0a6;border:none;color:#fff;font:12px monospace;
    padding:3px 8px;border-radius:4px;cursor:pointer;white-space:nowrap
  }
</style>
<div id="ruleTesterBox">
  <textarea id="rtb" placeholder='SOVAL výraz(y) – každý na vlastním řádku'></textarea>
  <button id="rtRun">testovat</button>
  <button id="rtVars">Proměnné</button>
  <button id="rtClose" title="Zavřít tester">×</button>
</div>`;

      document.body.appendChild(box);
      const $rtb   = box.querySelector('#rtb');
      const $run   = box.querySelector('#rtRun');
      const $vars  = box.querySelector('#rtVars');
      const $close = box.querySelector('#rtClose');

      const fit = el => { el.style.height='18px'; el.style.height = el.scrollHeight+'px'; };
      $rtb.addEventListener('input', ()=>fit($rtb));

      function runNow(){
        const ctx = window.SOVAL?.getContext?.snapshot?.() || {};
        const lines = $rtb.value.split('\n').map(s=>s.trim()).filter(Boolean);
        if(!lines.length){ alert('Zadej aspoň jeden výraz.'); return; }
        console.clear();
        lines.forEach((expr,i)=>{
          try{
            const fn = SOVA.calculateSOVAL.compile(expr, { debug:true });
            const ok = fn(ctx);
            console.log(`%c[${i+1}/${lines.length}] ${expr}  ⇒  ${ok}`, `color:${ok?'#0a0':'#d00'};font-weight:bold`);
          }catch(e){ console.error(`[${i+1}] chyba ve výrazu:`, expr, e); }
        });
      }

      $run.onclick = runNow;



      $vars.onclick = ()=>{
        const ctx = window.SOVAL?.getContext?.snapshot?.() || {};
        console.log('[SOVA ctx]', ctx);
        try{
          const flat = Object.entries(ctx).filter(([k,v]) => !(Array.isArray(v) && v.length && typeof v[0]==='object'));
          console.table(flat.map(([k,v])=>({k,v})));
        }catch{}
      };

      $rtb.addEventListener('keydown', e=>{ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); runNow(); } });

      $close.onclick = ()=> {
        try{
          // vypnout persistentní mód
          localStorage.setItem('SOVA.testSOVA.enabled','0');
          localStorage.removeItem('SOVA.testSOVA.enabled');
        }catch{}
        box.remove();
      };

      fit($rtb);
    };

    window.testSOVA_openPersistent = () => {
      try{ localStorage.setItem('SOVA.testSOVA.enabled','1'); }catch{}
      window.testSOVA();
    };
    window.testSOVA_closePersistent = () => {
      try{
        localStorage.setItem('SOVA.testSOVA.enabled','0');
        localStorage.removeItem('SOVA.testSOVA.enabled');
      }catch{}
      document.getElementById('ruleTesterBox')?.remove();
    };
  }

  // --- Vložení položky do admin bar menu ---
  function tryMountTesterMenu(){
    const bar = document.querySelector('.admin-bar #bar-menu');
    if (!bar) return false;
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = 'javascript:void(0)';
    a.textContent = 'SOVA tester';
    a.addEventListener('click', ()=> window.testSOVA_openPersistent(), false);
    li.appendChild(a);
    bar.appendChild(li);
    return true;
  }
  if (!tryMountTesterMenu()){
    const mo = new MutationObserver(()=>{ if (tryMountTesterMenu()) mo.disconnect(); });
    mo.observe(document.documentElement || document.body, { childList:true, subtree:true });
  }

  // Auto-open tester po reloadu, pokud je zapnutý persistentní režim
  try {
    if (localStorage.getItem('SOVA.testSOVA.enabled') === '1') {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => window.testSOVA());
      } else {
        setTimeout(() => window.testSOVA(), 0);
      }
    }
  } catch {}
})();

  /*───────────────────────────────────────────────────────────────────────────*
   * 7) BOOT – načíst FE rules ASAP a vystavit globály
   *───────────────────────────────────────────────────────────────────────────*/
  ;(function bootFE(){
    try{
      if (document.readyState === 'loading'){
        document.addEventListener('DOMContentLoaded', () => {
          SOVA.rules.load('FE').catch(e => console.error('[SOVA.rules.FE.load]', e));
        });
      } else {
        SOVA.rules.load('FE').catch(e => console.error('[SOVA.rules.FE.load]', e));
      }
    }catch(e){ console.error('[BOOT:FE] rules.load init failed', e); }

    // Expose (bez přepisu)
    const root = window, ns = (root.SOVA = root.SOVA || {});
    const ensure = (name, value) => {
      try { if (root[name] === undefined || root[name] === value) Object.defineProperty(root, name, { value, writable:false, configurable:true }); }
      catch { if (root[name] === undefined) root[name] = value; }
    };
    ensure('calculateSOVAL', ns.calculateSOVAL);
    ensure('getContext',     ns.getContext);
    ensure('rules',          ns.rules);
    ensure('url',            ns.url);
    ensure('bus',            ns.bus);
    ensure('fn',             ns.fn);

    root.SOVA_rules = ns.rules;
    root.SOVA_url   = ns.url;
    root.SOVA_fn    = ns.fn;
    root.SOVA_calculate = ns.calculateSOVAL;
  })();

  /*───────────────────────────────────────────────────────────────────────────*
   * 8) Registrace ukázkových funkcí (stub) – jen pro kouknutí do logu
   *    (reálné implementace doplníme později)
   *───────────────────────────────────────────────────────────────────────────*/
  ;(function registerExampleFns(ns){
    if (!ns?.fn) return;
    ns.fn.register('additionalSale', ({ params, settings }, ctx) => {
      if (localStorage.getItem('SOVA.testSOVA.enabled')==='1'){
        console.group('[additionalSale]'); console.log('params:', params); console.log('settings:', settings); console.log('ctx.pageType:', ctx?.pageType); console.groupEnd();
      }
      // TODO: implementace
    });
    ns.fn.register('deliveryOptions', ({ params, settings }, ctx) => {
      if (localStorage.getItem('SOVA.testSOVA.enabled')==='1'){
        console.group('[deliveryOptions]'); console.log('params:', params); console.log('settings:', settings); console.log('ctx.pageType:', ctx?.pageType); console.groupEnd();
      }
      // TODO: implementace
    });
  })(SOVA);

/*───────────────────────────────────────────────────────────────────────────*
 * 8a) testovaciInjectFunction – samoregistrace (po vzoru BE)
 *───────────────────────────────────────────────────────────────────────────*/
(function registerTestovaciInjectFunction(ns){
  if (!ns?.fn) return;

  // jednorázové vložení stylů + kontejneru
  function ensureBannerHost(){
    if (document.getElementById('sova-test-banners')) return;
    const style = document.createElement('style');
    style.id = 'sova-test-banners-style';
    style.textContent = `
      #sova-test-banners{
        position: fixed; bottom: 12px; right: 12px; z-index: 2147483647;
        display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
        pointer-events: none;
      }
      .sova-test-banner{
        pointer-events: auto;
        background: #111; color: #fff; border: 1px solid #444; border-radius: 8px;
        box-shadow: 0 6px 18px rgba(0,0,0,.35);
        padding: 10px 12px 10px 12px; max-width: 420px; font: 13px/1.45 system-ui, sans-serif;
        display: flex; align-items: flex-start; gap: 8px;
      }
      .sova-test-banner .sova-close{
        margin-left: 8px; cursor: pointer; border: 0; background: transparent; color: #bbb;
        font: 16px/1 system-ui, sans-serif; padding: 0 2px; border-radius: 4px;
      }
      .sova-test-banner .sova-close:hover{ color: #fff; background: #333; }
      .sova-test-banner .sova-text{ white-space: pre-wrap; }
    `;
    document.head.appendChild(style);

    const host = document.createElement('div');
    host.id = 'sova-test-banners';
    document.body.appendChild(host);
  }

  function pushBanner(message){
    ensureBannerHost();
    const host = document.getElementById('sova-test-banners');

    const box  = document.createElement('div');
    box.className = 'sova-test-banner';

    const text = document.createElement('div');
    text.className = 'sova-text';
    text.textContent = String(message ?? ''); // čistý text (ne HTML)

    const btn  = document.createElement('button');
    btn.className = 'sova-close';
    btn.type = 'button';
    btn.title = 'Zavřít';
    btn.textContent = '×';
    btn.addEventListener('click', ()=> box.remove(), { passive:true });

    box.appendChild(text);
    box.appendChild(btn);
    host.appendChild(box); // „pod sebe“ – každý nový je pod předchozím
  }

  // vlastní injekční funkce
  function testovaciInjectFunction({ params, settings }, ctx){
    // `params` může být string, nebo objekt { text: ... } – oboje podporujeme
    const msg = (params && typeof params === 'object') ? params.text ?? params.message ?? params.msg : params;
    const finalText = (msg == null || msg === '') ? 'Funguje' : String(msg);
    pushBanner(finalText);
    return true;
  }

  ns.fn.register('testovaciInjectFunction', testovaciInjectFunction);
})(SOVA);


/*───────────────────────────────────────────────────────────────────────────*
 * additionalSale – FE injekční funkce (s rozšířeným debug logem)
 *  - čte window.additionalSale (nebo SOVA.rules.featureSettings('additionalSale'))
 *  - filtruje pomocí SOVAL (bez aliasů)
 *  - renderuje 1:1 UI (#dvDoplUpgr) – checkboxy + selecty
 *  - exkluze checkboxů podle pairText (stejný pair = vždy jen 1)
 *  - po přidání hlavního produktu dopřidá vybrané kódy přes shoptet.cartShared.addToCart
 *  - DEBUG: pokud localStorage['SOVA.testSOVA.enabled'] === '1', loguje krok po kroku
 *───────────────────────────────────────────────────────────────────────────*/
/*───────────────────────────────────────────────────────────────────────────*
 * additionalSale – FE injekční funkce (lepší logování SOVAL + fail-safe)
 *───────────────────────────────────────────────────────────────────────────*/
(function registerAdditionalSale(ns){
  if (!ns?.fn) return;

  const TAG = '[additionalSale]';
  const isTest = () => localStorage.getItem('SOVA.testSOVA.enabled') === '1';

  // Bezpečné escapování pro HTML
  const esc = (s)=> String(s??'')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

  // Slug (skupiny párů/selectů, popup triggry)
  const slug = (s)=> String(s||'')
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^A-Za-z0-9]+/g,'_').replace(/^_+|_+$/g,'')
    .toLowerCase();

  function buildCheckboxRow(it){
    const groupSlug = slug(it.pairText||it.name||'grp');
    const id = 'doplnek_' + groupSlug;
    const name = esc(it.name||'');
    const code = esc(it.code||'');
    const priceTxt = ' +' + esc(String(it.price ?? ''));
    const trig = groupSlug;
    return `<tr>
  <td><label><input type="checkbox" class="doplnekUprade" id="${id}" value="${code}" data-pair="${trig}">${name} </label> <span class="trigger-${trig} fv-lazy-visible fv-info-popup-target" data-popup-trigger="${trig}" title="" data-original-title="Zjistit více..."></span></td>
  <td>${priceTxt}</td>
</tr>`;
  }

  function buildSelectRow(title, groupSlug, options){
    const head = esc(title||'');
    const selId = groupSlug; // pouze slug bez prefixů
    const trig = groupSlug;
    const opts = ['<option value="">vyberte variantu</option>']
      .concat(options.map(o=> `<option value="${esc(o.code||'')}">${esc(o.name||'')} +${esc(String(o.price ?? ''))}</option>`))
      .join('');
    return `<tr>
  <td>${head} <span class="trigger-${trig} fv-lazy-visible fv-info-popup-target" data-popup-trigger="${trig}" title="" data-original-title="Zjistit více..."></span></td>
  <td><select class="doplnekUprade" id="${selId}">${opts}</select></td>
</tr>`;
  }

  function mountUI(items){
    const anchor = document.querySelector('.availability-value');
    if (!anchor) {
      if (isTest()) console.warn(TAG, 'anchor .availability-value not found – UI not mounted');
      return;
    }

    // idempotentní render
    document.getElementById('dvDoplUpgr')?.remove();
    document.querySelector('.dvCenDph')?.remove();

    // Rozdělení: checkbox vs select (pořadí zachováno)
    const checkboxRows = [];
    const selectGroups = new Map(); // slug → { title, slug, items: [] }
    const selectOrder  = [];        // pořadí skupin dle prvního výskytu

    items.forEach(it=>{
      const t = (it.type||'').toLowerCase().trim();
      if (t === 'select'){
        const s = slug(it.pairText||'select');
        if (!selectGroups.has(s)){
          selectGroups.set(s, { title: it.pairText||'', slug:s, items: [] });
          selectOrder.push(s);
        }
        selectGroups.get(s).items.push({ code: it.code, name: it.name, price: it.price });
      } else {
        // default: checkbox
        checkboxRows.push(buildCheckboxRow(it));
      }
    });

    if (isTest()){
      console.groupCollapsed(TAG, 'mount UI');
      console.log('checkbox count:', checkboxRows.length);
      console.log('select groups:', selectOrder.slice());
      selectOrder.forEach(key=>{
        const grp = selectGroups.get(key);
        console.log(` - group "${key}" items:`, grp?.items?.length||0, grp);
      });
      console.groupEnd();
    }

    const wrap = document.createElement('div');
    wrap.id = 'dvDoplUpgr';

    if (checkboxRows.length){
      const d = document.createElement('div');
      d.id = 'dvDoplnky';
      d.innerHTML = `<h2>Doplňkové služby</h2><table class="tblTypcena">${checkboxRows.join('')}</table>`;
      wrap.appendChild(d);
    }

    if (selectOrder.length){
      const u = document.createElement('div');
      u.id = 'dvUpgr';
      let rows = '';
      selectOrder.forEach(key=>{
        const grp = selectGroups.get(key);
        if (grp?.items?.length){
          rows += buildSelectRow(grp.title, grp.slug, grp.items);
        }
      });
      if (rows){
        u.innerHTML = `<h2>Upgrade zařízení</h2><table class="tblTypselect">${rows}</table>`;
        wrap.appendChild(u);
      }
    }

    anchor.parentNode.insertBefore(wrap, anchor);

    // Poznámka pod tabulkami
    const note = document.createElement('div');
    note.className = 'dvCenDph';
    note.textContent = '(Ceny upgradů a doplňkových služeb jsou uvedeny s DPH)';
    wrap.insertAdjacentElement('afterend', note);

    // Exkluze checkboxů se stejným pairText (slugem)
    wrap.addEventListener('change', (e)=>{
      const t = e.target;
      if (t && t.matches('input[type="checkbox"].doplnekUprade')){
        const grp = t.getAttribute('data-pair');
        if (grp){
          if (isTest()){
            console.log(TAG, 'pair exclusive change', { group: grp, id: t.id, checked: t.checked });
          }
          wrap.querySelectorAll(`input[type="checkbox"].doplnekUprade[data-pair="${grp}"]`).forEach(cb=>{
            if (cb !== t) cb.checked = false;
          });
        }
      }
    }, true);
  }

  function gatherSelectedCodes(){
    const root = document.getElementById('dvDoplUpgr');
    if (!root) return [];
    const out = [];
    root.querySelectorAll('input[type="checkbox"].doplnekUprade:checked').forEach(cb=>{
      const v = cb.value; if (v) out.push(v);
    });
    root.querySelectorAll('select.doplnekUprade').forEach(sel=>{
      const v = sel.value; if (v) out.push(v);
    });
    return out;
  }

  // Řetězení doplňků po přidání hlavní položky
  let formSubmitted = false;
  let addingExtras  = false;
  function hookAddFlow(){
    const form = document.querySelector('form#product-detail-form');
    if (form){
      form.addEventListener('submit', ()=>{
        formSubmitted = true;
        if (isTest()) console.log(TAG, 'form submit → will try add extras after main item');
      }, true);
    }
    document.addEventListener('ShoptetCartAddCartItem', ()=>{
      if (!formSubmitted || addingExtras) return;
      const codes = gatherSelectedCodes();
      if (isTest()){
        console.log(TAG, 'ShoptetCartAddCartItem', { formSubmitted, addingExtras, selectedCodes: codes.slice() });
      }
      if (!codes.length){ formSubmitted = false; return; }

      const amount = parseInt(document.querySelector('form#product-detail-form input[name="amount"]')?.value||'1',10) || 1;
      addingExtras = true;

      let i = 0;
      const addNext = ()=>{
        if (i >= codes.length){
          addingExtras = false;
          formSubmitted = false;
          if (isTest()) console.log(TAG, 'done adding extras');
          return;
        }
        const code = codes[i++];
        try {
          if (isTest()) console.log(TAG, 'add extra', { idx: i, code, amount });
          shoptet.cartShared.addToCart({ productCode: code, amount }, true);
        } catch(e){
          console.error(TAG, 'addToCart failed', code, e);
        }
        setTimeout(addNext, 350);
      };
      addNext();
    }, true);
  }

  // ─── Pomocné „lint“ tipy k SOVALu (rychlá heuristika) ────────────────────
  function lintSoval(cond){
    const tips = [];
    const open = (cond.match(/\(/g)||[]).length;
    const close= (cond.match(/\)/g)||[]).length;
    if (open !== close) tips.push(`Nevyvážené závorky: "("=${open} vs ")"=${close}`);
    const dq = (cond.match(/(?<!\\)"/g)||[]).length; // jednoduchý odhad
    const sq = (cond.match(/(?<!\\)'/g)||[]).length;
    if (dq % 2 === 1) tips.push('Nesudý počet dvojitých uvozovek (")');
    if (sq % 2 === 1) tips.push("Nesudý počet jednoduchých uvozovek (')");
    if (/[^!<>=]\s+=\s+[^=]/.test(cond)) tips.push('Rovná se (=) mimo funkci? V SOVALu je "=" operátor equals.');
    return tips;
  }

  async function additionalSale({ params, settings }, ctx){
    try{
      // Načtení settings (priorita: featureSettings → window.additionalSale)
      let cfg = [];
      let source = 'none';
      if (Array.isArray(settings)) { cfg = settings; source = 'featureSettings'; }
      else if (Array.isArray(window.additionalSale)) { cfg = window.additionalSale; source = 'window.additionalSale'; }

      if (isTest()){
        console.groupCollapsed(TAG, 'init');
        console.log('source:', source, 'count:', cfg.length);
        console.log('ctx keys:', Object.keys(ctx||{}));
        console.groupEnd();
      }
      if (!cfg.length) { if(isTest()) console.log(TAG,'no settings'); return; }

      const TEST = isTest();
      const DEEP_DEBUG = TEST && localStorage.getItem('SOVA.testSOVA.deep') === '1';
      const CHUNK_SIZE = Math.max(0, parseInt(localStorage.getItem('SOVA.testSOVA.chunk') || '0', 10));

      // Bezpečná kompilace – nevalidní pravidlo zaloguju a označím jako false
      const compiled = new Array(cfg.length).fill(null);
      const compileErrors = [];

      cfg.forEach((it, idx) => {
        const cond = (typeof it.SOVAL === 'string') ? it.SOVAL.trim() : '';
        if (!cond) return;
        try{
          compiled[idx] = ns.calculateSOVAL.compile(cond, { debug:false });
        }catch(e){
          const rid = it.id ?? it.name ?? it.code ?? `#${idx+1}`;
          const tips = lintSoval(cond);
          if (TEST){
            console.groupCollapsed(`${TAG} SOVAL syntax error in rule ${rid}`);
            console.error(e);
            console.log('SOVAL:', cond);
            if (tips.length) console.log('hints:', tips);
            console.log('rule object:', it);
            console.groupEnd();
          } else {
            console.warn(`${TAG} SOVAL syntax error in rule ${rid}:`, e?.message||e);
          }
          compileErrors.push({ idx, rule: rid, message: e?.message||String(e), SOVAL: cond });
          compiled[idx] = null; // → bude vyhodnoceno jako false
        }
      });

      if (TEST && compileErrors.length){
        console.groupCollapsed(TAG, `compile errors (${compileErrors.length})`);
        try { console.table(compileErrors); } catch { console.log(compileErrors); }
        console.groupEnd();
      }

      const eligible  = [];
      const debugRows = [];

      const evalOne = (it, idx) => {
        const cond = (typeof it.SOVAL === 'string') ? it.SOVAL.trim() : '';
        const meta = {
          idx,
          type: it.type || 'checkbox',
          pairText: it.pairText || '',
          code: it.code || '',
          name: it.name || '',
          price: String(it.price ?? '')
        };

        // Pokud kompilace selhala → false (a důvod)
        if (cond && !compiled[idx]){
          debugRows.push({ ok:false, reason:'compile-error', ...meta, SOVAL: cond, took: 0 });
          return; // nepushujeme
        }

        let ok = true, t0, took = 0;
        if (cond && compiled[idx]) {
          t0 = performance.now();
          try {
            ok = !!compiled[idx](ctx);
          } catch (e) {
            ok = false;
            if (TEST) console.warn(TAG, `SOVAL runtime error @#${idx}`, e);
          }
          took = performance.now() - t0;

          if (DEEP_DEBUG && ok) {
            try { ns.calculateSOVAL.evalBool(cond, ctx, { debug:true }); }
            catch (e){ if (TEST) console.warn(TAG, `deep debug failed @#${idx}`, e); }
          }
        }

        debugRows.push({ ok, reason: ok?'':'runtime-error', ...meta, SOVAL: cond, took: +took.toFixed(2) });
        if (ok) eligible.push(it);
      };

      if (CHUNK_SIZE > 0) {
        for (let i = 0; i < cfg.length; i += CHUNK_SIZE) {
          const end = Math.min(i + CHUNK_SIZE, cfg.length);
          for (let j = i; j < end; j++) evalOne(cfg[j], j);
          await new Promise(requestAnimationFrame);
        }
      } else {
        for (let i = 0; i < cfg.length; i++) evalOne(cfg[i], i);
      }

      if (TEST) {
        console.groupCollapsed(TAG, `summary • eligible ${eligible.length}/${cfg.length}`);
        try { console.table(debugRows); } catch { console.log(debugRows); }
        console.groupEnd();
      }

      // render + hooky
      mountUI(eligible);
      hookAddFlow();

      if (TEST){
        console.groupCollapsed(TAG, 'rendered items');
        try {
          console.table(eligible.map(x=>({
            type:x.type,
            pairText:x.pairText,
            code:x.code,
            name:x.name,
            price:String(x.price),
            SOVAL:x.SOVAL||''
          })));
        } catch { console.log(eligible); }
        console.groupEnd();
      }
    }catch(e){
      console.error(TAG, 'failed', e);
    }
  }

  ns.fn.register('additionalSale', additionalSale);
})(SOVA);

/*───────────────────────────────────────────────────────────────────────────*
 * additionalSaleCart – upsell v košíku (FAST, no-mute + mobile grid cell)
 *  + safe SOVAL debug (kompilace s try/catch, skip invalid, cache)
 *───────────────────────────────────────────────────────────────────────────*/
(function registerAdditionalSaleCart(ns){
  if (!ns?.fn) return;
  if (window.__SOVA_additionalSaleCart_initialized) return;
  window.__SOVA_additionalSaleCart_initialized = true;

  const TAG  = '[additionalSaleCart]';
  const TEST = () => localStorage.getItem('SOVA.testSOVA.enabled') === '1';
  const DEEP = () => TEST() && localStorage.getItem('SOVA.testSOVA.deep') === '1';
  const now  = () => (performance && performance.now ? performance.now() : Date.now());
  const isMobile = () => window.matchMedia && window.matchMedia('(max-width: 767.98px)').matches;

  /* CSS (jen jednou) */
  function ensureCartCSS(){
    if (document.getElementById('sova-upsell-cart-css')) return;
    const el = document.createElement('style');
    el.id = 'sova-upsell-cart-css';
    el.textContent = `
/* Desktop/tablet default */
td.p-name .sova-upsell, td.p-name .sova-upsell-select{ margin-top:6px; padding:0; border:0; background:none; font:inherit; }
td.p-name .sova-upsell-row{ display:grid; grid-template-columns:auto 1fr auto; align-items:center; width:100%; line-height:1.2; border:0; margin:0; padding:0 0 0 10px; gap:0; }
td.p-name .sova-upsell-row + .sova-upsell-row{ margin-top:0; }
td.p-name .sova-upsell-row input[type="checkbox"]{
  appearance:auto !important; -webkit-appearance:auto !important;
  position:static !important; opacity:1 !important; visibility:visible !important;
  width:auto !important; height:auto !important; margin:0 5px 0 0 !important; transform:none !important;
}
td.p-name .sova-upsell label{ margin:0; padding:0; font-weight:400; border:0; }
td.p-name .sova-upsell .sova-upsell-row__text{ display:inline-flex; align-items:center; gap:6px; margin:0; padding:0; }
td.p-name .sova-upsell .fv-info-popup-target{ margin-left:6px; border:0; }
td.p-name .sova-upsell-row__price{ justify-self:end; text-align:right; white-space:nowrap; font-weight:600; margin-right:30px; }
td.p-name .sova-upsell-select{ margin-top:6px; padding:0; border:0; background:none; font:inherit; }
td.p-name .sova-upsell-select-row{ display:grid; grid-template-columns:auto 1fr; align-items:center; gap:0 8px; padding:0 0 0 10px; margin:0; border:0; line-height:1.2; width:100%; }
td.p-name .sova-upsell-select-row + .sova-upsell-select-row{ margin-top:0; }
td.p-name .sova-upsell-select-row label{ margin:0; padding:0; font-weight:400; border:0; white-space:nowrap; }
td.p-name .sova-upsell-select-row select{ width:100%; min-width:160px; margin:0; padding:2px 8px; border:0 !important; background:none; font:inherit; line-height:1.2; -webkit-appearance:menulist; appearance:menulist; }

/* ── MOBILE (<= 767.98px): vlastní grid area + flex řádky) ─────────────── */
@media (max-width: 767.98px) {
  .cart-inner tr[data-micro="cartItem"] {
    grid-template-areas:
      "img name name"
      "img availability quantity"
      "img price-p price"
      "sova sova sova" !important;
  }
  .cart-inner tr[data-micro="cartItem"] .sova-upsell-cell {
    grid-area: sova !important;
    grid-column: 1 / -1 !important;
  }
  .sova-upsell-row {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    padding: .4rem .65rem;
    border: .0625rem solid var(--color-primary);
    border-radius: 5px;
    margin-bottom: .4rem;
    gap: .5rem;
  }
  .sova-upsell-row__text { flex: 1; text-align: left; }
  .sova-upsell__checkbox {
    -webkit-appearance: auto !important;
    position: static !important;
    opacity: 1 !important;
    visibility: visible !important;
    width: auto !important;
    height: auto !important;
    margin: 0 5px 0 0 !important;
    transform: none !important;
  }
}
`;
    document.head.appendChild(el);
  }

  /* helpers */
  const esc  = (s)=> String(s??'')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

  const slug = (s)=> String(s||'')
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^A-Za-z0-9]+/g,'_').replace(/^_+|_+$/g,'')
    .toLowerCase();

  const codeExists = (rows, code) => (rows||[]).some(r => r?.code === code);

  function buildCheckboxRow(it, ownerId){
    const groupSlug = slug(it.pairText||it.name||'grp');
    const id   = `doplnek_${groupSlug}_${ownerId}`;
    const name = esc(it.name||'');
    const code = esc(it.code||'');
    const priceTxt = ' +' + esc(String(it.price ?? ''));
    const trig = groupSlug;
    return `<label class="sova-upsell-row">
      <input type="checkbox" class="sova-upsell__checkbox doplnekUprade" id="${id}" value="${code}" data-pair="${trig}">
      <span class="sova-upsell-row__text">
        ${name}
        <span class="trigger-${trig} fv-lazy-visible fv-info-popup-target" data-popup-trigger="${trig}" title="" data-original-title="Zjistit více..."></span>
      </span>
      <span class="sova-upsell-row__price">${priceTxt}</span>
    </label>`;
  }

  function buildSelectBlock(title, groupSlug, options, ownerId){
    const head = esc(title||'');
    const selId = `${groupSlug}_${ownerId}`;
    const opts = ['<option value="">vyberte variantu</option>']
      .concat(options.map(o => `<option value="${esc(o.code||'')}">${esc(o.name||'')} +${esc(String(o.price ?? ''))}</option>`))
      .join('');
    return `<div class="sova-upsell-select">
      <div class="sova-upsell-select-row">
        <label for="${selId}">${head}</label>
        <select class="sova-upsell__select doplnekUprade" id="${selId}" data-pair="${groupSlug}">${opts}</select>
      </div>
    </div>`;
  }

  /* ─── NO-MUTE transaction gate ─────────────────────────────────────────── */
  let renderQueued = false;
  const op = {
    active: false,
    lastEventTs: 0,
    idleTimer: 0,
    safetyTimer: 0,
    cleanup: null
  };

  function beginOp(label){
    if (TEST()) console.log(TAG, 'op begin →', label);
    op.active = true;
    op.lastEventTs = 0;
    clearTimeout(op.idleTimer);
    clearTimeout(op.safetyTimer);

    const onUpdated = () => {
      op.lastEventTs = Date.now();
      clearTimeout(op.idleTimer);
      op.idleTimer = setTimeout(()=> finishOp('idle'), 160);
    };

    document.addEventListener('ShoptetCartUpdated', onUpdated, true);
    document.addEventListener('shoptet:cart:updated', onUpdated, true);

    op.cleanup = () => {
      document.removeEventListener('ShoptetCartUpdated', onUpdated, true);
      document.removeEventListener('shoptet:cart:updated', onUpdated, true);
    };

    op.safetyTimer = setTimeout(()=> finishOp('safety'), 1800);
  }

  function finishOp(reason){
    if (!op.active) return;
    if (TEST()) console.log(TAG, 'op finish ←', reason);
    op.cleanup && op.cleanup();
    clearTimeout(op.idleTimer);
    clearTimeout(op.safetyTimer);
    op.active = false;
    scheduleRender('op-done');
  }

  function scheduleRender(reason){
    if (op.active && reason !== 'op-done'){
      if (TEST()) console.log(TAG, 'render deferred (op active):', reason);
      return;
    }
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; doRender(); });
  }

  /* ─── cart operace (bez mute) ──────────────────────────────────────────── */
  function addByCode(code, amount){
    if (!code || !amount) return;
    TEST() && console.log(TAG,'addByCode', {code, amount});
    beginOp('add ' + code);
    try{
      if (window.shoptet?.cartShared?.addToCart){
        window.shoptet.cartShared.addToCart({ productCode: code, amount }, true);
        return;
      }
    }catch(e){ console.warn(TAG,'cartShared.addToCart failed',e); }
    try{
      if (window.jQuery){
        window.jQuery.post('/action/Cart/addCartItem/?simple_ajax_cart=1', {
          productCode: code, amount, __csrf__: (window.shoptet?.csrf?.token || '')
        }).always(()=> finishOp('ajax'));
      }
    }catch(e){ console.error(TAG,'AJAX add failed', e); finishOp('ajax-error'); }
  }

  function removeAllByCode(code){
    if (!code) return;
    try{
      const ctx = ns.getContext?.snapshot?.() || {};
      const rows = Array.isArray(ctx.cartItemsExtended) ? ctx.cartItemsExtended : [];
      const targets = rows.filter(r => r?.code === code && r?.itemId);

      TEST() && console.log(TAG,'removeAllByCode(itemId)', { code, found: targets.length });
      beginOp('remove ' + code);

      if (!targets.length){
        try{
          if (window.shoptet?.cartShared?.removeFromCart){
            window.shoptet.cartShared.removeFromCart({ productCode: code });
            return;
          }
        }catch(e){ console.warn(TAG,'fallback remove by productCode failed', e); finishOp('fallback-error'); }
        return;
      }

      let i = 0;
      const step = () => {
        const hit = targets[i++];
        if (!hit){ return; }
        try {
          if (TEST()) console.log(TAG,'Remove by itemId:', hit.itemId, hit.name);
          shoptet.cartShared.removeFromCart({ itemId: hit.itemId });
        } catch(e){
          console.warn(TAG,'removeFromCart(itemId) failed', hit.itemId, e);
        }
        setTimeout(step, 60);
      };
      step();
    }catch(e){
      console.error(TAG,'removeAllByCode error', e);
      finishOp('exception');
    }
  }

  /* ─── SOVAL per řádek (SAFE compile + debug) ───────────────────────────── */
  const compiledCache = new Map(); // key: cond string → { fn|null, err|null, ms:number }
  function getCompiled(cond){
    const key = String(cond||'');
    if (compiledCache.has(key)) return compiledCache.get(key);
    let rec;
    const t0 = now();
    try{
      const fn = ns.calculateSOVAL.compile(key, { debug:false });
      rec = { fn, err: null, ms: now()-t0 };
    }catch(err){
      rec = { fn: null, err, ms: now()-t0 };
    }
    compiledCache.set(key, rec);
    return rec;
  }

  function ctxForRow(row, baseCtx){
    return Object.assign({}, baseCtx, {
      row,
      currentItem: row,
      code: row?.code,
      name: row?.name,
      productName: row?.name,
      priceWithVat: row?.priceWithVat,
      productPriceWithVat: row?.priceWithVat,
      URL: row?.URL || row?.url || '',
      url: row?.URL || row?.url || '',
      zarVylouceneCastiNazvu:
        (Array.isArray(baseCtx?.zarVylouceneCastiNazvu) && baseCtx.zarVylouceneCastiNazvu) ||
        (Array.isArray(window.injectVariables?.zarVylouceneCastiNazvu) && window.injectVariables.zarVylouceneCastiNazvu) ||
        []
    });
  }

  function decideUpsellsForRow(row, baseCtx, rules){
    const rowCtx = ctxForRow(row, baseCtx);
    const eligible  = [];
    const debugRows = [];

    for (let i=0;i<rules.length;i++){
      const rule = rules[i] || {};
      const condRaw = (typeof rule.SOVAL === 'string') ? rule.SOVAL.trim() : '';
      const meta = {
        idx: i,
        type: rule.type || 'checkbox',
        pairText: rule.pairText || '',
        code: rule.code || '',
        name: rule.name || '',
        price: String(rule.price ?? '')
      };

      // prázdný výraz = true (zpětná kompatibilita)
      if (!condRaw){
        debugRows.push({ ok:true, ...meta, SOVAL:'<empty>', compileMs:0, evalMs:0 });
        eligible.push(rule);
        continue;
      }

      // bezpečná kompilace
      const comp = getCompiled(condRaw);
      if (comp.err){
        if (TEST()) console.error(`${TAG} SOVAL compile error @#${i}`, comp.err, '\n', condRaw);
        debugRows.push({ ok:false, ...meta, SOVAL:condRaw, compileErr:String(comp.err?.message||comp.err), compileMs:+comp.ms.toFixed(2), evalMs:0 });
        continue; // neplatné pravidlo → přeskočit
      }

      // vyhodnocení
      let ok = true, took = 0;
      const t1 = now();
      try { ok = !!comp.fn(rowCtx); }
      catch(e){ ok = false; if (TEST()) console.warn(TAG,'SOVAL eval error @#'+i, e, '\n', condRaw); }
      took = now() - t1;

      // volitelný deep strom (drahé) jen když projde a je zapnutý
      if (DEEP && ok){
        try {
          console.groupCollapsed(`${TAG} rule #${i} → ${ok} ${took.toFixed(1)}ms`);
          console.log(condRaw);
          ns.calculateSOVAL.evalBool(condRaw, rowCtx, { debug:true });
          console.groupEnd();
        } catch(e){
          console.warn(TAG,'deep debug failed', e);
        }
      } else if (TEST()) {
        console.log(`${TAG} rule #${i} → ${ok} ${took.toFixed(1)}ms`, '\n', condRaw);
      }

      debugRows.push({ ok, ...meta, SOVAL:condRaw, compileMs:+comp.ms.toFixed(2), evalMs:+took.toFixed(2) });
      if (ok) eligible.push(rule);
    }

    if (TEST()){
      try{
        console.groupCollapsed(`${TAG} rules summary • row ${row?.code||'?'} (${row?.name||''})  —  ${eligible.length}/${rules.length}`);
        console.table(debugRows);
        console.groupEnd();
      }catch{
        console.log(TAG, 'summary', debugRows);
      }
    }
    return eligible;
  }

  function collectUpsellCodesFromSettings(cfg){
    const set = new Set();
    (cfg||[]).forEach(it=>{
      if (it?.code) set.add(String(it.code));
      if (it?.type?.toLowerCase() === 'select' && Array.isArray(it.options)){
        it.options.forEach(o => { if (o?.code) set.add(String(o.code)); });
      }
    });
    return set;
  }

  /* ─── mount do buňky/řádku (desktop vs mobile) ────────────────────────── */
  function mountIntoRowCell(cell, upsellItems, cartRows, baseRow){
    if (!cell) return;

    // smazat staré v cíli (desktop buňka)
    cell.querySelectorAll('.sova-upsell,.sova-upsell-select').forEach(n=>n.remove());
    // smazat případný mobilní cell v rámci stejného řádku
    const tr = cell.closest('tr');
    tr?.querySelectorAll('.sova-upsell-cell .sova-upsell,.sova-upsell-cell .sova-upsell-select').forEach(n=>n.remove());

    if (!upsellItems || !upsellItems.length) return;

    const ownerId = baseRow?.itemId || baseRow?.code || 'row';
    const box = document.createElement('div');
    box.className = 'sova-upsell';
    box.dataset.owner = ownerId;

    const checkboxRows = [];
    const selectGroups = new Map();
    const selectOrder  = [];

    upsellItems.forEach(it=>{
      const t = (it.type||'checkbox').toLowerCase().trim();
      if (t === 'select'){
        const key = slug(it.pairText||'select');
        if (!selectGroups.has(key)){
          selectGroups.set(key, { title: it.pairText||'', slug:key, items: [] });
          selectOrder.push(key);
        }
        selectGroups.get(key).items.push({ code: it.code, name: it.name, price: it.price });
      } else {
        checkboxRows.push(buildCheckboxRow(it, ownerId));
      }
    });

    const parts = [];
    if (checkboxRows.length) parts.push(checkboxRows.join(''));
    if (selectOrder.length){
      selectOrder.forEach(key=>{
        const grp = selectGroups.get(key);
        if (grp?.items?.length) parts.push( buildSelectBlock(grp.title, grp.slug, grp.items, ownerId) );
      });
    }
    box.innerHTML = parts.join('');

    // DOM umístění: mobile → vlastní TD (grid area 'sova'), jinak za <a.main-link>
    if (isMobile()){
      let upsellCell = tr?.querySelector('.sova-upsell-cell');
      if (!upsellCell){
        upsellCell = document.createElement('td');
        upsellCell.className = 'sova-upsell-cell';
        tr?.appendChild(upsellCell);
      } else {
        upsellCell.innerHTML = '';
      }
      upsellCell.appendChild(box);
    } else {
      const anchor = cell.querySelector('a.main-link[data-testid="cartProductName"]') || cell.querySelector('a.main-link');
      if (anchor) anchor.insertAdjacentElement('afterend', box);
      else cell.appendChild(box);
    }

    // init checked / select
    box.querySelectorAll('input.sova-upsell__checkbox').forEach(cb=>{
      const exists = codeExists(cartRows, cb.value);
      cb.checked = exists;
      TEST() && console.log(TAG,'init checkbox', { owner: ownerId, code: cb.value, checked: exists });
    });
    box.querySelectorAll('select.sova-upsell__select').forEach(sel=>{
      let chosen = '';
      [...sel.options].forEach(o => { if (o.value && codeExists(cartRows, o.value)) chosen = o.value; });
      sel.value = chosen;
      sel.dataset.prev = chosen || '';
      TEST() && console.log(TAG,'init select', { owner: ownerId, chosen });
    });

    const baseQty = parseInt(baseRow?.quantity,10) || 1;

    box.addEventListener('change', (e)=>{
      const t = e.target;
      if (!t) return;

      if (t.matches('input.sova-upsell__checkbox')){
        const code = t.value;
        const pair = t.getAttribute('data-pair') || '';
        if (!code) return;

        if (t.checked){
          if (pair){
            box.querySelectorAll(`input.sova-upsell__checkbox[data-pair="${pair}"]`).forEach(other=>{
              if (other !== t && other.checked){
                other.checked = false;
                removeAllByCode(other.value);
                TEST() && console.log(TAG,'pair remove other', { owner: ownerId, other: other.value });
              }
            });
          }
          addByCode(code, baseQty);
          TEST() && console.log(TAG,'checkbox add', { owner: ownerId, code, qty: baseQty });
        } else {
          removeAllByCode(code);
          TEST() && console.log(TAG,'checkbox remove all', { owner: ownerId, code });
        }
      }
      else if (t.matches('select.sova-upsell__select')){
        const newCode = t.value;
        const prev    = t.dataset.prev || '';
        if (prev && prev !== newCode){
          removeAllByCode(prev);
          TEST() && console.log(TAG,'select remove prev', { owner: ownerId, prev });
        }
        if (newCode){
          addByCode(newCode, baseQty);
          t.dataset.prev = newCode;
          TEST() && console.log(TAG,'select add', { owner: ownerId, code: newCode, qty: baseQty });
        } else {
          t.dataset.prev = '';
        }
      }
    }, { capture:true, passive:true });
  }

  /* ─── render ───────────────────────────────────────────────────────────── */
  let IS_RENDERING = false;
  function doRender(){
    if (IS_RENDERING) return;

    IS_RENDERING = true;
    TEST() && console.log(TAG,'render START');

    mo.disconnect();
    try{
      const ctx  = ns.getContext?.snapshot?.() || {};
      const rows = Array.isArray(ctx.cartItemsExtended) ? ctx.cartItemsExtended : [];
      TEST() && console.log(TAG,'rows:', rows.length);

      // settings: additionalSaleCart → window.additionalSaleCart → window.additionalSale
      let cfg = [];
      const fs = ns.rules?.featureSettings?.('additionalSaleCart');
      if (Array.isArray(fs)) cfg = fs;
      else if (Array.isArray(window.additionalSaleCart)) cfg = window.additionalSaleCart;
      else if (Array.isArray(window.additionalSale)) cfg = window.additionalSale;
      if (!cfg?.length){ TEST() && console.warn(TAG,'no settings'); return; }

      ensureCartCSS();

      // map TR podle kódu (desktop i mobile markup)
      const trByCode = new Map();
      document.querySelectorAll('.cart-table tbody tr.removeable,[data-testid="cartTable"] tbody tr,tr[data-micro="cartItem"]').forEach(tr=>{
        const code = tr.getAttribute('data-micro-sku') || tr.getAttribute('data-code') || tr.getAttribute('data-micro-sku-code') || undefined;
        if (code) trByCode.set(code, tr);
      });

      // upsell kódy (neinjektovat do vlastních řádků)
      const UPS_CODES = collectUpsellCodesFromSettings(cfg);

      rows.forEach(row=>{
        const code = row?.code;
        if (!code) return;

        const tr = trByCode.get(code);
        let cell = tr?.querySelector('td.p-name[data-testid="cellProductName"]') || tr?.querySelector('td.p-name');

        if (UPS_CODES.has(String(code))){
          // pro jistotu vždy smaž náš box jak v desktop buňce, tak v mobilní cell
          cell?.querySelectorAll('.sova-upsell,.sova-upsell-select').forEach(n=>n.remove());
          tr?.querySelectorAll('.sova-upsell-cell .sova-upsell,.sova-upsell-cell .sova-upsell-select').forEach(n=>n.remove());
          return;
        }

        if (!cell && tr){
          // některé mobilní markupy nemusí mít klasickou p-name; použij první buňku jako fallback
          cell = tr.querySelector('td') || null;
        }
        if (!cell) return;

        const eligible = decideUpsellsForRow(row, ctx, cfg);
        mountIntoRowCell(cell, eligible, rows, row);
      });

      TEST() && console.log(TAG,'render DONE');
    } finally {
      IS_RENDERING = false;
      setTimeout(()=> mo.observe(document.body, { childList:true, subtree:true }), 0);
    }
  }

  /* ─── MO + eventy ──────────────────────────────────────────────────────── */
  const isOurNode = (el) => !!(el && el.nodeType===1 && (el.closest?.('.sova-upsell,.sova-upsell-select,.sova-upsell-cell') || el.id==='sova-upsell-cart-css'));
  const touchesCart = (el) => !!(el && el.nodeType===1 && (
    el.matches?.('.cart-table,[data-testid="cartTable"],.cart-items,.cart-inner') ||
    el.querySelector?.('.cart-table,[data-testid="cartTable"],.cart-items,.cart-inner')
  ));
  const mo = new MutationObserver(muts=>{
    const anyCartChange = muts.some(m=>{
      const added  = [...(m.addedNodes||[])];
      const removed= [...(m.removedNodes||[])];
      const target = m.target;
      const onlyOurStuff =
        (added.length  ? added.every(isOurNode)   : true) &&
        (removed.length? removed.every(isOurNode) : true) &&
        isOurNode(target);
      if (onlyOurStuff) return false;
      if (added.some(touchesCart) || removed.some(touchesCart)) return true;
      return touchesCart(target);
    });
    if (anyCartChange){
      TEST() && console.log(TAG,'MO → cart change');
      scheduleRender('MO');
    }
  });
  mo.observe(document.body, { childList:true, subtree:true });

  [
    'ShoptetCartUpdated',
    'ShoptetCartAddCartItem',
    'ShoptetCartRemoveCartItem',
    'ShoptetDOMCartUpdated',
    'ShoptetDOMCartContentLoaded',
    'ShoptetDOMAdvancedOrderLoaded',
    'shoptet:cart:updated'
  ].forEach(ev => document.addEventListener(ev, ()=> {
    TEST() && console.log(TAG, 'evt', ev);
    scheduleRender(ev);
  }, true));

  // boot
  scheduleRender('init');
  ns.bus?.on?.('context:ready', ()=> scheduleRender('context:ready'));

  // public trigger
  ns.fn.register('additionalSaleCart', function(){ scheduleRender('fn.call'); });
})(SOVA);





})(); // IIFE end



// ==========================================
// 🔶 1. ZVÝRAZNĚNÍ VÝPRODEJE PRO VYBRANÉ ADMINY
// ==========================================
document.addEventListener("DOMContentLoaded", function () {
    const body = document.body;

    if (!body.classList.contains("admin-logged")) return;

    fetch("https://raw.githubusercontent.com/Lukas-dotcom/sova/main/BE-sova-settings.json")
        .then(response => response.json())
        .then(data => {
            const allowedNames = data?.FEzvyrazneniVyprodej?.rules?.map(item => item.jmena) || [];
            console.log("✅ Načtena jména:", allowedNames);

            const adminBarText = document.querySelector('.admin-bar')?.innerText || '';
            const matchedName = allowedNames.find(name => adminBarText.includes(name));

            if (matchedName) {
                body.classList.add("vyprodej-zvyrazneni-show");
                console.log("✅ Přidána třída vyprodej-zvyrazneni-show pro uživatele:", matchedName);
            } else {
                console.log("❌ Žádné oprávněné jméno nenalezeno v .admin-bar");
            }
        })
        .catch(err => {
            console.error("❌ Nepodařilo se načíst BE-sova-settings.json", err);
        });
});


// ==========================================
// 🎟️ 2. AUTOMATICKÉ UPLATNĚNÍ KUPÓNU
// ==========================================
(function () {
    const COUPON_KEY = 'kupon';
    const CART_WAS_EMPTY_KEY = 'kosik-byl-prazdny';

    // --- 1. Získání kupónu z URL ---
    const urlParams = new URLSearchParams(window.location.search);
    const urlCoupon = urlParams.get('kupon');

    if (urlCoupon) {
        sessionStorage.setItem(COUPON_KEY, urlCoupon);
        console.log(`🎟️ Kupón ${urlCoupon} uložen do sessionStorage.`);
    }

    const COUPON_CODE = sessionStorage.getItem(COUPON_KEY);
    if (!COUPON_CODE) {
        console.log('ℹ️ Kupón není k dispozici, skript se ukončuje.');
        return;
    }

    console.log(`🎯 Kupón ${COUPON_CODE} připraven.`);

    // --- 2. Po načtení stránky zjisti stav košíku ---
    window.addEventListener('load', () => {
        setTimeout(() => {
            const cartEl = document.querySelector('[data-testid="headerCartPrice"]');
            if (!cartEl) {
                console.warn('⚠️ Element pro košík nebyl nalezen.');
                return;
            }

            const rawText = cartEl.textContent || '';
            const cartText = rawText.replace(/\s+/g, ' ').trim().toLowerCase();
            console.log('🔍 Text v košíku po 1s:', `"${cartText}"`);

            const isCartEmpty = (
                cartText === 'prázdný košík' ||
                (cartText.includes('prázdný') && cartText.includes('košík'))
            );

            if (isCartEmpty) {
                sessionStorage.setItem(CART_WAS_EMPTY_KEY, 'true');
                console.log('🧺 Košík byl prázdný po načtení.');
            } else {
                sessionStorage.removeItem(CART_WAS_EMPTY_KEY);
                console.log('🧺 Košík už po načtení obsahoval položky.');
                tryAddCouponDirectly();
            }
        }, 1000);
    });

    // --- 3. Sleduj kliknutí na "Do košíku" ---
    document.addEventListener('click', function (e) {
        const btn = e.target.closest('button.add-to-cart-button');
        if (!btn) return;

        console.log('🛒 Detekováno kliknutí na "Do košíku". Čekám na CSRF token...');

        setTimeout(() => {
            const csrfInput = document.querySelector('input[name="__csrf__"]');
            const csrfToken = csrfInput?.value;

            if (!csrfToken) {
                console.warn('❌ CSRF token nebyl nalezen.');
                return;
            }

            console.log('🔐 CSRF token získán:', csrfToken);
            applyCoupon(csrfToken);
        }, 1000);
    });

    // --- 4. Pokus o přidání kupónu po načtení stránky ---
    function tryAddCouponDirectly() {
        fetch('/action/Cart/GetExtendedOrder/', {
            method: 'GET',
            credentials: 'include',
            headers: {
                'x-requested-with': 'XMLHttpRequest',
                'x-shoptet-xhr': 'Shoptet_Coo7ai'
            }
        })
        .then(res => res.json())
        .then(data => {
            const currentCoupon = data?.payload?.discountCoupon?.code;
            if (currentCoupon && currentCoupon === COUPON_CODE) {
                console.log('🛑 Kupón už je v košíku, nebude znovu přidáván.');
                return;
            }
    
            const csrfInput = document.querySelector('input[name="__csrf__"]');
            const csrfToken = csrfInput?.value;
    
            if (!csrfToken) {
                console.warn('⚠️ CSRF token chybí pro přímé přidání kupónu.');
                return;
            }
    
            console.log('🚀 Přidávám kupón po načtení, nebyl nalezen v GetExtendedOrder...');
    
            const params = new URLSearchParams();
            params.append('discountCouponCode', COUPON_CODE);
            params.append('__csrf__', csrfToken);
    
            fetch('/action/Cart/addDiscountCoupon/', {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'x-requested-with': 'XMLHttpRequest',
                    'x-shoptet-xhr': 'Shoptet_Coo7ai'
                },
                body: params.toString()
            })
                .then(res => res.json())
                .then(data => {
                    if (data.code === 200 && data.message?.includes('úspěšně')) {
                        console.log('✅ Kupón byl úspěšně uplatněn (po načtení stránky).');
                        sessionStorage.removeItem(COUPON_KEY);
    
                        const priceEl = document.querySelector('[data-testid="headerCartPrice"]');
                        if (priceEl) {
                            priceEl.innerHTML = 'Kupón <br>aktivní';
                            priceEl.style = 'line-height: 1.0; text-align: right;';
                            console.log('🎨 Košík upraven vizuálně (po načtení stránky).');
                        } else {
                            console.warn('⚠️ Element pro košík nebyl nalezen pro vizuální úpravu.');
                        }
    
                        sessionStorage.removeItem(CART_WAS_EMPTY_KEY);
                    } else {
                        console.warn('❌ Kupón se nepodařilo uplatnit (po načtení):', data);
                    }
                })
                .catch(err => {
                    console.error('❌ Chyba při přidávání kupónu po načtení:', err);
                });
        })
        .catch(err => {
            console.warn('⚠️ Chyba při kontrole kupónu v košíku:', err);
        });
    }
    

    // --- 5. Aplikuj kupón ---
    function applyCoupon(csrfToken) {
        const params = new URLSearchParams();
        params.append('discountCouponCode', COUPON_CODE);
        params.append('__csrf__', csrfToken);

        console.log('📤 Odesílám požadavek na uplatnění kupónu...');

        fetch('/action/Cart/addDiscountCoupon/', {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'x-requested-with': 'XMLHttpRequest',
                'x-shoptet-xhr': 'Shoptet_Coo7ai'
            },
            body: params.toString()
        })
        .then(res => res.json())
        .then(data => {
            if (data.code === 200 && data.message?.includes('úspěšně')) {
                console.log('✅ Kupón byl úspěšně uplatněn.');
                sessionStorage.removeItem(COUPON_KEY);

                const wasEmpty = sessionStorage.getItem(CART_WAS_EMPTY_KEY);
                if (wasEmpty) {
                    const priceEl = document.querySelector('[data-testid="headerCartPrice"]');
                    if (priceEl) {
                        priceEl.innerHTML = 'Kupón <br>aktivní';
                        priceEl.style = 'line-height: 1.0; text-align: right;';
                        console.log('🎨 Košík byl prázdný → upraveno vizuálně.');
                    } else {
                        console.warn('⚠️ Element pro košík nebyl nalezen pro vizuální úpravu.');
                    }
                    sessionStorage.removeItem(CART_WAS_EMPTY_KEY);
                } else {
                    console.log('🎨 Košík nebyl prázdný → žádná vizuální úprava.');
                }
            } else {
                console.warn('❌ Kupón se nepodařilo uplatnit:', data);
            }
        })
        .catch(err => {
            console.error('❌ Chyba při fetchi kupónu:', err);
        });
    }
})();



//zobrazení DIVů s kupóny
window.addEventListener("DOMContentLoaded", function () {
    const kuponValue = sessionStorage.getItem("kupon");

    // Pokud kupon existuje a není prázdný
    if (kuponValue && kuponValue.trim() !== "") {
        document.querySelectorAll(".sova-kupon").forEach(el => {
            el.style.display = "block"; 
        });
    }
});

