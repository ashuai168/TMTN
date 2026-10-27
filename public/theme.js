// 主题切换：<html data-theme="…">，颜色在 theme.css 里覆盖 CSS 变量；选择记在 localStorage.tmtnTheme
// 普通 <script>（不是 module），放在 <head> 里同步执行，刷新时不会先闪一下老主题
(() => {
  const THEMES = [
    { id: 'classic', name: '经典深色' },   // 默认 = 原来的主题（不设 data-theme）
    { id: 'new', name: '新配色' },
  ];
  const KEY = 'tmtnTheme';
  const root = document.documentElement;
  const get = () => { try { const v = localStorage.getItem(KEY); return THEMES.some((t) => t.id === v) ? v : 'classic'; } catch { return 'classic'; } };
  const apply = (id) => {
    if (id === 'classic') delete root.dataset.theme; else root.dataset.theme = id;
    const btn = document.getElementById('themeBtn');
    if (btn) { const t = THEMES.find((x) => x.id === id); btn.title = `主题：${t.name}（点击切换）`; btn.dataset.cur = id; const n = btn.querySelector('.theme-n'); if (n) n.textContent = t.name; }
    window.dispatchEvent(new CustomEvent('tmtn-theme', { detail: id }));
  };
  const set = (id) => { try { localStorage.setItem(KEY, id); } catch { /* 无痕模式就只管这一页 */ } apply(id); };
  const next = () => { const i = THEMES.findIndex((t) => t.id === get()); set(THEMES[(i + 1) % THEMES.length].id); };
  window.TMTN_THEME = { list: THEMES, get, set, next };
  apply(get());
  // 顶栏按钮：插在「打赏作者」前面
  const mount = () => {
    if (document.getElementById('themeBtn')) return;
    const b = document.createElement('button');
    b.id = 'themeBtn'; b.type = 'button'; b.className = 'pill theme-btn';
    b.innerHTML = '<span aria-hidden="true">🎨</span><span class="theme-n">主题</span>';
    b.addEventListener('click', next);
    const at = document.getElementById('donateBtn');
    if (at) at.before(b); else document.querySelector('.topbar')?.append(b);
    apply(get());
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
  // 别的标签页改了主题，这边跟着变
  window.addEventListener('storage', (e) => { if (e.key === KEY) apply(get()); });
})();
