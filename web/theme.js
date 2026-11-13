// Shown inside a frame only by Vega Fluo itself or a Chrome extension (its own side panel), never by
// another website: that would let a page trick clicks into the editor ("clickjacking").
(function () {
  if (window.top === window.self) return;
  var a = location.ancestorOrigins ? Array.prototype.slice.call(location.ancestorOrigins) : [];
  var ok = a.length > 0 && a.every(function (o) { return o === location.origin || o.indexOf("chrome-extension://") === 0; });
  if (!ok) { document.documentElement.style.display = "none"; throw new Error("Vega Fluo cannot be shown inside another site"); }
})();
// Runs before first paint so the saved colour scheme never flashes the default one.
try {
  var t = localStorage.getItem("margin.theme");
  if (t) document.documentElement.dataset.theme = t;
} catch (e) {}
