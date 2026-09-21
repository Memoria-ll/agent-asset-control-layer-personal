try {
  if (localStorage.getItem('aacl-theme') === 'dark') document.documentElement.dataset.theme = 'dark';
} catch (_) {
  // Theme initialization is best-effort; the application applies the default later.
}
