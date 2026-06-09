// Frontend logic: search, render, user-picker.
// Reads from /api/* — no client-side filtering, no client-side cosine.

import { search } from './api-client.js';

const $q = document.querySelector('#q');
const $results = document.querySelector('#results');
const $user = document.querySelector('#user-picker');

let currentUser = $user.value;
$user.addEventListener('change', () => {
  currentUser = $user.value;
  runSearch();
});

let timer;
$q.addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(runSearch, 200);
});

async function runSearch() {
  const query = $q.value.trim();
  try {
    const { results } = await search({ query, filters: {}, limit: 10 }, currentUser);
    render(results);
  } catch (e) {
    $results.innerHTML = `<p class="error">${escape(String(e))}</p>`;
  }
}

function render(items) {
  if (!items.length) {
    $results.innerHTML = `<p class="empty">No projects accessible to this user.</p>`;
    return;
  }
  $results.innerHTML = items.map((p) => `
    <article class="project">
      <h3>${escape(p.title)}</h3>
      <p>${escape(p.project_details?.summary || '')}</p>
      <small>ref ${escape(p.ref_number)}${p.score ? ' · score ' + p.score.toFixed(3) : ''}</small>
    </article>
  `).join('');
}

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

runSearch();
