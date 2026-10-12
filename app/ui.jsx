// 全局设计系统:TrackPoint 应用全部 UI 的视觉规范。
// Polaris web components(s-*)是 shadow DOM 无法深度定制,这里用自建 tp-* 体系:
// 自绘导航/卡片/表格/表单/徽章,仅保留 App Bridge 的 toast。在 app.jsx 布局渲染一次。
const css = `
body {
  margin: 0;
  background: #f5f5f7;
  color: #1f1f23;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI",
    "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  font-size: 13px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
*, *::before, *::after { box-sizing: border-box; }
button { font-family: inherit; }

/* ---------- 顶部导航 ---------- */
.tp-nav { background: #fff; border-bottom: 1px solid #e6e6ea; position: sticky; top: 0; z-index: 20; }
.tp-nav__inner {
  max-width: 1100px; margin: 0 auto; padding: 0 32px;
  display: flex; align-items: center; gap: 20px; height: 52px;
}
.tp-nav__brand {
  font-weight: 700; font-size: 14px; color: #101014; letter-spacing: -0.01em;
  display: flex; align-items: center; gap: 8px;
}
.tp-nav__dot { width: 9px; height: 9px; border-radius: 99px; background: linear-gradient(135deg, #6366f1, #a855f7); }
.tp-nav__links { display: flex; gap: 4px; margin-left: 10px; }
.tp-nav__links a {
  padding: 6px 13px; border-radius: 8px; font-size: 13px; font-weight: 500;
  color: #55565b; text-decoration: none; transition: all 0.15s;
}
.tp-nav__links a:hover { background: #f2f2f5; color: #101014; }
.tp-nav__links a.active { background: #101014; color: #fff; }
.tp-nav__shop { margin-left: auto; font-size: 12px; color: #8a8b90; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* 视觉隐藏的 file input(用 label 触发,保留原生校验) */
.tp-filehide { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }

/* ---------- 页面骨架(底部留白避开 Sidekick 悬浮球) ---------- */
.tp-page { max-width: 1100px; margin: 0 auto; padding: 26px 32px 110px; }
.tp-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 22px; }
.tp-header h1 { margin: 0 0 4px; font-size: 21px; font-weight: 700; letter-spacing: -0.02em; color: #101014; }
.tp-header .tp-sub { margin: 0; color: #67686d; font-size: 13px; max-width: 620px; }
.tp-header__actions { display: flex; gap: 8px; flex-shrink: 0; }
.tp-back { display: inline-block; font-size: 12px; color: #8a8b90; text-decoration: none; margin-bottom: 6px; }
.tp-back:hover { color: #101014; }

/* ---------- 统计卡片 ---------- */
.tp-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 20px; }
.tp-stat {
  background: #fff; border: 1px solid #e6e6ea; border-radius: 12px; padding: 14px 18px;
  box-shadow: 0 1px 2px rgba(16, 16, 20, 0.03);
}
.tp-stat__num { font-size: 23px; font-weight: 700; letter-spacing: -0.02em; color: #101014; }
.tp-stat__label { font-size: 12px; color: #77787d; margin-top: 1px; }

/* ---------- 分段页签 ---------- */
.tp-tabs { display: inline-flex; background: #ebebee; border-radius: 10px; padding: 3px; gap: 2px; margin-bottom: 18px; flex-wrap: wrap; }
.tp-tabs a {
  padding: 6px 15px; border-radius: 8px; font-size: 12.5px; font-weight: 500;
  color: #55565b; text-decoration: none; white-space: nowrap; transition: all 0.15s;
}
.tp-tabs a:hover { color: #101014; }
.tp-tabs a.active { background: #fff; color: #101014; font-weight: 600; box-shadow: 0 1px 3px rgba(16, 16, 20, 0.12); }

/* ---------- 卡片 ---------- */
.tp-card {
  background: #fff; border: 1px solid #e6e6ea; border-radius: 12px; margin-bottom: 18px;
  box-shadow: 0 1px 2px rgba(16, 16, 20, 0.03), 0 12px 32px -18px rgba(16, 16, 20, 0.12);
  overflow: hidden;
}
.tp-card__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 16px 20px 10px; }
.tp-card__title { font-size: 14px; font-weight: 650; color: #101014; margin: 0; }
.tp-card__desc { margin: 3px 0 0; font-size: 12.5px; color: #76777c; }
.tp-card__body { padding: 8px 20px 20px; }

/* ---------- 表格(自绘:列宽/hover/省略全可控) ---------- */
.tp-table { width: 100%; border-collapse: collapse; }
.tp-table th {
  text-align: left; font-size: 11.5px; font-weight: 600; letter-spacing: 0.03em;
  color: #6f7075; padding: 9px 14px; border-bottom: 1px solid #ececef; background: #fafafb;
}
.tp-table td { padding: 11px 14px; border-bottom: 1px solid #f1f1f3; font-size: 13px; color: #26262b; vertical-align: middle; }
.tp-table tbody tr:last-child td { border-bottom: none; }
.tp-table tbody tr { transition: background 0.12s; }
.tp-table tbody tr:hover { background: #fafafc; }
.tp-table td.actions, .tp-table th.actions { text-align: right; }
.tp-table td.actions { white-space: nowrap; }
.tp-table td.actions form { display: inline-flex; }
.tp-pagination {
  display: flex; align-items: center; justify-content: flex-end; gap: 10px;
  padding: 12px 14px; border-top: 1px solid #f1f1f3;
}
.tp-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px; color: #7a7b80; max-width: 260px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* ---------- 徽章 ---------- */
.tp-badge {
  display: inline-flex; align-items: center; padding: 2px 9px; border-radius: 999px;
  font-size: 11.5px; font-weight: 600; white-space: nowrap;
}
.tp-badge--success { background: #e5f3ea; color: #0c6b3e; }
.tp-badge--neutral { background: #efeff2; color: #6a6b70; }
.tp-badge--info { background: #e7f1fe; color: #1d5fb8; }
.tp-badge--critical { background: #fbe9e9; color: #b34141; }
.tp-badge--purple { background: #f3e8ff; color: #7c3aed; }
.tp-badge--teal { background: #dff5f0; color: #0e7490; }

/* ---------- 按钮 ---------- */
.tp-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 34px; padding: 0 16px; border-radius: 9px; font-size: 13px; font-weight: 600;
  cursor: pointer; border: 1px solid #d8d8dd; background: #fff; color: #26262b;
  transition: all 0.15s; text-decoration: none; white-space: nowrap;
}
.tp-btn:hover { background: #fafafa; border-color: #c2c2c8; }
.tp-btn:active { transform: translateY(0.5px); }
.tp-btn:disabled { opacity: 0.55; cursor: default; transform: none; }
.tp-btn--primary { background: #101014; border-color: #101014; color: #fff; box-shadow: 0 1px 2px rgba(16, 16, 20, 0.25); }
.tp-btn--primary:hover { background: #2b2b31; border-color: #2b2b31; }
.tp-btn--ghost { border-color: transparent; background: transparent; color: #4f46e5; padding: 0 10px; height: 30px; }
.tp-btn--ghost:hover { background: #eef0fe; }
.tp-btn--danger { border-color: transparent; background: transparent; color: #b34141; padding: 0 10px; height: 30px; }
.tp-btn--danger:hover { background: #fdeeec; }
.tp-btn--sm { height: 29px; padding: 0 12px; font-size: 12.5px; }

.tp-link { color: #4f46e5; text-decoration: none; font-weight: 600; font-size: 12.5px; white-space: nowrap; }
.tp-link:hover { text-decoration: underline; }

/* ---------- 横幅 ---------- */
.tp-banner { padding: 12px 16px; border-radius: 10px; font-size: 12.5px; margin-bottom: 18px; border: 1px solid; line-height: 1.6; }
.tp-banner--info { background: #eef1fe; border-color: #d6dcfb; color: #3d47b0; }
.tp-banner--warning { background: #fdf6e7; border-color: #f3e3b3; color: #8a6116; }

/* ---------- 表单 ---------- */
.tp-input, .tp-select {
  height: 34px; padding: 0 12px; font-size: 13px; font-family: inherit;
  color: #26262b; background: #fff; border: 1px solid #d8d8dd; border-radius: 9px;
  min-width: 0; width: 100%; transition: border-color 0.15s, box-shadow 0.15s;
}
.tp-input:hover, .tp-select:hover { border-color: #b8b8bf; }
.tp-input:focus, .tp-select:focus { outline: none; border-color: #4f46e5; box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.12); }
.tp-input::placeholder { color: #a5a6ab; }
.tp-input[type="file"] { height: auto; padding: 6px 10px; }
.tp-select {
  appearance: none; padding-right: 32px; cursor: pointer;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%2377777c' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 12px center;
}
.tp-field { display: flex; flex-direction: column; gap: 6px; }
.tp-field__label { font-size: 12px; font-weight: 600; color: #45464b; }
.tp-field__hint { font-size: 11.5px; color: #8a8b90; }
.tp-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
@media (max-width: 720px) { .tp-form-grid { grid-template-columns: 1fr; } }

/* ---------- 分段选择器 ---------- */
.tp-seg { display: inline-flex; background: #ebebee; border-radius: 9px; padding: 3px; gap: 2px; }
.tp-seg button {
  border: none; background: transparent; padding: 6px 15px; font-size: 12.5px; font-weight: 500;
  color: #55565b; border-radius: 7px; cursor: pointer; transition: all 0.15s;
}
.tp-seg button:hover { color: #101014; }
.tp-seg button.is-active { background: #fff; color: #101014; font-weight: 600; box-shadow: 0 1px 3px rgba(16, 16, 20, 0.12); }

/* ---------- 参数编辑器 ---------- */
.tp-params-box { border: 1px solid #ececef; border-radius: 10px; padding: 14px; background: #fafafb; }
.tp-params-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.tp-param-row {
  display: grid;
  grid-template-columns: minmax(130px, 170px) minmax(120px, 160px) minmax(200px, 1fr) minmax(110px, 140px) auto;
  gap: 8px; align-items: center; margin-bottom: 8px;
}
@media (max-width: 780px) { .tp-param-row { grid-template-columns: 1fr 1fr; } }

/* ---------- 公共组件导入行 ---------- */
.tp-component-list { display: flex; flex-direction: column; gap: 8px; max-height: 300px; overflow-y: auto; padding: 2px; }
.tp-component-row {
  display: flex; align-items: center; gap: 10px; padding: 9px 13px;
  border: 1px solid #e6e6ea; border-radius: 10px; background: #fff; cursor: pointer;
  transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
}
.tp-component-row:hover { border-color: #c9c9d0; background: #fafafc; box-shadow: 0 1px 2px rgba(16, 16, 20, 0.04); }
.tp-component-row .tp-name { font-weight: 600; color: #26262b; white-space: nowrap; font-size: 12.5px; }
.tp-component-row .tp-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px; color: #6a6b70; background: #f1f1f3;
  padding: 2px 8px; border-radius: 6px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 300px;
}
.tp-component-row .tp-muted { color: #8a8b90; font-size: 12px; white-space: nowrap; }

/* ---------- 产品选择器(规则绑定的限定产品) ---------- */
.tp-product-search { display: flex; gap: 8px; }
.tp-product-search .tp-input { flex: 1; }
.tp-product-results {
  display: flex; flex-direction: column; gap: 6px; margin-top: 8px;
  max-height: 220px; overflow-y: auto; padding: 2px;
}
.tp-product-row {
  display: flex; align-items: center; gap: 10px; padding: 8px 12px;
  border: 1px solid #e6e6ea; border-radius: 9px; background: #fff;
  transition: border-color 0.15s, background 0.15s;
}
.tp-product-row:hover { border-color: #c9c9d0; background: #fafafc; }
.tp-product-row .tp-name {
  font-weight: 600; color: #26262b; font-size: 12.5px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.tp-product-add { margin-left: auto; flex-shrink: 0; }
.tp-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.tp-chip__x {
  border: none; background: transparent; color: inherit; cursor: pointer;
  padding: 0 0 0 3px; font-size: 13px; line-height: 1; opacity: 0.65;
}
.tp-chip__x:hover { opacity: 1; }

/* ---------- 通用 ---------- */
.tp-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.tp-muted { color: #6d7175; font-size: 12.5px; }
.tp-chip {
  display: inline-flex; align-items: center; padding: 2px 9px; border-radius: 999px;
  background: #efeff2; color: #55565b; font-size: 11.5px; font-weight: 500; white-space: nowrap;
}
.tp-check {
  appearance: none; width: 16px; height: 16px; flex-shrink: 0;
  border: 1.5px solid #c2c2c8; border-radius: 5px; background: #fff;
  cursor: pointer; position: relative; transition: all 0.15s;
}
.tp-check:hover { border-color: #8f8f96; }
.tp-check:checked { background: #101014; border-color: #101014; }
.tp-check:checked::after {
  content: ""; position: absolute; left: 4px; top: 1.5px; width: 4px; height: 8px;
  border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(45deg);
}
.tp-check-label { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; color: #45464b; cursor: pointer; }
.tp-empty { text-align: center; color: #8a8b90; padding: 40px 16px; font-size: 12.5px; }
.tp-empty b { display: block; font-size: 13.5px; color: #45464b; margin-bottom: 4px; font-weight: 650; }
`;

export function GlobalStyles() {
  return <style>{css}</style>;
}
