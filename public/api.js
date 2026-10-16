// Small helpers shared by every screen (register.js, categories.js, payees.js).
// Keeping them here means each screen talks to the server and reports errors
// in exactly the same way.

export const byId = (id) => document.getElementById(id);

// --- Talking to the server ---

// Send a request and turn server errors (like "A name is required") into
// thrown Errors, so problems surface instead of failing silently.
export async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error ?? `Request failed: ${url}`);
  }
  return data;
}

export const getJson = (url) => request(url);

export const postJson = (url, body) =>
  request(url, {
    method: 'POST',
    // The server only accepts changes sent as JSON (see isTrustedRequest).
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

// Event handlers can't usefully return errors, so wrap them: any failure is
// shown to you instead of disappearing into the browser console.
export function runAction(action) {
  action().catch((err) => {
    console.error(err);
    alert(err.message);
  });
}

// A <button> that runs `action` through runAction when clicked.
export function makeButton(label, action, className) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  if (className) button.className = className;
  button.addEventListener('click', () => runAction(action));
  return button;
}
