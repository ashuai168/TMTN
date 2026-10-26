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
