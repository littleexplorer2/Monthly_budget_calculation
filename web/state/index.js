/* 唯一界面状态；不执行持久化或预算计算。
 * 跨模块调用由 web/js/app.js 显式注入；模块只导出本职责的接口。
 */
(function register(registry) {
  'use strict';
  registry.state = Object.freeze({
    dependencies: Object.freeze([]),
    create({  }, service = {}) {

      const state = {
        meta: null,               // /api/meta 返回的元数据
        activeSection: 'budget',  // budget | dashboard（仅界面导航，不持久化）
        activeBudgetTab: 'standards',
        activeDashboardTab: 'analysis',
        year: 0,
        month: 0,                 // 1-12
        region: 'Mainland',
        standards: { variable: {}, fixed: {}, travel: {}, extra: {} }, // 当前生效标准（默认 + 覆盖）
        itineraryByMonth: {},     // { 'YYYY-MM': { location: [{start, end}] } }
        optionsByMonth: {},       // { 'YYYY-MM': { region, includeTravel, travelSelected } }
        overridesByMonth: {},     // { 'YYYY-MM': 完整标准快照；兼容读取旧版差异 }
        resultsByMonth: {},       // { 'YYYY-MM': 计算结果（不含汇率明细） }
        annualBudgetsByYear: {},  // { 'YYYY': { currency: 全年当地金额 } }
        annualResultsByYear: {},  // { 'YYYY': 紧凑全年计算结果（不含原始汇率序列） }
        annualYear: 0,
        annualRatesData: null,
        annualRatesYear: null,
        annualLoading: false,
        annualLoadingYear: null,
        annualRateRequestId: 0,
        persistFailureNotified: false,
        activeLocation: null,     // 当前日历操作的目标地点
        calSel: { start: null, end: null },
        ratesData: null,          // 最近一次汇率数据
        ratesMonth: null,         // 汇率数据对应的月份 key
        ratesSource: null,        // 本次计算的行情来源（当月或月初上月均值回退）
        calcResult: null,
        rateCharts: [],           // 每币种独立折线图实例 { currency, instance }
        analysisChart: null,      // 数据分析页折线图
        busy: false,
        // 新建预算标准：当月自定义地点（[{key,name,category,currency}]）与固定预算自定义币种名
        customLocations: [],
        customCurrencies: {},
        monthLocations: null,
        monthLocationNames: null,
        monthCurrencyNames: null,
        monthStandardsSnapshot: false,
        // 旅居开关与选择（按月保存）：默认关闭；travelSelected=null 表示全部
        includeTravel: false,
        travelSelected: null,
        // 默认标准编辑：editingDefaults=true 时输入框直接编辑服务器默认标准（defaultsDraft 为未保存草稿）
        editingDefaults: false,
        defaultsDraft: null,
        // 默认标准弹窗的显示范围：false=只显示本月对应的部分，true=显示所有默认预算。
        // 纯界面偏好，只存在于内存（不写 app-state.json / localStorage，也不进草稿）。
        defaultsShowAll: false,
      };

      Object.assign(service, {
        state,
      });

      return service;
    },
  });
})(window.BudgetModules || (window.BudgetModules = Object.create(null)));
