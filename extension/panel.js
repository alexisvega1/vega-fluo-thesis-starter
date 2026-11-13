getUrl().then((url) => {
  const frame = document.getElementById("app");
  frame.src = url;
  document.getElementById("tab").onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url }); };
  // if the Mac is asleep or Vega Fluo is not running, say so instead of showing a blank panel
  fetch(url, { method: "HEAD", mode: "no-cors" }).catch(() => {
    frame.replaceWith(Object.assign(document.createElement("div"), { className: "down", innerHTML: `Can't reach Vega Fluo at <b>${url}</b>.<br>Is the Mac awake, Vega Fluo running, and Tailscale connected on this computer?` }));
  });
});
