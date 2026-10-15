/* 前端唯一组装入口。业务实现位于各职责目录的 index.js。 */
(function bootstrap(registry) {
  'use strict';
  const order = ["state","shared","http","feedback","locations","persistence","lifecycle","network","itinerary","standards","standardsEditor","standardsView","calendar","rates","results","monthly","annual","analysis","data","travel","shell"];
  const modules = Object.create(null);
  // 先分配稳定接口引用；界面模块间的回调只在全部组装完成后执行。
  for (const name of order) {
    if (!registry || !registry[name]) throw new Error('缺少前端模块：' + name);
    modules[name] = {};
  }
  for (const name of order) {
    const definition = registry[name];
    const dependencies = Object.create(null);
    for (const required of definition.dependencies) {
      if (!modules[required]) throw new Error(name + ' 依赖未注册模块：' + required);
      dependencies[required] = modules[required];
    }
    definition.create(dependencies, modules[name]);
  }
  window.BudgetApp = Object.freeze({ modules, state: modules.state.state });
  modules.lifecycle.start();
  document.addEventListener('DOMContentLoaded', modules.shell.init);
})(window.BudgetModules);
