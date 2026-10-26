// 计价币兑换路线表（data/quote-routes.json）：BNB ↔ 计价币是直接换，还是要经过 USDT（Ondo 代币化股票只允许和稳定币直接换）。
// 先用实测结果（只报价）预置，运行中自动发现并记住；兑换报「必须有稳定币」的错时会改成经 USDT 并保存。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dataFile } from './config.js';

const FILE = dataFile('quote-routes.json');
let table = null;
const load = () => { if (table) return table; try { table = JSON.parse(readFileSync(FILE, 'utf8')) || {}; } catch { table = {}; } return table; };
export function getRoute(addr) { return load()[String(addr).toLowerCase()] || null; }
export function setRoute(addr, route) {
  const k = String(addr).toLowerCase(), t = load(); t[k] = { ...(t[k] || {}), ...route, checkedAt: Date.now() };
  try { mkdirSync(new URL('.', FILE), { recursive: true }); writeFileSync(FILE, JSON.stringify(t, null, 1)); } catch { /* 写不了就只在内存里 */ }
}

// 流动性门槛：计价币最深的池子流动性低于这个值（美元）就拒绝兑换，避免在小池子里吃大滑点。可用 QUOTE_MIN_LIQ_USD 调整
export const MIN_LIQ_USD = Number(process.env.QUOTE_MIN_LIQ_USD || 20000);
// 最深池子的流动性：先看路线表（实测时记下的），没有就查一次 DexScreener 记下来（同一个币 6 小时内不重复查）
async function deepestLiq(addr) {
  const k = String(addr).toLowerCase(), r = getRoute(k);
  if (r?.liqUsd != null && Date.now() - (r.liqAt || 0) < 6 * 3600_000) return r;
  try {
    const j = await (await fetch('https://api.dexscreener.com/latest/dex/tokens/' + k, { signal: AbortSignal.timeout(6000) })).json();
    const pools = (j.pairs || []).filter((p) => p.chainId === 'bsc').map((p) => ({ pair: p.pairAddress, dex: p.dexId, labels: p.labels || [], liq: p.liquidity?.usd || 0, with: (p.baseToken.address.toLowerCase() === k ? p.quoteToken : p.baseToken).symbol })).sort((a, b) => b.liq - a.liq);
    setRoute(k, { liqUsd: pools[0]?.liq || 0, bestPool: pools[0] || null, liqAt: Date.now() });
  } catch { return r; }   // 查不到就按已有记录（没有记录则不拦）
  return getRoute(k);
}
export async function assertLiquid(addr, symbol) {
  const r = await deepestLiq(addr); symbol ||= r?.symbol || r?.bestPool && null || `计价币 ${String(addr).slice(0, 6)}…${String(addr).slice(-4)}`;
  if (r?.liqUsd != null && r.liqUsd < MIN_LIQ_USD) throw new Error(`${symbol} 最深的池子流动性只有 $${Math.round(r.liqUsd).toLocaleString('en-US')}（低于 $${MIN_LIQ_USD.toLocaleString('en-US')}），为避免在小池子里吃大滑点，拒绝兑换`);
  return r;
}
