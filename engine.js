// 株式自動売買 ― 売買エンジン（練習モード＝仮想のお金で売買）
// ルール：移動平均のゴールデンクロスで買い、デッドクロス・損切り・利確で売り
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
// ネット上（GitHub）で動かすときは KABU_STATE で記録の置き場所を変える
const STATE_FILE = process.env.KABU_STATE || path.join(DATA_DIR, 'state.json');

const DEFAULT_STATE = () => ({
  settings: {
    running: false,
    mode: 'paper',          // paper = 練習（実際の注文は出さない）
    initialCash: 1000000,   // 最初の資金（円）
    shortMA: 5,             // 短期移動平均（日）
    longMA: 25,             // 長期移動平均（日）
    stopLossPct: 5,         // 損切り（%）
    takeProfitPct: 10,      // 利確（%）
    maxPerSymbol: 500000,   // 1銘柄に使う上限（円）
    intervalSec: 60,        // 判定の間隔（秒）
    strategy: 'dip',        // dip = 売られすぎ買い（高勝率型） / ma = 移動平均クロス
    rsiBelow: 5,            // RSI(2日)がこの値未満で買い
    up200: true,            // 200日平均より上のときだけ買う
    dipTP: 2,               // 利確（%）
    dipSL: 7,               // 損切り（%）
    dipHold: 10,            // 最長で持つ日数（営業日）
    nkCrashPct: 3,          // 日経平均が5日でこの%以上下げた直後は買わない（0で使わない）
    intraStreak: 5,         // 5分足がこの本数つづけて下げたら買い
    intraUpDay: true,       // 前日終値より高いときだけ買う
    intraTP: 0.3,           // 利確（%）
    intraSL: 1.5,           // 損切り（%）
  },
  watchlist: [
    { code: '7203', name: 'トヨタ自動車' },
    { code: '6758', name: 'ソニーグループ' },
    { code: '9432', name: 'NTT' },
  ],
  cash: 1000000,
  positions: {},      // code -> { qty, avgPrice, buyDate }
  trades: [],
  logs: [],
  equityHistory: [],  // { date, value }
  lastSignal: {},     // code -> 最後に買った5分足（同じ合図で買い直さないため）
  lastTradeDate: {},  // code -> 'YYYY-MM-DD'（同じ日に何度も売買しないため）
});

let state = load();

function load() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const d = DEFAULT_STATE();
    return { ...d, ...s, settings: { ...d.settings, ...s.settings } };
  } catch {
    return DEFAULT_STATE();
  }
}

function save() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, STATE_FILE);
}

function log(msg) {
  state.logs.unshift({ time: new Date().toISOString(), msg });
  if (state.logs.length > 200) state.logs.length = 200;
}

// ---------- 日時（日本時間） ----------
function jstDate(ms = Date.now()) {
  return new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
}
function isMarketOpen(ms = Date.now()) {
  const d = new Date(ms + 9 * 3600e3);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return (m >= 540 && m < 690) || (m >= 750 && m < 930); // 9:00-11:30 / 12:30-15:30
}

// ---------- 株価データ ----------
const cache = new Map();
async function fetchChart(code, range = '2y') {
  const key = code + ':' + range;
  const hit = cache.get(key);
  // 保有中の銘柄は約1分ごと、それ以外は5分ごとに取り直す（銘柄が多くても負荷をかけないため）
  if (hit && Date.now() - hit.at < (state.positions[code] ? 55000 : 300000)) return hit.data;
  const sym = code.startsWith('^') ? code : code + '.T'; // ^N225 などの指数はそのまま
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`株価を取得できません（${code}: ${res.status}）`);
  const j = await res.json();
  const r = j.chart && j.chart.result && j.chart.result[0];
  if (!r || !r.timestamp) throw new Error(`銘柄が見つかりません（${code}）`);
  const q = r.indicators.quote[0], closes = q.close;
  const r1 = v => Math.round(v * 10) / 10;
  const bars = [];
  r.timestamp.forEach((t, i) => {
    if (closes[i] != null) bars.push({ date: jstDate(t * 1000), close: r1(closes[i]), open: r1(q.open[i] ?? closes[i]), high: r1(q.high[i] ?? closes[i]), low: r1(q.low[i] ?? closes[i]) });
  });
  if (bars.length < 2) throw new Error(`データが足りません（${code}）`);
  const data = {
    code,
    name: r.meta.shortName || r.meta.longName || code,
    price: bars[bars.length - 1].close,
    prevClose: bars[bars.length - 2].close,
    lastDate: bars[bars.length - 1].date,
    bars,
  };
  cache.set(key, { at: Date.now(), data });
  return data;
}

// ---------- 5分足（デイトレ用） ----------
const INTRA_LAST_ENTRY = 870; // 14:30 以降は新しく買わない
const INTRA_FORCE_EXIT = 920; // 15:20 の足で必ず売る
const INTRA_COST = 0.05;      // 過去検証で差し引く値ずれ（1往復・%）
async function fetch5m(code, range = '5d') {
  const key = code + ':5m:' + range;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 55000) return hit.data;
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(code) + '.T?range=' + range + '&interval=5m';
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('5分足を取得できません（' + code + ': ' + res.status + '）');
  const j = await res.json();
  const r = j.chart && j.chart.result && j.chart.result[0];
  if (!r || !r.timestamp) throw new Error('5分足がありません（' + code + '）');
  const q = r.indicators.quote[0], r1 = v => Math.round(v * 10) / 10;
  const bars = [];
  r.timestamp.forEach((t, i) => {
    if (q.close[i] == null || q.open[i] == null) return;
    const d = new Date(t * 1000 + 9 * 3600e3);
    const m = d.getUTCHours() * 60 + d.getUTCMinutes();
    bars.push({ day: d.toISOString().slice(0, 10), m, key: d.toISOString().slice(5, 16).replace('T', ' '), open: r1(q.open[i]), high: r1(q.high[i]), low: r1(q.low[i]), close: r1(q.close[i]) });
  });
  if (bars.length < 3) throw new Error('5分足が足りません（' + code + '）');
  cache.set(key, { at: Date.now(), data: bars });
  return bars;
}
function intraInd(bars) {
  const out = [];
  let streak = 0, prevClose = null, lastClose = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i], newDay = i === 0 || bars[i - 1].day !== b.day;
    if (newDay) { prevClose = lastClose; streak = 0; }
    streak = !newDay && b.close < bars[i - 1].close ? streak + 1 : 0;
    out.push({ streak, upDay: prevClose != null && b.close > prevClose, hasPrev: prevClose != null });
    lastClose = b.close;
  }
  return out;
}
function intraSignal(x, st) {
  return x.hasPrev && x.streak >= st.intraStreak && (!st.intraUpDay || x.upDay);
}

// ---------- 売買ルール ----------
function sma(arr, n, end) {
  if (end - n + 1 < 0) return null;
  let s = 0;
  for (let i = end - n + 1; i <= end; i++) s += arr[i];
  return s / n;
}

// closes の i 番目の時点での判定
function judge(closes, i, st, pos) {
  const sN = sma(closes, st.shortMA, i), lN = sma(closes, st.longMA, i);
  const sP = sma(closes, st.shortMA, i - 1), lP = sma(closes, st.longMA, i - 1);
  const price = closes[i];
  const out = { action: null, reason: '', short: sN, long: lN };
  if (sN == null || lN == null || sP == null || lP == null) return out;
  if (pos) {
    if (price <= pos.avgPrice * (1 - st.stopLossPct / 100)) { out.action = 'sell'; out.reason = '損切り'; }
    else if (price >= pos.avgPrice * (1 + st.takeProfitPct / 100)) { out.action = 'sell'; out.reason = '利確'; }
    else if (sP >= lP && sN < lN) { out.action = 'sell'; out.reason = 'デッドクロス'; }
  } else if (sP <= lP && sN > lN) { out.action = 'buy'; out.reason = 'ゴールデンクロス'; }
  return out;
}

// RSI(2日)・ワイルダー式。各日の値を配列で返す
function rsi2Series(closes) {
  const out = [];
  let up = 0, dn = 0;
  for (let i = 0; i < closes.length; i++) {
    const ch = i ? closes[i] - closes[i - 1] : 0;
    if (i === 1 || i === 2) { up += Math.max(ch, 0) / 2; dn += Math.max(-ch, 0) / 2; }
    else if (i > 2) { up = (up + Math.max(ch, 0)) / 2; dn = (dn + Math.max(-ch, 0)) / 2; }
    out.push(i >= 2 ? (up + dn === 0 ? 50 : 100 * up / (up + dn)) : null);
  }
  return out;
}
// 売られすぎ買いの条件：i 日目の終値で判定（買うのは翌日）
function dipSignal(closes, rsi, i, st) {
  if (i < 200 || rsi[i] == null || rsi[i] >= st.rsiBelow) return false;
  return !st.up200 || closes[i] > sma(closes, 200, i);
}
// 日経平均が直近5日で大きく下げた直後か。date を渡すと、その日より前の終値で判定する
async function nikkeiCrash(st, date) {
  if (!st.nkCrashPct) return { block: false, chg5: null };
  const bars = (await fetchChart('^N225')).bars;
  let i = bars.length - 1;
  if (date) while (i > 0 && bars[i].date >= date) i--;
  if (i < 5) return { block: false, chg5: null };
  const chg5 = (bars[i].close / bars[i - 5].close - 1) * 100;
  return { block: chg5 <= -st.nkCrashPct, chg5, asOf: bars[i].date };
}
function jstMinutes() {
  const d = new Date(Date.now() + 9 * 3600e3);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function buyQty(budget, price) {
  return Math.floor(budget / price / 100) * 100; // 100株単位
}

// ---------- 練習用の注文（仮想） ----------
function paperBuy(w, price, reason) {
  const st = state.settings;
  const qty = buyQty(Math.min(st.maxPerSymbol, state.cash), price);
  if (qty < 100) { log(`${w.name}（${w.code}）買いシグナルですが、資金が足りず見送り`); return false; }
  state.cash -= qty * price;
  state.positions[w.code] = { qty, avgPrice: price, buyDate: jstDate() };
  state.trades.unshift({ time: new Date().toISOString(), code: w.code, name: w.name, side: '買', qty, price, reason, pnl: null });
  log(`【買】${w.name}（${w.code}）${qty}株 @${price}円 ― ${reason}`);
  return true;
}
function paperSell(w, price, reason) {
  const pos = state.positions[w.code];
  if (!pos) return false;
  const pnl = Math.round((price - pos.avgPrice) * pos.qty);
  state.cash += pos.qty * price;
  delete state.positions[w.code];
  state.trades.unshift({ time: new Date().toISOString(), code: w.code, name: w.name, side: '売', qty: pos.qty, price, reason, pnl });
  log(`【売】${w.name}（${w.code}）${pos.qty}株 @${price}円 ― ${reason}（損益 ${pnl >= 0 ? '+' : ''}${pnl}円）`);
  return true;
}

// ---------- 1回分の判定 ----------
// デイトレの1回分：確定した直前の5分足で条件を見て買い、利確・損切り・引け前で売る
async function tickIntra(w, today) {
  const st = state.settings;
  const bars = await fetch5m(w.code);
  const n = bars.length, last = bars[n - 1];
  if (last.day !== today) return;
  const pos = state.positions[w.code], price = last.close;
  if (pos) {
    if (pos.buyDate !== today) paperSell(w, price, '持ち越し解消');
    else if (price <= pos.avgPrice * (1 - st.intraSL / 100)) paperSell(w, price, '損切り');
    else if (price >= pos.avgPrice * (1 + st.intraTP / 100)) paperSell(w, price, '利確');
    else if (last.m >= INTRA_FORCE_EXIT || jstMinutes() >= 925) paperSell(w, price, '引け前');
    return;
  }
  const sig = bars[n - 2];
  if (sig.day !== today || last.m > INTRA_LAST_ENTRY || jstMinutes() >= INTRA_FORCE_EXIT) return;
  if (state.lastSignal[w.code] === sig.key) return;
  if (!intraSignal(intraInd(bars)[n - 2], st)) return;
  state.lastSignal[w.code] = sig.key;
  paperBuy(w, price, '5分足の連続下落');
}
async function intraView(code) {
  try {
    const bars = await fetch5m(code), x = intraInd(bars)[bars.length - 1];
    return { streak: x.streak, upDay: x.hasPrev ? x.upDay : null, barTime: bars[bars.length - 1].key };
  } catch { return { streak: null, upDay: null }; }
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const today = jstDate();
    for (const w of state.watchlist) {
      try {
        if (state.settings.strategy === 'intra') { await tickIntra(w, today); continue; }
        const d = await fetchChart(w.code);
        if (d.lastDate !== today) continue;                  // 今日の値がまだ無い（休場日など）
        if (state.lastTradeDate[w.code] === today) continue; // 同じ日は1回まで
        const closes = d.bars.map(b => b.close);
        const st = state.settings, pos = state.positions[w.code];
        let j = { action: null };
        if (st.strategy === 'dip') {
          if (pos) {
            const held = d.bars.filter(b => b.date >= pos.buyDate).length;
            if (d.price <= pos.avgPrice * (1 - st.dipSL / 100)) j = { action: 'sell', reason: '損切り' };
            else if (d.price >= pos.avgPrice * (1 + st.dipTP / 100)) j = { action: 'sell', reason: '利確' };
            else if (held >= st.dipHold && jstMinutes() >= 900) j = { action: 'sell', reason: '期限' };
          } else if (dipSignal(closes, rsi2Series(closes), closes.length - 2, st)) {
            const nkc = await nikkeiCrash(st, today);
            if (!nkc.block) j = { action: 'buy', reason: '売られすぎ（RSI）' }; // 前日の終値で条件成立 → 今日買う
            else if (state.lastSignal[w.code] !== 'nk:' + today) {
              state.lastSignal[w.code] = 'nk:' + today;
              log(`${w.name}（${w.code}）は買いの条件ですが、日経平均が5日で${nkc.chg5.toFixed(1)}%下げた直後のため見送り`);
            }
          }
        } else {
          j = judge(closes, closes.length - 1, st, pos);
        }
        let done = false;
        if (j.action === 'buy') done = paperBuy(w, d.price, j.reason);
        if (j.action === 'sell') done = paperSell(w, d.price, j.reason);
        if (done) state.lastTradeDate[w.code] = today;
      } catch (e) {
        log(`${w.code}: ${e.message}`);
      }
    }
    await recordEquity();
    state.lastTick = new Date().toISOString();
    save();
  } finally {
    ticking = false;
  }
}

async function equity() {
  let v = state.cash;
  for (const [code, p] of Object.entries(state.positions)) {
    try { v += p.qty * (await fetchChart(code)).price; } catch { v += p.qty * p.avgPrice; }
  }
  return Math.round(v);
}
async function recordEquity() {
  const date = jstDate(), value = await equity();
  const h = state.equityHistory;
  if (h.length && h[h.length - 1].date === date) h[h.length - 1].value = value;
  else h.push({ date, value });
  if (h.length > 750) h.shift();
}

// ---------- 画面に渡す情報 ----------
async function view() {
  const st = state.settings;
  let nikkei = { block: false, chg5: null };
  try { if (st.strategy === 'dip') nikkei = await nikkeiCrash(st, isMarketOpen() ? jstDate() : null); } catch {}
  const watch = await Promise.all(state.watchlist.map(async w => {
    const pos = state.positions[w.code] || null;
    try {
      const d = await fetchChart(w.code);
      const closes = d.bars.map(b => b.close);
      const i = closes.length - 1;
      const s = sma(closes, st.shortMA, i), l = sma(closes, st.longMA, i);
      const rsi = rsi2Series(closes), m200 = sma(closes, 200, i);
      const today = d.lastDate === jstDate();
      return {
        rsi: rsi[i], above200: m200 != null ? d.price > m200 : null,
        buySignal: st.strategy === 'dip' && !pos && dipSignal(closes, rsi, today ? i - 1 : i, st),
        nkBlocked: nikkei.block,
        signalFor: today ? '今日' : '次の営業日',
        ...(st.strategy === 'intra' ? await intraView(w.code) : {}),
        code: w.code, name: w.name, price: d.price, prevClose: d.prevClose, lastDate: d.lastDate,
        short: s, long: l, trend: s != null && l != null ? (s > l ? 'up' : 'down') : null,
        pos, pnl: pos ? Math.round((d.price - pos.avgPrice) * pos.qty) : null,
      };
    } catch (e) {
      return { code: w.code, name: w.name, error: e.message, pos };
    }
  }));
  const eq = await equity();
  return {
    settings: st, watch, nikkei, cash: Math.round(state.cash), equity: eq,
    profit: eq - st.initialCash,
    trades: state.trades.slice(0, 100), logs: state.logs.slice(0, 60),
    equityHistory: state.equityHistory, lastTick: state.lastTick || null,
    marketOpen: isMarketOpen(), now: new Date().toISOString(),
  };
}

// ---------- 操作 ----------
function num(v, min, max, def) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}
function updateSettings(b) {
  const s = state.settings;
  const shortMA = Math.round(num(b.shortMA, 2, 100, s.shortMA));
  const longMA = Math.round(num(b.longMA, 3, 200, s.longMA));
  if (shortMA >= longMA) throw new Error('短期は長期より小さい日数にしてください');
  s.shortMA = shortMA; s.longMA = longMA;
  s.stopLossPct = num(b.stopLossPct, 0.5, 50, s.stopLossPct);
  s.takeProfitPct = num(b.takeProfitPct, 0.5, 200, s.takeProfitPct);
  s.maxPerSymbol = Math.round(num(b.maxPerSymbol, 10000, 1e9, s.maxPerSymbol));
  s.initialCash = Math.round(num(b.initialCash, 100000, 1e10, s.initialCash));
  s.intervalSec = Math.round(num(b.intervalSec, 30, 3600, s.intervalSec));
  if (['dip', 'ma', 'intra'].includes(b.strategy)) s.strategy = b.strategy;
  s.intraStreak = Math.round(num(b.intraStreak, 2, 20, s.intraStreak));
  s.intraTP = num(b.intraTP, 0.1, 10, s.intraTP);
  s.intraSL = num(b.intraSL, 0.1, 10, s.intraSL);
  if (typeof b.intraUpDay === 'boolean') s.intraUpDay = b.intraUpDay;
  s.rsiBelow = num(b.rsiBelow, 1, 50, s.rsiBelow);
  s.dipTP = num(b.dipTP, 0.5, 50, s.dipTP);
  s.dipSL = num(b.dipSL, 1, 50, s.dipSL);
  s.dipHold = Math.round(num(b.dipHold, 1, 60, s.dipHold));
  s.nkCrashPct = num(b.nkCrashPct, 0, 20, s.nkCrashPct ?? 3);
  if (typeof b.up200 === 'boolean') s.up200 = b.up200;
  log('設定を変更しました');
  save();
}
function setRunning(on) {
  state.settings.running = !!on;
  log(on ? '自動売買を開始しました（練習モード）' : '自動売買を停止しました');
  save();
}
async function addWatch(code, name) {
  code = String(code || '').trim().toUpperCase();
  if (!/^[0-9][0-9A-Z]{3}$/.test(code)) throw new Error('銘柄コードは4桁で入力してください（例：7203）');
  if (state.watchlist.some(w => w.code === code)) throw new Error('すでに登録されています');
  if (state.watchlist.length >= 60) throw new Error('登録は60銘柄までです');
  const d = await fetchChart(code);
  name = String(name || '').trim().slice(0, 30) || d.name;
  state.watchlist.push({ code, name });
  log(`${name}（${code}）を監視に追加`);
  save();
}
function removeWatch(code) {
  if (state.positions[code]) throw new Error('保有中の銘柄は外せません。先に売ってください');
  state.watchlist = state.watchlist.filter(w => w.code !== code);
  save();
}
async function sellAll() {
  for (const code of Object.keys(state.positions)) {
    const w = state.watchlist.find(x => x.code === code) || { code, name: code };
    try { paperSell(w, (await fetchChart(code)).price, '手動で全部売り'); } catch (e) { log(`${code}: ${e.message}`); }
  }
  await recordEquity();
  save();
}
function reset() {
  const keep = { settings: { ...state.settings, running: false }, watchlist: state.watchlist };
  state = { ...DEFAULT_STATE(), ...keep, cash: keep.settings.initialCash };
  log('練習の記録をリセットしました');
  save();
}

// ---------- 過去データで試す（バックテスト） ----------
// 売られすぎ買いの過去検証：条件成立の翌日の始値で買い、利確・損切り・期限で売る（同じ日は損切りを先に判定）
async function backtestDip(code) {
  const st = state.settings;
  const d = await fetchChart(code, '5y');
  const bars = d.bars, closes = bars.map(b => b.close), rsi = rsi2Series(closes);
  const nk = st.nkCrashPct ? (await fetchChart('^N225', '5y')).bars : [];
  const nkIdx = new Map(nk.map((b, k) => [b.date, k]));
  const nkBlock = date => { const k = nkIdx.get(date); return k != null && k >= 5 && (nk[k].close / nk[k - 5].close - 1) * 100 <= -st.nkCrashPct; };
  if (bars.length < 260) throw new Error('過去データが足りません（上場から日が浅い銘柄です）');
  const trades = [];
  let i = 200, overBudget = false;
  while (i < bars.length - 1) {
    if (!dipSignal(closes, rsi, i, st) || (st.nkCrashPct && nkBlock(bars[i].date))) { i++; continue; }
    const en = i + 1, entry = bars[en].open, target = entry * (1 + st.dipTP / 100), stop = entry * (1 - st.dipSL / 100);
    let qty = buyQty(st.maxPerSymbol, entry);
    if (qty < 100) { qty = 100; overBudget = true; }
    let exit = null, reason = '', j = en;
    for (; j < bars.length; j++) {
      const b = bars[j];
      if (j > en && b.open <= stop) { exit = b.open; reason = '損切り'; break; }
      if (b.low <= stop) { exit = stop; reason = '損切り'; break; }
      if (j > en && b.open >= target) { exit = b.open; reason = '利確'; break; }
      if (b.high >= target) { exit = target; reason = '利確'; break; }
      if (j - en + 1 >= st.dipHold) { exit = b.close; reason = '期限'; break; }
    }
    const open = exit == null;
    if (open) { exit = closes[closes.length - 1]; reason = '保有中'; }
    exit = Math.round(exit * 10) / 10;
    trades.push({ buyDate: bars[en].date, buyPrice: entry, sellDate: open ? null : bars[j].date, sellPrice: exit, qty, reason, pnl: Math.round((exit - entry) * qty) });
    if (open) break;
    i = j + 1;
  }
  const q0 = Math.max(100, buyQty(st.maxPerSymbol, closes[200]));
  const w = state.watchlist.find(x => x.code === code);
  return {
    code, name: w ? w.name : d.name, strategy: 'dip', overBudget,
    from: bars[200].date, to: bars[bars.length - 1].date,
    trades,
    totalPnl: trades.reduce((a, t) => a + t.pnl, 0),
    wins: trades.filter(t => t.pnl > 0).length,
    losses: trades.filter(t => t.pnl <= 0).length,
    buyHoldPnl: Math.round((closes[closes.length - 1] - closes[200]) * q0),
    series: bars.slice(200).map(b => ({ d: b.date, c: b.close })),
  };
}

// デイトレの過去検証（直近60日の5分足）：条件成立の次の足の始値で買い、その日のうちに必ず売る
async function backtestIntra(code) {
  const st = state.settings;
  const bars = await fetch5m(code, '60d'), ind = intraInd(bars);
  const trades = [];
  let i = 1, overBudget = false;
  while (i < bars.length - 1) {
    const en = i + 1;
    if (!intraSignal(ind[i], st) || bars[en].day !== bars[i].day || bars[en].m > INTRA_LAST_ENTRY) { i++; continue; }
    const entry = bars[en].open, target = entry * (1 + st.intraTP / 100), stop = entry * (1 - st.intraSL / 100);
    let qty = buyQty(st.maxPerSymbol, entry);
    if (qty < 100) { qty = 100; overBudget = true; }
    let exit = null, reason = '', j = en;
    for (; j < bars.length; j++) {
      const b = bars[j], lastOfDay = j === bars.length - 1 || bars[j + 1].day !== b.day;
      if (j > en && b.open <= stop) { exit = b.open; reason = '損切り'; break; }
      if (b.low <= stop) { exit = stop; reason = '損切り'; break; }
      if (j > en && b.open >= target) { exit = b.open; reason = '利確'; break; }
      if (b.high >= target) { exit = target; reason = '利確'; break; }
      if (b.m >= INTRA_FORCE_EXIT || lastOfDay) { exit = b.close; reason = '引け前'; break; }
    }
    const cost = entry * INTRA_COST / 100;
    trades.push({ buyDate: bars[en].key, buyPrice: entry, sellDate: bars[j].key, sellPrice: Math.round(exit * 10) / 10, qty, reason, pnl: Math.round((exit - entry - cost) * qty) });
    i = j + 1;
  }
  const first = bars[0].close, lastC = bars[bars.length - 1].close;
  const w = state.watchlist.find(x => x.code === code);
  return {
    code, name: w ? w.name : code, strategy: 'intra', overBudget,
    from: bars[0].day, to: bars[bars.length - 1].day,
    trades,
    totalPnl: trades.reduce((a, t) => a + t.pnl, 0),
    wins: trades.filter(t => t.pnl > 0).length,
    losses: trades.filter(t => t.pnl <= 0).length,
    buyHoldPnl: Math.round((lastC - first) * Math.max(100, buyQty(st.maxPerSymbol, first))),
    series: bars.map(b => ({ d: b.key, c: b.close })),
  };
}

async function backtest(code) {
  const st = state.settings;
  if (st.strategy === 'dip') return backtestDip(code);
  if (st.strategy === 'intra') return backtestIntra(code);
  const d = await fetchChart(code, '2y');
  const closes = d.bars.map(b => b.close);
  const start = st.longMA;
  if (closes.length <= start + 1) throw new Error('過去データが足りません');
  let pos = null;
  const trades = [];
  for (let i = start; i < closes.length; i++) {
    const j = judge(closes, i, st, pos);
    const price = closes[i], date = d.bars[i].date;
    if (j.action === 'buy') {
      const qty = buyQty(st.maxPerSymbol, price);
      if (qty >= 100) pos = { qty, avgPrice: price, buyDate: date };
    } else if (j.action === 'sell') {
      trades.push({ buyDate: pos.buyDate, buyPrice: pos.avgPrice, sellDate: date, sellPrice: price, qty: pos.qty, reason: j.reason, pnl: Math.round((price - pos.avgPrice) * pos.qty) });
      pos = null;
    }
  }
  if (pos) {
    const price = closes[closes.length - 1];
    trades.push({ buyDate: pos.buyDate, buyPrice: pos.avgPrice, sellDate: null, sellPrice: price, qty: pos.qty, reason: '保有中', pnl: Math.round((price - pos.avgPrice) * pos.qty) });
  }
  const q0 = buyQty(st.maxPerSymbol, closes[start]);
  const w = state.watchlist.find(x => x.code === code);
  return {
    code, name: w ? w.name : d.name,
    from: d.bars[start].date, to: d.bars[closes.length - 1].date,
    trades,
    totalPnl: trades.reduce((a, t) => a + t.pnl, 0),
    wins: trades.filter(t => t.pnl > 0).length,
    losses: trades.filter(t => t.pnl <= 0).length,
    buyHoldPnl: Math.round((closes[closes.length - 1] - closes[start]) * q0),
    series: d.bars.slice(start).map(b => ({ d: b.date, c: b.close })),
  };
}

module.exports = {
  tick, view, updateSettings, setRunning, addWatch, removeWatch, sellAll, reset, backtest,
  isMarketOpen, getState: () => state,
};
