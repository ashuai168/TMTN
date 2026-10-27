// Flap 普通 Portal（v5.27+，0xe2cE…9De0）的「Agent ID 门槛」盘（NFT-gated，2026-10-24 上线）：
// 发币时 Portal 发 FlapNFTGated(token, nft)（data 里，没有 indexed）。还在内盘（getTokenV8Safe.status = 1）时，
// 每笔买卖都要 tx.origin 持有这个 NFT 集合里至少 1 个（不看具体 tokenId）；每个 tx.origin 最多买总量 2%（buyQuotaOf）。
// 迁移（status = 4，LaunchedToDEX）以后门槛不再适用，外盘谁都能买。管理员可以去掉门槛（FlapNFTGateUpdated，newNft = 0），不能加。
// 依据：https://docs.utter.cash/en/docs/nft-gated ，并在链上核对过（2026-10-27）：
//   - 两个币安 Agentic 钱包地址都是普通 EOA（没有合约代码，不是 7702），baw contract-call 发出的交易 from 就是钱包地址 → tx.origin 满足；
//   - 两个钱包各持有 1 个 Binance Agent ID（SPACE ID Agent ID，0x60B9…022F）；
//   - 用钱包地址 eth_call 模拟 swapExactInput 能成交，用没有 NFT 的地址模拟回滚 NFTGatedOnly。
// quoteExactInput 不检查 NFT（只检查 2% 额度），所以下单前自己查 balanceOf，再用 from = 钱包 模拟一遍。
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { ethers } from 'ethers';
import { dataFile, NODEREAL_WSS, ZERO } from './config.js';
import { WsLogs, PUBLIC_WSS } from './rpc.js';
import { capFor, capLabel, sendApproval } from './approvals.js';

export const FLAP_PORTAL = '0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0';
const T_GATED = '0x2179156b3d2ade0f0de96eff28a7c29d924002784e113e69108d91a02cbf9098';      // FlapNFTGated(address token, address nft)
const T_GATE_UPD = '0xef4dac2f9b1190c744c50eaead877aa2f222bafb1ef8bb2c60baed13f4b63cd8';   // FlapNFTGateUpdated(address token, address oldNft, address newNft)
const T_DEX = '0x6e4f47630b8745b8cacbd44f42a8a33e7eea7cc08ef22fc7630f4f385784ff7d';        // LaunchedToDEX(address token, address pool, uint256 amount, uint256 eth)
const TOPICS = [[T_GATED, T_GATE_UPD, T_DEX]];
const REG = dataFile('flapNftGated.json');
const BACKFILL = 450_000;   // 第一次启动往回补约 4 天（功能 10-24 才上线），之后从记下的区块接着补
export const AGENT_ID_NFT = '0x60b9262456de011f7d15a54cdd8c48baaa8b022f';   // Binance Agent ID（SPACE ID）

const iface = new ethers.Interface([
  'function nftGate(address token) view returns (address)',
  'function buyQuotaOf(address token, address origin) view returns (uint256 bought, uint256 remaining)',
  'function maxBuyPerOrigin(address token) view returns (uint16 bps, uint256 maxBuyAmount)',
  'function quoteExactInput((address inputToken, address outputToken, uint256 inputAmount) p) returns (uint256)',
  'function swapExactInput((address inputToken, address outputToken, uint256 inputAmount, uint256 minOutputAmount, bytes permitData) p) payable returns (uint256)',
  'error NFTGatedOnly(address wallet)', 'error BuyCapExceeded(address origin, uint256 held, uint256 cap)', 'error SlippageTooHigh(uint256 actual, uint256 minimum)', 'error TokenNotTradable(address token)',
]);
const erc = new ethers.Interface(['function name() view returns (string)', 'function symbol() view returns (string)', 'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function metaURI() view returns (string)', 'function tokenURI(uint256) view returns (string)']);
const coder = ethers.AbiCoder.defaultAbiCoder();
const f18 = (v) => Number(ethers.formatEther(v));
const minOut = (v, slippagePct) => (v * BigInt(10000 - Math.min(9900, Math.round(slippagePct * 100)))) / 10000n;
const ERR = { NFTGatedOnly: '钱包没有门槛 NFT（NFTGatedOnly）', BuyCapExceeded: '已到每个地址 2% 买入上限（BuyCapExceeded）', SlippageTooHigh: '滑点不够（SlippageTooHigh），重新报价再试', TokenNotTradable: '内盘已关闭（已迁移，TokenNotTradable）' };
const why = (e) => { const d = e?.data || e?.info?.error?.data; try { const p = d && iface.parseError(d); if (p) return ERR[p.name] || p.name; } catch { /* 不是已知错误 */ } return e?.shortMessage || e?.message || String(e); };

export class FlapNft extends EventEmitter {
  constructor(provider, send = null) {
    super();
    this.provider = provider; this.send = send;   // send = Portal.send（baw contract-call + 等上链），只有交易端传
    this.reg = (() => { try { return JSON.parse(readFileSync(REG, 'utf8')); } catch { return {}; } })();
    this.reg.tokens ||= {}; this.reg.nfts ||= {};
    this.holdCache = new Map();
    this.status = { connected: false, wss: null, lastBlock: this.reg.lastBlock || 0, lastLogAt: 0, gated: 0, lastError: null, pollError: null };
  }
  save() { try { mkdirSync(new URL('.', REG), { recursive: true }); writeFileSync(REG, JSON.stringify(this.reg)); } catch { /* ignore */ } }
  list() { return Object.values(this.reg.tokens); }
  get(token) { return this.reg.tokens[String(token || '').toLowerCase()] || null; }

  async start() {
    for (const g of this.list()) this.emit('gated', g, { restore: true });
    this.sub = new WsLogs({ label: 'flap-nft', urls: [...NODEREAL_WSS, PUBLIC_WSS], filters: [{ address: FLAP_PORTAL, topics: TOPICS }], onLog: (l) => this.handle(l), status: this.status }).start();
    this.pollLoop();
  }

  async pollLoop() {
    for (let first = true; ; first = false) {
      if (!first) await new Promise((r) => setTimeout(r, this.sub?.live ? 60_000 : 5_000));
      try {
        const head = await this.provider.getBlockNumber();
        let from = Math.max(this.status.lastBlock ? this.status.lastBlock + 1 : head - BACKFILL, head - BACKFILL);
        while (from <= head) {
          const to = Math.min(head, from + 4999);
          for (const l of await this.provider.getLogs({ address: FLAP_PORTAL, topics: TOPICS, fromBlock: from, toBlock: to })) this.handle(l);
          this.status.lastBlock = to; from = to + 1;
          if (to % 50_000 < 5000) { this.reg.lastBlock = to; this.save(); }   // 补历史时隔一段记一次进度，中途重启不用从头补
        }
        this.reg.lastBlock = this.status.lastBlock; this.save(); this.status.pollError = null;
      } catch (e) { this.status.pollError = String(e.shortMessage || e.message).slice(0, 160); }
    }
  }

  handle(l) {
    try {
      const t0 = l.topics[0];
      if (t0 === T_GATED) {
        const [token, nft] = coder.decode(['address', 'address'], l.data); const k = token.toLowerCase();
        if (this.reg.tokens[k]) return;
        const g = { token: k, nft: nft.toLowerCase(), block: l.blockNumber, tx: l.transactionHash, seenAt: Date.now(), at: null };
        this.reg.tokens[k] = g; this.status.gated++; this.save();
        this.emit('gated', g, { restore: false });
      } else if (t0 === T_GATE_UPD) {
        const [token, , newNft] = coder.decode(['address', 'address', 'address'], l.data); const g = this.get(token);
        if (g && newNft === ZERO && !g.removed) { g.removed = true; this.save(); this.emit('ungated', g); }
      } else if (t0 === T_DEX) {
        const [token] = coder.decode(['address', 'address', 'uint256', 'uint256'], l.data); const g = this.get(token);
        if (g && !g.dex) { g.dex = true; this.save(); this.emit('dex', g); }
      }
    } catch { /* 解析失败的跳过 */ }
  }

  async call(to, i, fn, args = [], from) { return i.decodeFunctionResult(fn, await this.provider.call({ to, from, data: i.encodeFunctionData(fn, args) })); }

  // getTokenV8Safe(token)：静态结构，按字（32 字节）读需要的字段（链上核对过）。0 状态 1=内盘 4=已迁移，1 储备（报价币），2 流通量，
  // 3 价格（报价币 wei / 个），8 迁移门槛（流通量），9 报价币地址，10 是否支持原生 BNB 自动换报价币，15 进度（1e18 = 100%）
  async state(token) {
    const raw = await this.provider.call({ to: FLAP_PORTAL, data: '0x62fafcca' + ethers.zeroPadValue(token, 32).slice(2) });
    const w = (i) => BigInt('0x' + raw.slice(2 + i * 64, 2 + (i + 1) * 64));
    const quote = ethers.getAddress('0x' + raw.slice(2 + 9 * 64 + 24, 2 + 10 * 64));
    return { status: Number(w(0)), reserve: w(1), circulating: w(2), price: w(3), dexThresh: w(8), quote, nativeSwap: w(10) !== 0n, progress: Number(w(15)) / 1e16 };
  }

  // 门槛还在吗（管理员可能去掉了）：nftGate(token)，0 = 不再有门槛
  async gateOf(token) { return (await this.call(FLAP_PORTAL, iface, 'nftGate', [token]))[0].toLowerCase(); }

  // 不在登记表里的地址（钱包 2 后端没订阅到、手动搜索的）：直接问 Portal，是门槛盘就补登记
  async check(token) {
    const k = String(token).toLowerCase(); if (this.reg.tokens[k]) return this.reg.tokens[k];
    let nft; try { nft = await this.gateOf(k); } catch { return null; }
    if (!nft || nft === ZERO) return null;
    const g = { token: k, nft, block: null, tx: null, seenAt: Date.now(), at: null };
    this.reg.tokens[k] = g; this.save(); this.emit('gated', g, { restore: true }); return g;
  }

  // NFT 集合信息（名字、代号、示例图片）。图片：Binance Agent ID 每个 NFT 一张名片，取最近一次转账的那个 tokenId 的图当示例
  async nftInfo(nft) {
    const k = nft.toLowerCase(), c = this.reg.nfts[k];
    if (c && (c.image || Date.now() - c.at < 6 * 3600_000)) return c;
    const [name, symbol] = await Promise.all([this.call(k, erc, 'name').then((r) => r[0]).catch(() => ''), this.call(k, erc, 'symbol').then((r) => r[0]).catch(() => '')]);
    let image = c?.image || null;
    try {
      const head = await this.provider.getBlockNumber();
      const ls = await this.provider.getLogs({ address: k, topics: [ethers.id('Transfer(address,address,uint256)')], fromBlock: head - 999, toBlock: head });
      const id = ls.length && ls.at(-1).topics[3] ? BigInt(ls.at(-1).topics[3]) : null;
      const uri = id != null ? (await this.call(k, erc, 'tokenURI', [id]))[0] : '';
      if (/^https:\/\//.test(uri)) { const j = await (await fetch(uri, { signal: AbortSignal.timeout(6000) })).json(); if (/^https:\/\//.test(j?.image || '')) image = j.image; }
    } catch { /* 没图就算了 */ }
    const v = { nft: k, name: k === AGENT_ID_NFT ? 'Binance Agent ID' : name || '未知 NFT', rawName: name, symbol, image, known: k === AGENT_ID_NFT, at: Date.now() };
    this.reg.nfts[k] = v; this.save(); return v;
  }

  // 这个地址持有几个门槛 NFT（30 秒缓存；force 时当场查）
  async holds(nft, wallet, force = false) {
    const key = `${nft}:${String(wallet).toLowerCase()}`, c = this.holdCache.get(key);
    if (!force && c && Date.now() - c.at < 30_000) return c.n;
    const n = Number((await this.call(nft, erc, 'balanceOf', [wallet]))[0]);
    this.holdCache.set(key, { n, at: Date.now() }); return n;
  }
  async quota(token, wallet) { const [bought, remaining] = await this.call(FLAP_PORTAL, iface, 'buyQuotaOf', [token, wallet]); return { bought, remaining, capped: remaining !== ethers.MaxUint256 }; }

  // 下单前的门槛检查：内盘 + 门槛还在 + 钱包没有 NFT → 返回原因（跳过，不报错）；能交易返回 null
  async block(token, wallet) {
    const g = this.get(token); if (!g || g.removed || g.dex) return null;
    const nft = await this.gateOf(token).catch(() => g.nft);
    if (!nft || nft === ZERO) { g.removed = true; this.save(); this.emit('ungated', g); return null; }
    const n = await this.holds(nft, wallet, true);
    if (n > 0) return null;
    const info = this.reg.nfts[nft]; return `跳过：这个币还在内盘，要求钱包持有 ${info?.name || nft} NFT 才能买卖，这个钱包（${wallet.slice(0, 6)}…${wallet.slice(-4)}）没有`;
  }

  async quoteBuy(token, wallet, amountBnb) {
    const value = ethers.parseEther(String(amountBnb));
    const out = (await this.call(FLAP_PORTAL, iface, 'quoteExactInput', [[ZERO, token, value]], wallet))[0];
    return { value, out };
  }
  async quoteSell(token, wallet, amount) { return (await this.call(FLAP_PORTAL, iface, 'quoteExactInput', [[token, ZERO, amount]], wallet))[0]; }
  async balance(token, wallet) { return (await this.call(token, erc, 'balanceOf', [wallet]))[0]; }

  // 发交易前用钱包地址 eth_call 跑一遍（tx.origin = 钱包，会检查 NFT 门槛 / 2% 上限），回滚就直接报原因，不花 gas
  async simulate(from, data, value) {
    try { return iface.decodeFunctionResult('swapExactInput', await this.provider.call({ from, to: FLAP_PORTAL, data, value }))[0]; }
    catch (e) { throw Object.assign(new Error(`链上模拟失败：${why(e)}`), { code: /NFTGatedOnly/.test(why(e)) ? 'NFT_GATE' : undefined }); }
  }

  // 只报价 + 模拟（不上链）
  async previewBuy({ wallet, token, amountBnb, step }) {
    const q = await this.quoteBuy(token, wallet, amountBnb);
    step(`Flap Portal 报价 ${f18(q.out).toFixed(0)} 个`, 0);
    const got = await this.simulate(wallet, iface.encodeFunctionData('swapExactInput', [[ZERO, token, q.value, 0n, '0x']]), q.value);
    step('链上模拟通过（tx.origin = 钱包，NFT 门槛满足）', 0);
    return { dryRun: true, venue: 'Flap Portal.swapExactInput（Agent ID 门槛，未上链）', expected: f18(got) };
  }

  // 买入：一笔 swapExactInput{value}（BNB 盘原子完成；非 BNB 报价币盘由 Portal 自己把 BNB 换成报价币）。到 2% 上限时只成交到上限，多余 BNB 同笔退回
  async buy({ wallet, token, amountBnb, slippage, step }) {
    const q = await this.quoteBuy(token, wallet, amountBnb);
    if (q.out <= 0n) throw new Error('报价为 0：可能已到每个地址 2% 上限');
    step(`Flap Portal 报价 ${f18(q.out).toFixed(0)} 个`, 0);
    const inputData = iface.encodeFunctionData('swapExactInput', [[ZERO, token, q.value, minOut(q.out, slippage), '0x']]);
    await this.simulate(wallet, inputData, q.value);
    const hash = await this.send({ wallet, to: FLAP_PORTAL, valueWei: q.value, inputData, label: 'Flap Portal.swapExactInput 买入', step });
    return { venue: 'Flap Portal.swapExactInput（Agent ID 门槛内盘，BNB）', expected: f18(q.out), txHash: hash, hashes: [hash] };
  }

  async sell({ wallet, token, pct, slippage, step }) {
    const bal = await this.balance(token, wallet);
    if (bal <= 0n) throw new Error('没有可卖出的余额');
    const amt = pct >= 100 ? bal : (bal * BigInt(Math.round(pct * 100))) / 10000n;
    step(`卖出 ${f18(amt).toFixed(0)} 个（持有 ${f18(bal).toFixed(0)}）`, 0);
    const hashes = [];
    const allowance = (await this.call(token, erc, 'allowance', [wallet, FLAP_PORTAL]))[0];
    if (allowance < amt) { const cap = await capFor({ token, wallet, amount: amt, kind: 'sell' }); hashes.push(await sendApproval({ send: (o) => this.send(o), wallet, token, spender: FLAP_PORTAL, amount: amt, cap, label: `授权卖出（${capLabel('sell')}）`, kind: 'sell', step })); }
    else step('授权额度够用，跳过授权', 0);
    const out = await this.quoteSell(token, wallet, amt);
    const inputData = iface.encodeFunctionData('swapExactInput', [[token, ZERO, amt, minOut(out, slippage), '0x']]);
    await this.simulate(wallet, inputData, 0n);
    hashes.push(await this.send({ wallet, to: FLAP_PORTAL, inputData, label: 'Flap Portal.swapExactInput 卖出', step }));
    return { venue: 'Flap Portal.swapExactInput（Agent ID 门槛内盘，卖出得 BNB）', expected: f18(out), txHash: hashes.at(-1), hashes };
  }
}
