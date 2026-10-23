// Page world. Watches the page's own submission polls and announces a final Accepted verdict.
// It must never change what the page's fetch does or returns, so every failure here is swallowed.
(() => {
  const CHECK = /^\/submissions\/detail\/(\d+)\/v2\/check\/$/; // digits only: Run polls runcode_… ids
  const realFetch = window.fetch;
  const announced = new Set();

  // Mirrors LeetCode's own final-verdict logic. ai_state is the AI restrictions check, which can
  // still overturn a pass while PENDING or STARTED; it is usually absent.
  function isFinalAccepted(d) {
    return d?.state === 'SUCCESS' && d.status_code === 10 && !['PENDING', 'STARTED', 'FAILURE'].includes(d.ai_state);
  }

  function submissionId(input) {
    const url = new URL(input instanceof Request ? input.url : input, location.href);
    return url.origin === location.origin ? CHECK.exec(url.pathname)?.[1] : undefined;
  }

  function inspect(id, d) {
    if (announced.has(id) || !isFinalAccepted(d)) return;
    announced.add(id);
    window.postMessage({ source: 'ac2git', type: 'accepted', submissionId: id }, location.origin);
  }

  window.fetch = function (...args) {
    const response = realFetch.apply(this, args);
    try {
      const id = submissionId(args[0]);
      // Attached synchronously, so clone() runs before the page's own handler reads the body.
      if (id) response.then((r) => r.clone().json()).then((d) => inspect(id, d)).catch(() => {});
    } catch {}
    return response;
  };
})();
