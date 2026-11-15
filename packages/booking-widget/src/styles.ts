// ウィジェットの最小限の見た目（docs/DESIGN.md が決まるまで凝った見た目は作らない）。
// HP のほかの部分に影響しないよう、クラス名は zw- で始める。スマホの幅（320px〜）でも崩れないようにする
export const WIDGET_CSS = `
.zw-root { font-family: system-ui, sans-serif; line-height: 1.5; color: #222; max-width: 960px; margin: 0 auto; }
.zw-root *, .zw-root *::before, .zw-root *::after { box-sizing: border-box; }
.zw-root button { font: inherit; padding: 0.25em 0.75em; cursor: pointer; }
.zw-root button:disabled { cursor: not-allowed; }
.zw-guidance { margin: 0.5em 0; padding-left: 1.25em; font-size: 0.9em; }
.zw-calendar-header { display: flex; align-items: center; justify-content: space-between; gap: 0.5em; margin: 0.5em 0; }
.zw-month { margin: 0; font-size: 1.1em; }
.zw-status { margin: 0.5em 0; }
.zw-error, .zw-problems { color: #a00; }
.zw-grid { width: 100%; table-layout: fixed; border-collapse: collapse; }
.zw-grid th { font-size: 0.85em; font-weight: normal; padding: 0.25em 0; }
.zw-cell { border: 1px solid #ccc; vertical-align: top; padding: 2px; }
.zw-cell-inner { height: 9em; overflow: hidden; }
.zw-outside { background: #f4f4f4; }
.zw-past { background: #fafafa; color: #888; }
.zw-today .zw-day { font-weight: bold; text-decoration: underline; }
.zw-selected { outline: 2px solid #333; outline-offset: -2px; }
.zw-root .zw-day { border: none; background: none; padding: 0 0.25em; font-size: 0.9em; }
.zw-bookings { list-style: none; margin: 0; padding: 0; }
.zw-booking { font-size: 0.75em; line-height: 1.3; overflow-wrap: anywhere; margin-bottom: 1px; }
.zw-root .zw-more { border: none; background: none; padding: 0; font-size: 0.75em; text-decoration: underline; }
.zw-daylist { border: 1px solid #333; background: #fff; padding: 0.75em; margin: 0.75em 0; }
.zw-daylist h4 { margin: 0 0 0.5em; }
.zw-daylist ul { margin: 0 0 0.5em; padding-left: 1.25em; }
.zw-daylist .zw-booking { font-size: 1em; }
.zw-actions { display: flex; flex-wrap: wrap; gap: 0.5em; }
.zw-form { margin-top: 1.5em; }
.zw-form fieldset { border: 1px solid #ccc; margin: 0 0 1em; padding: 0.75em; min-width: 0; }
.zw-row { margin: 0.5em 0; }
.zw-label { display: block; font-weight: bold; margin-bottom: 0.25em; }
.zw-form input[type="text"], .zw-form input[type="email"], .zw-form input[type="tel"], .zw-form input[type="date"],
.zw-form select, .zw-form textarea { font: inherit; width: 100%; max-width: 28em; padding: 0.3em; }
.zw-choice { display: flex; align-items: flex-start; gap: 0.4em; margin: 0.25em 0; }
.zw-choice input { margin-top: 0.3em; }
.zw-required { font-size: 0.75em; color: #a00; border: 1px solid #a00; padding: 0 0.3em; font-weight: normal; }
.zw-note { font-size: 0.85em; color: #555; }
.zw-info { background: #f2f6ff; border-left: 4px solid #36c; padding: 0.5em; }
.zw-estimate { margin-top: 0.75em; }
.zw-submit { font-size: 1.1em; }
.zw-receipt { font-size: 1.4em; font-weight: bold; letter-spacing: 0.1em; }
@media (max-width: 600px) {
  .zw-cell { padding: 1px; }
  .zw-cell-inner { height: 10.5em; }
  .zw-booking, .zw-root .zw-more { font-size: 0.6em; }
  .zw-grid th { font-size: 0.75em; }
}
`;
