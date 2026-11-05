/* 跨月已保存结果的筛选和图表展示。
 * 跨模块调用由 web/js/app.js 显式注入；模块只导出本职责的接口。
 */
(function register(registry) {
  'use strict';
  registry.analysis = Object.freeze({
    dependencies: Object.freeze(["feedback","results","shared","state"]),
    create({ feedback: feedbackModule, results: resultsModule, shared: sharedModule, state: stateModule }, service = {}) {
      const { state } = stateModule;

      /* --------------------------------------------------------------------------
       * 数据分析：各月总预算折线图
       * 横轴 = 已保存计算结果的月份；纵轴 = 总预算（人民币）。
       * 两组标签（境内/境外、是否旅居）：未勾选 = 不筛选并在横轴注释；勾选后按勾选项筛选，该组注释隐藏。
       * ------------------------------------------------------------------------ */
      function monthKeyToLabel(key) {
        const [y, m] = String(key).split('-');
        return `${y}年${m}月`;
      }

      function collectAnalysisMonths() {
        const results = resultsModule.loadResultsMap();
        return Object.keys(results).sort().map((key) => {
          const r = results[key];
          if (r && r.stale) return null;
          const total = r && r.summary ? Number(r.summary['总预算(人民币)']) : NaN;
          if (!Number.isFinite(total)) return null;
          const opt = (state.monthsByKey[key] && state.monthsByKey[key].options) || {};
          const regionRaw = r.region || opt.region || (r.summary && r.summary['居住区域']) || 'Mainland';
          const region = regionRaw === 'Overseas' ? 'Overseas' : 'Mainland';
          let includeTravel;
          if (r.includeTravel != null) includeTravel = !!r.includeTravel;
          else if (opt.includeTravel != null) includeTravel = !!opt.includeTravel;
          else includeTravel = false;
          return { key, label: service.monthKeyToLabel(key), amount: total, region, includeTravel };
        }).filter(Boolean);
      }

      function readAnalysisFilters() {
        const regionVals = sharedModule.$$('#analysis-tags-region input:checked').map((el) => el.value);
        const travelVals = sharedModule.$$('#analysis-tags-travel input:checked').map((el) => el.value);
        return {
          from: (sharedModule.$('#analysis-from') && sharedModule.$('#analysis-from').value) || '',
          to: (sharedModule.$('#analysis-to') && sharedModule.$('#analysis-to').value) || '',
          regions: regionVals,
          hideRegionAnno: regionVals.length > 0,
          travels: travelVals.map((v) => v === '1'),
          hideTravelAnno: travelVals.length > 0,
        };
      }

      function fillAnalysisRangeSelects(allKeys) {
        const fromSel = sharedModule.$('#analysis-from');
        const toSel = sharedModule.$('#analysis-to');
        if (!fromSel || !toSel) return;
        const prevFrom = fromSel.value;
        const prevTo = toSel.value;
        const opts = allKeys.map((k) => `<option value="${sharedModule.esc(k)}">${sharedModule.esc(service.monthKeyToLabel(k))}</option>`).join('');
        fromSel.innerHTML = opts;
        toSel.innerHTML = opts;
        if (!allKeys.length) return;
        fromSel.value = allKeys.includes(prevFrom) ? prevFrom : allKeys[0];
        toSel.value = allKeys.includes(prevTo) ? prevTo : allKeys[allKeys.length - 1];
        if (fromSel.value > toSel.value) {
          const tmp = fromSel.value;
          fromSel.value = toSel.value;
          toSel.value = tmp;
        }
      }

      function destroyAnalysisChart() {
        if (state.analysisChart && typeof state.analysisChart.dispose === 'function') {
          state.analysisChart.dispose();
        }
        state.analysisChart = null;
      }

      function resizeAnalysisChart() {
        if (state.analysisChart) state.analysisChart.resize();
      }

      function renderAnalysis() {
        const host = sharedModule.$('#analysis-chart');
        const empty = sharedModule.$('#analysis-empty');
        const legend = sharedModule.$('#analysis-legend');
        if (!host) return;

        const all = service.collectAnalysisMonths();
        service.fillAnalysisRangeSelects(all.map((m) => m.key));
        const filters = service.readAnalysisFilters();

        let rows = all.filter((m) => {
          if (filters.from && m.key < filters.from) return false;
          if (filters.to && m.key > filters.to) return false;
          if (filters.regions.length && !filters.regions.includes(m.region)) return false;
          if (filters.travels.length && !filters.travels.includes(m.includeTravel)) return false;
          return true;
        });

        const total = rows.reduce((sum, row) => sum + row.amount, 0);
        const countEl = sharedModule.$('#analysis-month-count');
        const totalEl = sharedModule.$('#analysis-month-total');
        const averageEl = sharedModule.$('#analysis-month-average');
        if (countEl) countEl.textContent = String(rows.length);
        if (totalEl) totalEl.textContent = `¥ ${sharedModule.fmtMoney(total)}`;
        if (averageEl) averageEl.textContent = `¥ ${sharedModule.fmtMoney(rows.length ? total / rows.length : 0)}`;
        const showRegion = !filters.hideRegionAnno;
        const showTravel = !filters.hideTravelAnno;

        if (legend) {
          const bits = [];
          if (showRegion) {
            bits.push('<span class="lg-item"><i class="lg-dot" style="background:#00805f"></i>内地</span>');
            bits.push('<span class="lg-item"><i class="lg-dot" style="background:#265fce"></i>境外</span>');
          }
          if (showTravel) {
            bits.push('<span class="lg-item"><i class="lg-dot" style="background:#8a9299"></i>不含旅居</span>');
            bits.push('<span class="lg-item"><i class="lg-dia"></i>含旅居</span>');
          }
          legend.innerHTML = bits.join('');
        }

        if (!rows.length) {
          service.destroyAnalysisChart();
          host.classList.add('is-empty');
          host.style.height = '0px';
          feedbackModule.setElVisible(empty, true);
          if (empty) {
            empty.textContent = all.length
              ? '当前时间段或标签下没有月份。请调整筛选后再试。'
              : '还没有可绘制的月份。请先在各月添加行程并更新预算，本页会自动读取已保存结果。';
          }
          return;
        }

        feedbackModule.setElVisible(empty, false);
        host.classList.remove('is-empty');
        host.style.height = '';

        const data = rows.map((m) => ({
          value: m.amount,
          itemStyle: { color: showRegion ? (m.region === 'Overseas' ? '#265fce' : '#00805f') : '#00805f' },
          symbol: showTravel ? (m.includeTravel ? 'diamond' : 'circle') : 'circle',
          symbolSize: showTravel && m.includeTravel ? 14 : 9,
        }));

        if (!state.analysisChart) {
          state.analysisChart = echarts.init(host);
        }

        state.analysisChart.setOption({
          tooltip: {
            trigger: 'axis',
            backgroundColor: 'rgba(255, 255, 255, 0.98)',
            borderColor: '#e2e9ed',
            textStyle: { color: '#324c5b' },
            extraCssText: 'box-shadow:0 8px 24px rgba(50,76,91,.14);border-radius:8px;',
            formatter: (params) => {
              const p = params && params[0];
              if (!p) return '';
              const row = rows[p.dataIndex];
              if (!row) return '';
              const tags = [
                row.region === 'Overseas' ? '境外' : '内地',
                row.includeTravel ? '含旅居' : '不含旅居',
              ];
              return `${row.label}<br/>总预算 ¥ ${sharedModule.fmtMoney(row.amount)}<br/>${tags.join(' · ')}`;
            },
          },
          grid: { left: 64, right: 28, top: 28, bottom: showRegion || showTravel ? 72 : 48 },
          xAxis: {
            type: 'category',
            data: rows.map((m) => m.key),
            axisLine: { lineStyle: { color: '#c8d4db' } },
            axisTick: { lineStyle: { color: '#c8d4db' } },
            axisLabel: {
              interval: 0,
              hideOverlap: true,
              color: '#5a6f7c',
              formatter: (value) => service.monthKeyToLabel(value),
            },
          },
          yAxis: {
            type: 'value',
            name: '总预算（人民币）',
            nameTextStyle: { color: '#5a6f7c' },
            splitLine: { lineStyle: { color: '#edf2f5' } },
            axisLabel: {
              color: '#5a6f7c',
              formatter: (v) => (v >= 10000 ? `${(v / 10000).toFixed(1)}万` : String(v)),
            },
          },
          series: [{
            name: '总预算',
            type: 'line',
            smooth: true,
            showSymbol: true,
            symbol: 'circle',
            lineStyle: { width: 3, color: '#00805f' },
            data,
          }],
        }, true);
      }

      Object.assign(service, {
        monthKeyToLabel,
        collectAnalysisMonths,
        readAnalysisFilters,
        fillAnalysisRangeSelects,
        destroyAnalysisChart,
        resizeAnalysisChart,
        renderAnalysis,
      });

      return service;
    },
  });
})(window.BudgetModules || (window.BudgetModules = Object.create(null)));
