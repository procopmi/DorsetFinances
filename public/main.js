// The page's starting point. It shows the sample-data banner and switches
// between the screens (Register, Budget, Reports, Categories, Payees).
//
// All the screens live in index.html; only one is visible at a time. Each
// screen's file exports a show() that loads fresh data from the server, so
// whatever you changed on one screen is up to date when you open another.

import { byId, getJson, runAction } from '/api.js';
import * as register from '/register.js';
import * as budget from '/budget.js';
import * as reports from '/reports.js';
import * as categories from '/categories.js';
import * as payees from '/payees.js';
// The import preview is part of the Register screen; loading it here
// connects its "Import CSV…" button.
import '/import.js';

const screens = {
  register: { section: 'register-view', module: register },
  budget: { section: 'budget-view', module: budget },
  reports: { section: 'reports-view', module: reports },
  categories: { section: 'categories-view', module: categories },
  payees: { section: 'payees-view', module: payees },
};

function switchTo(name) {
  for (const [screenName, screen] of Object.entries(screens)) {
    byId(screen.section).hidden = screenName !== name;
  }
  // Mark the current screen's button, both for styling and for screen readers.
  for (const button of document.querySelectorAll('[data-screen]')) {
    button.setAttribute('aria-current', String(button.dataset.screen === name));
  }
  runAction(() => screens[name].module.show());
}

for (const button of document.querySelectorAll('[data-screen]')) {
  button.addEventListener('click', () => switchTo(button.dataset.screen));
}

runAction(async () => {
  const info = await getJson('/api/info');
  byId('sample-banner').hidden = !info.isSampleData;
  switchTo('register');
});
