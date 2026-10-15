/* 月度汇率请求和图表展示。
 * 跨模块调用由 web/js/app.js 显式注入；模块只导出本职责的接口。
 */
(function register(registry) {
  'use strict';
  registry.rates = Object.freeze({
    dependencies: Object.freeze(["http","feedback","locations","monthly","network","shared","state"]),
    create({ http: apiModule, feedback: feedbackModule, locations: locationsModule, monthly: monthlyModule, network: networkModule, shared: sharedModule, state: stateModule }, service = {}) {
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

      function renderRateCharts() {
        if (!state.ratesData) return;
        const showCNY = sharedModule.$('#chk-show-cny').checked;
        const container = sharedModule.$('#rates-charts');
        container.innerHTML = '';
        service.destroyRateCharts();

        for (const c of Object.keys(state.ratesData.series)) {
          if (c === 'CNY' && !showCNY) continue;

          // 每张图独立容器
          const wrap = document.createElement('div');
          wrap.className = 'rate-chart-wrap';
          const title = document.createElement('div');
          title.className = 'rate-chart-title';
          title.textContent = `${locationsModule.currencyName(c)}（${c}）兑人民币 · 每日走势`;
          const chartBox = document.createElement('div');
          chartBox.className = 'rate-chart';
          wrap.appendChild(title);
          wrap.appendChild(chartBox);
          container.appendChild(wrap);

          const chart = echarts.init(chartBox);
          chart.setOption({
            tooltip: {
              trigger: 'axis',
              valueFormatter: (v) => (v == null ? '-' : Number(v).toFixed(4)),
            },
            grid: { left: 64, right: 24, top: 30, bottom: 48 },
            xAxis: { type: 'category', data: state.ratesData.dates, boundaryGap: false },
            yAxis: { type: 'value', scale: true, name: `${c}/CNY` },
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
        for (const c of Object.keys(stats)) {
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

      async function loadRates(force = false) {
        // 计算响应附带的汇率可能只是「涉及币种」子集；进入汇率页时若数据来自计算，
        // 仍重新拉取全量币种，保证折线图完整。force 还会让后端跳过内存/磁盘缓存、重新下载。
        if (!force && state.ratesData && state.ratesMonth === monthlyModule.monthKey() && !state.ratesFromCalc) {
          service.renderRateCharts();
          service.renderRatesStats();
          return;
        }
        const requestYear = state.year;
        const requestMonth = state.month;
        const requestMonthKey = `${requestYear}-${sharedModule.pad2(requestMonth)}`;
        const requestId = state.rateRequestId + 1;
        state.rateRequestId = requestId;
        feedbackModule.setLoading(true, force
          ? '正在从 Yahoo Finance 重新下载当月汇率（将覆盖本地缓存）…'
          : '正在获取当月汇率数据（首次拉取可能需要数秒）…');
        try {
          // 币种 = 默认全部 + 当月新建标准产生的自定义币种
          const currs = new Set(state.meta.currencies);
          (locationsModule.activeCustomLocations() || []).forEach((c) => currs.add(c.currency));
          Object.keys(locationsModule.activeCustomCurrencies() || {}).forEach((c) => currs.add(c));
          const query = Array.from(currs).sort().join(',');
          const refreshQ = force ? '&refresh=true' : '';
          const data = await apiModule.api(`/api/rates?year=${requestYear}&month=${requestMonth}&currencies=${encodeURIComponent(query)}${refreshQ}`, { timeout: 180000 });
          if (state.rateRequestId !== requestId || monthlyModule.monthKey() !== requestMonthKey) return;
          state.ratesData = data;
          state.ratesMonth = requestMonthKey;
          state.ratesFromCalc = false;
          service.renderRateCharts();
          service.renderRatesStats();
          if (force) feedbackModule.toast('已重新下载当月汇率并更新本地缓存', 'success');
        } catch (err) {
          if (state.rateRequestId !== requestId || monthlyModule.monthKey() !== requestMonthKey) return;
          state.ratesData = null;
          feedbackModule.toast(err.message, 'error');
          networkModule.maybeShowNetworkWarning(err.message); // 汇率拉取失败 → 同步提示网络异常/VPN
        } finally {
          if (state.rateRequestId === requestId) feedbackModule.setLoading(false);
        }
      }

      Object.assign(service, {
        destroyRateCharts,
        resizeRateCharts,
        renderRateCharts,
        renderRatesStats,
        loadRates,
      });

      return service;
    },
  });
})(window.BudgetModules || (window.BudgetModules = Object.create(null)));
