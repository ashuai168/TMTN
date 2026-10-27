// Gang 新盘狙击：gang.fun 上出现新币（链上创建事件，GangChain 订阅，出块后约 1 秒）时，用选中的钱包各买总量的 N%（默认 1%，合约本身限制每个钱包最多 1%）。
// jak 2026-10-27 明确要求的功能；安全规则照跟单：
//   - 默认「关闭」+「模拟」（只记录会买多少，不下单），都要本人在页面上打开；有「急停」按钮（立刻关闭）；
//   - 服务器端强制上限：每个钱包单笔 BNB、每天合计 BNB（所有钱包加起来）、每天最多狙几个币；另外还受交易设置里的单笔上限约束；
//   - 只狙「刚创建」的盘（发现时间晚于 maxDelaySec 的不买）、已被买走太多的不买、屏蔽的开发者不买；
//   - 每一次决定（下单 / 模拟 / 跳过及原因）都写进记录，并推给页面弹提示。
// 下单走 placeOrder（和页面、跟单同一条路：多钱包、登录检查、地址锁定、单笔上限都照常），来源记为「狙击 Gang」。
// 速度：直接挂在 GangChain 的 token 事件上（不等接口）；按曲线公式一次算出买 N% 要多少 BNB（不走 costForPct 的多轮试算）；
// 记住这个币在哪个 pad 上，下单时少一次探测；钱包里已有够用的 WBNB 并且已授权时，只发 buy 一笔交易。
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { ethers } from 'ethers';
import { dataFile } from './config.js';
import { GANG_V2_LAUNCHPAD } from './gangChain.js';

const STATE = dataFile('snipe.json'), LOG = dataFile('snipe-log.jsonl');
const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { try { mkdirSync(new URL('.', f), { recursive: true }); writeFileSync(f, JSON.stringify(v, null, 1)); } catch { /* ignore */ } };
const append = (f, v) => { try { mkdirSync(new URL('.', f), { recursive: true }); appendFileSync(f, JSON.stringify(v) + '\n'); } catch { /* ignore */ } };
const day = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 10);
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const VT = 1066666666666666666666666667n, BPS = 10000n, FEE = 100n, SUPPLY = 10n ** 27n;   // LaunchpadV2：虚拟代币储备、1% 平台费、总量 10 亿
const ceil = (a, b) => (a + b - 1n) / b;
export const HARD_MAX_BUY = 0.3;   // 无论参数怎么填，每个钱包单笔不超过 0.3 BNB

export const SNIPE_DEFAULTS = {
  pct: 1, wallets: [1, 2], quotes: ['BNB'], maxBnbPerBuy: 0.08, dailyCapBnb: 0.5, maxTokensPerDay: 5,
  maxDelaySec: 8, maxSoldPct: 15, partial: true, slippage: 15, buffer: 5, dryRun: true,
};

// 曲线上从已卖出 sold 再买 tokens 个，要付多少报价币（含 1% 平台费）。和 gangV2Pads.buyQuote 同一套公式
export function costFor({ virtualQuote, realQuote = 0n, sold = 0n }, tokens) {
  const vq = BigInt(virtualQuote), k = vq * VT, qR = vq + BigInt(realQuote), tR = VT - BigInt(sold);
  if (tokens >= tR) return null;
  const net = ceil(k, tR - tokens) - qR;
  return ceil(net * BPS, BPS - FEE);
}

export class Sniper extends EventEmitter {
  constructor({ market, trader, placeOrder, isBlocked, log }) {
    super();
    Object.assign(this, { market, trader, placeOrder, isBlocked: isBlocked || (() => false), logFn: log || (() => {}) });
    const s = readJson(STATE, {});
    this.enabled = s.enabled === true; this.params = this.clean({ ...SNIPE_DEFAULTS, ...(s.params || {}) });
    this.days = s.days || {}; this.done = s.done || {};   // done：已经处理过（下单 / 模拟）的币，不重复狙
    this.stats = { sims: 0, orders: 0, fails: 0, bnb: 0, ...(s.stats || {}) };
    this.recent = [];   // 最近发现的新盘和当时买 N% 的成本（页面上显示，帮着定上限）
    this.log = []; try { this.log = readFileSync(LOG, 'utf8').trim().split('\n').slice(-300).map((l) => JSON.parse(l)).reverse(); } catch { /* 第一次 */ }
    for (const r of this.log) if (r.cost != null && this.recent.length < 20) this.recent.push({ ts: r.ts, token: r.token, symbol: r.symbol, quote: r.quote, costBnb: r.cost, soldPct: r.soldPct });
    market.gangChain?.on('token', (it) => this.onLaunch(it).catch((e) => this.record(it, 'error', `出错：${e.message}`)));
    if (this.enabled) this.logFn(`[狙击] 启动时已开启（${this.params.dryRun ? '模拟' : '真实下单'}）`);
    // 开着的时候每 10 秒碰一下交易节点：连接保持热的，新盘出现时第一次读曲线约 0.13 秒（冷连接要 0.7～1 秒）
    setInterval(() => { if (this.enabled) this.trader.gangV2?.provider?.getBlockNumber?.().catch(() => {}); }, 10_000).unref?.();
  }

  clean(p) {
    const n = (v, d, lo = 0, hi = 1e9) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
    return {
      pct: n(p.pct, 1, 0.01, 1), wallets: (Array.isArray(p.wallets) ? p.wallets : [1]).map(Number).filter((x) => x > 0),
      quotes: (Array.isArray(p.quotes) ? p.quotes : ['BNB']).map((x) => String(x).toUpperCase().slice(0, 12)).filter(Boolean),   // 报价币符号；'*' = 全部（非 BNB 盘要先用 baw 换报价币，慢几秒）
      maxBnbPerBuy: n(p.maxBnbPerBuy, 0.08, 0, HARD_MAX_BUY), dailyCapBnb: n(p.dailyCapBnb, 0.5, 0, 20), maxTokensPerDay: Math.round(n(p.maxTokensPerDay, 5, 0, 200)),
      maxDelaySec: n(p.maxDelaySec, 8, 1, 120), maxSoldPct: n(p.maxSoldPct, 15, 0, 80), partial: p.partial !== false, slippage: n(p.slippage, 15, 1, 50), buffer: n(p.buffer, 5, 0, 30), dryRun: p.dryRun !== false,
    };
  }
  save() {
    const cut = Date.now() - 3 * 86400_000; for (const [k, v] of Object.entries(this.done)) if (v < cut) delete this.done[k];
    for (const d of Object.keys(this.days)) if (d < day(cut - 30 * 86400_000)) delete this.days[d];
    writeJson(STATE, { enabled: this.enabled, params: this.params, days: this.days, done: this.done, stats: this.stats }); this.emit('state', this.view()); }
  // 今天的用量：真实和模拟分开记（模拟不占真实额度），按当前模式取
  today(sim = this.params.dryRun) { const d = (this.days[day()] ||= { bnb: 0, tokens: 0 }); if (!sim) return d; return (d.sim ||= { bnb: 0, tokens: 0 }); }
  view() { return { enabled: this.enabled, params: this.params, today: this.today(), stats: this.stats, recent: this.recent.slice(0, 20), typical: this.typical(), hardMax: HARD_MAX_BUY, liveTrade: !this.trader?.status?.dryRun }; }
  setEnabled(v) { this.enabled = !!v; this.save(); this.logFn(`[狙击] ${this.enabled ? `已开启（${this.params.dryRun ? '模拟' : '真实下单'}）` : '已关闭'}`); return this.view(); }
  update(params) { this.params = this.clean({ ...this.params, ...(params || {}) }); this.save(); return this.view(); }

  // BNB 盘（虚拟储备 5 BNB）的参考成本：前面已经被买走 0% / 5% / 10% / 20% 时，再买 N% 要多少 BNB
  typical() {
    const tok = (SUPPLY * BigInt(Math.round(this.params.pct * 100))) / 10000n;
    const vq = 5n * 10n ** 18n;
    return [0, 5, 10, 20].map((s) => { const sold = (SUPPLY * BigInt(s)) / 100n, realQuote = ceil(vq * VT, VT - sold) - vq; return { soldPct: s, bnb: +Number(ethers.formatEther(costFor({ virtualQuote: vq, realQuote, sold }, tok))).toFixed(4) }; });
  }

  record(it, kind, reason, extra = {}) {
    const row = { ts: Date.now(), kind, reason, token: it?.address, symbol: it?.symbol, quote: it?.quoteSymbol, dryRun: this.params.dryRun, ...extra };
    this.log.unshift(row); if (this.log.length > 500) this.log.length = 500; append(LOG, row); this.emit('log', row);
    return row;
  }

  async onLaunch(it) {
    if (!this.enabled) return;
    const p = this.params, t0 = Date.now(), delay = (it.seenAt - it.createdAt * 1000) / 1000;
    if (this.done[it.address]) return;
    if (it.track !== 'v2') return this.record(it, 'skip', 'Gang 老盘（0x315B）不狙');
    if (!p.quotes.includes('*') && !p.quotes.includes(String(it.quoteSymbol || '').toUpperCase())) return this.record(it, 'skip', `报价币 ${it.quoteSymbol} 不在狙击范围（${p.quotes.join(' / ')}）`);
    if (delay > p.maxDelaySec) return this.record(it, 'skip', `发现太晚（出块后 ${delay.toFixed(1)} 秒 > ${p.maxDelaySec} 秒）`);
    if (this.isBlocked({ address: it.address, creator: it.creator })) return this.record(it, 'skip', '代币或开发者在屏蔽列表里');
    const td = this.today();
    if (p.maxTokensPerDay > 0 && td.tokens >= p.maxTokensPerDay) return this.record(it, 'skip', `今天已狙 ${td.tokens} 个（上限 ${p.maxTokensPerDay}）`);
    // 曲线状态 → 买 N% 要多少报价币 → 换成 BNB
    const gv = this.trader.gangV2; gv.pads.set(it.address, GANG_V2_LAUNCHPAD);   // 新盘都建在 0x1B8F 上，下单时不用再挨个 pad 探测
    const { c } = await gv.curve(it.address);
    const soldPct = Number((BigInt(c.sold) * 10000n) / SUPPLY) / 100;
    const tokens = (SUPPLY * BigInt(Math.round(p.pct * 100))) / 10000n;
    const qCost = costFor(c, tokens); if (qCost == null) return this.record(it, 'skip', '曲线上剩余不够');
    const wb = String(c.quote).toLowerCase() === WBNB || c.quote === ethers.ZeroAddress;
    const rate = wb ? 1 : await gv.quoteRate(c.quote);   // 1 BNB = rate 个报价币
    const dec = wb ? 18 : await gv.decimals(c.quote);
    const cost = Number(ethers.formatUnits(qCost, dec)) / (rate || Infinity);
    this.recent.unshift({ ts: Date.now(), token: it.address, symbol: it.symbol, quote: it.quoteSymbol, costBnb: +cost.toFixed(5), soldPct }); if (this.recent.length > 20) this.recent.length = 20;
    if (!(cost > 0)) return this.record(it, 'skip', '拿不到报价币汇率，算不出成本', { soldPct });
    if (soldPct > p.maxSoldPct) return this.record(it, 'skip', `发现时已被买走 ${soldPct.toFixed(1)}%（上限 ${p.maxSoldPct}%）`, { cost, soldPct });
    // 每个钱包买 cost ×（1 + 缓冲）：同一区块里别人（包括我们另一个钱包）先买了价格会高一点；多出来的报价币合约退回，留在钱包
    let amt = cost * (1 + p.buffer / 100) * (wb ? 1 : 1.03), note = '';
    const cap = Math.min(p.maxBnbPerBuy, HARD_MAX_BUY, Number(this.trader.status?.maxTradeBnb) || HARD_MAX_BUY);
    if (amt > cap) { if (!p.partial) return this.record(it, 'skip', `买 ${p.pct}% 要 ${amt.toFixed(4)} BNB，超过单笔上限 ${cap}`, { cost, soldPct }); note = `（超过单笔上限，只买 ${cap} BNB ≈ ${(p.pct * cap / amt).toFixed(2)}%）`; amt = cap; }
    const nW = p.wallets.length || 1;
    if (p.dailyCapBnb > 0 && td.bnb + amt * nW > p.dailyCapBnb + 1e-9) return this.record(it, 'skip', `今天已用 ${td.bnb.toFixed(4)} BNB，再买 ${(amt * nW).toFixed(4)} 会超过每天上限 ${p.dailyCapBnb}`, { cost, soldPct });
    amt = +amt.toFixed(6);
    // 先占额度（成交 / 待确认算花掉，失败的退回），避免连着几个新盘同时超限
    this.done[it.address] = Date.now(); td.tokens++; td.bnb += amt * nW;
    const base = { cost: +cost.toFixed(6), soldPct, amount: amt, wallets: p.wallets, delayMs: Date.now() - it.createdAt * 1000, calcMs: Date.now() - t0 };
    if (p.dryRun) {
      this.stats.sims++; this.save();
      return this.record(it, 'sim', `模拟买入：每个钱包 ${amt} BNB × ${nW} 个钱包（买 ${p.pct}% 约 ${cost.toFixed(4)} BNB，发现时已卖出 ${soldPct.toFixed(1)}%）${note}`, base);
    }
    this.save();
    this.emit('fire', { ...base, token: it.address, symbol: it.symbol });
    const list = [].concat(await this.placeOrder({ token: it.address, side: 'buy', amount: amt, slippage: p.slippage, slots: p.wallets, source: '狙击 Gang' }).catch((e) => [{ status: 'failed', reason: e.message }]) || []);
    const ok = list.filter((o) => o?.status === 'filled' || o?.status === 'pending');
    const refund = amt * (nW - ok.length); if (refund > 0) td.bnb = Math.max(0, td.bnb - refund);
    if (!ok.length) td.tokens = Math.max(0, td.tokens - 1);
    this.stats.orders += ok.length; this.stats.fails += list.length - ok.length; this.stats.bnb += amt * ok.length; this.save();
    return this.record(it, ok.length ? 'order' : 'fail', `狙击买入 ${amt} BNB${note}：${list.map((o) => `${o.wallet || ''} ${o.status === 'filled' ? '成交' : o.status === 'pending' ? '已提交待确认（已计入额度）' : '失败 ' + (o.reason || '')}`).join('；')}`,
      { ...base, totalMs: Date.now() - it.createdAt * 1000, results: list.map((o) => ({ wallet: o.wallet, status: o.status, tx: o.tx, reason: o.reason, out: o.out, latencyMs: o.latencyMs })) });
  }
}
