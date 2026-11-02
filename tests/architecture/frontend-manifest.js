'use strict';

// Browser module registration name -> directory. Python layers are registered
// in manifest.py; these are different inventories, not duplicate definitions.
module.exports = Object.freeze({
  state: 'state',
  shared: 'shared',
  http: 'http',
  feedback: 'feedback',
  locations: 'locations',
  persistence: 'persistence',
  lifecycle: 'lifecycle',
  network: 'network',
  itinerary: 'itinerary',
  standards: 'standards',
  standardsEditor: 'standards-editor',
  standardsView: 'standards-view',
  calendar: 'calendar',
  rates: 'rates',
  results: 'results',
  subscriptions: 'subscriptions',
  monthly: 'monthly',
  annual: 'annual',
  analysis: 'analysis',
  assets: 'assets',
  navigation: 'navigation',
  data: 'data',
  travel: 'travel',
  shell: 'shell',
});
