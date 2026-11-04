import { test, expect } from '@playwright/test';
import { signInAs, type Role } from './helpers/auth';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Every screen in the app, both themes, with the browser's own complaints
 * recorded alongside each shot.
 *
 * This exists to be a TRACK, not a gate: runs land under
 * e2e/shots/runs/<stamp>/ so nothing overwrites the previous one, and the
 * committed baseline in e2e/shots/ is left alone. Run it with
 *
 *   npm run test:walkthrough
 *
 * Screenshots alone would only prove a screen rendered something. Each visit
 * also collects console errors, uncaught page errors and any response >= 400,
 * which is what actually distinguishes "styled correctly" from "working".
 */
const STAMP = process.env.RUN_STAMP || new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const ROOT = path.join('e2e', 'shots', 'runs', STAMP);

const SCREENS: Record<Role, { base: string; paths: string[] }> = {
  superAdmin: { base: '/super-admin', paths: ['', 'approvals','team-approvals','users','departments','labs','projects','companies','admins','lab','inventory','finances','history','database','feedback','settings','notifications','messages'] },
  admin:      { base: '/admin',       paths: ['', 'approvals','team-approvals','components','lists','users','notifications','history','messages'] },
  manager:    { base: '/manager',     paths: ['', 'approvals','team-approvals','my-components','lists','ip-requests','team','notifications','messages'] },
  user:       { base: '/user',        paths: ['', 'my-components','lists','ip-requests','notifications','messages'] },
  procurement:{ base: '/procurement', paths: ['', 'indents','ip-requests','request-item','refunds','vendor-codes','notes','planning','components','lab-items','vault','notifications','messages'] },
  inventory:  { base: '/inventory',   paths: ['', 'components','allot','ip-requests','request-item','requests','bom-batches','issue-slips','dispositions','returns','lab-items','fixed-assets','history','notifications','messages'] },
  finance:    { base: '/finance',     paths: ['', 'inventory-items','ip-requests','indents','refunds','associate-finance','fixed-assets','companies','subscriptions','vault','notifications','messages'] },
  associateFinance: { base: '/associate-finance', paths: ['', 'inventory-items','ip-requests','indents','refunds','fixed-assets','notifications','messages'] },
};


/**
 * WCAG AA contrast, measured on the live DOM.
 *
 * Folded into the walkthrough rather than kept as a separate hand-picked route
 * list, because the hand-picked list is what let /super-admin/database ship a
 * banner at 1.11:1 — it simply was not on the list. Every screen the sweep
 * visits is now audited, so "not audited" stops being a silent state.
 *
 * Backgrounds resolve through gradients (a `.bg-brand.text-white` button is
 * painted by a background-IMAGE that covers its background-colour; scoring the
 * colour alone produced 193 false failures once) and through a single layer of
 * translucency.
 */
const CONTRAST_AUDIT = `(() => {
  const lum=(r,g,b)=>{const f=v=>{v/=255;return v<=0.03928?v/12.92:((v+0.055)/1.055)**2.4};return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b)};
  const nums=s=>(s.match(/[\\d.]+/g)||[]).map(Number);
  // Keep the ALPHA. from-blue-400/10 compiles to rgba(96,165,250,0.1); scoring
  // against opaque blue-400 reported a banner as failing when what is painted
  // is a 10% wash over the card beneath it.
  const stops=s=>{const o=[];const re=/rgba?\\(([^)]+)\\)/g;let m;while((m=re.exec(s))){const p=m[1].split(',').map(Number);if(p.length>=3)o.push(p)}return o};
  const blend=(c,a,bg)=>c.map((v,i)=>Math.round(v*a+bg[i]*(1-a)));
  // Walk to the first OPAQUE ancestor, compositing translucent layers on the
  // way, so a 10% wash resolves to what is actually painted.
  const bgOf=el=>{
    const layers=[]; let n=el;
    while(n&&n!==document.documentElement){
      const cs=getComputedStyle(n);
      if(cs.backgroundImage&&cs.backgroundImage!=='none'){
        const st=stops(cs.backgroundImage);
        // A gradient carrying a fully transparent stop is a PATTERN (dots,
        // stripes), not a fill: it covers a few percent of the area, so the
        // thing behind it is what text actually sits on. Scoring against the
        // dot colour produced 16 phantom failures on the Messages empty state.
        const sparse=st.some(q=>(q[3]!==undefined&&q[3]<0.02));
        if(st.length&&!sparse){
          const opaque=st.filter(q=>(q[3]===undefined||q[3]>0.99));
          if(opaque.length) return opaque.map(q=>q.slice(0,3));
          for(const q of st){ const a=q[3]===undefined?1:q[3]; if(a>0.02) layers.push({c:q.slice(0,3),a}); }
        }
      }
      const q=nums(cs.backgroundColor);
      if(q.length>=3){
        const a=q[3]===undefined?1:q[3];
        if(a>0.99){ let base=q.slice(0,3); for(let i=layers.length-1;i>=0;i--) base=blend(layers[i].c,layers[i].a,base); return [base]; }
        if(a>0.02) layers.push({c:q.slice(0,3),a});
      }
      n=n.parentElement;
    }
    // No opaque ancestor: fall back to the THEME's page colour, not black.
    // Black produced 32 phantom failures on the Messages empty state.
    const pg=nums(getComputedStyle(document.documentElement).getPropertyValue('--c-page')||'');
    let base=pg.length>=3?pg.slice(0,3):(document.documentElement.classList.contains('dark')?[15,15,17]:[255,255,255]);
    for(let i=layers.length-1;i>=0;i--) base=blend(layers[i].c,layers[i].a,base);
    return [base];};
  const out=[];
  for(const el of document.querySelectorAll('body *')){
    if(el.children.length)continue;
    const t=(el.textContent||'').trim(); if(t.length<2)continue;
    const r=el.getBoundingClientRect(); if(r.width<2||r.height<2)continue;
    const cs=getComputedStyle(el); if(cs.visibility==='hidden'||cs.opacity==='0')continue;
    // WCAG 1.4.3 exempts INACTIVE controls. Disabled pagination buttons were
    // 54 of 97 reported failures — every one of them compliant.
    if(el.closest('[disabled],[aria-disabled="true"]'))continue;
    const fg=nums(cs.color).slice(0,3); const op=parseFloat(cs.opacity);
    let worst=Infinity,wbg=null;
    for(const bg of bgOf(el)){
      const f=op<1?blend(fg,op,bg):fg;
      const l1=lum(...f),l2=lum(...bg);
      const ra=(Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05);
      if(ra<worst){worst=ra;wbg=bg}}
    const px=parseFloat(cs.fontSize),bold=(parseInt(cs.fontWeight)||400)>=700;
    const need=(px>=24||(px>=18.66&&bold))?3:4.5;
    if(worst+0.01<need) out.push({text:t.slice(0,40),ratio:+worst.toFixed(2),need,fg:'rgb('+fg+')',bg:'rgb('+wbg+')',cls:(el.className||'').toString().slice(0,70)});
  }
  return out;
})()`;

type Problem = { role: string; theme: string; screen: string; kind: string; detail: string };
const problems: Problem[] = [];

/** Noise that is the environment, not the app. */
const IGNORE = [
  /favicon/i,
  /\/api\/auth\/refresh\b.*\b401\b/,      // expected pre-login
  /ERR_INTERNET_DISCONNECTED/,
  /Download the React DevTools/i,
];
const noisy = (s: string) => IGNORE.some((r) => r.test(s));

for (const theme of ['light', 'dark'] as const) {
  for (const [role, { base, paths }] of Object.entries(SCREENS) as [Role, { base: string; paths: string[] }][]) {
    test(`${role} · ${theme}`, async ({ page }) => {
      test.setTimeout(240_000);
      await page.addInitScript((t) => {
        try { localStorage.setItem('theme_preference', t); } catch { /* blocked */ }
      }, theme);

      let screen = 'login';
      page.on('console', (m) => {
        if (m.type() !== 'error') return;
        const text = m.text();
        if (noisy(text)) return;
        problems.push({ role, theme, screen, kind: 'console', detail: text.slice(0, 300) });
      });
      page.on('pageerror', (e) => {
        if (noisy(String(e))) return;
        problems.push({ role, theme, screen, kind: 'pageerror', detail: String(e).slice(0, 300) });
      });
      page.on('response', (r) => {
        if (r.status() < 400) return;
        const line = `${r.status()} ${r.request().method()} ${r.url()}`;
        if (noisy(line)) return;
        problems.push({ role, theme, screen, kind: 'http', detail: line.slice(0, 300) });
      });

      await signInAs(page, role);

      const dir = path.join(ROOT, theme, role);
      fs.mkdirSync(dir, { recursive: true });

      for (const p of paths) {
        screen = p || 'dashboard';
        const url = p ? `${base}/${p}` : base;
        await page.goto(url);
        await page.waitForLoadState('networkidle').catch(() => { /* long-poll sockets */ });
        await page.waitForTimeout(700);

        // A screen that rendered nothing is worth knowing about even though
        // the shot would look merely empty.
        const bodyText = (await page.locator('body').innerText().catch(() => '')) || '';
        if (bodyText.trim().length < 40) {
          problems.push({ role, theme, screen, kind: 'blank', detail: `only ${bodyText.trim().length} chars of text` });
        }

        for (const f of (await page.evaluate(CONTRAST_AUDIT)) as any[]) {
          problems.push({
            role, theme, screen, kind: 'contrast',
            detail: `${f.ratio}:1 (need ${f.need}) "${f.text}" ${f.fg} on ${f.bg} [${f.cls}]`.slice(0, 300),
          });
        }

        await page.screenshot({
          path: path.join(dir, `${screen}.png`),
          fullPage: false,
          animations: 'disabled',
        });
      }
    });
  }
}

test.afterAll(() => {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'findings.json'), JSON.stringify(problems, null, 2));

  const byKind = problems.reduce<Record<string, number>>((a, p) => { a[p.kind] = (a[p.kind] || 0) + 1; return a; }, {});
  const lines = [
    `# Walkthrough ${STAMP}`,
    '',
    `${problems.length} problem(s) recorded` + (problems.length ? ` — ${Object.entries(byKind).map(([k, n]) => `${k}: ${n}`).join(', ')}` : ''),
    '',
  ];
  if (problems.length) {
    lines.push('| role | theme | screen | kind | detail |', '|---|---|---|---|---|');
    for (const p of problems) {
      lines.push(`| ${p.role} | ${p.theme} | ${p.screen} | ${p.kind} | ${p.detail.replace(/\|/g, '\\|')} |`);
    }
  }
  fs.writeFileSync(path.join(ROOT, 'report.md'), lines.join('\n') + '\n');
  console.log(`\nwalkthrough -> ${ROOT}  (${problems.length} problems)`);
});
