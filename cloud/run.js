// ネット上（GitHub Actions）で1回だけ動かす入口
// 取引時間中なら1回分の判定（練習の売買）をして、携帯で見るページ用の docs/status.json を書き出す。
// 使い方: node cloud/run.js   （FORCE_TICK=1 で取引時間外でも判定する。試し用）
const fs = require('fs');
const path = require('path');
process.env.KABU_STATE = path.join(__dirname, 'state.json');
const eng = require('../engine');

const DOCS = path.join(__dirname, '..', 'docs');
const jst = iso => iso ? new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : '';
const r1 = v => v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10;

(async () => {
  const st = eng.getState().settings;
  let ticked = false;
  if (st.running && (eng.isMarketOpen() || process.env.FORCE_TICK === '1')) { await eng.tick(); ticked = true; }
  const s = await eng.view();
  const held = s.watch.filter(w => w.pos), sig = s.watch.filter(w => w.buySignal && !w.nkBlocked);
  const errors = s.watch.filter(w => w.error).length;
  const rank = w => (w.pos ? 0 : w.buySignal ? 1 : 2);
  const out = {
    asOf: jst(s.now), lastTick: jst(s.lastTick), ticked,
    running: s.settings.running, marketOpen: s.marketOpen,
    equity: Math.round(s.equity), cash: Math.round(s.cash), initialCash: s.settings.initialCash,
    profit: Math.round(s.profit), profitPct: r1(s.profit / s.settings.initialCash * 100),
    held: held.length, signals: sig.length, watching: s.watch.length, errors,
    nkChg5: r1(s.nikkei && s.nikkei.chg5), nkBlock: !!(s.nikkei && s.nikkei.block),
    rule: `RSI(2日)が${st.rsiBelow}未満・200日平均より上で翌日に買い／利確+${st.dipTP}%・損切り−${st.dipSL}%・最長${st.dipHold}日／日経平均が5日で−${st.nkCrashPct}%以上下げた直後は買わない`,
    watch: s.watch.filter(w => w.price != null).sort((a, b) => rank(a) - rank(b) || (a.rsi ?? 999) - (b.rsi ?? 999)).map(w => ({
      code: w.code, name: w.name, price: w.price, chgPct: w.prevClose ? r1((w.price / w.prevClose - 1) * 100) : null,
      rsi: r1(w.rsi), above200: w.above200,
      status: w.pos ? '保有中' : w.buySignal ? (w.nkBlocked ? '条件成立（見送り）' : '買いの条件成立') : '',
      qty: w.pos ? w.pos.qty : null, buyPrice: w.pos ? w.pos.avgPrice : null, buyDate: w.pos ? w.pos.buyDate : null,
      pnl: w.pnl == null ? null : Math.round(w.pnl),
    })),
    trades: s.trades.slice(0, 100).map(t => ({ time: jst(t.time), name: t.name, code: t.code, side: t.side, qty: t.qty, price: t.price, reason: t.reason, pnl: t.pnl })),
    equityHistory: s.equityHistory,
    logs: s.logs.slice(0, 30).map(l => ({ time: jst(l.time), msg: l.msg })),
  };
  fs.mkdirSync(DOCS, { recursive: true });
  fs.writeFileSync(path.join(DOCS, 'status.json'), JSON.stringify(out));
  console.log(`asOf ${out.asOf} ticked=${ticked} equity=${out.equity} held=${out.held} signals=${out.signals} errors=${errors}`);
})().catch(e => { console.error(e); process.exit(1); });
