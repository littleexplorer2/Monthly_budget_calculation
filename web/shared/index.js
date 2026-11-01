/* DOM、字符串、日期与展示常量。
 * 跨模块调用由 web/js/app.js 显式注入；模块只导出本职责的接口。
 */
(function register(registry) {
  'use strict';
  registry.shared = Object.freeze({
    dependencies: Object.freeze([]),
    create({  }, service = {}) {

      // 地点差异化配色（定居/旅居各地点颜色差别大，便于日历/列表/芯片区分）
      const LOC_COLORS = ['#2563eb', '#16a34a', '#ea580c', '#9333ea', '#0891b2', '#dc2626'];

      const EXTRA_CURRENCIES = ['CNY', 'HKD', 'USD'];

      // 额外预算固定币种，默认金额均为 0

      const $ = (sel, root = document) => root.querySelector(sel);

      const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

      /* --------------------------------------------------------------------------
       * 工具函数
       * ------------------------------------------------------------------------ */
      function esc(s) {
        return String(s).replace(/[&<>"']/g, (c) => (
          { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
        ));
      }

      function fmtMoney(n) {
        const v = Number(n);
        return Number.isFinite(v)
          ? v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
          : '-';
      }

      function pad2(n) { return String(n).padStart(2, '0'); }

      function dateStr(y, m, d) { return `${y}-${service.pad2(m)}-${service.pad2(d)}`; }

      function catLetter(name) {
        const s = String(name || '').trim();
        return s ? s.slice(0, 1) : '·';
      }

      function budgetRowHtml({ color, letter, title, sub, inputs, chip = '', action = '' }) {
        return `<div class="budget-row">
          <span class="cat-icon" style="background:${color}">${service.esc(letter)}</span>
          <div class="budget-row-text">
            <div class="budget-row-title">${title}${chip}</div>
            <div class="budget-row-sub">${sub}</div>
          </div>
          <div class="budget-row-actions">${action}</div>
          <div class="budget-row-amt">${inputs}</div>
        </div>`;
      }

      function parseDate(s) {
        const [y, m, d] = String(s).split('-').map(Number);
        return new Date(y, (m || 1) - 1, d || 1);
      }

      /** 按本地日历逐日枚举（含首尾），Windows/macOS 夏令时下也不跳日、不串地点 */
      function iterDays(start, end) {
        const days = [];
        if (!start || !end) return days;
        let cur = service.parseDate(start);
        const last = service.parseDate(end);
        if (Number.isNaN(cur.getTime()) || Number.isNaN(last.getTime()) || cur > last) return days;
        while (cur <= last) {
          days.push(service.dateStr(cur.getFullYear(), cur.getMonth() + 1, cur.getDate()));
          cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1);
        }
        return days;
      }

      function rangesFromDays(days) {
        const sorted = Array.from(new Set(days)).sort();
        if (!sorted.length) return [];
        const ranges = [];
        let start = sorted[0];
        let prev = sorted[0];
        for (let i = 1; i < sorted.length; i++) {
          const d = service.parseDate(prev);
          const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
          const expected = service.dateStr(next.getFullYear(), next.getMonth() + 1, next.getDate());
          if (sorted[i] === expected) {
            prev = sorted[i];
          } else {
            ranges.push({ start, end: prev });
            start = prev = sorted[i];
          }
        }
        ranges.push({ start, end: prev });
        return ranges;
      }

      /** 两个日期之间的天数（含首尾） */
      function daysBetween(a, b) {
        return Math.round((service.parseDate(b) - service.parseDate(a)) / 86400000) + 1;
      }

      function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

      Object.assign(service, {
        LOC_COLORS,
        EXTRA_CURRENCIES,
        $,
        $$,
        esc,
        fmtMoney,
        pad2,
        dateStr,
        catLetter,
        budgetRowHtml,
        parseDate,
        iterDays,
        rangesFromDays,
        daysBetween,
        deepClone,
      });

      return service;
    },
  });
})(window.BudgetModules || (window.BudgetModules = Object.create(null)));
