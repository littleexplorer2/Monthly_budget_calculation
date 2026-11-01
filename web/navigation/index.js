/* 顶部主分区与预算子页签导航。
 * 只负责可见区域、活动态和进入统计面板时的组合刷新；各功能仍由对应模块实现。
 */
(function register(registry) {
  'use strict';
  registry.navigation = Object.freeze({
    dependencies: Object.freeze(["analysis","annual","rates","shared","state"]),
    create({ analysis: analysisModule, annual: annualModule, rates: ratesModule, shared: sharedModule, state: stateModule }, service = {}) {
      const { state } = stateModule;
      const BUDGET_TABS = Object.freeze(['standards', 'itinerary', 'result']);
      const DASHBOARD_TABS = Object.freeze(['analysis', 'rates']);

      function renderNavigation() {
        const dashboard = state.activeSection === 'dashboard';
        sharedModule.$$('.primary-nav-item').forEach((button) => {
          const active = button.dataset.section === state.activeSection;
          button.classList.toggle('active', active);
          button.setAttribute('aria-current', active ? 'page' : 'false');
        });
        sharedModule.$$('.section-nav-item').forEach((button) => {
          const active = !dashboard && button.dataset.tab === state.activeBudgetTab;
          button.classList.toggle('active', active);
          button.setAttribute('aria-current', active ? 'page' : 'false');
        });
        sharedModule.$$('.dashboard-nav-item').forEach((button) => {
          const active = dashboard && button.dataset.dashboardTab === state.activeDashboardTab;
          button.classList.toggle('active', active);
          button.setAttribute('aria-current', active ? 'page' : 'false');
        });
        sharedModule.$$('.tab-panel').forEach((panel) => {
          const active = dashboard
            ? panel.id === 'tab-dashboard'
            : panel.id === `tab-${state.activeBudgetTab}`;
          panel.classList.toggle('active', active);
        });
        sharedModule.$$('.dashboard-block').forEach((panel) => {
          panel.classList.toggle('active', dashboard && panel.id === `tab-${state.activeDashboardTab}`);
        });
        if (document.body && document.body.classList) {
          document.body.classList.toggle('dashboard-view', dashboard);
        }
      }

      function refreshDashboard() {
        if (state.activeSection !== 'dashboard') return;
        if (state.activeDashboardTab === 'rates') {
          ratesModule.renderRatesPanel();
        } else {
          annualModule.renderAnnualBudget();
          analysisModule.renderAnalysis();
        }
        setTimeout(() => {
          ratesModule.resizeRateCharts();
          analysisModule.resizeAnalysisChart();
        }, 60);
      }

      function openSection(name) {
        state.activeSection = name === 'dashboard' ? 'dashboard' : 'budget';
        service.renderNavigation();
        service.refreshDashboard();
      }

      function openBudgetTab(name) {
        if (!BUDGET_TABS.includes(name)) return false;
        state.activeSection = 'budget';
        state.activeBudgetTab = name;
        service.renderNavigation();
        return true;
      }

      function openDashboardTab(name) {
        if (!DASHBOARD_TABS.includes(name)) return false;
        state.activeSection = 'dashboard';
        state.activeDashboardTab = name;
        service.renderNavigation();
        service.refreshDashboard();
        return true;
      }

      function switchTab(name) {
        if (name === 'dashboard') { service.openSection('dashboard'); return true; }
        if (DASHBOARD_TABS.includes(name)) return service.openDashboardTab(name);
        return service.openBudgetTab(name);
      }

      Object.assign(service, {
        BUDGET_TABS,
        DASHBOARD_TABS,
        renderNavigation,
        refreshDashboard,
        openSection,
        openBudgetTab,
        openDashboardTab,
        switchTab,
      });
      return service;
    },
  });
})(window.BudgetModules || (window.BudgetModules = Object.create(null)));
