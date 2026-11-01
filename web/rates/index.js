/* 月度汇率请求和图表展示。
 * 跨模块调用由 web/js/app.js 显式注入；模块只导出本职责的接口。
 */
(function register(registry) {
  'use strict';
  registry.rates = Object.freeze({
    dependencies: Object.freeze(["locations","shared","state"]),
    create({ locations: locationsModule, shared: sharedModule, state: stateModule }, service = {}) {
      const { state } = stateModule;

      /* --------------------------------------------------------------------------
       * 汇率走势（每种货币独立一张折线图）
       * 说明：不同币种兑人民币的量级差异很大（如 USD≈7.2、HKD≈0.92、THB≈0.19），
       * 若画在同一张图上，低量级币种会被压成近似水平的直线。因此按币种拆分，
       * 每张图使用各自独立的纵轴比例尺（scale: true），走势一目了然。
       * ------------------------------------------------------------------------ */
      function destroyRateCharts() {
        for (const item of state.rateCharts) {
          if (item.instance && typeof item.instance.dispose === 'function') {
            item.instance.dispose();
          }
        }
        state.rateCharts = [];
      }

      function resizeRateCharts() {
        state.rateCharts.forEach((item) => {
          if (item.instance) item.instance.resize();
        });
      }

      function displayCurrencies(currencies) {
        const ordered = locationsModule.orderedCurrencies(currencies).filter((currency) => currency !== 'CNY');
        return ordered.includes('CNH') ? ['CNH', ...ordered.filter((currency) => currency !== 'CNH')] : ordered;
      }

      function renderRateCharts() {
        if (!state.ratesData) return;
        const container = sharedModule.$('#rates-charts');
        container.innerHTML = '';
        service.destroyRateCharts();

        for (const c of service.displayCurrencies(Object.keys(state.ratesData.series))) {

          // 每张图独立容器
          const wrap = document.createElement('div');
          wrap.className = 'rate-chart-wrap';
          const title = document.createElement('div');
          title.className = 'rate-chart-title';
          title.textContent = c === 'CNH'
            ? '离岸人民币兑在岸人民币（CNH/CNY）· 每日走势'
            : `${locationsModule.currencyName(c)}（${c}）兑人民币 · 每日走势`;
          const chartBox = document.createElement('div');
          chartBox.className = 'rate-chart';
          wrap.appendChild(title);
          wrap.appendChild(chartBox);
          container.appendChild(wrap);

          const chart = echarts.init(chartBox);
          chart.setOption({
            color: ['#12c48b', '#40c3f9', '#ff6faf', '#ffc053', '#7b93a4'],
            tooltip: {
              trigger: 'axis',
              backgroundColor: 'rgba(12, 20, 28, 0.94)',
              borderColor: 'rgba(255,255,255,0.14)',
              textStyle: { color: '#f4f8fb' },
              valueFormatter: (v) => (v == null ? '-' : Number(v).toFixed(4)),
            },
            grid: { left: 64, right: 24, top: 30, bottom: 48 },
            xAxis: {
              type: 'category', data: state.ratesData.dates, boundaryGap: false,
              axisLine: { lineStyle: { color: '#3a4b59' } },
              axisLabel: { color: '#91a4b5' },
            },
            yAxis: {
              type: 'value', scale: true, name: `${c}/CNY`,
              nameTextStyle: { color: '#91a4b5' },
              axisLabel: { color: '#91a4b5' },
              splitLine: { lineStyle: { color: 'rgba(255,255,255,0.08)' } },
            },
            dataZoom: [
              { type: 'inside' },
              { type: 'slider', height: 16, bottom: 10 },
            ],
            series: [{
              name: locationsModule.currencyName(c),
              type: 'line',
              showSymbol: false,
              connectNulls: true,
              sampling: 'lttb',
              lineStyle: { width: 2 },
              data: state.ratesData.series[c],
            }],
          }, true);
          state.rateCharts.push({ currency: c, instance: chart });
        }
      }

      function renderRatesStats() {
        const stats = state.ratesData.stats;
        let html = '<table class="detail-table"><thead><tr><th>币种</th><th class="num">起始</th><th class="num">期末</th>' +
          '<th class="num">均值</th><th class="num">最低</th><th class="num">最高</th></tr></thead><tbody>';
        for (const c of service.displayCurrencies(Object.keys(stats))) {
          const s = stats[c];
          const f = (v) => (v == null ? '-' : Number(v).toFixed(4));
          html += `<tr>
            <td>${sharedModule.esc(locationsModule.currencyName(c))} <span class="muted">${sharedModule.esc(c)}</span></td>
            <td class="num">${f(s.start)}</td>
            <td class="num">${f(s.end)}</td>
            <td class="num">${f(s.avg)}</td>
            <td class="num">${f(s.min)}</td>
            <td class="num">${f(s.max)}</td>
          </tr>`;
        }
        html += '</tbody></table>';
        sharedModule.$('#rates-stats-table').innerHTML = html;
      }

      function renderRatesPanel() {
        const currentMonth = `${state.year}-${sharedModule.pad2(state.month)}`;
        const current = state.ratesData && state.ratesMonth === currentMonth;
        const empty = sharedModule.$('#rates-empty');
        const content = sharedModule.$('#rates-content');
        if (empty) empty.hidden = !!current;
        if (content) content.hidden = !current;
        if (!current) {
          service.destroyRateCharts();
          const charts = sharedModule.$('#rates-charts');
          if (charts) charts.innerHTML = '';
          const stats = sharedModule.$('#rates-stats-table');
          if (stats) stats.innerHTML = '';
          return false;
        }
        const source = state.ratesSource || {};
        const note = sharedModule.$('#rates-source-note');
        if (note) {
          note.textContent = source.fallback
            ? `${source.requested_month} 月首日暂无行情，本次图表与预算使用 ${source.source_month} 月平均汇率。`
            : '汇率已在本月预算计算时自动获取；图表展示本次计算实际使用的币种与日历日序列。';
          note.classList.toggle('is-warning', !!source.fallback);
        }
        service.renderRateCharts();
        service.renderRatesStats();
        return true;
      }

      // 保留公开方法名供组装层调用；它只渲染计算响应，不再发起独立行情请求。
      function loadRates() {
        return service.renderRatesPanel();
      }

      Object.assign(service, {
        destroyRateCharts,
        resizeRateCharts,
        displayCurrencies,
        renderRateCharts,
        renderRatesStats,
        renderRatesPanel,
        loadRates,
      });

      return service;
    },
  });
})(window.BudgetModules || (window.BudgetModules = Object.create(null)));
