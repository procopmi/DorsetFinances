// Runs in the browser. It asks the server for data (fetch) and fills in the page.
// The browser never touches the database directly; it only talks to /api/ routes.

// Small helper: GET a JSON API route, and turn server errors into thrown Errors
// so problems surface instead of failing silently.
async function getJson(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error ?? `Request failed: ${url}`);
  }
  return data;
}

async function loadPage() {
  const info = await getJson('/api/info');
  document.getElementById('sample-banner').hidden = !info.isSampleData;

  const accounts = await getJson('/api/accounts');
  const list = document.getElementById('account-list');
  document.getElementById('no-accounts').hidden = accounts.length > 0;

  for (const account of accounts) {
    const item = document.createElement('li');
    // textContent (not innerHTML) so an account name is always shown as plain
    // text and can never be interpreted as HTML.
    item.textContent = account.name;
    list.append(item);
  }
}

loadPage().catch((err) => {
  console.error(err);
  alert(`Could not load the page: ${err.message}`);
});
